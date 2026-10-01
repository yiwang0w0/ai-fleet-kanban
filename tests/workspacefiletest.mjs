import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire,syncBuiltinESMExports} from "node:module";
import childProcess from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync,statSync,renameSync,symlinkSync,openSync,ftruncateSync,closeSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync,spawn} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {prepareAdapter,ADAPTER_CONTRACTS} from "../core/execution/adapters.mjs";
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
function repo(){
 const root=path("task-repo");mkdirSync(root);git(root,["init","--quiet","--template="]);
 mkdirSync(join(root,"src"));mkdirSync(join(root,"docs"));writeFileSync(join(root,"src","demo.txt"),"raw\r\n中文\r\n");writeFileSync(join(root,"docs","readme.md"),"base\n");writeFileSync(join(root,"private.txt"),"history granted by local pool\n");
 git(root,["-c","core.autocrlf=false","add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","base"]);const base=git(root,["rev-parse","HEAD"]);
 writeFileSync(join(root,"src","demo.txt"),"later commit\n");git(root,["add","."]);git(root,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","later"]);writeFileSync(join(root,"untracked.txt"),"do not copy");
 return {root,base};
}
function setup({projectId="demo",executionMode="fixture",sourceInfo=SOURCE}={}){
 const f=fixture({executionMode,sourceInfo}),r=repo(),mapping=registerRepository(f.db,{mappingId:randomUUID(),projectId,repoId:"app",root:r.root,git:pinnedGit,baseCommit:r.base,paths:["src/","docs/"]}),poolRoot=path("pool");mkdirSync(poolRoot);
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

test("file session imports actual permitted baseline bytes and binds the exact launch",()=>{
 const f=setup(),x=preparedFiles(f);assert.deepEqual(prepareWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),x.descriptor);assert.equal(f.db.prepare("SELECT count(*) n FROM workspace_files WHERE workspace_id=?").get(x.args.workspaceId).n,2);
 assert.throws(()=>tool(f,x,"get_workspace"),{code:"LAUNCH_NOT_AVAILABLE"});const permit=begin(f,x);assert.equal(permit.launch_permit,true);assert.equal(state(f,x).executor_bound,true);assert.equal(info(f,x).file_count,2);assert.equal(info(f,x).storage,"transactional_workspace");assert.equal(read(f,x).content,"raw\r\n中文\r\n");assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
 assert.ok(listTools(f.db,x.w.auth).tools.some(t=>t.name==="edit_workspace_file"));const roles=callTool(f.db,x.w.auth,"list_roles",{});assert.equal(roles.roles.find(r=>r.role_id==="engine").enforcement,"mcp_workspace_files_only");assert.equal(roles.roles.find(r=>r.role_id==="coord").enforcement,"board_tool_scope_only");assert.throws(()=>read(f,x,{path:"private.txt"}),{code:"PATH_NOT_ALLOWED"});assert.equal(JSON.stringify(info(f,x)).includes(f.poolRoot),false);
});
test("workspace launch identity, missing session and old board contracts never consume quota",()=>{
 for(const kind of ["binding","board","dirty"]){const f=setup(),x=preparedFiles(f);
  if(kind==="binding")x.execution.workspace={...x.descriptor,baseline_digest:"0".repeat(64)};
  if(kind==="board"){delete x.execution.workspace;x.execution.format="ai-fleet-process/v1";x.execution.adapter_contract="ai-fleet-adapter/board-tools-v1";}
  if(kind==="dirty")writeFileSync(join(directory(f,x),"src/demo.txt"),"local change");
  assert.throws(()=>begin(f,x));assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);assert.equal(count(f,"workspace_launches"),0);assert.equal(count(f,"broker_execution_records"),0);
 }
 const f=setup(),x=workspace(f);assert.throws(()=>launch(f,x.w),{code:"WORKSPACE_ADAPTER_REQUIRED"});assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);
});
test("UTF8 range edits use exact versions and preserve repository files until a delivery commit",()=>{
 const f=setup(),x=activeFiles(f),first=read(f,x,{limit:7});assert.equal(first.content,"raw\r\n");assert.equal(first.next_offset,5);assert.throws(()=>read(f,x,{offset:6}),{code:"BAD_FILE_RANGE"});
 // Removing the middle bytes of two characters could otherwise form a different valid character.
 assert.throws(()=>edit(f,x,{path:"src/demo.txt",expected_version:1,offset:6,delete_bytes:3,content:""}),{code:"BAD_FILE_RANGE"});
 const changed=edit(f,x,{path:"src/demo.txt",expected_version:1,offset:5,delete_bytes:6,content:"日本語"});assert.equal(changed.file.version,2);assert.equal(read(f,x,{expected_version:2}).content,"raw\r\n日本語\r\n");assert.throws(()=>read(f,x),{code:"WORKSPACE_FILE_CHANGED"});
 assert.throws(()=>edit(f,x,{path:"src/demo.txt",expected_version:2,offset:6,delete_bytes:1,content:""}),{code:"BAD_FILE_RANGE"});assert.equal(info(f,x).revision,1);assert.equal(readFileSync(join(directory(f,x),"src/demo.txt"),"utf8"),"raw\r\n中文\r\n");
 assert.equal(tool(f,x,"delete_workspace_file",{request_id:randomUUID(),path:"src/demo.txt",expected_version:2}).file.deleted,true);assert.throws(()=>read(f,x,{expected_version:3}),{code:"WORKSPACE_FILE_MISSING"});
 assert.equal(edit(f,x,{path:"src/demo.txt",expected_version:3,content:"restored"}).file.version,4);
});
test("file bytes, version, event and MCP replay receipt commit atomically",()=>{
 const f=setup(),x=activeFiles(f),args=editArgs();f.db.exec("CREATE TRIGGER fail_file_receipt BEFORE INSERT ON broker_requests WHEN NEW.tool_name='edit_workspace_file' BEGIN SELECT RAISE(ABORT,'fixture MCP receipt'); END");
 assert.throws(()=>tool(f,x,"edit_workspace_file",args),/fixture MCP receipt/);assert.equal(info(f,x).revision,0);assert.equal(count(f,"workspace_file_events"),0);assert.equal(f.db.prepare("SELECT 1 FROM workspace_files WHERE path='src/generated.mjs'").get(),undefined);f.db.exec("DROP TRIGGER fail_file_receipt");
 const result=tool(f,x,"edit_workspace_file",args);assert.deepEqual(tool(f,x,"edit_workspace_file",args),result);assert.equal(info(f,x).revision,1);assert.throws(()=>tool(f,x,"edit_workspace_file",{...args,content:"different"}),{code:"REQUEST_CONFLICT"});assert.equal(count(f,"workspace_file_events"),1);
});
test("roles, run ownership, read scope and declared writes constrain file tools",()=>{
 const f=setup(),a=activeFiles(f),b=activeFiles(f);assert.throws(()=>tool(f,a,"get_workspace",{task_uid:b.t.task_uid}),{code:"FORBIDDEN"});assert.throws(()=>callTool(f.db,f.coord.auth,"get_workspace",{task_uid:a.t.task_uid}),{code:"FORBIDDEN"});assert.equal(listTools(f.db,f.coord.auth).tools.some(t=>t.name==="read_workspace_file"),false);
 assert.throws(()=>edit(f,a,{path:"docs/readme.md",expected_version:1}),{code:"PATH_NOT_ALLOWED"});assert.throws(()=>edit(f,a,{path:"../outside"}),{code:"UNSAFE_ARTIFACT_PATH"});assert.throws(()=>edit(f,a,{path:"src/DEMO.txt"}),{code:"PATH_COLLISION"});assert.throws(()=>edit(f,a,{path:"src/demo.txt/child"}),{code:"PATH_COLLISION"});
 revokePrincipal(f.db,{principalId:a.w.receipt.principal_id,expectedVersion:1});assert.throws(()=>info(f,a),{code:"UNAUTHENTICATED"});assert.equal(info(f,b).revision,0);
});
test("readonly execution policy exposes file reads without edit tools",()=>{
 const f=setup();putRole(f.db,policy("engine","implement",{tools:"read-only"}),1);const x=activeFiles(f);assert.equal(read(f,x).sha256.length,64);assert.equal(listTools(f.db,x.w.auth).tools.some(t=>t.name==="edit_workspace_file"),false);assert.throws(()=>edit(f,x),{code:"FORBIDDEN"});
});
test("pagination detects intervening edits and file limits fail without partial mutations",()=>{
 const f=setup(),x=activeFiles(f),page=tool(f,x,"list_workspace_files",{expected_revision:0,after_path:"",limit:1});assert.equal(page.files.length,1);assert.ok(page.next_path);edit(f,x);
 assert.throws(()=>tool(f,x,"list_workspace_files",{expected_revision:0,after_path:page.next_path,limit:1}),{code:"WORKSPACE_REVISION_CHANGED"});const before=info(f,x).revision;
 assert.throws(()=>edit(f,x,{path:"src/large.txt",content:"中".repeat(30000)}),{code:"BAD_FILE_CONTENT"});assert.throws(()=>edit(f,x,{path:"src/invalid.txt",content:"\ud800"}),{code:"BAD_FILE_CONTENT"});assert.equal(info(f,x).revision,before);
});
test("launch audit failure rolls back workspace binding, execution record and spent permit",()=>{
 const f=setup(),x=preparedFiles(f);f.db.exec("CREATE TRIGGER fail_session_launch BEFORE INSERT ON broker_dispatch_events WHEN NEW.kind='launch_committed' BEGIN SELECT RAISE(ABORT,'fixture launch audit'); END");assert.throws(()=>begin(f,x),/fixture launch audit/);assert.equal(count(f,"workspace_launches"),0);assert.equal(count(f,"broker_execution_records"),0);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);f.db.exec("DROP TRIGGER fail_session_launch");begin(f,x);assert.equal(info(f,x).revision,0);
});
test("stopped run produces actual Git file bytes, deletions and executable modes without touching dirty checkout",()=>{
 const f=setup(),x=activeFiles(f);edit(f,x,{executable:true});tool(f,x,"delete_workspace_file",{request_id:randomUUID(),path:"src/demo.txt",expected_version:1});assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_EXECUTION_INCOMPLETE"});settle(f,x);
 const root=directory(f,x);writeFileSync(join(root,"src/demo.txt"),"preserve user dirty file");writeFileSync(join(root,"untracked.txt"),"preserve untracked");const result=commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),manifest=result.manifest;
 assert.equal(manifest.base_commit,f.r.base);assert.equal(git(root,["rev-parse",manifest.commit+"^"]),f.r.base);assert.equal(git(root,["show",manifest.commit+":src/generated.mjs"]),"export const result=42;");assert.equal(git(root,["ls-tree",manifest.commit,"src/demo.txt"]),"");assert.match(git(root,["ls-tree",manifest.commit,"src/generated.mjs"]),/^100755/);
 assert.equal(git(root,["rev-parse","HEAD"]),f.r.base);assert.equal(readFileSync(join(root,"src/demo.txt"),"utf8"),"preserve user dirty file");assert.equal(readFileSync(join(root,"untracked.txt"),"utf8"),"preserve untracked");assert.equal(result.accepted,false);assert.equal(manifest.fixture_runs,1);assert.equal(manifest.run_id,x.w.receipt.run_id);
 const capture=captureWorkspaceCommit(f.db,{workspaceId:x.args.workspaceId}),independent=path("independent")+".mjs";writeFileSync(independent,capture.files[0].bytes);assert.equal(execFileSync(process.execPath,["--input-type=module","-e","import {result} from "+JSON.stringify(pathToFileURL(independent).href)+"; console.log(result)"],{encoding:"utf8",windowsHide:true}).trim(),"42");assert.deepEqual(commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),result);assert.deepEqual(readdirSync(dirname(root)).filter(n=>n.startsWith("commit-")),[]);assert.throws(()=>info(f,x),{code:"UNAUTHENTICATED"});
});
test("commit audit failure preserves deterministic Git objects and retries without duplicating history",()=>{
 const f=setup(),x=activeFiles(f);edit(f,x);settle(f,x);f.db.exec("CREATE TRIGGER fail_file_commit BEFORE INSERT ON workspace_events WHEN NEW.kind='delivery_commit' BEGIN SELECT RAISE(ABORT,'fixture delivery audit'); END");assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),/fixture delivery audit/);assert.equal(count(f,"workspace_commits"),0);assert.deepEqual(readdirSync(dirname(directory(f,x))).filter(n=>n.startsWith("commit-")),[]);const oid=git(directory(f,x),["rev-parse","refs/fleet/workspaces/"+x.args.workspaceId]);f.db.exec("DROP TRIGGER fail_file_commit");assert.equal(commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}).manifest.commit,oid);assert.equal(count(f,"workspace_commits"),1);
});
test("ending native task execution closes file edits before a process receipt arrives",()=>{
 const f=setup(),x=activeFiles(f);tool(f,x,"report_result",{request_id:randomUUID(),run_id:x.w.receipt.run_id,outcome:"done",evidence:"file tools closed"});const before=count(f,"workspace_file_events");assert.throws(()=>edit(f,x),{code:"RUN_EXPIRED"});assert.equal(count(f,"workspace_file_events"),before);assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_EXECUTION_INCOMPLETE"});settle(f,x);assert.equal(commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}).manifest.files.length,0);
});


