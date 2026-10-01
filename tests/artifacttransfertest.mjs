import {issueCredential,listenPeerServer,fixtureEndpoint} from "./helpers/peer-network.mjs";
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
const TMP=mkdtempSync(join(tmpdir(),"fleet-artifact-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}rmSync(TMP,{recursive:true,force:true});});
function node(){const dir=join(TMP,"n"+serial++);mkdirSync(dir);const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateBindings(db);migrateResults(db);migrateRelations(db);return {db,dir,path,node:localIdentity(db)};}
function grant(a,b,scopes=["peer:handshake","delegation:offer","delegation:status","delegation:binding","delegation:control","delegation:result"],projects=["demo"]){const file=join(TMP,"grant"+serial+++".json");issueCredential(b.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes,projects,credentialFile:file,expectedVersion:b.db.prepare("SELECT credential_version FROM federation_peers WHERE peer_node_id=?").get(a.node.node_id)?.credential_version});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(b.db,"Bearer "+c.token)};}
function card(f,extra={}){const id=store.add(f.db,{subject:"work "+serial++,description:"requested work",acceptance:"review evidence",treeMode:"hierarchical",route:"mcp",released:1,...extra}),t=store.get(f.db,id);enrollTask(f.db,{id,projectId:"demo",workKind:"implement",capabilities:["workspace-files"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
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
 const policy=(role_id,kind)=>({role_id,kind,projects:["demo"],capabilities:["workspace-files"],runtime:kind==="implement"?"claude":null,model:kind==="implement"?"fixture-model":null,effort:kind==="implement"?"low":null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:5,max_open_tasks:100,requests_per_minute:300}});
 const suffix=serial++;putRole(n.db,policy("coord"+suffix,"coordinate"));putRole(n.db,policy("engine"+suffix,"implement"));const file=join(TMP,"coord"+suffix+".json");issuePrincipal(n.db,{roleId:"coord"+suffix,projects:["demo"],credentialFile:file});const auth="Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
 if(task.id===f.target.id)releaseBoundTask(n.db,{relationId:f.d.relation_id,expectedTaskVersion:store.get(n.db,task.id).aggregate_version});
 const current=store.get(n.db,task.id),a=callTool(n.db,auth,"request_assignment",{request_id:randomUUID(),task_uid:current.task_uid,expected_version:current.aggregate_version});
 const q=putQuota(n.db,{quota_id:randomUUID(),runtime:"claude",execution_mode:mode,projects:["demo"],limit_total:1,enabled:true}),credentialFile=join(TMP,"worker"+serial+++".json"),w=prepareDispatch(n.db,{assignmentId:a.assignment_id,quotaId:q.quota_id,executionMode:mode,credentialFile,sourceGate});
 return {w,q,auth,workerCredentialFile:credentialFile};
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

import {createHash} from "node:crypto";
import {realpathSync} from "node:fs";
import {registerRepository} from "../core/artifacts/repositories.mjs";
import {registerWorkspacePool,createTaskWorkspace} from "../core/artifacts/workspaces.mjs";
import {prepareWorkspaceSession} from "../core/artifacts/workspace-session.mjs";
import {commitWorkspaceSession} from "../core/artifacts/workspace-commit.mjs";
import {migrateArtifacts,registerArtifactTarget,prepareArtifact,artifactState,receiveArtifactOffer,receiveArtifactChunk,sealArtifact,peerArtifactStatus,verifyArtifact,captureVerifiedArtifact,artifactChunk,recordArtifactProgress,CHUNK_BYTES,MAX_ARTIFACT_STORAGE} from "../core/artifacts/transfers.mjs";
import {deliverArtifact} from "../core/artifacts/transfer-client.mjs";
import {contentHash} from "../core/artifacts/git-package.mjs";
const git=(dir,args)=>execFileSync("git",["-C",dir,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
const gitExecPath=execFileSync("git",["--exec-path"],{encoding:"utf8"}).trim(),gitPath=realpathSync.native(join(gitExecPath,"../../bin/git.exe")),pinnedGit={path:gitPath,sha256:contentHash(readFileSync(gitPath))};
function observed(execution){return {status:"success",evidence:"fixture file session terminal",usage:null,diagnostic:"SUCCESS",real_model_call_confirmed:false,observed:{runtime:"claude",session_id:"fixture-session",turn_id:null,model:"fixture-model",terminal_status:"success",protocol_error:null,bytes:1024,events:2,stdout_sha256:"7".repeat(64)},process:{started:true,pid:123,containment:"windows-job",cleanup:"job_empty",host_sha256:"8".repeat(64),executable_sha256:execution.command_sha256,python_sha256:execution.python_sha256,exit_code:0,host_error:null,host_exit_code:0,stderr_bytes:0,stderr_hashed_bytes:0,stderr_sha256:"9".repeat(64)}};}

function fileCandidate({register=true,receiveReport=true}={}){
 const f=fullyBound(),w=worker(f),root=join(TMP,"repo"+serial++);mkdirSync(root);mkdirSync(join(root,"src"));
 writeFileSync(join(root,"src","base.txt"),"original\r\n中文\r\n");writeFileSync(join(root,"private.txt"),"unchanged baseline; local full-read grant required\n");
 git(root,["init","--quiet","--template="]);git(root,["-c","core.autocrlf=false","add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","approved base"]);const base=git(root,["rev-parse","HEAD"]),receiverRoot=join(TMP,"receiver"+serial++);
 git(TMP,["clone","--quiet","--no-hardlinks",root,receiverRoot]);
 const map=(n,root)=>registerRepository(n.db,{mappingId:randomUUID(),projectId:"demo",repoId:"app",root,git:pinnedGit,baseCommit:base,paths:["src/"]});
 const senderMapping=map(f.b,root),receiverMapping=map(f.a,receiverRoot),poolRoot=join(TMP,"pool"+serial++);mkdirSync(poolRoot);const pool=registerWorkspacePool(f.b.db,{poolId:randomUUID(),mappingId:senderMapping.mapping_id,root:poolRoot,allowFullHistoryCopy:true});
 const workspaceId=randomUUID();createTaskWorkspace(f.b.db,{workspaceId,poolId:pool.pool_id,dispatchId:w.w.dispatch_id,baseCommit:base,writePaths:["src/"]});const descriptor=prepareWorkspaceSession(f.b.db,{workspaceId});
 const execution={format:"ai-fleet-process/v2",adapter_contract:"ai-fleet-adapter/workspace-files-v1",workspace:descriptor,adapter_digest:"1".repeat(64),runtime:"claude",model:"fixture-model",effort:"low",run_id:w.w.run_id,agent_instance_id:w.w.agent_instance_id,principal_id:w.w.principal_id,command_sha256:"2".repeat(64),python_sha256:"3".repeat(64),files_digest:"4".repeat(64),prompt_sha256:"5".repeat(64),environment_sha256:"6".repeat(64),timeout_ms:5000,heartbeat_ms:50,stderr_limit:1024};
 authorizeLaunch(f.b.db,{dispatchId:w.w.dispatch_id,sourceGate,execution});
 const workerFile=JSON.parse(readFileSync(w.workerCredentialFile,"utf8"));
 const auth="Bearer "+workerFile.token;
 for(const [path,content] of [["src/generated.mjs","export const result=42;\n/*"+"x".repeat(45000)+"*/\n"],["src/note1.txt","a".repeat(45000)],["src/note2.txt","b".repeat(45000)]])callTool(f.b.db,auth,"edit_workspace_file",{request_id:randomUUID(),task_uid:f.target.task_uid,path,expected_version:0,offset:0,delete_bytes:0,content,executable:false});
 const observation=observed(execution);finishDispatch(f.b.db,{dispatchId:w.w.dispatch_id,result:{status:observation.status,evidence:observation.evidence,usage:null},observation});commitWorkspaceSession(f.b.db,{workspaceId});const r=candidate(f),ba=grant(f.b,f.a,["peer:handshake","delegation:result","artifact:write"]);
 migrateArtifacts(f.a.db);migrateArtifacts(f.b.db);
 if(receiveReport){const ack=receiveResult(f.a.db,ba.peer,r.body);recordResultReceipt(f.b.db,{resultId:r.result_id,receipt:ack});}
 const targetArgs={resultId:r.result_id,mappingId:receiverMapping.mapping_id,baseCommit:base,allowFullBaselineRead:true};if(register&&receiveReport)registerArtifactTarget(f.a.db,targetArgs);
 const t=prepareArtifact(f.b.db,{resultId:r.result_id,transferId:randomUUID()});return {...f,w,r,t,ba,root,base,receiverRoot,receiverMapping,targetArgs,workspaceId};
}
function upload(f,h=f.t.header,bytes=null){receiveArtifactOffer(f.a.db,f.ba.peer,h);const n=Math.ceil(h.payload_bytes/CHUNK_BYTES);for(let i=0;i<n;i++){const chunk=bytes?{transfer_id:h.transfer_id,header_digest:digest(h),chunk_index:i,sha256:contentHash(bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)),content:bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES).toString("base64")}:artifactChunk(f.b.db,{transferId:h.transfer_id,index:i});receiveArtifactChunk(f.a.db,f.ba.peer,chunk);}return sealArtifact(f.a.db,f.ba.peer,{transfer_id:h.transfer_id,header_digest:digest(h)});}
const transferRows=db=>JSON.stringify(Object.fromEntries(["artifact_targets","artifact_transfers","artifact_chunks","artifact_receipts","artifact_events"].map(t=>[t,db.prepare("SELECT * FROM "+t+" ORDER BY rowid").all()])));

test("HTTP transfers actual MCP Git outputs across a lost chunk ACK and database restart, then verifies locally",async()=>{
 const f=fileCandidate({register:false,receiveReport:false}),before=store.get(f.a.db,f.source.id);let url=await network(f.a);
 assert.equal((await deliverResult(f.b.db,{resultId:f.r.result_id,url,credentialFile:f.ba.file})).delivery_state,"acknowledged");registerArtifactTarget(f.a.db,f.targetArgs);
 let lost=false;const fetchImpl=async(u,o)=>{const r=await fetch(u,o);if(u.endsWith("/chunk")&&!lost){lost=true;await r.arrayBuffer();throw Error("lost ACK after durable receive");}return r;};
 const send=extra=>deliverArtifact(f.b.db,{transferId:f.t.transfer_id,url,credentialFile:f.ba.file,...extra});
 assert.equal((await send({fetchImpl})).delivery_state,"retry_pending");assert.equal(artifactState(f.a.db,f.t.transfer_id).next_chunk,1);
 const server=servers.at(-1);server.closeAllConnections();await new Promise(r=>server.close(r));f.a.db.close();f.b.db.close();for(const n of [f.a,f.b]){n.db=new DatabaseSync(n.path);dbs.push(n.db);n.db.exec("PRAGMA busy_timeout=5000");}url=await network(f.a);
 let resumed=await send({maxChunks:1});if(resumed.delivery_state==="retry_pending"){assert.equal(resumed.error_code,"TRANSPORT_ERROR");resumed=await send({maxChunks:1});}assert.equal(resumed.delivery_state,"more",JSON.stringify(resumed));const received=await send();assert.equal(received.delivery_state,"acknowledged");assert.equal(received.state,"received");assert.equal(received.verification,null);assert.equal(received.accepted,false);
 assert.throws(()=>captureVerifiedArtifact(f.a.db,{transferId:f.t.transfer_id}),{code:"ARTIFACT_UNVERIFIED"});assert.equal(verifyArtifact(f.a.db,{transferId:f.t.transfer_id}).state,"content_verified");
 const sent=await send();assert.equal(sent.sent_chunks,0);assert.equal(sent.state,"content_verified");assert.equal(sent.accepted,false);
 const captured=captureVerifiedArtifact(f.a.db,{transferId:f.t.transfer_id}),value=JSON.parse(captured.bytes),module=value.files.find(x=>x.path==="src/generated.mjs"),independent=join(TMP,"execute-"+serial++);mkdirSync(independent);writeFileSync(join(independent,"result.mjs"),Buffer.from(module.content,"base64"));assert.equal(execFileSync(process.execPath,["--input-type=module","-e","import {result} from './result.mjs'; console.log(result)"],{cwd:independent,encoding:"utf8",windowsHide:true}).trim(),"42");
 assert.equal(git(f.receiverRoot,["rev-parse","HEAD"]),f.base);assert.equal(existsSync(join(f.receiverRoot,"src","generated.mjs")),false);assert.deepEqual(store.get(f.a.db,f.source.id),before);assert.equal(f.a.db.prepare("SELECT count(*) n FROM task_runs").get().n,0);assert.equal(f.b.db.prepare("SELECT count(*) n FROM broker_dispatches").get().n,1);
 const cli=JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli/artifact.mjs"),"get","--db",f.a.path,"--transfer",f.t.transfer_id],{encoding:"utf8",windowsHide:true}));assert.equal(cli.state,"content_verified");assert.equal(cli.accepted,false);
});

test("local receive grant, exact candidate/run/base and bounded ordered chunks are required",()=>{
 const f=fileCandidate({register:false}),h=f.t.header;
 assert.throws(()=>receiveArtifactOffer(f.a.db,f.ba.peer,h),{code:"ARTIFACT_TARGET_REQUIRED"});assert.throws(()=>registerArtifactTarget(f.a.db,{...f.targetArgs,allowFullBaselineRead:false}),{code:"BASELINE_READ_GRANT_REQUIRED"});registerArtifactTarget(f.a.db,f.targetArgs);
 for(const mutate of [h=>h.manifest.run_id=randomUUID(),h=>h.manifest.dispatch_id=randomUUID(),h=>h.manifest.repo_id="other",h=>h.manifest.base_commit="0".repeat(40),h=>h.manifest.files[0].path="private.txt",h=>h.result_body_digest="a".repeat(64)]){const bad=structuredClone(h);mutate(bad);bad.manifest_digest=digest(bad.manifest);assert.throws(()=>receiveArtifactOffer(f.a.db,f.ba.peer,bad));}
 receiveArtifactOffer(f.a.db,f.ba.peer,h);assert.throws(()=>receiveArtifactOffer(f.a.db,f.ba.peer,{...h,transfer_id:randomUUID()}),{code:"ARTIFACT_EXISTS"});
 const first=artifactChunk(f.b.db,{transferId:f.t.transfer_id,index:0}),second=artifactChunk(f.b.db,{transferId:f.t.transfer_id,index:1});assert.throws(()=>receiveArtifactChunk(f.a.db,f.ba.peer,second),{code:"CHUNK_ORDER"});assert.throws(()=>receiveArtifactChunk(f.a.db,f.ba.peer,{...first,content:"YQ=="}),{code:"ARTIFACT_MISMATCH"});
 const before=transferRows(f.a.db);f.a.db.exec("CREATE TRIGGER injected BEFORE INSERT ON artifact_events BEGIN SELECT RAISE(ABORT,'artifact audit fault'); END");assert.throws(()=>receiveArtifactChunk(f.a.db,f.ba.peer,first),/artifact audit fault/);assert.equal(transferRows(f.a.db),before);f.a.db.exec("DROP TRIGGER injected");
 const one=receiveArtifactChunk(f.a.db,f.ba.peer,first);assert.equal(one.next_chunk,1);assert.deepEqual(receiveArtifactChunk(f.a.db,f.ba.peer,first),one);const different=Buffer.alloc(CHUNK_BYTES,0);assert.throws(()=>receiveArtifactChunk(f.a.db,f.ba.peer,{...first,sha256:contentHash(different),content:different.toString("base64")}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>sealArtifact(f.a.db,f.ba.peer,{transfer_id:f.t.transfer_id,header_digest:f.t.header_digest}),{code:"ARTIFACT_INCOMPLETE"});
 for(const table of ["artifact_targets","artifact_transfers","artifact_chunks","artifact_events"])assert.throws(()=>f.a.db.exec("DELETE FROM "+table),/must be retained/);
 const weak=grant(f.b,f.a,["peer:handshake","delegation:result"]);assert.throws(()=>receiveArtifactChunk(f.a.db,weak.peer,second),{code:"FORBIDDEN"});assert.throws(()=>receiveArtifactChunk(f.a.db,f.ba.peer,second),{code:"FORBIDDEN"});
});

test("received bytes are not verified when actual content contradicts the run-bound Git manifest",()=>{
 const f=fileCandidate(),raw=Buffer.from(f.b.db.prepare("SELECT payload FROM artifact_transfers WHERE transfer_id=?").get(f.t.transfer_id).payload),p=JSON.parse(raw),content=Buffer.from(p.files[0].content,"base64");content[0]^=1;p.files[0].content=content.toString("base64");const bytes=Buffer.from(canonical(p)),h={...f.t.header,payload_bytes:bytes.length,payload_sha256:contentHash(bytes)};
 assert.equal(upload(f,h,bytes).state,"received");const before=transferRows(f.a.db);assert.throws(()=>verifyArtifact(f.a.db,{transferId:f.t.transfer_id}),{code:"OBJECT_CORRUPT"});assert.equal(transferRows(f.a.db),before);assert.equal(artifactState(f.a.db,f.t.transfer_id).verification,null);assert.equal(git(f.receiverRoot,["rev-parse","HEAD"]),f.base);
});

test("cancellation and rejection stop further bytes while retaining earlier chunks",()=>{
 for(const cancelled of [true,false]){const f=fileCandidate();receiveArtifactOffer(f.a.db,f.ba.peer,f.t.header);receiveArtifactChunk(f.a.db,f.ba.peer,artifactChunk(f.b.db,{transferId:f.t.transfer_id,index:0}));if(cancelled)cancel(f);else reject(f,f.r);const before=transferRows(f.a.db);assert.throws(()=>receiveArtifactChunk(f.a.db,f.ba.peer,artifactChunk(f.b.db,{transferId:f.t.transfer_id,index:1})),{code:"RESULT_NOT_PENDING"});assert.equal(transferRows(f.a.db),before);assert.equal(peerArtifactStatus(f.a.db,f.ba.peer,{transfer_id:f.t.transfer_id,header_digest:f.t.header_digest}).next_chunk,1);}
});

test("source receipt audit failures roll back sender acknowledgement and malformed progress cannot advance it",()=>{
 const f=fileCandidate(),ack=upload(f),before=transferRows(f.b.db);f.b.db.exec("CREATE TRIGGER injected BEFORE INSERT ON artifact_events BEGIN SELECT RAISE(ABORT,'receipt fault'); END");assert.throws(()=>recordArtifactProgress(f.b.db,{transferId:f.t.transfer_id,response:ack}),/receipt fault/);assert.equal(transferRows(f.b.db),before);f.b.db.exec("DROP TRIGGER injected");
 for(const bad of [{...ack,accepted:true},{...ack,received_bytes:1},{...ack,receipt:{...ack.receipt,target_epoch:randomUUID()}},{...ack,state:"content_verified"},{...ack,verification:{...ack.receipt,kind:"artifact_content_verified",mapping_id:randomUUID()}}]){assert.throws(()=>recordArtifactProgress(f.b.db,{transferId:f.t.transfer_id,response:bad}));assert.equal(transferRows(f.b.db),before);}
 assert.equal(recordArtifactProgress(f.b.db,{transferId:f.t.transfer_id,response:ack}).state,"received");assert.throws(()=>recordArtifactProgress(f.b.db,{transferId:f.t.transfer_id,response:{...ack,receipt:null,state:"receiving"}}),{code:"RECEIPT_MISMATCH"});
});

test("credential revocation during HTTP chunk upload prevents persistence and later verification",async()=>{
 const f=fileCandidate();receiveArtifactOffer(f.a.db,f.ba.peer,f.t.header);const body=JSON.stringify(artifactChunk(f.b.db,{transferId:f.t.transfer_id,index:0})),url=await network(f.a),server=servers.at(-1),before=transferRows(f.a.db);let notify;
 const uploading=new Promise(resolve=>notify=resolve);server.once("request",()=>notify());
 const response=new Promise((resolve,reject)=>{const req=http.request(url+"/peer/v1/artifact/chunk",{method:"POST",headers:{Authorization:f.ba.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);const split=Math.floor(body.length/2);req.write(body.slice(0,split));uploading.then(()=>{revokePeer(f.a.db,{peerNodeId:f.b.node.node_id,expectedVersion:f.ba.peer.credential_version});req.end(body.slice(split));}).catch(reject);});
 assert.equal(await response,401);assert.equal(transferRows(f.a.db),before);
 f.ba=grant(f.b,f.a,["peer:handshake","delegation:result","artifact:write"]);upload(f);revokePeer(f.a.db,{peerNodeId:f.b.node.node_id,expectedVersion:f.ba.peer.credential_version});assert.throws(()=>verifyArtifact(f.a.db,{transferId:f.t.transfer_id}),{code:"FORBIDDEN"});assert.equal(artifactState(f.a.db,f.t.transfer_id).verification,null);
});

test("declared storage includes retained old-epoch transfers and refuses excess before accepting bytes",()=>{
 const f=fileCandidate(),h=f.t.header;
 // Simulate prior durable reservations without allocating hundreds of MB in a test.
 for(let i=0;i<6;i++){const id=randomUUID(),prior={...h,transfer_id:id,result_id:randomUUID(),payload_bytes:48*1024*1024};f.a.db.prepare("INSERT INTO artifact_transfers VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,prior.result_id,"source",f.a.node.node_id,randomUUID(),canonical(prior),digest(prior),prior.payload_bytes,null,new Date().toISOString());}
 const before=transferRows(f.a.db);assert.throws(()=>receiveArtifactOffer(f.a.db,f.ba.peer,h),{code:"ARTIFACT_STORAGE_LIMIT"});assert.equal(transferRows(f.a.db),before);assert.equal(f.a.db.prepare("SELECT count(*) n FROM artifact_chunks").get().n,0);
});

test("backup activation retains received bytes but cannot reuse previous node-epoch grants or receipts",()=>{
 const f=fileCandidate();upload(f);verifyArtifact(f.a.db,{transferId:f.t.transfer_id});const before=transferRows(f.a.db),evidence=join(TMP,"evidence-"+serial++);mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"actual artifact fixture");
 const backup=createBackup({dbPath:f.a.path,evidenceDir:evidence,destination:join(TMP,"backup-"+serial++)}),destination=join(TMP,"restored-"+serial++);restoreBackup({backupDirectory:backup.destination,destination});const dbPath=join(destination,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);assert.equal(transferRows(db),before);assert.throws(()=>artifactState(db,f.t.transfer_id),{code:"RESTORE_HOLD"});
 retireNode({dbPath:f.a.path,expectedEpoch:f.a.node.sync_epoch});const plan=prepareRecovery({dbPath});activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated actual artifact fixture",attested_at:new Date().toISOString()}});
 migrateArtifacts(db);assert.equal(transferRows(db),before);assert.throws(()=>verifyArtifact(db,{transferId:f.t.transfer_id}),{code:"ARTIFACT_RECOVERY_REQUIRED"});assert.throws(()=>captureVerifiedArtifact(db,{transferId:f.t.transfer_id}),{code:"ARTIFACT_RECOVERY_REQUIRED"});assert.equal(db.prepare("SELECT count(*) n FROM artifact_chunks").get().n,Math.ceil(f.t.header.payload_bytes/CHUNK_BYTES));
});

test("artifact capacity reports all epoch reservations without changing peer progress fields",()=>{
 const f=fileCandidate(),s=artifactState(f.b.db,f.t.transfer_id),expected=f.t.header.payload_bytes+Buffer.byteLength(canonical(f.t.header));assert.equal(s.storage.used_bytes,expected);assert.equal(s.storage.remaining_bytes,MAX_ARTIFACT_STORAGE-expected);assert.equal(s.storage.sqlite_file_bytes_reclaimed,false);
 const h=f.t.header,id=randomUUID(),old={...h,transfer_id:id,result_id:randomUUID()};f.a.db.prepare('INSERT INTO artifact_transfers VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,old.result_id,'source',f.a.node.node_id,randomUUID(),canonical(old),digest(old),old.payload_bytes,null,new Date().toISOString());const ack=receiveArtifactOffer(f.a.db,f.ba.peer,h);assert.equal(Object.hasOwn(ack,'storage'),false);assert.equal(recordArtifactProgress(f.b.db,{transferId:f.t.transfer_id,response:ack}).state,'prepared');
 const cli=JSON.parse(execFileSync(process.execPath,[join(ROOT,'cli/artifact.mjs'),'capacity','--db',f.a.path],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));assert.equal(cli.reserved_transfers,2);assert.equal(cli.used_bytes,expected+old.payload_bytes+Buffer.byteLength(canonical(old)));assert.equal(artifactState(f.a.db,h.transfer_id).storage.remaining_bytes,cli.remaining_bytes);
});
