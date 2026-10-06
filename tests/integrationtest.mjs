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
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,openSync,ftruncateSync,closeSync} from "node:fs";
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

function fileCandidate({register=true,receiveReport=true,objectFormat="sha1"}={}){
 const f=fullyBound(),w=worker(f),root=join(TMP,"repo"+serial++);mkdirSync(root);mkdirSync(join(root,"src"));
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
 const observation=observed(execution);finishDispatch(f.b.db,{dispatchId:w.w.dispatch_id,result:{status:observation.status,evidence:observation.evidence,usage:null},observation});commitWorkspaceSession(f.b.db,{workspaceId});const r=candidate(f),ba=grant(f.b,f.a,["peer:handshake","delegation:result","artifact:write"]);
 migrateArtifacts(f.a.db);migrateArtifacts(f.b.db);
 if(receiveReport){const ack=receiveResult(f.a.db,ba.peer,r.body);recordResultReceipt(f.b.db,{resultId:r.result_id,receipt:ack});}
 const targetArgs={resultId:r.result_id,mappingId:receiverMapping.mapping_id,baseCommit:base,allowFullBaselineRead:true};if(register&&receiveReport)registerArtifactTarget(f.a.db,targetArgs);
 const t=prepareArtifact(f.b.db,{resultId:r.result_id,transferId:randomUUID()});return {...f,w,r,t,ba,root,base,receiverRoot,receiverMapping,targetArgs,workspaceId};
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

test("actual received objects merge by source CAS while local HEAD, index, dirty files and task remain unchanged",async()=>{
 const {f,config,args}=await mergeFixture(),root=f.receiverRoot;
 writeFileSync(join(root,"src/base.txt"),"local staged work\n");git(root,["add","src/base.txt"]);writeFileSync(join(root,"private.txt"),"local unstaged work\n");writeFileSync(join(root,"untracked.txt"),"local untracked work\n");
 mkdirSync(join(root,".git/hooks"),{recursive:true});writeFileSync(join(root,".git/hooks/reference-transaction"),"#!/bin/sh\nexit 17\n",{mode:0o700});assert.throws(()=>git(root,["update-ref","refs/heads/hook-probe",f.base]),/hook/);
 const status=git(root,["status","--porcelain"]),indexHash=contentHash(readFileSync(join(root,".git/index"))),task=canonical({...store.get(f.a.db,f.source.id)}),ready=prepareIntegration(f.a.db,args);assert.equal(ready.phase,"ready");assert.deepEqual(prepareIntegration(f.a.db,args),ready);assert.equal(refValue(f,config.ref),f.base);
 const done=executeIntegration(f.a.db,args),receipt=done.receipt;assert.equal(done.phase,"settled");assert.equal(receipt.source_applied,true);assert.equal(receipt.current_at_observation,true);assert.equal(done.accepted,false);assert.equal(refValue(f,config.ref),receipt.merge_commit);assert.equal(git(root,["show",config.ref+":src/generated.mjs"]).startsWith("export const result=42;"),true);
 const parents=git(root,["rev-list","--parents","-n","1",config.ref]).split(" ");assert.deepEqual(parents,[receipt.merge_commit,f.base,f.t.header.manifest.commit]);assert.equal(git(root,["rev-parse",config.ref+"^{tree}"]),f.t.header.manifest.tree);assert.equal(git(root,["rev-parse","HEAD"]),f.base);assert.equal(contentHash(readFileSync(join(root,".git/index"))),indexHash);assert.equal(git(root,["status","--porcelain"]),status);assert.equal(readFileSync(join(root,"src/base.txt"),"utf8"),"local staged work\n");assert.equal(canonical({...store.get(f.a.db,f.source.id)}),task);assert.equal(bindingState(f.a.db,f.d.relation_id).state,"confirmed");assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);assert.equal(captureAppliedIntegration(f.a.db,args).currently_valid,true);
 const viaCli=JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli/integration.mjs"),"get","--db",f.a.path,"--id",args.integrationId],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}));assert.equal(viaCli.receipt.merge_commit,receipt.merge_commit);assert.equal(viaCli.accepted,false);
 assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_ALREADY_LAUNCHED"});assert.deepEqual(reconcileIntegration(f.a.db,args),done);assert.throws(()=>prepareIntegration(f.a.db,{...args,integrationId:randomUUID()}),{code:"SOURCE_REF_CONFLICT"});
 for(const table of ["integration_policies","integration_attempts","integration_objects","integration_launches","integration_receipts"])assert.throws(()=>f.a.db.exec("DELETE FROM "+table),/integration history must be retained/);
});

