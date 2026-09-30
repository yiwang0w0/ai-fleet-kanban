import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync,statSync,renameSync,symlinkSync,openSync,ftruncateSync,closeSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync,spawn} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {prepareAdapter} from "../core/execution/adapters.mjs";
import {executePreparedDispatch,reconcileExecutionJournal} from "../core/execution/runner.mjs";
import {digest} from "../core/federation/sync-store.mjs";
import {migratePeers} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,issuePrincipal,revokePrincipal,authenticatePrincipal} from "../core/mcp/policy.mjs";
import {callTool,listTools} from "../core/mcp/tools.mjs";
import {pinFile,superviseProcess} from "../core/execution/supervisor.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateDispatch,putQuota,quotaStatus,prepareDispatch,authorizeLaunch,finishDispatch,abandonPrepared,dispatchStatus} from "../core/execution/dispatch.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-file-session-")),dbs=[],children=[];let seq=0;
after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const done=new Promise(r=>c.once("close",r));c.kill();await done;}for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
const path=name=>join(TMP,name+"-"+seq++);
const git=(dir,args)=>execFileSync("git",["-C",dir,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
function source(){
 const dir=path("source");mkdirSync(dir);writeFileSync(join(dir,"code.txt"),"governance fixture\n");
 git(dir,["init","--quiet"]);git(dir,["config","core.autocrlf","false"]);git(dir,["add","code.txt"]);git(dir,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","fixture"]);
 const approvalFile=path("accepted");writeFileSync(approvalFile,git(dir,["rev-parse","HEAD:"]));
 return {codeRoot:dir,approvalFile,gate:createSourceGate({codeRoot:dir,approvalFile})};
}
const SOURCE=source();
function policy(id,kind,extra={}){
 return {role_id:id,kind,projects:["demo"],capabilities:kind==="implement"?["workspace-files"]:[],runtime:kind==="implement"?"claude":null,model:kind==="implement"?"fixture-model":null,effort:kind==="implement"?"fixture-effort":null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300},...extra};
}
function fixture({limit=5,sourceInfo=SOURCE,executionMode="fixture"}={}){
 const boardRoot=path("board");mkdirSync(boardRoot);const dbPath=join(boardRoot,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);migrateDispatch(db);
 putRole(db,policy("coord","coordinate"));putRole(db,policy("engine","implement"));
 const file=path("coordinator")+".json",p=issuePrincipal(db,{roleId:"coord",projects:["demo"],credentialFile:file});
 const coord={...p,auth:"Bearer "+JSON.parse(readFileSync(file,"utf8")).token};
 const quota=putQuota(db,{quota_id:randomUUID(),runtime:"claude",execution_mode:executionMode,projects:["demo"],limit_total:limit,enabled:true});
 return {db,dbPath,coord,quota,source:sourceInfo};
}
const count=(f,name)=>f.db.prepare("SELECT count(*) n FROM "+name).get().n;
function card(f,{kind="task",parent=null,release=true,capabilities=["workspace-files"]}={}){
 const args={request_id:randomUUID(),project_id:"demo",subject:randomUUID(),description:"fixture task",acceptance:"observed receipt",work_kind:"implement",required_capabilities:capabilities};
 const created=parent?callTool(f.db,f.coord.auth,"split_task",{...args,parent_uid:parent.task_uid,expected_version:parent.aggregate_version}):callTool(f.db,f.coord.auth,"create_task",{...args,kind});
 if(release)store.setReleased(f.db,{id:created.task.id,expectedVersion:created.task.aggregate_version,released:true});
 return store.get(f.db,created.task.id);
}
function assign(f,t){const current=store.get(f.db,t.id);return callTool(f.db,f.coord.auth,"request_assignment",{request_id:randomUUID(),task_uid:current.task_uid,expected_version:current.aggregate_version});}
function prepare(f,a,extra={}){
 const credentialFile=extra.credentialFile??path("worker")+".json";
 const receipt=prepareDispatch(f.db,{assignmentId:a.assignment_id,quotaId:f.quota.quota_id,executionMode:f.quota.execution_mode,credentialFile,sourceGate:f.source.gate,...extra});
 return {receipt,credentialFile,auth:"Bearer "+JSON.parse(readFileSync(credentialFile,"utf8")).token};
}
const launch=(f,w)=>authorizeLaunch(f.db,{dispatchId:w.receipt.dispatch_id,sourceGate:f.source.gate});
const finish=(f,w,result={status:"success",evidence:"fixture output",usage:null})=>finishDispatch(f.db,{dispatchId:w.receipt.dispatch_id,result});

import {registerRepository,approveRepositoryBase} from "../core/artifacts/repositories.mjs";
import {migrateWorkspaces,registerWorkspacePool,createTaskWorkspace,workspaceState,workspaceConflicts,taskWorkspaceDirectory,retainTaskWorkspace} from "../core/artifacts/workspaces.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";
const hash=b=>createHash("sha256").update(b).digest("hex"),execPath=execFileSync("git",["--exec-path"],{encoding:"utf8"}).trim();
const gitPath=process.platform==="win32"?realpathSync.native(join(execPath,"../../bin/git.exe")):realpathSync.native(execFileSync("which",["git"],{encoding:"utf8"}).trim());
const pinnedGit={path:gitPath,sha256:hash(readFileSync(gitPath))};
function repo(format="sha1"){
 const root=path("task-repo");mkdirSync(root);git(root,["init","--quiet","--template=","--object-format="+format]);
 mkdirSync(join(root,"src"));mkdirSync(join(root,"docs"));writeFileSync(join(root,"src","demo.txt"),"raw\r\n中文\r\n");writeFileSync(join(root,"docs","readme.md"),"base\n");writeFileSync(join(root,"private.txt"),"history granted by local pool\n");
 git(root,["-c","core.autocrlf=false","add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","base"]);const base=git(root,["rev-parse","HEAD"]);
 writeFileSync(join(root,"src","demo.txt"),"later commit\n");git(root,["add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","later"]);writeFileSync(join(root,"untracked.txt"),"do not copy");
 return {root,base};
}
function setup({projectId="demo",executionMode="fixture",sourceInfo=SOURCE,format="sha1"}={}){
 const f=fixture({executionMode,sourceInfo}),r=repo(format),mapping=registerRepository(f.db,{mappingId:randomUUID(),projectId,repoId:"app",root:r.root,git:pinnedGit,baseCommit:r.base,paths:["src/","docs/"]}),poolRoot=path("pool");mkdirSync(poolRoot);
 const config={poolId:randomUUID(),mappingId:mapping.mapping_id,root:poolRoot,allowFullHistoryCopy:true};registerWorkspacePool(f.db,config);
 return {...f,r,mapping,poolRoot,pool:config};
}
function request(f,extra={}){const t=card(f),w=prepare(f,assign(f,t));return {w,t,args:{workspaceId:randomUUID(),poolId:f.pool.poolId,dispatchId:w.receipt.dispatch_id,baseCommit:f.r.base,writePaths:["src/"],...extra}};}
function workspace(f,extra={}){const x=request(f,extra);return {...x,state:createTaskWorkspace(f.db,x.args)};}
const directory=(f,x)=>taskWorkspaceDirectory(f.db,{workspaceId:x.args.workspaceId});
const state=(f,x)=>workspaceState(f.db,{workspaceId:x.args.workspaceId});
const retain=(f,x)=>retainTaskWorkspace(f.db,{workspaceId:x.args.workspaceId,reason:"fixture finished; preserve files"});

import {prepareWorkspaceSession,workspaceLaunchDescriptor} from "../core/artifacts/workspace-session.mjs";
import {commitWorkspaceSession,captureWorkspaceCommit} from "../core/artifacts/workspace-commit.mjs";
import {listenBroker} from "../core/mcp/gateway.mjs";
import {launchReceipt} from "../core/execution/receipts.mjs";
function executionFor(x,extra={}){
 const w=x.w;return {format:"ai-fleet-process/v2",adapter_contract:"ai-fleet-adapter/workspace-files-v1",workspace:x.descriptor,adapter_digest:"1".repeat(64),runtime:"claude",model:"fixture-model",effort:"fixture-effort",run_id:w.receipt.run_id,agent_instance_id:w.receipt.agent_instance_id,principal_id:w.receipt.principal_id,command_sha256:"2".repeat(64),python_sha256:"3".repeat(64),files_digest:"4".repeat(64),prompt_sha256:"5".repeat(64),environment_sha256:"6".repeat(64),timeout_ms:5000,heartbeat_ms:50,stderr_limit:1024,...extra};
}
function observed(execution){return {status:"success",evidence:"fixture file session terminal",usage:null,diagnostic:"SUCCESS",real_model_call_confirmed:false,observed:{runtime:"claude",session_id:"fixture-session",turn_id:null,model:"fixture-model",terminal_status:"success",protocol_error:null,bytes:1024,events:2,stdout_sha256:"7".repeat(64)},process:{started:true,pid:123,containment:"windows-job",cleanup:"job_empty",host_sha256:"8".repeat(64),executable_sha256:execution.command_sha256,python_sha256:execution.python_sha256,exit_code:0,host_error:null,host_exit_code:0,stderr_bytes:0,stderr_hashed_bytes:0,stderr_sha256:"9".repeat(64)}};}
function preparedFiles(f,extra={}){const x=workspace(f,extra);x.descriptor=prepareWorkspaceSession(f.db,{workspaceId:x.args.workspaceId});x.execution=executionFor(x);return x;}
function begin(f,x){return authorizeLaunch(f.db,{dispatchId:x.w.receipt.dispatch_id,sourceGate:f.source.gate,execution:x.execution});}
function activeFiles(f,extra={}){const x=preparedFiles(f,extra);begin(f,x);return x;}
const tool=(f,x,name,args={})=>callTool(f.db,x.w.auth,name,{task_uid:x.t.task_uid,...args});
const info=(f,x)=>tool(f,x,"get_workspace");
const read=(f,x,extra={})=>tool(f,x,"read_workspace_file",{path:"src/demo.txt",expected_version:1,offset:0,limit:65536,...extra});
const editArgs=extra=>({request_id:randomUUID(),path:"src/generated.mjs",expected_version:0,offset:0,delete_bytes:0,content:"export const result=42;\n",executable:false,...extra});
const edit=(f,x,extra={})=>tool(f,x,"edit_workspace_file",editArgs(extra));
function settle(f,x,observation=observed(x.execution)){return finishDispatch(f.db,{dispatchId:x.w.receipt.dispatch_id,result:{status:observation.status,evidence:observation.evidence,usage:observation.usage},observation});}


import {repositoryReader} from "../core/artifacts/git-reader.mjs";
import {captureWorkspacePackage} from "../core/artifacts/workspace-commit.mjs";
import {verifyGitPackage,treeFromFiles,base64Bytes,validateDeliveryManifest} from "../core/artifacts/git-package.mjs";
function packageFixture(format="sha1"){
 const f=setup({format}),x=activeFiles(f);edit(f,x);edit(f,x,{path:"src/a.js",content:"a\n"});edit(f,x,{path:"src/a/子模块.js",content:"b\n",executable:true});tool(f,x,"delete_workspace_file",{request_id:randomUUID(),path:"src/demo.txt",expected_version:1});settle(f,x);commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId});
 const p=captureWorkspacePackage(f.db,{workspaceId:x.args.workspaceId}),g=repositoryReader({root:f.r.root,git:pinnedGit}),baseline=g.snapshot({commit:f.r.base,consume(){}});g.verify();return {f,x,p,options:{manifest:p.manifest,manifestDigest:p.manifest_digest,baseline,allowedPaths:["src/"]}};
}
test("actual run-bound SHA1 and SHA256 packages rebuild the exact Git tree and original committed bytes",()=>{
 for(const format of ["sha1","sha256"]){
  const {f,x,p,options}=packageFixture(format),v=verifyGitPackage(p.bytes,options);assert.equal(v.manifest.commit.length,format==="sha1"?40:64);assert.equal(v.content_verified,true);assert.equal(v.accepted,false);assert.equal(v.files.find(f=>f.path==="src/generated.mjs").bytes.toString(),"export const result=42;\n");assert.equal(v.manifest.run_id,x.w.receipt.run_id);assert.equal(treeFromFiles(options.baseline.files,format),git(f.r.root,["rev-parse",f.r.base+"^{tree}"]));
  assert.deepEqual(captureWorkspacePackage(f.db,{workspaceId:x.args.workspaceId}).bytes,p.bytes);
 }
});
test("receiver refuses wrong base, expanded paths, corrupt file bytes and omitted changes",()=>{
 const {p,options}=packageFixture();assert.throws(()=>verifyGitPackage(p.bytes,{...options,allowedPaths:["docs/"]}),{code:"PATH_NOT_ALLOWED"});assert.throws(()=>verifyGitPackage(p.bytes,{...options,baseline:{...options.baseline,commit:"0".repeat(40)}}),{code:"BASE_MISMATCH"});
 for(const mutate of [x=>x.files[0].content=Buffer.from("wrong actual bytes").toString("base64"),x=>x.files.pop(),x=>x.files.push(x.files[0]),x=>x.commit_bytes=Buffer.from("tree malformed\n\n").toString("base64"),x=>x.extra=true]){const value=JSON.parse(p.bytes);mutate(value);assert.throws(()=>verifyGitPackage(Buffer.from(JSON.stringify(value)),options));}
 for(const mutate of [m=>m.task_uid=randomUUID(),m=>m.task_uid=randomUUID()+"/"+randomUUID(),m=>m.stop_proofs=[null]]){const m=structuredClone(p.manifest);mutate(m);assert.throws(()=>validateDeliveryManifest(m));}
 const m=structuredClone(p.manifest);m.files=m.files.filter(f=>f.operation!=="delete");const value=JSON.parse(p.bytes);value.manifest=m;value.manifest_digest=digest(m);assert.throws(()=>verifyGitPackage(Buffer.from(JSON.stringify(value)),{...options,manifest:m,manifestDigest:digest(m)}),{code:"OBJECT_CORRUPT"});
});
test("portable full-tree collisions and noncanonical byte encodings fail before materialization",()=>{
 const file={path:"src/a",mode:"100644",blob_oid:"a".repeat(40)};for(const path of ["src/a/b","SRC/b","src/A","../outside",".git/config"])assert.throws(()=>treeFromFiles([file,{...file,path}],"sha1"));
 for(const s of ["a","YQ=","YR==","YQ==\n","!!!!"])assert.throws(()=>base64Bytes(s,16),{code:"BAD_ARTIFACT_BYTES"});assert.equal(base64Bytes("YQ==",1).toString(),"a");assert.throws(()=>base64Bytes("YWI=",1),{code:"BAD_ARTIFACT_BYTES"});
});

test("maximum allowed file content decodes without regex stack growth",()=>{
 const bytes=Buffer.alloc(8*1024*1024,120),encoded=bytes.toString("base64");assert.deepEqual(base64Bytes(encoded,bytes.length),bytes);assert.throws(()=>base64Bytes(encoded,bytes.length-1),{code:"BAD_ARTIFACT_BYTES"});
});
