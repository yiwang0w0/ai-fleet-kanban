// Local administration only. State-changing actions require explicit observed identity/plan.
import {prepareRecovery,activateRecovery,retireNode,recoveryStatus,readRecoveryJSON,writeRecoveryJSON} from "../core/recovery.mjs";
const usage="用法: node cli/recovery.mjs status --db <绝对路径>\n"+
 "      node cli/recovery.mjs prepare --db <恢复数据库> --plan-file <新计划文件> [--retired-epoch <已退役的epoch>]\n"+
 "      node cli/recovery.mjs retire --db <原数据库> --expected-epoch <所见epoch> [--receipt-file <新回执文件>]\n"+
 "      node cli/recovery.mjs activate --db <恢复数据库> --plan-file <已核对计划> --plan-digest <已核对摘要> --attestation-file <真实退役声明> [--receipt-file <新回执文件>]";
try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==="--help")console.log(usage);
 else{
  const allowed={status:["db"],prepare:["db","plan-file","retired-epoch"],retire:["db","expected-epoch","receipt-file"],activate:["db","plan-file","plan-digest","attestation-file","receipt-file"]}[command],opts={};
  if(!allowed)throw Error(usage);
  for(let i=0;i<args.length;i+=2){
   const key=args[i].replace(/^--/,"");if(!args[i].startsWith("--")||!allowed.includes(key)||Object.hasOwn(opts,key)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);
   opts[key]=args[i+1];
  }
  if(!opts.db)throw Error("--db 必填");
  let result;
  if(command==="status")result=recoveryStatus(opts.db);
  else if(command==="prepare"){
   if(!opts["plan-file"])throw Error("--plan-file 必填");
   result=prepareRecovery({dbPath:opts.db,retiredEpoch:opts["retired-epoch"]});writeRecoveryJSON(opts["plan-file"],result);
  }else if(command==="retire")result=retireNode({dbPath:opts.db,expectedEpoch:opts["expected-epoch"]});
  else{
   for(const key of ["plan-file","plan-digest","attestation-file"])if(!opts[key])throw Error("--"+key+" 必填");
   result=activateRecovery({dbPath:opts.db,plan:readRecoveryJSON(opts["plan-file"]),expectedPlanDigest:opts["plan-digest"],attestation:readRecoveryJSON(opts["attestation-file"])});
  }
  console.log(JSON.stringify(result,null,2));
  if(opts["receipt-file"])try{writeRecoveryJSON(opts["receipt-file"],result);}catch(e){throw Error("数据库操作已提交，但回执文件写入失败；请用 status 查询已保存回执。"+e.message);}
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