test("source changes and checked-out branches refuse CAS without touching the new source work",async()=>{
 const {f,config,args}=await mergeFixture();prepareIntegration(f.a.db,args);const other=concurrentCommit(f);git(f.receiverRoot,["update-ref",config.ref,other,f.base]);assert.throws(()=>executeIntegration(f.a.db,args),{code:"SOURCE_REF_CONFLICT"});assert.equal(refValue(f,config.ref),other);assert.equal(integrationState(f.a.db,args.integrationId).phase,"ready");
 git(f.receiverRoot,["update-ref",config.ref,f.base,other]);const oldHead=git(f.receiverRoot,["symbolic-ref","HEAD"]);git(f.receiverRoot,["symbolic-ref","HEAD",config.ref]);assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_REF_CHECKED_OUT"});assert.equal(refValue(f,config.ref),f.base);git(f.receiverRoot,["symbolic-ref","HEAD",oldHead]);
 const alias="refs/heads/"+config.ref.slice("refs/heads/".length).toUpperCase();git(f.receiverRoot,["symbolic-ref","HEAD",alias]);assert.equal(git(f.receiverRoot,["rev-parse","HEAD"]),f.base);assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_REF_CHECKED_OUT"});git(f.receiverRoot,["symbolic-ref","HEAD",oldHead]);
 const linked=join(TMP,"linked-"+serial++);git(f.receiverRoot,["worktree","add","--quiet",linked,config.ref.slice("refs/heads/".length)]);assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_REF_CHECKED_OUT"});assert.equal(refValue(f,config.ref),f.base);
 revokeIntegrationPolicy(f.a.db,{policyId:config.policyId});assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_REVOKED"});assert.equal(integrationState(f.a.db,args.integrationId).phase,"ready");
});

test("Git success followed by SQLite rollback recovers the same actual merge after database reopen and never reapplies",async()=>{
 const {f,config,args}=await mergeFixture();prepareIntegration(f.a.db,args);f.a.db.exec("CREATE TRIGGER fail_merge_receipt BEFORE INSERT ON integration_receipts BEGIN SELECT RAISE(ABORT,'fixture merge receipt failure'); END");assert.throws(()=>executeIntegration(f.a.db,args),/fixture merge receipt failure/);const applied=refValue(f,config.ref);assert.notEqual(applied,f.base);assert.equal(integrationState(f.a.db,args.integrationId).phase,"launch_committed");assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_ALREADY_LAUNCHED"});f.a.db.exec("DROP TRIGGER fail_merge_receipt");
 const reopened=new DatabaseSync(f.a.path);dbs.push(reopened);const done=reconcileIntegration(reopened,args);assert.equal(done.receipt.merge_commit,applied);assert.equal(done.receipt.source_applied,true);assert.equal(done.receipt.current_at_observation,true);assert.equal(refValue(f,config.ref),applied);assert.deepEqual(reconcileIntegration(reopened,args),done);assert.equal(reopened.prepare("SELECT count(*) n FROM integration_launches").get().n,1);
});

