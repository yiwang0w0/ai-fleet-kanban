import {issueCredential,listenPeerServer,fixtureEndpoint} from "./helpers/peer-network.mjs";
import {federationStuck} from '../core/inspection.mjs';
import {normalizeCancellationClosure} from '../core/federation/cancellation-contract.mjs';
import {migrateCancellationClosure,cancellationClosureState,startCancellationRetirement,recordCancellationRetirement,settleCancellation} from "../core/federation/cancellation-closure.mjs";
import {submitCancellationRetirement} from "../core/federation/cancellation-closure-client.mjs";
import {cancelRelation,completeRelation,localRegistrarPeer} from "../core/federation/relations.mjs";
import {migrateResults,prepareResult,receiveResult,resultState,rejectResult} from "../core/federation/results.mjs";
import {completionContract,completionReady} from "../core/federation/completion-contract.mjs";
import {readFleetTask} from "../core/fleet-view.mjs";
import {migrateCancellations,listCancellations,prepareCancellation,receiveCancellation,cancellationState,recordCancellationReceipt,confirmCancellationStopped,cancellationWork} from "../core/federation/cancellation.mjs";
import {progressCancellation} from "../core/federation/cancellation-service.mjs";
import {deliverCancellation} from "../core/federation/cancellation-client.mjs";
import {prepareUncertainResolution,recordUncertainResolution,migrateDispatch,putQuota,prepareDispatch,authorizeLaunch,finishDispatch,dispatchStatus,quotaStatus} from "../core/execution/dispatch.mjs";
import {watchDelegationCancellation} from "../core/execution/control.mjs";
import {pinFile,superviseProcess} from "../core/execution/supervisor.mjs";
import {existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import http from "node:http";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {putRole,issuePrincipal} from "../core/mcp/policy.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {migratePeers,authenticate,localIdentity,revokePeer} from "../core/federation/peers.mjs";
import {digest,canonical} from "../core/federation/sync-store.mjs";
import {enrollTask,callTool} from "../core/mcp/tools.mjs";
import {createIntent,receiveOffer,decideIncoming,recordReceipt,incomingStatus,outgoingStatus} from "../core/federation/delegation.mjs";
import {migrateRelations,createRelationGraph,publishTopology,approveRelation,withdrawRelation,relationStatus} from "../core/federation/relations.mjs";
import {bindTopology,prepareTopology,startTopologyAttempt,acceptTopologyReceipt,topologyState} from "../core/federation/topology.mjs";
import {migrateBindings,prepareBinding,bindingState,bindingMessage,receiveBindingMessage,recordBindingMessage,startBindingAttempt,acceptBindingReceipt,cancelUnsentBinding,listBindings,releaseBoundTask,bindingProposalState,declineBindingProposal} from "../core/federation/bindings.mjs";
import {submitBinding,sendBindingMessage} from "../core/federation/binding-client.mjs";

const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-binding-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}rmSync(TMP,{recursive:true,force:true});});
function node(){const dir=join(TMP,"n"+serial++);mkdirSync(dir);const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateBindings(db);migrateCancellations(db);migrateRelations(db);return {db,dir,path,node:localIdentity(db)};}
function grant(a,b,scopes=["peer:handshake","delegation:offer","delegation:status","delegation:binding","delegation:control"],projects=["demo"]){const file=join(TMP,"grant"+serial+++".json");issueCredential(b.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes,projects,credentialFile:file,expectedVersion:b.db.prepare("SELECT credential_version FROM federation_peers WHERE peer_node_id=?").get(a.node.node_id)?.credential_version});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(b.db,"Bearer "+c.token)};}
function card(f,extra={}){const id=store.add(f.db,{subject:"work "+serial++,description:"requested work",acceptance:"review evidence",treeMode:"hierarchical",route:"mcp",released:1,...extra}),t=store.get(f.db,id);enrollTask(f.db,{id,projectId:"demo",workKind:"implement",capabilities:["board-tools"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
function register(f,owner,g){bindTopology(owner.db,{projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,registrarNodeId:f.r.node.node_id,registrarEpoch:f.r.node.sync_epoch});const op=prepareTopology(owner.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:0}),args=startTopologyAttempt(owner.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.r.db,g.peer,args);acceptTopologyReceipt(owner.db,{operationId:op.operation_id,requestId:args.request_id,receipt});}
function fixture({withThird=false,localRegistrar=false}={}){
 const a=node(),b=node(),r=localRegistrar?a:node(),source=card(a),ab=grant(a,b),ar=localRegistrar?{peer:localRegistrarPeer(a.db,"demo")}:grant(a,r,["peer:handshake","relations:read","relations:approve","relations:publish"]),br=grant(b,r,["peer:handshake","relations:read","relations:approve","relations:publish"]);
 const out=createIntent(a.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:b.node.node_id,targetEpoch:b.node.sync_epoch});receiveOffer(b.db,ab.peer,out.offer);
 const accepted=decideIncoming(b.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"fixture"});
 recordReceipt(a.db,out.delegation_id,accepted);
 const target=store.get(b.db,b.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id);
 const c=withThird?node():null,g=createRelationGraph(r.db,{projectId:"demo",members:[a,b,...(c?[c]:[])].map(x=>({node_id:x.node.node_id,node_epoch:x.node.sync_epoch}))}),f={a,b,c,r,g,ab,ar,br,source,target,out};
 register(f,a,ar);register(f,b,br);
 f.d={schema_version:1,type:"delegation",relation_id:randomUUID(),delegation_id:out.delegation_id,project_id:"demo",graph_id:g.graph_id,graph_epoch:g.graph_epoch,source_node_id:a.node.node_id,source_epoch:a.node.sync_epoch,source_task_uid:source.task_uid,target_node_id:b.node.node_id,target_epoch:b.node.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest,source_topology_revision:1,target_topology_revision:1};
 return f;
}
function prepare(f,which){const owner=f[which],task=which==="a"?f.source:f.target;return prepareBinding(owner.db,{relation:f.d,expectedTaskVersion:store.get(owner.db,task.id).aggregate_version});}
function approve(f,which){const owner=f[which],args=startBindingAttempt(owner.db,{relationId:f.d.relation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=approveRelation(f.r.db,f[which+"r"].peer,args);return acceptBindingReceipt(owner.db,{relationId:f.d.relation_id,requestId:args.request_id,receipt});}
function send(f,kind){const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind}),receipt=receiveBindingMessage(f.b.db,f.ab.peer,body);return recordBindingMessage(f.a.db,{requestId:body.request_id,receipt});}
function begin(f){prepare(f,"a");approve(f,"a");send(f,"proposal");prepare(f,"b");}
function finish(f){approve(f,"b");const receipt=relationStatus(f.r.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:f.d.relation_id});acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt});send(f,"source_ready");return receipt;}
const state=db=>JSON.stringify(Object.fromEntries(["tasks","task_events","delegation_bindings","binding_attempts","binding_proposals","binding_proposal_decisions","binding_inbox","binding_source_commits","binding_events"].map(n=>[n,db.prepare("SELECT * FROM "+n+" ORDER BY rowid").all()])));
async function network(n){const s=await listenPeerServer(n.db,{port:0});servers.push(s);return "http://127.0.0.1:"+s.address().port;}

