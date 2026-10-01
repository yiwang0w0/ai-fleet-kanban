import {readFleetTask,readFleetSnapshot} from "../core/fleet-view.mjs";
import {evidenceMarkdown} from "../core/context-evidence.mjs";
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
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,openSync,ftruncateSync,closeSync} from "node:fs";
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
const TMP=mkdtempSync(join(tmpdir(),"fleet-artifact-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}rmSync(TMP,{recursive:true,force:true});});
function node(){const dir=join(TMP,"n"+serial++);mkdirSync(dir);const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateBindings(db);migrateResults(db);migrateRelations(db);return {db,dir,path,node:localIdentity(db)};}
function grant(a,b,scopes=["peer:handshake","delegation:offer","delegation:status","delegation:binding","delegation:control","delegation:result","delegation:complete"],projects=["demo"]){const file=join(TMP,"grant"+serial+++".json");issueCredential(b.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes,projects,credentialFile:file,expectedVersion:b.db.prepare("SELECT credential_version FROM federation_peers WHERE peer_node_id=?").get(a.node.node_id)?.credential_version});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(b.db,"Bearer "+c.token)};}
function card(f,extra={}){const id=store.add(f.db,{subject:"work "+serial++,description:"requested work",acceptance:"review evidence",treeMode:"hierarchical",route:"mcp",released:1,...extra}),t=store.get(f.db,id);enrollTask(f.db,{id,projectId:"demo",workKind:"implement",capabilities:["workspace-files"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
function register(f,owner,g){bindTopology(owner.db,{projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,registrarNodeId:f.r.node.node_id,registrarEpoch:f.r.node.sync_epoch});const op=prepareTopology(owner.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:0}),args=startTopologyAttempt(owner.db,{operationId:op.operation_id,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.registrar.db,g.peer,args);acceptTopologyReceipt(owner.db,{operationId:op.operation_id,requestId:args.request_id,receipt});}
function fixture({withThird=false,sourceParent=false,sourceSibling=false,sourceChild=false,registrarOnSource=false}={}){
 const a=node(),b=node(),r=registrarOnSource?a:node(),parent=sourceParent?card(a,{kind:"goal"}):null,source=card(a,parent?{parentId:parent.id,provesParent:true,oneofKey:"candidate-options"}:{}),sibling=sourceSibling?card(a,{parentId:parent.id,oneofKey:"candidate-options"}):null,child=sourceChild?card(a,{parentId:source.id}):null;
 if(parent)a.db.prepare("UPDATE tasks SET status='waiting',waiting_for='review',auto_review_at='2000-01-01T00:00:00Z',review_fp='old-review' WHERE id=?").run(parent.id);
 if(child)a.db.prepare("UPDATE tasks SET status='done',verdict='approve' WHERE id=?").run(child.id);
 const ab=grant(a,b),ar=r===a?{file:null,peer:localRegistrarPeer(a.db,"demo")}:grant(a,r,["peer:handshake","relations:read","relations:approve","relations:publish","relations:complete"]),br=grant(b,r,["peer:handshake","relations:read","relations:approve","relations:publish","relations:complete"]);
 const out=createIntent(a.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:b.node.node_id,targetEpoch:b.node.sync_epoch});receiveOffer(b.db,ab.peer,out.offer);
 const accepted=decideIncoming(b.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"fixture"});
 recordReceipt(a.db,out.delegation_id,accepted);
 const target=store.get(b.db,b.db.prepare("SELECT id FROM tasks WHERE task_uid=?").get(accepted.target_task_uid).id);
 const c=withThird?node():null,g=createRelationGraph(r.db,{projectId:"demo",members:[a,b,...(c?[c]:[])].map(x=>({node_id:x.node.node_id,node_epoch:x.node.sync_epoch}))}),f={a,b,c,r,registrar:r,g,ab,ar,br,source,target,out,parent,sibling,child};
 register(f,a,ar);register(f,b,br);
 f.d={schema_version:1,type:"delegation",relation_id:randomUUID(),delegation_id:out.delegation_id,project_id:"demo",graph_id:g.graph_id,graph_epoch:g.graph_epoch,source_node_id:a.node.node_id,source_epoch:a.node.sync_epoch,source_task_uid:source.task_uid,target_node_id:b.node.node_id,target_epoch:b.node.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest,source_topology_revision:1,target_topology_revision:1};
 return f;
}
function prepare(f,which){const owner=f[which],task=which==="a"?f.source:f.target;return prepareBinding(owner.db,{relation:f.d,expectedTaskVersion:store.get(owner.db,task.id).aggregate_version});}
function approve(f,which){const owner=f[which],args=startBindingAttempt(owner.db,{relationId:f.d.relation_id,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=approveRelation(f.registrar.db,f[which+"r"].peer,args);return acceptBindingReceipt(owner.db,{relationId:f.d.relation_id,requestId:args.request_id,receipt});}
function send(f,kind){const body=bindingMessage(f.a.db,{relationId:f.d.relation_id,kind}),receipt=receiveBindingMessage(f.b.db,f.ab.peer,body);return recordBindingMessage(f.a.db,{requestId:body.request_id,receipt});}
function begin(f){prepare(f,"a");approve(f,"a");send(f,"proposal");prepare(f,"b");}
function finish(f){approve(f,"b");const receipt=relationStatus(f.registrar.db,f.ar.peer,{project_id:"demo",graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:f.d.relation_id});acceptBindingReceipt(f.a.db,{relationId:f.d.relation_id,receipt});send(f,"source_ready");return receipt;}

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
 const before=topologyState(owner.db,"demo"),op=prepareTopology(owner.db,{projectId:"demo",operationId:randomUUID(),expectedRevision:before.revision,edits}),args=startTopologyAttempt(owner.db,{operationId:op.operation_id,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version}),receipt=publishTopology(f.registrar.db,credential.peer,args);acceptTopologyReceipt(owner.db,{operationId:op.operation_id,requestId:args.request_id,receipt});return op;
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

function fileCandidate({register=true,receiveReport=true,prepareTransfer=true,objectFormat="sha1",...options}={}){
 const f=fullyBound(options),w=worker(f),root=join(TMP,"repo"+serial++);mkdirSync(root);mkdirSync(join(root,"src"));
 writeFileSync(join(root,"src","base.txt"),"original\r\n中文\r\n");writeFileSync(join(root,"private.txt"),"unchanged baseline; local full-read grant required\n");
 git(root,["init","--quiet","--template=","--object-format="+objectFormat]);git(root,["-c","core.autocrlf=false","add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","approved base"]);const base=git(root,["rev-parse","HEAD"]),receiverRoot=join(TMP,"receiver"+serial++);
 git(TMP,["clone","--quiet","--no-hardlinks",root,receiverRoot]);
 const map=(n,root)=>registerRepository(n.db,{mappingId:randomUUID(),projectId:"demo",repoId:"app",root,git:pinnedGit,baseCommit:base,paths:["src/"]});
 const senderMapping=map(f.b,root),receiverMapping=map(f.a,receiverRoot),poolRoot=join(TMP,"pool"+serial++);mkdirSync(poolRoot);const pool=registerWorkspacePool(f.b.db,{poolId:randomUUID(),mappingId:senderMapping.mapping_id,root:poolRoot,allowFullHistoryCopy:true});
 const workspaceId=randomUUID();createTaskWorkspace(f.b.db,{workspaceId,poolId:pool.pool_id,dispatchId:w.w.dispatch_id,baseCommit:base,writePaths:["src/"]});const descriptor=prepareWorkspaceSession(f.b.db,{workspaceId});
 const execution={format:"ai-fleet-process/v2",adapter_contract:"ai-fleet-adapter/workspace-files-v1",workspace:descriptor,adapter_digest:"1".repeat(64),runtime:"claude",model:"fixture-model",effort:"low",run_id:w.w.run_id,agent_instance_id:w.w.agent_instance_id,principal_id:w.w.principal_id,command_sha256:"2".repeat(64),python_sha256:"3".repeat(64),files_digest:"4".repeat(64),prompt_sha256:"5".repeat(64),environment_sha256:"6".repeat(64),timeout_ms:5000,heartbeat_ms:50,stderr_limit:1024};
 authorizeLaunch(f.b.db,{dispatchId:w.w.dispatch_id,sourceGate,execution});
 const workerFile=JSON.parse(readFileSync(w.workerCredentialFile,"utf8"));
 const auth="Bearer "+workerFile.token;
 for(const [path,content] of [["src/generated.mjs","export const result=42;\n/*"+"x".repeat(45000)+"*/\n"],["src/note1.txt","a".repeat(45000)],["src/note2.txt","b".repeat(45000)]])callTool(f.b.db,auth,"edit_workspace_file",{request_id:randomUUID(),task_uid:f.target.task_uid,path,expected_version:0,offset:0,delete_bytes:0,content,executable:false});
 const observation=observed(execution);finishDispatch(f.b.db,{dispatchId:w.w.dispatch_id,result:{status:observation.status,evidence:observation.evidence,usage:null},observation});commitWorkspaceSession(f.b.db,{workspaceId});const r=candidate(f),ba=grant(f.b,f.a,["peer:handshake","delegation:result","artifact:write","delegation:complete",...(f.registrar===f.a?["relations:read","relations:approve","relations:publish","relations:complete"]:[])]);if(f.registrar===f.a)f.br=ba;
 migrateArtifacts(f.a.db);migrateArtifacts(f.b.db);
 if(receiveReport){const ack=receiveResult(f.a.db,ba.peer,r.body);recordResultReceipt(f.b.db,{resultId:r.result_id,receipt:ack});}
 const targetArgs={resultId:r.result_id,mappingId:receiverMapping.mapping_id,baseCommit:base,allowFullBaselineRead:true};if(register&&receiveReport)registerArtifactTarget(f.a.db,targetArgs);
 const t=prepareTransfer?prepareArtifact(f.b.db,{resultId:r.result_id,transferId:randomUUID()}):null;return {...f,registrar:f.r,w,r,t,ba,root,base,receiverRoot,receiverMapping,targetArgs,workspaceId};
}
function upload(f,h=f.t.header,bytes=null){receiveArtifactOffer(f.a.db,f.ba.peer,h);const n=Math.ceil(h.payload_bytes/CHUNK_BYTES);for(let i=0;i<n;i++){const chunk=bytes?{transfer_id:h.transfer_id,header_digest:digest(h),chunk_index:i,sha256:contentHash(bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)),content:bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES).toString("base64")}:artifactChunk(f.b.db,{transferId:h.transfer_id,index:i});receiveArtifactChunk(f.a.db,f.ba.peer,chunk);}return sealArtifact(f.a.db,f.ba.peer,{transfer_id:h.transfer_id,header_digest:digest(h)});}
const transferRows=db=>JSON.stringify(Object.fromEntries(["artifact_targets","artifact_transfers","artifact_chunks","artifact_receipts","artifact_events"].map(t=>[t,db.prepare("SELECT * FROM "+t+" ORDER BY rowid").all()])));


import {materializeVerificationInput,assertVerificationInput} from "../core/verification/workspace.mjs";
import {workspaceRepositorySource} from "../core/artifacts/repositories.mjs";
import {superviseCommand} from "../core/execution/supervisor.mjs";
function receivedInput(){const f=fileCandidate();upload(f);verifyArtifact(f.a.db,{transferId:f.t.transfer_id});const captured=captureVerifiedArtifact(f.a.db,{transferId:f.t.transfer_id}),source=workspaceRepositorySource(f.a.db,{mappingId:f.receiverMapping.mapping_id,baseCommit:f.base}),container=join(TMP,"verification-"+serial++);return {f,args:{source,container,packageBytes:captured.bytes,manifest:captured.header.manifest,manifestDigest:captured.header.manifest_digest,allowFullHistoryCopy:true}};}
import {registerVerificationProfile,revokeVerificationProfile,prepareVerification,executeVerification,reconcileVerification,verificationState,captureVerificationReceipt} from "../core/verification/service.mjs";
function localCheck(f,code="console.log('source check passed');",overrides={}){
 const checker=join(TMP,"local-check-"+serial+++".mjs"),poolRoot=join(TMP,"verify-pool-"+serial++);mkdirSync(poolRoot);writeFileSync(checker,code);
 const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys;print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim());
 const definition={command:pinFile(process.execPath),python,pins:[pinFile(checker)],args:[checker],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),timeout_ms:5000,heartbeat_ms:100,stdout_limit:8192,stderr_limit:8192,...overrides};
 const config={profileId:randomUUID(),mappingId:f.receiverMapping.mapping_id,poolRoot,allowFullHistoryCopy:true,definition,sourceGate},profile=registerVerificationProfile(f.a.db,config);
 return {config,profile,checker,poolRoot,verificationId:randomUUID(),transferId:f.t.transfer_id,profileId:profile.profile_id,sourceGate};
}
function readyCheck(code,overrides){const {f}=receivedInput(),v=localCheck(f,code,overrides);prepareVerification(f.a.db,v);return {f,v};}


