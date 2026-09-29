import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode,writeRecoveryJSON} from "../core/recovery.mjs";
import {migratePeers,issueCredential,authenticate,localIdentity,revokePeer} from "../core/federation/peers.mjs";
import {migrateSync,shareTask,exportBatch,applyBatch,cursor,recordSource,listReplicas,digest,canonical,syncStatus} from "../core/federation/sync-store.mjs";
import {startSnapshot,snapshotPage,beginSnapshot,receiveSnapshotPage,snapshotStage} from "../core/federation/snapshots.mjs";
import {prepareSourceRecovery,acceptSourceRecovery,sourceRecoveryHistory} from "../core/federation/epoch-recovery.mjs";
import {sourceRecoveryMarker,replicationCursor} from "../core/federation/epoch-state.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
import {syncOnce} from "../core/federation/sync-client.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-epoch-")),handles=[],servers=[];
let seq=0,tick=Date.now();const path=name=>join(TMP,name+"-"+seq++);
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const d of handles){try{d.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function node(){
 const dir=path("node");mkdirSync(dir);const evidence=join(dir,"evidence");mkdirSync(evidence);
 const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);handles.push(db);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);
 return {dir,dbPath,db,evidence,identity:localIdentity(db)};
}
function credential(a,b,projects,expectedVersion){
 const file=path("peer")+".json";
 issueCredential(a.db,{peerNodeId:b.identity.node_id,peerEpoch:b.identity.sync_epoch,scopes:["peer:handshake","sync:pull","sync:ack"],projects,credentialFile:file,expectedVersion});
 const c=JSON.parse(readFileSync(file,"utf8"));return {file,c,peer:authenticate(a.db,"Bearer "+c.token)};
}
function task(a,projectId="demo"){
 const id=store.add(a.db,{subject:"fixture "+seq++});shareTask(a.db,{id,projectId,expectedVersion:1});return id;
}
function flush(a,peer,projectId="demo"){
 let after=0,batches=[];
 for(;;){const b=exportBatch(a.db,peer,{project_id:projectId,after_seq:after});batches.push(b);after=b.events.at(-1)?.seq??after;if(after>=b.head_seq&&!b.pending_count)return batches;}
}
function copy(b,source,batches){recordSource(b.db,source.identity);for(const batch of batches)applyBatch(b.db,{origin:source.identity.node_id,epoch:source.identity.sync_epoch,projectId:batch.project_id},batch);}
function restore(a,backup,retiredEpoch=a.identity.sync_epoch){
 const dir=path("restored");restoreBackup({backupDirectory:backup.destination,destination:dir});
 const dbPath=join(dir,"board.db"),plan=prepareRecovery({dbPath,retiredEpoch});
 retireNode({dbPath:a.dbPath,expectedEpoch:a.identity.sync_epoch});
 const attestation={format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated temporary test fixture; not real device evidence",attested_at:new Date().toISOString()};
 const receipt=activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation});
 const db=new DatabaseSync(dbPath);handles.push(db);migrateSync(db);
 return {dir,dbPath,db,evidence:join(dir,"evidence"),identity:localIdentity(db),receipt};
}
async function pair({cards=1,multi=false,newProjects,initialSnapshot=false}={}){
 const a=node(),b=node(),projects=multi?["demo","other"]:["demo"],old=credential(a,b,projects);
 const ids=Array.from({length:cards},()=>task(a));
 const other=multi?task(a,"other"):null;
 for(const projectId of projects){
  const batches=flush(a,old.peer,projectId);
  if(!initialSnapshot)copy(b,a,batches);
  else{
   const source={origin:a.identity.node_id,epoch:a.identity.sync_epoch,projectId};
   const m=startSnapshot(a.db,old.peer,{project_id:projectId});beginSnapshot(b.db,source,m);
   for(let offset=0;;){const page=snapshotPage(a.db,old.peer,{project_id:projectId,snapshot_id:m.snapshot_id,offset});receiveSnapshotPage(b.db,source,page);if(page.done)break;offset=page.next_offset;}
   recordSource(b.db,a.identity);
  }
 }
 const backup=createBackup({dbPath:a.dbPath,evidenceDir:a.evidence,destination:path("backup")});
 a.db.prepare("UPDATE tasks SET result='result after backup',description='newer than backup',status='done' WHERE id=?").run(ids[0]);
 const missing=task(a);a.db.prepare("UPDATE tasks SET result='missing task result' WHERE id=?").run(missing);
 const late=flush(a,old.peer);copy(b,a,late);
 const recovered=restore(a,backup),fresh=credential(recovered,b,newProjects??projects,2);
 for(const p of newProjects??projects)flush(recovered,fresh.peer,p);
 const server=await listenPeerServer(recovered.db,{port:0});servers.push(server);
 const url="http://127.0.0.1:"+server.address().port;
 const options={url,credentialFile:fresh.file,expectedEpoch:a.identity.sync_epoch};
 return {a,b,old,ids,other,missing,late,recovered,fresh,server,url,options,
  source:{origin:a.identity.node_id,epoch:recovered.identity.sync_epoch,projectId:"demo"}};
}
const prepare=f=>prepareSourceRecovery(f.b.db,f.options);
async function accept(f,plan){plan??=await prepare(f);return acceptSourceRecovery(f.b.db,{plan,expectedPlanDigest:plan.plan_digest});}
const sync=(f,extra={})=>syncOnce(f.b.db,{url:f.url,credentialFile:f.fresh.file,projectId:"demo",now:tick+=100000,...extra});
const visible=f=>listReplicas(f.b.db);
const rawSource=f=>f.b.db.prepare("SELECT origin_epoch FROM federation_sources WHERE origin_node_id=?").get(f.a.identity.node_id).origin_epoch;
function manifest(f,projectId="demo"){return startSnapshot(f.recovered.db,f.fresh.peer,{project_id:projectId});}
function page(f,m,offset=0){return snapshotPage(f.recovered.db,f.fresh.peer,{project_id:m.project_id,snapshot_id:m.snapshot_id,offset});}

