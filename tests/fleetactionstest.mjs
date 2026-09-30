import {authenticate} from "../core/federation/peers.mjs";
import {createIntent,receiveOffer,decideIncoming,recordReceipt} from "../core/federation/delegation.mjs";
import {migrateRelations,createRelationGraph,publishTopology,approveRelation,relationStatus} from "../core/federation/relations.mjs";
import {bindTopology,prepareTopology,startTopologyAttempt,acceptTopologyReceipt} from "../core/federation/topology.mjs";
import {migrateBindings,prepareBinding,bindingMessage,receiveBindingMessage,recordBindingMessage,startBindingAttempt,acceptBindingReceipt} from "../core/federation/bindings.mjs";
import {migrateResults} from "../core/federation/results.mjs";
import {migrateDispatch,putQuota,prepareDispatch,authorizeLaunch,finishDispatch} from "../core/execution/dispatch.mjs";
import test,{after} from "node:test";
import {spawn} from "node:child_process";
import {createServer as createNetServer} from "node:net";
import {fileURLToPath} from "node:url";
import {setTimeout as sleep} from "node:timers/promises";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join,relative} from "node:path";
import {tmpdir} from "node:os";
import {localIdentity,issueCredential,migratePeers} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,issuePrincipal,revokePrincipal} from "../core/mcp/policy.mjs";
import {enrollTask,callTool} from "../core/mcp/tools.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
import {openFleetActions} from "../core/fleet-actions.mjs";
const store=createRequire(import.meta.url)("../core/store.js"),TMP=mkdtempSync(join(tmpdir(),"fleet-actions-")),dbs=[],servers=[],controllers=[];let serial=0;
after(async()=>{for(const a of controllers)await a.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}assert.ok(!relative(tmpdir(),TMP).startsWith(".."));rmSync(TMP,{recursive:true,force:true});});
function node(projects=["demo"]){
 const dir=join(TMP,String(serial++));mkdirSync(dir);const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);
 const policy={role_id:"coord",kind:"coordinate",projects,capabilities:[],runtime:null,model:null,effort:null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:1,max_open_tasks:50,requests_per_minute:300}};putRole(db,policy);
 const principal_file=join(dir,"coord.json"),principal=issuePrincipal(db,{roleId:"coord",projects,credentialFile:principal_file}),identity=localIdentity(db);
 return {dir,dbPath,db,identity,principal_file,principal,policy,config:{format:"ai-fleet-actions/v1",node_id:identity.node_id,node_epoch:identity.sync_epoch,principal_file,peers:[]}};
}
function card(n,project="demo"){
 const id=store.add(n.db,{subject:"操作测试 <text>",description:"public work",acceptance:"explicit review",treeMode:"hierarchical",released:0}),t=store.get(n.db,id);enrollTask(n.db,{id,projectId:project,workKind:"implement",capabilities:["board-tools"],expectedVersion:t.aggregate_version});return store.get(n.db,id);
}
async function pair({fetchImpl=fetch}={}){
 const a=node(),b=node();const server=await listenPeerServer(b.db,{port:0});servers.push(server);
 const credential_file=join(a.dir,"peer.json");issueCredential(b.db,{peerNodeId:a.identity.node_id,peerEpoch:a.identity.sync_epoch,scopes:["peer:handshake","delegation:offer","delegation:status"],projects:["demo"],credentialFile:credential_file});
 a.config.peers=[{node_id:b.identity.node_id,node_epoch:b.identity.sync_epoch,projects:["demo"],url:"http://127.0.0.1:"+server.address().port,credential_file}];
 let clock=Date.now();const open=(n,extra={})=>{const c=openFleetActions(n.db,{config:n.config,now:()=>clock,...extra});controllers.push(c);return c;};
 return {a,b,source:open(a,{fetchImpl}),target:open(b),open,now:()=>clock,advance:ms=>clock+=ms};
}
function proposal(f,t=card(f.a)){return {action_id:randomUUID(),project_id:"demo",command:"create_delegation",arguments:{task_uid:t.task_uid,expected_version:t.aggregate_version,target_node_id:f.b.identity.node_id,target_epoch:f.b.identity.sync_epoch}};}
const rows=db=>db.prepare("SELECT count(*) n FROM fleet_operator_actions").get().n;
test("actual HTTP proposal, acceptance and status stay distinct and duplicate clicks create one target task",async()=>{
 const f=await pair(),input=proposal(f),r=f.source.enqueue(input);assert.equal(r.state,"pending");for(let i=0;i<10;i++)assert.deepEqual(f.source.enqueue(input),r);
 assert.deepEqual(f.source.enqueue({...input,action_id:randomUUID()}),r);assert.equal(rows(f.a.db),1);await f.source.tick();const incoming=f.target.catalog("demo").incoming;assert.equal(incoming.length,1);assert.equal(incoming[0].state,"received");assert.equal(store.list(f.b.db).tasks.length,0);
 const decision={action_id:randomUUID(),project_id:"demo",command:"decide_delegation",arguments:{delegation_id:input.action_id,expected_version:1,decision:"accept",note:"accept as unconfirmed"}};
 const accepted=f.target.enqueue(decision);assert.equal(accepted.state,"applied");assert.equal(accepted.result.state,"accepted_unconfirmed");assert.deepEqual(f.target.enqueue(decision),accepted);
 assert.equal(store.list(f.b.db).tasks.length,1);assert.equal(store.list(f.b.db).tasks[0].released,false);assert.equal(f.b.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);
 f.source.enqueue({action_id:randomUUID(),project_id:"demo",command:"poll_delegation",arguments:{id:input.action_id}});await f.source.tick();
 assert.equal(f.source.catalog("demo").outgoing[0].state,"accepted_unconfirmed");
 assert.equal(f.source.catalog("demo").actions.filter(a=>a.state==="acknowledged").length,2);
});
test("lost acknowledgement resumes same durable intent after reopen without another target task",async()=>{
 let lost=true;const f=await pair({fetchImpl:async(...args)=>{const r=await fetch(...args);if(lost&&String(args[0]).endsWith("/offer")){lost=false;await r.arrayBuffer();throw Error("lost ACK PRIVATE");}return r;}});
 const input=proposal(f);f.source.enqueue(input);await f.source.tick();assert.equal(f.source.catalog("demo").actions[0].state,"retry_pending");assert.equal(f.target.catalog("demo").incoming.length,1);
 await f.source.close();f.advance(31000);const reopened=f.open(f.a);await reopened.tick();assert.equal(reopened.catalog("demo").actions[0].state,"acknowledged");assert.equal(f.target.catalog("demo").incoming.length,1);
 assert.equal(store.list(f.b.db).tasks.length,0);assert.equal(JSON.stringify(reopened.catalog("demo")).includes("PRIVATE"),false);
});
test("offline retry is bounded and queue crash reservation replays one intent",async()=>{
 let requests=0;const f=await pair({fetchImpl:async()=>{requests++;throw Error("offline");}}),input=proposal(f);f.source.enqueue(input);
 await Promise.all([f.source.tick(),f.source.tick()]);assert.equal(requests,1);assert.equal(f.source.catalog("demo").actions[0].state,"retry_pending");await f.source.tick();assert.equal(requests,1);
 f.advance(31000);await f.source.tick();assert.equal(requests,2);await f.source.close();f.advance(31000);
 f.a.db.prepare("UPDATE fleet_operator_actions SET next_attempt_at=?,attempts=attempts+1").run(f.now()+60000);const next=f.open(f.a);await next.tick();assert.equal(f.target.catalog("demo").incoming.length,0);f.advance(61000);await next.tick();assert.equal(f.target.catalog("demo").incoming.length,1);
});
test("coordinator revocation between handshake and offer prevents the mutating request",async()=>{
 let f,network=0;f=await pair({fetchImpl:async(...args)=>{network++;const r=await fetch(...args);if(String(args[0]).endsWith("/hello"))revokePrincipal(f.a.db,{principalId:f.a.principal.principal_id,expectedVersion:1});return r;}});
 f.source.enqueue(proposal(f));await f.source.tick();assert.equal(network,1);assert.equal(f.target.catalog("demo").incoming.length,0);assert.throws(()=>f.source.catalog("demo"));assert.equal(f.a.db.prepare("SELECT state FROM fleet_operator_actions").get().state,"blocked");
});
test("wrong project, stale task, altered request and unknown URL fields roll back all writes",async()=>{
 const f=await pair(),t=card(f.a),input=proposal(f,t);
 for(const change of [x=>x.project_id="secret",x=>x.arguments.expected_version++,x=>x.arguments.url="https://attacker.invalid",x=>x.arguments.request_id=randomUUID(),x=>x.command="report_result",x=>x.arguments.target_epoch=randomUUID()]){
  const x=structuredClone(input);change(x);assert.throws(()=>f.source.enqueue(x));assert.equal(rows(f.a.db),0);assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_outgoing").get().n,0);
 }
 f.source.enqueue(input);const conflict=structuredClone(input);conflict.arguments.expected_version++;assert.throws(()=>f.source.enqueue(conflict),{code:"REQUEST_CONFLICT"});assert.equal(rows(f.a.db),1);
});
test("queue persistence failure atomically rolls back proposal and MCP request record",async()=>{
 const f=await pair(),input=proposal(f);f.a.db.exec("CREATE TRIGGER fail_action BEFORE INSERT ON fleet_operator_actions BEGIN SELECT RAISE(ABORT,'injected action failure'); END");
 assert.throws(()=>f.source.enqueue(input),/injected action/);assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_outgoing").get().n,0);assert.equal(f.a.db.prepare("SELECT count(*) n FROM broker_requests WHERE request_id=?").get(input.action_id).n,0);
 f.a.db.exec("DROP TRIGGER fail_action");assert.equal(f.source.enqueue(input).state,"pending");
});
test("catalog never exposes peer endpoints, credentials or another project's action records",async()=>{
 const f=await pair();f.source.enqueue(proposal(f));const encoded=JSON.stringify(f.source.catalog("demo"));const credential=JSON.parse(readFileSync(f.a.config.peers[0].credential_file,"utf8"));const local=JSON.parse(readFileSync(f.a.principal_file,"utf8"));
 for(const privateValue of [f.a.dir,f.a.config.peers[0].url,credential.token,local.token])assert.equal(encoded.includes(privateValue),false);
 assert.throws(()=>f.source.catalog("other"),{code:"FORBIDDEN"});
});
test("wrong node and non-coordinator reject action authority",async()=>{
 const f=await pair();const wrong=structuredClone(f.a.config);wrong.node_epoch=randomUUID();assert.throws(()=>openFleetActions(f.a.db,{config:wrong}),{code:"EPOCH_CHANGED"});
 putRole(f.a.db,{...f.a.policy,kind:"observe",tools:"read-only"},1);assert.throws(()=>f.source.enqueue(proposal(f)));assert.equal(rows(f.a.db),0);
});

