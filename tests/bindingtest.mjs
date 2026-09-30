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
const TMP=mkdtempSync(join(tmpdir(),"fleet-binding-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}rmSync(TMP,{recursive:true,force:true});});
function node(){const dir=join(TMP,"n"+serial++);mkdirSync(dir);const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateBindings(db);migrateRelations(db);return {db,dir,path,node:localIdentity(db)};}
function grant(a,b,scopes=["peer:handshake","delegation:offer","delegation:status","delegation:binding"],projects=["demo"]){const file=join(TMP,"grant"+serial+++".json");issueCredential(b.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes,projects,credentialFile:file,expectedVersion:b.db.prepare("SELECT credential_version FROM federation_peers WHERE peer_node_id=?").get(a.node.node_id)?.credential_version});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(b.db,"Bearer "+c.token)};}
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
const state=db=>JSON.stringify(Object.fromEntries(["tasks","task_events","delegation_bindings","binding_attempts","binding_proposals","binding_proposal_decisions","binding_inbox","binding_source_commits","binding_events"].map(n=>[n,db.prepare("SELECT * FROM "+n+" ORDER BY rowid").all()])));
async function network(n){const s=await listenPeerServer(n.db,{port:0});servers.push(s);return "http://127.0.0.1:"+s.address().port;}