test("new credentials alone cannot change the epoch and preparation preserves old visible results",async()=>{
 const f=await pair(),before=canonical(visible(f));
 const r=await sync(f);assert.equal(r.error_code,"EPOCH_CHANGED");assert.equal(rawSource(f),f.a.identity.sync_epoch);
 const p=await prepare(f);assert.equal(p.binding.new_epoch,f.recovered.identity.sync_epoch);assert.equal(p.projects[0].replicas,2);
 assert.equal(canonical(visible(f)),before);assert.equal(snapshotStage(f.b.db,f.source),null);
 assert.ok(!JSON.stringify(p).includes(f.fresh.c.token));
 const marker=sourceRecoveryMarker(f.recovered.db);assert.equal(marker.receipt_digest.length,64);
 assert.deepEqual(Object.keys(marker).sort(),["activated_at","backup_epoch","format","new_epoch","node_id","receipt_digest","recovery_id","retired_epoch"]);
});

test("acceptance fences old traffic while a paged new snapshot retains old visible tasks",async()=>{
 const f=await pair({cards:61});await accept(f);
 let requests=0;
 const old=await sync(f,{credentialFile:f.old.file,fetchImpl:()=>{requests++;throw Error("must not send");}});
 assert.equal(old.error_code,"RETIRED_EPOCH");assert.equal(requests,0);
 assert.throws(()=>applyBatch(f.b.db,{origin:f.a.identity.node_id,epoch:f.a.identity.sync_epoch,projectId:"demo"},f.late[0]),{code:"RETIRED_EPOCH"});
 assert.throws(()=>recordSource(f.b.db,f.a.identity),{code:"RETIRED_EPOCH"});
 const next=flush(f.recovered,f.fresh.peer)[0];assert.throws(()=>applyBatch(f.b.db,f.source,next),{code:"SNAPSHOT_REQUIRED"});
 const r=await sync(f,{maxBatches:1});assert.equal(r.state,"pending");assert.equal(visible(f).length,62);
 assert.equal(visible(f).find(x=>x.task_uid===store.get(f.a.db,f.ids[0]).task_uid).result,"result after backup");
 assert.ok(visible(f).every(x=>x.recovery_state==="pending_snapshot"));
 assert.equal(f.b.db.prepare("SELECT origin_epoch FROM federation_cursors").get().origin_epoch,f.a.identity.sync_epoch);
});

