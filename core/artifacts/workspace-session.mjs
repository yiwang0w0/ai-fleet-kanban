import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {PeerError,uuid} from "../federation/protocol.mjs";
import {transaction,localIdentity} from "../federation/peers.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {migrateWorkspaces,workspaceState,workspaceExecutionRecord,taskWorkspaceDirectory} from "./workspaces.mjs";
import {repositoryState} from "./repositories.mjs";
import {artifactPath,repositoryReader,MAX_FILE_BYTES} from "./git-reader.mjs";
import {verifyInitialWorkspace} from "./git-workspace.mjs";
const require=createRequire(import.meta.url),cancellation=require("../cancellation_guard.js");
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const at=()=>new Date().toISOString(),hash=b=>createHash("sha256").update(b).digest("hex");
const within=(path,policy)=>policy.some(p=>p.endsWith("/")?path.startsWith(p):path===p);
const has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t);
const MAX_CURRENT_BYTES=32*1024*1024,MAX_WRITTEN_BYTES=64*1024*1024,MAX_EDIT_BYTES=65536;
function unit(db,work){if(!db.isTransaction)return transaction(db,work);db.exec("SAVEPOINT workspace_file_unit");try{const r=work();db.exec("RELEASE workspace_file_unit");return r;}catch(e){db.exec("ROLLBACK TO workspace_file_unit; RELEASE workspace_file_unit");throw e;}}
function row(db,workspaceId){workspaceState(db,{workspaceId});return db.prepare("SELECT * FROM task_workspaces WHERE workspace_id=?").get(workspaceId);}
function session(db,r){const s=has(db,"workspace_sessions")?db.prepare("SELECT * FROM workspace_sessions WHERE workspace_id=?").get(r.workspace_id):null;if(!s)fail("WORKSPACE_SESSION_REQUIRED","请先准备工作区文件会话");if(digest(JSON.parse(s.descriptor_json))!==s.descriptor_digest)fail("WORKSPACE_SESSION_CORRUPT","工作区会话身份不一致");return s;}
function preparedRun(db,r){
 const d=db.prepare("SELECT * FROM broker_dispatches WHERE dispatch_id=?").get(r.dispatch_id),t=d&&db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(d.task_uid);
 if(r.state!=="ready"||!d||d.phase!=="prepared"||d.launch_at||!t||t.status!=="in_progress"||t.run_id!==d.run_id||t.aggregate_version!==d.claimed_version||t.archived_at||cancellation.held(db,t.id))fail("WORKSPACE_RUN_CHANGED","工作区准备运行已变化或正在取消");return d;
}
function descriptor(s){const d=JSON.parse(s.descriptor_json);return {workspace_id:d.workspace_id,descriptor_digest:s.descriptor_digest,base_commit:d.base_commit,baseline_digest:d.baseline_digest,access:"mcp-files-v1"};}
/** Import actual committed bytes once. All subsequent agent edits and MCP receipts share SQLite transactions. */
export function prepareWorkspaceSession(db,{workspaceId}){
 if(db.isTransaction)fail("TRANSACTION_CONTEXT","文件会话准备需独立提交");migrateWorkspaces(db);const r=row(db,workspaceId),d=preparedRun(db,r);
 const old=db.prepare("SELECT * FROM workspace_sessions WHERE workspace_id=?").get(workspaceId);if(old)return descriptor(session(db,r));
 const binding=JSON.parse(r.binding_json),receipt=JSON.parse(r.receipt_json),mapping=repositoryState(db,{mappingId:binding.mapping_id}),root=taskWorkspaceDirectory(db,{workspaceId});verifyInitialWorkspace(receipt);
 const local=JSON.parse(db.prepare("SELECT descriptor_json FROM repository_mappings WHERE mapping_id=?").get(binding.mapping_id).descriptor_json),reader=repositoryReader({root,git:local.git}),files=[];let total=0;
 const actual=reader.snapshot({commit:binding.base_commit,consume(meta,bytes){if(!within(meta.path,mapping.allowed_paths))return;total+=bytes.length;if(total>MAX_CURRENT_BYTES)fail("WORKSPACE_SESSION_LIMIT","会话可访问基线总计超过 32 MiB");files.push({...meta,bytes});}});reader.verify();
 if(digest(actual)!==digest(receipt.manifest))fail("WORKSPACE_CONTENT_CHANGED","工作区原始基线清单已变化");
 const value={format:"ai-fleet-workspace-session/v1",workspace_id:workspaceId,dispatch_id:r.dispatch_id,run_id:r.run_id,agent_instance_id:d.agent_instance_id,node_id:r.node_id,node_epoch:r.node_epoch,project_id:binding.project_id,repo_id:binding.repo_id,binding_digest:r.binding_digest,base_commit:binding.base_commit,baseline_digest:digest(actual),read_paths:mapping.allowed_paths,write_paths:binding.write_paths,initial_files:files.map(f=>({path:f.path,mode:f.mode,sha256:f.sha256,size:f.size}))};
 return transaction(db,()=>{
  const current=row(db,workspaceId);preparedRun(db,current);repositoryState(db,{mappingId:binding.mapping_id});verifyInitialWorkspace(receipt);
  const prior=db.prepare("SELECT * FROM workspace_sessions WHERE workspace_id=?").get(workspaceId);if(prior)return descriptor(session(db,current));
  db.prepare("INSERT INTO workspace_sessions(workspace_id,dispatch_id,descriptor_json,descriptor_digest,created_at) VALUES(?,?,?,?,?)").run(workspaceId,r.dispatch_id,canonical(value),digest(value),at());
  for(const f of files)db.prepare("INSERT INTO workspace_files VALUES(?,?,1,?,?,?,0,?)").run(workspaceId,f.path,f.mode,f.bytes,f.sha256,f.sha256);
  db.prepare("INSERT INTO workspace_events(workspace_id,pool_id,kind,detail_json,created_at) VALUES(?,?,'file_session_prepared',?,?)").run(workspaceId,r.pool_id,canonical({descriptor_digest:digest(value),files:files.length,total_bytes:total}),at());return descriptor(session(db,current));
 });
}
export function workspaceLaunchDescriptor(db,dispatchId){const r=workspaceExecutionRecord(db,dispatchId);return r?descriptor(session(db,r)):null;}
export function validateWorkspaceLaunch(db,{dispatchId,execution,policy}){
 const r=workspaceExecutionRecord(db,dispatchId);
 if(!r){if(execution?.workspace||policy?.capabilities.includes("workspace-files"))fail("WORKSPACE_NOT_BOUND","分派没有工作区");return null;}
 if(execution?.format!=="ai-fleet-process/v2"||execution.adapter_contract!=="ai-fleet-adapter/workspace-files-v1"||!policy?.capabilities.includes("workspace-files"))fail("WORKSPACE_ADAPTER_REQUIRED","任务工作区需要专用 MCP 文件执行合同");
 preparedRun(db,r);const s=session(db,r),expected=descriptor(s);
 if(canonical(execution.workspace)!==canonical(expected)||s.revision!==0||s.written_bytes!==0)fail("WORKSPACE_LAUNCH_CHANGED","工作区会话或启动绑定已变化");
 const value=JSON.parse(s.descriptor_json),files=db.prepare("SELECT path,mode,sha256,length(content) size FROM workspace_files WHERE workspace_id=? AND deleted=0 ORDER BY path COLLATE BINARY").all(r.workspace_id).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(canonical(files)!==canonical(value.initial_files))fail("WORKSPACE_SESSION_CORRUPT","初始会话文件与准备记录不一致");
 for(const f of db.prepare("SELECT content,sha256 FROM workspace_files WHERE workspace_id=?").all(r.workspace_id))if(hash(f.content)!==f.sha256)fail("WORKSPACE_SESSION_CORRUPT","初始文件字节摘要不一致");
 taskWorkspaceDirectory(db,{workspaceId:r.workspace_id});verifyInitialWorkspace(JSON.parse(r.receipt_json));
 return r.workspace_id;
}
/** Called inside the same transaction as the execution record and spent permit. */
export function bindWorkspaceLaunch(db,{workspaceId,dispatchId,execution}){
 if(!workspaceId)return;if(!db.isTransaction)fail("TRANSACTION_CONTEXT","工作区启动绑定必须与许可原子提交");
 db.prepare("INSERT INTO workspace_launches VALUES(?,?,?,?)").run(workspaceId,dispatchId,digest(execution),at());
}
function access(db,p,taskUid,write=false){
 localIdentity(db);if(!p.run||p.run.task_uid!==taskUid||!p.role.policy.capabilities.includes("workspace-files"))fail("FORBIDDEN","仅专用执行身份可访问自己的工作区",403);
 if(write&&(p.role.policy.kind!=="implement"||p.role.policy.tools!=="write"))fail("FORBIDDEN","当前身份只读",403);
 const d=db.prepare("SELECT * FROM broker_dispatches WHERE run_id=?").get(p.run_id),r=d&&workspaceExecutionRecord(db,d.dispatch_id),t=d&&db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(taskUid);
 if(!r||r.state!=="ready"||d.phase!=="launch_committed"||!t||t.run_id!==p.run_id||t.status!=="in_progress"||t.archived_at||cancellation.held(db,t.id))fail("WORKSPACE_RUN_CHANGED","工作区运行已结束、替换或正在取消");
 const s=session(db,r),l=db.prepare("SELECT * FROM workspace_launches WHERE workspace_id=?").get(r.workspace_id),e=db.prepare("SELECT launch_digest FROM broker_execution_records WHERE dispatch_id=?").get(d.dispatch_id);
 if(!l||l.launch_digest!==e?.launch_digest||d.principal_id!==p.principal_id||d.agent_instance_id!==p.agent_instance_id||has(db,"workspace_commits")&&db.prepare("SELECT 1 FROM workspace_commits WHERE workspace_id=?").get(r.workspace_id))fail("WORKSPACE_NOT_BOUND","本次执行没有匹配的文件会话");
 const value=JSON.parse(s.descriptor_json);if(!p.projects.includes(value.project_id))fail("FORBIDDEN","项目未授权",403);return {r,s,value};
}
const fileOut=f=>({path:f.path,version:f.version,mode:f.mode,sha256:f.sha256,byte_length:f.content?.length??0,deleted:!!f.deleted});
function file(db,id,path){artifactPath(path);return db.prepare("SELECT * FROM workspace_files WHERE workspace_id=? AND path=?").get(id,path);}
function integer(v,min,max){if(!Number.isSafeInteger(v)||v<min||v>max)fail("BAD_FILE_RANGE","文件版本或字节范围无效");}
export function workspaceFileInfo(db,p,{task_uid}){
 const {r,s,value}=access(db,p,task_uid),size=db.prepare("SELECT count(*) files,coalesce(sum(length(content)),0) bytes FROM workspace_files WHERE workspace_id=? AND deleted=0").get(r.workspace_id);
 return {workspace_id:r.workspace_id,run_id:r.run_id,base_commit:value.base_commit,revision:s.revision,read_paths:value.read_paths,write_paths:value.write_paths,file_count:size.files,total_bytes:size.bytes,storage:"transactional_workspace",written_bytes:s.written_bytes,limits:{file_bytes:MAX_FILE_BYTES,insert_bytes:MAX_EDIT_BYTES,session_bytes:MAX_CURRENT_BYTES,written_bytes:MAX_WRITTEN_BYTES,revisions:512},filesystem_sandbox:false};
}
export function listWorkspaceFiles(db,p,{task_uid,after_path,limit,expected_revision}){
 const {r,s}=access(db,p,task_uid);integer(limit,1,100);integer(expected_revision,0,512);if(s.revision!==expected_revision)fail("WORKSPACE_REVISION_CHANGED","会话清单已变化，请重新分页");if(after_path!=="")artifactPath(after_path);
 const rows=db.prepare("SELECT path,version,mode,sha256,length(content) byte_length,deleted FROM workspace_files WHERE workspace_id=? AND path>? COLLATE BINARY ORDER BY path COLLATE BINARY LIMIT ?").all(r.workspace_id,after_path,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);
 return {workspace_id:r.workspace_id,revision:s.revision,files:rows,next_path:more?rows.at(-1).path:null};
}
export function readWorkspaceFile(db,p,{task_uid,path,expected_version,offset,limit}){
 const {r,value}=access(db,p,task_uid);artifactPath(path);if(!within(path,value.read_paths))fail("PATH_NOT_ALLOWED","文件不在可读范围");
 const f=file(db,r.workspace_id,path);if(!f||f.deleted)fail("WORKSPACE_FILE_MISSING","文件不存在");if(f.version!==expected_version)fail("WORKSPACE_FILE_CHANGED","文件版本已变化");
 integer(offset,0,f.content.length);integer(limit,4,MAX_EDIT_BYTES);const bytes=Buffer.from(f.content);if(hash(bytes)!==f.sha256)fail("WORKSPACE_SESSION_CORRUPT","文件字节摘要不一致");
 try{new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{fail("TEXT_FILE_REQUIRED","此执行配置只读写 UTF-8 文本文件");}
 if(offset<bytes.length&&(bytes[offset]&0xc0)===0x80)fail("BAD_FILE_RANGE","起点须位于 UTF-8 字符边界");let end=Math.min(bytes.length,offset+limit);while(end<bytes.length&&end>offset&&(bytes[end]&0xc0)===0x80)end--;
 return {...fileOut(f),offset,next_offset:end,eof:end===bytes.length,content:bytes.subarray(offset,end).toString("utf8")};
}
function collision(db,id,path){
 for(const f of db.prepare("SELECT path FROM workspace_files WHERE workspace_id=? AND path<>?").all(id,path)){
  const a=path.split("/"),b=f.path.split("/");let i=0;for(;i<Math.min(a.length,b.length);i++){if(a[i].toUpperCase()!==b[i].toUpperCase())break;if(a[i]!==b[i])fail("PATH_COLLISION","路径大小写与已有目录或文件冲突");}
  if(i===Math.min(a.length,b.length))fail("PATH_COLLISION","路径与已有文件或目录冲突");
 }
}
function mutate(db,p,args,deleted){return unit(db,()=>{
 const {r,s,value}=access(db,p,args.task_uid,true),path=artifactPath(args.path);if(!within(path,value.write_paths))fail("PATH_NOT_ALLOWED","文件不在声明写入范围");
 const prior=file(db,r.workspace_id,path);if(prior&&!prior.deleted&&hash(prior.content)!==prior.sha256)fail("WORKSPACE_SESSION_CORRUPT","原文件字节摘要不一致");integer(args.expected_version,0,1000);if((prior?.version??0)!==args.expected_version)fail("WORKSPACE_FILE_CHANGED","文件版本已变化");if(deleted&&(!prior||prior.deleted))fail("WORKSPACE_FILE_MISSING","文件不存在");
 collision(db,r.workspace_id,path);if(s.revision>=512)fail("WORKSPACE_EDIT_LIMIT","本次运行已达到 512 次文件修改");
 let content=null,mode=prior?.mode??"100644";
 if(!deleted){
  if(typeof args.content!=="string"||Buffer.byteLength(args.content)>MAX_EDIT_BYTES||Buffer.from(args.content).toString("utf8")!==args.content||typeof args.executable!=="boolean")fail("BAD_FILE_CONTENT","每次插入需为 64 KiB 内的有效 UTF-8 文本");
  const before=prior&&!prior.deleted?Buffer.from(prior.content):Buffer.alloc(0);integer(args.offset,0,before.length);integer(args.delete_bytes,0,before.length-args.offset);
  if([args.offset,args.offset+args.delete_bytes].some(n=>n<before.length&&(before[n]&0xc0)===0x80))fail("BAD_FILE_RANGE","修改起止须位于 UTF-8 字符边界");
  content=Buffer.concat([before.subarray(0,args.offset),Buffer.from(args.content,"utf8"),before.subarray(args.offset+args.delete_bytes)]);if(content.length>MAX_FILE_BYTES)fail("WORKSPACE_EDIT_LIMIT","文件超过 8 MiB");
  try{new TextDecoder("utf-8",{fatal:true}).decode(content);}catch{fail("BAD_FILE_RANGE","修改切断了 UTF-8 字符或结果不是文本");}mode=args.executable?"100755":"100644";
 }
 const size=db.prepare("SELECT count(*) files,coalesce(sum(length(content)),0) bytes FROM workspace_files WHERE workspace_id=?").get(r.workspace_id),bytes=content?.length??0;
 if(!prior&&size.files>=4096||size.bytes-(prior?.content?.length??0)+bytes>MAX_CURRENT_BYTES||s.written_bytes+bytes>MAX_WRITTEN_BYTES)fail("WORKSPACE_EDIT_LIMIT","会话文件数量或字节容量达到上限");
 const next=(prior?.version??0)+1,sha=deleted?null:hash(content),revision=s.revision+1;
 db.prepare("INSERT INTO workspace_files VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(workspace_id,path) DO UPDATE SET version=excluded.version,mode=excluded.mode,content=excluded.content,sha256=excluded.sha256,deleted=excluded.deleted").run(r.workspace_id,path,next,mode,content,sha,Number(deleted));
 db.prepare("UPDATE workspace_sessions SET revision=?,written_bytes=written_bytes+? WHERE workspace_id=?").run(revision,bytes,r.workspace_id);
 db.prepare("INSERT INTO workspace_file_events VALUES(?,?,?,?,?,?,?,?)").run(r.workspace_id,revision,path,next,deleted?"delete":"edit",sha,bytes,at());
 return {workspace_id:r.workspace_id,revision,file:fileOut(file(db,r.workspace_id,path)),accepted:false};
});}
export const editWorkspaceFile=(db,p,args)=>mutate(db,p,args,false);
export const deleteWorkspaceFile=(db,p,args)=>mutate(db,p,args,true);
