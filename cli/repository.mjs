import {openPeerDatabase} from "../core/federation/peers.mjs";
import {exact} from "../core/mcp/policy.mjs";
import {readRecoveryJSON} from "../core/recovery.mjs";
import {registerRepository,approveRepositoryBase,repositoryState,listRepositories,captureRepositoryFiles} from "../core/artifacts/repositories.mjs";
const usage=[
 "node cli/repository.mjs register --db <数据库绝对路径> --config-file <本机仓库登记JSON>",
 "node cli/repository.mjs approve-base --db <DB> --mapping <UUID> --base <完整提交ID>",
 "node cli/repository.mjs get --db <DB> --project <项目> --repo <仓库ID>",
 "node cli/repository.mjs list --db <DB> --project <项目>",
 "node cli/repository.mjs manifest --db <DB> --project <项目> --repo <仓库ID> --base <已批准提交> --commit <交付提交> --paths-file <相对路径JSON数组>",
 "本机管理命令不接受远端指定路径，不获取远端对象、不创建工作区、不启动模型。manifest 仅输出已读取内容的清单，不代表文件已传输或通过验收。"
].join("\n");
let db;try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={register:["db","config-file"],"approve-base":["db","mapping","base"],get:["db","project","repo"],list:["db","project"],manifest:["db","project","repo","base","commit","paths-file"]}[command],o={};
  if(!fields)throw Error(usage);for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(fields.some(k=>!o[k]))throw Error(usage);db=openPeerDatabase(o.db);let result;
  if(command==="register"){
   const c=readRecoveryJSON(o["config-file"]);exact(c,["mapping_id","project_id","repo_id","root","git","base_commit","paths"],"repository_config");
   result=registerRepository(db,{mappingId:c.mapping_id,projectId:c.project_id,repoId:c.repo_id,root:c.root,git:c.git,baseCommit:c.base_commit,paths:c.paths});
  }else if(command==="approve-base")result=approveRepositoryBase(db,{mappingId:o.mapping,baseCommit:o.base});
  else if(command==="get")result=repositoryState(db,{projectId:o.project,repoId:o.repo});
  else if(command==="list")result=listRepositories(db,{projectId:o.project});
  else{const captured=captureRepositoryFiles(db,{projectId:o.project,repoId:o.repo,baseCommit:o.base,commit:o.commit,paths:readRecoveryJSON(o["paths-file"])});const {files,...metadata}=captured;result={...metadata,content_captured:true,content_persisted:false,transferred:false};}
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
