import {readFileSync,statSync} from "node:fs";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateRelations,createRelationGraph,localRegistrarPeer,relationStatus,previewTopology,listRelationGraphs} from "../core/federation/relations.mjs";
const usage="node cli/relations.mjs create --db <登记节点DB绝对路径> --project <项目> --members-file <[{node_id,node_epoch}] JSON>\n"+
 "node cli/relations.mjs list --db <登记节点DB绝对路径>\n"+
 "node cli/relations.mjs status --db <登记节点DB> --project <项目> --graph <UUID> --graph-epoch <UUID> [--relation <委派UUID>]\n"+
 "node cli/relations.mjs preview --db <所有者DB> --project <项目> --graph <UUID> --graph-epoch <UUID> --revision <本地图修订>\n"+
 "preview 只读预览，不冻结结构、不远程登记、不放行执行。";
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={create:["db","project","members-file"],list:["db"],status:["db","project","graph","graph-epoch","relation"],preview:["db","project","graph","graph-epoch","revision"]}[command];if(!fields)throw Error(usage);const o={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(!o.db)throw Error("--db 必填；不会默认使用运行部署");db=openPeerDatabase(o.db);migrateRelations(db);let result;
  if(command==="create"){
   if(!o["members-file"]||statSync(o["members-file"]).size>16384)throw Error("成员文件缺失或超过16KiB");let members;try{members=JSON.parse(readFileSync(o["members-file"],"utf8"));}catch{throw Error("成员文件不是有效JSON");}
   result=createRelationGraph(db,{projectId:o.project,members});
  }else if(command==="list")result=listRelationGraphs(db);
  else if(command==="preview")result=previewTopology(db,{projectId:o.project,graphId:o.graph,graphEpoch:o["graph-epoch"],revision:Number(o.revision)});
  else result=relationStatus(db,localRegistrarPeer(db,o.project),{project_id:o.project,graph_id:o.graph,graph_epoch:o["graph-epoch"],relation_id:o.relation??null});
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