function cancel(f,reasonCode="operator_cancelled"){return prepareCancellation(f.a.db,{relationId:f.d.relation_id,cancelId:randomUUID(),expectedTaskVersion:store.get(f.a.db,f.source.id).aggregate_version,reasonCode});}
function received(f){const c=cancel(f),r=receiveCancellation(f.b.db,f.ab.peer,c.request);recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});return c;}
function fullyBound(options){const f=fixture(options);begin(f);finish(f);return f;}
const src=join(TMP,"governance");mkdirSync(src);const sourceGate={check:()=>({code_root:src,tree:"a".repeat(40),commit:"b".repeat(40)})};
function worker(f,{mode="fixture",task=f.target}={}){
 const n=f.b;migrateDispatch(n.db);migrateCancellations(n.db);
 const policy=(role_id,kind)=>({role_id,kind,projects:["demo"],capabilities:["board-tools"],runtime:kind==="implement"?"claude":null,model:kind==="implement"?"fixture-model":null,effort:kind==="implement"?"low":null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:5,max_open_tasks:100,requests_per_minute:300}});
 const suffix=serial++;putRole(n.db,policy("coord"+suffix,"coordinate"));putRole(n.db,policy("engine"+suffix,"implement"));const file=join(TMP,"coord"+suffix+".json");issuePrincipal(n.db,{roleId:"coord"+suffix,projects:["demo"],credentialFile:file});const auth="Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
 if(task.id===f.target.id)releaseBoundTask(n.db,{relationId:f.d.relation_id,expectedTaskVersion:store.get(n.db,task.id).aggregate_version});
 const current=store.get(n.db,task.id),a=callTool(n.db,auth,"request_assignment",{request_id:randomUUID(),task_uid:current.task_uid,expected_version:current.aggregate_version});
 const q=putQuota(n.db,{quota_id:randomUUID(),runtime:"claude",execution_mode:mode,projects:["demo"],limit_total:1,enabled:true}),credentialFile=join(TMP,"worker"+serial+++".json"),w=prepareDispatch(n.db,{assignmentId:a.assignment_id,quotaId:q.quota_id,executionMode:mode,credentialFile,sourceGate});
 return {w,q,auth};
}
const counts=db=>JSON.stringify(Object.fromEntries(["delegation_cancellations","cancellation_members","cancellation_proofs","cancellation_events","tasks","task_events"].map(t=>[t,db.prepare("SELECT * FROM "+t+" ORDER BY rowid").all()])));
test("delivery acknowledgement is not a stop acknowledgement; a never-run target proves quiescence once",()=>{
 const f=fullyBound(),c=received(f);assert.equal(cancellationState(f.a.db,f.d.relation_id).state,"received");assert.equal(cancellationState(f.a.db,f.d.relation_id).stopped,false);
 assert.equal(federationStuck(f.a.db).items.find(i=>i.category==='cancellation_received')?.record_id,c.cancel_id);
 assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);assert.throws(()=>releaseBoundTask(f.b.db,{relationId:f.d.relation_id,expectedTaskVersion:store.get(f.b.db,f.target.id).aggregate_version}),{code:"CONFIRMATION_REQUIRED"});
 const r=progressCancellation(f.b.db,f.d.relation_id);assert.equal(r.receipt.stopped,true);assert.equal(r.receipt.run_count,0);assert.deepEqual(progressCancellation(f.b.db,f.d.relation_id),r);
 assert.equal(recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r.receipt}).stopped,true);
 assert.equal(federationStuck(f.a.db).items.filter(i=>i.category==='cancellation_received').length,0);assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"not-auto-reclaimed"}).ok,false);
 const before=counts(f.a.db);recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r.receipt});assert.equal(counts(f.a.db),before);assert.deepEqual(receiveCancellation(f.b.db,f.ab.peer,c.request),r.receipt);
});
test("source cancellation enforces current version, fixed request identity and local confirmation",()=>{
 const f=fixture();begin(f);assert.throws(()=>cancel(f),{code:"CONFIRMATION_REQUIRED"});finish(f);
 assert.throws(()=>prepareCancellation(f.a.db,{relationId:f.d.relation_id,cancelId:randomUUID(),expectedTaskVersion:999}),{code:"CONFLICT"});const c=cancel(f);
 assert.throws(()=>cancel(f),{code:"REQUEST_CONFLICT"});assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_cancellations").get().n,1);
 assert.throws(()=>receiveCancellation(f.b.db,f.ab.peer,{...c.request,relation:{...c.request.relation,offer_digest:"0".repeat(64)}}),{code:"CONTRACT_MISMATCH"});
 receiveCancellation(f.b.db,f.ab.peer,c.request);assert.throws(()=>receiveCancellation(f.b.db,f.ab.peer,{...c.request,reason_code:"deadline_exceeded"}),{code:"REQUEST_CONFLICT"});
});
test("a lost target confirmation does not prevent authenticated cancellation of the actually prepared endpoint",()=>{
 const f=fixture();begin(f);const a=startBindingAttempt(f.b.db,{relationId:f.d.relation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),r=approveRelation(f.r.db,f.br.peer,a);acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});
 received(f);assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);assert.equal(bindingState(f.b.db,f.d.relation_id).state,"prepared");
});
test("grant scope, projects, credential generation and retired epochs are checked before cancellation",()=>{
 const f=fullyBound(),c=cancel(f),before=counts(f.b.db);
 for(const p of [{...f.ab.peer,scopes:[]},{...f.ab.peer,projects:["other"]},{...f.ab.peer,credential_version:999},{...f.ab.peer,peer_epoch:randomUUID()}])assert.throws(()=>receiveCancellation(f.b.db,p,c.request),{code:"FORBIDDEN"});
 assert.equal(counts(f.b.db),before);const fresh=grant(f.a,f.b);assert.throws(()=>receiveCancellation(f.b.db,f.ab.peer,c.request),{code:"FORBIDDEN"});
 f.b.db.prepare("INSERT INTO federation_retired_epochs VALUES(?,?,?)").run(f.a.node.node_id,f.a.node.sync_epoch,randomUUID());assert.throws(()=>receiveCancellation(f.b.db,fresh.peer,c.request),{code:"RETIRED_EPOCH"});
});
test("prepared permits are abandoned without spending and cannot launch after receipt",()=>{
 const f=fullyBound(),{w,q}=worker(f);received(f);
 assert.throws(()=>authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate}),{code:"CANCELLATION_PENDING"});
 const r=progressCancellation(f.b.db,f.d.relation_id);assert.equal(r.receipt.stopped,true);assert.equal(r.receipt.run_count,1);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"abandoned");assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);assert.equal(store.get(f.b.db,f.target.id).status,"waiting");
 assert.throws(()=>f.b.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(f.target.id),/CANCELLATION_PENDING/);
});
test("task report and lease expiration cannot substitute for a process stop receipt",()=>{
 const f=fullyBound(),{w,q}=worker(f);authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate});received(f);
 store.report(f.b.db,{id:f.target.id,worker:w.worker,runId:w.run_id,outcome:"done",evidence:"late local result"});
 const r=progressCancellation(f.b.db,f.d.relation_id);assert.equal(r.receipt.stopped,false);assert.ok(r.blockers.some(b=>b.kind==="outcome_missing"));
 const settled=finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:"success",evidence:"terminal fixture",usage:null}});assert.equal(settled.phase,"settled");assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.fixture_runs,1);assert.equal(quotaStatus(f.b.db,q.quota_id).used,1);
 const g=fullyBound();releaseBoundTask(g.b.db,{relationId:g.d.relation_id,expectedTaskVersion:store.get(g.b.db,g.target.id).aggregate_version});store.claimById(g.b.db,{id:g.target.id,worker:"unmanaged"});received(g);g.b.db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(g.target.id);store.reapExpired(g.b.db);
 assert.ok(progressCancellation(g.b.db,g.d.relation_id).blockers.some(b=>b.kind==="unmanaged_run"));
});
test("late provider completion is retained for decision instead of accepted as normal work",()=>{
 const f=fullyBound(),{w}=worker(f);authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate});received(f);
 const r=finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:"success",evidence:"completed while disconnected",usage:null}});
 assert.equal(r.result.delivery,"cancelled_work_result_retained");assert.equal(store.get(f.b.db,f.target.id).waiting_for,"decision");assert.equal(store.get(f.b.db,f.target.id).result.includes("completed while disconnected"),true);assert.equal(r.result.accepted,false);
});
test("audit failures roll back cancellation intent, received fence and final proof",()=>{
 const f=fullyBound();let before=counts(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON cancellation_events BEGIN SELECT RAISE(ABORT,'cancel audit fault'); END");assert.throws(()=>cancel(f),/cancel audit fault/);assert.equal(counts(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");const c=cancel(f);
 before=counts(f.b.db);f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON cancellation_events BEGIN SELECT RAISE(ABORT,'cancel audit fault'); END");assert.throws(()=>receiveCancellation(f.b.db,f.ab.peer,c.request),/cancel audit fault/);assert.equal(counts(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");receiveCancellation(f.b.db,f.ab.peer,c.request);
 before=counts(f.b.db);f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON cancellation_events BEGIN SELECT RAISE(ABORT,'cancel audit fault'); END");assert.throws(()=>confirmCancellationStopped(f.b.db,f.d.relation_id),/cancel audit fault/);assert.equal(counts(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");
});
test("real HTTP loss of receive and stop responses replays the same cancel without losing its durable fence",async()=>{
 const f=fullyBound(),c=cancel(f),url=await network(f.b);let lost=true;
 const first=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,url,credentialFile:f.ab.file,fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/cancel")&&lost){lost=false;await r.arrayBuffer();throw Error("lost receive ACK");}return r;}});
 assert.equal(first.delivery_state,"retry_pending");assert.equal(first.state,"pending");assert.equal(cancellationState(f.b.db,f.d.relation_id).state,"received");
 assert.equal((await deliverCancellation(f.a.db,{relationId:f.d.relation_id,url,credentialFile:f.ab.file})).state,"received");
 assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);
 lost=true;const unknown=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ab.file,fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("cancel-status")&&lost){lost=false;await r.arrayBuffer();throw Error("lost stop ACK");}return r;}});
 assert.equal(unknown.state,"received");assert.equal(unknown.delivery_state,"retry_pending");assert.equal(cancellationState(f.b.db,f.d.relation_id).stopped,true);
 const done=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ab.file});assert.equal(done.stopped,true);assert.equal(done.cancel_id,c.cancel_id);assert.equal(f.b.db.prepare("SELECT count(*) n FROM cancellation_proofs").get().n,1);
});
// The wire status operation must never advance a cancellation, even if all
// process evidence is already sufficient. Only explicit progress may write it.
test("cancel-status HTTP reads leave prepared dispatches and all durable state unchanged",async()=>{
 const f=fullyBound(),{w,q}=worker(f),c=received(f),url=await network(f.b);
 const tables=f.b.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
 const snapshot=()=>digest(tables.map(n=>[n,f.b.db.prepare('SELECT * FROM "'+n.replaceAll('"','""')+'"').all()]));
 const query=async(body={},auth=f.ab.auth)=>fetch(url+"/peer/v1/delegation/cancel-status",{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({relation_id:f.d.relation_id,project_id:"demo",cancel_id:c.cancel_id,...body})});
 const before=snapshot();
 for(const [body,auth,status] of [[{},"Bearer invalid",401],[{project_id:"private"},f.ab.auth,404],[{cancel_id:randomUUID()},f.ab.auth,404]]){const r=await query(body,auth);assert.equal(r.status,status);await r.arrayBuffer();assert.equal(snapshot(),before);}
 for(let i=0;i<2;i++){const r=await query();assert.equal(r.status,200);assert.equal((await r.json()).kind,"cancel_received");assert.equal(snapshot(),before);}
 assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"prepared");assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);
 assert.throws(()=>authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate}),{code:"CANCELLATION_PENDING"});
 const progress=cli("progress","--db",f.b.path,"--relation",f.d.relation_id);assert.equal(progress.status,0,progress.stderr);assert.equal(JSON.parse(progress.stdout).receipt.stopped,true);
 assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"abandoned");const stopped=snapshot();
 for(let i=0;i<2;i++){const r=await query();assert.equal(r.status,200);assert.equal((await r.json()).kind,"cancel_stopped");assert.equal(snapshot(),stopped);}
 const saved=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ab.file});assert.equal(saved.stopped,true);assert.equal(snapshot(),stopped);assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);
});