import {registerIntegrationPolicy,revokeIntegrationPolicy,prepareIntegration,executeIntegration,reconcileIntegration,captureAppliedIntegration,integrationState,abandonIntegration} from "../core/integration/service.mjs";
import {integrationRef,integrationGit,sourceIdentities} from "../core/integration/git.mjs";
async function mergeFixture(options={}){
 const f=fileCandidate(options);upload(f);verifyArtifact(f.a.db,{transferId:f.t.transfer_id});const v=localCheck(f,"import {pathToFileURL} from 'node:url';import {join} from 'node:path';import assert from 'node:assert/strict';const {result}=await import(pathToFileURL(join(process.cwd(),'src/generated.mjs')));assert.equal(result,42);console.log('source checked actual module');");prepareVerification(f.a.db,v);const verified=await executeVerification(f.a.db,v);assert.equal(verified.receipt.checks_passed,true);
 const poolRoot=join(TMP,"integration-pool-"+serial++);mkdirSync(poolRoot);const ref="refs/heads/fleet-integration-"+serial++;git(f.receiverRoot,["update-ref",ref,f.base]);
 const config={policyId:randomUUID(),mappingId:f.receiverMapping.mapping_id,ref,poolRoot,allowVerifiedContentMerge:true,exclusiveRefManagement:true,sourceGate};registerIntegrationPolicy(f.a.db,config);
 const args={integrationId:randomUUID(),policyId:config.policyId,verificationId:v.verificationId,sourceGate};return {f,v,config,args};
}
const refValue=(f,ref)=>git(f.receiverRoot,["rev-parse",ref]);
function concurrentCommit(f){return git(f.receiverRoot,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit-tree",git(f.receiverRoot,["rev-parse",f.base+"^{tree}"]),"-p",f.base,"-m","independent source change"]);}


import {migrateCompletion,prepareCompletion,completionState,receiveCompletion,recordCompletionReady,startCompletionAttempt,recordCompletionRetirement,settleCompletion} from "../core/federation/completion.mjs";
import {deliverCompletion,submitCompletion} from "../core/federation/completion-client.mjs";
import {completeRelation,localRegistrarPeer} from "../core/federation/relations.mjs";
async function completionFixture(options={}){const x=await mergeFixture(options),{f,args}=x;prepareIntegration(f.a.db,args);executeIntegration(f.a.db,args);for(const n of [f.a,f.b])migrateCompletion(n.db);const completionId=randomUUID(),completeArgs={completionId,integrationId:args.integrationId,expectedSourceVersion:store.get(f.a.db,f.source.id).aggregate_version,note:"operator reviewed actual fixture output",allowFixture:true,sourceGate:args.sourceGate};return {...x,completionId,completeArgs};}
function readyBoth(x){const {f,completeArgs,completionId}=x,s=prepareCompletion(f.a.db,completeArgs),ack=receiveCompletion(f.b.db,f.ab.peer,s.plan);recordCompletionReady(f.a.db,{completionId,ready:ack});return s;}
function retireBoth(x){const {f,completionId}=x;let a=startCompletionAttempt(f.a.db,{completionId,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version}),pending=completeRelation(f.registrar.db,f.ar.peer,a);recordCompletionRetirement(f.a.db,{completionId,requestId:a.request_id,receipt:pending});a=startCompletionAttempt(f.b.db,{completionId,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version});const receipt=completeRelation(f.registrar.db,f.br.peer,a);recordCompletionRetirement(f.b.db,{completionId,requestId:a.request_id,receipt});recordCompletionRetirement(f.a.db,{completionId,receipt});return receipt;}
test("actual source integration becomes accepted only after bilateral readiness and registrar completion, then both tasks settle once",async()=>{
 const x=await completionFixture(),{f,completionId,completeArgs}=x;const beforeTrace=readFleetTask(f.a.db,f.source.task_uid).evidence;assert.equal(beforeTrace.artifacts.total,1);assert.equal(beforeTrace.verifications.items[0].checks_passed,true);assert.equal(beforeTrace.integrations.items[0].source_applied,true);assert.equal(beforeTrace.completions.total,0);const s=readyBoth(x);assert.equal(s.accepted,false);assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);assert.throws(()=>settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate}),{code:"COMPLETION_NOT_RETIRED"});
 const receipt=retireBoth(x);assert.equal(receipt.completed,true);assert.equal(bindingState(f.a.db,f.d.relation_id).state,"confirmed");const source=settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate});assert.equal(source.accepted,true);assert.equal(store.get(f.a.db,f.source.id).status,"done");assert.equal(bindingState(f.a.db,f.d.relation_id).state,"completed");assert.equal(resultState(f.a.db,f.r.result_id).state,"accepted");
 const target=settleCompletion(f.b.db,{completionId});assert.equal(target.accepted,true);assert.equal(store.get(f.b.db,f.target.id).status,"done");assert.equal(bindingState(f.b.db,f.d.relation_id).state,"completed");assert.deepEqual(settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate}),source);assert.deepEqual(settleCompletion(f.b.db,{completionId}),target);assert.equal(f.registrar.db.prepare("SELECT count(*) n FROM relation_edges").get().n,1);assert.equal(f.registrar.db.prepare("SELECT count(*) n FROM relation_completions").get().n,1);assert.equal(f.a.db.prepare("SELECT count(*) n FROM completion_write_permits").get().n,0);
 const trace=readFleetTask(f.a.db,f.source.task_uid).evidence;assert.equal(trace.completions.items[0].historical_accepted,true);assert.equal(trace.completions.items[0].fixture_runs,1);assert.equal(trace.results.items[0].accepted,false);assert.equal(trace.relations.items[0].closed,true);const catalog=readFleetSnapshot(f.a.db,{includeEvidence:true}),markdown=evidenceMarkdown(catalog).markdown;assert.ok(markdown.includes(trace.artifacts.items[0].commit));assert.ok(markdown.includes(trace.verifications.items[0].verification_id));assert.ok(markdown.includes('"historical_accepted": true'));assert.ok(!JSON.stringify(trace).includes(f.a.dir));
 const receiptTriggers=f.a.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='completion_settlements'").all();for(const t of receiptTriggers)f.a.db.exec('DROP TRIGGER "'+t.name+'"');f.a.db.prepare("UPDATE completion_settlements SET receipt_digest=? WHERE completion_id=?").run("0".repeat(64),completionId);const corrupt=readFleetTask(f.a.db,f.source.task_uid).evidence.completions.items[0];assert.equal(corrupt.historical_accepted,false);assert.equal(corrupt.receipt_state,"unverified");
});