test("real board HTTP action endpoints enforce operator, origin and coordinator project authority",{timeout:40000},async()=>{
 const f=await pair(),t=card(f.a),input=proposal(f,t);
 const configPath=join(f.a.dir,"board-config.json"),actionPath=join(f.a.dir,"actions.json");
 writeFileSync(configPath,JSON.stringify({lines:[{id:"fixture",label:"fixture"}],roles:[],routes:["default"],repo:f.a.dir}));
 writeFileSync(actionPath,JSON.stringify(f.a.config));
 const probe=createNetServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 let output="";const root=fileURLToPath(new URL("../",import.meta.url));
 const proc=spawn(process.execPath,[join(root,"core/server.mjs")],{cwd:f.a.dir,windowsHide:true,env:{...process.env,BOARD_HOST:"127.0.0.1",BOARD_PORT:String(port),BOARD_CONFIG:configPath,BOARD_DATA_DIR:f.a.dir,BOARD_DB:f.a.dbPath,BOARD_REPO:f.a.dir,BOARD_POOL_TEST_MODE:"1",BOARD_POOL_TEST_PROBE:"ok",BOARD_FLEET_ACTIONS_CONFIG:actionPath},stdio:["ignore","pipe","pipe"]});
 proc.stdout.on("data",b=>output+=b);proc.stderr.on("data",b=>output+=b);
 const request=(path,options={})=>fetch("http://127.0.0.1:"+port+path,{...options,signal:AbortSignal.timeout(5000)});
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await request("/health")).ok){ready=true;break;}}catch{}if(proc.exitCode!==null)break;await sleep(100);}assert.ok(ready,output);
  const operator=readFileSync(join(f.a.dir,"board_token"),"utf8").trim(),headers={"X-Board-Token":operator,"Content-Type":"application/json"};
  for(const method of ["GET","POST"]){
   const body=method==="POST"?JSON.stringify(input):undefined;
   assert.equal((await request("/api/fleet/actions",{method,body})).status,401);
   for(const role of ["worker","review"])assert.equal((await request("/api/fleet/actions",{method,body,headers:{"X-Board-Token":readFileSync(join(f.a.dir,role+"_token"),"utf8").trim()}})).status,403);
   assert.equal((await request("/api/fleet/actions",{method,body,headers:{...headers,Origin:"https://foreign.invalid"}})).status,403);
  }
  const r=await request("/api/fleet/actions",{method:"POST",headers,body:JSON.stringify(input)});assert.equal(r.status,202);assert.equal((await r.json()).action_id,input.action_id);
  for(let i=0;i<40&&!f.target.catalog("demo").incoming.length;i++)await sleep(100);
  assert.equal(f.target.catalog("demo").incoming.length,1);
  const repeated=await request("/api/fleet/actions",{method:"POST",headers,body:JSON.stringify({...input,action_id:randomUUID()})});assert.equal((await repeated.json()).action_id,input.action_id);assert.equal(rows(f.a.db),1);
  const list=await request("/api/fleet/actions?project=demo",{headers});assert.equal(list.status,200);assert.match(list.headers.get("cache-control"),/no-store/);assert.equal((await list.json()).actions[0].state,"acknowledged");
  assert.equal((await request("/api/fleet/actions?project=other",{headers})).status,403);
  const invalid=await request("/api/fleet/actions",{method:"POST",headers,body:'{"PRIVATE-PARSE-MARKER"'});assert.equal(invalid.status,400);assert.equal((await invalid.text()).includes("PRIVATE-PARSE-MARKER"),false);
  const html=await (await request("/")).text();assert.ok(html.includes('id="fleet-action-dialog"'));assert.ok(html.includes('id="fleet-actions"'));assert.ok(!html.includes(f.a.principal_file));
 }finally{if(proc.exitCode===null){const exited=new Promise(r=>proc.once("exit",r));proc.kill();await exited;}}
});
test("default board leaves action storage uninitialized and rejects operator writes",{timeout:40000},async()=>{
 const n=node(),configPath=join(n.dir,"board-config.json");writeFileSync(configPath,JSON.stringify({lines:[{id:"fixture",label:"fixture"}],roles:[],routes:["default"],repo:n.dir}));
 const probe=createNetServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 let output="";const proc=spawn(process.execPath,[fileURLToPath(new URL("../core/server.mjs",import.meta.url))],{cwd:n.dir,windowsHide:true,env:{...process.env,BOARD_HOST:"127.0.0.1",BOARD_PORT:String(port),BOARD_CONFIG:configPath,BOARD_DATA_DIR:n.dir,BOARD_DB:n.dbPath,BOARD_REPO:n.dir,BOARD_POOL_TEST_MODE:"1",BOARD_POOL_TEST_PROBE:"ok",BOARD_FLEET_ACTIONS_CONFIG:""},stdio:["ignore","pipe","pipe"]});
 proc.stdout.on("data",b=>output+=b);proc.stderr.on("data",b=>output+=b);
 const request=(path,options={})=>fetch("http://127.0.0.1:"+port+path,{...options,signal:AbortSignal.timeout(5000)});
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await request("/health")).ok){ready=true;break;}}catch{}if(proc.exitCode!==null)break;await sleep(100);}assert.ok(ready,output);
  const headers={"X-Board-Token":readFileSync(join(n.dir,"board_token"),"utf8").trim()};
  assert.equal((await (await request("/api/fleet/actions",{headers})).json()).enabled,false);
  assert.equal((await request("/api/fleet/actions",{method:"POST",headers,body:"{}"})).status,409);
  assert.equal(n.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='fleet_operator_actions'").get().n,0);
 }finally{if(proc.exitCode===null){const exited=new Promise(r=>proc.once("exit",r));proc.kill();await exited;}}
});

