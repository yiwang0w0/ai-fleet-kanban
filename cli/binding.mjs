import {readFileSync,statSync} from "node:fs";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateBindings,prepareBinding,bindingState,listBindings,releaseBoundTask,bindingProposalState,declineBindingProposal} from "../core/federation/bindings.mjs";
import {submitBinding,sendBindingMessage} from "../core/federation/binding-client.mjs";
const usage="node cli/binding.mjs prepare --db <DB绝对路径> --relation-file <关系JSON> --version <当前任务版本>\n"+
 "node cli/binding.mjs approve|poll|withdraw|cancel --db <DB> --relation <UUID> [--url <固定登记节点地址> --credential <凭据文件>]\n"+
 "node cli/binding.mjs send --db <DB> --relation <UUID> --kind proposal|source_ready --url <固定接收端地址> --credential <凭据文件>\n"+
 "node cli/binding.mjs release --db <DB> --relation <UUID> --version <当前任务版本>\n"+
 "node cli/binding.mjs decline --db <DB> --relation <UUID> --digest <提案摘要> --reason stale_topology|contract_changed|duplicate|operator_declined\n"+
 "node cli/binding.mjs get-proposal --db <DB> --relation <UUID>\n"+
 "node cli/binding.mjs get --db <DB> --relation <UUID>\nnode cli/binding.mjs list --db <DB> --project <项目>\n"+
 "关系确认与双方端点就绪只建立放行条件；release 显式放行，以上命令都不启动模型。";
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={prepare:["db","relation-file","version"],approve:["db","relation","url","credential"],poll:["db","relation","url","credential"],withdraw:["db","relation","url","credential"],cancel:["db","relation","url","credential"],send:["db","relation","kind","url","credential"],release:["db","relation","version"],"get-proposal":["db","relation"],decline:["db","relation","digest","reason"],get:["db","relation"],list:["db","project"]}[command];
  if(!fields)throw Error(usage);const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(!o.db)throw Error("--db 必填，不默认连接运行部署");db=openPeerDatabase(o.db);migrateBindings(db);let result;
  if(command==="prepare"){if(!o["relation-file"]||statSync(o["relation-file"]).size>8192)throw Error("关系文件必填且不得超过8KiB");let relation;try{relation=JSON.parse(readFileSync(o["relation-file"],"utf8"));}catch{throw Error("关系文件不是有效JSON");}result=prepareBinding(db,{relation,expectedTaskVersion:Number(o.version)});}
  else if(command==="get-proposal")result=bindingProposalState(db,o.relation);
  else if(command==="decline")result=declineBindingProposal(db,{relationId:o.relation,expectedDescriptorDigest:o.digest,reasonCode:o.reason});
  else if(command==="get")result=bindingState(db,o.relation);
  else if(command==="list")result=listBindings(db,{projectId:o.project});
  else if(command==="release")result=releaseBoundTask(db,{relationId:o.relation,expectedTaskVersion:Number(o.version)});
  else if(command==="send")result=await sendBindingMessage(db,{relationId:o.relation,kind:o.kind,url:o.url,credentialFile:o.credential});
  else result=await submitBinding(db,{relationId:o.relation,mode:command,url:o.url,credentialFile:o.credential});
  console.log(JSON.stringify(result,null,2));if(["retry_pending","blocked","rejected"].includes(result.delivery_state))process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