test("poll refuses a peer without the read-only status capability before issuing a status request",async()=>{
 const f=fullyBound(),{w}=worker(f);received(f);const url=await network(f.b),before=counts(f.b.db),sourceBefore=counts(f.a.db);
 for(const missing of [true,false]){
  const paths=[],required=[];
  const result=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ab.file,fetchImpl:async(u,o)=>{
   paths.push(new URL(u).pathname);
   if(u.endsWith("/hello")){
    const body=JSON.parse(o.body);required.push(...body.required_capabilities);
    if(!missing)return new Response(JSON.stringify({code:"REQUIRED_FEATURE_UNSUPPORTED"}),{status:426,headers:{"Content-Type":"application/json"}});
    const r=await fetch(u,{...o,body:JSON.stringify({...body,required_capabilities:["delegation-cancellation-v1"]})}),hello=await r.json();hello.capabilities=hello.capabilities.filter(x=>x!=="delegation-cancellation-status-readonly-v1");
    return new Response(JSON.stringify(hello),{status:r.status,headers:{"Content-Type":"application/json"}});
   }
   return fetch(u,o);
  }});
  assert.equal(result.delivery_state,"blocked");assert.equal(result.error_code,"REQUIRED_FEATURE_UNSUPPORTED");assert.deepEqual(paths,["/peer/v1/hello"]);assert.ok(required.includes("delegation-cancellation-status-readonly-v1"));
  assert.equal(counts(f.a.db),sourceBefore);assert.equal(counts(f.b.db),before);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"prepared");
 }
});