test("HTTP lost readiness and retirement ACKs resume original intents after reopening databases",async()=>{
 const x=await completionFixture(),{f,completionId,completeArgs}=x;prepareCompletion(f.a.db,completeArgs);const targetUrl=await network(f.b),registrarUrl=await network(f.registrar);let loseReady=true;
 const lostReady=async(url,options)=>{const r=await fetch(url,options);if(String(url).endsWith("/delegation/complete")&&loseReady){loseReady=false;await r.arrayBuffer();throw Error("fixture lost ready ACK");}return r;};
 assert.equal((await deliverCompletion(f.a.db,{completionId,url:targetUrl,credentialFile:f.ab.file,fetchImpl:lostReady})).delivery_state,"retry_pending");assert.equal(completionState(f.b.db,completionId).phase,"ready");assert.equal(completionState(f.a.db,completionId).phase,"prepared");
 const reopened=new DatabaseSync(f.a.path);dbs.push(reopened);assert.equal((await deliverCompletion(reopened,{completionId,url:targetUrl,credentialFile:f.ab.file})).delivery_state,"acknowledged");assert.equal(f.b.db.prepare("SELECT count(*) n FROM completion_ready").get().n,1);
 assert.equal((await submitCompletion(reopened,{completionId,url:registrarUrl,credentialFile:f.ar.file})).delivery_state,"waiting_peer");let loseRetirement=true;
 const lostRetirement=async(url,options)=>{const r=await fetch(url,options);if(String(url).endsWith("/relations/complete")&&loseRetirement){loseRetirement=false;await r.arrayBuffer();throw Error("fixture lost completion ACK");}return r;};
 assert.equal((await submitCompletion(f.b.db,{completionId,url:registrarUrl,credentialFile:f.br.file,fetchImpl:lostRetirement})).delivery_state,"retry_pending");assert.equal(f.registrar.db.prepare("SELECT count(*) n FROM relation_completions").get().n,1);const reopenedTarget=new DatabaseSync(f.b.path);dbs.push(reopenedTarget);
 assert.equal((await submitCompletion(reopenedTarget,{completionId,url:registrarUrl,credentialFile:f.br.file})).phase,"retired");assert.equal((await submitCompletion(reopened,{completionId,mode:"poll",url:registrarUrl,credentialFile:f.ar.file})).phase,"retired");
 assert.equal(settleCompletion(reopened,{completionId,sourceGate:completeArgs.sourceGate}).accepted,true);assert.equal(settleCompletion(reopenedTarget,{completionId}).accepted,true);assert.equal(reopenedTarget.prepare("SELECT count(*) n FROM completion_registrar_attempts").get().n,1);const cli=JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli/completion.mjs"),"get","--db",f.a.path,"--id",completionId],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}));assert.equal(cli.accepted,true);
});
test("settlement failure rolls back task, result, binding closure, permits and parent advancement on both endpoints",async()=>{
 const x=await completionFixture(),{f,completionId,completeArgs}=x;readyBoth(x);retireBoth(x);
 for(const n of [f.a,f.b]){const id=n===f.a?f.source.id:f.target.id,before=canonical({...store.get(n.db,id)});n.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON completion_settlements BEGIN SELECT RAISE(ABORT,'fixture settlement rollback'); END");assert.throws(()=>settleCompletion(n.db,{completionId,sourceGate:completeArgs.sourceGate}),/fixture settlement rollback/);assert.equal(canonical({...store.get(n.db,id)}),before);assert.equal(bindingState(n.db,f.d.relation_id).state,"confirmed");assert.equal(resultState(n.db,f.r.result_id).accepted,false);assert.equal(n.db.prepare("SELECT count(*) n FROM completion_write_permits").get().n,0);assert.equal(n.db.prepare("SELECT count(*) n FROM binding_completions").get().n,0);n.db.exec("DROP TRIGGER fail_completion");assert.equal(settleCompletion(n.db,{completionId,sourceGate:completeArgs.sourceGate}).accepted,true);}
});
test("fixture approval is explicit, malformed or unauthorized source plans cannot seal the target, and committed scope cannot grow",async()=>{
 const x=await completionFixture({sourceChild:true}),{f,completionId,completeArgs}=x;assert.throws(()=>prepareCompletion(f.a.db,{...completeArgs,allowFixture:false}),{code:"BAD_COMPLETION"});assert.throws(()=>prepareCompletion(f.a.db,{...completeArgs,expectedSourceVersion:completeArgs.expectedSourceVersion+1}),{code:"COMPLETION_TASK_HELD"});assert.equal(f.a.db.prepare("SELECT count(*) n FROM completion_plans").get().n,0);
 const s=prepareCompletion(f.a.db,completeArgs);assert.throws(()=>receiveCompletion(f.b.db,{...f.ab.peer,scopes:f.ab.peer.scopes.filter(x=>x!=="delegation:complete")},s.plan),{code:"FORBIDDEN"});assert.throws(()=>receiveCompletion(f.b.db,f.ab.peer,{...s.plan,body_digest:"0".repeat(64)}),{code:"COMPLETION_RESULT_CHANGED"});assert.equal(f.b.db.prepare("SELECT count(*) n FROM completion_plans").get().n,0);
 assert.throws(()=>f.a.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(f.child.id),/COMPLETION_COMMITTED/);assert.throws(()=>card(f.a,{parentId:f.source.id}),/COMPLETION_COMMITTED/);assert.throws(()=>cancel(f),/COMPLETION_COMMITTED/);assert.throws(()=>rejectResult(f.a.db,{resultId:f.r.result_id,decisionId:randomUUID(),expectedSourceVersion:completeArgs.expectedSourceVersion,note:"cannot replace committed approval"}),/COMPLETION_COMMITTED/);
 const workerAuth="Bearer "+JSON.parse(readFileSync(f.w.workerCredentialFile,"utf8")).token;assert.throws(()=>callTool(f.b.db,workerAuth,"prepare_completion",{completion_id:completionId}));assert.equal(resultState(f.b.db,f.r.result_id).accepted,false);
});
test("registrar ignores revoked completion votes, requires both current endpoint credentials and retains the original edge",async()=>{
 const x=await completionFixture(),{f,completionId}=x;readyBoth(x);let args=startCompletionAttempt(f.a.db,{completionId,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version}),pending=completeRelation(f.registrar.db,f.ar.peer,args);recordCompletionRetirement(f.a.db,{completionId,requestId:args.request_id,receipt:pending});
 revokePeer(f.registrar.db,{peerNodeId:f.a.node.node_id,expectedVersion:f.ar.peer.credential_version});args=startCompletionAttempt(f.b.db,{completionId,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version});pending=completeRelation(f.registrar.db,f.br.peer,args);assert.equal(pending.completed,false);assert.deepEqual(pending.approved_by,[f.b.node.node_id]);recordCompletionRetirement(f.b.db,{completionId,requestId:args.request_id,receipt:pending});assert.throws(()=>completeRelation(f.registrar.db,f.ar.peer,{...args,request_id:randomUUID()}),{code:"AUTHORIZATION_CHANGED"});
 const renewed=grant(f.a,f.registrar,["peer:handshake","relations:read","relations:approve","relations:publish","relations:complete"]);args=startCompletionAttempt(f.a.db,{completionId,expectedVersion:f.registrar.db.prepare("SELECT version FROM relation_graphs").get().version});const done=completeRelation(f.registrar.db,renewed.peer,args);assert.equal(done.completed,true);assert.equal(done.approved_by.find(a=>a.node_id===f.a.node.node_id).credential_version,renewed.peer.credential_version);assert.throws(()=>recordCompletionRetirement(f.a.db,{completionId,receipt:{...done,approved_by:done.approved_by.slice(0,1)}}),{code:"BAD_COMPLETION"});recordCompletionRetirement(f.a.db,{completionId,requestId:args.request_id,receipt:done});assert.equal(f.registrar.db.prepare("SELECT count(*) n FROM relation_edges").get().n,1);
});
test("source ref changes or revoked integration authority prevent acceptance after registrar completion",async()=>{
 const x=await completionFixture(),{f,completionId,completeArgs,config}=x;readyBoth(x);retireBoth(x);const acceptedRef=refValue(f,config.ref),other=concurrentCommit(f);git(f.receiverRoot,["update-ref",config.ref,other,acceptedRef]);assert.throws(()=>settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate}),{code:"INTEGRATION_EFFECT_UNCONFIRMED"});assert.equal(refValue(f,config.ref),other);assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);assert.equal(bindingState(f.a.db,f.d.relation_id).state,"confirmed");
 git(f.receiverRoot,["update-ref",config.ref,acceptedRef,other]);revokeIntegrationPolicy(f.a.db,{policyId:config.policyId});assert.throws(()=>settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate}),{code:"INTEGRATION_REVOKED"});assert.equal(completionState(f.a.db,completionId).phase,"retired");assert.equal(store.get(f.a.db,f.source.id).status,"not_started");
});
test("verified child completion never rubber-stamps parent or alternative sibling, and reopens only an eligible parent review",async()=>{
 for(const variant of ["sibling","review","human"]){const sourceSibling=variant==="sibling",x=await completionFixture({sourceParent:true,sourceSibling}),{f,completionId,completeArgs}=x;assert.equal(store.get(f.a.db,f.source.id).proves_parent,true);if(variant==="human")f.a.db.prepare("UPDATE tasks SET human_gate=1,human_gate_src='explicit' WHERE id=?").run(f.parent.id);readyBoth(x);retireBoth(x);settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate});const parent=store.get(f.a.db,f.parent.id);assert.equal(parent.status,"waiting");assert.equal(parent.resolved_by,null);if(sourceSibling){assert.equal(store.get(f.a.db,f.sibling.id).status,"not_started");assert.equal(parent.auto_review_at,"2000-01-01T00:00:00Z");}else if(variant==="human"){assert.equal(parent.human_gate,true);assert.equal(parent.auto_review_at,"2000-01-01T00:00:00Z");}else{assert.equal(parent.auto_review_at,null);assert.equal(f.a.db.prepare("SELECT review_fp FROM tasks WHERE id=?").get(f.parent.id).review_fp,null);assert.equal(parent.waiting_for,"review");}assert.equal(store.get(f.a.db,f.source.id).verify_ok,true);}
});
test("a source task changed to a human gate after verification cannot consume prior byte checks",async()=>{
 const x=await completionFixture(),{f,completeArgs}=x;f.a.db.prepare("UPDATE tasks SET human_gate=1,human_gate_src='explicit' WHERE id=?").run(f.source.id);assert.throws(()=>prepareCompletion(f.a.db,{...completeArgs,expectedSourceVersion:store.get(f.a.db,f.source.id).aggregate_version}),{code:"VERIFICATION_STALE"});assert.equal(f.a.db.prepare("SELECT count(*) n FROM completion_plans").get().n,0);assert.equal(store.get(f.a.db,f.source.id).human_gate,true);
});
test("closed bindings survive migration and old readiness replay without regaining execution authority",async()=>{
 const x=await completionFixture(),{f,completionId,completeArgs}=x;readyBoth(x);retireBoth(x);settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate});settleCompletion(f.b.db,{completionId});for(const n of [f.a,f.b])migrateCompletion(n.db);send(f,"source_ready");assert.equal(bindingState(f.b.db,f.d.relation_id).state,"completed");assert.equal(bindingState(f.b.db,f.d.relation_id).execution_authorized,false);assert.equal(bindingProposalState(f.b.db,f.d.relation_id).state,"completed");assert.equal(listBindings(f.b.db,{projectId:"demo"}).bindings[0].state,"completed");assert.throws(()=>f.b.db.prepare("UPDATE delegation_bindings SET closed=0 WHERE relation_id=?").run(f.d.relation_id),/binding/);
 for(const table of ["completion_plans","completion_members","completion_ready","completion_retirements","completion_settlements","binding_completions"])assert.throws(()=>f.a.db.exec("DELETE FROM "+table),/retained/);for(const table of ["relation_completion_proposals","relation_completion_votes","relation_completions"])assert.throws(()=>f.registrar.db.exec("DELETE FROM "+table),/retention/);
});

