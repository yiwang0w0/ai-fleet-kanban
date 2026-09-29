import {readFileSync} from "node:fs";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateDelegation,createIntent,decideIncoming,incomingStatus,outgoingStatus,listDelegations} from "../core/federation/delegation.mjs";
import {deliverIntent} from "../core/federation/delegation-client.mjs";
const usage="node cli/delegation.mjs propose --db <绝对路径> --id <UUID> --task <task_uid> --version <任务版本> --target <node_id> --target-epoch <epoch>\n"+
 "node cli/delegation.mjs send|poll --db <绝对路径> --id <UUID> --url <显式回环或Tailscale根地址> --credential-file <文件>\n"+
 "node cli/delegation.mjs get --db <绝对路径> --id <UUID> --direction incoming|outgoing\n"+
 "node cli/delegation.mjs list --db <绝对路径> --project <项目> --direction incoming|outgoing [--limit <1-1000>]\n"+
 "node cli/delegation.mjs decide --db <绝对路径> --id <UUID> --decision-id <UUID> --version <接收版本> --decision accept|reject [--note-file <UTF8文件>]\n"+
 "接受只创建未确认、未放行的接收任务；本命令不启动执行器。";
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={propose:["db","id","task","version","target","target-epoch"],send:["db","id","url","credential-file"],poll:["db","id","url","credential-file"],get:["db","id","direction"],list:["db","project","direction","limit"],decide:["db","id","decision-id","version","decision","note-file"]}[command];
  if(!fields)throw Error(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(key)||Object.hasOwn(opts,key)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);opts[key]=args[i+1];}
  if(!opts.db)throw Error("--db 必填；不会使用当前部署");db=openPeerDatabase(opts.db);migrateDelegation(db);let result;
  if(command==="propose")result=createIntent(db,{delegationId:opts.id,taskUid:opts.task,expectedVersion:Number(opts.version),targetNodeId:opts.target,targetEpoch:opts["target-epoch"]});
  else if(command==="send"||command==="poll")result=await deliverIntent(db,{delegationId:opts.id,url:opts.url,credentialFile:opts["credential-file"],mode:command==="send"?"offer":"status"});
  else if(command==="decide")result=decideIncoming(db,{delegationId:opts.id,decisionId:opts["decision-id"],expectedVersion:Number(opts.version),decision:opts.decision,note:opts["note-file"]?readFileSync(opts["note-file"],"utf8"):""});
  else if(command==="get"){
   if(!["incoming","outgoing"].includes(opts.direction))throw Error("direction 无效");result=opts.direction==="incoming"?incomingStatus(db,opts.id):outgoingStatus(db,opts.id);
  }else result=listDelegations(db,{direction:opts.direction,projectId:opts.project,limit:opts.limit===undefined?100:Number(opts.limit)});
  console.log(JSON.stringify(result,null,2));if(result.delivery_state==="retry_pending"||result.delivery_state==="blocked")process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{db?.close();}
