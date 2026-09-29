import {readFileSync,statSync} from "node:fs";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateTopology,bindTopology,prepareTopology,topologyState,topologyOperation} from "../core/federation/topology.mjs";
import {sendTopology} from "../core/federation/topology-client.mjs";
const usage="node cli/topology.mjs bind --db <DB绝对路径> --project <项目> --graph <UUID> --graph-epoch <UUID> --registrar <node_id> --registrar-epoch <UUID>\n"+
 "node cli/topology.mjs prepare --db <DB> --project <项目> --operation <UUID> --revision <本地修订，初次0> [--edits-file <JSON文件>]\n"+
 "node cli/topology.mjs send|cancel --db <DB> --operation <UUID> [--url <固定地址> --credential <凭据文件>]\n"+
 "node cli/topology.mjs status --db <DB> --project <项目>\nnode cli/topology.mjs operation --db <DB> --operation <UUID>\n"+
 "prepare 持久移除将被替换的旧边并暂停项目新领取；send 确认后才添加新边。网络失败保持可恢复状态。";
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={bind:["db","project","graph","graph-epoch","registrar","registrar-epoch"],prepare:["db","project","operation","revision","edits-file"],send:["db","operation","url","credential"],cancel:["db","operation","url","credential"],status:["db","project"],operation:["db","operation"]}[command];if(!fields)throw Error(usage);const o={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(!o.db)throw Error("--db 必填；不会默认使用运行部署");db=openPeerDatabase(o.db);migrateTopology(db);let result;
  if(command==="bind")result=bindTopology(db,{projectId:o.project,graphId:o.graph,graphEpoch:o["graph-epoch"],registrarNodeId:o.registrar,registrarEpoch:o["registrar-epoch"]});
  else if(command==="prepare"){let edits=[];if(o["edits-file"]){if(statSync(o["edits-file"]).size>4*1024*1024)throw Error("修改文件超过4MiB");try{edits=JSON.parse(readFileSync(o["edits-file"],"utf8"));}catch{throw Error("修改文件不是有效JSON");}}result=prepareTopology(db,{projectId:o.project,operationId:o.operation,expectedRevision:Number(o.revision),edits});}
  else if(command==="status")result=topologyState(db,o.project);
  else if(command==="operation")result=topologyOperation(db,o.operation);
  else{result=await sendTopology(db,{operationId:o.operation,url:o.url,credentialFile:o.credential,mode:command==="send"?"publish":"cancel"});if(["retry_pending","blocked","rejected"].includes(result.delivery_state))process.exitCode=2;}
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