test("v2 binding migration adds lifecycle atomically and retains read-only inspection before upgrade",()=>{
 const f=fullyBound(),db=f.b.db;for(const r of db.prepare("SELECT type,name FROM sqlite_master WHERE type IN('trigger','index') AND sql LIKE '%closed%' AND (name LIKE 'binding_%' OR name='delegation_unconfirmed_execution')").all()){assert.match(r.name,/^[a-z_]+$/);db.exec("DROP "+r.type.toUpperCase()+" "+r.name);}db.exec("ALTER TABLE delegation_bindings DROP COLUMN closed; UPDATE binding_schema SET version=2; CREATE UNIQUE INDEX binding_one_delegation ON delegation_bindings(delegation_id) WHERE state IN('prepared','confirmed'); CREATE UNIQUE INDEX binding_one_task ON delegation_bindings(task_uid,side) WHERE state IN('prepared','confirmed')");
 const before=canonical({...db.prepare("SELECT * FROM delegation_bindings").get()}),ro=new DatabaseSync(f.b.path,{readOnly:true});dbs.push(ro);assert.equal(bindingState(ro,f.d.relation_id).state,"confirmed");assert.equal(bindingProposalState(ro,f.d.relation_id).state,"confirmed");assert.equal(listBindings(ro,{projectId:"demo"}).bindings[0].state,"confirmed");db.exec("CREATE TRIGGER fail_lifecycle BEFORE UPDATE ON binding_schema WHEN NEW.version=3 BEGIN SELECT RAISE(ABORT,'fixture lifecycle migration fault'); END");assert.throws(()=>migrateBindings(db),/fixture lifecycle migration fault/);assert.equal(db.prepare("PRAGMA table_info(delegation_bindings)").all().some(c=>c.name==="closed"),false);assert.equal(db.prepare("SELECT version FROM binding_schema").get().version,2);db.exec("DROP TRIGGER fail_lifecycle");migrateBindings(db);const after={...db.prepare("SELECT * FROM delegation_bindings").get()};assert.equal(after.closed,0);delete after.closed;assert.equal(canonical(after),before);assert.equal(bindingState(db,f.d.relation_id).state,"confirmed");
});
test("actual backup activation retains completion history but cannot consume old-epoch acceptance",async()=>{
 const x=await completionFixture(),{f,completionId}=x;readyBoth(x);const evidence=join(f.a.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic completion evidence");const backup=createBackup({dbPath:f.a.path,evidenceDir:evidence,destination:join(TMP,"completion-backup-"+serial++)}),dir=join(TMP,"completion-restore-"+serial++);restoreBackup({backupDirectory:backup.destination,destination:dir});const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);assert.throws(()=>completionState(db,completionId),{code:"RESTORE_HOLD"});retireNode({dbPath:f.a.path,expectedEpoch:f.a.node.sync_epoch});const plan=prepareRecovery({dbPath:path});activateRecovery({dbPath:path,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated completion fixture",attested_at:new Date().toISOString()}});assert.throws(()=>completionState(db,completionId),{code:"COMPLETION_RECOVERY_REQUIRED"});assert.equal(db.prepare("SELECT count(*) n FROM completion_plans").get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM result_recovery_permits").get().n,0);assert.equal(db.prepare("SELECT released FROM tasks WHERE id=?").get(f.source.id).released,0);
});
test("credential revoked during actual completion upload cannot persist target readiness",async()=>{
 const x=await completionFixture(),{f,completionId,completeArgs}=x,s=prepareCompletion(f.a.db,completeArgs),url=await network(f.b),body=Buffer.from(JSON.stringify(s.plan));const code=await new Promise((resolve,reject)=>{const req=http.request(url+"/peer/v1/delegation/complete",{method:"POST",headers:{authorization:f.ab.auth,"content-type":"application/json","content-length":body.length}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);req.write(body.subarray(0,12));setTimeout(()=>{try{revokePeer(f.b.db,{peerNodeId:f.a.node.node_id,expectedVersion:f.ab.peer.credential_version});req.end(body.subarray(12));}catch(e){req.destroy();reject(e);}},60);});assert.equal(code,401);assert.equal(f.b.db.prepare("SELECT count(*) n FROM completion_plans").get().n,0);assert.equal(completionState(f.a.db,completionId).phase,"prepared");
});
test("two independent source processes settle one acceptance without duplicate task or binding decisions",async()=>{
 const x=await completionFixture(),{f,completionId}=x;readyBoth(x);retireBoth(x);const script=join(TMP,"completion-concurrent-"+serial+++".mjs");writeFileSync(script,[
 'import {DatabaseSync} from "node:sqlite";',
 'import {settleCompletion} from '+JSON.stringify(new URL('../core/federation/completion.mjs',import.meta.url).href)+';',
 'const db=new DatabaseSync(process.argv[2]);db.exec("PRAGMA busy_timeout=5000");',
 'process.once("message",()=>{try{const sourceGate={check:()=>({code_root:process.argv[4],tree:"a".repeat(40),commit:"b".repeat(40)})};console.log(JSON.stringify(settleCompletion(db,{completionId:process.argv[3],sourceGate})));}catch(e){console.error(e.code,e.message);process.exitCode=1;}finally{db.close();process.disconnect();}});process.send("ready");'
 ].join("\n"));
 const children=[0,1].map(()=>{const p=spawn(process.execPath,[script,f.a.path,completionId,src],{stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);return {p,ready:new Promise((resolve,reject)=>{p.once("message",resolve);p.once("error",reject);p.once("exit",code=>{if(code!==0)reject(Error("startup "+code+" "+err));});}),done:new Promise((resolve,reject)=>{p.once("error",reject);p.once("close",code=>{if(code!==0)return reject(Error(err));try{resolve(JSON.parse(out));}catch(e){reject(e);}});})};});await Promise.all(children.map(c=>c.ready));for(const c of children)c.p.send("go");const values=await Promise.all(children.map(c=>c.done));assert.deepEqual(values[0],values[1]);assert.equal(values[0].accepted,true);assert.equal(f.a.db.prepare("SELECT count(*) n FROM result_decisions").get().n,1);assert.equal(f.a.db.prepare("SELECT count(*) n FROM binding_completions").get().n,1);assert.equal(f.a.db.prepare("SELECT count(*) n FROM task_events WHERE task_id=? AND kind='resolve'").get(f.source.id).n,1);
});


test("two-node layout co-locates registrar with source and completes over HTTP without a third node",async()=>{
 const x=await completionFixture({registrarOnSource:true}),{f,completionId,completeArgs}=x;assert.equal(f.registrar,f.a);assert.equal(new Set([f.a.node.node_id,f.b.node.node_id,f.registrar.node.node_id]).size,2);
 prepareCompletion(f.a.db,completeArgs);const targetUrl=await network(f.b),sourceUrl=await network(f.a);assert.equal((await deliverCompletion(f.a.db,{completionId,url:targetUrl,credentialFile:f.ab.file})).delivery_state,"acknowledged");
 assert.equal((await submitCompletion(f.a.db,{completionId})).delivery_state,"waiting_peer");const target=await submitCompletion(f.b.db,{completionId,url:sourceUrl,credentialFile:f.br.file});assert.equal(target.delivery_state,"acknowledged");assert.equal((await submitCompletion(f.a.db,{completionId,mode:"poll"})).phase,"retired");
 assert.equal(target.retirement.approved_by.find(v=>v.node_id===f.a.node.node_id).credential_version,0);assert.equal(target.retirement.approved_by.find(v=>v.node_id===f.b.node.node_id).credential_version,f.br.peer.credential_version);
 assert.equal(settleCompletion(f.a.db,{completionId,sourceGate:completeArgs.sourceGate}).accepted,true);assert.equal(settleCompletion(f.b.db,{completionId}).accepted,true);assert.equal(store.get(f.a.db,f.source.id).status,"done");assert.equal(store.get(f.b.db,f.target.id).status,"done");assert.equal(f.a.db.prepare("SELECT count(*) n FROM relation_completions").get().n,1);
});

import {openFleetActions} from "../core/fleet-actions.mjs";
import {revokePrincipal} from "../core/mcp/policy.mjs";
const fleetDeliveryControllers=[];
after(async()=>{for(const c of fleetDeliveryControllers)await c.close();});
function deliveryOperator(n,{receivers=[],profiles=[],peers=[],integrationPolicies,...options}={}){
 const role_id="delivery"+serial++,principal_file=join(TMP,role_id+".json");
 putRole(n.db,{role_id,kind:"coordinate",projects:["demo","other"],capabilities:[],runtime:null,model:null,effort:null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:1,max_open_tasks:100,requests_per_minute:300}});
 const principal=issuePrincipal(n.db,{roleId:role_id,projects:["demo","other"],credentialFile:principal_file});
 const config={format:"ai-fleet-actions/v1",node_id:n.node.node_id,node_epoch:n.node.sync_epoch,principal_file,peers,delivery:{approval_file:join(src,"approved-fixture-tree"),receivers,verification_profiles:profiles,...(integrationPolicies===undefined?{}:{integration_policies:integrationPolicies})}};
 const open=extra=>{const c=openFleetActions(n.db,{config,sourceGate,...options,...extra});fleetDeliveryControllers.push(c);return c;};
 return {config,principal,open,actions:open()};
}
const deliveryRequest=(command,args,project_id="demo")=>({action_id:randomUUID(),project_id,command,arguments:args});
async function deliveryDo(actions,request){const queued=actions.enqueue(request);await actions.tick();const result=actions.catalog(request.project_id).actions.find(a=>a.action_id===queued.action_id);assert.ok(result);return result;}

test("panel delivery transfers actual bytes after lost ACK and restart, verifies a fixed command once, and does not accept tasks",async()=>{
 const f=fileCandidate({register:false,prepareTransfer:false}),url=await network(f.a);let lost=false,clock=Date.now();
 const target=deliveryOperator(f.b,{peers:[{node_id:f.a.node.node_id,node_epoch:f.a.node.sync_epoch,projects:["demo"],url,credential_file:f.ba.file}],now:()=>clock,fetchImpl:async(...args)=>{const r=await fetch(...args);if(!lost&&String(args[0]).endsWith("/artifact/chunk")){lost=true;await r.arrayBuffer();throw Error("lost ACK");}return r;}});
 const prep=deliveryRequest("prepare_artifact",{result_id:f.r.result_id}),prepared=await deliveryDo(target.actions,prep);assert.equal(prepared.state,"applied");f.t=artifactState(f.b.db,prepared.result.transfer_id);
 assert.equal(target.actions.enqueue({...prep,action_id:randomUUID()}).action_id,prep.action_id);assert.equal(f.b.db.prepare("SELECT count(*) n FROM artifact_transfers").get().n,1);
 const marker=join(TMP,"panel-check-count-"+serial+++".txt"),v=localCheck(f,"import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {join} from 'node:path';import assert from 'node:assert/strict';const {result}=await import(pathToFileURL(join(process.cwd(),'src/generated.mjs')));assert.equal(result,42);fs.appendFileSync("+JSON.stringify(marker)+",'once\\n');console.log('fixed check passed');");
 const source=deliveryOperator(f.a,{profiles:[v.profileId],receivers:[{project_id:"demo",mapping_id:f.receiverMapping.mapping_id,base_commit:f.base,allow_full_baseline_read:true}]});
 assert.throws(()=>source.actions.enqueue(deliveryRequest("register_artifact_target",{result_id:f.r.result_id,mapping_id:f.receiverMapping.mapping_id},"other")),{code:"NOT_FOUND"});
 assert.throws(()=>source.actions.enqueue(deliveryRequest("register_artifact_target",{result_id:f.r.result_id,mapping_id:randomUUID()})),{code:"FORBIDDEN"});
 const receiveRequest=deliveryRequest("register_artifact_target",{result_id:f.r.result_id,mapping_id:f.receiverMapping.mapping_id});source.actions.enqueue(receiveRequest);assert.equal(f.a.db.prepare("SELECT count(*) n FROM artifact_targets").get().n,0);await source.actions.tick();
 const transfer=deliveryRequest("send_artifact",{id:f.t.transfer_id});assert.equal((await deliveryDo(target.actions,transfer)).state,"retry_pending");assert.equal(lost,true);
 await target.actions.close();clock+=10000;target.actions=target.open({fetchImpl:fetch});await target.actions.tick();assert.equal(target.actions.catalog("demo").actions.find(a=>a.action_id===transfer.action_id).state,"acknowledged");
 const verify=await deliveryDo(source.actions,deliveryRequest("verify_artifact",{id:f.t.transfer_id}));assert.equal(verify.result.state,"content_verified");
 const prepare=deliveryRequest("prepare_verification",{transfer_id:f.t.transfer_id,profile_id:v.profileId}),verification=await deliveryDo(source.actions,prepare);assert.equal(verification.result.state,"ready");
 assert.equal(source.actions.enqueue({...prepare,action_id:randomUUID()}).action_id,prepare.action_id);
 const id=verification.result.verification_id,run=await deliveryDo(source.actions,deliveryRequest("run_verification",{id}));assert.equal(run.result.state,"checks_passed");assert.equal(run.result.checks_passed,true);
 assert.equal((await deliveryDo(source.actions,deliveryRequest("run_verification",{id}))).result.state,"checks_passed");assert.equal(readFileSync(marker,"utf8"),"once\n");assert.equal(f.a.db.prepare("SELECT count(*) n FROM verification_launches").get().n,1);
 const catalog=source.actions.catalog("demo").delivery;assert.equal(catalog.artifacts[0].state,"content_verified");assert.equal(catalog.verifications[0].checks_passed,true);assert.equal(catalog.profiles.length,1);
 const encoded=JSON.stringify(catalog);for(const hidden of [marker,v.checker,source.config.principal_file,JSON.parse(readFileSync(source.config.principal_file,"utf8")).token])assert.equal(encoded.includes(hidden),false);
 assert.equal(source.actions.catalog("other").delivery.artifacts.length,0);assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);assert.notEqual(store.get(f.a.db,f.source.id).status,"done");
});