test("recovery records an already-applied source merge but cannot approve it after local authority was revoked",async()=>{
 const {f,config,args}=await mergeFixture();prepareIntegration(f.a.db,args);f.a.db.exec("CREATE TRIGGER fail_merge_receipt BEFORE INSERT ON integration_receipts BEGIN SELECT RAISE(ABORT,'fixture merge receipt failure'); END");assert.throws(()=>executeIntegration(f.a.db,args),/fixture merge receipt failure/);f.a.db.exec("DROP TRIGGER fail_merge_receipt");const applied=refValue(f,config.ref);revokeIntegrationPolicy(f.a.db,{policyId:config.policyId});const done=reconcileIntegration(f.a.db,args);assert.equal(done.receipt.source_applied,true);assert.equal(done.receipt.current_at_observation,false);assert.equal(done.receipt.context_error,"INTEGRATION_REVOKED");assert.equal(refValue(f,config.ref),applied);assert.throws(()=>captureAppliedIntegration(f.a.db,args),{code:"INTEGRATION_NOT_APPLIED"});assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);
});

test("an unknown launch or an independently moved ref cannot be retried, abandoned or silently overwritten",async()=>{
 const {f,config,args}=await mergeFixture(),ready=prepareIntegration(f.a.db,args);f.a.db.prepare("INSERT INTO integration_launches VALUES(?,?,?,?)").run(args.integrationId,ready.binding_digest,ready.objects_digest,new Date().toISOString());assert.throws(()=>reconcileIntegration(f.a.db,args),{code:"INTEGRATION_EFFECT_UNCONFIRMED"});assert.throws(()=>executeIntegration(f.a.db,args),{code:"INTEGRATION_ALREADY_LAUNCHED"});assert.throws(()=>abandonIntegration(f.a.db,{integrationId:args.integrationId,reason:"unknown process"}),{code:"INTEGRATION_ALREADY_LAUNCHED"});
 const other=concurrentCommit(f);git(f.receiverRoot,["update-ref",config.ref,other,f.base]);assert.throws(()=>reconcileIntegration(f.a.db,args),{code:"INTEGRATION_EFFECT_UNCONFIRMED"});assert.equal(refValue(f,config.ref),other);assert.equal(integrationState(f.a.db,args.integrationId).phase,"launch_committed");
});

test("explicit local permissions and retained failed preparation prevent overwrite; an unlaunched attempt can be abandoned",async()=>{
 const {f,config,args}=await mergeFixture();assert.throws(()=>registerIntegrationPolicy(f.a.db,{...config,policyId:randomUUID(),allowVerifiedContentMerge:false}),{code:"INTEGRATION_PERMISSION_REQUIRED"});assert.throws(()=>registerIntegrationPolicy(f.a.db,{...config,policyId:randomUUID(),exclusiveRefManagement:false}),{code:"INTEGRATION_PERMISSION_REQUIRED"});assert.throws(()=>registerIntegrationPolicy(f.a.db,{...config,policyId:randomUUID(),poolRoot:f.receiverRoot}),{code:"INTEGRATION_PATH_OVERLAP"});
 const other=join(TMP,"other-receiver-"+serial++);git(TMP,["clone","--quiet","--no-hardlinks",f.receiverRoot,other]);const otherMapping=registerRepository(f.a.db,{mappingId:randomUUID(),projectId:"demo",repoId:"other-app",root:other,git:pinnedGit,baseCommit:f.base,paths:["src/"]});git(other,["update-ref",config.ref,f.base]);const otherPolicy=randomUUID();registerIntegrationPolicy(f.a.db,{...config,policyId:otherPolicy,mappingId:otherMapping.mapping_id});assert.throws(()=>prepareIntegration(f.a.db,{...args,policyId:otherPolicy,integrationId:randomUUID()}),{code:"INTEGRATION_MAPPING_MISMATCH"});
 for(const ref of ["HEAD","refs/remotes/origin/main","refs/heads/main.lock","refs/heads/Alias","refs/heads/a/../b","refs/heads/a\nupdate HEAD"])assert.throws(()=>integrationRef(ref),{code:"BAD_INTEGRATION_REF"});
 const dir=join(config.poolRoot,args.integrationId);mkdirSync(dir);writeFileSync(join(dir,"keep.txt"),"keep");assert.throws(()=>prepareIntegration(f.a.db,args));assert.equal(integrationState(f.a.db,args.integrationId).phase,"preparing");assert.equal(prepareIntegration(f.a.db,args).phase,"preparing");assert.equal(readFileSync(join(dir,"keep.txt"),"utf8"),"keep");assert.equal(abandonIntegration(f.a.db,{integrationId:args.integrationId,reason:"retain conflicting directory"}).phase,"abandoned");
 const fresh={...args,integrationId:randomUUID()};assert.equal(prepareIntegration(f.a.db,fresh).phase,"ready");assert.equal(executeIntegration(f.a.db,fresh).receipt.source_applied,true);assert.equal(readFileSync(join(dir,"keep.txt"),"utf8"),"keep");
});

