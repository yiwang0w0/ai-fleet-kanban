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
import {migratePeers,issueCredential,authenticate,localIdentity,revokePeer} from "../core/federation/peers.mjs";
import {migrateSync,digest} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,issuePrincipal} from "../core/mcp/policy.mjs";
import {enrollTask,callTool} from "../core/mcp/tools.mjs";
import {migrateRelations,createRelationGraph,publishTopology,approveRelation,relationStatus,localRegistrarPeer,previewTopology,validateCombinedGraph} from "../core/federation/relations.mjs";
import {migrateTopology,bindTopology,topologyState,topologyOperation,prepareTopology,startTopologyAttempt,rejectTopologyAttempt,acceptTopologyReceipt,cancelPreparedTopology} from "../core/federation/topology.mjs";
import {sendTopology} from "../core/federation/topology-client.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-topology-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function fixture(){const dir=join(TMP,"node-"+serial++);mkdirSync(dir);const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);migrateRelations(db);migrateTopology(db);return {dir,dbPath,db,node:localIdentity(db)};}
function card(f,extra={},projectId="demo"){const id=store.add(f.db,{subject:"task "+serial++,treeMode:"hierarchical",released:1,...extra}),t=store.get(f.db,id);if(projectId)enrollTask(f.db,{id,projectId,workKind:"implement",capabilities:["board-tools"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
function grant(a,r){const file=join(TMP,"peer-"+serial+++".json");issueCredential(r.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes:["peer:handshake","relations:read","relations:publish","relations:approve"],projects:["demo"],credentialFile:file});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(r.db,"Bearer "+c.token)};}
function setup(){const a=fixture(),r=fixture(),g=createRelationGraph(r.db,{projectId:"demo",members:[{node_id:a.node.node_id,node_epoch:a.node.sync_epoch}]}),credential=grant(a,r);return {a,r,g,credential};}
function bind(f){return bindTopology(f.a.db,{projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,registrarNodeId:f.r.node.node_id,registrarEpoch:f.r.node.sync_epoch});}
function stage(f,edits=[]){return prepareTopology(f.a.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:topologyState(f.a.db,"demo").revision,edits});}
function edit(f,t,parent=null,deps=[]){const current=store.get(f.a.db,t.id);return {task_uid:current.task_uid,expected_version:current.aggregate_version,parent_uid:parent?.task_uid??null,blocked_by:deps.map(t=>t.task_uid)};}
function commit(f,op){const v=f.r.db.prepare("SELECT version FROM relation_graphs").get().version,args=startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:v}),receipt=publishTopology(f.r.db,f.credential.peer,args);return acceptTopologyReceipt(f.a.db,{operationId:op.operation_id,requestId:args.request_id,receipt});}
function init(f){bind(f);return commit(f,stage(f));}
function graphStatus(f){return relationStatus(f.r.db,f.credential.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:null});}
function state(db){const names=["tasks","task_events","topology_bindings","topology_operations","topology_attempts","topology_vertices","topology_holds","topology_events","topology_write_permits"];return JSON.stringify(Object.fromEntries(names.map(n=>[n,db.prepare("SELECT * FROM "+n+" ORDER BY rowid").all()])));}
async function network(f){const s=await listenPeerServer(f.r.db,{port:0});servers.push(s);return {url:"http://127.0.0.1:"+s.address().port,credentialFile:f.credential.file};}
const count=(db,table)=>db.prepare("SELECT count(*) n FROM "+table).get().n;
test("explicit binding and first registration hold new claims until a matching registrar receipt commits",()=>{
 const f=setup(),t=card(f.a);assert.equal(bind(f).phase,"unregistered");assert.equal(store.claimById(f.a.db,{id:t.id,worker:"fixture"}).ok,false);
 const op=stage(f);assert.equal(op.state,"prepared");assert.equal(topologyState(f.a.db,"demo").phase,"pending");const result=commit(f,op);assert.equal(result.state,"applied");
 assert.equal(topologyState(f.a.db,"demo").revision,1);assert.equal(topologyState(f.a.db,"demo").phase,"ready");assert.equal(store.claimById(f.a.db,{id:t.id,worker:"fixture"}).ok,true);
 assert.throws(()=>bind(f),{code:"CONFLICT"});assert.equal(count(f.a.db,"topology_write_permits"),0);
});
test("binding refuses outgoing and incoming connections to unadmitted or different-project tasks",()=>{
 for(const type of ["child","dependency","parent","prerequisite"]){
  const f=setup(),inside=card(f.a);let outside;
  if(type==="child")outside=card(f.a,{parentId:inside.id},null);
  else if(type==="dependency")outside=card(f.a,{blockedBy:[inside.id]},null);
  else{outside=card(f.a,{},"other");store.update(f.a.db,{id:inside.id,...(type==="parent"?{parentId:outside.id}:{blockedBy:[outside.id]})});}
  assert.throws(()=>bind(f),{code:["child","dependency"].includes(type)?"PROJECT_BOUNDARY":"MISSING_LOCAL_REFERENCE"});assert.equal(count(f.a.db,"topology_bindings"),0);
 }
});
test("registered structure cannot be changed through native edits, creation, raw SQL or unenrollment",()=>{
 const f=setup(),a=card(f.a),b=card(f.a);init(f);
 assert.throws(()=>store.update(f.a.db,{id:a.id,parentId:b.id}),/TOPOLOGY_MANAGED/);
 assert.throws(()=>store.update(f.a.db,{id:a.id,blockedBy:[b.id]}),/TOPOLOGY_MANAGED/);
 assert.throws(()=>store.add(f.a.db,{subject:"unshared child",parentId:a.id}),/TOPOLOGY_MANAGED/);
 assert.throws(()=>store.add(f.a.db,{subject:"unshared dependency",blockedBy:[a.id]}),/TOPOLOGY_MANAGED/);
 const outside=card(f.a,{},null);assert.throws(()=>store.update(f.a.db,{id:outside.id,blockedBy:[a.id]}),/TOPOLOGY_MANAGED/);
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET id=id+1000 WHERE id=?").run(a.id),/immutable/);
 assert.throws(()=>f.a.db.prepare("DELETE FROM tasks WHERE id=?").run(a.id),/retained/);
 assert.throws(()=>f.a.db.prepare("DELETE FROM broker_task_projects WHERE task_id=?").run(a.id),/retained/);
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET kind='goal' WHERE id=?").run(a.id),/TOPOLOGY_MANAGED/);
 store.update(f.a.db,{id:a.id,description:"allowed text edit"});assert.equal(store.get(f.a.db,a.id).description,"allowed text edit");
});
test("an isolated admitted task waits for the next registered snapshot before it can be claimed",()=>{
 const f=setup();card(f.a);init(f);const added=card(f.a);
 assert.equal(store.claimById(f.a.db,{id:added.id,worker:"fixture"}).ok,false);
 const op=stage(f);assert.throws(()=>card(f.a),/TOPOLOGY_MANAGED/);commit(f,op);
 assert.equal(store.claimById(f.a.db,{id:added.id,worker:"fixture"}).ok,true);
});
test("dependency reversal removes the old edge before publishing and only adds the new edge after acknowledgement",()=>{
 const f=setup(),b=card(f.a),a=card(f.a,{blockedBy:[b.id]});init(f);
 const op=stage(f,[edit(f,a),edit(f,b,null,[a])]);
 assert.deepEqual(store.get(f.a.db,a.id).blocked_by,[]);assert.deepEqual(store.get(f.a.db,b.id).blocked_by,[]);
 assert.equal(graphStatus(f).edges,1);assert.equal(topologyState(f.a.db,"demo").revision,1);
 commit(f,op);assert.deepEqual(store.get(f.a.db,b.id).blocked_by,[a.id]);assert.deepEqual(store.get(f.a.db,a.id).blocked_by,[]);
 assert.equal(topologyState(f.a.db,"demo").revision,2);assert.equal(count(f.a.db,"topology_write_permits"),0);
});
test("parent reversal changes the tree through an edge-free intermediate graph and native audited updates",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);
 const op=stage(f,[edit(f,a,b),edit(f,b)]);
 assert.equal(store.get(f.a.db,a.id).parent_id,null);assert.equal(store.get(f.a.db,b.id).parent_id,null);
 commit(f,op);assert.equal(store.get(f.a.db,a.id).parent_id,b.id);assert.equal(store.get(f.a.db,b.id).parent_id,null);
 assert.ok(store.events(f.a.db,{taskId:a.id}).some(e=>e.kind==="set_parent"&&e.actor==="topology:"+op.operation_id));
});
test("stale task versions, invalid trees and mixed cycles fail before any intermediate mutation",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);const before=state(f.a.db);
 assert.throws(()=>stage(f,[{...edit(f,b),expected_version:999}]),{code:"CONFLICT"});assert.equal(state(f.a.db),before);
 assert.throws(()=>stage(f,[edit(f,b,a,[a])]),{code:"RELATION_CYCLE"});assert.equal(state(f.a.db),before);
});
test("prepared operation IDs are immutable and replay after commit without duplicating history",()=>{
 const f=setup();card(f.a);bind(f);const args={projectId:"demo",operationId:randomUUID(),expectedRevision:0,edits:[]};
 const op=prepareTopology(f.a.db,args);assert.deepEqual(prepareTopology(f.a.db,args),op);assert.throws(()=>prepareTopology(f.a.db,{...args,expectedRevision:1}),{code:"REQUEST_CONFLICT"});
 commit(f,op);assert.equal(prepareTopology(f.a.db,args).state,"applied");assert.equal(count(f.a.db,"topology_operations"),1);
});
test("prepare and commit are atomic with native task events and request receipts",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);let before=state(f.a.db);
 f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON topology_events WHEN NEW.kind='prepared' BEGIN SELECT RAISE(ABORT,'injected stage'); END; BEGIN IMMEDIATE");
 assert.throws(()=>stage(f,[edit(f,b)]),/injected stage/);f.a.db.exec("COMMIT");assert.equal(state(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");
 const op=stage(f,[edit(f,b),edit(f,a,b)]),args=startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:graphStatus(f).version}),receipt=publishTopology(f.r.db,f.credential.peer,args);before=state(f.a.db);
 f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON topology_events WHEN NEW.kind='applied' BEGIN SELECT RAISE(ABORT,'injected commit'); END");
 assert.throws(()=>acceptTopologyReceipt(f.a.db,{operationId:op.operation_id,requestId:args.request_id,receipt}),/injected commit/);assert.equal(state(f.a.db),before);assert.equal(count(f.a.db,"topology_write_permits"),0);
 f.a.db.exec("DROP TRIGGER injected");assert.equal(acceptTopologyReceipt(f.a.db,{operationId:op.operation_id,requestId:args.request_id,receipt}).state,"applied");
});
test("offline pending structural changes do not stop unrelated already-claimed work from heartbeat and reporting",async()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id}),running=card(f.a);init(f);
 const claim=store.claimById(f.a.db,{id:running.id,worker:"worker"});assert.equal(claim.ok,true);
 const op=stage(f,[edit(f,b)]),out=await sendTopology(f.a.db,{operationId:op.operation_id,url:"http://127.0.0.1:1",credentialFile:f.credential.file,fetchImpl:async()=>{throw Error("fixture offline");}});
 assert.equal(out.delivery_state,"retry_pending");assert.equal(topologyState(f.a.db,"demo").phase,"pending");
 assert.equal(store.heartbeat(f.a.db,{id:running.id,worker:"worker",runId:claim.task.run_id}).task.status,"in_progress");
 store.report(f.a.db,{id:running.id,worker:"worker",runId:claim.task.run_id,outcome:"done",evidence:"persisted while graph registrar offline"});
 assert.equal(store.get(f.a.db,running.id).status,"waiting");assert.equal(store.claimById(f.a.db,{id:b.id,worker:"another"}).ok,false);
});
test("affected live subtrees refuse a structural move without changing the running task or graph",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id}),c=card(f.a);init(f);assert.equal(store.claimById(f.a.db,{id:b.id,worker:"worker"}).ok,true);
 const before=state(f.a.db);assert.throws(()=>stage(f,[edit(f,a,c)]),{code:"ACTIVE_STRUCTURE"});assert.equal(state(f.a.db),before);
});
test("a transition holds affected goal completion and archiving while allowing unrelated automatic completion",()=>{
 const f=setup(),g=card(f.a,{kind:"goal"}),a=card(f.a,{parentId:g.id}),b=card(f.a,{parentId:g.id}),other=card(f.a,{kind:"goal"}),done=card(f.a,{parentId:other.id});init(f);
 f.a.db.prepare("UPDATE tasks SET status='done' WHERE id IN(?,?)").run(a.id,done.id);
 const op=stage(f,[edit(f,b)]);
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(g.id),/TOPOLOGY_PENDING/);
 assert.throws(()=>store.archive(f.a.db,{id:g.id}),/TOPOLOGY_PENDING/);
 const completed=store.completeGoals(f.a.db);assert.ok(completed.includes(other.id));assert.ok(!completed.includes(g.id));assert.equal(store.get(f.a.db,g.id).status,"not_started");
 cancelPreparedTopology(f.a.db,{operationId:op.operation_id});assert.equal(store.get(f.a.db,b.id).parent_id,g.id);
});
test("untransmitted changes cancel locally, but unknown remote outcomes cannot restore old edges",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);let op=stage(f,[edit(f,b)]);
 assert.equal(cancelPreparedTopology(f.a.db,{operationId:op.operation_id}).state,"cancelled");assert.equal(store.get(f.a.db,b.id).parent_id,a.id);assert.equal(topologyState(f.a.db,"demo").phase,"ready");
 op=stage(f,[edit(f,b)]);startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:graphStatus(f).version});
 assert.throws(()=>cancelPreparedTopology(f.a.db,{operationId:op.operation_id,observedGraph:graphStatus(f)}),{code:"UNKNOWN_REMOTE_OUTCOME"});assert.equal(store.get(f.a.db,b.id).parent_id,null);
});
test("lost HTTP response replays one immutable request after database restart and commits exactly once",async()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);const op=stage(f,[edit(f,b)]),net=await network(f);let lost=false;
 const first=await sendTopology(f.a.db,{operationId:op.operation_id,...net,fetchImpl:async(u,o)=>{const response=await fetch(u,o);if(u.endsWith("/publish")&&!lost){lost=true;await response.arrayBuffer();throw Error("lost receipt");}return response;}});
 assert.equal(first.delivery_state,"retry_pending");assert.equal(graphStatus(f).topologies[0].revision,2);assert.equal(topologyState(f.a.db,"demo").revision,1);
 const requestId=first.attempts.find(a=>a.state==="pending").request_id,db=new DatabaseSync(f.a.dbPath);dbs.push(db);migrateTopology(db);
 const resumed=await sendTopology(db,{operationId:op.operation_id,...net});assert.equal(resumed.state,"applied");assert.equal(resumed.attempts.length,1);assert.equal(resumed.attempts[0].request_id,requestId);
 const version=graphStatus(f).version;assert.equal((await sendTopology(db,{operationId:op.operation_id})).state,"applied");assert.equal(graphStatus(f).version,version);
});
test("receipt identity and digest mismatches preserve the intermediate graph and pending request",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);const op=stage(f,[edit(f,b)]),args=startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:graphStatus(f).version}),r=publishTopology(f.r.db,f.credential.peer,args),before=state(f.a.db);
 for(const bad of [{...r,graph_epoch:randomUUID()},{...r,owner_epoch:randomUUID()},{...r,snapshot_digest:"0".repeat(64)},{...r,revision:99}])assert.throws(()=>acceptTopologyReceipt(f.a.db,{operationId:op.operation_id,requestId:args.request_id,receipt:bad}),{code:"RECEIPT_MISMATCH"});
 assert.equal(state(f.a.db),before);assert.equal(acceptTopologyReceipt(f.a.db,{operationId:op.operation_id,requestId:args.request_id,receipt:r}).state,"applied");
});

