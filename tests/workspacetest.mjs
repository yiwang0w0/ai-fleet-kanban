import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync,statSync,renameSync,symlinkSync,openSync,ftruncateSync,closeSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync,spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {prepareAdapter} from "../core/execution/adapters.mjs";
import {executePreparedDispatch,reconcileExecutionJournal} from "../core/execution/runner.mjs";
import {digest} from "../core/federation/sync-store.mjs";
import {migratePeers} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,issuePrincipal,revokePrincipal,authenticatePrincipal} from "../core/mcp/policy.mjs";
import {callTool} from "../core/mcp/tools.mjs";
import {pinFile,superviseProcess} from "../core/execution/supervisor.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateDispatch,putQuota,quotaStatus,prepareDispatch,authorizeLaunch,finishDispatch,abandonPrepared,dispatchStatus} from "../core/execution/dispatch.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-workspace-")),dbs=[],children=[];let seq=0;
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
 return {role_id:id,kind,projects:["demo"],capabilities:kind==="implement"?["code"]:[],runtime:kind==="implement"?"claude":null,model:kind==="implement"?"fixture-model":null,effort:kind==="implement"?"fixture-effort":null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300},...extra};
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
function card(f,{kind="task",parent=null,release=true,capabilities=["code"]}={}){
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
function repo(){
 const root=path("task-repo");mkdirSync(root);git(root,["init","--quiet","--template="]);
 mkdirSync(join(root,"src"));mkdirSync(join(root,"docs"));writeFileSync(join(root,"src","demo.txt"),"raw\r\n中文\r\n");writeFileSync(join(root,"docs","readme.md"),"base\n");writeFileSync(join(root,"private.txt"),"history granted by local pool\n");
 git(root,["-c","core.autocrlf=false","add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","base"]);const base=git(root,["rev-parse","HEAD"]);
 writeFileSync(join(root,"src","demo.txt"),"later commit\n");git(root,["add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","later"]);writeFileSync(join(root,"untracked.txt"),"do not copy");
 return {root,base};
}
function setup({projectId="demo"}={}){
 const f=fixture(),r=repo(),mapping=registerRepository(f.db,{mappingId:randomUUID(),projectId,repoId:"app",root:r.root,git:pinnedGit,baseCommit:r.base,paths:["src/","docs/"]}),poolRoot=path("pool");mkdirSync(poolRoot);
 const config={poolId:randomUUID(),mappingId:mapping.mapping_id,root:poolRoot,allowFullHistoryCopy:true};registerWorkspacePool(f.db,config);
 return {...f,r,mapping,poolRoot,pool:config};
}
function request(f,extra={}){const t=card(f),w=prepare(f,assign(f,t));return {w,t,args:{workspaceId:randomUUID(),poolId:f.pool.poolId,dispatchId:w.receipt.dispatch_id,baseCommit:f.r.base,writePaths:["src/"],...extra}};}
function workspace(f,extra={}){const x=request(f,extra);return {...x,state:createTaskWorkspace(f.db,x.args)};}
const directory=(f,x)=>taskWorkspaceDirectory(f.db,{workspaceId:x.args.workspaceId});
const state=(f,x)=>workspaceState(f.db,{workspaceId:x.args.workspaceId});
const retain=(f,x)=>retainTaskWorkspace(f.db,{workspaceId:x.args.workspaceId,reason:"fixture finished; preserve files"});

test("full-history pools require explicit local authority, disjoint directories and immutable registration",()=>{
 const f=setup();assert.throws(()=>registerWorkspacePool(f.db,{...f.pool,allowFullHistoryCopy:false}),{code:"FULL_HISTORY_PERMISSION_REQUIRED"});
 assert.equal(registerWorkspacePool(f.db,f.pool).pool_id,f.pool.poolId);
 assert.throws(()=>registerWorkspacePool(f.db,{...f.pool,poolId:randomUUID()}),{code:"WORKSPACE_POOL_EXISTS"});
 assert.throws(()=>registerWorkspacePool(f.db,{...f.pool,root:f.r.root}),{code:"WORKSPACE_POOL_OVERLAP"});
 const another=path("another-pool");mkdirSync(another);assert.throws(()=>registerWorkspacePool(f.db,{...f.pool,root:another}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>f.db.exec("DELETE FROM workspace_pools"),/retained/);
});
test("actual independent checkout preserves exact approved commit and bytes without source dirt or shared objects",()=>{
 const f=setup(),x=workspace(f),root=directory(f,x);
 assert.equal(x.state.state,"ready");assert.equal(x.state.binding.run_id,x.w.receipt.run_id);assert.equal(x.state.binding.task_uid,x.t.task_uid);
 assert.equal(git(root,["rev-parse","HEAD"]),f.r.base);assert.equal(git(root,["remote"]),"");
 assert.equal(readFileSync(join(root,"src/demo.txt"),"utf8"),"raw\r\n中文\r\n");assert.equal(existsSync(join(root,"untracked.txt")),false);
 assert.equal(readFileSync(join(root,"private.txt"),"utf8"),"history granted by local pool\n");
 assert.equal(x.state.accepted,false);assert.equal(x.state.executor_bound,false);assert.equal(x.state.filesystem_sandbox,false);assert.equal(JSON.stringify(x.state).includes(f.poolRoot),false);
 const oid=git(root,["rev-parse",f.r.base+":src/demo.txt"]),a=statSync(join(root,".git/objects",oid.slice(0,2),oid.slice(2)),{bigint:true}),b=statSync(join(f.r.root,".git/objects",oid.slice(0,2),oid.slice(2)),{bigint:true});
 assert.equal(a.nlink,1n);assert.notEqual(a.ino,b.ino);assert.equal(git(root,["rev-parse","--git-common-dir"]),".git");
});
test("concurrent task directories isolate writes and expose declared target conflicts",()=>{
 const f=setup(),a=workspace(f),b=workspace(f,{writePaths:["src/demo.txt"]}),c=workspace(f,{writePaths:["docs/"]});
 assert.notEqual(directory(f,a),directory(f,b));writeFileSync(join(directory(f,a),"src/demo.txt"),"task A only");
 assert.equal(readFileSync(join(directory(f,b),"src/demo.txt"),"utf8"),"raw\r\n中文\r\n");assert.equal(readFileSync(join(f.r.root,"src/demo.txt"),"utf8"),"later commit\n");
 const overlaps=workspaceConflicts(f.db,{workspaceId:a.args.workspaceId});assert.equal(overlaps.conflicts.length,1);assert.equal(overlaps.conflicts[0].workspace_id,b.args.workspaceId);assert.equal(overlaps.merge_safe,false);assert.equal(workspaceConflicts(f.db,{workspaceId:c.args.workspaceId}).conflicts.length,0);
});
test("workspace requests require an approved base, matching project and declared allowed writes",()=>{
 const f=setup(),x=request(f);assert.throws(()=>createTaskWorkspace(f.db,{...x.args,writePaths:["private.txt"]}),{code:"PATH_NOT_ALLOWED"});
 assert.throws(()=>createTaskWorkspace(f.db,{...x.args,baseCommit:git(f.r.root,["rev-parse","HEAD"])}),{code:"BASE_NOT_APPROVED"});
 assert.throws(()=>createTaskWorkspace(f.db,{...x.args,writePaths:["../outside"]}),{code:"UNSAFE_ARTIFACT_PATH"});
 assert.equal(count(f,"task_workspaces"),0);const other=setup({projectId:"other"}),y=request(other);assert.throws(()=>createTaskWorkspace(other.db,y.args),{code:"WORKSPACE_PROJECT_MISMATCH"});assert.equal(count(other,"task_workspaces"),0);
});
test("replays preserve modified files and one actual run cannot acquire a replacement workspace",()=>{
 const f=setup(),x=workspace(f),root=directory(f,x);writeFileSync(join(root,"src/demo.txt"),"uncommitted work");
 assert.deepEqual(createTaskWorkspace(f.db,x.args),x.state);assert.equal(readFileSync(join(root,"src/demo.txt"),"utf8"),"uncommitted work");
 assert.throws(()=>createTaskWorkspace(f.db,{...x.args,writePaths:["docs/"]}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>createTaskWorkspace(f.db,{...x.args,workspaceId:randomUUID()}),{code:"WORKSPACE_ALREADY_BOUND"});
 assert.equal(count(f,"task_workspaces"),1);assert.equal(f.db.prepare("SELECT count(*) n FROM workspace_events WHERE kind='ready'").get().n,1);
});
test("workspace-bound runs cannot spend a permit through existing board-only or direct SQL launches",()=>{
 const f=setup(),x=workspace(f);assert.throws(()=>launch(f,x.w),{code:"WORKSPACE_ADAPTER_REQUIRED"});assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);
 assert.throws(()=>f.db.prepare("UPDATE broker_dispatches SET launch_at=? WHERE dispatch_id=?").run(new Date().toISOString(),x.w.receipt.dispatch_id),/WORKSPACE_ADAPTER_REQUIRED/);
 assert.equal(dispatchStatus(f.db,x.w.receipt.dispatch_id).phase,"prepared");assert.throws(()=>retain(f,x),{code:"WORKSPACE_RUN_NOT_STOPPED"});
});
test("existing directories are never overwritten or automatically retried after provisioning fails",()=>{
 const f=setup(),x=request(f),dir=join(f.poolRoot,x.args.workspaceId);mkdirSync(dir);writeFileSync(join(dir,"keep.txt"),"existing evidence");
 assert.throws(()=>createTaskWorkspace(f.db,x.args));assert.equal(state(f,x).state,"failed");assert.equal(readFileSync(join(dir,"keep.txt"),"utf8"),"existing evidence");
 assert.equal(createTaskWorkspace(f.db,x.args).state,"failed");assert.equal(existsSync(join(dir,"repo")),false);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);
});
test("unsafe Git modes and LFS pointers preserve partial directories without claiming readiness",()=>{
 for(const kind of ["symlink","submodule","lfs"]){const f=setup();
  if(kind==="lfs"){writeFileSync(join(f.r.root,"src/lfs.txt"),"version https://git-lfs.github.com/spec/v1\noid sha256:"+"0".repeat(64)+"\nsize 42\n");git(f.r.root,["add","src/lfs.txt"]);}
  else{const oid=kind==="submodule"?f.r.base:execFileSync(gitPath,["hash-object","-w","--stdin"],{cwd:f.r.root,input:"../../outside",encoding:"utf8",windowsHide:true}).trim();git(f.r.root,["update-index","--add","--cacheinfo",(kind==="submodule"?"160000":"120000")+","+oid+",src/special"]);}
  git(f.r.root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m",kind]);const base=git(f.r.root,["rev-parse","HEAD"]);approveRepositoryBase(f.db,{mappingId:f.mapping.mapping_id,baseCommit:base});const x=request(f,{baseCommit:base});
  assert.throws(()=>createTaskWorkspace(f.db,x.args),{code:kind==="lfs"?"LFS_CONTENT_REQUIRED":"FILE_TYPE_UNSUPPORTED"});assert.equal(state(f,x).state,"failed");assert.equal(existsSync(join(f.poolRoot,x.args.workspaceId,"repo/.git")),true);
 }
});
test("source filters, hooks and attribute newline transformations never run during materialization",()=>{
 const f=setup(),sentinel=join(f.r.root,"FILTER_OR_HOOK_RAN");
 git(f.r.root,["config","filter.trap.smudge","touch "+sentinel]);writeFileSync(join(f.r.root,".gitattributes"),"*.txt filter=trap text eol=crlf\n");git(f.r.root,["add",".gitattributes"]);git(f.r.root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","attributes"]);
 const hook=join(f.r.root,".git/hooks");mkdirSync(hook,{recursive:true});writeFileSync(join(hook,"post-checkout"),"#!/bin/sh\ntouch '"+sentinel.replaceAll("\\","/")+"'\n");
 const base=git(f.r.root,["rev-parse","HEAD"]);approveRepositoryBase(f.db,{mappingId:f.mapping.mapping_id,baseCommit:base});const x=workspace(f,{baseCommit:base});
 assert.equal(existsSync(sentinel),false);assert.equal(readFileSync(join(directory(f,x),"src/demo.txt"),"utf8"),"later commit\n");assert.equal(existsSync(join(directory(f,x),".git/hooks/post-checkout")),false);
});
test("external object stores and oversized copies are rejected before cloning",()=>{
 for(const kind of ["alternates","bytes"]){const f=setup(),x=request(f);
  if(kind==="alternates")writeFileSync(join(f.r.root,".git/objects/info/alternates"),"/unavailable/outside\n");
  else{const fd=openSync(join(f.r.root,".git/objects/oversized"),"wx");ftruncateSync(fd,512*1024*1024+1);closeSync(fd);}
  assert.throws(()=>createTaskWorkspace(f.db,x.args),{code:kind==="alternates"?"SHARED_OBJECT_STORE":"WORKSPACE_COPY_LIMIT"});assert.equal(state(f,x).state,"failed");assert.equal(existsSync(join(f.poolRoot,x.args.workspaceId)),false);
 }
});
test("audit failures roll back reservation or readiness while retaining completed filesystem work",()=>{
 const f=setup(),x=request(f);f.db.exec("CREATE TRIGGER fail_workspace_event BEFORE INSERT ON workspace_events WHEN NEW.kind='reserved' BEGIN SELECT RAISE(ABORT,'fixture reserve audit'); END");assert.throws(()=>createTaskWorkspace(f.db,x.args),/fixture reserve audit/);assert.equal(count(f,"task_workspaces"),0);assert.equal(existsSync(join(f.poolRoot,x.args.workspaceId)),false);
 f.db.exec("DROP TRIGGER fail_workspace_event; CREATE TRIGGER fail_workspace_event BEFORE INSERT ON workspace_events WHEN NEW.kind='ready' BEGIN SELECT RAISE(ABORT,'fixture ready audit'); END");assert.throws(()=>createTaskWorkspace(f.db,x.args),/fixture ready audit/);assert.equal(state(f,x).state,"failed");assert.equal(state(f,x).baseline,null);assert.equal(existsSync(join(f.poolRoot,x.args.workspaceId,"repo/src/demo.txt")),true);
});
test("retention requires observed stop, keeps dirty/untracked files, and is transactional and idempotent",()=>{
 const f=setup(),x=workspace(f),root=directory(f,x);writeFileSync(join(root,"src/demo.txt"),"modified and uncommitted");writeFileSync(join(root,"new.txt"),"untracked evidence");
 assert.throws(()=>retain(f,x),{code:"WORKSPACE_RUN_NOT_STOPPED"});abandonPrepared(f.db,{dispatchId:x.w.receipt.dispatch_id,reason:"no executor started"});
 f.db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON workspace_events WHEN NEW.kind='retained' BEGIN SELECT RAISE(ABORT,'fixture retention audit'); END");assert.throws(()=>retain(f,x),/fixture retention audit/);assert.equal(state(f,x).state,"ready");f.db.exec("DROP TRIGGER fail_retention");
 const retained=retain(f,x);assert.equal(retained.state,"retained");assert.equal(retained.stop_proof.proofs[0].kind,"never_launched");assert.equal(retained.stop_proof.physical_files_deleted,false);assert.deepEqual(retain(f,x),retained);
 assert.equal(readFileSync(join(root,"src/demo.txt"),"utf8"),"modified and uncommitted");assert.equal(readFileSync(join(root,"new.txt"),"utf8"),"untracked evidence");assert.throws(()=>f.db.exec("DELETE FROM task_workspaces"),/retained/);assert.throws(()=>f.db.exec("UPDATE task_workspaces SET state='ready'"),/immutable|transition/);
});
test("pool and checkout directory replacement is detected and never silently remapped",()=>{
 const f=setup(),x=workspace(f),root=directory(f,x);renameSync(root,root+"-retained");mkdirSync(root);assert.throws(()=>directory(f,x),{code:"WORKSPACE_DIRECTORY_CHANGED"});
 const other=setup(),y=request(other);renameSync(other.poolRoot,other.poolRoot+"-old");mkdirSync(other.poolRoot);assert.throws(()=>createTaskWorkspace(other.db,y.args),{code:"WORKSPACE_DIRECTORY_CHANGED"});assert.equal(count(other,"task_workspaces"),0);
});
test("changed or already launched native runs cannot retroactively bind an unused workspace",()=>{
 for(const kind of ["launched","ended"]){const f=setup(),x=request(f);if(kind==="launched")launch(f,x.w);else abandonPrepared(f.db,{dispatchId:x.w.receipt.dispatch_id,reason:"abandoned before copy"});assert.throws(()=>createTaskWorkspace(f.db,x.args),{code:"WORKSPACE_RUN_CHANGED"});assert.equal(count(f,"task_workspaces"),0);}
});
test("CLI creates and inspects a real task checkout with an explicit database",()=>{
 const f=setup(),x=request(f),config=path("workspace-config")+".json";writeFileSync(config,JSON.stringify({workspace_id:x.args.workspaceId,pool_id:x.args.poolId,dispatch_id:x.args.dispatchId,base_commit:x.args.baseCommit,write_paths:x.args.writePaths}));
 const cli=(command,args)=>JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli/workspace.mjs"),command,"--db",f.dbPath,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}));
 assert.equal(cli("create",["--config-file",config]).state,"ready");assert.equal(cli("get",["--workspace",x.args.workspaceId]).run_id,x.w.receipt.run_id);assert.equal(cli("directory",["--workspace",x.args.workspaceId]).directory,directory(f,x));assert.equal(cli("conflicts",["--workspace",x.args.workspaceId]).conflicts.length,0);
 abandonPrepared(f.db,{dispatchId:x.w.receipt.dispatch_id,reason:"CLI test complete"});assert.equal(cli("retain",["--workspace",x.args.workspaceId,"--reason","keep actual bytes"]).state,"retained");
});
test("schema changes are refused and durable provisioning records cannot be silently restarted",()=>{
 const f=setup(),x=workspace(f);migrateWorkspaces(f.db);f.db.exec("UPDATE workspace_schema SET version=999");assert.throws(()=>state(f,x),{code:"SCHEMA_INCOMPATIBLE"});assert.throws(()=>migrateWorkspaces(f.db),{code:"SCHEMA_INCOMPATIBLE"});assert.throws(()=>launch(f,x.w),{code:"SCHEMA_INCOMPATIBLE"});f.db.exec("UPDATE workspace_schema SET version=1");
 assert.throws(()=>f.db.exec("UPDATE task_workspaces SET binding_digest='changed'"),/immutable/);assert.throws(()=>f.db.exec("UPDATE task_workspaces SET receipt_digest='changed'"),/immutable/);
});


test("two independent processes cannot provision two directories for one dispatch",async()=>{
 const f=setup(),x=request(f),a={...x.args},b={...x.args,workspaceId:randomUUID()};
 const script='import {DatabaseSync} from "node:sqlite"; import {createTaskWorkspace} from '+JSON.stringify(new URL("../core/artifacts/workspaces.mjs",import.meta.url).href)+'; const [path,config]=process.argv.slice(1);const db=new DatabaseSync(path);db.exec("PRAGMA busy_timeout=5000");try{const r=createTaskWorkspace(db,JSON.parse(config));console.log(JSON.stringify({ok:true,id:r.workspace_id,state:r.state}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}finally{db.close();}';
 const start=config=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,["--input-type=module","-e",script,f.dbPath,JSON.stringify(config)],{windowsHide:true,stdio:["ignore","pipe","pipe"]});children.push(p);let out="",err="";p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>err+=b);p.once("error",reject);p.once("close",code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));});
 const results=await Promise.all([start(a),start(b)]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,"WORKSPACE_ALREADY_BOUND");assert.equal(results.find(r=>r.ok).state,"ready");assert.equal(count(f,"task_workspaces"),1);assert.equal([a,b].filter(c=>existsSync(join(f.poolRoot,c.workspaceId))).length,1);
});
test("actual backup activation leaves old workspace files intact and prohibits old epoch reuse",()=>{
 const f=setup(),x=workspace(f),root=directory(f,x),evidence=path("evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"isolated workspace evidence");
 abandonPrepared(f.db,{dispatchId:x.w.receipt.dispatch_id,reason:"stop fixture before backup"});retain(f,x);writeFileSync(join(root,"preserve.txt"),"not in database backup");
 const node=store.localNode(f.db),backup=createBackup({dbPath:f.dbPath,evidenceDir:evidence,destination:path("backup")}),destination=path("restored");restoreBackup({backupDirectory:backup.destination,destination});const dbPath=join(destination,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);
 assert.throws(()=>workspaceState(db,{workspaceId:x.args.workspaceId}),{code:"RESTORE_HOLD"});retireNode({dbPath:f.dbPath,expectedEpoch:node.sync_epoch});const plan=prepareRecovery({dbPath});
 activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated workspace fixture",attested_at:new Date().toISOString()}});
 assert.throws(()=>workspaceState(db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_RECOVERY_REQUIRED"});assert.throws(()=>createTaskWorkspace(db,x.args),{code:"WORKSPACE_RECOVERY_REQUIRED"});assert.equal(readFileSync(join(root,"preserve.txt"),"utf8"),"not in database backup");
});
test("baseline files are bounded before ready and malformed reserved paths cannot reach disk",()=>{
 for(const kind of ["oversized","reserved"]){const f=setup();let base;
  if(kind==="oversized"){
   writeFileSync(join(f.r.root,"src/large.bin"),Buffer.alloc(8*1024*1024+1,65));git(f.r.root,["add","src/large.bin"]);git(f.r.root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m",kind]);base=git(f.r.root,["rev-parse","HEAD"]);
  }else{
   // Construct a tree object without asking Windows Git's index to admit NUL.
   const plumbing=(args,input)=>execFileSync(gitPath,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid",...args],{cwd:f.r.root,input,encoding:"utf8",windowsHide:true,stdio:["pipe","pipe","pipe"]}).trim();
   const blob=git(f.r.root,["rev-parse",f.r.base+":src/demo.txt"]),tree=plumbing(["mktree"],"100644 blob "+blob+"\tNUL.txt\n");base=plumbing(["commit-tree",tree,"-p",f.r.base],"malformed baseline\n");
  }
  approveRepositoryBase(f.db,{mappingId:f.mapping.mapping_id,baseCommit:base});const x=request(f,{baseCommit:base});
  assert.throws(()=>createTaskWorkspace(f.db,x.args),{code:kind==="oversized"?"WORKSPACE_CONTENT_LIMIT":"UNSAFE_ARTIFACT_PATH"});assert.equal(state(f,x).state,"failed");
 }
});

test("native SHA256 baseline commits remain original object IDs in an independent task repository",()=>{
 const f=fixture(),root=path("sha256-source");mkdirSync(root);git(root,["init","--quiet","--template=","--object-format=sha256"]);writeFileSync(join(root,"code.txt"),"native SHA256\n");git(root,["add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","base"]);const base=git(root,["rev-parse","HEAD"]);
 const mapping=registerRepository(f.db,{mappingId:randomUUID(),projectId:"demo",repoId:"app",root,git:pinnedGit,baseCommit:base,paths:["code.txt"]}),poolRoot=path("sha256-pool");mkdirSync(poolRoot);const config={poolId:randomUUID(),mappingId:mapping.mapping_id,root:poolRoot,allowFullHistoryCopy:true};registerWorkspacePool(f.db,config);
 const complete={...f,r:{root,base},mapping,poolRoot,pool:config},x=workspace(complete,{writePaths:["code.txt"]});assert.equal(x.state.baseline.commit.length,64);assert.equal(git(directory(complete,x),["rev-parse","HEAD"]),base);assert.equal(readFileSync(join(directory(complete,x),"code.txt"),"utf8"),"native SHA256\n");
});


test("full-tree expansion checks file counts and case-colliding directories before writing their files",()=>{
 for(const kind of ["count","collision"]){const f=setup(),blob=git(f.r.root,["rev-parse",f.r.base+":src/demo.txt"]);
  const plumbing=(args,input)=>execFileSync(gitPath,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid",...args],{cwd:f.r.root,input,encoding:"utf8",windowsHide:true,stdio:["pipe","pipe","pipe"]}).trim();
  let tree;if(kind==="count")tree=plumbing(["mktree"],Array.from({length:4097},(_,i)=>"100644 blob "+blob+"\tf"+String(i).padStart(5,"0")+"\n").join(""));
  else{const child=plumbing(["mktree"],"100644 blob "+blob+"\ta.txt\n");tree=plumbing(["mktree"],"040000 tree "+child+"\tCase\n040000 tree "+child+"\tcase\n");}
  const base=plumbing(["commit-tree",tree,"-p",f.r.base],"bounded baseline\n");approveRepositoryBase(f.db,{mappingId:f.mapping.mapping_id,baseCommit:base});const x=request(f,{baseCommit:base});
  assert.throws(()=>createTaskWorkspace(f.db,x.args),{code:kind==="count"?"WORKSPACE_CONTENT_LIMIT":"PATH_COLLISION"});assert.equal(state(f,x).state,"failed");
 }
});
