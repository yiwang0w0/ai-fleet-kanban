import {commitWorkspaceSession,captureWorkspaceCommit} from "../core/artifacts/workspace-commit.mjs";
import {prepareWorkspaceSession} from "../core/artifacts/workspace-session.mjs";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {readRecoveryJSON} from "../core/recovery.mjs";
import {exact} from "../core/mcp/policy.mjs";
import {recoverStaleWorkspaces,registerWorkspacePool,createTaskWorkspace,workspaceState,workspaceConflicts,taskWorkspaceDirectory,retainTaskWorkspace} from "../core/artifacts/workspaces.mjs";
const usage=[
 "node cli/workspace.mjs recover-stale --db <DB> (封存超过十分钟的准备记录，保留全部文件)",
 "node cli/workspace.mjs register-pool --db <DB绝对路径> --config-file <本机JSON>",
 "node cli/workspace.mjs create --db <DB> --config-file <已准备运行的工作区JSON>",
 "node cli/workspace.mjs commit|manifest --db <DB> --workspace <UUID>",
 "node cli/workspace.mjs prepare-files --db <DB> --workspace <UUID>",
 "node cli/workspace.mjs get|conflicts|directory --db <DB> --workspace <UUID>",
 "node cli/workspace.mjs retain --db <DB> --workspace <UUID> --reason <保留原因>",
 "本机管理命令：池需显式授权复制完整本机 Git 历史；工作区只为已领取且未启动运行创建，不启动模型。retain 核对停止证明并保留所有文件，不删除未提交改动。"
].join("\n");
let db;try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={"recover-stale":["db"],"register-pool":["db","config-file"],create:["db","config-file"],commit:["db","workspace"],manifest:["db","workspace"],"prepare-files":["db","workspace"],get:["db","workspace"],conflicts:["db","workspace"],directory:["db","workspace"],retain:["db","workspace","reason"]}[command],o={};
  if(!fields)throw Error(usage);for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(fields.some(k=>!o[k]))throw Error(usage);db=openPeerDatabase(o.db);let result;
  if(command==="recover-stale")result=recoverStaleWorkspaces(db);
  else if(command==="register-pool"){const c=readRecoveryJSON(o["config-file"]);exact(c,["pool_id","mapping_id","root","allow_full_history_copy"],"workspace_pool");result=registerWorkspacePool(db,{poolId:c.pool_id,mappingId:c.mapping_id,root:c.root,allowFullHistoryCopy:c.allow_full_history_copy});}
  else if(command==="create"){const c=readRecoveryJSON(o["config-file"]);exact(c,["workspace_id","pool_id","dispatch_id","base_commit","write_paths"],"task_workspace");result=createTaskWorkspace(db,{workspaceId:c.workspace_id,poolId:c.pool_id,dispatchId:c.dispatch_id,baseCommit:c.base_commit,writePaths:c.write_paths});}
  else if(command==="commit")result=commitWorkspaceSession(db,{workspaceId:o.workspace});
  else if(command==="manifest"){const {files,...receipt}=captureWorkspaceCommit(db,{workspaceId:o.workspace});result={...receipt,content_captured:true};}
  else if(command==="prepare-files")result=prepareWorkspaceSession(db,{workspaceId:o.workspace});
  else if(command==="get")result=workspaceState(db,{workspaceId:o.workspace});
  else if(command==="conflicts")result=workspaceConflicts(db,{workspaceId:o.workspace});
  else if(command==="directory")result={workspace_id:o.workspace,directory:taskWorkspaceDirectory(db,{workspaceId:o.workspace}),local_only:true};
  else result=retainTaskWorkspace(db,{workspaceId:o.workspace,reason:o.reason});
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