test("verified cutover archives regressed results and keeps absent tasks visible for review",async()=>{
 const f=await pair();await accept(f);const result=await sync(f);assert.equal(result.state,"synced");
 const rows=visible(f),first=rows.find(x=>x.task_uid===store.get(f.a.db,f.ids[0]).task_uid),missing=rows.find(x=>x.task_uid===store.get(f.a.db,f.missing).task_uid);
 assert.equal(first.source_epoch,f.recovered.identity.sync_epoch);assert.equal(first.result,null);assert.equal(first.recovery_state,null);
 assert.equal(missing.result,"missing task result");assert.equal(missing.recovery_state,"missing_review");assert.equal(missing.source_epoch,f.a.identity.sync_epoch);
 const history=sourceRecoveryHistory(f.b.db,f.a.identity.node_id);
 assert.ok(history.archive.some(x=>x.table_name==="federation_replicas"&&JSON.parse(x.row.task_json??"null")?.result==="result after backup"));
 assert.equal(history.projects[0].state,"installed");assert.equal(history.missing.length,1);
 assert.equal(store.list(f.b.db).tasks.length,0);assert.equal(store.claim(f.b.db,{worker:"cannot-claim-replicas"}),null);
 f.recovered.db.prepare("UPDATE tasks SET description='new epoch delta' WHERE id=?").run(f.ids[0]);
 assert.equal((await sync(f)).state,"synced");assert.equal(visible(f).find(x=>x.task_uid===first.task_uid).description,"new epoch delta");
});

test("bad or disconnected source recovery markers and unsupported capabilities refuse a plan",async()=>{
 const f=await pair();
 for(const mutate of [h=>h.extensions.source_recovery.retired_epoch=randomUUID(),h=>delete h.extensions.source_recovery,h=>h.capabilities=h.capabilities.filter(x=>x!=="source-epoch-recovery-v1")]){
  const fetchImpl=async(...args)=>{const response=await fetch(...args),h=await response.json();mutate(h);return new Response(JSON.stringify(h));};
  await assert.rejects(prepareSourceRecovery(f.b.db,{...f.options,fetchImpl}));
 }
 assert.equal(rawSource(f),f.a.identity.sync_epoch);
});

test("edited, miscounted, stale or wrong-directory plans cannot authorize a transition",async()=>{
 const f=await pair(),p=await prepare(f);
 await assert.rejects(acceptSourceRecovery(f.b.db,{plan:p,expectedPlanDigest:"0".repeat(64)}),{code:"PLAN_CHANGED"});
 const changed=structuredClone(p);changed.projects[0].replicas=999;const {plan_digest,...body}=changed;changed.plan_digest=digest(body);
 await assert.rejects(acceptSourceRecovery(f.b.db,{plan:changed,expectedPlanDigest:changed.plan_digest}),{code:"PLAN_CHANGED"});
 const other=node();await assert.rejects(acceptSourceRecovery(other.db,{plan:p,expectedPlanDigest:p.plan_digest}),{code:"PLAN_CHANGED"});
 f.b.db.prepare("UPDATE federation_cursors SET updated_at='changed after review'").run();
 await assert.rejects(acceptSourceRecovery(f.b.db,{plan:p,expectedPlanDigest:p.plan_digest}),{code:"PLAN_CHANGED"});
 assert.equal(rawSource(f),f.a.identity.sync_epoch);
});

test("acceptance failure rolls back the retirement fence, project state and source identity",async()=>{
 const f=await pair(),p=await prepare(f);
 f.b.db.exec("CREATE TRIGGER reject_acceptance BEFORE UPDATE ON federation_sources BEGIN SELECT RAISE(ABORT,'injected acceptance failure'); END");
 await assert.rejects(accept(f,p),/injected acceptance failure/);
 assert.equal(rawSource(f),f.a.identity.sync_epoch);
 assert.equal(f.b.db.prepare("SELECT count(*) n FROM federation_retired_epochs").get().n,0);
 assert.equal(f.b.db.prepare("SELECT count(*) n FROM federation_epoch_acceptances").get().n,0);
 f.b.db.exec("DROP TRIGGER reject_acceptance");await accept(f,p);
});

test("corrupt final snapshot and commit failure leave old replicas and approved pending state intact",async()=>{
 const f=await pair();await accept(f);const m=manifest(f);beginSnapshot(f.b.db,f.source,m);
 const bad=page(f,m);bad.events[0].payload.task.subject="tampered";const {page_digest,...body}=bad;bad.page_digest=digest(body);
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,bad),{code:"CONTENT_MISMATCH"});
 assert.equal(visible(f).length,2);assert.equal(snapshotStage(f.b.db,f.source).next_offset,0);
 f.b.db.exec("CREATE TRIGGER reject_cutover BEFORE UPDATE ON federation_cursors BEGIN SELECT RAISE(ABORT,'injected cutover failure'); END");
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,page(f,m)),/injected cutover failure/);
 assert.ok(visible(f).every(x=>x.recovery_state==="pending_snapshot"));assert.equal(f.b.db.prepare("SELECT count(*) n FROM federation_epoch_archive WHERE table_name='federation_replicas'").get().n,0);
 f.b.db.exec("DROP TRIGGER reject_cutover");assert.equal(receiveSnapshotPage(f.b.db,f.source,page(f,m)).installed,true);
});

