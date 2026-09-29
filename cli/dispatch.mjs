import {fileURLToPath} from "node:url";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {readRecoveryJSON} from "../core/recovery.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateDispatch,putQuota,prepareDispatch,abandonPrepared,dispatchStatus,quotaStatus} from "../core/execution/dispatch.mjs";
const usage=[
 "node cli/dispatch.mjs quota --db <绝对路径> --policy-file <预算JSON> [--version <所见版本>]",
 "node cli/dispatch.mjs quota-status --db <绝对路径> --quota <ID>",
 "node cli/dispatch.mjs prepare --db <绝对路径> --assignment <ID> --quota <ID> --mode fixture|provider --credential-file <新绝对路径> --accepted-rev <治理树验收文件>",
 "node cli/dispatch.mjs status --db <绝对路径> --dispatch <ID>",
 "node cli/dispatch.mjs abandon --db <绝对路径> --dispatch <ID> --reason <尚未启动的放弃原因>",
 "prepare 只领取并保留预算，不发放启动许可或启动模型。已消费许可的运行禁止自动重启/退款。"
].join("\n");
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={quota:["db","policy-file","version"],"quota-status":["db","quota"],prepare:["db","assignment","quota","mode","credential-file","accepted-rev"],status:["db","dispatch"],abandon:["db","dispatch","reason"]}[command];
  if(!fields)throw Error(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(opts,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);opts[k]=args[i+1];}
  if(!opts.db)throw Error("--db 必填");
  const sourceGate=command==="prepare"?createSourceGate({codeRoot:fileURLToPath(new URL("../",import.meta.url)),approvalFile:opts["accepted-rev"]??""}):null;
  db=openPeerDatabase(opts.db);migrateSync(db);migrateDispatch(db);
  let result;
  if(command==="quota")result=putQuota(db,readRecoveryJSON(opts["policy-file"]),opts.version===undefined?undefined:Number(opts.version));
  else if(command==="quota-status")result=quotaStatus(db,opts.quota);
  else if(command==="status")result=dispatchStatus(db,opts.dispatch);
  else if(command==="abandon")result=abandonPrepared(db,{dispatchId:opts.dispatch,reason:opts.reason});
  else result=prepareDispatch(db,{assignmentId:opts.assignment,quotaId:opts.quota,executionMode:opts.mode,credentialFile:opts["credential-file"],sourceGate});
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{db?.close();}