test("panel delivery reconciles a durable verification journal after database write failure without rerunning the check",async()=>{
 const f=fileCandidate();upload(f);verifyArtifact(f.a.db,{transferId:f.t.transfer_id});
 const marker=join(TMP,"panel-journal-"+serial+++".txt"),v=localCheck(f,"import fs from 'node:fs';fs.appendFileSync("+JSON.stringify(marker)+",'once\\n');console.log('retained observation');");prepareVerification(f.a.db,v);
 const source=deliveryOperator(f.a,{profiles:[v.profileId]});
 f.a.db.exec("CREATE TRIGGER fail_panel_verification_receipt BEFORE INSERT ON verification_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt disk failure'); END");
 const run=await deliveryDo(source.actions,deliveryRequest("run_verification",{id:v.verificationId}));assert.equal(run.state,"blocked");assert.equal(verificationState(f.a.db,v.verificationId).phase,"launch_committed");assert.equal(readFileSync(marker,"utf8"),"once\n");
 f.a.db.exec("DROP TRIGGER fail_panel_verification_receipt");
 await deliveryDo(source.actions,deliveryRequest("resume_delivery",{id:run.action_id}));assert.equal(source.actions.catalog("demo").actions.find(a=>a.action_id===run.action_id).result.state,"checks_passed");
 const reconciled=await deliveryDo(source.actions,deliveryRequest("reconcile_verification",{id:v.verificationId}));assert.equal(reconciled.result.state,"checks_passed");assert.equal(readFileSync(marker,"utf8"),"once\n");assert.equal(f.a.db.prepare("SELECT count(*) n FROM verification_launches").get().n,1);
 assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);
});