test("forged or changed stop receipts cannot settle a source cancellation",()=>{
 const f=fullyBound();received(f);const r=progressCancellation(f.b.db,f.d.relation_id).receipt,before=counts(f.a.db);
 for(const patch of [{request_digest:"0".repeat(64)},{target_epoch:randomUUID()},{stopped:false},{member_count:0},{fixture_runs:1}])assert.throws(()=>recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:{...r,...patch}}),{code:"RECEIPT_MISMATCH"});
 assert.equal(counts(f.a.db),before);
});
function publishLocal(f,owner,credential,edits=[]){
 const before=topologyState(owner.db,"demo"),op=prepareTopology(owner.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:before.revision,edits}),args=startTopologyAttempt(owner.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.r.db,credential.peer,args);acceptTopologyReceipt(owner.db,{operationId:op.operation_id,requestId:args.request_id,receipt});return op;
}
test("cancellation freezes actual and pending before/desired subtree members while prior topology can still settle",()=>{
 const f=fullyBound(),child=card(f.b),other=card(f.b);
 publishLocal(f,f.b,f.br,[{task_uid:child.task_uid,expected_version:store.get(f.b.db,child.id).aggregate_version,parent_uid:f.target.task_uid,blocked_by:[]}]);
 const pending=prepareTopology(f.b.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:topologyState(f.b.db,"demo").revision,edits:[
 {task_uid:child.task_uid,expected_version:store.get(f.b.db,child.id).aggregate_version,parent_uid:null,blocked_by:[]},
 {task_uid:other.task_uid,expected_version:store.get(f.b.db,other.id).aggregate_version,parent_uid:f.target.task_uid,blocked_by:[]}]});
 received(f);assert.equal(cancellationWork(f.b.db,f.d.relation_id).members.length,3);
 for(const t of [child,other])assert.equal(store.claimById(f.b.db,{id:t.id,worker:"blocked"}).ok,false);
 const args=startTopologyAttempt(f.b.db,{operationId:pending.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.r.db,f.br.peer,args);acceptTopologyReceipt(f.b.db,{operationId:pending.operation_id,requestId:args.request_id,receipt});
 assert.equal(store.get(f.b.db,child.id).parent_id,null);assert.equal(store.get(f.b.db,other.id).parent_id,f.target.id);
 assert.throws(()=>prepareTopology(f.b.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:topologyState(f.b.db,"demo").revision,edits:[{task_uid:child.task_uid,expected_version:store.get(f.b.db,child.id).aggregate_version,parent_uid:f.target.task_uid,blocked_by:[]}]}),/CANCELLATION_PENDING/);
 assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.member_count,3);
});
test("confirmed downstream delegation keeps upstream cancellation pending until its actual stop acknowledgement",()=>{
 const f=fullyBound({withThird:true}),c=f.c,bc=grant(f.b,c),cr=grant(c,f.r,["peer:handshake","relations:read","relations:approve","relations:publish"]),source=store.get(f.b.db,f.target.id);
 const out=createIntent(f.b.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:c.node.node_id,targetEpoch:c.node.sync_epoch});receiveOffer(c.db,bc.peer,out.offer);
 const accepted=decideIncoming(c.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"downstream"});recordReceipt(f.b.db,out.delegation_id,accepted);register(f,c,cr);
 const target=store.get(c.db,c.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id),q={a:f.b,b:c,r:f.r,g:f.g,ab:bc,ar:f.br,br:cr,source,target,out};
 q.d={...f.d,relation_id:randomUUID(),delegation_id:out.delegation_id,source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:source.task_uid,target_node_id:c.node.node_id,target_epoch:c.node.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest};begin(q);finish(q);
 received(f);const waiting=progressCancellation(f.b.db,f.d.relation_id);assert.equal(waiting.receipt.stopped,false);assert.ok(waiting.blockers.some(b=>b.relation_id===q.d.relation_id));
 const childCancel=cancellationState(f.b.db,q.d.relation_id);assert.equal(childCancel.request.reason_code,"upstream_cancelled");receiveCancellation(c.db,bc.peer,childCancel.request);const done=progressCancellation(c.db,q.d.relation_id).receipt;
 recordCancellationReceipt(f.b.db,{relationId:q.d.relation_id,receipt:done});assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.downstream_count,1);
 closureGrants(f);assert.throws(()=>startCancellationRetirement(f.b.db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)}),{code:"DOWNSTREAM_PENDING"});
 retirePair(q);settlePair(q);recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:progressCancellation(f.b.db,f.d.relation_id).receipt});retirePair(f);settlePair(f);
 assert.equal(relationStatus(f.r.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:null}).edges,0);assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"middle-stays-held"}).ok,false);

});
test("reopened databases and repeated migrations retain cancellation fences and terminal proof",()=>{
 const f=fullyBound();received(f);progressCancellation(f.b.db,f.d.relation_id);const db=new DatabaseSync(f.b.path);
 try{migrateCancellations(db);migrateCancellations(db);assert.equal(cancellationState(db,f.d.relation_id).stopped,true);assert.equal(store.claimById(db,{id:f.target.id,worker:"restarted"}).ok,false);
 for(const table of ["delegation_cancellations","cancellation_members","cancellation_proofs","cancellation_events"])assert.throws(()=>db.exec("DELETE FROM "+table),/retained/);
 assert.throws(()=>db.exec("UPDATE delegation_cancellations SET state='received'"),/immutable/);
 }finally{db.close();}
});
test("current authorization is rechecked after an actual cancel upload, with no partial fence on revocation",async()=>{
 const f=fullyBound(),c=cancel(f),body=JSON.stringify(c.request),url=await network(f.b),server=servers.at(-1),before=counts(f.b.db);let notify;
 const receiving=new Promise(resolve=>notify=resolve);server.once("request",()=>notify());
 const response=new Promise((resolve,reject)=>{const req=http.request(url+"/peer/v1/delegation/cancel",{method:"POST",headers:{Authorization:f.ab.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);const split=Math.floor(body.length/2);req.write(body.slice(0,split));receiving.then(()=>{revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});req.end(body.slice(split));}).catch(reject);});
 assert.ok((await response)>=400);assert.equal(counts(f.b.db),before);
});
test("durable cancellation watcher stops an actual supervised process tree and retains its observed outcome",async()=>{
 const f=fullyBound(),{w,q}=worker(f,{mode:"provider"}),script=join(TMP,"cancel-worker"+serial+++".mjs"),pidFile=join(TMP,"cancel-child"+serial+++".txt");
 writeFileSync(script,[
 'import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs";',
 'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(process.argv[2],String(child.pid));',
 'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"cancel-fixture",model:"fixture-model"})+"\\n");setInterval(()=>{},1000);'
 ].join("\n"));
 const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys; print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim()),command=pinFile(process.execPath),file=pinFile(script);
 const execution={format:"ai-fleet-process/v1",adapter_contract:"cancel-fixture/v1",adapter_digest:"1".repeat(64),runtime:"claude",model:"fixture-model",effort:"low",run_id:w.run_id,agent_instance_id:w.agent_instance_id,principal_id:w.principal_id,command_sha256:command.sha256,python_sha256:python.sha256,files_digest:digest([file]),prompt_sha256:"2".repeat(64),environment_sha256:"3".repeat(64),timeout_ms:10000,heartbeat_ms:50,stderr_limit:1024};
 authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate,execution});const safety=new AbortController(),watch=watchDelegationCancellation(f.b.db,w.task_id,{intervalMs:50,signal:safety.signal});
 const running=superviseProcess({python,command,args:[script,pidFile],cwd:TMP,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),input:"fixture",pins:[file],runtime:"claude",timeoutMs:10000,heartbeatMs:50,stderrLimit:1024,signal:watch.signal});
 let out;try{
  for(let i=0;i<200&&!existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,20));assert.equal(existsSync(pidFile),true,"fixture must actually start");
  received(f);revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,false);
  out=await running;
 }finally{safety.abort();if(!out)await running;watch.close();}
 assert.equal(out.status,"cancelled",JSON.stringify(out));assert.equal(out.process.started,true);
 finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:out.status,evidence:out.evidence,usage:out.usage},observation:out});
 const done=progressCancellation(f.b.db,f.d.relation_id);
 if(process.platform==="win32"){assert.equal(out.process.cleanup,"job_empty");assert.equal(done.receipt.stopped,true);}else{assert.equal(out.process.cleanup,"group_signalled");assert.equal(done.receipt.stopped,false);assert.ok(done.blockers.some(b=>b.kind==="process_stop_unconfirmed"));}
 const pid=Number(readFileSync(pidFile,"utf8"));let alive=true;for(let i=0;i<100;i++){try{process.kill(pid,0);if(process.platform==="linux"&&readFileSync("/proc/"+pid+"/stat","utf8").split(") ")[1]?.startsWith("Z"))alive=false;}catch{alive=false;}if(!alive)break;await new Promise(r=>setTimeout(r,20));}assert.equal(alive,false,"fixture child must actually exit");
 assert.equal(quotaStatus(f.b.db,q.quota_id).used,1);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).real_model_call_confirmed,false);
});