function grant(a,b,scopes=["peer:handshake","delegation:offer","delegation:status","delegation:binding","delegation:control","delegation:result"]){
 const file=join(TMP,"peer-"+serial+++".json");issueCredential(b.db,{peerNodeId:a.identity.node_id,peerEpoch:a.identity.sync_epoch,scopes,projects:["demo"],credentialFile:file,expectedVersion:b.db.prepare("SELECT credential_version FROM federation_peers WHERE peer_node_id=?").get(a.identity.node_id)?.credential_version});
 return {file,peer:authenticate(b.db,"Bearer "+JSON.parse(readFileSync(file,"utf8")).token)};
}
async function bound(){
 const a=node(),b=node(),r=node();for(const n of [a,b,r]){migrateBindings(n.db);migrateResults(n.db);migrateRelations(n.db);}
 const source=card(a),ab=grant(a,b),ba=grant(b,a),ar=grant(a,r,["peer:handshake","relations:read","relations:approve","relations:publish"]),br=grant(b,r,["peer:handshake","relations:read","relations:approve","relations:publish"]);
 const out=createIntent(a.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:b.identity.node_id,targetEpoch:b.identity.sync_epoch});receiveOffer(b.db,ab.peer,out.offer);
 const accepted=decideIncoming(b.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"fixture"});recordReceipt(a.db,out.delegation_id,accepted);
 const target=store.get(b.db,b.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id);
 const g=createRelationGraph(r.db,{projectId:"demo",members:[a,b].map(n=>({node_id:n.identity.node_id,node_epoch:n.identity.sync_epoch}))});
 for(const[n,credential]of [[a,ar],[b,br]]){
  bindTopology(n.db,{projectId:"demo",graphId:g.graph_id,graphEpoch:g.graph_epoch,registrarNodeId:r.identity.node_id,registrarEpoch:r.identity.sync_epoch});
  const op=prepareTopology(n.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:0}),args=startTopologyAttempt(n.db,{operationId:op.operation_id,expectedVersion:r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(r.db,credential.peer,args);acceptTopologyReceipt(n.db,{operationId:op.operation_id,requestId:args.request_id,receipt});
 }
 const d={schema_version:1,type:"delegation",relation_id:randomUUID(),delegation_id:out.delegation_id,project_id:"demo",graph_id:g.graph_id,graph_epoch:g.graph_epoch,source_node_id:a.identity.node_id,source_epoch:a.identity.sync_epoch,source_task_uid:source.task_uid,target_node_id:b.identity.node_id,target_epoch:b.identity.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest,source_topology_revision:1,target_topology_revision:1};
 const approve=(n,c)=>{const args=startBindingAttempt(n.db,{relationId:d.relation_id,expectedVersion:r.db.prepare("SELECT version FROM relation_graphs").get().version});return acceptBindingReceipt(n.db,{relationId:d.relation_id,requestId:args.request_id,receipt:approveRelation(r.db,c.peer,args)});};
 const send=kind=>{const body=bindingMessage(a.db,{relationId:d.relation_id,kind});recordBindingMessage(a.db,{requestId:body.request_id,receipt:receiveBindingMessage(b.db,ab.peer,body)});};
 prepareBinding(a.db,{relation:d,expectedTaskVersion:store.get(a.db,source.id).aggregate_version});approve(a,ar);send("proposal");
 prepareBinding(b.db,{relation:d,expectedTaskVersion:store.get(b.db,target.id).aggregate_version});approve(b,br);
 acceptBindingReceipt(a.db,{relationId:d.relation_id,receipt:relationStatus(r.db,ar.peer,{project_id:"demo",graph_id:g.graph_id,graph_epoch:g.graph_epoch,relation_id:d.relation_id})});send("source_ready");
 const open=async(n,other,c)=>{
  const server=await listenPeerServer(other.db,{port:0});servers.push(server);n.config.peers=[{node_id:other.identity.node_id,node_epoch:other.identity.sync_epoch,projects:["demo"],url:"http://127.0.0.1:"+server.address().port,credential_file:c.file}];
  const action=openFleetActions(n.db,{config:n.config});controllers.push(action);return action;
 };
 return {a,b,r,d,source,target,left:await open(a,b,ab),right:await open(b,a,ba)};
}
const action=(controller,command,args)=>controller.enqueue({action_id:randomUUID(),project_id:"demo",command,arguments:args});
test("bound cancellation shows received until local quiescence and explicit source polling",async()=>{
 const f=await bound(),rid=f.d.relation_id;
 const sent=action(f.left,"request_cancellation",{relation_id:rid,expected_version:store.get(f.a.db,f.source.id).aggregate_version,reason_code:"operator_cancelled"});
 assert.equal(sent.result.stopped,false);await f.left.tick();assert.equal(f.left.catalog("demo").cancellations[0].state,"received");assert.equal(f.right.catalog("demo").cancellations[0].state,"received");
 const progressed=action(f.right,"progress_cancellation",{relation_id:rid});assert.equal(progressed.result.stopped,true);assert.equal(f.left.catalog("demo").cancellations[0].state,"received");
 action(f.left,"poll_cancellation",{id:rid});await f.left.tick();assert.equal(f.left.catalog("demo").cancellations[0].state,"stopped");
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);assert.equal(f.b.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);
});
test("release and fixture candidate transfer preserve pending review; owner rejection returns without relaunch",async()=>{
 const f=await bound(),rid=f.d.relation_id,n=f.b;
 const released=action(f.right,"release_delegation",{relation_id:rid,expected_version:store.get(n.db,f.target.id).aggregate_version});assert.equal(released.result.state,"released");assert.equal(released.result.dispatch_started,false);assert.equal(n.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);
 migrateDispatch(n.db);putRole(n.db,{...n.policy,role_id:"engine",kind:"implement",capabilities:["board-tools"],runtime:"claude",model:"fixture-model",effort:"low"});
 const auth="Bearer "+JSON.parse(readFileSync(n.principal_file,"utf8")).token,current=store.get(n.db,f.target.id);
 const assigned=callTool(n.db,auth,"request_assignment",{request_id:randomUUID(),task_uid:current.task_uid,expected_version:current.aggregate_version});
 const quota=putQuota(n.db,{quota_id:randomUUID(),runtime:"claude",execution_mode:"fixture",projects:["demo"],limit_total:1,enabled:true});
 const codeRoot=join(TMP,"governance-"+serial++);mkdirSync(codeRoot);const sourceGate={check:()=>({code_root:codeRoot,tree:"a".repeat(40),commit:"b".repeat(40)})};
 const dispatch=prepareDispatch(n.db,{assignmentId:assigned.assignment_id,quotaId:quota.quota_id,executionMode:"fixture",credentialFile:join(n.dir,"fixture-worker.json"),sourceGate});
 authorizeLaunch(n.db,{dispatchId:dispatch.dispatch_id,sourceGate});finishDispatch(n.db,{dispatchId:dispatch.dispatch_id,result:{status:"success",evidence:"synthetic fixture only; no real model",usage:null}});
 const candidate=action(f.right,"prepare_result",{relation_id:rid,expected_version:store.get(n.db,f.target.id).aggregate_version});assert.equal(candidate.state,"pending");
 await f.right.tick();assert.equal(f.right.catalog("demo").results[0].state,"delivered");const received=f.left.catalog("demo").results[0];assert.equal(received.state,"received");assert.equal(received.review_state,"pending_evidence");
 action(f.left,"reject_result",{result_id:candidate.action_id,expected_version:received.source_task_version,note:"Missing actual provider and artifact evidence"});
 action(f.right,"poll_result",{id:candidate.action_id});await f.right.tick();assert.equal(f.right.catalog("demo").results[0].state,"rejected");
 assert.equal(n.db.prepare("SELECT count(*) n FROM task_runs").get().n,1);assert.notEqual(store.get(f.a.db,f.source.id).status,"done");
});