test("panel delivery rejects changed configuration and candidate context before queued file effects",async()=>{
 const f=fileCandidate();upload(f);let checkedInside=false;assert.throws(()=>verifyArtifact(f.a.db,{transferId:f.t.transfer_id,authorize(){checkedInside=f.a.db.isTransaction;throw Error("fixture authorization revoked before receipt");}}),/authorization revoked/);assert.equal(checkedInside,true);assert.equal(artifactState(f.a.db,f.t.transfer_id).state,"received");
 const source=deliveryOperator(f.a),request=deliveryRequest("verify_artifact",{id:f.t.transfer_id});
 f.a.db.exec("CREATE TRIGGER fail_panel_action_insert BEFORE INSERT ON fleet_operator_actions BEGIN SELECT RAISE(ABORT,'fixture queue failure'); END");
 assert.throws(()=>source.actions.enqueue(request),/fixture queue failure/);assert.equal(f.a.db.prepare("SELECT count(*) n FROM fleet_operator_actions").get().n,0);assert.equal(artifactState(f.a.db,f.t.transfer_id).state,"received");f.a.db.exec("DROP TRIGGER fail_panel_action_insert");
 source.actions.enqueue(request);await source.actions.close();
 const original=source.config.delivery.approval_file;source.config.delivery.approval_file=join(src,"changed-approval-fixture");
 source.actions=source.open();await source.actions.tick();const blocked=source.actions.catalog("demo").actions[0];assert.equal(blocked.last_error_code,"DELIVERY_CONFIG_CHANGED");assert.equal(artifactState(f.a.db,f.t.transfer_id).state,"received");
 await source.actions.close();source.config.delivery.approval_file=original;source.actions=source.open();const later=deliveryRequest("verify_artifact",{id:f.t.transfer_id});source.actions.enqueue(later);
 reject(f,f.r);await source.actions.tick();assert.equal(source.actions.catalog("demo").actions.find(x=>x.action_id===later.action_id).last_error_code,"RESULT_NOT_PENDING");assert.equal(f.a.db.prepare("SELECT count(*) n FROM artifact_receipts WHERE kind='artifact_content_verified'").get().n,0);
});