function principal(n,kind="coordinate",projects=["demo"]){
 const id="p"+serial++,file=join(TMP,id+".json");putRole(n.db,{role_id:id,kind,projects,capabilities:[],runtime:null,model:null,effort:null,tools:kind==="observe"?"read-only":"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300}});issuePrincipal(n.db,{roleId:id,projects,credentialFile:file});return "Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
}
test("MCP cancellation intent is coordinator/project scoped and atomic with its durable response",()=>{
 const f=fullyBound(),coord=principal(f.a),observe=principal(f.a,"observe"),foreign=principal(f.a,"coordinate",["other"]),args={request_id:randomUUID(),relation_id:f.d.relation_id,expected_version:store.get(f.a.db,f.source.id).aggregate_version,reason_code:"operator_cancelled"};
 assert.throws(()=>callTool(f.a.db,observe,"request_cancellation",args),{code:"FORBIDDEN"});
 assert.throws(()=>callTool(f.a.db,foreign,"request_cancellation",args),{code:"NOT_FOUND"});
 assert.throws(()=>callTool(f.a.db,coord,"request_cancellation",{...args,reason_code:"upstream_cancelled"}),{code:"BAD_INPUT"});
 const before=counts(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'cancel response fault'); END");
 assert.throws(()=>callTool(f.a.db,coord,"request_cancellation",args),/cancel response fault/);assert.equal(counts(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");
 const r=callTool(f.a.db,coord,"request_cancellation",args);assert.equal(r.state,"pending");assert.deepEqual(callTool(f.a.db,coord,"request_cancellation",args),r);
 assert.throws(()=>callTool(f.a.db,coord,"request_cancellation",{...args,reason_code:"deadline_exceeded"}),{code:"REQUEST_CONFLICT"});
 assert.equal(callTool(f.a.db,observe,"get_cancellation",{relation_id:f.d.relation_id}).state,"pending");
 assert.equal(callTool(f.a.db,observe,"list_cancellations",{project_id:"demo",limit:10}).cancellations[0].identity_current,1);
 assert.throws(()=>callTool(f.a.db,foreign,"get_cancellation",{relation_id:f.d.relation_id}),{code:"NOT_FOUND"});
 assert.throws(()=>callTool(f.a.db,foreign,"list_cancellations",{project_id:"demo",limit:10}),{code:"FORBIDDEN"});
});
test("MCP and direct progress roll back abandoned permits, principal revocation and proof together",()=>{
 const f=fullyBound(),{w,q,auth}=worker(f),observe=principal(f.b,"observe"),foreign=principal(f.b,"coordinate",["other"]);received(f);
 const args={request_id:randomUUID(),relation_id:f.d.relation_id},snapshot=()=>JSON.stringify([counts(f.b.db),dispatchStatus(f.b.db,w.dispatch_id),f.b.db.prepare("SELECT * FROM broker_principals").all(),f.b.db.prepare("SELECT * FROM broker_auth_events").all(),f.b.db.prepare("SELECT * FROM broker_assignments").all(),f.b.db.prepare("SELECT * FROM broker_dispatch_events").all()]);
 assert.throws(()=>callTool(f.b.db,observe,"progress_cancellation",args),{code:"FORBIDDEN"});
 assert.throws(()=>callTool(f.b.db,foreign,"progress_cancellation",args),{code:"NOT_FOUND"});
 const before=snapshot();
 for(const table of ["cancellation_proofs","broker_requests"]){
  f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'progress persistence fault'); END");
  assert.throws(()=>table==="broker_requests"?callTool(f.b.db,auth,"progress_cancellation",args):progressCancellation(f.b.db,f.d.relation_id),/progress persistence fault/);
  assert.equal(snapshot(),before);f.b.db.exec("DROP TRIGGER injected");
 }
 const r=callTool(f.b.db,auth,"progress_cancellation",args);assert.equal(r.receipt.stopped,true);assert.deepEqual(callTool(f.b.db,auth,"progress_cancellation",args),r);
 assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"abandoned");
});
function cli(command,...args){return spawnSync(process.execPath,[join(ROOT,"cli/cancellation.mjs"),command,...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});}
function cliAsync(command,...args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[join(ROOT,"cli/cancellation.mjs"),command,...args],{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);p.once("error",reject);p.once("close",status=>resolve({status,stdout:out,stderr:err}));});}
test("explicit-database CLI performs request, HTTP send/poll, inspection and unresolved exit reporting",async()=>{
 const f=fullyBound(),{w}=worker(f);authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate});
 assert.notEqual(cli("get","--relation",f.d.relation_id).status,0);
 const args=["--db",f.a.path,"--relation",f.d.relation_id,"--id",randomUUID(),"--version",String(store.get(f.a.db,f.source.id).aggregate_version)];
 assert.notEqual(cli("request",...args,"--reason","upstream_cancelled").status,0);
 const created=cli("request",...args,"--reason","deadline_exceeded");assert.equal(created.status,0,created.stderr);assert.equal(JSON.parse(created.stdout).request.reason_code,"deadline_exceeded");
 assert.equal(cli("get","--db",f.a.path,"--relation",f.d.relation_id).status,0);
 const listed=cli("list","--db",f.a.path,"--project","demo");assert.equal(listed.status,0,listed.stderr);assert.equal(JSON.parse(listed.stdout).cancellations.length,1);
 const url=await network(f.b),transport=["--db",f.a.path,"--relation",f.d.relation_id,"--url",url,"--credential",f.ab.file];
 const sent=await cliAsync("send",...transport);assert.equal(sent.status,0,sent.stderr);assert.equal(JSON.parse(sent.stdout).stopped,false);
 const pending=cli("progress","--db",f.b.path,"--relation",f.d.relation_id);assert.equal(pending.status,2,pending.stderr);assert.equal(JSON.parse(pending.stdout).receipt.stopped,false);
 finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:"cancelled",evidence:"terminal synthetic fixture",usage:null}});
 const unadvanced=await cliAsync("poll",...transport);assert.equal(unadvanced.status,0,unadvanced.stderr);assert.equal(JSON.parse(unadvanced.stdout).stopped,false);
 const progressed=cli("progress","--db",f.b.path,"--relation",f.d.relation_id);assert.equal(progressed.status,0,progressed.stderr);assert.equal(JSON.parse(progressed.stdout).receipt.stopped,true);
 const done=await cliAsync("poll",...transport);assert.equal(done.status,0,done.stderr);assert.equal(JSON.parse(done.stdout).stopped,true);
});
test("independent processes serialize cancellation receipt against consuming a single launch permit",async()=>{
 const f=fullyBound(),{w,q}=worker(f),c=cancel(f),script=join(TMP,"cancel-race"+serial+++".mjs"),file=join(TMP,"cancel-race"+serial+++".json");
 writeFileSync(file,JSON.stringify({peer:f.ab.peer,request:c.request,dispatchId:w.dispatch_id,gate:sourceGate.check()}));
 writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite"; import {readFileSync} from "node:fs";',
  'import {receiveCancellation} from '+JSON.stringify(new URL("../core/federation/cancellation.mjs",import.meta.url).href)+';',
  'import {authorizeLaunch} from '+JSON.stringify(new URL("../core/execution/dispatch.mjs",import.meta.url).href)+';',
  'const [path,file,action]=process.argv.slice(2),db=new DatabaseSync(path),x=JSON.parse(readFileSync(file,"utf8"));db.exec("PRAGMA busy_timeout=5000");',
  'process.send("ready");process.once("message",()=>{let r;try{r=action==="cancel"?receiveCancellation(db,x.peer,x.request):authorizeLaunch(db,{dispatchId:x.dispatchId,sourceGate:{check:()=>x.gate}});}catch(e){r={error:e.code||e.message};}db.close();process.stdout.write(JSON.stringify(r));process.disconnect();});'
 ].join("\n"));
 const children=["cancel","launch"].map(action=>{const p=spawn(process.execPath,[script,f.b.path,file,action],{stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);return {p,ready:new Promise((resolve,reject)=>{p.once("message",resolve);p.once("error",reject);p.once("exit",code=>{if(code!==0)reject(Error("startup "+code+" "+err));});}),done:new Promise((resolve,reject)=>{p.once("error",reject);p.once("close",code=>{if(code!==0)return reject(Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});})};});
 await Promise.all(children.map(c=>c.ready));for(const c of children)c.p.send("go");const [ack,launch]=await Promise.all(children.map(c=>c.done));
 assert.equal(ack.kind,"cancel_received");assert.equal(ack.stopped,false);
 if(launch.launch_permit){assert.equal(quotaStatus(f.b.db,q.quota_id).used,1);assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,false);finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:"cancelled",evidence:"synthetic terminal after race",usage:null}});}
 else{assert.equal(launch.error,"CANCELLATION_PENDING");assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);}
 assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);
 assert.throws(()=>authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate}));
});
test("restored target retains fences and exposes old cancellation history without reusing its stop proof",()=>{
 const f=fullyBound();received(f);progressCancellation(f.b.db,f.d.relation_id);
 const evidence=join(f.b.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic cancellation evidence");
 const backup=createBackup({dbPath:f.b.path,evidenceDir:evidence,destination:join(TMP,"cancel-backup"+serial++)}),dir=join(TMP,"cancel-restore"+serial++);restoreBackup({backupDirectory:backup.destination,destination:dir});
 const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);assert.throws(()=>cancellationState(db,f.d.relation_id),{code:"RESTORE_HOLD"});
 retireNode({dbPath:f.b.path,expectedEpoch:f.b.node.sync_epoch});const plan=prepareRecovery({dbPath:path});
 activateRecovery({dbPath:path,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated cancellation fixture",attested_at:new Date().toISOString()}});
 assert.throws(()=>progressCancellation(db,f.d.relation_id),{code:"CANCELLATION_RECOVERY_REQUIRED"});assert.equal(store.claimById(db,{id:f.target.id,worker:"restored"}).ok,false);
 assert.equal(listCancellations(db,{projectId:"demo"}).cancellations[0].identity_current,0);
});
test("lost source persistence after a real stopped HTTP receipt is retryable without rewriting target proof",async()=>{
 const f=fullyBound();received(f);progressCancellation(f.b.db,f.d.relation_id);const url=await network(f.b),before=counts(f.a.db);
 f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON cancellation_events BEGIN SELECT RAISE(ABORT,'stop receipt persistence fault'); END");
 const failed=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ab.file});
 assert.equal(failed.delivery_state,"retry_pending");assert.equal(failed.stopped,false);assert.equal(counts(f.a.db),before);assert.equal(cancellationState(f.b.db,f.d.relation_id).stopped,true);
 f.a.db.exec("DROP TRIGGER injected");const proof=counts(f.b.db);
 assert.equal((await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ab.file})).stopped,true);assert.equal(counts(f.b.db),proof);
});
test("database launch fence is installed in both migration orders and rejects old direct launch writes",()=>{
 for(const dispatchFirst of [false,true]){
  const f=fullyBound(),{w,q}=worker(f);f.b.db.exec("DROP TRIGGER cancellation_launch_hold");
  if(dispatchFirst)migrateCancellations(f.b.db);else migrateDispatch(f.b.db);
  received(f);assert.throws(()=>f.b.db.prepare("UPDATE broker_dispatches SET launch_at=? WHERE dispatch_id=?").run(new Date().toISOString(),w.dispatch_id),/CANCELLATION_PENDING/);
  assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"prepared");
 }
});

