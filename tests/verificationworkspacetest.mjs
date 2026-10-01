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


import {materializeVerificationInput,assertVerificationInput} from "../core/verification/workspace.mjs";
import {workspaceRepositorySource} from "../core/artifacts/repositories.mjs";
import {superviseCommand} from "../core/execution/supervisor.mjs";
function receivedInput(){const f=fileCandidate();upload(f);verifyArtifact(f.a.db,{transferId:f.t.transfer_id});const captured=captureVerifiedArtifact(f.a.db,{transferId:f.t.transfer_id}),source=workspaceRepositorySource(f.a.db,{mappingId:f.receiverMapping.mapping_id,baseCommit:f.base}),container=join(TMP,"verification-"+serial++);return {f,args:{source,container,packageBytes:captured.bytes,manifest:captured.header.manifest,manifestDigest:captured.header.manifest_digest,allowFullHistoryCopy:true}};}
test("source reconstructs the received Git commit in an independent repository and a pinned command tests its actual module",async()=>{
 const {f,args}=receivedInput(),receipt=materializeVerificationInput(args),root=receipt.identities.repo.root;
 assert.notEqual(root,f.receiverRoot);assert.equal(git(root,["rev-parse","HEAD"]),f.t.header.manifest.commit);assert.equal(git(f.receiverRoot,["rev-parse","HEAD"]),f.base);assert.equal(receipt.filesystem_sandbox,false);
 const checker=join(TMP,"source-approved-check.mjs");writeFileSync(checker,"import {pathToFileURL} from 'node:url';import {join} from 'node:path';import assert from 'node:assert/strict';const m=await import(pathToFileURL(join(process.cwd(),'src/generated.mjs')));assert.equal(m.result,42);console.log('checked actual module: 42');");
 const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys;print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim()),out=await superviseCommand({python,command:pinFile(process.execPath),args:[checker],pins:[pinFile(checker)],cwd:root,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),timeoutMs:5000});
 assert.equal(out.status,"success",JSON.stringify(out));assert.equal(out.process.cleanup,"job_empty");assert.equal(out.stdout.text,"checked actual module: 42\n");assert.equal(assertVerificationInput(receipt,{allowGenerated:true}).inputs_unchanged,true);assert.equal(existsSync(join(f.receiverRoot,"src/generated.mjs")),false);assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);
});
test("a changed input or staged tree cannot be hidden by successful command output; generated files are explicit",()=>{
 const {args}=receivedInput(),receipt=materializeVerificationInput(args),root=receipt.identities.repo.root,file=join(root,"src/generated.mjs"),original=readFileSync(file);writeFileSync(join(root,"report.txt"),"generated");assert.throws(()=>assertVerificationInput(receipt),{code:"VERIFICATION_INPUT_CHANGED"});assert.equal(assertVerificationInput(receipt,{allowGenerated:true}).inputs_unchanged,true);
 writeFileSync(file,"export const result=0;\n");assert.throws(()=>assertVerificationInput(receipt,{allowGenerated:true}),{code:"WORKSPACE_CONTENT_CHANGED"});writeFileSync(file,original);git(root,["add","report.txt"]);assert.throws(()=>assertVerificationInput(receipt,{allowGenerated:true}),{code:"VERIFICATION_GIT_FAILED"});
});
test("materialization requires a separate local history-copy grant and never overwrites an existing directory",()=>{
 const {args}=receivedInput();assert.throws(()=>materializeVerificationInput({...args,allowFullHistoryCopy:false}),{code:"FULL_HISTORY_PERMISSION_REQUIRED"});assert.equal(existsSync(args.container),false);mkdirSync(args.container);writeFileSync(join(args.container,"keep.txt"),"keep");assert.throws(()=>materializeVerificationInput(args));assert.equal(readFileSync(join(args.container,"keep.txt"),"utf8"),"keep");
});

import {registerVerificationProfile,revokeVerificationProfile,prepareVerification,executeVerification,reconcileVerification,verificationState,captureVerificationReceipt} from "../core/verification/service.mjs";
function localCheck(f,code="console.log('source check passed');",overrides={}){
 const checker=join(TMP,"local-check-"+serial+++".mjs"),poolRoot=join(TMP,"verify-pool-"+serial++);mkdirSync(poolRoot);writeFileSync(checker,code);
 const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys;print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim());
 const definition={command:pinFile(process.execPath),python,pins:[pinFile(checker)],args:overrides.isolation?["--preserve-symlinks","--preserve-symlinks-main",checker]:[checker],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),timeout_ms:5000,heartbeat_ms:100,stdout_limit:8192,stderr_limit:8192,...overrides};
 const config={profileId:randomUUID(),mappingId:f.receiverMapping.mapping_id,poolRoot,allowFullHistoryCopy:true,definition,sourceGate},profile=registerVerificationProfile(f.a.db,config);
 return {config,profile,checker,poolRoot,verificationId:randomUUID(),transferId:f.t.transfer_id,profileId:profile.profile_id,sourceGate};
}
function readyCheck(code,overrides){const {f}=receivedInput(),v=localCheck(f,code,overrides);prepareVerification(f.a.db,v);return {f,v};}