test("actual supervised process edits through the broker and yields a verifiable run-bound Git commit",async()=>{
 const f=setup(),x=preparedFiles(f),server=await listenBroker(f.db,{port:0}),script=path("file-agent")+".mjs";
 const program=`import {readFileSync} from 'node:fs';
 const c=JSON.parse(readFileSync(process.argv[2],'utf8')),url=process.argv[3],uid=process.argv[4],session=process.argv[5];
 async function call(name,args){const r=await fetch(url+'/local/v1/tools/call',{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:{task_uid:uid,...args}})});if(!r.ok)throw Error('broker status '+r.status);return (await r.json()).result;}
 const old=await call('read_workspace_file',{path:'src/demo.txt',expected_version:1,offset:0,limit:65536});
 if(!old.content.includes('中文'))throw Error('baseline mismatch');
 await call('edit_workspace_file',{request_id:crypto.randomUUID(),path:'src/generated.mjs',expected_version:0,offset:0,delete_bytes:0,content:'export const result=73;\\n',executable:false});
 process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:session,model:'fixture-model'})+'\\n');
 process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,result:'MCP fixture edited actual file bytes'})+'\\n');`;
 writeFileSync(script,program);const pythonPath=execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys; print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim(),python=pinFile(pythonPath),command=pinFile(process.execPath);
 x.execution=executionFor(x,{command_sha256:command.sha256,python_sha256:python.sha256});begin(f,x);
 try{
  const observation=await superviseProcess({python,command,args:[script,x.w.credentialFile,"http://127.0.0.1:"+server.address().port,x.t.task_uid,x.w.receipt.agent_instance_id],cwd:TMP,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),input:"fixture only",pins:[pinFile(script),pinFile(x.w.credentialFile)],runtime:"claude",timeoutMs:5000,heartbeatMs:50,stderrLimit:1024,heartbeat:()=>store.heartbeat(f.db,{id:x.t.id,worker:x.w.receipt.worker,runId:x.w.receipt.run_id}).task.status==="in_progress"});
  assert.equal(observation.status,"success",JSON.stringify(observation));assert.equal(observation.process.started,true);settle(f,x,observation);
  const out=commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),captured=captureWorkspaceCommit(f.db,{workspaceId:x.args.workspaceId});assert.equal(captured.files[0].bytes.toString(),"export const result=73;\n");assert.equal(out.manifest.launch_digest,digest(x.execution));assert.equal(out.manifest.run_id,x.w.receipt.run_id);assert.equal(out.manifest.real_model_call_confirmed,false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM broker_requests WHERE tool_name='edit_workspace_file' AND principal_id=?").get(x.w.receipt.principal_id).n,1);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test("provider-labelled completion without strong cleanup proof cannot produce a delivery commit",()=>{
 const f=setup({executionMode:"provider"}),x=activeFiles(f);edit(f,x);const o=observed(x.execution);o.status="failed";o.diagnostic="TIMEOUT";o.observed.terminal_status="failed";o.process.cleanup="unconfirmed";settle(f,x,o);
 assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_RUN_NOT_STOPPED"});assert.equal(count(f,"workspace_commits"),0);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
});
test("independent clients racing the same file version apply exactly one edit",async()=>{
 const f=setup(),x=activeFiles(f),script='import {DatabaseSync} from "node:sqlite"; import {callTool} from '+JSON.stringify(new URL("../core/mcp/tools.mjs",import.meta.url).href)+'; const [path,auth,args]=process.argv.slice(1);const db=new DatabaseSync(path);db.exec("PRAGMA busy_timeout=5000");try{const r=callTool(db,auth,"edit_workspace_file",JSON.parse(args));console.log(JSON.stringify({ok:true,revision:r.revision}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}finally{db.close();}';
 const launch=content=>new Promise((resolve,reject)=>{const args={task_uid:x.t.task_uid,...editArgs({content})},p=spawn(process.execPath,["--input-type=module","-e",script,f.dbPath,x.w.auth,JSON.stringify(args)],{windowsHide:true,stdio:["ignore","pipe","pipe"]});children.push(p);let out="",err="";p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>err+=b);p.once("error",reject);p.once("close",code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));});
 const result=await Promise.all([launch("client A"),launch("client B")]);assert.equal(result.filter(x=>x.ok).length,1);assert.equal(result.find(x=>!x.ok).code,"WORKSPACE_FILE_CHANGED");assert.equal(info(f,x).revision,1);assert.equal(count(f,"workspace_file_events"),1);
});
test("MCP file bytes survive database reopen and the explicit CLI prepares and captures real commits",()=>{
 const f=setup(),x=workspace(f),cli=(command)=>JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli/workspace.mjs"),command,"--db",f.dbPath,"--workspace",x.args.workspaceId],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}));x.descriptor=cli("prepare-files");x.execution=executionFor(x);begin(f,x);edit(f,x);
 const reopened=new DatabaseSync(f.dbPath);dbs.push(reopened);assert.equal(callTool(reopened,x.w.auth,"read_workspace_file",{task_uid:x.t.task_uid,path:"src/generated.mjs",expected_version:1,offset:0,limit:65536}).content,"export const result=42;\n");settle(f,x);const result=cli("commit"),capture=cli("manifest");assert.equal(capture.manifest.commit,result.manifest.commit);assert.equal(capture.content_captured,true);assert.equal(capture.transferred,false);assert.equal(JSON.stringify(capture).includes(f.poolRoot),false);
});
test("corrupted current bytes fail reads, edits and commit preparation without claiming output",()=>{
 const f=setup(),x=activeFiles(f);f.db.prepare("UPDATE workspace_files SET content=? WHERE workspace_id=? AND path='src/demo.txt'").run(Buffer.from("tampered"),x.args.workspaceId);assert.throws(()=>read(f,x),{code:"WORKSPACE_SESSION_CORRUPT"});assert.throws(()=>edit(f,x,{path:"src/demo.txt",expected_version:1}),{code:"WORKSPACE_SESSION_CORRUPT"});settle(f,x);assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_SESSION_CORRUPT"});assert.equal(count(f,"workspace_commits"),0);
});
test("recovery activation preserves byte history but old file sessions cannot launch, edit or commit",()=>{
 const f=setup(),x=activeFiles(f);edit(f,x);settle(f,x);const committed=commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),evidence=path("file-evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"file session fixture");const node=store.localNode(f.db),backup=createBackup({dbPath:f.dbPath,evidenceDir:evidence,destination:path("file-backup")}),destination=path("file-restored");restoreBackup({backupDirectory:backup.destination,destination});const dbPath=join(destination,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);retireNode({dbPath:f.dbPath,expectedEpoch:node.sync_epoch});const plan=prepareRecovery({dbPath});activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated file session fixture",attested_at:new Date().toISOString()}});
 assert.throws(()=>captureWorkspaceCommit(db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_RECOVERY_REQUIRED"});assert.throws(()=>prepareWorkspaceSession(db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_RECOVERY_REQUIRED"});assert.equal(db.prepare("SELECT descriptor_digest FROM workspace_commits WHERE workspace_id=?").get(x.args.workspaceId).descriptor_digest,committed.manifest_digest);assert.equal(Buffer.from(db.prepare("SELECT content FROM workspace_files WHERE workspace_id=? AND path='src/generated.mjs'").get(x.args.workspaceId).content).toString(),"export const result=42;\n");
});