test("panel delivery principal revocation stops a running fixed check and preserves its failed observation",async()=>{
 const f=fileCandidate();upload(f);verifyArtifact(f.a.db,{transferId:f.t.transfer_id});
 const marker=join(TMP,"panel-running-"+serial+++".txt"),v=localCheck(f,"import fs from 'node:fs';fs.writeFileSync("+JSON.stringify(marker)+",'started');await new Promise(r=>setTimeout(r,30000));console.log('should not finish');",{timeout_ms:35000});
 prepareVerification(f.a.db,v);const source=deliveryOperator(f.a,{profiles:[v.profileId]}),request=deliveryRequest("run_verification",{id:v.verificationId});
 source.actions.enqueue(request);const running=source.actions.tick(),deadline=Date.now()+10000;
 while(!existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
 assert.equal(existsSync(marker),true);revokePrincipal(f.a.db,{principalId:source.principal.principal_id,expectedVersion:1});await running;
 const state=verificationState(f.a.db,v.verificationId);assert.equal(state.phase,"settled");assert.equal(state.receipt.checks_passed,false);assert.equal(state.receipt.observation.process.cleanup,"job_empty");
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM verification_launches").get().n,1);assert.throws(()=>source.actions.catalog("demo"));assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);
});


test("panel closure merges once, freezes explicit acceptance, and settles both endpoints through actual HTTP",async()=>{
 const x=await mergeFixture({registrarOnSource:true}),{f,v,config}=x;
 const aUrl=await network(f.a),bUrl=await network(f.b);
 const peer=(n,url,file)=>({node_id:n.node.node_id,node_epoch:n.node.sync_epoch,projects:["demo"],url,credential_file:file});
 const source=deliveryOperator(f.a,{profiles:[v.profileId],integrationPolicies:[config.policyId],peers:[peer(f.b,bUrl,f.ab.file)]});
 const target=deliveryOperator(f.b,{integrationPolicies:[],peers:[peer(f.a,aUrl,f.ba.file)]});
 const request=deliveryRequest("prepare_integration",{verification_id:v.verificationId,policy_id:config.policyId});
 const prep=await deliveryDo(source.actions,request);assert.equal(prep.state,"applied",JSON.stringify(prep));assert.equal(prep.result.state,"integration_ready");
 assert.equal(source.actions.enqueue({...request,action_id:randomUUID()}).action_id,prep.action_id);
 const integrationId=prep.result.integration_id;assert.equal(refValue(f,config.ref),f.base);
 const merged=await deliveryDo(source.actions,deliveryRequest("apply_integration",{id:integrationId}));assert.equal(merged.result.source_applied,true,JSON.stringify(merged));
 const commit=refValue(f,config.ref);assert.notEqual(commit,f.base);assert.equal(store.get(f.a.db,f.source.id).status,"not_started");
 assert.equal((await deliveryDo(source.actions,deliveryRequest("apply_integration",{id:integrationId}))).result.source_applied,true);assert.equal(refValue(f,config.ref),commit);assert.equal(f.a.db.prepare("SELECT count(*) n FROM integration_launches").get().n,1);
 const args={integration_id:integrationId,expected_version:store.get(f.a.db,f.source.id).aggregate_version,note:"Explicit operator acceptance of synthetic fixture only",allow_fixture:true};
 assert.throws(()=>source.actions.enqueue(deliveryRequest("prepare_completion",{...args,allow_fixture:false})),{code:"FIXTURE_ACCEPTANCE_REQUIRED"});
 const prepare=deliveryRequest("prepare_completion",args),decision=await deliveryDo(source.actions,prepare);assert.equal(decision.state,"applied",JSON.stringify(decision));
 const id=decision.result.completion_id;assert.ok(id);assert.equal(source.actions.enqueue({...prepare,action_id:randomUUID()}).action_id,decision.action_id);assert.equal(store.get(f.a.db,f.source.id).status,"not_started");
 assert.equal((await deliveryDo(source.actions,deliveryRequest("send_completion",{id}))).state,"acknowledged");
 assert.equal((await deliveryDo(source.actions,deliveryRequest("register_completion",{id}))).state,"applied");
 assert.equal((await deliveryDo(target.actions,deliveryRequest("register_completion",{id}))).state,"acknowledged");
 assert.equal((await deliveryDo(source.actions,deliveryRequest("poll_completion",{id}))).state,"acknowledged");
 for(const op of [source,target]){const done=await deliveryDo(op.actions,deliveryRequest("settle_completion",{id}));assert.equal(done.result.accepted,true,JSON.stringify(done));assert.equal((await deliveryDo(op.actions,deliveryRequest("settle_completion",{id}))).result.accepted,true);}
 assert.equal(store.get(f.a.db,f.source.id).status,"done");assert.equal(store.get(f.b.db,f.target.id).status,"done");
 assert.equal(source.actions.catalog("demo").delivery.closure.completions[0].accepted,true);assert.equal(source.actions.catalog("other").delivery.closure.completions.length,0);
 for(const op of [source,target]){const text=JSON.stringify(op.actions.catalog("demo"));assert.ok(!text.includes(op.config.principal_file));assert.ok(!text.includes(f.receiverRoot));}
});


test("panel closure resumes the same Git update after receipt failure without applying it again",async()=>{
 const {f,v,config}=await mergeFixture(),source=deliveryOperator(f.a,{profiles:[v.profileId],integrationPolicies:[config.policyId]});
 const prep=await deliveryDo(source.actions,deliveryRequest("prepare_integration",{verification_id:v.verificationId,policy_id:config.policyId})),id=prep.result.integration_id;
 f.a.db.exec("CREATE TRIGGER fail_integration_receipt BEFORE INSERT ON integration_receipts BEGIN SELECT RAISE(ABORT,'fixture interrupted receipt'); END");
 const applied=await deliveryDo(source.actions,deliveryRequest("apply_integration",{id}));assert.equal(applied.state,"blocked");assert.equal(integrationState(f.a.db,id).phase,"launch_committed");const commit=refValue(f,config.ref);assert.notEqual(commit,f.base);
 f.a.db.exec("DROP TRIGGER fail_integration_receipt");await source.actions.close();source.actions=source.open();
 await deliveryDo(source.actions,deliveryRequest("resume_delivery",{id:applied.action_id}));
 assert.equal(integrationState(f.a.db,id).phase,"settled");assert.equal(refValue(f,config.ref),commit);assert.equal(f.a.db.prepare("SELECT count(*) n FROM integration_launches").get().n,1);
 assert.equal(source.actions.catalog("demo").actions.find(a=>a.action_id===applied.action_id).state,"applied");
});

test("panel closure refuses unauthorized policy and changed authority before queued Git effects",async()=>{
 const {f,v,config}=await mergeFixture(),source=deliveryOperator(f.a,{profiles:[v.profileId],integrationPolicies:[config.policyId]});
 const args={verification_id:v.verificationId,policy_id:config.policyId};
 assert.throws(()=>source.actions.enqueue(deliveryRequest("prepare_integration",args,"other")),{code:"NOT_FOUND"});
 assert.throws(()=>source.actions.enqueue(deliveryRequest("prepare_integration",{...args,policy_id:randomUUID()})),{code:"FORBIDDEN"});
 assert.throws(()=>source.actions.enqueue(deliveryRequest("prepare_integration",{...args,ref:"refs/heads/arbitrary"})),{code:"BAD_INPUT"});
 f.a.db.exec("CREATE TRIGGER fail_panel_closure BEFORE INSERT ON fleet_operator_actions BEGIN SELECT RAISE(ABORT,'fixture queue rollback'); END");
 assert.throws(()=>source.actions.enqueue(deliveryRequest("prepare_integration",args)),/fixture queue rollback/);assert.equal(f.a.db.prepare("SELECT count(*) n FROM integration_attempts").get().n,0);f.a.db.exec("DROP TRIGGER fail_panel_closure");
 const prep=await deliveryDo(source.actions,deliveryRequest("prepare_integration",args)),id=prep.result.integration_id;
 const apply=deliveryRequest("apply_integration",{id});source.actions.enqueue(apply);revokeIntegrationPolicy(f.a.db,{policyId:config.policyId});await source.actions.tick();
 assert.equal(source.actions.catalog("demo").actions.find(a=>a.action_id===apply.action_id).last_error_code,"INTEGRATION_REVOKED");assert.equal(refValue(f,config.ref),f.base);assert.equal(f.a.db.prepare("SELECT count(*) n FROM integration_launches").get().n,0);
});

test("panel closure rechecks operator authority after a remote readiness response before local receipt writes",async()=>{
 const x=await completionFixture(),{f,completionId}=x;prepareCompletion(f.a.db,x.completeArgs);const url=await network(f.b);let source,revoked=false;
 const fetchImpl=async(address,options)=>{const response=await fetch(address,options);if(String(address).endsWith('/delegation/complete')&&!revoked){revoked=true;revokePrincipal(f.a.db,{principalId:source.principal.principal_id,expectedVersion:1});}return response;};
 source=deliveryOperator(f.a,{integrationPolicies:[],peers:[{node_id:f.b.node.node_id,node_epoch:f.b.node.sync_epoch,projects:["demo"],url,credential_file:f.ab.file}],fetchImpl});
 const request=deliveryRequest("send_completion",{id:completionId});source.actions.enqueue(request);await source.actions.tick();
 assert.equal(revoked,true);assert.equal(completionState(f.b.db,completionId).phase,"ready");assert.equal(completionState(f.a.db,completionId).phase,"prepared");assert.equal(f.a.db.prepare("SELECT state FROM fleet_operator_actions WHERE action_id=?").get(request.action_id).state,"blocked");
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM completion_ready").get().n,0);
});