test("durable source-owned verification tests actual received code and binds task, profile, artifact and stopped Windows command",async()=>{
 const {f,v}=readyCheck("import {pathToFileURL} from 'node:url';import {join} from 'node:path';import assert from 'node:assert/strict';const {result}=await import(pathToFileURL(join(process.cwd(),'src/generated.mjs')));assert.equal(result,42);console.log('verified 42');");
 const before=JSON.stringify(store.get(f.a.db,f.source.id)),ready=verificationState(f.a.db,v.verificationId);assert.equal(ready.phase,"ready");assert.deepEqual(prepareVerification(f.a.db,v),ready);
 const done=await executeVerification(f.a.db,v);assert.equal(captureVerificationReceipt(f.a.db,v).currently_valid,true);assert.equal(done.phase,"settled");assert.equal(done.receipt.checks_passed,true,JSON.stringify(done));assert.equal(done.receipt.observation.stdout.text,"verified 42\n");assert.equal(done.receipt.observation.process.cleanup,"job_empty");assert.equal(done.binding.artifact_manifest_digest,f.t.header.manifest_digest);assert.equal(done.binding.source_task_uid,f.source.task_uid);assert.equal(done.accepted,false);assert.equal(done.receipt.filesystem_sandbox,false);assert.equal(JSON.stringify(store.get(f.a.db,f.source.id)),before);assert.equal(git(f.receiverRoot,["rev-parse","HEAD"]),f.base);assert.equal(bindingState(f.a.db,f.d.relation_id).state,"confirmed");
 await assert.rejects(executeVerification(f.a.db,v),{code:"VERIFICATION_ALREADY_LAUNCHED"});assert.deepEqual(reconcileVerification(f.a.db,v),done);
 for(const table of ["verification_profiles","verification_attempts","verification_inputs","verification_launches","verification_receipts"])assert.throws(()=>f.a.db.exec("DELETE FROM "+table),/verification history must be retained/);
 const restarted=new DatabaseSync(f.a.path);dbs.push(restarted);assert.deepEqual(verificationState(restarted,v.verificationId),done);f.a.db.prepare("UPDATE tasks SET verify_cmd=? WHERE id=?").run("changed after recorded success",f.source.id);assert.throws(()=>captureVerificationReceipt(f.a.db,v),{code:"VERIFICATION_STALE"});assert.equal(verificationState(f.a.db,v.verificationId).receipt.checks_passed,true);
});

test("zero command exit cannot approve changed inputs or stale source requirements",async()=>{
 const {f,v}=readyCheck("import {writeFileSync} from 'node:fs';writeFileSync('src/generated.mjs','export const result=0;');console.log('pretend success');");
 const done=await executeVerification(f.a.db,v);assert.equal(done.receipt.observation.status,"success");assert.equal(done.receipt.checks_passed,false);assert.equal(done.receipt.after.error,"WORKSPACE_CONTENT_CHANGED");assert.equal(resultState(f.a.db,f.r.result_id).accepted,false);
 const second=localCheck(f);prepareVerification(f.a.db,second);assert.throws(()=>f.a.db.prepare("UPDATE tasks SET acceptance=? WHERE id=?").run("new source contract",f.source.id),/BINDING_CONTRACT/);f.a.db.prepare("UPDATE tasks SET verify_cmd=? WHERE id=?").run("new source criteria",f.source.id);
 await assert.rejects(executeVerification(f.a.db,second),{code:"VERIFICATION_STALE"});assert.equal(verificationState(f.a.db,second.verificationId).phase,"ready");
});