test("trusted adapter runner seals a v2 workspace launch, journals its real process and cannot restart",async()=>{
 const sourceInfo=source(),bridge=join(sourceInfo.codeRoot,"bridge.mjs");writeFileSync(bridge,"// fixture bridge; never contacts a model\n");git(sourceInfo.codeRoot,["add","."]);git(sourceInfo.codeRoot,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","fixture bridge"]);writeFileSync(sourceInfo.approvalFile,git(sourceInfo.codeRoot,["rev-parse","HEAD:"]));sourceInfo.gate=createSourceGate({codeRoot:sourceInfo.codeRoot,approvalFile:sourceInfo.approvalFile});
 const f=setup({sourceInfo,executionMode:"provider"}),role=policy("engine","implement",{model:"claude-fixture-1",effort:"low"});putRole(f.db,role,1);
 const dirs=Object.fromEntries(["scratch","private","auth"].map(k=>{const p=path(k);mkdirSync(p);return [k,p];})),t=card(f),w=prepare(f,assign(f,t),{credentialFile:join(dirs.private,"principal.json")}),args={workspaceId:randomUUID(),poolId:f.pool.poolId,dispatchId:w.receipt.dispatch_id,baseCommit:f.r.base,writePaths:["src/"]};createTaskWorkspace(f.db,args);const descriptor=prepareWorkspaceSession(f.db,{workspaceId:args.workspaceId});
 // Node receives Claude flags and exits before any model/network connection.
 const prepared=prepareAdapter({installation:{runtime:"claude",version:ADAPTER_CONTRACTS.claude,program:pinFile(process.execPath),auth_home:dirs.auth},role,dispatch:w.receipt,codeRoot:sourceInfo.codeRoot,workspace:dirs.scratch,privateDirectory:dirs.private,workspaceBinding:descriptor,mcp:{node:pinFile(process.execPath),bridge:pinFile(bridge),url:"http://127.0.0.1:43111",credentialFile:w.credentialFile},prompt:"fixture only",environment:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase())))});
 const pythonPath=execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys; print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim(),options={dispatchId:w.receipt.dispatch_id,sourceGate:sourceInfo.gate,prepared,python:pinFile(pythonPath),privateDirectory:dirs.private,timeoutMs:5000};
 const receipt=await executePreparedDispatch(f.db,options);assert.equal(receipt.phase,"settled");assert.equal(receipt.result.status,"failed");assert.equal(receipt.execution.observation.process.started,true);assert.equal(receipt.execution.observation.real_model_call_confirmed,false);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);assert.deepEqual(receipt.execution.launch.workspace,descriptor);assert.equal(receipt.execution.launch.format,"ai-fleet-process/v2");assert.equal(workspaceState(f.db,{workspaceId:args.workspaceId}).executor_bound,true);assert.equal(reconcileExecutionJournal(f.db,receipt.journal_file).phase,"settled");assert.equal(existsSync(w.credentialFile),false);await assert.rejects(executePreparedDispatch(f.db,options),{code:"LAUNCH_NOT_AVAILABLE"});assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
});
test("schema one upgrades transactionally while preserving existing independent workspaces",()=>{
 const f=setup(),x=workspace(f),before=state(f,x);
 // Exact schema-v1 shape: no file-session tables and the old unbound-launch fence.
 for(const table of ["workspace_sessions","workspace_files","workspace_file_events","workspace_launches","workspace_commits"])f.db.exec("DROP TABLE "+table);
 f.db.exec("DROP TRIGGER workspace_unbound_launch; UPDATE workspace_schema SET version=1; CREATE TRIGGER workspace_unbound_launch BEFORE UPDATE OF launch_at ON broker_dispatches WHEN OLD.launch_at IS NULL AND NEW.launch_at IS NOT NULL AND EXISTS(SELECT 1 FROM task_workspaces WHERE dispatch_id=NEW.dispatch_id) BEGIN SELECT RAISE(ABORT,'WORKSPACE_ADAPTER_REQUIRED'); END; CREATE TRIGGER fail_workspace_upgrade BEFORE UPDATE ON workspace_schema BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");
 assert.throws(()=>state(f,x),{code:"SCHEMA_INCOMPATIBLE"});assert.throws(()=>migrateWorkspaces(f.db),/fixture migration failure/);assert.equal(f.db.prepare("SELECT version FROM workspace_schema").get().version,1);assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_sessions'").get(),undefined);
 f.db.exec("DROP TRIGGER fail_workspace_upgrade");migrateWorkspaces(f.db);assert.deepEqual(state(f,x),before);assert.equal(f.db.prepare("SELECT version FROM workspace_schema").get().version,2);migrateWorkspaces(f.db);assert.deepEqual(state(f,x),before);x.descriptor=prepareWorkspaceSession(f.db,{workspaceId:x.args.workspaceId});x.execution=executionFor(x);begin(f,x);assert.equal(read(f,x).content,"raw\r\n中文\r\n");
});