test("local subset remains acyclic when new cross-node edges arrive between publication and local commit",async()=>{
 const a=fixture(),b=fixture(),r=fixture(),g=createRelationGraph(r.db,{projectId:"demo",members:[{node_id:a.node.node_id,node_epoch:a.node.sync_epoch},{node_id:b.node.node_id,node_epoch:b.node.sync_epoch}]}),f={a,r,g,credential:grant(a,r)},other={a:b,r,g,credential:grant(b,r)};
 const a2=card(a),a1=card(a,{blockedBy:[a2.id]}),b1=card(b);init(f);init(other);
 const op=stage(f,[edit(f,a1),edit(f,a2,null,[a1])]),args=startTopologyAttempt(a.db,{operationId:op.operation_id,expectedVersion:graphStatus(f).version}),receipt=publishTopology(r.db,f.credential.peer,args);
 const relation=(source,target,sourceTask,targetTask,sv,tv)=>({schema_version:1,type:"delegation",relation_id:randomUUID(),delegation_id:randomUUID(),project_id:"demo",graph_id:g.graph_id,graph_epoch:g.graph_epoch,source_node_id:source.node.node_id,source_epoch:source.node.sync_epoch,source_task_uid:sourceTask.task_uid,target_node_id:target.node.node_id,target_epoch:target.node.sync_epoch,target_task_uid:targetTask.task_uid,offer_digest:digest("fixture"),source_topology_revision:sv,target_topology_revision:tv});
 for(const d of [relation(a,b,a2,b1,2,1),relation(b,a,b1,a1,1,2)]){
  for(const peer of [f.credential.peer,other.credential.peer])approveRelation(r.db,peer,{request_id:randomUUID(),expected_version:graphStatus(f).version,relation:d});
 }
 const actual=owner=>previewTopology(owner.db,{projectId:"demo",graphId:g.graph_id,graphEpoch:g.graph_epoch,revision:2}).snapshot;
 const edges=r.db.prepare("SELECT from_uid,to_uid FROM relation_edges").all();assert.equal(validateCombinedGraph([actual(a),actual(b)],edges).edges,2);
 acceptTopologyReceipt(a.db,{operationId:op.operation_id,requestId:args.request_id,receipt});assert.equal(validateCombinedGraph([actual(a),actual(b)],edges).edges,3);
 const reverse=stage(f,[edit(f,a1,null,[a2]),edit(f,a2)]),net=await network(f);
 const refused=await sendTopology(a.db,{operationId:reverse.operation_id,...net});assert.equal(refused.delivery_state,"rejected");assert.equal(refused.error_code,"RELATION_CYCLE");
 assert.equal((await sendTopology(a.db,{operationId:reverse.operation_id,...net,mode:"cancel"})).state,"cancelled");
 assert.deepEqual(store.get(a.db,a2.id).blocked_by,[a1.id]);assert.deepEqual(store.get(a.db,a1.id).blocked_by,[]);
 assert.equal(validateCombinedGraph([actual(a),actual(b)],edges).edges,3);
});
test("CAS rejection preserves a safe prepared operation and retry uses a fresh request only after definitive refusal",async()=>{
 const f=setup();card(f.a);init(f);const op=stage(f),old=startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:1}),net=await network(f);
 const rejected=await sendTopology(f.a.db,{operationId:op.operation_id,...net});assert.equal(rejected.error_code,"GRAPH_VERSION_CONFLICT");assert.equal(rejected.attempts[0].state,"rejected");
 const result=await sendTopology(f.a.db,{operationId:op.operation_id,...net});assert.equal(result.state,"applied");assert.equal(result.attempts.length,2);assert.notEqual(result.attempts[1].request_id,old.request_id);
});
test("a local receipt persistence failure retries the already committed remote request without another graph change",async()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);const op=stage(f,[edit(f,b)]),net=await network(f);
 f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON topology_events WHEN NEW.kind='applied' BEGIN SELECT RAISE(ABORT,'injected receipt'); END");
 const failed=await sendTopology(f.a.db,{operationId:op.operation_id,...net});assert.equal(failed.delivery_state,"retry_pending");assert.equal(failed.error_code,"STORAGE_ERROR");
 const version=graphStatus(f).version;assert.equal(failed.attempts[0].state,"pending");f.a.db.exec("DROP TRIGGER injected");
 const result=await sendTopology(f.a.db,{operationId:op.operation_id,...net});assert.equal(result.state,"applied");assert.equal(result.attempts.length,1);assert.equal(graphStatus(f).version,version);
});
test("authentication revoked after a lost response does not turn an unknown success into a cancellable failure",async()=>{
 const f=setup();card(f.a);init(f);const op=stage(f),net=await network(f);
 await sendTopology(f.a.db,{operationId:op.operation_id,...net,fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/publish")){await r.arrayBuffer();throw Error("lost");}return r;}});
 revokePeer(f.r.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
 const blocked=await sendTopology(f.a.db,{operationId:op.operation_id,...net});assert.equal(blocked.delivery_state,"blocked");assert.equal(blocked.attempts[0].state,"pending");
 assert.throws(()=>rejectTopologyAttempt(f.a.db,{operationId:op.operation_id,requestId:blocked.attempts[0].request_id,code:"REMOTE_401"}),{code:"UNKNOWN_REMOTE_OUTCOME"});
 await assert.rejects(sendTopology(f.a.db,{operationId:op.operation_id,...net,mode:"cancel"}),{code:"UNKNOWN_REMOTE_OUTCOME"});
 assert.equal(topologyState(f.a.db,"demo").phase,"pending");
});
test("a registrar participating as the owner commits through the same durable protocol without a self credential",async()=>{
 const a=fixture(),t=card(a),g=createRelationGraph(a.db,{projectId:"demo",members:[{node_id:a.node.node_id,node_epoch:a.node.sync_epoch}]}),f={a,r:a,g};
 bind(f);const op=stage(f),result=await sendTopology(a.db,{operationId:op.operation_id});assert.equal(result.state,"applied");assert.equal(store.claimById(a.db,{id:t.id,worker:"fixture"}).ok,true);
});
test("metadata edits during a pending submission survive registration and archived dependency targets remain held",()=>{
 const f=setup(),a=card(f.a),b=card(f.a);init(f);const op=stage(f,[edit(f,b,null,[a])]);
 store.update(f.a.db,{id:b.id,description:"new user detail"});assert.throws(()=>store.archive(f.a.db,{id:a.id}),/TOPOLOGY_PENDING/);
 f.a.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(a.id);commit(f,op);assert.equal(store.get(f.a.db,b.id).description,"new user detail");assert.deepEqual(store.get(f.a.db,b.id).blocked_by,[a.id]);
});
test("converging dependency paths are counted once by native validation during committed graph application",()=>{
 const f=setup(),nodes=[];for(let i=0;i<10;i++)nodes.push(card(f.a,{blockedBy:nodes.map(t=>t.id)}));const t=card(f.a);init(f);
 const op=stage(f,[edit(f,t,null,[nodes.at(-1)])]);assert.equal(commit(f,op).state,"applied");assert.deepEqual(store.get(f.a.db,t.id).blocked_by,[nodes.at(-1).id]);
});
test("equivalent dependency JSON formatting does not edit an already-running task during initial registration",()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{blockedBy:[a.id]});f.a.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(a.id);
 const run=store.claimById(f.a.db,{id:b.id,worker:"fixture"});assert.equal(run.ok,true);f.a.db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run("[ "+a.id+" ]",b.id);
 assert.equal(init(f).state,"applied");assert.equal(store.get(f.a.db,b.id).run_id,run.task.run_id);
});
function principal(f,kind="coordinate",projects=["demo"]){
 const id="role-"+serial++,file=join(TMP,"mcp-"+serial+++".json"),execution=kind==="implement";
 const role=putRole(f.db,{role_id:id,kind,projects,capabilities:execution?["board-tools"]:[],runtime:execution?"claude":null,model:execution?"fixture-model":null,effort:execution?"fixture-effort":null,tools:kind==="observe"?"read-only":"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300}});
 if(execution)return {role,file};
 issuePrincipal(f.db,{roleId:id,projects,credentialFile:file});return {role,file,auth:"Bearer "+JSON.parse(readFileSync(file,"utf8")).token};
}
const splitArgs=t=>({request_id:randomUUID(),project_id:"demo",parent_uid:t.task_uid,expected_version:t.aggregate_version,subject:"MCP child "+serial++,description:"",acceptance:"",work_kind:"implement",required_capabilities:["board-tools"]});
test("MCP split in a managed tree creates one held child and attaches it only after registration",()=>{
 const f=setup(),root=card(f.a),coord=principal(f.a);init(f);
 const args=splitArgs(store.get(f.a.db,root.id)),out=callTool(f.a.db,coord.auth,"split_task",args);
 assert.equal(out.task.parent_uid,null);assert.equal(out.placement_pending.target_parent_uid,root.task_uid);assert.equal(out.task.topology.phase,"pending");
 assert.deepEqual(callTool(f.a.db,coord.auth,"split_task",args),out);assert.equal(count(f.a.db,"tasks"),2);
 assert.equal(callTool(f.a.db,coord.auth,"get_sync_status",{}).topologies[0].operation_id,args.request_id);
 commit(f,topologyOperation(f.a.db,args.request_id));const task=callTool(f.a.db,coord.auth,"get_task",{task_uid:out.task.task_uid}).task;
 assert.equal(task.parent_uid,root.task_uid);assert.equal(task.topology.phase,"ready");assert.equal(task.released,false);
});
test("an authenticated running agent can propose a child while its parent continues to report locally",()=>{
 const f=setup(),root=card(f.a),engine=principal(f.a,"implement");init(f);
 const claim=store.claimById(f.a.db,{id:root.id,worker:"engine",runtime:"claude",agentInstanceId:randomUUID(),runContext:{role_id:engine.role.role_id,broker_role_version:engine.role.version,broker_role_digest:engine.role.policy_digest}});assert.equal(claim.ok,true);
 issuePrincipal(f.a.db,{roleId:engine.role.role_id,projects:["demo"],runId:claim.task.run_id,credentialFile:engine.file});const auth="Bearer "+JSON.parse(readFileSync(engine.file,"utf8")).token;
 const args=splitArgs(store.get(f.a.db,root.id)),out=callTool(f.a.db,auth,"split_task",args);assert.equal(out.task.parent_uid,null);
 store.report(f.a.db,{id:root.id,worker:"engine",runId:claim.task.run_id,outcome:"done",evidence:"candidate parent work"});
 assert.equal(store.get(f.a.db,root.id).status,"waiting");assert.ok(!store.pendingReview(f.a.db).some(t=>t.id===root.id));
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(root.id),/TOPOLOGY_PENDING/);
 commit(f,topologyOperation(f.a.db,args.request_id));assert.equal(store.get(f.a.db,out.task.id).parent_id,root.id);
});
test("MCP structural preparation is coordinator-only, project-scoped and rolls back with its response",()=>{
 const f=setup(),a=card(f.a),b=card(f.a),foreign=card(f.a,{},"secret"),coord=principal(f.a),observe=principal(f.a,"observe");init(f);
 const args={request_id:randomUUID(),project_id:"demo",expected_revision:1,edits:[edit(f,b,a)]};
 assert.throws(()=>callTool(f.a.db,observe.auth,"prepare_topology",args),{code:"FORBIDDEN"});
 assert.throws(()=>callTool(f.a.db,coord.auth,"prepare_topology",{...args,edits:[edit(f,b,foreign)]}),{code:"NOT_FOUND"});
 assert.equal(callTool(f.a.db,coord.auth,"get_sync_status",{}).topologies.length,1);
 f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests WHEN NEW.tool_name='prepare_topology' BEGIN SELECT RAISE(ABORT,'injected MCP receipt'); END");const before=state(f.a.db);
 assert.throws(()=>callTool(f.a.db,coord.auth,"prepare_topology",args),/injected MCP receipt/);assert.equal(state(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");
 const op=callTool(f.a.db,coord.auth,"prepare_topology",args);assert.equal(op.state,"prepared");assert.equal(op.desired_revision,2);assert.equal(op.dispatch_started,false);
});
test("MCP split task, enrollment and structural proposal roll back together if its durable response fails",()=>{
 const f=setup(),root=card(f.a),coord=principal(f.a);init(f);const before=state(f.a.db),countBefore=count(f.a.db,"broker_task_projects");
 f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests WHEN NEW.tool_name='split_task' BEGIN SELECT RAISE(ABORT,'injected split receipt'); END");
 assert.throws(()=>callTool(f.a.db,coord.auth,"split_task",splitArgs(root)),/injected split receipt/);assert.equal(state(f.a.db),before);assert.equal(count(f.a.db,"broker_task_projects"),countBefore);
});
test("actual owner restore/activation leaves old topology commitments quarantined and tasks unclaimable",()=>{
 const f=setup(),t=card(f.a);init(f);const op=stage(f),evidence=join(f.a.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic topology evidence");
 const backup=createBackup({dbPath:f.a.dbPath,evidenceDir:evidence,destination:join(TMP,"backup-"+serial++)}),dir=join(TMP,"restore-"+serial++);
 restoreBackup({backupDirectory:backup.destination,destination:dir});const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);assert.throws(()=>migrateTopology(db),{code:"RESTORE_HOLD"});
 retireNode({dbPath:f.a.dbPath,expectedEpoch:f.a.node.sync_epoch});const plan=prepareRecovery({dbPath});activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated topology fixture; no physical node attestation",attested_at:new Date().toISOString()}});
 assert.throws(()=>topologyState(db,"demo"),{code:"TOPOLOGY_RECOVERY_REQUIRED"});assert.throws(()=>topologyOperation(db,op.operation_id),{code:"TOPOLOGY_RECOVERY_REQUIRED"});
 assert.equal(store.claimById(db,{id:t.id,worker:"restored"}).ok,false);assert.equal(count(db,"topology_operations"),2);
});
test("CLI can bind, prepare, send and inspect a local registrar using explicit database paths",()=>{
 const a=fixture(),t=card(a),g=createRelationGraph(a.db,{projectId:"demo",members:[{node_id:a.node.node_id,node_epoch:a.node.sync_epoch}]}),id=randomUUID();
 const cli=(...args)=>spawnSync(process.execPath,[join(ROOT,"cli/topology.mjs"),...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});
 assert.notEqual(cli("status","--project","demo").status,0);
 const bound=cli("bind","--db",a.dbPath,"--project","demo","--graph",g.graph_id,"--graph-epoch",g.graph_epoch,"--registrar",a.node.node_id,"--registrar-epoch",a.node.sync_epoch);assert.equal(bound.status,0,bound.stderr);
 const prepared=cli("prepare","--db",a.dbPath,"--project","demo","--operation",id,"--revision","0");assert.equal(prepared.status,0,prepared.stderr);
 const sent=cli("send","--db",a.dbPath,"--operation",id);assert.equal(sent.status,0,sent.stderr);assert.equal(JSON.parse(sent.stdout).state,"applied");
 const status=cli("status","--db",a.dbPath,"--project","demo");assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).revision,1);assert.equal(store.get(a.db,t.id).attempts,0);
});

test("a concurrent completed publisher is reported as acknowledged instead of a stale local conflict",async()=>{
 const f=setup();card(f.a);init(f);const op=stage(f),net=await network(f);let completed=false;
 const result=await sendTopology(f.a.db,{operationId:op.operation_id,...net,fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/status")&&!completed){completed=true;commit(f,op);}return r;}});
 assert.equal(result.state,"applied");assert.equal(result.delivery_state,"acknowledged");assert.equal(result.attempts.length,1);
});
test("independent processes cannot both claim an affected task and prepare its structural removal",async()=>{
 const f=setup(),a=card(f.a),b=card(f.a,{parentId:a.id});init(f);
 const script=join(TMP,"topology-race.mjs"),input=join(TMP,"topology-race.json");
 writeFileSync(input,JSON.stringify({projectId:"demo",operationId:randomUUID(),expectedRevision:1,edits:[edit(f,b)]}));
 writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite";',
  'import {readFileSync} from "node:fs";',
  'import {createInterface} from "node:readline";',
  'const topology=await import(process.argv[2]),store=(await import(process.argv[3])).default,db=new DatabaseSync(process.argv[4]);db.exec("PRAGMA busy_timeout=5000");',
  'process.stdout.write("ready\\n");',
  'for await(const line of createInterface({input:process.stdin})){',
  ' try{const result=process.argv[5]==="prepare"?topology.prepareTopology(db,JSON.parse(readFileSync(process.argv[6],"utf8"))):store.claimById(db,{id:Number(process.argv[6]),worker:"race"});process.stdout.write(JSON.stringify({result})+"\\n");}',
  ' catch(e){process.stdout.write(JSON.stringify({error:e.code??"INTERNAL"})+"\\n");}',
  ' db.close();break;','}'
 ].join("\n"));
 const jobs=[["prepare",input],["claim",String(b.id)]],kids=jobs.map(([mode,arg])=>{
  const cp=spawn(process.execPath,[script,new URL("../core/federation/topology.mjs",import.meta.url).href,new URL("../core/store.js",import.meta.url).href,f.a.dbPath,mode,arg],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let out="",errors="",readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
  cp.stdout.on("data",d=>{out+=d.toString();if(out.includes("ready\n"))readyResolve();});cp.stderr.on("data",d=>errors+=d.toString());cp.once("error",readyReject);
  const done=new Promise(r=>cp.once("close",code=>{if(!out.includes("ready\n"))readyReject(Error("child startup failed: "+errors));r({code,out,errors});}));return {cp,ready,done};
 });let timer,results;
 try{
  const deadline=new Promise((_,j)=>timer=setTimeout(()=>j(Error("topology race timeout")),15000));
  await Promise.race([Promise.all(kids.map(k=>k.ready)),deadline]);for(const k of kids)k.cp.stdin.end("go\n");
  const raw=await Promise.race([Promise.all(kids.map(k=>k.done)),deadline]);assert.ok(raw.every(r=>r.code===0),JSON.stringify(raw));results=raw.map(r=>JSON.parse(r.out.trim().split("\n").at(-1)));
 }finally{clearTimeout(timer);for(const k of kids)if(k.cp.exitCode===null)k.cp.kill();await Promise.all(kids.map(k=>k.done));}
 if(results[0].result){assert.equal(results[0].result.state,"prepared");assert.equal(results[1].result.ok,false);assert.equal(count(f.a.db,"task_runs"),0);assert.equal(store.get(f.a.db,b.id).parent_id,null);}
 else{assert.ok(["CONFLICT","ACTIVE_STRUCTURE"].includes(results[0].error),JSON.stringify(results));assert.equal(results[1].result.ok,true);assert.equal(store.get(f.a.db,b.id).parent_id,a.id);assert.equal(topologyState(f.a.db,"demo").phase,"ready");}
});

test("moving a managed subtree retains archived descendants and their original parent identities",()=>{
 const f=setup(),root=card(f.a),branch=card(f.a,{parentId:root.id}),archived=card(f.a,{parentId:branch.id}),target=card(f.a);store.archive(f.a.db,{id:archived.id});init(f);
 const old=store.get(f.a.db,archived.id),op=stage(f,[edit(f,branch,target)]);commit(f,op);
 const now=store.get(f.a.db,archived.id);assert.equal(now.parent_id,branch.id);assert.equal(now.task_uid,old.task_uid);assert.equal(now.archived_at,old.archived_at);assert.equal(store.get(f.a.db,branch.id).parent_id,target.id);
});

test("final sibling uniqueness is checked before publication and pending title edits preserve commit and cancel",()=>{
 for(const cancel of [false,true]){
  const f=setup(),a=card(f.a),b=card(f.a),moving=card(f.a,{parentId:a.id,subject:"Move Me"}),oldSibling=card(f.a,{parentId:a.id,subject:"old"}),newSibling=card(f.a,{parentId:b.id,subject:"new"});init(f);
  const op=stage(f,[edit(f,moving,b)]);
  assert.throws(()=>store.update(f.a.db,{id:newSibling.id,subject:"m o v e　m e"}),/TOPOLOGY_PENDING/);
  assert.throws(()=>store.update(f.a.db,{id:moving.id,subject:"NEW"}),/TOPOLOGY_PENDING/);
  assert.throws(()=>store.update(f.a.db,{id:oldSibling.id,subject:"moveme"}),/TOPOLOGY_PENDING/);
  store.update(f.a.db,{id:moving.id,subject:"Renamed",description:"user note preserved"});
  assert.throws(()=>f.a.db.prepare("UPDATE tasks SET subject='renamed' WHERE id=?").run(newSibling.id),/TOPOLOGY_PENDING/);
  if(cancel)cancelPreparedTopology(f.a.db,{operationId:op.operation_id});else commit(f,op);
  assert.equal(store.get(f.a.db,moving.id).parent_id,cancel?a.id:b.id);
  assert.equal(store.get(f.a.db,moving.id).subject,"Renamed");
  assert.equal(store.get(f.a.db,moving.id).description,"user note preserved");
  store.update(f.a.db,{id:cancel?newSibling.id:oldSibling.id,subject:"renamed"});
 }
 const f=setup(),a=card(f.a),b=card(f.a,{subject:"Case"}),c=card(f.a,{subject:"c a　s e"});init(f);const before=state(f.a.db);
 assert.throws(()=>stage(f,[edit(f,b,a),edit(f,c,a)]),{code:"DUPLICATE_SIBLING"});assert.equal(state(f.a.db),before);
});
test("SQLite sibling normalization is exact and archived title reservations cannot block commit",()=>{
 const f=setup(),root=card(f.a),a=card(f.a,{subject:"Ä"}),b=card(f.a,{subject:"ä"}),archived=card(f.a,{parentId:root.id,subject:"Ä"});store.archive(f.a.db,{id:archived.id});init(f);
 const op=stage(f,[edit(f,a,root),edit(f,b,root)]);
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET archived_at=NULL WHERE id=?").run(archived.id),/TOPOLOGY_PENDING/);
 commit(f,op);assert.equal(store.get(f.a.db,a.id).parent_id,root.id);assert.equal(store.get(f.a.db,b.id).parent_id,root.id);
});

test("preparation refuses a transition whose native cancellation could not restore the old structure",()=>{
 for(const closed of ["done","archived"]){
  const f=setup(),parent=card(f.a),child=card(f.a,{parentId:parent.id});init(f);
  f.a.db.prepare("UPDATE tasks SET "+(closed==="done"?"status='done'":"archived_at='2026-09-01T00:00:00.000Z'")+" WHERE id=?").run(parent.id);
  const before=state(f.a.db);assert.throws(()=>stage(f,[edit(f,child)]),/closed_parent|已归档/);assert.equal(state(f.a.db),before);
 }
 const f=setup(),dependency=card(f.a),task=card(f.a,{blockedBy:[dependency.id]});init(f);store.archive(f.a.db,{id:dependency.id});
 const before=state(f.a.db);assert.throws(()=>stage(f,[edit(f,task)]),/归档/);assert.equal(state(f.a.db),before);
});