test("revoking local verification authority during a live command stops the Windows job and cannot record a passing check",async()=>{
 const {f}=receivedInput(),marker=join(TMP,"verify-start-"+serial++),v=localCheck(f,"import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'started');setInterval(()=>{},100);",{args:[]});v.config.definition.args=[v.checker,marker];
 // A profile is immutable: register a new ID for the actual approved arguments.
 v.profileId=v.config.profileId=randomUUID();registerVerificationProfile(f.a.db,v.config);prepareVerification(f.a.db,v);
 const running=executeVerification(f.a.db,v),deadline=Date.now()+5000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(existsSync(marker),true);revokeVerificationProfile(f.a.db,{profileId:v.profileId});
 const done=await running;assert.equal(done.receipt.checks_passed,false);assert.equal(done.receipt.observation.process.cleanup,"job_empty");assert.equal(done.receipt.after.error,"VERIFICATION_REVOKED");assert.equal(done.receipt.observation.diagnostic,"HEARTBEAT_FAILED");
});

test("durable observation recovers a failed DB settlement without a second command, including after restart",async()=>{
 const {f}=receivedInput(),marker=join(TMP,"verify-count-"+serial++),v=localCheck(f,"import {appendFileSync} from 'node:fs';appendFileSync("+JSON.stringify(marker)+",'run\\n');console.log('passed once');");prepareVerification(f.a.db,v);
 f.a.db.exec("CREATE TRIGGER fail_verification_receipt BEFORE INSERT ON verification_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
 await assert.rejects(executeVerification(f.a.db,v),/fixture receipt failure/);assert.equal(verificationState(f.a.db,v.verificationId).phase,"launch_committed");const once=readFileSync(marker,"utf8");await assert.rejects(executeVerification(f.a.db,v),{code:"VERIFICATION_ALREADY_LAUNCHED"});assert.equal(readFileSync(marker,"utf8"),once);
 f.a.db.exec("DROP TRIGGER fail_verification_receipt");const restarted=new DatabaseSync(f.a.path);dbs.push(restarted);const done=reconcileVerification(restarted,v);assert.equal(done.receipt.checks_passed,true,JSON.stringify(done));assert.equal(readFileSync(marker,"utf8"),once);
});

test("recovery never promotes a stale success and missing observations never refund a launch",async()=>{
 const {f,v}=readyCheck();f.a.db.exec("CREATE TRIGGER fail_verification_receipt BEFORE INSERT ON verification_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");await assert.rejects(executeVerification(f.a.db,v),/fixture receipt failure/);f.a.db.exec("DROP TRIGGER fail_verification_receipt");f.a.db.prepare("UPDATE tasks SET verify_cmd=? WHERE id=?").run("changed while recovering",f.source.id);const done=reconcileVerification(f.a.db,v);assert.equal(done.receipt.checks_passed,false);assert.equal(done.receipt.recovery_error,"VERIFICATION_STALE");
 const second=localCheck(f);prepareVerification(f.a.db,second);f.a.db.prepare("INSERT INTO verification_launches VALUES(?,?,?,?)").run(second.verificationId,'{}',digest({}),new Date().toISOString());assert.throws(()=>reconcileVerification(f.a.db,second),{code:"VERIFICATION_OBSERVATION_MISSING"});await assert.rejects(executeVerification(f.a.db,second),{code:"VERIFICATION_ALREADY_LAUNCHED"});assert.equal(verificationState(f.a.db,second.verificationId).phase,"launch_committed");
});

test("source gate, explicit history grant, pinned files and retained partial preparation fail closed",async()=>{
 const {f}=receivedInput(),v=localCheck(f);
 assert.throws(()=>registerVerificationProfile(f.a.db,{...v.config,profileId:randomUUID(),allowFullHistoryCopy:false}),{code:"FULL_HISTORY_PERMISSION_REQUIRED"});assert.throws(()=>registerVerificationProfile(f.a.db,{...v.config,profileId:randomUUID(),poolRoot:f.receiverRoot}),{code:"VERIFICATION_PATH_OVERLAP"});assert.throws(()=>registerVerificationProfile(f.a.db,{...v.config,profileId:randomUUID(),definition:{...v.config.definition,env:{NODE_OPTIONS:"--require other.js"}}}),{code:"BAD_VERIFICATION"});
 assert.throws(()=>prepareVerification(f.a.db,{...v,sourceGate:{check(){throw Object.assign(Error('unapproved'),{code:"SOURCE_UNAPPROVED"});}}}),{code:"SOURCE_UNAPPROVED"});
 const folder=join(v.poolRoot,v.verificationId);mkdirSync(folder);writeFileSync(join(folder,"keep.txt"),"keep");assert.throws(()=>prepareVerification(f.a.db,v));assert.equal(verificationState(f.a.db,v.verificationId).phase,"preparing");assert.equal(prepareVerification(f.a.db,v).phase,"preparing");assert.equal(readFileSync(join(folder,"keep.txt"),"utf8"),"keep");await assert.rejects(executeVerification(f.a.db,v),{code:"VERIFICATION_NOT_READY"});
 const second=localCheck(f);prepareVerification(f.a.db,second);writeFileSync(second.checker,"console.log('changed script');");await assert.rejects(executeVerification(f.a.db,second),{code:"PIN_CHANGED"});assert.equal(verificationState(f.a.db,second.verificationId).phase,"ready");
});

import {unlinkSync,rmdirSync} from "node:fs";
import {repositoryReader} from "../core/artifacts/git-reader.mjs";
import {encodeGitPackage} from "../core/artifacts/git-package.mjs";
test("received Git reconstruction supports both file-to-directory and directory-to-file changes",()=>{
 const {f,args}=receivedInput(),root=f.receiverRoot;let base=f.base;
 for(const direction of ["file_to_directory","directory_to_file"]){
  const path=join(root,"src","base.txt");
  if(direction==="file_to_directory"){unlinkSync(path);mkdirSync(path);writeFileSync(join(path,"child.mjs"),"export default 1;\n");}
  else{unlinkSync(join(path,"child.mjs"));rmdirSync(path);writeFileSync(path,"returned file\n");}
  git(root,["-c","core.autocrlf=false","add","src"]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m",direction]);
  const commit=git(root,["rev-parse","HEAD"]),g=repositoryReader({root,git:pinnedGit}),before=g.snapshot({commit:base,consume(){}}),bytes=new Map(),after=g.snapshot({commit,consume(m,b){bytes.set(m.path,Buffer.from(b));}}),old=new Map(before.files.map(x=>[x.path,x])),next=new Map(after.files.map(x=>[x.path,x])),files=[];
  for(const path of [...new Set([...old.keys(),...next.keys()])].sort()){
   const a=old.get(path),b=next.get(path);if(a&&b&&a.blob_oid===b.blob_oid&&a.mode===b.mode)continue;
   files.push(b?{...b,operation:"write",base_sha256:a?.sha256??null}:{path,operation:"delete",mode:null,sha256:null,size:0,blob_oid:null,base_sha256:a.sha256});
  }
  const manifest={...args.manifest,base_commit:base,commit,tree:after.tree,content_snapshot_digest:digest(after),files},manifestDigest=digest(manifest),packageBytes=encodeGitPackage({manifest,manifest_digest:manifestDigest,files:files.filter(x=>x.operation==="write").map(x=>({path:x.path,bytes:bytes.get(x.path)})),commitBytes:g.commitBytes(commit)});g.verify();
  const materialized=materializeVerificationInput({...args,source:{...args.source,base_tree:before.tree},container:join(TMP,"swap-"+serial++),manifest,manifestDigest,packageBytes});assert.equal(assertVerificationInput(materialized).commit,commit);base=commit;
 }
});

test("AppContainer source verification executes delivered code while the authority database remains inaccessible",async()=>{
 const {f}=receivedInput();
 const code="import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {join} from 'node:path';import assert from 'node:assert/strict';const {result}=await import(pathToFileURL(join(process.cwd(),'src/generated.mjs')));assert.equal(result,42);const db="+JSON.stringify(f.a.path)+";for(const act of [()=>readFileSync(db),()=>writeFileSync(db,'corrupt')])assert.throws(act,e=>['EPERM','EACCES'].includes(e.code));writeFileSync('sandbox-check.txt','verified');console.log('isolated verified 42');";
 const isolation={kind:"windows-appcontainer",network:"none",memory_limit_bytes:268435456,process_limit:4},v=localCheck(f,code,{isolation});prepareVerification(f.a.db,v);
 const before=JSON.stringify(store.get(f.a.db,f.source.id)),done=await executeVerification(f.a.db,v);
 assert.equal(done.receipt.checks_passed,true,JSON.stringify(done));assert.equal(done.receipt.filesystem_sandbox,true);assert.equal(done.receipt.observation.stdout.text,"isolated verified 42\n");assert.equal(done.receipt.observation.process.sandbox.profile_removed,true);assert.equal(done.accepted,false);assert.equal(JSON.stringify(store.get(f.a.db,f.source.id)),before);
 assert.equal(captureVerificationReceipt(f.a.db,v).currently_valid,true);assert.deepEqual(reconcileVerification(f.a.db,v),done);await assert.rejects(executeVerification(f.a.db,v),{code:"VERIFICATION_ALREADY_LAUNCHED"});
 const restarted=new DatabaseSync(f.a.path);dbs.push(restarted);assert.equal(verificationState(restarted,v.verificationId).receipt.filesystem_sandbox,true);
});