test("both verified endpoint commitments permit an explicitly released target while holding its source",()=>{
 const f=fixture();begin(f);
 assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
 assert.throws(()=>store.setReleased(f.b.db,{id:f.target.id,released:true}),/DELEGATION_UNCONFIRMED/);
 finish(f);assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,true);assert.equal(store.get(f.b.db,f.target.id).released,false);
 store.setReleased(f.b.db,{id:f.target.id,released:true});assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"target"}).ok,true);
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"source"}).ok,false);
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(f.source.id),/BINDING_PENDING/);
});
test("a supplied confirmed graph receipt and source message cannot replace the target's independent registrar commitment",()=>{
 const f=fixture();begin(f);const args=startBindingAttempt(f.b.db,{relationId:f.d.relation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),r=approveRelation(f.r.db,f.br.peer,args);
 acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});send(f,"source_ready");
 assert.equal(bindingState(f.b.db,f.d.relation_id).state,"prepared");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
 assert.throws(()=>store.setReleased(f.b.db,{id:f.target.id,released:true}),/DELEGATION_UNCONFIRMED/);
 acceptBindingReceipt(f.b.db,{relationId:f.d.relation_id,requestId:args.request_id,receipt:r});assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,true);
});
test("a target's confirmed graph alone does not authorize execution without the source's durable ready message",()=>{
 const f=fixture();begin(f);approve(f,"b");assert.equal(bindingState(f.b.db,f.d.relation_id).state,"confirmed");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
 assert.throws(()=>store.setReleased(f.b.db,{id:f.target.id,released:true}),/DELEGATION_UNCONFIRMED/);
});
test("preparation checks accepted contracts, task CAS, current registered revisions, and actual endpoints",()=>{
 const f=fixture(),before=state(f.a.db);
 assert.throws(()=>prepareBinding(f.a.db,{relation:f.d,expectedTaskVersion:999}),{code:"CONFLICT"});
 assert.throws(()=>prepareBinding(f.a.db,{relation:{...f.d,source_topology_revision:2},expectedTaskVersion:f.source.aggregate_version}),{code:"TOPOLOGY_PENDING"});
 assert.throws(()=>prepareBinding(f.a.db,{relation:{...f.d,offer_digest:"0".repeat(64)},expectedTaskVersion:f.source.aggregate_version}),{code:"CONTRACT_MISMATCH"});
 assert.throws(()=>prepare(f,"b"),{code:"PROPOSAL_REQUIRED"});assert.equal(state(f.a.db),before);
 store.update(f.a.db,{id:f.source.id,description:"changed scope"});assert.throws(()=>prepare(f,"a"),{code:"CONTRACT_CHANGED"});
});
test("binding refuses existing local runs and does not silently duplicate already executing work",()=>{
 const f=fixture();assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"local"}).ok,true);assert.throws(()=>prepare(f,"a"),{code:"ACTIVE_WORK"});assert.equal(f.a.db.prepare("SELECT count(*) n FROM delegation_bindings").get().n,0);
});
test("bound contracts remain fixed and topology changes wait only until registrar confirmation",()=>{
 const f=fixture();begin(f);
 for(const x of [{subject:"changed"},{description:"changed"},{acceptance:"changed"},{route:"main"}])assert.throws(()=>store.update(f.a.db,{id:f.source.id,...x}),/BINDING_CONTRACT/);
 assert.throws(()=>store.archive(f.a.db,{id:f.source.id}),/BINDING_CONTRACT/);
 assert.throws(()=>prepareTopology(f.a.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:1}),/BINDING_PENDING/);
 finish(f);assert.equal(prepareTopology(f.a.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:1}).state,"prepared");
});
test("unauthorized, rotated and other-project peers cannot commit a target readiness message",()=>{
 const f=fixture();begin(f);approve(f,"b");const r=relationStatus(f.r.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:f.d.relation_id});acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});
 const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready"}),before=state(f.b.db);
 for(const peer of [{...f.ab.peer,projects:["other"]},{...f.ab.peer,scopes:[]},{...f.ab.peer,peer_epoch:randomUUID()},{...f.ab.peer,credential_version:999}])assert.throws(()=>receiveBindingMessage(f.b.db,peer,body),{code:"SOURCE_REVOKED"});
 assert.equal(state(f.b.db),before);revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,body),{code:"SOURCE_REVOKED"});
});
test("credential rotation stops new target claims until the same immutable ready message is authenticated again",()=>{
 const f=fixture();begin(f);finish(f);const fresh=grant(f.a,f.b);
 assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
 const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready"});receiveBindingMessage(f.b.db,fresh.peer,body);assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,true);
 assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_source_commits").get().n,2);assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_inbox").get().n,2);
});
test("already claimed target work can still heartbeat and report when source credentials are revoked",()=>{
 const f=fixture();begin(f);finish(f);store.setReleased(f.b.db,{id:f.target.id,released:true});const c=store.claimById(f.b.db,{id:f.target.id,worker:"target"});assert.equal(c.ok,true);
 revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
 store.heartbeat(f.b.db,{id:f.target.id,worker:"target",runId:c.task.run_id});
 store.report(f.b.db,{id:f.target.id,worker:"target",runId:c.task.run_id,outcome:"done",evidence:"completed original run offline"});
 assert.equal(store.get(f.b.db,f.target.id).status,"waiting");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
});
test("request IDs, relation IDs and both authenticated approvals are immutable",()=>{
 const f=fixture();begin(f);const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal"}),before=state(f.b.db);
 assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,{...body,relation:{...body.relation,source_topology_revision:2}}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>prepareBinding(f.a.db,{relation:{...f.d,target_topology_revision:2},expectedTaskVersion:f.source.aggregate_version}),{code:"REQUEST_CONFLICT"});assert.equal(state(f.b.db),before);
 const a=startBindingAttempt(f.b.db,{relationId:f.d.relation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),r=approveRelation(f.r.db,f.br.peer,a);
 for(const forged of [{...r,registrar_epoch:randomUUID()},{...r,approved_by:[r.approved_by[0],r.approved_by[0]]},{...r,descriptor_digest:"0".repeat(64)}])assert.throws(()=>acceptBindingReceipt(f.b.db,{relationId:f.d.relation_id,requestId:a.request_id,receipt:forged}),{code:"RECEIPT_MISMATCH"});
 assert.equal(bindingState(f.b.db,f.d.relation_id).state,"prepared");
});
test("preparation, confirmation and readiness roll back together with their required audit records",()=>{
 const f=fixture();let before=state(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON binding_events BEGIN SELECT RAISE(ABORT,'injected binding audit'); END");
 assert.throws(()=>prepare(f,"a"),/injected binding audit/);assert.equal(state(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");begin(f);approve(f,"b");
 const r=relationStatus(f.r.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:f.d.relation_id});before=state(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON binding_events BEGIN SELECT RAISE(ABORT,'injected binding audit'); END");
 assert.throws(()=>acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r}),/injected binding audit/);assert.equal(state(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});
 const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready"});before=state(f.b.db);f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON binding_events BEGIN SELECT RAISE(ABORT,'injected binding audit'); END");
 assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,body),/injected binding audit/);assert.equal(state(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");receiveBindingMessage(f.b.db,f.ab.peer,body);assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,true);
});
test("untransmitted source binding cancels offline, while a transmitted approval requires confirmed registrar withdrawal",()=>{
 const f=fixture();prepare(f,"a");assert.equal(cancelUnsentBinding(f.a.db,f.d.relation_id).state,"cancelled");assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"restored"}).ok,true);
 const q=fixture();begin(q);assert.throws(()=>cancelUnsentBinding(q.a.db,q.d.relation_id),{code:"UNKNOWN_REMOTE_OUTCOME"});
 const args=startBindingAttempt(q.a.db,{relationId:q.d.relation_id,action:"withdraw"}),r=withdrawRelation(q.r.db,q.ar.peer,args);acceptBindingReceipt(q.a.db,{relationId:q.d.relation_id,requestId:args.request_id,receipt:r});
 assert.equal(bindingState(q.a.db,q.d.relation_id).state,"cancelled");assert.equal(store.claimById(q.a.db,{id:q.source.id,worker:"restored"}).ok,true);
 const status=relationStatus(q.r.db,q.br.peer,{project_id:"demo",graph_id:q.g.graph_id,graph_epoch:q.g.graph_epoch,relation_id:q.d.relation_id});acceptBindingReceipt(q.b.db,{relationId:q.d.relation_id,receipt:status});assert.equal(bindingState(q.b.db,q.d.relation_id).state,"cancelled");
});
test("real HTTP clients recover lost approval and source-ready responses without duplicate graphs or target commitments",async()=>{
 const f=fixture(),rurl=await network(f.r),burl=await network(f.b);prepare(f,"a");let lost=false;
 const first=await submitBinding(f.a.db,{relationId:f.d.relation_id,url:rurl,credentialFile:f.ar.file,fetchImpl:async(url,opts)=>{const r=await fetch(url,opts);if(url.endsWith("/approve")&&!lost){lost=true;await r.arrayBuffer();throw Error("lost ACK");}return r;}});
 assert.equal(first.delivery_state,"retry_pending");const requestId=first.attempts[0].request_id;
 const retry=await submitBinding(f.a.db,{relationId:f.d.relation_id,url:rurl,credentialFile:f.ar.file});assert.equal(retry.delivery_state,"acknowledged");assert.equal(retry.attempts[0].request_id,requestId);
 await sendBindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal",url:burl,credentialFile:f.ab.file});prepare(f,"b");
 assert.equal((await submitBinding(f.b.db,{relationId:f.d.relation_id,url:rurl,credentialFile:f.br.file})).state,"confirmed");
 assert.equal((await submitBinding(f.a.db,{relationId:f.d.relation_id,mode:"poll",url:rurl,credentialFile:f.ar.file})).state,"confirmed");
 lost=false;const ready=await sendBindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready",url:burl,credentialFile:f.ab.file,fetchImpl:async(url,opts)=>{const r=await fetch(url,opts);if(url.endsWith("/binding")&&!lost){lost=true;await r.arrayBuffer();throw Error("lost ready ACK");}return r;}});
 assert.equal(ready.delivery_state,"retry_pending");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,true);
 assert.equal((await sendBindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready",url:burl,credentialFile:f.ab.file})).delivery_state,"acknowledged");
 assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_edges").get().n,1);assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_source_commits").get().n,1);
 assert.equal(listBindings(f.b.db,{projectId:"demo"}).proposals.length,1);
});
function principal(n,kind="coordinate",projects=["demo"]){
 const id="p"+serial++,file=join(TMP,id+".json");putRole(n.db,{role_id:id,kind,projects,capabilities:[],runtime:null,model:null,effort:null,tools:kind==="observe"?"read-only":"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300}});issuePrincipal(n.db,{roleId:id,projects,credentialFile:file});return "Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
}
test("MCP binding tools enforce coordinator/project scope and preparation rolls back with its response",()=>{
 const f=fixture(),coord=principal(f.a),observe=principal(f.a,"observe"),foreign=principal(f.a,"coordinate",["secret"]),args={request_id:randomUUID(),relation:f.d,expected_version:f.source.aggregate_version};
 assert.throws(()=>callTool(f.a.db,observe,"prepare_binding",args),{code:"FORBIDDEN"});
 assert.throws(()=>callTool(f.a.db,foreign,"prepare_binding",args),{code:"FORBIDDEN"});
 const before=state(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'injected broker receipt'); END");
 assert.throws(()=>callTool(f.a.db,coord,"prepare_binding",args),/injected broker receipt/);assert.equal(state(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");
 const r=callTool(f.a.db,coord,"prepare_binding",args);assert.equal(r.state,"prepared");assert.deepEqual(callTool(f.a.db,coord,"prepare_binding",args),r);
 assert.equal(callTool(f.a.db,observe,"list_bindings",{project_id:"demo",limit:10}).bindings.length,1);
 assert.throws(()=>callTool(f.a.db,foreign,"get_binding",{relation_id:f.d.relation_id}),{code:"NOT_FOUND"});
});
test("MCP release is scoped and atomic with native audit, binding event and durable tool receipt",()=>{
 const f=fixture();begin(f);finish(f);const coord=principal(f.b),observe=principal(f.b,"observe"),args={request_id:randomUUID(),relation_id:f.d.relation_id,expected_version:store.get(f.b.db,f.target.id).aggregate_version};
 assert.throws(()=>callTool(f.b.db,observe,"release_delegation",args),{code:"FORBIDDEN"});
 const before=state(f.b.db);f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'injected release receipt'); END");
 assert.throws(()=>callTool(f.b.db,coord,"release_delegation",args),/injected release receipt/);assert.equal(state(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");
 const r=callTool(f.b.db,coord,"release_delegation",args);assert.equal(r.released,true);assert.equal(r.dispatch_started,false);assert.deepEqual(callTool(f.b.db,coord,"release_delegation",args),r);
 assert.equal(f.b.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);
 assert.throws(()=>releaseBoundTask(f.a.db,{relationId:f.d.relation_id,expectedTaskVersion:f.source.aggregate_version}),{code:"CONFIRMATION_REQUIRED"});
});
test("a bound delegated descendant prevents ancestors from premature review or final completion",()=>{
 const f=fixture(),parent=card(f.a,{kind:"goal"}),op=prepareTopology(f.a.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:1,edits:[{task_uid:f.source.task_uid,expected_version:store.get(f.a.db,f.source.id).aggregate_version,parent_uid:parent.task_uid,blocked_by:[]}]});
 const args=startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),r=publishTopology(f.r.db,f.ar.peer,args);acceptTopologyReceipt(f.a.db,{operationId:op.operation_id,requestId:args.request_id,receipt:r});f.d.source_topology_revision=2;prepare(f,"a");
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(parent.id),/BINDING_PENDING/);
 f.a.db.prepare("UPDATE tasks SET status='waiting',waiting_for='review',result='candidate' WHERE id=?").run(parent.id);assert.ok(!store.pendingReview(f.a.db).some(t=>t.id===parent.id));
 assert.equal(store.completeGoals(f.a.db).includes(parent.id),false);assert.equal(store.get(f.a.db,parent.id).status,"waiting");
});
test("local confirmation failure retries the identical approval after the registrar has already confirmed",async()=>{
 const f=fixture();begin(f);const url=await network(f.r),version=f.r.db.prepare("SELECT version FROM relation_graphs").get().version;
 f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON binding_events WHEN NEW.kind='relation_confirmed' BEGIN SELECT RAISE(ABORT,'injected confirmation'); END");
 const first=await submitBinding(f.b.db,{relationId:f.d.relation_id,url,credentialFile:f.br.file});assert.equal(first.delivery_state,"retry_pending");assert.equal(first.state,"prepared");const id=first.attempts[0].request_id;
 assert.equal(f.r.db.prepare("SELECT version FROM relation_graphs").get().version,version+1);
 f.b.db.exec("DROP TRIGGER injected");const next=await submitBinding(f.b.db,{relationId:f.d.relation_id,url,credentialFile:f.br.file});assert.equal(next.state,"confirmed");assert.equal(next.attempts[0].request_id,id);assert.equal(f.r.db.prepare("SELECT version FROM relation_graphs").get().version,version+1);
});
test("definitive rejection before any successful approval leaves a source binding safely cancellable",async()=>{
 const f=fixture();prepare(f,"a");const op=prepareTopology(f.b.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:1}),args=startTopologyAttempt(f.b.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),r=publishTopology(f.r.db,f.br.peer,args);acceptTopologyReceipt(f.b.db,{operationId:op.operation_id,requestId:args.request_id,receipt:r});
 const url=await network(f.r),out=await submitBinding(f.a.db,{relationId:f.d.relation_id,url,credentialFile:f.ar.file});assert.equal(out.delivery_state,"rejected");assert.equal(out.error_code,"TOPOLOGY_VERSION_CONFLICT");
 assert.equal((await submitBinding(f.a.db,{relationId:f.d.relation_id,mode:"cancel"})).state,"cancelled");
});
test("a revoked source does not prevent the receiver from withdrawing its unconfirmed binding",async()=>{
 const f=fixture();begin(f);revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});const url=await network(f.r);
 const out=await submitBinding(f.b.db,{relationId:f.d.relation_id,mode:"withdraw",url,credentialFile:f.br.file});assert.equal(out.state,"cancelled");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
});
test("restarting a database and running both migrations again preserves endpoint authorization",()=>{
 const f=fixture();begin(f);finish(f);f.b.db.close();f.b.db=new DatabaseSync(f.b.path);dbs.push(f.b.db);store.migrate(f.b.db);migrateBindings(f.b.db);
 assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,true);releaseBoundTask(f.b.db,{relationId:f.d.relation_id,expectedTaskVersion:store.get(f.b.db,f.target.id).aggregate_version});assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"restarted"}).ok,true);
});
test("restored and activated target cannot reuse a former epoch's delegation commitments",()=>{
 const f=fixture();begin(f);finish(f);const evidence=join(f.b.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic binding evidence");
 const backup=createBackup({dbPath:f.b.path,evidenceDir:evidence,destination:join(TMP,"backup"+serial++)}),dir=join(TMP,"restore"+serial++);restoreBackup({backupDirectory:backup.destination,destination:dir});const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);assert.throws(()=>bindingState(db,f.d.relation_id),{code:"RESTORE_HOLD"});
 retireNode({dbPath:f.b.path,expectedEpoch:f.b.node.sync_epoch});const plan=prepareRecovery({dbPath:path});activateRecovery({dbPath:path,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated binding test fixture",attested_at:new Date().toISOString()}});
 assert.throws(()=>bindingState(db,f.d.relation_id),{code:"BINDING_RECOVERY_REQUIRED"});assert.equal(store.claimById(db,{id:f.target.id,worker:"restored"}).ok,false);
});
test("CLI preparation, inspection and offline cancellation require an explicit initialized database",()=>{
 const f=fixture(),file=join(TMP,"descriptor"+serial+++".json");writeFileSync(file,JSON.stringify(f.d));
 const cli=(...args)=>spawnSync(process.execPath,[join(ROOT,"cli/binding.mjs"),...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});
 assert.notEqual(cli("get","--relation",f.d.relation_id).status,0);
 const p=cli("prepare","--db",f.a.path,"--relation-file",file,"--version",String(f.source.aggregate_version));assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).state,"prepared");
 assert.equal(cli("list","--db",f.a.path,"--project","demo").status,0);assert.equal(cli("get","--db",f.a.path,"--relation",f.d.relation_id).status,0);
 const c=cli("cancel","--db",f.a.path,"--relation",f.d.relation_id);assert.equal(c.status,0,c.stderr);assert.equal(JSON.parse(c.stdout).state,"cancelled");assert.equal(store.get(f.a.db,f.source.id).attempts,0);
});
test("independent processes cannot both bind delegation and claim the same local source",async()=>{
 const f=fixture(),script=join(TMP,"binding-race"+serial+++".mjs"),data=join(TMP,"race"+serial+++".json");writeFileSync(data,JSON.stringify({relation:f.d,expectedTaskVersion:f.source.aggregate_version}));
 writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite"; import {readFileSync} from "node:fs"; import {createRequire} from "node:module"; import {fileURLToPath} from "node:url";',
  'import {prepareBinding} from '+JSON.stringify(new URL("../core/federation/bindings.mjs",import.meta.url).href)+';',
  'const store=createRequire(import.meta.url)(fileURLToPath('+JSON.stringify(new URL("../core/store.js",import.meta.url).href)+'));',
  'const [dbPath,file,action,id]=process.argv.slice(2),db=new DatabaseSync(dbPath);db.exec("PRAGMA busy_timeout=5000");',
  'process.send("ready");process.once("message",()=>{let result;try{result=action==="claim"?store.claimById(db,{id:Number(id),worker:"racer"}):prepareBinding(db,JSON.parse(readFileSync(file,"utf8")));}catch(e){result={error:e.code};}db.close();process.stdout.write(JSON.stringify(result));process.disconnect();});'
 ].join("\n"));
 const children=["claim","bind"].map(action=>{const p=spawn(process.execPath,[script,f.a.path,data,action,String(f.source.id)],{stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);return {p,ready:new Promise((resolve,reject)=>{p.once("message",resolve);p.once("error",reject);p.once("exit",code=>{if(code!==0)reject(Error("startup "+code+" "+err));});}),done:new Promise((resolve,reject)=>{p.once("error",reject);p.once("close",code=>{if(code!==0)return reject(Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});})};});
 await Promise.all(children.map(c=>c.ready));for(const c of children)c.p.send("go");const [claim,bind]=await Promise.all(children.map(c=>c.done));
 assert.equal(Number(claim.ok===true)+Number(bind.state==="prepared"),1);
 if(claim.ok)assert.ok(["CONFLICT","ACTIVE_WORK"].includes(bind.error));else{assert.equal(claim.ok,false);assert.equal(bind.state,"prepared");}
});
test("an endpoint may receive upstream work and delegate downstream without running the same work locally",()=>{
 const f=fixture({withThird:true});begin(f);finish(f);
 const c=f.c,bc=grant(f.b,c),cr=grant(c,f.r,["peer:handshake","relations:read","relations:approve","relations:publish"]),source=store.get(f.b.db,f.target.id);
 const out=createIntent(f.b.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:c.node.node_id,targetEpoch:c.node.sync_epoch});receiveOffer(c.db,bc.peer,out.offer);
 const accepted=decideIncoming(c.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"downstream"});recordReceipt(f.b.db,out.delegation_id,accepted);register(f,c,cr);
 const target=store.get(c.db,c.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id),q={a:f.b,b:c,r:f.r,g:f.g,ab:bc,ar:f.br,br:cr,source,target,out};
 q.d={...f.d,relation_id:randomUUID(),delegation_id:out.delegation_id,source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:source.task_uid,target_node_id:c.node.node_id,target_epoch:c.node.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest};
 begin(q);finish(q);const upstream=bindingState(f.b.db,f.d.relation_id);assert.equal(upstream.binding_authorized,true);assert.equal(upstream.execution_authorized,false);
 assert.equal(bindingState(c.db,q.d.relation_id).execution_authorized,true);assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_edges").get().n,2);
 assert.throws(()=>releaseBoundTask(f.b.db,{relationId:f.d.relation_id,expectedTaskVersion:source.aggregate_version}),{code:"CONFIRMATION_REQUIRED"});
 releaseBoundTask(c.db,{relationId:q.d.relation_id,expectedTaskVersion:target.aggregate_version});assert.equal(store.claimById(c.db,{id:target.id,worker:"downstream"}).ok,true);
});
test("a retired source epoch cannot refresh readiness even while its credential row remains active",()=>{
 const f=fixture();begin(f);finish(f);f.b.db.prepare("INSERT INTO federation_retired_epochs VALUES(?,?,?)").run(f.a.node.node_id,f.a.node.sync_epoch,randomUUID());
 const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready"});assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,body),{code:"RETIRED_EPOCH"});assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
});
test("revocation during an actual HTTP upload cannot persist a source-ready commitment",async()=>{
 const f=fixture();begin(f);approve(f,"b");const r=relationStatus(f.r.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:f.d.relation_id});acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt:r});
 const body=JSON.stringify(bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"source_ready"})),url=await network(f.b),server=servers.at(-1),before=state(f.b.db);let notify;
 const receiving=new Promise(resolve=>notify=resolve);server.once("request",()=>notify());
 const result=new Promise((resolve,reject)=>{
  const req=http.request(url+"/peer/v1/delegation/binding",{method:"POST",headers:{Authorization:f.ab.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);
  const split=Math.floor(body.length/2);req.write(body.slice(0,split));receiving.then(()=>{revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});req.end(body.slice(split));}).catch(reject);
 });
 assert.ok((await result)>=400);assert.equal(state(f.b.db),before);assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);
});
test("a confirmation racing withdrawal rejects cancellation but leaves the confirmed receipt recoverable",async()=>{
 const f=fixture();begin(f);approve(f,"b");const url=await network(f.r);
 const cancelled=await submitBinding(f.a.db,{relationId:f.d.relation_id,mode:"withdraw",url,credentialFile:f.ar.file});assert.equal(cancelled.delivery_state,"rejected");assert.equal(cancelled.error_code,"RELATION_CONFIRMED");assert.equal(cancelled.state,"prepared");
 const recovered=await submitBinding(f.a.db,{relationId:f.d.relation_id,mode:"poll",url,credentialFile:f.ar.file});assert.equal(recovered.state,"confirmed");
 await assert.rejects(submitBinding(f.a.db,{relationId:f.d.relation_id,mode:"cancel",url,credentialFile:f.ar.file}),{code:"RELATION_CONFIRMED"});
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"cannot-reclaim"}).ok,false);
});
test("local delegation status distinguishes immutable acceptance receipts from current endpoint readiness",()=>{
 const f=fixture();assert.equal(incomingStatus(f.b.db,f.out.delegation_id).binding,null);begin(f);finish(f);
 const target=incomingStatus(f.b.db,f.out.delegation_id),source=outgoingStatus(f.a.db,f.out.delegation_id);
 assert.equal(target.receipt.state,"accepted_unconfirmed");assert.equal(target.receipt.dispatch_ready,false);
 assert.equal(target.binding.state,"confirmed");assert.equal(target.binding.binding_authorized,true);assert.equal(source.binding.side,"source");assert.equal(source.binding.binding_authorized,false);
});