test("a child process exit before cutover commit preserves old data and resumable staging",async()=>{
 const f=await pair();await accept(f);const m=manifest(f);beginSnapshot(f.b.db,f.source,m);
 const input=path("page")+".json";writeFileSync(input,JSON.stringify({source:f.source,page:page(f,m)}));
 const script='import {DatabaseSync} from "node:sqlite";import {readFileSync} from "node:fs";import {receiveSnapshotPage} from '+JSON.stringify(new URL("../core/federation/snapshots.mjs",import.meta.url).href)+';const db=new DatabaseSync(process.argv[1]);const old=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==="COMMIT")process.exit(73);return old.call(this,sql);};const input=JSON.parse(readFileSync(process.argv[2],"utf8"));receiveSnapshotPage(db,input.source,input.page);';
 const child=spawnSync(process.execPath,["--input-type=module","-e",script,f.b.dbPath,input],{encoding:"utf8",windowsHide:true,timeout:15000});
 assert.equal(child.status,73,child.stderr);assert.equal(snapshotStage(f.b.db,f.source).next_offset,0);
 assert.ok(visible(f).every(x=>x.recovery_state==="pending_snapshot"));assert.equal((await sync(f)).state,"synced");
});

test("multiple projects install separately and a narrower credential leaves others visibly pending",async()=>{
 const f=await pair({multi:true,newProjects:["demo"]});await accept(f);
 assert.equal((await sync(f)).state,"synced");
 assert.equal(syncStatus(f.b.db).epoch_projects.find(x=>x.project_id==="other").state,"pending");
 assert.equal(visible(f).find(x=>x.project_id==="other").recovery_state,"pending_snapshot");
 await assert.rejects(sync(f,{projectId:"other"}),{code:"FORBIDDEN"});
 f.fresh=credential(f.recovered,f.b,["demo","other"],3);flush(f.recovered,f.fresh.peer,"other");
 assert.equal((await sync(f,{projectId:"other"})).state,"synced");
 assert.ok(syncStatus(f.b.db).epoch_projects.every(x=>x.state==="installed"));
});

test("a revoked credential cannot approve a prepared transition or finish downloading",async()=>{
 const f=await pair(),p=await prepare(f);
 revokePeer(f.recovered.db,{peerNodeId:f.b.identity.node_id,expectedVersion:3});
 await assert.rejects(accept(f,p),{code:"REMOTE_401"});assert.equal(rawSource(f),f.a.identity.sync_epoch);
 f.fresh=credential(f.recovered,f.b,["demo"],4);f.options.credentialFile=f.fresh.file;await accept(f);
 let revoked=false;
 const r=await sync(f,{fetchImpl:async(...args)=>{if(args[0].endsWith("/snapshot/page")&&!revoked){revokePeer(f.recovered.db,{peerNodeId:f.b.identity.node_id,expectedVersion:5});revoked=true;}return fetch(...args);}});
 assert.equal(r.state,"error");assert.equal(r.error_code,"REMOTE_401");assert.ok(visible(f).every(x=>x.recovery_state==="pending_snapshot"));
});

test("losing the post-install ACK does not repeat the cutover or lose the archive",async()=>{
 const f=await pair();await accept(f);let drop=true;
 const r=await sync(f,{fetchImpl:async(...args)=>{if(args[0].endsWith("/ack")&&drop){drop=false;throw Error("lost ACK");}return fetch(...args);}});
 assert.equal(r.state,"error");assert.equal(syncStatus(f.b.db).epoch_projects[0].state,"installed");
 const n=sourceRecoveryHistory(f.b.db,f.a.identity.node_id).archive.length;
 assert.equal((await sync(f)).state,"synced");assert.equal(sourceRecoveryHistory(f.b.db,f.a.identity.node_id).archive.length,n);
});