test("upstream cancellation safely closes only unsent downstream preparations and waits for registrar withdrawal otherwise",()=>{
 for(const uncertain of [false,true]){
  const f=fullyBound({withThird:true}),c=f.c,bc=grant(f.b,c),cr=grant(c,f.r,["peer:handshake","relations:read","relations:approve","relations:publish"]),source=store.get(f.b.db,f.target.id);
  const out=createIntent(f.b.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:c.node.node_id,targetEpoch:c.node.sync_epoch});receiveOffer(c.db,bc.peer,out.offer);
  const accepted=decideIncoming(c.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"prepared downstream"});recordReceipt(f.b.db,out.delegation_id,accepted);register(f,c,cr);
  const target=store.get(c.db,c.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id),q={a:f.b,b:c,r:f.r,g:f.g,ab:bc,ar:f.br,br:cr,source,target,out};
  q.d={...f.d,relation_id:randomUUID(),delegation_id:out.delegation_id,source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:source.task_uid,target_node_id:c.node.node_id,target_epoch:c.node.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest};prepare(q,"a");
  if(uncertain)startBindingAttempt(f.b.db,{relationId:q.d.relation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version});
  received(f);const result=progressCancellation(f.b.db,f.d.relation_id);
  assert.equal(result.receipt.stopped,!uncertain);
  if(uncertain){
   assert.equal(bindingState(f.b.db,q.d.relation_id).state,"prepared");assert.ok(result.blockers.some(b=>b.relation_id===q.d.relation_id));
   assert.throws(()=>startBindingAttempt(f.b.db,{relationId:q.d.relation_id,action:"withdraw"}),{code:"UNKNOWN_REMOTE_OUTCOME"});
   const original=startBindingAttempt(f.b.db,{relationId:q.d.relation_id}),recovered=approveRelation(f.r.db,f.br.peer,original);acceptBindingReceipt(f.b.db,{relationId:q.d.relation_id,requestId:original.request_id,receipt:recovered});
   const args=startBindingAttempt(f.b.db,{relationId:q.d.relation_id,action:"withdraw"}),receipt=withdrawRelation(f.r.db,f.br.peer,args);acceptBindingReceipt(f.b.db,{relationId:q.d.relation_id,requestId:args.request_id,receipt});
   assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);
  }
  assert.equal(bindingState(f.b.db,q.d.relation_id).state,"cancelled");assert.equal(store.get(c.db,target.id).attempts,0);
 }
});
test("an interrupted but never-launched prepared run can be abandoned without a model call",()=>{
 const f=fullyBound(),{w,q}=worker(f);store.report(f.b.db,{id:f.target.id,worker:w.worker,runId:w.run_id,outcome:"wait",evidence:"stopped before execution"});
 assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"interrupted");received(f);
 assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).phase,"abandoned");assert.equal(quotaStatus(f.b.db,q.quota_id).used,0);
});

test("CLI cancellation closure retires the edge bilaterally and returns the paused source to its owner",async()=>{
 const f=fullyBound();received(f);recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:progressCancellation(f.b.db,f.d.relation_id).receipt});
 const scopes=["peer:handshake","relations:read","relations:approve","relations:publish","relations:complete"],ar=grant(f.a,f.r,scopes),br=grant(f.b,f.r,scopes),url=await network(f.r),args=(n,g)=>["--db",n.path,"--relation",f.d.relation_id,"--url",url,"--credential",g.file];
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"before-retirement"}).ok,false);
 const first=await cliAsync("retire",...args(f.a,ar));assert.equal(first.status,2,first.stderr);assert.equal(JSON.parse(first.stdout).closure_phase,"voting");
 const second=await cliAsync("retire",...args(f.b,br));assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).closure_phase,"retired");
 const polled=await cliAsync("retire-poll",...args(f.a,ar));assert.equal(polled.status,0,polled.stderr);
 for(const [n,id] of [[f.a,f.source.id],[f.b,f.target.id]]){const r=cli("settle","--db",n.path,"--relation",f.d.relation_id,"--version",String(store.get(n.db,id).aggregate_version));assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).closure_phase,"settled");assert.equal(bindingState(n.db,f.d.relation_id).state,"cancelled");assert.equal(n.db.prepare("SELECT closed FROM delegation_bindings WHERE relation_id=?").get(f.d.relation_id).closed,1);}
 assert.equal(store.get(f.a.db,f.source.id).released,false);assert.equal(store.get(f.a.db,f.source.id).status,"not_started");assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"cancelled-target"}).ok,false);
 assert.equal(relationStatus(f.r.db,ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:null}).edges,0);assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_edges").get().n,1);
 store.setReleased(f.a.db,{id:f.source.id,released:true,expectedVersion:store.get(f.a.db,f.source.id).aggregate_version});assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"owner-resumed"}).ok,true);
});

const retirementScopes=["peer:handshake","relations:read","relations:approve","relations:publish","relations:complete"];
const graphVersion=f=>f.r.db.prepare("SELECT version FROM relation_graphs").get().version;
function closureGrants(f){for(const side of ["a","b"]){migrateCancellationClosure(f[side].db);f[side+"r"]=f[side]===f.r?{peer:localRegistrarPeer(f.r.db,"demo")}:grant(f[side],f.r,retirementScopes);}}
function stopped(f){received(f);const r=progressCancellation(f.b.db,f.d.relation_id).receipt;recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});return r;}
function retirePair(f){closureGrants(f);let receipt;for(const side of ["a","b"]){const args=startCancellationRetirement(f[side].db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)});receipt=cancelRelation(f.r.db,f[side+"r"].peer,args);recordCancellationRetirement(f[side].db,{relationId:f.d.relation_id,requestId:args.request_id,receipt});}assert.equal(receipt.cancelled,true);recordCancellationRetirement(f.a.db,{relationId:f.d.relation_id,receipt});return receipt;}
function settlePair(f){for(const [n,t] of [[f.a,f.source],[f.b,f.target]])settleCancellation(n.db,{relationId:f.d.relation_id,expectedTaskVersion:store.get(n.db,t.id).aggregate_version});}
function databaseRows(db,{mcp=false}={}){return canonical(Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().filter(({name})=>!mcp||!["broker_audit","broker_rate"].includes(name)).map(({name})=>[name,digest(db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY rowid').all())])));}

test("cancellation closure requires stop evidence, matching receipts and task CAS before unlocking",()=>{
 const f=fullyBound();received(f);closureGrants(f);assert.throws(()=>startCancellationRetirement(f.a.db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)}),{code:"STOP_UNCONFIRMED"});
 assert.throws(()=>f.a.db.exec("UPDATE delegation_bindings SET state='cancelled',closed=1"),/binding/);assert.throws(()=>settleCancellation(f.a.db,{relationId:f.d.relation_id,expectedTaskVersion:f.source.aggregate_version}),{code:"CANCELLATION_NOT_RETIRED"});
 recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:progressCancellation(f.b.db,f.d.relation_id).receipt});const final=retirePair(f),before=databaseRows(f.a.db);
 const changed=structuredClone(final.cancellation);changed.stopped.proof_digest="0".repeat(64);assert.throws(()=>cancelRelation(f.r.db,f.br.peer,{request_id:randomUUID(),expected_version:graphVersion(f),cancellation:changed}),{code:"REQUEST_CONFLICT"});
 for(const bad of [{...final,registrar_node_id:randomUUID()},{...final,cancellation_digest:"0".repeat(64)},{...final,approved_by:[final.approved_by[0],final.approved_by[0]]}])assert.throws(()=>recordCancellationRetirement(f.a.db,{relationId:f.d.relation_id,receipt:bad}),{code:"BAD_CANCELLATION_CLOSURE"});
 assert.throws(()=>settleCancellation(f.a.db,{relationId:f.d.relation_id,expectedTaskVersion:999}),{code:"CONFLICT"});assert.equal(databaseRows(f.a.db),before);assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"not-settled"}).ok,false);
});

test("cancellation closure retries lost HTTP ACK and local persistence using one durable retirement",async()=>{
 const f=fullyBound();stopped(f);closureGrants(f);const url=await network(f.r),args=side=>({relationId:f.d.relation_id,url,credentialFile:f[side+"r"].file}),before=graphVersion(f);
 assert.equal((await submitCancellationRetirement(f.a.db,args("a"))).delivery_state,"waiting_peer");let lost=true;
 const unknown=await submitCancellationRetirement(f.b.db,{...args("b"),fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/relations/cancel")&&lost){lost=false;await r.arrayBuffer();throw Error("lost cancellation retirement ACK");}return r;}});assert.equal(unknown.delivery_state,"retry_pending");assert.equal(graphVersion(f),before+1);
 const requestId=unknown.attempts.find(a=>a.state==="pending").request_id;f.b.db.exec("CREATE TRIGGER fault BEFORE INSERT ON cancellation_retirements BEGIN SELECT RAISE(ABORT,'retirement persistence fault'); END");assert.equal((await submitCancellationRetirement(f.b.db,args("b"))).error_code,"STORAGE_ERROR");f.b.db.exec("DROP TRIGGER fault");
 const reopened=new DatabaseSync(f.b.path);dbs.push(reopened);migrateCancellationClosure(reopened);const recovered=await submitCancellationRetirement(reopened,args("b"));assert.equal(recovered.closure_phase,"retired");assert.equal(recovered.attempts[0].request_id,requestId);assert.equal(graphVersion(f),before+1);
 assert.equal((await submitCancellationRetirement(f.a.db,{...args("a"),mode:"poll"})).closure_phase,"retired");assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_cancellations").get().n,1);assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_edges").get().n,1);
});