test("outer transaction retains caller work but queue failure rolls back intent; uncommitted rows cannot send",async()=>{
 const f=await pair(),input=proposal(f);f.a.db.exec("BEGIN");
 try{
  const id=store.add(f.a.db,{subject:"caller work"});
  f.a.db.exec("CREATE TRIGGER fail_nested_action BEFORE INSERT ON fleet_operator_actions BEGIN SELECT RAISE(ABORT,'nested failure'); END");
  assert.throws(()=>f.source.enqueue(input),/nested failure/);assert.ok(store.get(f.a.db,id));assert.equal(f.a.db.isTransaction,true);
  assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_outgoing").get().n,0);assert.equal(rows(f.a.db),0);
  f.a.db.exec("DROP TRIGGER fail_nested_action");f.source.enqueue(input);await assert.rejects(f.source.tick(),{code:"TRANSACTION_ACTIVE"});assert.equal(f.target.catalog("demo").incoming.length,0);
 }finally{f.a.db.exec("ROLLBACK");}
 assert.equal(rows(f.a.db),0);
});
test("queue shutdown aborts network and reopening retries the same intent",async()=>{
 let started;const ready=new Promise(r=>started=r);
 const f=await pair({fetchImpl:(_url,options)=>new Promise((_resolve,reject)=>{started();options.signal.addEventListener("abort",()=>reject(Error("aborted")),{once:true});})});
 const input=proposal(f);f.source.enqueue(input);const running=f.source.tick();await ready;await f.source.close();await running;
 assert.equal(f.a.db.prepare("SELECT state FROM fleet_operator_actions").get().state,"retry_pending");f.advance(31000);const reopened=f.open(f.a);await reopened.tick();assert.equal(reopened.catalog("demo").actions[0].state,"acknowledged");assert.equal(f.target.catalog("demo").incoming.length,1);
});
test("configured identity replacement cannot take over the previous principal queue",async()=>{
 const f=await pair();f.source.enqueue(proposal(f));const changed=join(f.a.dir,"replacement.json");issuePrincipal(f.a.db,{roleId:"coord",projects:["demo"],credentialFile:changed});
 writeFileSync(f.a.principal_file,readFileSync(changed));await f.source.tick();assert.equal(f.target.catalog("demo").incoming.length,0);assert.equal(f.source.catalog("demo").actions.length,0);
 assert.throws(()=>f.a.db.prepare("UPDATE fleet_operator_actions SET project_id='changed'").run(),/immutable/);
});
test("catalog caps combined project records and keeps project-filtered contracts",async()=>{
 const a=node(["alpha","beta"]),b=node(["alpha","beta"]),credentialFile=join(a.dir,"two-projects.json");
 issueCredential(b.db,{peerNodeId:a.identity.node_id,peerEpoch:a.identity.sync_epoch,scopes:["peer:handshake","delegation:offer","delegation:status"],projects:["alpha","beta"],credentialFile});
 const credential=authenticate(b.db,"Bearer "+JSON.parse(readFileSync(credentialFile,"utf8")).token);
 const left=openFleetActions(a.db,{config:a.config}),right=openFleetActions(b.db,{config:b.config});controllers.push(left,right);
 for(let i=0;i<120;i++){const project=i<100?"alpha":"beta",t=card(a,project),out=createIntent(a.db,{delegationId:randomUUID(),taskUid:t.task_uid,expectedVersion:t.aggregate_version,targetNodeId:b.identity.node_id,targetEpoch:b.identity.sync_epoch});receiveOffer(b.db,credential,out.offer);}
 const all=right.catalog();assert.equal(all.incoming.length,100);assert.equal(all.truncated,true);const beta=right.catalog("beta");assert.equal(beta.incoming.length,20);assert.equal(right.catalog("alpha").incoming.length,100);assert.equal(right.catalog("alpha").truncated,false);assert.ok(beta.incoming.every(x=>x.project_id==="beta"));assert.equal(beta.truncated,false);
});