test("recovery cannot move a previously observed task into another project",async()=>{
 const f=await pair({multi:true});await accept(f);
 const m=manifest(f),p=page(f,m),other={...m,project_id:"other",snapshot_id:randomUUID()};
 for(const e of p.events){e.project_id="other";const {event_digest,...unsigned}=e;e.event_digest=digest(unsigned);}
 other.content_digest=digest(p.events);other.checkpoint.event_digest=p.events.find(e=>e.seq===other.head_seq).event_digest;
 const otherSource={...f.source,projectId:"other"};beginSnapshot(f.b.db,otherSource,other);
 p.snapshot_id=other.snapshot_id;const {page_digest,...body}=p;p.page_digest=digest(body);
 assert.throws(()=>receiveSnapshotPage(f.b.db,otherSource,p),{code:"OWNER_MISMATCH"});
 assert.equal(syncStatus(f.b.db).epoch_projects.find(x=>x.project_id==="other").state,"pending");
});

test("another recovery supersedes unfinished project staging without losing the old visible results",async()=>{
 const f=await pair({cards:30,multi:true});await accept(f);
 assert.equal((await sync(f,{maxBatches:1})).state,"pending");const stale=manifest(f),staleSource={...f.source};
 const backup=createBackup({dbPath:f.recovered.dbPath,evidenceDir:f.recovered.evidence,destination:path("second-backup")});
 f.server.closeAllConnections();await new Promise(r=>f.server.close(r));
 const priorEpoch=f.recovered.identity.sync_epoch,second=restore(f.recovered,backup);
 f.fresh=credential(second,f.b,["demo","other"],4);f.recovered=second;
 for(const p of ["demo","other"])flush(second,f.fresh.peer,p);
 f.server=await listenPeerServer(second.db,{port:0});servers.push(f.server);f.url="http://127.0.0.1:"+f.server.address().port;
 f.options={url:f.url,credentialFile:f.fresh.file,expectedEpoch:priorEpoch};
 f.source={origin:second.identity.node_id,epoch:second.identity.sync_epoch,projectId:"demo"};
 const plan=await prepare(f);assert.ok(plan.projects.every(x=>x.previous_pending));
 await accept(f,plan);assert.equal(snapshotStage(f.b.db,f.source),null);
 assert.throws(()=>beginSnapshot(f.b.db,staleSource,stale),{code:"RETIRED_EPOCH"});
 assert.equal(visible(f).find(x=>x.task_uid===store.get(f.a.db,f.ids[0]).task_uid).result,"result after backup");
 assert.equal((await sync(f)).state,"synced");assert.equal((await sync(f,{projectId:"other"})).state,"synced");
 const history=sourceRecoveryHistory(f.b.db,f.a.identity.node_id);assert.equal(history.acceptances.length,2);
 assert.ok(history.archive.some(x=>x.table_name==="federation_epoch_projects"&&x.row.state==="pending"));
 assert.equal(history.missing.length,1);
});

test("a missing task reappearing in the approved epoch resolves its flag and retains old evidence",async()=>{
 const f=await pair();await accept(f);await sync(f);
 const historical=sourceRecoveryHistory(f.b.db,f.a.identity.node_id).missing[0];
 const task=JSON.parse(historical.replica.task_json),after=cursor(f.b.db,f.source.origin,f.source.epoch,"demo");
 task.aggregate_version=1;task.result="owner recovered this task";task.updated_at=new Date().toISOString();
 const payload={task},e={schema_version:1,event_id:randomUUID(),origin_node_id:f.source.origin,origin_epoch:f.source.epoch,project_id:"demo",seq:after+1,aggregate_uid:task.task_uid,aggregate_version:1,kind:"task.snapshot",payload,payload_digest:digest(payload)};
 e.event_digest=digest(e);
 const batch={protocol_version:1,origin_node_id:f.source.origin,origin_epoch:f.source.epoch,project_id:"demo",after_seq:after,head_seq:e.seq,pending_count:0,checkpoint:{seq:e.seq,event_digest:e.event_digest},events:[e]};
 assert.equal(applyBatch(f.b.db,f.source,batch).applied,1);
 const item=visible(f).find(x=>x.task_uid===task.task_uid);assert.equal(item.recovery_state,null);assert.equal(item.result,"owner recovered this task");
 const h=sourceRecoveryHistory(f.b.db,f.a.identity.node_id);assert.ok(h.missing[0].resolved_at);assert.equal(JSON.parse(h.missing[0].replica.task_json).result,"missing task result");
});