test("cancellation closure rejects stale graph votes and ignores revoked credential generations",async()=>{
 const f=fullyBound();stopped(f);closureGrants(f);const url=await network(f.r),args=side=>({relationId:f.d.relation_id,url,credentialFile:f[side+"r"].file});let bump=true;
 const conflict=await submitCancellationRetirement(f.a.db,{...args("a"),fetchImpl:async(u,o)=>{if(u.endsWith("/relations/cancel")&&bump){bump=false;f.r.db.exec("UPDATE relation_graphs SET version=version+1");}return fetch(u,o);}});assert.equal(conflict.delivery_state,"rejected");assert.equal(conflict.error_code,"GRAPH_VERSION_CONFLICT");
 assert.equal((await submitCancellationRetirement(f.a.db,args("a"))).delivery_state,"waiting_peer");const old=f.ar;f.ar=grant(f.a,f.r,retirementScopes);
 assert.equal((await submitCancellationRetirement(f.b.db,args("b"))).delivery_state,"waiting_peer");assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_cancellations").get().n,0);assert.throws(()=>cancelRelation(f.r.db,old.peer,{...startCancellationRetirement(f.a.db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)})}),{code:"AUTHORIZATION_CHANGED"});
 const current=await submitCancellationRetirement(f.a.db,args("a"));assert.equal(current.closure_phase,"retired");assert.equal(current.retirement.approved_by.find(a=>a.node_id===f.a.node.node_id).credential_version,f.ar.peer.credential_version);
});

test("cancellation closure refuses unsupported registrars and rechecks authority after network response",async()=>{
 const f=fullyBound();stopped(f);closureGrants(f);const url=await network(f.r);let writes=0;
 const blocked=await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id,url,credentialFile:f.ar.file,fetchImpl:async(u,o)=>{if(u.endsWith("/relations/cancel"))writes++;const r=await fetch(u,o);if(u.endsWith("/hello")){const body=await r.json();body.capabilities=[];return new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});}return r;}});assert.equal(blocked.error_code,"REQUIRED_FEATURE_UNSUPPORTED");assert.equal(writes,0);assert.equal(blocked.attempts.length,0);
 let valid=true;const revoked=await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id,url,credentialFile:f.ar.file,authorize:()=>{if(!valid){const e=Error("operator revoked");e.code="AUTHORIZATION_CHANGED";throw e;}},fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/relations/cancel"))valid=false;return r;}});assert.equal(revoked.delivery_state,"retry_pending");assert.equal(revoked.closure_phase,"voting");assert.equal(revoked.attempts[0].state,"pending");assert.equal(f.a.db.prepare("SELECT count(*) n FROM cancellation_retirements").get().n,0);
});

test("cancellation closure settlement rolls back task, binding and MCP response and preserves replay",()=>{
 const f=fullyBound();stopped(f);retirePair(f);const auth=principal(f.a),observe=principal(f.a,"observe"),other=principal(f.a,"coordinate",["other"]),args={request_id:randomUUID(),relation_id:f.d.relation_id,expected_version:store.get(f.a.db,f.source.id).aggregate_version};
 assert.throws(()=>callTool(f.a.db,observe,"settle_cancellation",args),{code:"FORBIDDEN"});assert.throws(()=>callTool(f.a.db,other,"settle_cancellation",args),{code:"NOT_FOUND"});
 for(const table of ["cancellation_settlements","cancellation_events","broker_requests"]){const before=databaseRows(f.a.db,{mcp:true}),audit=f.a.db.prepare("SELECT count(*) n FROM broker_audit").get().n,rate=f.a.db.prepare("SELECT sum(count) n FROM broker_rate").get().n;f.a.db.exec("CREATE TRIGGER fault BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'cancel settlement persistence fault'); END");assert.throws(()=>callTool(f.a.db,auth,"settle_cancellation",args),/cancel settlement persistence fault/);assert.equal(databaseRows(f.a.db,{mcp:true}),before);assert.equal(f.a.db.prepare("SELECT count(*) n FROM broker_audit").get().n,audit+1);assert.equal(f.a.db.prepare("SELECT sum(count) n FROM broker_rate").get().n,rate+1);assert.equal(f.a.db.prepare("SELECT outcome FROM broker_audit ORDER BY id DESC LIMIT 1").get().outcome,"ERR_SQLITE_ERROR");f.a.db.exec("DROP TRIGGER fault");}
 const done=callTool(f.a.db,auth,"settle_cancellation",args),before=databaseRows(f.a.db,{mcp:true});assert.equal(done.closure_phase,"settled");assert.equal(done.accepted,false);assert.deepEqual(callTool(f.a.db,auth,"settle_cancellation",args),done);assert.equal(databaseRows(f.a.db,{mcp:true}),before);assert.equal(f.a.db.prepare("SELECT outcome FROM broker_audit ORDER BY id DESC LIMIT 1").get().outcome,"replayed");assert.equal(callTool(f.a.db,observe,"get_cancellation",{relation_id:f.d.relation_id}).closure_phase,"settled");
 const oldReady=JSON.parse(f.a.db.prepare("SELECT body_json FROM binding_outbox WHERE kind='source_ready'").get().body_json),targetVersion=store.get(f.b.db,f.target.id).aggregate_version;settleCancellation(f.b.db,{relationId:f.d.relation_id,expectedTaskVersion:targetVersion});migrateBindings(f.b.db);assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,oldReady),{code:"CONTRACT_MISMATCH"});assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
 const prior=f.a.db.prepare("SELECT * FROM delegation_cancellations WHERE relation_id=?").get(f.d.relation_id),request=JSON.parse(prior.request_json);assert.equal(prepareCancellation(f.a.db,{relationId:f.d.relation_id,cancelId:prior.cancel_id,expectedTaskVersion:prior.expected_task_version,reasonCode:request.reason_code}).stopped,true);assert.deepEqual(receiveCancellation(f.b.db,f.ab.peer,request),JSON.parse(prior.stopped_json));
});

test("cancellation closure handles a prepared target with lost original confirmation without reviving it",()=>{
 const f=fixture();begin(f);const a=startBindingAttempt(f.b.db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)}),r=approveRelation(f.r.db,f.br.peer,a);acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});stopped(f);assert.equal(bindingState(f.b.db,f.d.relation_id).state,"prepared");retirePair(f);settlePair(f);
 assert.equal(bindingState(f.b.db,f.d.relation_id).state,"cancelled");assert.throws(()=>acceptBindingReceipt(f.b.db,{relationId:f.d.relation_id,requestId:a.request_id,receipt:r}),{code:"CONFLICT"});assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"late-confirmation"}).ok,false);
});

function syntheticCompletion(f){const p={schema_version:1,kind:"source_acceptance",completion_id:randomUUID(),relation:f.d,result_id:randomUUID(),body_digest:"a".repeat(64),source_task_version:store.get(f.a.db,f.source.id).aggregate_version,target_task_version:store.get(f.b.db,f.target.id).aggregate_version,verification_receipt_digest:"b".repeat(64),integration_receipt_digest:"c".repeat(64),artifact_manifest_digest:"d".repeat(64),source_merge_commit:"e".repeat(40),source_tree:"f".repeat(40),scope_digest:"1".repeat(64),fixture_runs:1,decision:{kind:"operator",note:"synthetic registrar contract only",allow_fixture:true}};return completionContract(p,completionReady(p));}
test("cancellation closure and successful completion cannot both win the registrar lifecycle",()=>{
 for(const cancellationFirst of [true,false]){const f=fullyBound();stopped(f);closureGrants(f);const a=startCancellationRetirement(f.a.db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)}),done={request_id:randomUUID(),expected_version:graphVersion(f),completion:syntheticCompletion(f)};
  if(cancellationFirst){cancelRelation(f.r.db,f.ar.peer,a);assert.throws(()=>completeRelation(f.r.db,f.ar.peer,done),{code:"CANCELLATION_COMMITTED"});}
  else{completeRelation(f.r.db,f.ar.peer,done);assert.throws(()=>cancelRelation(f.r.db,f.ar.peer,a),{code:"COMPLETION_COMMITTED"});}
  assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_cancellations").get().n,0);assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_completions").get().n,0);
 }
});

