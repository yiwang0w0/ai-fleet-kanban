import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateResults,prepareResult,rejectResult,resultState,listResults} from "../core/federation/results.mjs";
import {deliverResult} from "../core/federation/result-client.mjs";
const usage=[
 "node cli/result.mjs prepare --db <接收数据库绝对路径> --relation <UUID> --id <交付UUID> --version <当前任务版本>",
 "node cli/result.mjs send|poll --db <接收数据库> --result <UUID> --url <来源节点地址> --credential <反向凭据文件>",
 "node cli/result.mjs reject --db <来源数据库> --result <UUID> --decision <裁定UUID> --version <来源任务版本> --note <返工说明>",
 "node cli/result.mjs get --db <数据库> --result <UUID>",
 "node cli/result.mjs list --db <数据库> --project <项目>",
 "候选交付不是验收通过；只有收到来源拒绝并原子保存后，才可返回本机返工队列。以上命令不启动模型。"
].join("\n");
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={prepare:["db","relation","id","version"],send:["db","result","url","credential"],poll:["db","result","url","credential"],reject:["db","result","decision","version","note"],get:["db","result"],list:["db","project"]}[command];
  if(!fields)throw Error(usage);const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(!o.db)throw Error("--db 必填，不默认连接当前部署");db=openPeerDatabase(o.db);migrateResults(db);let r;
  if(command==="prepare")r=prepareResult(db,{resultId:o.id,relationId:o.relation,expectedTaskVersion:Number(o.version)});
  else if(command==="reject")r=rejectResult(db,{resultId:o.result,decisionId:o.decision,expectedSourceVersion:Number(o.version),note:o.note});
  else if(command==="get")r=resultState(db,o.result);
  else if(command==="list")r=listResults(db,{projectId:o.project});
  else r=await deliverResult(db,{resultId:o.result,mode:command,url:o.url,credentialFile:o.credential});
  console.log(JSON.stringify(r,null,2));if(["retry_pending","blocked"].includes(r.delivery_state))process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