test("credential metadata must match the authenticated node, epoch and version",async()=>{
 const f=await pair(),original=JSON.parse(readFileSync(f.a.principal_file,"utf8"));
 for(const change of [x=>x.node_id=randomUUID(),x=>x.node_epoch=randomUUID(),x=>x.credential_version++]){
  const value=structuredClone(original);change(value);writeFileSync(f.a.principal_file,JSON.stringify(value));assert.throws(()=>f.source.enqueue(proposal(f)),{code:"AUTHORIZATION_CHANGED"});assert.equal(rows(f.a.db),0);
 }
 writeFileSync(f.a.principal_file,JSON.stringify(original));
});


// Administrative graph/credential setup is explicit; every subsequent workflow step uses the panel controller.
async function bindingWorkflow({localRegistrar=false,fetchImpl=fetch}={}){
 const a=node(),b=node(),r=localRegistrar?a:node();for(const n of new Set([a,b,r])){migrateBindings(n.db);migrateRelations(n.db);}
 const source=card(a);const ab=grant(a,b),ba=grant(b,a,["peer:handshake","delegation:offer","delegation:status","delegation:binding","relations:read","relations:approve","relations:publish"]);
 const ar=localRegistrar?null:grant(a,r,["peer:handshake","relations:read","relations:approve","relations:publish"]),br=localRegistrar?ba:grant(b,r,["peer:handshake","relations:read","relations:approve","relations:publish"]);
 const endpoints=new Map();for(const n of new Set([a,b,r])){const s=await listenPeerServer(n.db,{port:0});servers.push(s);endpoints.set(n,"http://127.0.0.1:"+s.address().port);}
 const connect=(n,other,c)=>n.config.peers.push({node_id:other.identity.node_id,node_epoch:other.identity.sync_epoch,projects:["demo"],url:endpoints.get(other),credential_file:c.file});
 connect(a,b,ab);connect(b,a,ba);if(!localRegistrar){connect(a,r,ar);connect(b,r,br);}
 let clock=Date.now();const open=(n,fetchImpl=fetch)=>{const a=openFleetActions(n.db,{config:n.config,fetchImpl,now:()=>clock});controllers.push(a);return a;};
 const left=open(a,fetchImpl),right=open(b);
 const offer=action(left,"create_delegation",{task_uid:source.task_uid,expected_version:source.aggregate_version,target_node_id:b.identity.node_id,target_epoch:b.identity.sync_epoch});await left.tick();
 action(right,"decide_delegation",{delegation_id:offer.action_id,expected_version:1,decision:"accept",note:"reviewed"});
 action(left,"poll_delegation",{id:offer.action_id});await left.tick();
 const target=store.list(b.db).tasks[0],g=createRelationGraph(r.db,{projectId:"demo",members:[a,b].map(n=>({node_id:n.identity.node_id,node_epoch:n.identity.sync_epoch}))});
 for(const n of [a,b])bindTopology(n.db,{projectId:"demo",graphId:g.graph_id,graphEpoch:g.graph_epoch,registrarNodeId:r.identity.node_id,registrarEpoch:r.identity.sync_epoch});
 return {a,b,r,left,right,source,target,offer,g,open,advance:ms=>clock+=ms};
}
async function registerBoth(f){
 for(const c of [f.left,f.right]){action(c,"publish_topology",{expected_revision:0});await c.tick();assert.equal(c.catalog("demo").topologies[0].phase,"ready");}
 action(f.left,"refresh_registration",{id:"demo"});await f.left.tick();
 return f.left.catalog("demo").outgoing[0].binding_draft;
}
async function proposeBinding(f){
 const draft=await registerBoth(f);assert.equal(draft.ready,true);
 const prepared=action(f.left,"propose_binding",{delegation_id:f.offer.action_id,review_digest:draft.review_digest});await f.left.tick();return prepared.action_id;
}
for(const localRegistrar of [false,true])test("panel workflow independently confirms both endpoints with "+(localRegistrar?"local":"remote")+" registrar",async()=>{
 const f=await bindingWorkflow({localRegistrar});const rid=await proposeBinding(f);
 assert.equal(f.left.catalog("demo").bindings[0].source_approved,true);
 action(f.left,"send_binding_proposal",{id:rid});await f.left.tick();
 const p=f.right.catalog("demo").proposals[0];assert.equal(p.relation_id,rid);assert.equal(p.description,"public work");assert.equal(p.acceptance,"explicit review");
 assert.throws(()=>action(f.right,"release_delegation",{relation_id:rid,expected_version:p.task_version}));
 action(f.right,"accept_binding_proposal",{relation_id:rid,descriptor_digest:p.descriptor_digest,expected_version:p.task_version});await f.right.tick();
 assert.equal(f.right.catalog("demo").bindings[0].state,"confirmed");assert.equal(f.right.catalog("demo").bindings[0].execution_authorized,false);
 action(f.left,"poll_binding",{id:rid});await f.left.tick();assert.equal(f.left.catalog("demo").bindings[0].state,"confirmed");
 action(f.left,"send_source_ready",{id:rid});await f.left.tick();const bound=f.right.catalog("demo").bindings[0];assert.equal(bound.execution_authorized,true);
 action(f.right,"release_delegation",{relation_id:rid,expected_version:bound.task_version});assert.equal(store.get(f.b.db,f.target.id).released,true);
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);assert.equal(f.b.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);
 assert.equal(f.left.catalog("demo").actions.every(a=>["applied","acknowledged"].includes(a.state)),true);
 assert.equal(f.right.catalog("demo").actions.every(a=>["applied","acknowledged"].includes(a.state)),true);
 // A terminal protocol state remains a successful receipt when the same operation is resumed.
 action(f.left,"poll_binding",{id:rid});await f.left.tick();assert.equal(f.left.catalog("demo").actions.find(a=>a.command==="poll_binding").state,"acknowledged");
});
test("binding review freezes registration and task version; changed previews never auto-advance",async()=>{
 const f=await bindingWorkflow(),draft=await registerBoth(f);
 store.update(f.a.db,{id:f.source.id,expectedVersion:store.get(f.a.db,f.source.id).aggregate_version,description:"changed contract",actor:"test"});
 assert.throws(()=>action(f.left,"propose_binding",{delegation_id:f.offer.action_id,review_digest:draft.review_digest}),{code:"REVIEW_CHANGED"});
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_bindings").get().n,0);
 const next=f.left.catalog("demo").outgoing[0].binding_draft;
 assert.throws(()=>action(f.left,"propose_binding",{delegation_id:f.offer.action_id,review_digest:next.review_digest}),{code:"CONTRACT_CHANGED"});
 assert.throws(()=>action(f.left,"refresh_registration",{id:"another"}),{code:"NOT_FOUND"});
 assert.throws(()=>action(f.left,"publish_topology",{expected_revision:1,edits:[]}),{code:"BAD_INPUT"});
});
test("lost structure receipt recovers original operation after reopening; no duplicate revision",async()=>{
 let lose=true;
 const f=await bindingWorkflow({fetchImpl:async(...args)=>{const response=await fetch(...args);if(lose&&String(args[0]).endsWith("/relations/publish")){lose=false;await response.arrayBuffer();throw Error("lost private response");}return response;}});
 const sent=action(f.left,"publish_topology",{expected_revision:0});await f.left.tick();
 assert.equal(f.left.catalog("demo").actions.find(a=>a.action_id===sent.action_id).state,"retry_pending");await f.left.close();f.advance(31000);f.left=f.open(f.a);await f.left.tick();
 assert.equal(f.left.catalog("demo").topologies[0].revision,1);assert.equal(f.left.catalog("demo").topologies[0].phase,"ready");
 assert.equal(f.r.db.prepare("SELECT revision FROM relation_topologies WHERE node_id=?").get(f.a.identity.node_id).revision,1);
 action(f.left,"resend_topology",{id:sent.action_id});await f.left.tick();assert.equal(f.left.catalog("demo").actions.find(a=>a.command==="resend_topology").state,"acknowledged");
});
test("target declines authenticated proposal and source withdraws without releasing tasks",async()=>{
 const f=await bindingWorkflow(),rid=await proposeBinding(f);action(f.left,"send_binding_proposal",{id:rid});await f.left.tick();
 const p=f.right.catalog("demo").proposals[0];
 action(f.right,"decline_binding_proposal",{relation_id:rid,expected_descriptor_digest:p.descriptor_digest,reason_code:"operator_declined"});
 assert.equal(f.right.catalog("demo").proposals.length,0);
 assert.throws(()=>action(f.right,"accept_binding_proposal",{relation_id:rid,descriptor_digest:p.descriptor_digest,expected_version:p.task_version}),{code:"PROPOSAL_DECLINED"});
 action(f.left,"cancel_binding",{id:rid});await f.left.tick();assert.equal(f.left.catalog("demo").bindings[0].state,"cancelled");
 assert.equal(store.get(f.b.db,f.target.id).released,false);
});
test("failed action insert rolls back prepared binding and broker receipt together",async()=>{
 const f=await bindingWorkflow(),draft=await registerBoth(f);
 f.a.db.exec("CREATE TRIGGER reject_binding_queue BEFORE INSERT ON fleet_operator_actions WHEN NEW.command='propose_binding' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END");
 const id=randomUUID(),input={action_id:id,project_id:"demo",command:"propose_binding",arguments:{delegation_id:f.offer.action_id,review_digest:draft.review_digest}};
 assert.throws(()=>f.left.enqueue(input),/queue unavailable/);assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_bindings").get().n,0);
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM broker_requests WHERE request_id=?").get(id).n,0);
 f.a.db.exec("DROP TRIGGER reject_binding_queue");f.left.enqueue(input);await f.left.tick();assert.equal(f.left.catalog("demo").bindings.length,1);
});
test("revocation during registrar handshake prevents status caching and approval",async()=>{
 let armed=false,f;
 f=await bindingWorkflow({fetchImpl:async(...args)=>{const response=await fetch(...args);if(armed&&String(args[0]).endsWith("/hello")){armed=false;revokePrincipal(f.a.db,{principalId:f.a.principal.principal_id,expectedVersion:1});}return response;}});
 await registerBoth(f);f.a.db.exec("DELETE FROM fleet_registrar_observations");
 const sent=action(f.left,"refresh_registration",{id:"demo"});armed=true;await f.left.tick();
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM fleet_registrar_observations").get().n,0);
 assert.equal(f.a.db.prepare("SELECT state FROM fleet_operator_actions WHERE action_id=?").get(sent.action_id).state,"blocked");
});

