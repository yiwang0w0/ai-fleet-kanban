import {dispatchStale,inspectionError} from '../core/inspection.mjs';
import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {workspaceLaunchDescriptor} from "../core/artifacts/workspace-session.mjs";
import {readFileSync,statSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {readRecoveryJSON,writeRecoveryJSON} from "../core/recovery.mjs";
import {prepareAdapter} from "../core/execution/adapters.mjs";
import {executePreparedDispatch,reconcileExecutionJournal} from "../core/execution/runner.mjs";
import {pinFile} from "../core/execution/supervisor.mjs";
import {exact,getRole} from "../core/mcp/policy.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {prepareUncertainResolution,recordUncertainResolution,migrateDispatch,putQuota,prepareDispatch,abandonPrepared,dispatchStatus,quotaStatus} from "../core/execution/dispatch.mjs";
const usage=[
 "node cli/dispatch.mjs stale --db <现存绝对路径> [--project <项目>] [--limit <1..100>] [--cursor <上一页游标>]",
 "node cli/dispatch.mjs quota --db <绝对路径> --policy-file <预算JSON> [--version <所见版本>]",
 "node cli/dispatch.mjs quota-status --db <绝对路径> --quota <ID>",
 "node cli/dispatch.mjs prepare --db <绝对路径> --assignment <ID> --quota <ID> --mode fixture|provider --credential-file <新绝对路径> --accepted-rev <治理树验收文件>",
 "node cli/dispatch.mjs status --db <绝对路径> --dispatch <ID>",
 "node cli/dispatch.mjs abandon --db <绝对路径> --dispatch <ID> --reason <尚未启动的放弃原因>",
 "node cli/dispatch.mjs execute --db <绝对路径> --dispatch <ID> --config-file <本机执行配置JSON> --prompt-file <提示文件> --accepted-rev <治理树验收文件>",
 "node cli/dispatch.mjs reconcile --db <绝对路径> --journal-file <执行回执JSON>",
 "node cli/dispatch.mjs prepare-uncertain --db <绝对路径> --dispatch <ID> --plan-file <新计划JSON>",
 "node cli/dispatch.mjs record-uncertain --db <绝对路径> --plan-file <已核对计划> --plan-digest <明确摘要> --attestation-file <真实停止声明>",
 "execute 消耗一次 provider 额度并启动一个任务；reconcile 只补交终态，不启动模型。",
 "prepare 只领取并保留预算，不发放启动许可或启动模型。已消费许可的运行禁止自动重启/退款。"
].join("\n");
const [command,...args]=process.argv.slice(2);let db;
const invalid=message=>Object.assign(new Error(message),command==="stale"?{code:"BAD_INPUT"}:{});
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={stale:["db","project","limit","cursor"],quota:["db","policy-file","version"],"quota-status":["db","quota"],prepare:["db","assignment","quota","mode","credential-file","accepted-rev"],status:["db","dispatch"],abandon:["db","dispatch","reason"],execute:["db","dispatch","config-file","prompt-file","accepted-rev"],reconcile:["db","journal-file"],"prepare-uncertain":["db","dispatch","plan-file"],"record-uncertain":["db","plan-file","plan-digest","attestation-file"]}[command];
  if(!fields)throw invalid(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(opts,k)||args[i+1]===undefined||args[i+1].startsWith("--"))throw invalid(usage);opts[k]=args[i+1];}
  if(!opts.db)throw invalid("--db 必填");
  const codeRoot=fileURLToPath(new URL("../",import.meta.url));
  const sourceGate=["prepare","execute"].includes(command)?createSourceGate({codeRoot,approvalFile:opts["accepted-rev"]??""}):null;
  if(["prepare-uncertain","stale"].includes(command))db=openSchedulerControlDatabase(opts.db,{readOnly:true});
  else {db=openPeerDatabase(opts.db);migrateSync(db);migrateDispatch(db);}
  let result;
  if(command==="stale"){result=dispatchStale(db,{projectId:opts.project??null,limit:opts.limit===undefined?100:Number(opts.limit),cursor:opts.cursor??null});process.exitCode=result.total?2:0;}
  else if(command==="quota")result=putQuota(db,readRecoveryJSON(opts["policy-file"]),opts.version===undefined?undefined:Number(opts.version));
  else if(command==="quota-status")result=quotaStatus(db,opts.quota);
  else if(command==="status")result=dispatchStatus(db,opts.dispatch);
  else if(command==="abandon")result=abandonPrepared(db,{dispatchId:opts.dispatch,reason:opts.reason});
  else if(command==="reconcile")result=reconcileExecutionJournal(db,opts["journal-file"]);
  else if(command==="prepare-uncertain"){result=prepareUncertainResolution(db,opts.dispatch);writeRecoveryJSON(opts["plan-file"],result);}
  else if(command==="record-uncertain")result=recordUncertainResolution(db,{plan:readRecoveryJSON(opts["plan-file"]),expectedPlanDigest:opts["plan-digest"],attestation:readRecoveryJSON(opts["attestation-file"])});
  else if(command==="execute"){
   const config=readRecoveryJSON(opts["config-file"]);
   exact(config,["installation","python","node","workspace","private_directory","mcp_url","credential_file","timeout_ms"],"executor_config");
   if(!opts["prompt-file"]||statSync(opts["prompt-file"]).size>131072)throw Error("需要 128 KiB 内的提示文件");
   const dispatch=dispatchStatus(db,opts.dispatch),role=getRole(db,dispatch.role_id);
   if(!role)throw Error("执行角色不存在");
   const prepared=prepareAdapter({workspaceBinding:role.policy.capabilities.includes("workspace-files")?workspaceLaunchDescriptor(db,opts.dispatch):null,installation:config.installation,role:role.policy,dispatch,codeRoot,workspace:config.workspace,privateDirectory:config.private_directory,
    mcp:{node:config.node,bridge:pinFile(join(codeRoot,"cli/mcp.mjs")),url:config.mcp_url,credentialFile:config.credential_file},prompt:readFileSync(opts["prompt-file"],"utf8")});
   const cancel=new AbortController(),stop=()=>cancel.abort();process.once("SIGINT",stop);process.once("SIGTERM",stop);
   try{result=await executePreparedDispatch(db,{dispatchId:opts.dispatch,sourceGate,prepared,python:config.python,privateDirectory:prepared.plan.privateDirectory,timeoutMs:config.timeout_ms,signal:cancel.signal});}
   finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
  }
  else result=prepareDispatch(db,{assignmentId:opts.assignment,quotaId:opts.quota,executionMode:opts.mode,credentialFile:opts["credential-file"],sourceGate});
  console.log(JSON.stringify(result,null,2));
 }
}catch(e){console.error(command==="stale"?JSON.stringify(inspectionError(e)):(e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{db?.close();}
