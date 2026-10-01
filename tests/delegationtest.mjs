import {issueCredential,listenPeerServer,fixtureEndpoint} from "./helpers/peer-network.mjs";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn,spawnSync} from "node:child_process";
import {migratePeers,authenticate,localIdentity,revokePeer} from "../core/federation/peers.mjs";
import {migrateSync,digest} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,issuePrincipal} from "../core/mcp/policy.mjs";
import {enrollTask,callTool} from "../core/mcp/tools.mjs";

import {migrateDelegation,createIntent,receiveOffer,decideIncoming,outgoingStatus,incomingStatus,recordReceipt,peerDelegationStatus,listDelegations,MAX_OPEN_OFFERS} from "../core/federation/delegation.mjs";
import {deliverIntent} from "../core/federation/delegation-client.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-delegation-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function fixture(){const dir=join(TMP,"node-"+serial++);mkdirSync(dir);const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);migrateDelegation(db);return {dir,dbPath,db,node:localIdentity(db)};}
function card(f,extra={}){const id=store.add(f.db,{subject:"delegation fixture",description:"requested work",acceptance:"review candidate evidence",treeMode:"hierarchical",released:0,...extra}),t=store.get(f.db,id);enrollTask(f.db,{id,projectId:"demo",workKind:"implement",capabilities:["board-tools"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
function grant(a,b,extra={}){const file=join(TMP,"peer-"+serial+++".json");issueCredential(b.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes:["peer:handshake","delegation:offer","delegation:status"],projects:["demo"],credentialFile:file,...extra});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(b.db,"Bearer "+c.token)};}
function pair(){const a=fixture(),b=fixture(),t=card(a),g=grant(a,b),args={delegationId:randomUUID(),taskUid:t.task_uid,expectedVersion:t.aggregate_version,targetNodeId:b.node.node_id,targetEpoch:b.node.sync_epoch},out=createIntent(a.db,args);return {a,b,t,g,args,out};}
function receive(f){return receiveOffer(f.b.db,f.g.peer,f.out.offer);}
function decide(f,extra={}){return decideIncoming(f.b.db,{delegationId:f.out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"accepted scope; relationship still pending",...extra});}
async function network(f){const s=await listenPeerServer(f.db,{port:0});servers.push(s);return "http://127.0.0.1:"+s.address().port;}
const count=(db,table)=>db.prepare("SELECT count(*) n FROM "+table).get().n;
const snapshot=db=>JSON.stringify({tasks:db.prepare("SELECT * FROM tasks ORDER BY id").all(),events:db.prepare("SELECT * FROM task_events ORDER BY id").all(),incoming:db.prepare("SELECT * FROM delegation_incoming ORDER BY delegation_id").all(),projects:db.prepare("SELECT * FROM broker_task_projects ORDER BY task_id").all()});

test("source proposals retain a fixed public work contract and replay without duplicating the outbox",()=>{
 const f=pair();assert.equal(f.out.state,"pending");assert.equal(f.out.dispatch_ready,false);assert.equal(count(f.b.db,"tasks"),0);
 assert.deepEqual(createIntent(f.a.db,f.args),f.out);assert.equal(count(f.a.db,"delegation_outgoing"),1);
 assert.throws(()=>createIntent(f.a.db,{...f.args,targetEpoch:randomUUID()}),{code:"REQUEST_CONFLICT"});
 f.a.db.prepare("UPDATE tasks SET verify_cmd='private verifier',evidence_path='private/path' WHERE id=?").run(f.t.id);
 assert.ok(!JSON.stringify(f.out.offer).includes("private"));assert.deepEqual(createIntent(f.a.db,f.args),f.out);
 assert.throws(()=>createIntent(f.a.db,{...f.args,delegationId:randomUUID()}),{code:"CONFLICT"});
});
test("ten offers and a repeated acceptance create exactly one target-owned unconfirmed task",()=>{
 const f=pair();for(let i=0;i<10;i++)assert.equal(receive(f).state,"received");assert.equal(count(f.b.db,"tasks"),0);
 const decisionId=randomUUID(),r=decide(f,{decisionId});assert.equal(r.state,"accepted_unconfirmed");assert.equal(r.dispatch_ready,false);
 assert.deepEqual(decide(f,{decisionId}),r);assert.deepEqual(receive(f),r);assert.equal(count(f.b.db,"tasks"),1);
 const t=store.get(f.b.db,incomingStatus(f.b.db,r.delegation_id).target_task_id);
 assert.equal(t.owner_node_id,f.b.node.node_id);assert.notEqual(t.task_uid,f.t.task_uid);assert.equal(t.released,false);assert.equal(t.tree_mode,"hierarchical");assert.equal(t.attempts,0);assert.equal(count(f.b.db,"task_runs"),0);
 const out=recordReceipt(f.a.db,r.delegation_id,r);assert.equal(out.state,"accepted_unconfirmed");assert.equal(store.get(f.a.db,f.t.id).task_uid,f.t.task_uid);assert.equal(count(f.a.db,"tasks"),1);
});
test("unconfirmed target tasks cannot be released, claimed, completed or deleted through another entrypoint",()=>{
 const f=pair();receive(f);const r=decide(f),id=incomingStatus(f.b.db,r.delegation_id).target_task_id;
 assert.throws(()=>store.setReleased(f.b.db,{id,released:true}),/DELEGATION_UNCONFIRMED/);
 assert.throws(()=>f.b.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(id),/DELEGATION_UNCONFIRMED/);
 assert.throws(()=>f.b.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id),/DELEGATION_UNCONFIRMED/);
 assert.throws(()=>f.b.db.prepare("DELETE FROM tasks WHERE id=?").run(id),/retained/);
 assert.equal(store.claimById(f.b.db,{id,worker:"fixture"}).ok,false);assert.equal(store.get(f.b.db,id).attempts,0);
});
test("rejection is durable, creates no card and cannot later be overwritten by acceptance",()=>{
 const f=pair();receive(f);const decisionId=randomUUID(),r=decide(f,{decisionId,decision:"reject",note:"wrong scope"});
 assert.equal(r.state,"rejected");assert.equal(r.target_task_uid,null);assert.equal(count(f.b.db,"tasks"),0);
 assert.deepEqual(decide(f,{decisionId,decision:"reject",note:"wrong scope"}),r);
 assert.throws(()=>decide(f),{code:"CONFLICT"});assert.throws(()=>decide(f,{decisionId}),{code:"REQUEST_CONFLICT"});
 assert.equal(recordReceipt(f.a.db,r.delegation_id,r).state,"rejected");
});
test("changed bodies, forged owners, foreign epochs and unknown execution fields cannot enter the inbox",()=>{
 const f=pair();for(const [offer,code] of [
  [{...f.out.offer,source_node_id:randomUUID()},"OWNER_MISMATCH"],
  [{...f.out.offer,source_epoch:randomUUID()},"IDENTITY_MISMATCH"],
  [{...f.out.offer,target_epoch:randomUUID()},"EPOCH_CHANGED"],
  [{...f.out.offer,target_node_id:randomUUID()},"EPOCH_CHANGED"],
  [{...f.out.offer,task:{...f.out.offer.task,command:"shell"}},"BAD_INPUT"],
  [{...f.out.offer,project_id:"other"},"FORBIDDEN"]
 ])assert.throws(()=>receiveOffer(f.b.db,f.g.peer,offer),{code});
 assert.equal(count(f.b.db,"delegation_incoming"),0);receive(f);
 assert.throws(()=>receiveOffer(f.b.db,f.g.peer,{...f.out.offer,task:{...f.out.offer.task,subject:"changed"}}),{code:"REQUEST_CONFLICT"});
 assert.equal(count(f.b.db,"delegation_incoming"),1);
});
test("source revocation or retired epoch prevents subsequent local acceptance",()=>{
 for(const retired of [false,true]){
  const f=pair();receive(f);
  if(retired)f.b.db.prepare("INSERT INTO federation_retired_epochs(origin_node_id,origin_epoch,acceptance_id) VALUES(?,?,?)").run(f.a.node.node_id,f.a.node.sync_epoch,randomUUID());
  else revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
  assert.throws(()=>decide(f),{code:retired?"RETIRED_EPOCH":"SOURCE_REVOKED"});assert.equal(count(f.b.db,"tasks"),0);
 }
});
test("task creation, enrollment, receiver decision and audit roll back as one transaction",()=>{
 const f=pair();receive(f);const before=snapshot(f.b.db);
 f.b.db.exec("CREATE TRIGGER injected_decision BEFORE INSERT ON delegation_events WHEN NEW.kind='accept' BEGIN SELECT RAISE(ABORT,'injected decision'); END");
 assert.throws(()=>decide(f),/injected decision/);assert.equal(snapshot(f.b.db),before);
 f.b.db.exec("DROP TRIGGER injected_decision");assert.equal(decide(f).state,"accepted_unconfirmed");
});
test("failed receive and source proposal writes do not leave half records, including nested calls",()=>{
 const f=pair();f.b.db.exec("CREATE TRIGGER injected_receive BEFORE INSERT ON delegation_events BEGIN SELECT RAISE(ABORT,'injected receive'); END; BEGIN IMMEDIATE");
 assert.throws(()=>receive(f),/injected receive/);f.b.db.exec("COMMIT");assert.equal(count(f.b.db,"delegation_incoming"),0);
 f.a.db.exec("CREATE TRIGGER injected_send BEFORE INSERT ON delegation_events BEGIN SELECT RAISE(ABORT,'injected send'); END");
 assert.throws(()=>createIntent(f.a.db,{...f.args,delegationId:randomUUID()}),/injected send/);assert.equal(count(f.a.db,"delegation_outgoing"),1);
});
test("receipts bind both epochs, target ownership, contract digest and monotonically observed decisions",()=>{
 const f=pair(),old=receive(f),accepted=decide(f);recordReceipt(f.a.db,accepted.delegation_id,accepted);
 assert.equal(recordReceipt(f.a.db,old.delegation_id,old).state,"accepted_unconfirmed");
 for(const response of [{...accepted,offer_digest:"bad"},{...accepted,source_epoch:randomUUID()},{...accepted,target_epoch:randomUUID()},{...accepted,dispatch_ready:true}])assert.throws(()=>recordReceipt(f.a.db,accepted.delegation_id,response),{code:"RECEIPT_MISMATCH"});
 assert.throws(()=>recordReceipt(f.a.db,accepted.delegation_id,{...accepted,target_task_uid:f.t.task_uid}),{code:"OWNER_MISMATCH"});
 assert.throws(()=>recordReceipt(f.a.db,accepted.delegation_id,{...accepted,note:"different"}),{code:"RECEIPT_CONFLICT"});
 assert.equal(count(f.a.db,"delegation_events"),2);
});
test("restarting both database connections retains offers, decisions and immutable identities",()=>{
 const f=pair();receive(f);const receipt=decide(f);recordReceipt(f.a.db,receipt.delegation_id,receipt);
 const a=new DatabaseSync(f.a.dbPath),b=new DatabaseSync(f.b.dbPath);dbs.push(a,b);migrateDelegation(a);migrateDelegation(b);
 assert.equal(outgoingStatus(a,receipt.delegation_id).state,"accepted_unconfirmed");assert.equal(incomingStatus(b,receipt.delegation_id).receipt.target_task_uid,receipt.target_task_uid);
 assert.throws(()=>b.prepare("UPDATE delegation_incoming SET target_task_uid=? WHERE delegation_id=?").run(f.t.task_uid,receipt.delegation_id),/immutable/);
 assert.throws(()=>a.prepare("UPDATE delegation_outgoing SET offer_json='{}' WHERE delegation_id=?").run(receipt.delegation_id),/immutable/);
});
function restored(f){
 const evidence=join(f.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic delegation evidence");
 const backup=createBackup({dbPath:f.dbPath,evidenceDir:evidence,destination:join(TMP,"backup-"+serial++)}),dir=join(TMP,"restore-"+serial++);
 restoreBackup({backupDirectory:backup.destination,destination:dir});const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);
 assert.throws(()=>migrateDelegation(db),{code:"RESTORE_HOLD"});retireNode({dbPath:f.dbPath,expectedEpoch:f.node.sync_epoch});
 const plan=prepareRecovery({dbPath});activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated delegation fixture; no physical node attestation",attested_at:new Date().toISOString()}});
 return {...f,dir,dbPath,db,node:localIdentity(db)};
}
test("a restored source or target epoch cannot continue an old delegation",()=>{
 const f=pair();receive(f);const b=restored(f.b);
 assert.equal(incomingStatus(b.db,f.out.delegation_id).identity_current,false);
 assert.throws(()=>decide({...f,b}),{code:"EPOCH_CHANGED"});assert.equal(count(b.db,"tasks"),0);
 const a=restored(f.a);assert.equal(outgoingStatus(a.db,f.out.delegation_id).identity_current,false);
 assert.throws(()=>createIntent(a.db,f.args),{code:"EPOCH_CHANGED"});
});
test("live HTTP delivery, local acceptance and source poll preserve one bilateral record",async()=>{
 const f=pair(),url=await network(f.b),args={delegationId:f.out.delegation_id,url,credentialFile:f.g.file};
 assert.equal((await deliverIntent(f.a.db,args)).state,"received");assert.equal(count(f.b.db,"tasks"),0);decide(f);
 const result=await deliverIntent(f.a.db,{...args,mode:"status"});assert.equal(result.state,"accepted_unconfirmed");assert.equal(result.delivery_state,"acknowledged");assert.equal(result.dispatch_ready,false);
 assert.equal(count(f.b.db,"tasks"),1);assert.equal(count(f.a.db,"tasks"),1);
});
test("a lost acknowledgement and offline retry never duplicate received or accepted work",async()=>{
 const f=pair(),url=await network(f.b),args={delegationId:f.out.delegation_id,url,credentialFile:f.g.file};
 const lost=await deliverIntent(f.a.db,{...args,fetchImpl:async(...xs)=>{const r=await fetch(...xs);if(xs[0].endsWith("/offer")){await r.arrayBuffer();throw Error("fixture lost ACK");}return r;}});
 assert.equal(lost.state,"pending");assert.equal(lost.delivery_state,"retry_pending");assert.equal(count(f.b.db,"delegation_incoming"),1);
 const offline=await deliverIntent(f.a.db,{...args,fetchImpl:async()=>{throw Error("secret fixture must not be persisted");}});assert.equal(offline.last_error_code,"TRANSPORT_ERROR");assert.ok(!JSON.stringify(offline).includes("secret fixture"));
 decide(f);const retried=await deliverIntent(f.a.db,args);assert.equal(retried.state,"accepted_unconfirmed");assert.equal(retried.attempts,3);assert.equal(count(f.b.db,"tasks"),1);
});
test("existing sync-only credentials cannot post an offer and status cannot read another peer's offer",async()=>{
 const f=pair(),url=await network(f.b),other=fixture(),g=grant(other,f.b,{scopes:["peer:handshake","sync:pull","sync:ack"]});
 let r=await fetch(url+"/peer/v1/delegation/offer",{method:"POST",headers:{Authorization:g.auth,"Content-Type":"application/json"},body:JSON.stringify({offer:f.out.offer})});assert.equal(r.status,403);assert.equal(count(f.b.db,"delegation_incoming"),0);
 receive(f);const h=grant(other,f.b,{expectedVersion:1});
 r=await fetch(url+"/peer/v1/delegation/status",{method:"POST",headers:{Authorization:h.auth,"Content-Type":"application/json"},body:JSON.stringify({delegation_id:f.out.delegation_id,project_id:"demo"})});assert.equal(r.status,404);
});
test("wrong pinned receiver credentials are refused before making any network request",async()=>{
 const f=pair(),other=fixture(),g=grant(f.a,other);let called=false;
 await assert.rejects(()=>deliverIntent(f.a.db,{delegationId:f.out.delegation_id,url:fixtureEndpoint(other.db),credentialFile:g.file,fetchImpl:async()=>{called=true;}}),{code:"IDENTITY_MISMATCH"});
 assert.equal(called,false);assert.equal(outgoingStatus(f.a.db,f.out.delegation_id).attempts,0);
});
test("invalid receipt persistence stays retryable and does not acknowledge a successful write",async()=>{
 const f=pair(),url=await network(f.b);f.a.db.exec("CREATE TRIGGER refuse_receipt BEFORE UPDATE OF receipt_json ON delegation_outgoing BEGIN SELECT RAISE(ABORT,'injected receipt'); END");
 const args={delegationId:f.out.delegation_id,url,credentialFile:f.g.file},result=await deliverIntent(f.a.db,args);
 assert.equal(result.state,"pending");assert.equal(result.delivery_state,"retry_pending");assert.equal(count(f.b.db,"delegation_incoming"),1);
 f.a.db.exec("DROP TRIGGER refuse_receipt");assert.equal((await deliverIntent(f.a.db,args)).state,"received");
});
test("malformed credential diagnostics never repeat credential file fragments",async()=>{
 const f=pair(),file=join(TMP,"malformed.json");writeFileSync(file,'{"token":"secret-token-fragment');
 await assert.rejects(()=>deliverIntent(f.a.db,{delegationId:f.out.delegation_id,url:"http://127.0.0.1:1",credentialFile:file}),e=>e.code==="BAD_CREDENTIAL"&&!e.message.includes("secret-token"));
});
function coordinator(f,kind="coordinate",projects=["demo"],maxOpen=100){
 const role_id="role-"+serial++;putRole(f.db,{role_id,kind,projects,capabilities:[],runtime:null,model:null,effort:null,tools:kind==="observe"?"read-only":"write",priority:1,enabled:true,limits:{max_task_attempts:1,max_open_tasks:maxOpen,requests_per_minute:300}});
 const file=join(TMP,"principal-"+serial+++".json");issuePrincipal(f.db,{roleId:role_id,projects,credentialFile:file});return "Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
}
test("MCP coordinates proposal and decision with project scope, replay and receiver role quotas",()=>{
 const a=fixture(),b=fixture(),t=card(a),g=grant(a,b),auth=coordinator(a),target=coordinator(b),observer=coordinator(b,"observe"),other=coordinator(b,"coordinate",["other"]);
 const args={request_id:randomUUID(),task_uid:t.task_uid,expected_version:t.aggregate_version,target_node_id:b.node.node_id,target_epoch:b.node.sync_epoch};
 const proposed=callTool(a.db,auth,"create_delegation",args);assert.deepEqual(callTool(a.db,auth,"create_delegation",args),proposed);receiveOffer(b.db,g.peer,proposed.offer);
 const decision={request_id:randomUUID(),delegation_id:proposed.delegation_id,expected_version:1,decision:"accept",note:"reviewed contract"};
 assert.throws(()=>callTool(b.db,observer,"decide_delegation",decision),{code:"FORBIDDEN"});assert.throws(()=>callTool(b.db,other,"decide_delegation",decision),{code:"NOT_FOUND"});
 const r=callTool(b.db,target,"decide_delegation",decision);assert.deepEqual(callTool(b.db,target,"decide_delegation",decision),r);assert.equal(count(b.db,"tasks"),1);
 assert.equal(callTool(b.db,observer,"get_delegation",{delegation_id:r.delegation_id,direction:"incoming"}).receipt.state,"accepted_unconfirmed");
 const next=createIntent(a.db,{delegationId:randomUUID(),taskUid:t.task_uid,expectedVersion:t.aggregate_version,targetNodeId:b.node.node_id,targetEpoch:b.node.sync_epoch});receiveOffer(b.db,g.peer,next.offer);
 assert.throws(()=>callTool(b.db,coordinator(b,"coordinate",["demo"],1),"decide_delegation",{...decision,request_id:randomUUID(),delegation_id:next.delegation_id}),{code:"BUDGET_EXHAUSTED"});assert.equal(count(b.db,"tasks"),1);
});
test("MCP audit failure rolls back the accepted task, decision and tool replay receipt together",()=>{
 const f=pair();receive(f);const auth=coordinator(f.b),before=snapshot(f.b.db);
 f.b.db.exec("CREATE TRIGGER refuse_broker_receipt BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'injected broker receipt'); END");
 assert.throws(()=>callTool(f.b.db,auth,"decide_delegation",{request_id:randomUUID(),delegation_id:f.out.delegation_id,expected_version:1,decision:"accept",note:""}),/injected broker receipt/);
 assert.equal(snapshot(f.b.db),before);assert.equal(count(f.b.db,"broker_requests"),0);
});
test("administration CLI uses explicit databases and persists a reviewable proposal and decision",()=>{
 const f=pair();receive(f);const run=args=>spawnSync(process.execPath,[join(ROOT,"cli/delegation.mjs"),...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});
 const result=run(["decide","--db",f.b.dbPath,"--id",f.out.delegation_id,"--decision-id",randomUUID(),"--version","1","--decision","accept"]);
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).state,"accepted_unconfirmed");
 const list=run(["list","--db",f.b.dbPath,"--direction","incoming","--project","demo"]);assert.equal(list.status,0,list.stderr);assert.equal(JSON.parse(list.stdout).length,1);
 const noDb=run(["list","--direction","incoming","--project","demo"]);assert.equal(noDb.status,1);assert.match(noDb.stderr,/--db/);
});