function proposalOnly(f){prepare(f,"a");approve(f,"a");send(f,"proposal");}
function decline(f,reasonCode="operator_declined"){return declineBindingProposal(f.b.db,{relationId:f.d.relation_id,expectedDescriptorDigest:digest(f.d),reasonCode});}
test("unprepared proposals can be explicitly declined with immutable evidence and no source release",()=>{
 const f=fixture();proposalOnly(f);const before=state(f.b.db);
 assert.throws(()=>declineBindingProposal(f.b.db,{relationId:f.d.relation_id,expectedDescriptorDigest:"0".repeat(64),reasonCode:"operator_declined"}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>declineBindingProposal(f.b.db,{relationId:f.d.relation_id,expectedDescriptorDigest:digest(f.d),reasonCode:"arbitrary"}),{code:"BAD_INPUT"});
 assert.equal(state(f.b.db),before);assert.equal(decline(f).state,"declined");assert.equal(decline(f).state,"declined");
 assert.throws(()=>decline(f,"duplicate"),{code:"REQUEST_CONFLICT"});
 assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_events WHERE kind='proposal_declined'").get().n,1);
 assert.throws(()=>prepare(f,"b"),{code:"PROPOSAL_DECLINED"});assert.equal(store.get(f.b.db,f.target.id).released,false);
 assert.equal(bindingState(f.a.db,f.d.relation_id).state,"prepared");assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"held"}).ok,false);
 for(const table of ["binding_proposal_decisions","binding_proposals"])assert.throws(()=>f.b.db.exec("DELETE FROM "+table),/retained/);
 assert.throws(()=>f.b.db.exec("UPDATE binding_proposal_decisions SET reason_code='duplicate'"),/immutable/);
 const list=listBindings(f.b.db,{projectId:"demo"});assert.equal(list.pending_count,0);assert.deepEqual(list.pending_proposals,[]);assert.equal(list.proposals[0].state,"declined");
});
test("decline cannot replace prepared, pending-approval, confirmed or cancelled binding recovery",()=>{
 const f=fixture();begin(f);assert.throws(()=>decline(f),{code:"PROPOSAL_BOUND"});
 startBindingAttempt(f.b.db,{relationId:f.d.relation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version});assert.throws(()=>decline(f),{code:"PROPOSAL_BOUND"});
 finish(f);assert.throws(()=>decline(f),{code:"PROPOSAL_BOUND"});
 const g=fixture();begin(g);const a=startBindingAttempt(g.b.db,{relationId:g.d.relation_id,action:"withdraw"}),receipt=withdrawRelation(g.r.db,g.br.peer,a);acceptBindingReceipt(g.b.db,{relationId:g.d.relation_id,requestId:a.request_id,receipt});assert.throws(()=>decline(g),{code:"PROPOSAL_BOUND"});
 assert.equal(listBindings(g.b.db,{projectId:"demo"}).pending_count,0);
});
test("MCP proposal decline requires coordinate/project scope and rolls back with both audit and response",()=>{
 const f=fixture();proposalOnly(f);const coord=principal(f.b),observe=principal(f.b,"observe"),other=principal(f.b,"coordinate",["secret"]),args={request_id:randomUUID(),relation_id:f.d.relation_id,expected_descriptor_digest:digest(f.d),reason_code:"stale_topology"};
 assert.equal(callTool(f.b.db,observe,"get_binding_proposal",{relation_id:f.d.relation_id}).state,"pending");
 assert.throws(()=>callTool(f.b.db,observe,"decline_binding_proposal",args),{code:"FORBIDDEN"});
 for(const tool of ["get_binding_proposal","decline_binding_proposal"])assert.throws(()=>callTool(f.b.db,other,tool,tool==="get_binding_proposal"?{relation_id:f.d.relation_id}:args),{code:"NOT_FOUND"});
 const before=state(f.b.db);
 for(const table of ["binding_events","broker_requests"]){f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'decline persistence fault'); END");assert.throws(()=>callTool(f.b.db,coord,"decline_binding_proposal",args),/decline persistence fault/);assert.equal(state(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");}
 const r=callTool(f.b.db,coord,"decline_binding_proposal",args);assert.equal(r.state,"declined");assert.deepEqual(callTool(f.b.db,coord,"decline_binding_proposal",args),r);
 assert.throws(()=>callTool(f.b.db,coord,"decline_binding_proposal",{...args,reason_code:"duplicate"}),{code:"REQUEST_CONFLICT"});
});
test("authenticated retry sees current decline without overwriting historical ACK or cancelling source automatically",async()=>{
 const f=fixture();proposalOnly(f);const url=await network(f.b),rurl=await network(f.r),body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal"});
 const ack=f.a.db.prepare("SELECT receipt_json FROM binding_outbox WHERE request_id=?").get(body.request_id).receipt_json;decline(f);
 const unknown=await sendBindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal",url,credentialFile:f.ab.file,fetchImpl:async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/binding")){await r.arrayBuffer();throw Error("lost decline response");}return r;}});assert.equal(unknown.delivery_state,"retry_pending");
 const r=await sendBindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal",url,credentialFile:f.ab.file});assert.equal(r.delivery_state,"blocked");assert.equal(r.error_code,"PROPOSAL_DECLINED");
 assert.equal(f.a.db.prepare("SELECT receipt_json FROM binding_outbox WHERE request_id=?").get(body.request_id).receipt_json,ack);
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"still-held"}).ok,false);
 const cancel=await submitBinding(f.a.db,{relationId:f.d.relation_id,mode:"withdraw",url:rurl,credentialFile:f.ar.file});assert.equal(cancel.state,"cancelled");
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:"after-verified-withdrawal"}).ok,true);
 const before=state(f.b.db);assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,{...body,relation:{...body.relation,target_topology_revision:2}}),{code:"REQUEST_CONFLICT"});assert.equal(state(f.b.db),before);
});
test("declined history releases one bounded queue slot, stays visible, and cannot hide older pending proposals",()=>{
 const f=fixture();proposalOnly(f);const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal"}),messages=[];
 for(let i=1;i<1000;i++){const m={...body,request_id:randomUUID(),relation:{...f.d,relation_id:randomUUID()}};receiveBindingMessage(f.b.db,f.ab.peer,m);messages.push(m);}
 assert.equal(listBindings(f.b.db,{projectId:"demo",limit:1}).pending_count,1000);
 const next={...body,request_id:randomUUID(),relation:{...f.d,relation_id:randomUUID()}};
 assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,next),{code:"QUEUE_LIMIT"});decline(f);receiveBindingMessage(f.b.db,f.ab.peer,next);
 assert.equal(listBindings(f.b.db,{projectId:"demo",limit:1}).pending_count,1000);
 assert.throws(()=>receiveBindingMessage(f.b.db,f.ab.peer,body),{code:"PROPOSAL_DECLINED"});
 declineBindingProposal(f.b.db,{relationId:next.relation.relation_id,expectedDescriptorDigest:digest(next.relation),reasonCode:"duplicate"});
 const list=listBindings(f.b.db,{projectId:"demo",limit:1});assert.equal(list.proposals[0].state,"declined");assert.equal(list.pending_proposals[0].relation_id,messages[0].relation.relation_id);assert.equal(list.pending_count,999);
 assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_proposals").get().n,1001);
});
test("schema v1 upgrades transactionally and read-only inspection remains available before migration",()=>{
 const f=fixture();proposalOnly(f);f.b.db.exec("DROP TRIGGER binding_decline_unprepared; DROP TRIGGER binding_declined_hold; DROP TABLE binding_proposal_decisions; UPDATE binding_schema SET version=1");
 assert.equal(listBindings(f.b.db,{projectId:"demo"}).pending_count,1);assert.equal(bindingProposalState(f.b.db,f.d.relation_id).state,"pending");
 f.b.db.exec("CREATE TRIGGER injected BEFORE UPDATE ON binding_schema BEGIN SELECT RAISE(ABORT,'migration fault'); END");
 assert.throws(()=>migrateBindings(f.b.db),/migration fault/);assert.equal(f.b.db.prepare("SELECT version FROM binding_schema").get().version,1);assert.equal(f.b.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='binding_proposal_decisions'").get().n,0);
 f.b.db.exec("DROP TRIGGER injected");migrateBindings(f.b.db);decline(f);migrateBindings(f.b.db);
 assert.equal(f.b.db.prepare("SELECT version FROM binding_schema").get().version,3);assert.equal(bindingProposalState(f.b.db,f.d.relation_id).state,"declined");
 const db=new DatabaseSync(f.b.path);try{migrateBindings(db);assert.equal(bindingProposalState(db,f.d.relation_id).state,"declined");}finally{db.close();}
});
test("stale topology and revoked source access do not prevent an offline local decline",()=>{
 const f=fixture();proposalOnly(f);
 const op=prepareTopology(f.b.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:1}),a=startTopologyAttempt(f.b.db,{operationId:op.operation_id,expectedVersion:f.r.db.prepare("SELECT version FROM relation_graphs").get().version}),r=publishTopology(f.r.db,f.br.peer,a);acceptTopologyReceipt(f.b.db,{operationId:op.operation_id,requestId:a.request_id,receipt:r});
 assert.throws(()=>prepare(f,"b"),{code:"TOPOLOGY_PENDING"});revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
 assert.equal(decline(f,"stale_topology").state,"declined");assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_attempts").get().n,0);
});
test("CLI reads and declines the exact proposal from an explicitly selected database",()=>{
 const f=fixture();proposalOnly(f);const cli=(...args)=>spawnSync(process.execPath,[join(ROOT,"cli/binding.mjs"),...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});
 const read=cli("get-proposal","--db",f.b.path,"--relation",f.d.relation_id);assert.equal(read.status,0,read.stderr);assert.equal(JSON.parse(read.stdout).descriptor_digest,digest(f.d));
 const result=cli("decline","--db",f.b.path,"--relation",f.d.relation_id,"--digest",digest(f.d),"--reason","contract_changed");assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).state,"declined");assert.equal(store.get(f.b.db,f.target.id).attempts,0);
});
test("restored epochs retain proposal history without filling or authorizing the new epoch's pending queue",()=>{
 const f=fixture();proposalOnly(f);const evidence=join(f.b.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic proposal evidence");const backup=createBackup({dbPath:f.b.path,evidenceDir:evidence,destination:join(TMP,"proposal-backup"+serial++)}),dir=join(TMP,"proposal-restore"+serial++);restoreBackup({backupDirectory:backup.destination,destination:dir});const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);
 retireNode({dbPath:f.b.path,expectedEpoch:f.b.node.sync_epoch});const plan=prepareRecovery({dbPath:path});activateRecovery({dbPath:path,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated proposal recovery fixture",attested_at:new Date().toISOString()}});
 const list=listBindings(db,{projectId:"demo"});assert.equal(list.proposals.length,1);assert.equal(list.proposals[0].identity_current,false);assert.equal(list.pending_count,0);assert.deepEqual(list.pending_proposals,[]);
 assert.throws(()=>declineBindingProposal(db,{relationId:f.d.relation_id,expectedDescriptorDigest:digest(f.d),reasonCode:"operator_declined"}),{code:"BINDING_RECOVERY_REQUIRED"});
});
test("independent processes serialize target preparation against proposal decline",async()=>{
 const f=fixture();proposalOnly(f);const script=join(TMP,"proposal-race"+serial+++".mjs"),data=join(TMP,"proposal-race-data"+serial+++".json");writeFileSync(data,JSON.stringify({relation:f.d,expectedTaskVersion:store.get(f.b.db,f.target.id).aggregate_version,descriptorDigest:digest(f.d)}));
 writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite"; import {readFileSync} from "node:fs";',
  'import {prepareBinding,declineBindingProposal} from '+JSON.stringify(new URL("../core/federation/bindings.mjs",import.meta.url).href)+';',
  'const [path,file,action]=process.argv.slice(2),db=new DatabaseSync(path),d=JSON.parse(readFileSync(file,"utf8"));db.exec("PRAGMA busy_timeout=5000");',
  'process.send("ready");process.once("message",()=>{let result;try{result=action==="prepare"?prepareBinding(db,d):declineBindingProposal(db,{relationId:d.relation.relation_id,expectedDescriptorDigest:d.descriptorDigest,reasonCode:"operator_declined"});}catch(e){result={error:e.code};}db.close();process.stdout.write(JSON.stringify(result));process.disconnect();});'
 ].join("\n"));
 const children=["prepare","decline"].map(action=>{const p=spawn(process.execPath,[script,f.b.path,data,action],{stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);return {p,ready:new Promise((resolve,reject)=>{p.once("message",resolve);p.once("error",reject);p.once("exit",code=>{if(code!==0)reject(Error("startup "+code+" "+err));});}),done:new Promise((resolve,reject)=>{p.once("error",reject);p.once("close",code=>{if(code!==0)return reject(Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});})};});
 await Promise.all(children.map(c=>c.ready));for(const c of children)c.p.send("go");const [prepared,declined]=await Promise.all(children.map(c=>c.done));
 assert.equal(Number(prepared.state==="prepared")+Number(declined.state==="declined"),1);
 if(prepared.state==="prepared"){assert.equal(declined.error,"PROPOSAL_BOUND");assert.equal(bindingProposalState(f.b.db,f.d.relation_id).state,"prepared");}else{assert.equal(prepared.error,"PROPOSAL_DECLINED");assert.equal(bindingProposalState(f.b.db,f.d.relation_id).state,"declined");}
});

test("declined attempt can be replaced only with a new relation after verified registrar withdrawal",()=>{
 const f=fixture();proposalOnly(f);const oldId=f.d.relation_id;decline(f);
 const a=startBindingAttempt(f.a.db,{relationId:oldId,action:"withdraw"}),receipt=withdrawRelation(f.r.db,f.ar.peer,a);acceptBindingReceipt(f.a.db,{relationId:oldId,requestId:a.request_id,receipt});
 f.d={...f.d,relation_id:randomUUID()};begin(f);finish(f);releaseBoundTask(f.b.db,{relationId:f.d.relation_id,expectedTaskVersion:store.get(f.b.db,f.target.id).aggregate_version});
 assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:"replacement"}).ok,true);assert.equal(bindingProposalState(f.b.db,oldId).state,"declined");assert.equal(bindingState(f.a.db,oldId).state,"cancelled");assert.equal(f.r.db.prepare("SELECT count(*) n FROM relation_edges").get().n,1);
});
test("a decline committed during an HTTP retry upload is checked before any receipt is returned",async()=>{
 const f=fixture();proposalOnly(f);const text=JSON.stringify(bindingMessage(f.a.db,{relationId:f.d.relation_id,kind:"proposal"})),url=await network(f.b),server=servers.at(-1);let notify;
 const receiving=new Promise(resolve=>notify=resolve);server.once("request",()=>notify());
 const result=new Promise((resolve,reject)=>{
  const req=http.request(url+"/peer/v1/delegation/binding",{method:"POST",headers:{Authorization:f.ab.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(text)}},res=>{let body="";res.setEncoding("utf8");res.on("data",x=>body+=x);res.on("end",()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)});}catch(e){reject(e);}});});req.on("error",reject);
  const split=Math.floor(text.length/2);req.write(text.slice(0,split));receiving.then(()=>{decline(f);req.end(text.slice(split));}).catch(reject);
 });
 const r=await result;assert.equal(r.status,409);assert.equal(r.body.code,"PROPOSAL_DECLINED");assert.equal(f.b.db.prepare("SELECT count(*) n FROM binding_inbox").get().n,1);assert.equal(bindingProposalState(f.b.db,f.d.relation_id).state,"declined");
});
