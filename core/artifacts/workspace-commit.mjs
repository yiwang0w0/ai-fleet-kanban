import {execFileSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {localIdentity,transaction} from "../federation/peers.mjs";
import {PeerError,uuid} from "../federation/protocol.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {workspaceState,taskWorkspaceDirectory} from "./workspaces.mjs";
import {repositoryReader,gitPin,gitEnvironment,objectId} from "./git-reader.mjs";
import {inspectStoppedRuns} from "../execution/stop-proof.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const hash=b=>createHash("sha256").update(b).digest("hex");
function context(db,workspaceId){
 workspaceState(db,{workspaceId});const r=db.prepare("SELECT * FROM task_workspaces WHERE workspace_id=?").get(workspaceId),binding=JSON.parse(r.binding_json),d=db.prepare("SELECT * FROM broker_dispatches WHERE dispatch_id=?").get(r.dispatch_id),s=db.prepare("SELECT * FROM workspace_sessions WHERE workspace_id=?").get(workspaceId),l=db.prepare("SELECT * FROM workspace_launches WHERE workspace_id=?").get(workspaceId),run=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(r.run_id);
 if(!s||!l||!run||d.phase!=="settled"||!d.result_digest)fail("WORKSPACE_EXECUTION_INCOMPLETE","交付提交需要已绑定且已结算的实际运行");
 const stopped=inspectStoppedRuns(db,{nodeId:r.node_id,nodeEpoch:r.node_epoch,members:[],runs:[run]});if(stopped.blockers.length)fail("WORKSPACE_RUN_NOT_STOPPED","没有经过核验的进程停止证明");
 const e=db.prepare("SELECT * FROM broker_execution_records WHERE dispatch_id=?").get(r.dispatch_id);if(e?.launch_digest!==l.launch_digest||JSON.parse(e.launch_json).workspace?.descriptor_digest!==s.descriptor_digest)fail("WORKSPACE_NOT_BOUND","执行回执与文件会话不匹配");
 if(digest(JSON.parse(s.descriptor_json))!==s.descriptor_digest||digest(binding)!==r.binding_digest||digest(JSON.parse(e.launch_json))!==l.launch_digest)fail("WORKSPACE_SESSION_CORRUPT","运行或会话回执摘要不一致");
 const original=JSON.parse(s.descriptor_json),initial=new Map(original.initial_files.map(f=>[f.path,f])),files=db.prepare("SELECT * FROM workspace_files WHERE workspace_id=? ORDER BY path COLLATE BINARY").all(workspaceId),changes=[];
 for(const f of files){if(!f.deleted&&hash(f.content)!==f.sha256)fail("WORKSPACE_SESSION_CORRUPT","会话文件字节摘要不一致");const base=initial.get(f.path);if(f.deleted&&!base||!f.deleted&&base&&base.sha256===f.sha256&&base.mode===f.mode)continue;changes.push(f);}
 if(changes.length>256||changes.reduce((n,f)=>n+(f.content?.length??0),0)>32*1024*1024)fail("WORKSPACE_DELIVERY_LIMIT","交付变化超过 256 文件或 32 MiB");
 return {r,binding,d,s,l,stopped,changes};
}
/** Produces actual Git objects in the independent repository. Does not checkout, merge, or erase dirty files. */
export function commitWorkspaceSession(db,{workspaceId}){
 uuid(workspaceId,"workspace_id");if(db.isTransaction)fail("TRANSACTION_CONTEXT","交付对象生成需独立于调用事务");const c=context(db,workspaceId),prior=db.prepare("SELECT * FROM workspace_commits WHERE workspace_id=?").get(workspaceId);
 if(prior)return {manifest:JSON.parse(prior.descriptor_json),manifest_digest:prior.descriptor_digest,accepted:false};
 const root=taskWorkspaceDirectory(db,{workspaceId}),mapping=JSON.parse(db.prepare("SELECT descriptor_json FROM repository_mappings WHERE mapping_id=?").get(c.binding.mapping_id).descriptor_json),pin=gitPin(mapping.git),reader=repositoryReader({root,git:pin}),base=reader.commit(c.binding.base_commit);
 if(base.tree!==c.binding.base_tree)fail("OBJECT_CORRUPT","交付基础树不一致");
 const privateDir=mkdtempSync(join(dirname(root),"commit-")),env={...gitEnvironment(pin.path),GIT_INDEX_FILE:join(privateDir,"index"),GIT_AUTHOR_NAME:"AI Fleet Workspace",GIT_AUTHOR_EMAIL:"workspace@example.invalid",GIT_COMMITTER_NAME:"AI Fleet Workspace",GIT_COMMITTER_EMAIL:"workspace@example.invalid",GIT_AUTHOR_DATE:c.d.finished_at,GIT_COMMITTER_DATE:c.d.finished_at},deadline=performance.now()+30000;
 function run(args,input=null,missing=false){
  gitPin(pin);const remaining=Math.floor(deadline-performance.now());if(remaining<=0)fail("WORKSPACE_COMMIT_TIMEOUT","交付对象生成超过期限");
  try{return execFileSync(pin.path,["--no-pager","--no-lazy-fetch","--no-replace-objects","--no-optional-locks","-c","protocol.allow=never","-c","core.fsmonitor=false","-c","core.untrackedCache=false","-c","commit.gpgSign=false",...args],{cwd:root,env,input,windowsHide:true,timeout:Math.min(10000,remaining),maxBuffer:4*1024*1024,stdio:["pipe","pipe","pipe"]}).toString("utf8").trim();}
  catch(e){if(missing&&e.status===1)return null;fail("WORKSPACE_COMMIT_FAILED","固定 Git 交付对象操作失败");}
 }
 run(["read-tree",base.commit]);const changes=[];
 for(const f of c.changes){
  const oid=f.deleted?"0".repeat(base.commit.length):objectId(run(["hash-object","-w","--no-filters","--stdin"],Buffer.from(f.content)),reader.info.object_format);
  run(["update-index","-z","--index-info"],Buffer.from((f.deleted?"0":f.mode)+" "+oid+"\t"+f.path+"\0"));
  changes.push({path:f.path,operation:f.deleted?"delete":"write",mode:f.deleted?null:f.mode,sha256:f.sha256,size:f.content?.length??0,blob_oid:f.deleted?null:oid,base_sha256:f.base_sha256});
 }
 const tree=objectId(run(["write-tree"]),reader.info.object_format),commit=objectId(run(["commit-tree",tree,"-p",base.commit],Buffer.from("Workspace "+workspaceId+"\nRun "+c.r.run_id+"\nSession "+c.s.descriptor_digest+"\nRevision "+c.s.revision+"\n")),reader.info.object_format);
 const verify=repositoryReader({root,git:pin}),actual=verify.commit(commit);if(actual.tree!==tree||canonical(actual.parents)!==canonical([base.commit]))fail("OBJECT_CORRUPT","生成提交未绑定原始基线");
 const writes=changes.filter(f=>f.operation==="write"),captured=writes.length?verify.capture({baseCommit:base.commit,commit,paths:writes.map(f=>f.path),allowed:c.binding.write_paths}):null;
 if(captured)for(const f of captured.files){const expected=writes.find(x=>x.path===f.path);if(f.sha256!==expected.sha256||f.blob_oid!==expected.blob_oid||f.size!==expected.size||f.mode!==expected.mode)fail("OBJECT_CORRUPT","生成文件与会话实际字节不一致");}verify.verify();
 const full=verify.snapshot({commit,consume(){}}),expected=new Map(JSON.parse(c.r.receipt_json).manifest.files.map(f=>[f.path,f]));
 for(const f of changes)if(f.operation==="delete")expected.delete(f.path);else expected.set(f.path,{path:f.path,mode:f.mode,blob_oid:f.blob_oid,size:f.size,sha256:f.sha256});
 if(canonical(full.files)!==canonical([...expected.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)))fail("OBJECT_CORRUPT","交付完整目录包含未声明变化");
 const ref="refs/fleet/workspaces/"+workspaceId,old=run(["rev-parse","--verify","--quiet",ref],null,true);if(old!==null&&old!==commit)fail("WORKSPACE_REF_CHANGED","交付引用已绑定其他提交");if(old===null)run(["update-ref",ref,commit,"0".repeat(base.commit.length)]);
 const manifest={schema_version:1,kind:"workspace_delivery_commit",node_id:c.r.node_id,node_epoch:c.r.node_epoch,workspace_id:workspaceId,project_id:c.binding.project_id,repo_id:c.binding.repo_id,task_uid:c.binding.task_uid,run_id:c.r.run_id,dispatch_id:c.r.dispatch_id,agent_instance_id:c.binding.agent_instance_id,base_commit:base.commit,commit,tree,content_snapshot_digest:digest(full),session_descriptor_digest:c.s.descriptor_digest,session_revision:c.s.revision,launch_digest:c.l.launch_digest,process_result_digest:c.d.result_digest,stop_proofs:c.stopped.proofs,fixture_runs:c.stopped.fixtureRuns,files:changes,real_model_call_confirmed:false};
 return transaction(db,()=>{
  localIdentity(db);const now=context(db,workspaceId);if(now.s.revision!==c.s.revision||now.d.result_digest!==c.d.result_digest)fail("WORKSPACE_SESSION_CHANGED","生成期间文件会话已变化");
  const old=db.prepare("SELECT * FROM workspace_commits WHERE workspace_id=?").get(workspaceId);if(old){if(old.descriptor_digest!==digest(manifest))fail("WORKSPACE_COMMIT_CONFLICT","交付提交不一致");return {manifest:JSON.parse(old.descriptor_json),manifest_digest:old.descriptor_digest,accepted:false};}
  db.prepare("INSERT INTO workspace_commits VALUES(?,?,?,?)").run(workspaceId,canonical(manifest),digest(manifest),new Date().toISOString());db.prepare("INSERT INTO workspace_events(workspace_id,pool_id,kind,detail_json,created_at) VALUES(?,?,'delivery_commit',?,?)").run(workspaceId,c.r.pool_id,canonical({manifest_digest:digest(manifest),commit}),new Date().toISOString());return {manifest,manifest_digest:digest(manifest),accepted:false};
 });
}
export function captureWorkspaceCommit(db,{workspaceId}){
 workspaceState(db,{workspaceId});const row=db.prepare("SELECT * FROM workspace_commits WHERE workspace_id=?").get(workspaceId);if(!row)fail("WORKSPACE_COMMIT_REQUIRED","尚无该运行的交付提交");const manifest=JSON.parse(row.descriptor_json);if(digest(manifest)!==row.descriptor_digest)fail("WORKSPACE_COMMIT_CORRUPT","交付清单摘要不一致");
 const c=context(db,workspaceId),root=taskWorkspaceDirectory(db,{workspaceId}),mapping=JSON.parse(db.prepare("SELECT descriptor_json FROM repository_mappings WHERE mapping_id=?").get(c.binding.mapping_id).descriptor_json),g=repositoryReader({root,git:mapping.git}),head=g.commit(manifest.commit),paths=manifest.files.filter(f=>f.operation==="write").map(f=>f.path);
 if(head.tree!==manifest.tree||canonical(head.parents)!==canonical([manifest.base_commit]))fail("OBJECT_CORRUPT","交付提交身份不一致");if(digest(g.snapshot({commit:manifest.commit,consume(){}}))!==manifest.content_snapshot_digest)fail("OBJECT_CORRUPT","完整交付目录或字节改变");const capture=paths.length?g.capture({baseCommit:manifest.base_commit,commit:manifest.commit,paths,allowed:c.binding.write_paths}):{files:[]};g.verify();
 for(const f of capture.files){const expected=manifest.files.find(x=>x.path===f.path);if(f.sha256!==expected.sha256||f.size!==expected.size||f.blob_oid!==expected.blob_oid||f.mode!==expected.mode)fail("OBJECT_CORRUPT","交付实际字节不匹配");}
 return {manifest,manifest_digest:row.descriptor_digest,files:capture.files.map(f=>({path:f.path,bytes:f.bytes})),accepted:false,transferred:false};
}
