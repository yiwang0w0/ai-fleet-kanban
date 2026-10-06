import {migrateCancellationClosure,cancellationClosureState,settleCancellation} from "../core/federation/cancellation-closure.mjs";
import {submitCancellationRetirement} from "../core/federation/cancellation-closure-client.mjs";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateCancellations,listCancellations,prepareCancellation,cancellationState} from "../core/federation/cancellation.mjs";
import {progressCancellation} from "../core/federation/cancellation-service.mjs";
import {deliverCancellation} from "../core/federation/cancellation-client.mjs";
import {names} from "../core/federation/protocol.mjs";
const usage=[
 "node cli/cancellation.mjs request --db <DB绝对路径> --relation <UUID> --id <取消UUID> --version <当前任务版本> --reason operator_cancelled|deadline_exceeded",
 "node cli/cancellation.mjs send|poll --db <来源DB> --relation <UUID> --url <接收节点地址> --credential <凭据文件>",
 "node cli/cancellation.mjs progress --db <接收DB> --relation <UUID>",
 "node cli/cancellation.mjs retire|retire-poll --db <端点DB> --relation <UUID> [--url <登记节点地址> --credential <登记凭据>]",
 "node cli/cancellation.mjs settle --db <端点DB> --relation <UUID> --version <当前任务版本>",
 "node cli/cancellation.mjs get --db <DB> --relation <UUID>",
 "node cli/cancellation.mjs list --db <DB> --project <项目>",
 "poll 只获取并保存已有回执；接收端必须显式 progress 才推进停止证明。旧节点未声明只读查询能力时 poll 拒绝发送状态请求。",
 "取消送达不是停止确认；未知进程或未确认下游保持待处理。以上命令不启动模型。"
].join("\n");
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={request:["db","relation","id","version","reason"],send:["db","relation","url","credential"],poll:["db","relation","url","credential"],progress:["db","relation"],get:["db","relation"],retire:["db","relation","url","credential"],"retire-poll":["db","relation","url","credential"],settle:["db","relation","version"],list:["db","project"]}[command];
  if(!fields)throw Error(usage);const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(!o.db)throw Error("--db 必填，不默认连接当前部署");if(command==="request"&&!["operator_cancelled","deadline_exceeded"].includes(o.reason))throw Error("--reason 必须为 operator_cancelled 或 deadline_exceeded");db=openPeerDatabase(o.db);migrateCancellationClosure(db);let result;
  if(command==="request")result=prepareCancellation(db,{relationId:o.relation,cancelId:o.id,expectedTaskVersion:Number(o.version),reasonCode:o.reason});
  else if(command==="get")result=cancellationClosureState(db,o.relation);
  else if(command==="progress")result=progressCancellation(db,o.relation);
  else if(command==="list")result=listCancellations(db,{projectId:o.project});
  else if(command==="settle")result=settleCancellation(db,{relationId:o.relation,expectedTaskVersion:Number(o.version)});
  else if(["retire","retire-poll"].includes(command))result=await submitCancellationRetirement(db,{relationId:o.relation,mode:command==="retire"?"approve":"poll",url:o.url,credentialFile:o.credential});
  else result=await deliverCancellation(db,{relationId:o.relation,mode:command,url:o.url,credentialFile:o.credential});
  console.log(JSON.stringify(result,null,2));if(["retry_pending","blocked","waiting_peer","rejected"].includes(result.delivery_state)||result.blocker_count>0)process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