test("cancellation closure retains late candidate data after both bindings close without accepting or restarting",()=>{
 const f=fullyBound(),{w}=worker(f);migrateResults(f.a.db);migrateResults(f.b.db);authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate});received(f);finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:"success",evidence:"late cancelled fixture evidence",usage:null}});recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:progressCancellation(f.b.db,f.d.relation_id).receipt});retirePair(f);settlePair(f);
 const result=prepareResult(f.b.db,{resultId:randomUUID(),relationId:f.d.relation_id,expectedTaskVersion:store.get(f.b.db,f.target.id).aggregate_version}),ba=grant(f.b,f.a,["peer:handshake","delegation:result"]),sourceBefore=store.get(f.a.db,f.source.id);
 const receipt=receiveResult(f.a.db,ba.peer,result.body);assert.deepEqual(receiveResult(f.a.db,ba.peer,result.body),receipt);assert.equal(resultState(f.a.db,result.result_id).accepted,false);assert.deepEqual(store.get(f.a.db,f.source.id),sourceBefore);assert.throws(()=>rejectResult(f.a.db,{resultId:result.result_id,decisionId:randomUUID(),expectedSourceVersion:sourceBefore.aggregate_version,note:"cannot rework cancelled work"}),{code:"CANCELLATION_PENDING"});assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"late-result-restart"}).ok,false);
});

test("cancellation closure works with registrar on source in a two-node layout and exposes cancelled history",async()=>{
 const f=fullyBound({localRegistrar:true});stopped(f);closureGrants(f);const url=await network(f.a);
 assert.equal((await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id})).delivery_state,"waiting_peer");assert.equal((await submitCancellationRetirement(f.b.db,{relationId:f.d.relation_id,url,credentialFile:f.br.file})).closure_phase,"retired");assert.equal((await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id,mode:"poll"})).closure_phase,"retired");settlePair(f);
 const view=readFleetTask(f.a.db,f.source.task_uid).evidence.relations;assert.equal(view.modules.binding,"available");assert.equal(view.modules.registration,"available");const edge=view.items.find(r=>r.relation_id===f.d.relation_id);assert.equal(edge.binding_state,"cancelled");assert.equal(edge.registration_state,"cancelled");assert.equal(edge.closed,true);
});


function lostProvider(f){
 const {w,q}=worker(f,{mode:'provider'}),execution={format:'ai-fleet-process/v1',adapter_contract:'lost-observation-fixture/v1',adapter_digest:'1'.repeat(64),runtime:'claude',model:'fixture-model',effort:'low',run_id:w.run_id,agent_instance_id:w.agent_instance_id,principal_id:w.principal_id,command_sha256:'2'.repeat(64),python_sha256:'3'.repeat(64),files_digest:'4'.repeat(64),prompt_sha256:'5'.repeat(64),environment_sha256:'6'.repeat(64),timeout_ms:5000,heartbeat_ms:50,stderr_limit:1024};
 authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate,execution});return {w,q};
}
function attestLost(f,w){const plan=prepareUncertainResolution(f.b.db,w.dispatch_id),attestation={format:'ai-fleet-uncertain-execution-attestation/v1',node_id:plan.node_id,node_epoch:plan.node_epoch,dispatch_id:plan.dispatch_id,run_id:plan.run_id,launch_digest:plan.launch_digest,plan_digest:plan.plan_digest,supervisor_stopped:true,process_tree_stopped:true,remote_session_stopped:true,no_automatic_retry:true,evidence_ref:'fixture:explicit-stopped-provider-tree',attested_at:new Date().toISOString()};return recordUncertainResolution(f.b.db,{plan,expectedPlanDigest:plan.plan_digest,attestation});}

test('operator-attested lost outcome travels through actual HTTP cancellation and registrar retirement with an explicit evidence tier',async()=>{
 const f=fullyBound(),{w,q}=lostProvider(f);received(f);assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,false);const resolution=attestLost(f,w),stopped=progressCancellation(f.b.db,f.d.relation_id).receipt;assert.equal(stopped.schema_version,2);assert.equal(stopped.operator_attested_runs,1);assert.equal(stopped.stop_evidence,'includes_operator_attestation');assert.equal(dispatchStatus(f.b.db,w.dispatch_id).execution.observation,null);assert.equal(resolution.outcome_known,false);
 assert.throws(()=>normalizeCancellationClosure({schema_version:1,kind:'delegation_cancellation',request:cancellationState(f.b.db,f.d.relation_id).request,stopped:null}),{code:'BAD_INPUT'});
 const before=counts(f.a.db);for(const patch of [{operator_attested_runs:2},{stop_evidence:'machine_verified'},{schema_version:1},{operator_attested_runs:0}]){assert.throws(()=>recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:{...stopped,...patch}}));assert.equal(counts(f.a.db),before);}
 const url=await network(f.b),receivedStop=await deliverCancellation(f.a.db,{relationId:f.d.relation_id,mode:'poll',url,credentialFile:f.ab.file});assert.equal(receivedStop.receipt.schema_version,2);assert.equal(receivedStop.stopped,true);closureGrants(f);const registrarURL=await network(f.r),paths=[];
 const oldPeer=await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id,url:registrarURL,credentialFile:f.ar.file,fetchImpl:async(u,o)=>{paths.push(new URL(u).pathname);const response=await fetch(u,o);if(u.endsWith('/hello')){const body=await response.json();body.capabilities=body.capabilities.filter(c=>c!=='delegation-operator-stop-v1');return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});}return response;}});assert.equal(oldPeer.error_code,'REQUIRED_FEATURE_UNSUPPORTED');assert.deepEqual(paths,['/peer/v1/hello']);assert.equal(oldPeer.attempts.length,0);
 assert.equal((await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id,url:registrarURL,credentialFile:f.ar.file})).delivery_state,'waiting_peer');const retired=await submitCancellationRetirement(f.b.db,{relationId:f.d.relation_id,url:registrarURL,credentialFile:f.br.file});assert.equal(retired.retirement.cancellation.stopped.schema_version,2);assert.throws(()=>recordCancellationRetirement(f.a.db,{relationId:f.d.relation_id,receipt:{...retired.retirement,schema_version:2}}),{code:'BAD_CANCELLATION_CLOSURE'});assert.equal((await submitCancellationRetirement(f.a.db,{relationId:f.d.relation_id,mode:'poll',url:registrarURL,credentialFile:f.ar.file})).delivery_state,'acknowledged');settlePair(f);assert.equal(bindingState(f.a.db,f.d.relation_id).state,'cancelled');assert.equal(store.get(f.b.db,f.target.id).human_gate,true);assert.equal(store.get(f.a.db,f.source.id).released,false);assert.equal(quotaStatus(f.b.db,q.quota_id).used,1);assert.equal(graphVersion(f)>1,true);
});

test("downstream operator attestation is propagated upstream and survives bottom-up retirement",()=>{
 const f=fullyBound({withThird:true}),c=f.c,bc=grant(f.b,c),cr=grant(c,f.r,["peer:handshake","relations:read","relations:approve","relations:publish"]),source=store.get(f.b.db,f.target.id);
 const out=createIntent(f.b.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:c.node.node_id,targetEpoch:c.node.sync_epoch});receiveOffer(c.db,bc.peer,out.offer);
 const accepted=decideIncoming(c.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"downstream"});recordReceipt(f.b.db,out.delegation_id,accepted);register(f,c,cr);
 const target=store.get(c.db,c.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id),q={a:f.b,b:c,r:f.r,g:f.g,ab:bc,ar:f.br,br:cr,source,target,out};
 q.d={...f.d,relation_id:randomUUID(),delegation_id:out.delegation_id,source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:source.task_uid,target_node_id:c.node.node_id,target_epoch:c.node.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest};begin(q);finish(q);
 const lost=lostProvider(q);received(f);const waiting=progressCancellation(f.b.db,f.d.relation_id);assert.equal(waiting.receipt.stopped,false);assert.ok(waiting.blockers.some(b=>b.relation_id===q.d.relation_id));
 const childCancel=cancellationState(f.b.db,q.d.relation_id);assert.equal(childCancel.request.reason_code,"upstream_cancelled");receiveCancellation(c.db,bc.peer,childCancel.request);attestLost(q,lost.w);const done=progressCancellation(c.db,q.d.relation_id).receipt;
 recordCancellationReceipt(f.b.db,{relationId:q.d.relation_id,receipt:done});assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.downstream_count,1);const upstream=progressCancellation(f.b.db,f.d.relation_id).receipt;assert.equal(upstream.schema_version,2);assert.equal(upstream.operator_attested_runs,0);assert.equal(upstream.stop_evidence,"includes_operator_attestation");
 closureGrants(f);assert.throws(()=>startCancellationRetirement(f.b.db,{relationId:f.d.relation_id,expectedVersion:graphVersion(f)}),{code:"DOWNSTREAM_PENDING"});
 retirePair(q);settlePair(q);recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt:progressCancellation(f.b.db,f.d.relation_id).receipt});retirePair(f);settlePair(f);
 assert.equal(relationStatus(f.r.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:null}).edges,0);assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"middle-stays-held"}).ok,false);

});