test("stale target revision is rejected by registrar and cannot authorize a target task",async()=>{
 const f=await bindingWorkflow(),draft=await registerBoth(f);
 action(f.right,"publish_topology",{expected_revision:1});await f.right.tick();assert.equal(f.right.catalog("demo").topologies[0].revision,2);
 const proposed=action(f.left,"propose_binding",{delegation_id:f.offer.action_id,review_digest:draft.review_digest});await f.left.tick();
 const receipt=f.left.catalog("demo").actions.find(a=>a.action_id===proposed.action_id);assert.equal(receipt.state,"blocked");assert.equal(receipt.last_error_code,"TOPOLOGY_VERSION_CONFLICT");
 assert.equal(f.left.catalog("demo").bindings[0].source_approved,false);assert.equal(f.right.catalog("demo").proposals.length,0);
 assert.equal(store.get(f.b.db,f.target.id).released,false);action(f.left,"cancel_binding",{id:proposed.action_id});await f.left.tick();assert.equal(f.left.catalog("demo").bindings[0].state,"cancelled");
});
test("registrar observation discards arbitrary response fields and rejects changed registrar identity",async()=>{
 let mode="extra";
 const f=await bindingWorkflow({fetchImpl:async(...args)=>{const response=await fetch(...args);if(String(args[0]).endsWith("/relations/status")&&response.ok){const value=await response.json();if(value.topologies){if(mode==="extra")value.private_raw="must never be persisted";else value.registrar_epoch=randomUUID();return new Response(JSON.stringify(value),{status:200,headers:{"Content-Type":"application/json"}});}return new Response(JSON.stringify(value),{status:200});}return response;}});
 await registerBoth(f);const before=f.a.db.prepare("SELECT * FROM fleet_registrar_observations").get();assert.equal(before.status_json.includes("must never"),false);
 mode="identity";const sent=action(f.left,"refresh_registration",{id:"demo"});await f.left.tick();assert.deepEqual(f.a.db.prepare("SELECT * FROM fleet_registrar_observations").get(),before);
 assert.equal(f.a.db.prepare("SELECT last_error_code FROM fleet_operator_actions WHERE action_id=?").get(sent.action_id).last_error_code,"GRAPH_MISMATCH");
});