test("an authenticated empty project snapshot preserves all old tasks as missing-review records",async()=>{
 const f=await pair();await accept(f);
 // Deliberately model an owner restoring a backup from before any shared task existed.
 const m={snapshot_version:1,snapshot_id:randomUUID(),origin_node_id:f.source.origin,origin_epoch:f.source.epoch,project_id:"demo",head_seq:0,checkpoint:null,record_count:0,content_digest:digest([]),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()};
 beginSnapshot(f.b.db,f.source,m);
 const p={snapshot_id:m.snapshot_id,offset:0,next_offset:0,done:true,events:[]};p.page_digest=digest(p);
 assert.equal(receiveSnapshotPage(f.b.db,f.source,p).installed,true);
 assert.equal(visible(f).length,2);assert.ok(visible(f).every(x=>x.recovery_state==="missing_review"));
 assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,"demo"),0);
});

test("snapshot event receipts prevent identity reuse across recovery epochs",async()=>{
 const f=await pair({cards:2,initialSnapshot:true});
 // This non-head event was initially learned only from a snapshot.
 const oldEvent=JSON.parse(f.a.db.prepare("SELECT event_json FROM federation_outbox WHERE project_id=\'demo\' AND seq=1").get().event_json);
 await accept(f);const m=manifest(f),p=page(f,m);
 p.events[0].event_id=oldEvent.event_id;
 const {event_digest,...unsigned}=p.events[0];p.events[0].event_digest=digest(unsigned);
 m.content_digest=digest(p.events);m.checkpoint.event_digest=p.events.find(e=>e.seq===m.head_seq).event_digest;
 const {page_digest,...body}=p;p.page_digest=digest(body);
 beginSnapshot(f.b.db,f.source,m);
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,p),{code:"CONTENT_MISMATCH"});
 assert.ok(visible(f).every(x=>x.recovery_state==="pending_snapshot"));
});

async function cli(args){
 const cp=spawn(process.execPath,[join(ROOT,"cli/source-recovery.mjs"),...args],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let out="",error="",timer;cp.stdout.on("data",b=>out+=b);cp.stderr.on("data",b=>error+=b);
 const closed=new Promise(resolve=>cp.once("close",resolve));
 try{
  const status=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error("CLI timeout: "+error)),15000);cp.once("error",reject);cp.once("close",resolve);});
  return {status,out,error};
 }finally{clearTimeout(timer);if(cp.exitCode===null)cp.kill();await closed;}
}
test("independent CLI prepares an exclusive plan, checks its digest, and exposes preserved history",async()=>{
 const f=await pair(),file=path("receiver-plan")+".json";
 const args=["prepare","--db",f.b.dbPath,"--url",f.url,"--credential-file",f.fresh.file,"--expected-epoch",f.a.identity.sync_epoch,"--plan-file",file];
 const prepared=await cli(args);assert.equal(prepared.status,0,prepared.error);
 assert.notEqual((await cli(args)).status,0);
 const p=JSON.parse(readFileSync(file,"utf8"));
 assert.notEqual((await cli(["accept","--db",f.b.dbPath,"--plan-file",file])).status,0);
 const accepted=await cli(["accept","--db",f.b.dbPath,"--plan-file",file,"--plan-digest",p.plan_digest]);assert.equal(accepted.status,0,accepted.error);
 assert.equal((await sync(f)).state,"synced");
 const history=await cli(["history","--db",f.b.dbPath,"--origin",f.a.identity.node_id]);assert.equal(history.status,0,history.error);
 assert.equal(JSON.parse(history.out).missing.length,1);assert.ok(!history.out.includes(f.fresh.c.token));
});

test("acceptance revokes the reverse-direction old credential and forbids reauthorizing its retired epoch",async()=>{
 const f=await pair(),reverse=credential(f.b,f.a,["demo"]),plan=await prepare(f);
 assert.equal(plan.local_credential.revocation_required,true);assert.equal(plan.local_credential.credential_version,1);
 const receipt=await accept(f,plan);assert.equal(receipt.local_credentials_revoked,1);
 assert.throws(()=>authenticate(f.b.db,"Bearer "+reverse.c.token),{code:"UNAUTHENTICATED"});
 assert.throws(()=>credential(f.b,f.a,["demo"],2),{code:"RETIRED_EPOCH"});
 const renewed=credential(f.b,f.recovered,["demo"],2);
 assert.equal(authenticate(f.b.db,"Bearer "+renewed.c.token).peer_epoch,f.recovered.identity.sync_epoch);
 assert.ok(f.b.db.prepare("SELECT 1 FROM federation_auth_events WHERE action='source_epoch_revoke'").get());
});