test("independent processes deduplicate receipt and race accept/reject without duplicate target tasks",async()=>{
 const f=pair(),script=join(TMP,"parallel-delegation.mjs"),offerFile=join(TMP,"parallel-offer.json");writeFileSync(offerFile,JSON.stringify(f.out.offer));
 writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite";',
  'import {readFileSync} from "node:fs";',
  'import {createInterface} from "node:readline";',
  'const api=await import(process.argv[2]),auth=await import(process.argv[3]),db=new DatabaseSync(process.argv[4]);db.exec("PRAGMA busy_timeout=5000");',
  'process.stdout.write("ready\\n");',
  'for await(const line of createInterface({input:process.stdin})){',
  ' try{const input=JSON.parse(readFileSync(process.argv[6],"utf8"));let result;',
  ' if(process.argv[5]==="receive"){const c=JSON.parse(readFileSync(process.argv[7],"utf8"));result=api.receiveOffer(db,auth.authenticate(db,"Bearer "+c.token,"delegation:offer"),input);}',
  ' else result=api.decideIncoming(db,input);process.stdout.write(JSON.stringify({result})+"\\n");}',
  ' catch(e){process.stdout.write(JSON.stringify({error:e.code??"INTERNAL"})+"\\n");}',
  ' db.close();break;',
  '}'
 ].join("\n"));
 async function race(mode,files){
  const kids=files.map(file=>{
   const cp=spawn(process.execPath,[script,new URL("../core/federation/delegation.mjs",import.meta.url).href,new URL("../core/federation/peers.mjs",import.meta.url).href,f.b.dbPath,mode,file,f.g.file],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
   let out="",errors="",readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
   cp.stdout.on("data",d=>{out+=d.toString();if(out.includes("ready\n"))readyResolve();});cp.stderr.on("data",d=>errors+=d.toString());cp.once("error",readyReject);
   const done=new Promise(r=>cp.once("close",code=>{if(!out.includes("ready\n"))readyReject(Error("child startup failed: "+errors));r({code,out,errors});}));return {cp,ready,done};
  });let timer;
  try{
   await Promise.race([Promise.all(kids.map(k=>k.ready)),new Promise((_,j)=>timer=setTimeout(()=>j(Error("delegation barrier timeout")),10000))]);
   for(const k of kids)k.cp.stdin.end("go\n");
   const results=await Promise.all(kids.map(k=>k.done));assert.ok(results.every(r=>r.code===0),JSON.stringify(results));
   return results.map(r=>JSON.parse(r.out.trim().split("\n").at(-1)));
  }finally{clearTimeout(timer);for(const k of kids)if(k.cp.exitCode===null)k.cp.kill();await Promise.all(kids.map(k=>k.done));}
 }
 const offers=await race("receive",[offerFile,offerFile]);assert.ok(offers.every(x=>x.result?.state==="received"));assert.equal(count(f.b.db,"delegation_incoming"),1);assert.equal(count(f.b.db,"delegation_events"),1);
 const files=["accept","reject"].map(decision=>{const file=join(TMP,"parallel-"+decision+".json");writeFileSync(file,JSON.stringify({delegationId:f.out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision,note:"race fixture"}));return file;});
 const decisions=await race("decide",files);assert.equal(decisions.filter(x=>x.result).length,1);assert.equal(decisions.filter(x=>x.error==="CONFLICT").length,1);
 const status=incomingStatus(f.b.db,f.out.delegation_id);assert.equal(count(f.b.db,"tasks"),status.receipt.state==="accepted_unconfirmed"?1:0);assert.equal(count(f.b.db,"delegation_events"),2);
});
test("bounded proposal queues refuse new records but allow retries and decisions at capacity",()=>{
 const f=pair();for(let i=1;i<MAX_OPEN_OFFERS;i++)createIntent(f.a.db,{...f.args,delegationId:randomUUID()});
 assert.equal(count(f.a.db,"delegation_outgoing"),MAX_OPEN_OFFERS);assert.throws(()=>createIntent(f.a.db,{...f.args,delegationId:randomUUID()}),{code:"QUEUE_LIMIT"});
 for(const r of f.a.db.prepare("SELECT offer_json FROM delegation_outgoing").all())receiveOffer(f.b.db,f.g.peer,JSON.parse(r.offer_json));
 assert.equal(count(f.b.db,"delegation_incoming"),MAX_OPEN_OFFERS);
 assert.throws(()=>receiveOffer(f.b.db,f.g.peer,{...f.out.offer,delegation_id:randomUUID()}),{code:"QUEUE_LIMIT"});assert.equal(receive(f).state,"received");
 const rejected=decide(f,{decision:"reject"});recordReceipt(f.a.db,rejected.delegation_id,rejected);
 const next=createIntent(f.a.db,{...f.args,delegationId:randomUUID()});assert.equal(receiveOffer(f.b.db,f.g.peer,next.offer).state,"received");
});
test("long Unicode work contracts transfer intact while oversized serialized text is refused",async()=>{
 const f=pair(),long="界".repeat(12000),t=card(f.a,{description:long,acceptance:long}),o=createIntent(f.a.db,{...f.args,delegationId:randomUUID(),taskUid:t.task_uid,expectedVersion:t.aggregate_version});
 const url=await network(f.b),sent=await deliverIntent(f.a.db,{delegationId:o.delegation_id,url,credentialFile:f.g.file});assert.equal(sent.delivery_state,"acknowledged");
 const got=incomingStatus(f.b.db,o.delegation_id).offer;assert.equal(got.task.description,long);assert.equal(got.task.acceptance,long);
 const huge="\u0001".repeat(16384),offer={...f.out.offer,task:{...f.out.offer.task,description:huge,acceptance:huge}};
 assert.throws(()=>receiveOffer(f.b.db,f.g.peer,offer),{code:"TOO_LARGE"});assert.equal(count(f.b.db,"delegation_incoming"),1);
 const large=card(f.a,{description:huge,acceptance:huge});assert.throws(()=>createIntent(f.a.db,{...f.args,delegationId:randomUUID(),taskUid:large.task_uid,expectedVersion:large.aggregate_version}),{code:"TOO_LARGE"});assert.equal(count(f.a.db,"delegation_outgoing"),2);
 const response=await fetch(url+"/peer/v1/delegation/offer",{method:"POST",headers:{Authorization:f.g.auth,"Content-Type":"application/json"},body:JSON.stringify({offer})});assert.equal(response.status,413);
});
test("a copied accepted receiver task stays held after the actual restore/activation workflow",()=>{
 const f=pair();receive(f);const r=decide(f),b=restored(f.b),status=incomingStatus(b.db,r.delegation_id);
 assert.equal(status.identity_current,false);assert.equal(status.receipt.target_task_uid,r.target_task_uid);
 assert.throws(()=>store.setReleased(b.db,{id:status.target_task_id,released:true}),/DELEGATION_UNCONFIRMED/);
 assert.equal(store.claimById(b.db,{id:status.target_task_id,worker:"after-restore"}).ok,false);
});

test("remote authorization failures are blocked and distinct from retryable transport failures",async()=>{
 const f=pair(),url=await network(f.b);revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
 const r=await deliverIntent(f.a.db,{delegationId:f.out.delegation_id,url,credentialFile:f.g.file});
 assert.equal(r.delivery_state,"blocked");assert.equal(r.last_error_code,"REMOTE_401");assert.equal(r.state,"pending");assert.equal(count(f.b.db,"delegation_incoming"),0);
});

test("a successful retry of the same receiver version clears the prior transport error",async()=>{
 const f=pair(),url=await network(f.b),args={delegationId:f.out.delegation_id,url,credentialFile:f.g.file};
 const first=await deliverIntent(f.a.db,args);assert.equal(first.state,"received");const events=count(f.a.db,"delegation_events");
 const offline=await deliverIntent(f.a.db,{...args,fetchImpl:async()=>{throw Error("offline fixture");}});assert.equal(offline.last_error_code,"TRANSPORT_ERROR");
 const recovered=await deliverIntent(f.a.db,args);assert.equal(recovered.delivery_state,"acknowledged");assert.equal(recovered.last_error_code,null);assert.equal(count(f.a.db,"delegation_events"),events);assert.equal(count(f.b.db,"tasks"),0);
});
