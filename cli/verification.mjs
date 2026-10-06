import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {readRecoveryJSON} from "../core/recovery.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateVerification,registerVerificationProfile,revokeVerificationProfile,prepareVerification,executeVerification,reconcileVerification,verificationState,captureVerificationReceipt} from "../core/verification/service.mjs";
const usage=[
 "node cli/verification.mjs profile --db <来源DB> --config <本机配置JSON> --accepted-rev <治理树验收文件>",
 "node cli/verification.mjs revoke --db <来源DB> --profile <UUID>",
 "node cli/verification.mjs prepare --db <来源DB> --profile <UUID> --transfer <UUID> --id <验证UUID> --accepted-rev <治理树验收文件>",
 "node cli/verification.mjs run --db <来源DB> --id <验证UUID> --accepted-rev <治理树验收文件>",
 "node cli/verification.mjs reconcile --db <来源DB> --id <验证UUID> --accepted-rev <治理树验收文件>",
 "node cli/verification.mjs check --db <来源DB> --id <验证UUID> --accepted-rev <治理树验收文件>",
 "node cli/verification.mjs get --db <来源DB> --id <验证UUID>",
 "来源节点独立配置固定命令，核验实际接收产物。run 只启动一次；reconcile 只恢复已有观察。检查通过不代表来源合并或任务验收。"
].join("\n");
let db;const controller=new AbortController(),cancel=()=>controller.abort();
try{
 const [command,...args]=process.argv.slice(2);if(!command||command==="--help")console.log(usage);
 else{
  const fields={profile:["db","config","accepted-rev"],revoke:["db","profile"],prepare:["db","profile","transfer","id","accepted-rev"],run:["db","id","accepted-rev"],reconcile:["db","id","accepted-rev"],get:["db","id"],check:["db","id","accepted-rev"]}[command],o={};
  if(!fields)throw Error(usage);for(let j=0;j<args.length;j+=2){const k=args[j].slice(2);if(!args[j].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||!args[j+1]||args[j+1].startsWith("--"))throw Error(usage);o[k]=args[j+1];}if(fields.some(k=>!o[k]))throw Error(usage);
  const sourceGate=o["accepted-rev"]?createSourceGate({codeRoot:resolve(dirname(fileURLToPath(import.meta.url)),".."),approvalFile:o["accepted-rev"]}):null;
  sourceGate?.check();db=openPeerDatabase(o.db);migrateVerification(db);let r;
  if(command==="profile"){
   const config=readRecoveryJSON(o.config),allowed=["profileId","mappingId","poolRoot","allowFullHistoryCopy","definition"];
   if(!config||typeof config!=="object"||Array.isArray(config)||Object.keys(config).length!==allowed.length||Object.keys(config).some(k=>!allowed.includes(k)))throw Error("本机配置仅接受 profileId、mappingId、poolRoot、allowFullHistoryCopy、definition");
   r=registerVerificationProfile(db,{...config,sourceGate});
  }else if(command==="revoke")r=revokeVerificationProfile(db,{profileId:o.profile});
  else if(command==="prepare")r=prepareVerification(db,{verificationId:o.id,profileId:o.profile,transferId:o.transfer,sourceGate});
  else if(command==="check")r=captureVerificationReceipt(db,{verificationId:o.id,sourceGate});
  else if(command==="get")r=verificationState(db,o.id);
  else if(command==="reconcile")r=reconcileVerification(db,{verificationId:o.id,sourceGate});
  else{process.once("SIGINT",cancel);process.once("SIGTERM",cancel);r=await executeVerification(db,{verificationId:o.id,sourceGate,signal:controller.signal});}
  console.log(JSON.stringify(r,null,2));if(r.phase==="settled"&&!r.receipt.checks_passed)process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{process.removeListener("SIGINT",cancel);process.removeListener("SIGTERM",cancel);db?.close();}