test("source merge supports SHA256 repositories and binds the actual verification receipt in the commit",async()=>{
 const {f,config,args}=await mergeFixture({objectFormat:"sha256"});prepareIntegration(f.a.db,args);const done=executeIntegration(f.a.db,args);assert.equal(done.receipt.merge_commit.length,64);assert.equal(git(f.receiverRoot,["rev-parse",config.ref+"^{tree}"]),f.t.header.manifest.tree);const raw=git(f.receiverRoot,["cat-file","commit",done.receipt.merge_commit]);assert.ok(raw.includes(done.binding.verification_receipt_digest));assert.ok(raw.includes(args.integrationId));assert.equal(captureAppliedIntegration(f.a.db,args).currently_valid,true);
 f.a.db.prepare("UPDATE tasks SET verify_cmd=? WHERE id=?").run("changed after source merge",f.source.id);assert.throws(()=>captureAppliedIntegration(f.a.db,args),{code:"VERIFICATION_STALE"});assert.equal(refValue(f,config.ref),done.receipt.merge_commit);
});

import {repositoryReader} from "../core/artifacts/git-reader.mjs";
test("source Git plumbing stays anchored to the registered common directory if a linked worktree is redirected",()=>{
 const root=join(TMP,"anchor-source-"+serial++);mkdirSync(root);writeFileSync(join(root,"one.txt"),"base\n");git(root,["init","--quiet","--template="]);git(root,["add","one.txt"]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","base"]);const base=git(root,["rev-parse","HEAD"]),tree=git(root,["rev-parse","HEAD^{tree}"]),ref="refs/heads/anchor-target";git(root,["update-ref",ref,base]);
 const linked=join(TMP,"anchor-linked-"+serial++),other=join(TMP,"anchor-other-"+serial++);git(root,["worktree","add","--quiet","--detach",linked,base]);git(TMP,["clone","--quiet","--no-hardlinks",root,other]);
 const create=(dir,message)=>git(dir,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit-tree",tree,"-p",base,"-m",message]);const next=create(root,"authorized source update"),foreign=create(other,"different foreign update");git(other,["update-ref",ref,foreign]);
 const reader=repositoryReader({root:linked,git:pinnedGit}),source=reader.info;reader.verify();const pinned=integrationGit({source,identities:sourceIdentities(source)});assert.equal(pinned.refValue(ref),base);
 const pointer=Buffer.from("gitdir: "+join(other,".git").replaceAll("\\","/")+"\n"),fd=openSync(join(linked,".git"),"r+");try{writeFileSync(fd,pointer);ftruncateSync(fd,pointer.length);}finally{closeSync(fd);}assert.equal(git(linked,["rev-parse",ref]),foreign);
 assert.equal(pinned.refValue(ref),base);assert.equal(pinned.compareAndSwap({ref,expected:base,next}),next);assert.equal(git(root,["rev-parse",ref]),next);assert.equal(git(other,["rev-parse",ref]),foreign);
});
