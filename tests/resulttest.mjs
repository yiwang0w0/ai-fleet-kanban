import {migrateResults,prepareResult,receiveResult,resultState,listResults,recordResultReceipt,rejectResult,recordResultDecision,peerResultStatus} from "../core/federation/results.mjs";
import {deliverResult} from "../core/federation/result-client.mjs";
import {migrateCancellations,listCancellations,prepareCancellation,receiveCancellation,cancellationState,recordCancellationReceipt,confirmCancellationStopped,cancellationWork} from "../core/federation/cancellation.mjs";
import {progressCancellation} from "../core/federation/cancellation-service.mjs";
import {deliverCancellation} from "../core/federation/cancellation-client.mjs";
import {migrateDispatch,putQuota,prepareDispatch,authorizeLaunch,finishDispatch,dispatchStatus,quotaStatus} from "../core/execution/dispatch.mjs";
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
import {migratePeers,issueCredential,authenticate,localIdentity,revokePeer} from "../core/federation/peers.mjs";
import {digest,canonical} from "../core/federation/sync-store.mjs";
import {enrollTask,callTool} from "../core/mcp/tools.mjs";
import {createIntent,receiveOffer,decideIncoming,recordReceipt,incomingStatus,outgoingStatus} from "../core/federation/delegation.mjs";
import {migrateRelations,createRelationGraph,publishTopology,approveRelation,withdrawRelation,relationStatus} from "../core/federation/relations.mjs";
import {bindTopology,prepareTopology,startTopologyAttempt,acceptTopologyReceipt,topologyState} from "../core/federation/topology.mjs";
import {migrateBindings,prepareBinding,bindingState,bindingMessage,receiveBindingMessage,recordBindingMessage,startBindingAttempt,acceptBindingReceipt,cancelUnsentBinding,listBindings,releaseBoundTask,bindingProposalState,declineBindingProposal} from "../core/federation/bindings.mjs";
import {submitBinding,sendBindingMessage} from "../core/federation/binding-client.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-result-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}rmSync(TMP,{recursive:true,force:true});});
function node(){const dir=join(TMP,"n"+serial++);mkdirSync(dir);const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateBindings(db);migrateResults(db);migrateRelations(db);return {db,dir,path,node:localIdentity(db)};}
function grant(a,b,scopes=["peer:handshake","delegation:offer","delegation:status","delegation:binding","delegation:control","delegation:result"],projects=["demo"]){const file=join(TMP,"grant"+serial+++".json");issueCredential(b.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes,projects,credentialFile:file,expectedVersion:b.db.prepare("SELECT credential_version FROM federation_peers WHERE peer_node_id=?").get(a.node.node_id)?.credential_version});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(b.db,"Bearer "+c.token)};}
function card(f,extra={}){const id=store.add(f.db,{subject:"work "+serial++,description:"requested work",acceptance:"review evidence",treeMode:"hierarchical",route:"mcp",released:1,...extra}),t=store.get(f.db,id);enrollTask(f.db,{id,projectId:"demo",workKind:"implement",capabilities:["board-tools"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
function register(f,owner,g){bindTopology(owner.db,{projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,registrarNodeId:f.r.node.node_id,registrarEpoch:f.r.node.sync_epoch});const op=prepareTopology(owner.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:0}),args=startTopologyAttempt(owner.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.r.db,g.peer,args);acceptTopologyReceipt(owner.db,{operationId:op.operation_id,requestId:args.request_id,receipt});}
function fixture({withThird=false}={}){
 const a=node(),b=node(),r=node(),source=card(a),ab=grant(a,b),ar=grant(a,r,["peer:handshake","relations:read","relations:approve","relations:publish"]),br=grant(b,r,["peer:handshake","relations:read","relations:approve","relations:publish"]);
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

function principal(n,kind="coordinate",projects=["demo"]){
 const id="p"+serial++,file=join(TMP,id+".json");putRole(n.db,{role_id:id,kind,projects,capabilities:[],runtime:null,model:null,effort:null,tools:kind==="observe"?"read-only":"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300}});issuePrincipal(n.db,{roleId:id,projects,credentialFile:file});return "Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
}
function publishLocal(f,owner,credential,edits=[]){
 const before=topologyState(owner.db,"demo"),op=prepareTopology(owner.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:before.revision,edits}),args=startTopologyAttempt(owner.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.r.db,credential.peer,args);acceptTopologyReceipt(owner.db,{operationId:op.operation_id,requestId:args.request_id,receipt});return op;
}

function completed(f,{mode="fixture",task=f.target,status="success"}={}){
 const w=worker(f,{mode,task});authorizeLaunch(f.b.db,{dispatchId:w.w.dispatch_id,sourceGate});
 finishDispatch(f.b.db,{dispatchId:w.w.dispatch_id,result:{status,evidence:"synthetic result; no actual artifact or provider acceptance",usage:null}});return w;
}
function candidate(f){return prepareResult(f.b.db,{relationId:f.d.relation_id,resultId:randomUUID(),expectedTaskVersion:store.get(f.b.db,f.target.id).aggregate_version});}
function receive(f,r){const ba=grant(f.b,f.a,["peer:handshake","delegation:result"]),ack=receiveResult(f.a.db,ba.peer,r.body);recordResultReceipt(f.b.db,{resultId:r.result_id,receipt:ack});return ba;}
function reject(f,r,note="Please supply the missing test evidence"){return rejectResult(f.a.db,{resultId:r.result_id,decisionId:randomUUID(),expectedSourceVersion:store.get(f.a.db,f.source.id).aggregate_version,note});}
const rows=db=>JSON.stringify(Object.fromEntries(["delegation_results","result_members","result_receipts","result_decisions","result_events","result_recovery_permits","tasks","task_events"].map(t=>[t,db.prepare("SELECT * FROM "+t+" ORDER BY rowid").all()])));
test("candidate exports the exact observed run without fabricating a source run or accepting work",()=>{
 const f=fullyBound(),{w}=completed(f),r=candidate(f);assert.equal(r.body.execution.run_id,w.run_id);assert.equal(r.body.execution.agent_instance_id,w.agent_instance_id);assert.equal(r.body.scope.fixture_runs,1);
 assert.equal(r.body.execution.execution_mode,"fixture");assert.equal(r.accepted,false);assert.equal(r.body.process_result.status,"success");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
 assert.throws(()=>f.b.db.prepare("UPDATE tasks SET result='changed' WHERE id=?").run(f.target.id),/RESULT_PENDING/);
 assert.throws(()=>store.resolve(f.b.db,{id:f.target.id,verdict:"approve",note:""}),/RESULT_PENDING/);
 const before=store.get(f.a.db,f.source.id);receive(f,r);assert.equal(resultState(f.a.db,r.result_id).review_state,"pending_evidence");assert.deepEqual(store.get(f.a.db,f.source.id),before);assert.equal(f.a.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);
 assert.equal(resultState(f.b.db,r.result_id).state,"delivered");assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"not-accepted"}).ok,false);
});
test("reporting a task or forging a provider-mode dispatch without observation cannot create a candidate",()=>{
 const f=fullyBound(),{w}=worker(f);authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate});
 store.report(f.b.db,{id:f.target.id,worker:w.worker,runId:w.run_id,outcome:"done",evidence:"reported before process exit"});
 assert.throws(()=>candidate(f),{code:"STOP_UNCONFIRMED"});assert.equal(f.b.db.prepare("SELECT count(*) n FROM delegation_results").get().n,0);
 finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:"success",evidence:"process ended",usage:null}});
 assert.throws(()=>prepareResult(f.b.db,{resultId:randomUUID(),relationId:f.d.relation_id,expectedTaskVersion:999}),{code:"CONFLICT"});candidate(f);
 const g=fullyBound();completed(g,{mode:"provider"});assert.throws(()=>candidate(g),{code:"STOP_UNCONFIRMED"});
});
test("source rejects unauthorized, altered-contract, invalid-digest and out-of-sequence results without partial rows",()=>{
 const f=fullyBound();completed(f);const r=candidate(f),ba=grant(f.b,f.a,["peer:handshake","delegation:result"]),before=rows(f.a.db);
 for(const p of [{...ba.peer,projects:["other"]},{...ba.peer,scopes:[]},{...ba.peer,credential_version:99}])assert.throws(()=>receiveResult(f.a.db,p,r.body),{code:"FORBIDDEN"});
 assert.throws(()=>receiveResult(f.a.db,ba.peer,{...r.body,process_result:{...r.body.process_result,evidence:"changed"}}),{code:"BAD_INPUT"});
 assert.throws(()=>receiveResult(f.a.db,ba.peer,{...r.body,relation:{...r.body.relation,offer_digest:"0".repeat(64)}}),{code:"CONTRACT_MISMATCH"});
 assert.throws(()=>receiveResult(f.a.db,ba.peer,{...r.body,sequence:2}),{code:"SEQUENCE_CONFLICT"});assert.equal(rows(f.a.db),before);
 const ack=receiveResult(f.a.db,ba.peer,r.body);assert.deepEqual(receiveResult(f.a.db,ba.peer,r.body),ack);
 assert.throws(()=>receiveResult(f.a.db,ba.peer,{...r.body,report:"rewritten report"}),{code:"REQUEST_CONFLICT"});
});
test("owner rejection is durable, releases only matching target work for rework, and preserves every old candidate",()=>{
 const f=fullyBound();completed(f);const r=candidate(f);receive(f,r);
 const decision=reject(f,r).decision;assert.equal(store.get(f.b.db,f.target.id).status,"waiting");
 assert.throws(()=>recordResultDecision(f.b.db,{resultId:r.result_id,decision:{...decision,body_digest:"0".repeat(64)}}),{code:"RECEIPT_MISMATCH"});
 recordResultDecision(f.b.db,{resultId:r.result_id,decision});const after=rows(f.b.db);
 assert.equal(store.get(f.b.db,f.target.id).status,"not_started");assert.ok(store.get(f.b.db,f.target.id).verdict_note.includes(decision.note));assert.equal(store.get(f.a.db,f.source.id).status,"not_started");
 recordResultDecision(f.b.db,{resultId:r.result_id,decision});assert.equal(rows(f.b.db),after);
 completed(f);const newer=candidate(f);assert.equal(newer.sequence,2);assert.notEqual(newer.body.execution.run_id,r.body.execution.run_id);receive(f,newer);
 assert.equal(resultState(f.b.db,r.result_id).state,"rejected");assert.equal(resultState(f.a.db,newer.result_id).state,"received");assert.equal(listResults(f.b.db,{projectId:"demo"}).results.length,2);
});
test("a late candidate is retained after source cancellation but cannot trigger rework",()=>{
 const f=fullyBound();completed(f);const r=candidate(f),c=cancel(f);receive(f,r);
 assert.equal(resultState(f.a.db,r.result_id).review_state,"cancel_pending");assert.throws(()=>reject(f,r),{code:"CANCELLATION_PENDING"});
 receiveCancellation(f.b.db,f.ab.peer,c.request);assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);
 assert.equal(store.get(f.b.db,f.target.id).status,"waiting");assert.equal(resultState(f.a.db,r.result_id).accepted,false);
});
test("a previously valid rejection arriving after target cancellation records history without restarting work",()=>{
 const f=fullyBound();completed(f);const r=candidate(f);receive(f,r);const decision=reject(f,r).decision;
 const c=cancel(f);receiveCancellation(f.b.db,f.ab.peer,c.request);recordResultDecision(f.b.db,{resultId:r.result_id,decision});
 assert.equal(store.get(f.b.db,f.target.id).status,"waiting");assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"cancelled-rework"}).ok,false);
 assert.equal(progressCancellation(f.b.db,f.d.relation_id).receipt.stopped,true);assert.equal(resultState(f.b.db,r.result_id).state,"rejected");
});
test("candidate seals completed local children; active child work and topology transitions must settle first",()=>{
 const f=fullyBound();completed(f);const child=card(f.b);publishLocal(f,f.b,f.br,[{task_uid:child.task_uid,expected_version:child.aggregate_version,parent_uid:f.target.task_uid,blocked_by:[]}]);
 assert.throws(()=>candidate(f),{code:"CHILDREN_PENDING"});completed(f,{task:child});store.resolve(f.b.db,{id:child.id,verdict:"approve",note:""});
 const r=candidate(f);assert.equal(r.body.scope.member_count,2);assert.equal(r.body.scope.run_count,2);assert.equal(r.body.scope.fixture_runs,2);
 assert.throws(()=>f.b.db.prepare("UPDATE tasks SET description='changed' WHERE id=?").run(child.id),/RESULT_PENDING/);
 assert.throws(()=>prepareTopology(f.b.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:topologyState(f.b.db,"demo").revision,edits:[{task_uid:child.task_uid,expected_version:store.get(f.b.db,child.id).aggregate_version,parent_uid:null,blocked_by:[]}]}),/RESULT_PENDING/);
 receive(f,r);recordResultDecision(f.b.db,{resultId:r.result_id,decision:reject(f,r).decision});assert.equal(store.get(f.b.db,child.id).status,"done");
});
test("MCP candidate publication and rejection enforce project/role scope and roll back with their response",()=>{
 const f=fullyBound();completed(f);const auth=principal(f.b),observe=principal(f.b,"observe"),foreign=principal(f.b,"coordinate",["secret"]),args={request_id:randomUUID(),relation_id:f.d.relation_id,expected_version:store.get(f.b.db,f.target.id).aggregate_version};
 assert.throws(()=>callTool(f.b.db,observe,"prepare_result",args),{code:"FORBIDDEN"});assert.throws(()=>callTool(f.b.db,foreign,"prepare_result",args),{code:"NOT_FOUND"});
 let before=rows(f.b.db);f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'candidate response fault'); END");
 assert.throws(()=>callTool(f.b.db,auth,"prepare_result",args),/candidate response fault/);assert.equal(rows(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");
 const r=callTool(f.b.db,auth,"prepare_result",args);assert.deepEqual(callTool(f.b.db,auth,"prepare_result",args),r);receive(f,r);
 const source=principal(f.a),other=principal(f.a,"coordinate",["secret"]),reader=principal(f.a,"observe"),decision={request_id:randomUUID(),result_id:r.result_id,expected_version:store.get(f.a.db,f.source.id).aggregate_version,note:"missing work"};
 assert.throws(()=>callTool(f.a.db,reader,"reject_result",decision),{code:"FORBIDDEN"});assert.throws(()=>callTool(f.a.db,other,"get_result",{result_id:r.result_id}),{code:"NOT_FOUND"});
 before=rows(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'rejection response fault'); END");
 assert.throws(()=>callTool(f.a.db,source,"reject_result",decision),/rejection response fault/);assert.equal(rows(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");
 assert.equal(callTool(f.a.db,source,"reject_result",decision).state,"rejected");assert.equal(callTool(f.a.db,reader,"list_results",{project_id:"demo",limit:10}).results.length,1);
});
test("rework persistence failure rolls back owner receipt and native resolution together",()=>{
 const f=fullyBound();completed(f);const r=candidate(f);receive(f,r);const decision=reject(f,r).decision,before=rows(f.b.db);
 for(const table of ["task_events","result_events"]){
  f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'rework persistence fault'); END");
  assert.throws(()=>recordResultDecision(f.b.db,{resultId:r.result_id,decision}),/rework persistence fault/);assert.equal(rows(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");
 }
 recordResultDecision(f.b.db,{resultId:r.result_id,decision});assert.equal(store.get(f.b.db,f.target.id).status,"not_started");
});
test("actual HTTP lost result and rejection responses replay without duplicate source runs or rework",async()=>{
 const f=fullyBound();completed(f);const r=candidate(f),ba=grant(f.b,f.a,["peer:handshake","delegation:result"]),url=await network(f.a);let lost=true;
 const first=await deliverResult(f.b.db,{resultId:r.result_id,url,credentialFile:ba.file,fetchImpl:async(u,o)=>{const response=await fetch(u,o);if(u.endsWith("/result")&&lost){lost=false;await response.arrayBuffer();throw Error("lost result ACK");}return response;}});
 assert.equal(first.delivery_state,"retry_pending");assert.equal(first.state,"prepared");assert.equal(resultState(f.a.db,r.result_id).state,"received");
 assert.equal((await deliverResult(f.b.db,{resultId:r.result_id,url,credentialFile:ba.file})).state,"delivered");reject(f,r);
 f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON result_events BEGIN SELECT RAISE(ABORT,'local rejection write fault'); END");
 const failed=await deliverResult(f.b.db,{resultId:r.result_id,mode:"poll",url,credentialFile:ba.file});assert.equal(failed.delivery_state,"retry_pending");assert.equal(store.get(f.b.db,f.target.id).status,"waiting");f.b.db.exec("DROP TRIGGER injected");
 const done=await deliverResult(f.b.db,{resultId:r.result_id,mode:"poll",url,credentialFile:ba.file});assert.equal(done.state,"rejected");
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);assert.equal(f.b.db.prepare("SELECT count(*) n FROM task_events WHERE task_id=? AND kind='resolve'").get(f.target.id).n,1);
});
test("actual backup activation quarantines candidate identity while retaining frozen execution scope",()=>{
 const f=fullyBound();completed(f);const r=candidate(f),evidence=join(f.b.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic result evidence");
 const backup=createBackup({dbPath:f.b.path,evidenceDir:evidence,destination:join(TMP,"result-backup"+serial++)}),dir=join(TMP,"result-restore"+serial++);restoreBackup({backupDirectory:backup.destination,destination:dir});
 const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);assert.throws(()=>resultState(db,r.result_id),{code:"RESTORE_HOLD"});
 retireNode({dbPath:f.b.path,expectedEpoch:f.b.node.sync_epoch});const plan=prepareRecovery({dbPath:path});
 activateRecovery({dbPath:path,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated result fixture",attested_at:new Date().toISOString()}});
 assert.throws(()=>resultState(db,r.result_id),{code:"RESULT_RECOVERY_REQUIRED"});assert.equal(listResults(db,{projectId:"demo"}).results[0].identity_current,0);
 assert.equal(store.claimById(db,{id:f.target.id,worker:"old-candidate"}).ok,false);assert.equal(db.prepare("SELECT count(*) n FROM result_recovery_permits").get().n,0);
});

test("locally reviewed completion remains an unaccepted source candidate and can be reopened by owner rejection",()=>{
 const f=fullyBound();completed(f);store.resolve(f.b.db,{id:f.target.id,verdict:"approve",note:""});
 const r=candidate(f);assert.equal(r.body.target_status,"done");receive(f,r);assert.equal(resultState(f.a.db,r.result_id).accepted,false);
 recordResultDecision(f.b.db,{resultId:r.result_id,decision:reject(f,r).decision});assert.equal(store.get(f.b.db,f.target.id).status,"not_started");
 const last=f.b.db.prepare("SELECT detail FROM task_events WHERE task_id=? AND kind='resolve' ORDER BY id DESC LIMIT 1").get(f.target.id);
 assert.equal(JSON.parse(last.detail).from_status,"done");
});
test("rejected execution identity cannot be relabelled as a fresh candidate locally or over the wire",()=>{
 const f=fullyBound();completed(f);const r=candidate(f);const ba=receive(f,r);recordResultDecision(f.b.db,{resultId:r.result_id,decision:reject(f,r).decision});
 f.b.db.prepare("UPDATE tasks SET status='waiting',waiting_for='review' WHERE id=?").run(f.target.id);
 assert.throws(()=>candidate(f),{code:"RESULT_RUN_REUSED"});
 assert.throws(()=>receiveResult(f.a.db,ba.peer,{...r.body,result_id:randomUUID(),sequence:2}),{code:"RESULT_RUN_REUSED"});
});
test("sealing a candidate races safely with an independent native review process",async()=>{
 const f=fullyBound();completed(f);const version=store.get(f.b.db,f.target.id).aggregate_version,script=join(TMP,"result-race"+serial+++".mjs"),file=join(TMP,"result-race"+serial+++".json");
 writeFileSync(file,JSON.stringify({resultId:randomUUID(),relationId:f.d.relation_id,expectedTaskVersion:version,taskId:f.target.id}));
 writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite"; import {readFileSync} from "node:fs"; import {createRequire} from "node:module"; import {fileURLToPath} from "node:url";',
  'import {prepareResult} from '+JSON.stringify(new URL("../core/federation/results.mjs",import.meta.url).href)+';',
  'const store=createRequire(import.meta.url)(fileURLToPath('+JSON.stringify(new URL("../core/store.js",import.meta.url).href)+'));',
  'const [path,file,action]=process.argv.slice(2),db=new DatabaseSync(path),x=JSON.parse(readFileSync(file,"utf8"));db.exec("PRAGMA busy_timeout=5000");',
  'process.send("ready");process.once("message",()=>{let r;try{r=action==="seal"?prepareResult(db,x):store.resolve(db,{id:x.taskId,verdict:"approve",note:"",expectedVersion:x.expectedTaskVersion});}catch(e){r={error:e.code,message:e.message};}db.close();process.stdout.write(JSON.stringify(r));process.disconnect();});'
 ].join("\n"));
 const children=["seal","review"].map(action=>{const p=spawn(process.execPath,[script,f.b.path,file,action],{stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);return {p,ready:new Promise((resolve,reject)=>{p.once("message",resolve);p.once("error",reject);p.once("exit",code=>{if(code!==0)reject(Error("startup "+code+" "+err));});}),done:new Promise((resolve,reject)=>{p.once("error",reject);p.once("close",code=>{if(code!==0)return reject(Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});})};});
 await Promise.all(children.map(c=>c.ready));for(const c of children)c.p.send("go");const [sealed,reviewed]=await Promise.all(children.map(c=>c.done));
 assert.equal(Number(sealed.state==="prepared")+Number(reviewed.status==="done"),1);
 if(sealed.state==="prepared")assert.match(reviewed.message,/RESULT_PENDING/);else assert.equal(sealed.error,"CONFLICT");
});
function resultCLI(command,...args){return spawnSync(process.execPath,[join(ROOT,"cli/result.mjs"),command,...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});}
function resultCLIAsync(command,...args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[join(ROOT,"cli/result.mjs"),command,...args],{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);p.once("error",reject);p.once("close",status=>resolve({status,stdout:out,stderr:err}));});}
test("explicit-database CLI completes candidate publication, source rejection and matching native rework",async()=>{
 const f=fullyBound();completed(f);const id=randomUUID(),ba=grant(f.b,f.a,["peer:handshake","delegation:result"]),url=await network(f.a);
 assert.notEqual(resultCLI("get","--result",id).status,0);
 const prepared=resultCLI("prepare","--db",f.b.path,"--relation",f.d.relation_id,"--id",id,"--version",String(store.get(f.b.db,f.target.id).aggregate_version));assert.equal(prepared.status,0,prepared.stderr);
 const args=["--db",f.b.path,"--result",id,"--url",url,"--credential",ba.file],sent=await resultCLIAsync("send",...args);assert.equal(sent.status,0,sent.stderr);assert.equal(JSON.parse(sent.stdout).state,"delivered");
 assert.equal(resultCLI("get","--db",f.a.path,"--result",id).status,0);assert.equal(resultCLI("list","--db",f.a.path,"--project","demo").status,0);
 const decision=resultCLI("reject","--db",f.a.path,"--result",id,"--decision",randomUUID(),"--version",String(store.get(f.a.db,f.source.id).aggregate_version),"--note","supply the missing artifact");assert.equal(decision.status,0,decision.stderr);
 const polled=await resultCLIAsync("poll",...args);assert.equal(polled.status,0,polled.stderr);assert.equal(JSON.parse(polled.stdout).state,"rejected");assert.equal(store.get(f.b.db,f.target.id).status,"not_started");
});

test("candidate publication requires actual provider process cleanup, not a provider label on a fixture receipt",async()=>{
 const f=fullyBound(),{w}=worker(f,{mode:"provider"}),script=join(TMP,"result-provider-fixture"+serial+++".mjs");
 writeFileSync(script,[
  'const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");',
  'emit({type:"system",subtype:"init",session_id:"result-fixture",model:"fixture-model"});',
  'emit({type:"result",subtype:"success",is_error:false,session_id:"result-fixture",result:"synthetic observed output",usage:{input_tokens:0,output_tokens:0}});'
 ].join("\n"));
 const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys; print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim()),command=pinFile(process.execPath),file=pinFile(script);
 const execution={format:"ai-fleet-process/v1",adapter_contract:"result-fixture/v1",adapter_digest:"1".repeat(64),runtime:"claude",model:"fixture-model",effort:"low",run_id:w.run_id,agent_instance_id:w.agent_instance_id,principal_id:w.principal_id,command_sha256:command.sha256,python_sha256:python.sha256,files_digest:digest([file]),prompt_sha256:"2".repeat(64),environment_sha256:"3".repeat(64),timeout_ms:10000,heartbeat_ms:50,stderr_limit:1024};
 authorizeLaunch(f.b.db,{dispatchId:w.dispatch_id,sourceGate,execution});
 const out=await superviseProcess({python,command,args:[script],cwd:TMP,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),input:"fixture",pins:[file],runtime:"claude",timeoutMs:10000,heartbeatMs:50,stderrLimit:1024});
 assert.equal(out.status,"success",JSON.stringify(out));assert.equal(out.real_model_call_confirmed,false);
 finishDispatch(f.b.db,{dispatchId:w.dispatch_id,result:{status:out.status,evidence:out.evidence,usage:out.usage},observation:out});
 if(process.platform!=="win32"){assert.throws(()=>candidate(f),{code:"STOP_UNCONFIRMED"});return;}
 const r=candidate(f);assert.equal(r.body.execution.observation_digest,digest(out));assert.equal(r.body.execution.quiescence,"windows_job_empty");assert.equal(r.body.scope.fixture_runs,0);
 receive(f,r);assert.equal(resultState(f.a.db,r.result_id).accepted,false);assert.equal(dispatchStatus(f.b.db,w.dispatch_id).real_model_call_confirmed,false);
});
test("restart migrations retain candidate bytes, seals and append-only audit",()=>{
 const f=fullyBound();completed(f);const r=candidate(f),before=rows(f.b.db),db=new DatabaseSync(f.b.path);
 try{
  store.migrate(db);migrateResults(db);migrateResults(db);assert.equal(rows(db),before);
  assert.equal(resultState(db,r.result_id).body_digest,r.body_digest);assert.equal(store.pendingReview(db).some(t=>t.id===f.target.id),false);
  receive(f,r);recordResultDecision(f.b.db,{resultId:r.result_id,decision:reject(f,r).decision});
  for(const table of ["delegation_results","result_members","result_receipts","result_decisions","result_events"]){
   assert.throws(()=>db.exec("DELETE FROM "+table),/result history must be retained/);
  }
 }finally{db.close();}
});
test("source rechecks target credentials after an actual result body upload before persisting candidate data",async()=>{
 const f=fullyBound();completed(f);const r=candidate(f),ba=grant(f.b,f.a,["peer:handshake","delegation:result"]),body=JSON.stringify(r.body),url=await network(f.a),server=servers.at(-1),before=rows(f.a.db);let notify;
 const uploading=new Promise(resolve=>notify=resolve);server.once("request",()=>notify());
 const response=new Promise((resolve,reject)=>{const req=http.request(url+"/peer/v1/delegation/result",{method:"POST",headers:{Authorization:ba.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);const split=Math.floor(body.length/2);req.write(body.slice(0,split));uploading.then(()=>{revokePeer(f.a.db,{peerNodeId:f.b.node.node_id,expectedVersion:1});req.end(body.slice(split));}).catch(reject);});
 assert.ok((await response)>=400);assert.equal(rows(f.a.db),before);
});