test("MCP rejects non-boolean executable before file mutations or replay receipts",()=>{
 const f=setup(),x=activeFiles(f),before=count(f,"broker_requests");
 for(const executable of ["yes","false",0,1,null,{},[]])assert.throws(()=>edit(f,x,{executable}),e=>e.code==="BAD_INPUT"&&e.message.includes("executable"));
 assert.equal(info(f,x).revision,0);assert.equal(count(f,"workspace_file_events"),0);assert.equal(count(f,"broker_requests"),before);
 edit(f,x,{executable:false});assert.equal(f.db.prepare("SELECT mode FROM workspace_files WHERE workspace_id=? AND path='src/generated.mjs'").get(x.args.workspaceId).mode,"100644");
 edit(f,x,{path:"src/executable.mjs",executable:true});assert.equal(f.db.prepare("SELECT mode FROM workspace_files WHERE workspace_id=? AND path='src/executable.mjs'").get(x.args.workspaceId).mode,"100755");
});


test("failed Git delivery removes only its temporary index and preserves existing refs and files",()=>{
 const f=setup(),x=activeFiles(f);edit(f,x);settle(f,x);const root=directory(f,x),parent=dirname(root),ref="refs/fleet/workspaces/"+x.args.workspaceId;
 const old=join(parent,"commit-older");mkdirSync(old);writeFileSync(join(old,"index"),"operator-retained");
 git(root,["update-ref",ref,f.r.base]);
 assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_REF_CHANGED"});
 assert.equal(git(root,["rev-parse",ref]),f.r.base);assert.equal(count(f,"workspace_commits"),0);
 assert.deepEqual(readdirSync(parent).filter(n=>n.startsWith("commit-")),["commit-older"]);assert.equal(readFileSync(join(old,"index"),"utf8"),"operator-retained");
 git(root,["update-ref","-d",ref]);assert.ok(commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}).manifest.commit);
 assert.deepEqual(readdirSync(parent).filter(n=>n.startsWith("commit-")),["commit-older"]);
});

test("unexpected temporary content is retained and stops delivery before its database receipt",()=>{
 const f=setup(),x=activeFiles(f);edit(f,x);settle(f,x);let extra;
 const original=childProcess.execFileSync;
 childProcess.execFileSync=(program,args,options)=>{
  const result=original(program,args,options);
  if(args.includes("read-tree")&&options.env?.GIT_INDEX_FILE){extra=join(dirname(options.env.GIT_INDEX_FILE),"keep.txt");writeFileSync(extra,"unknown file must survive");}
  return result;
 };syncBuiltinESMExports();
 try{assert.throws(()=>commitWorkspaceSession(f.db,{workspaceId:x.args.workspaceId}),{code:"WORKSPACE_COMMIT_CLEANUP_FAILED"});}finally{childProcess.execFileSync=original;syncBuiltinESMExports();}
 assert.equal(readFileSync(extra,"utf8"),"unknown file must survive");assert.equal(existsSync(join(dirname(extra),"index")),true);assert.equal(count(f,"workspace_commits"),0);
 assert.match(git(directory(f,x),["rev-parse","refs/fleet/workspaces/"+x.args.workspaceId]),/^[0-9a-f]{40}$/);
});
