import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {readRecoveryJSON} from "../core/recovery.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateIntegration,registerIntegrationPolicy,revokeIntegrationPolicy,prepareIntegration,executeIntegration,reconcileIntegration,captureAppliedIntegration,integrationState,abandonIntegration} from "../core/integration/service.mjs";
const usage=[
 "node cli/integration.mjs policy --db <来源DB> --config <本机配置JSON> --accepted-rev <治理树验收文件>",
 "node cli/integration.mjs revoke --db <来源DB> --policy <UUID>",
 "node cli/integration.mjs prepare --db <来源DB> --policy <UUID> --verification <UUID> --id <合并UUID> --accepted-rev <治理树验收文件>",
 "node cli/integration.mjs apply --db <来源DB> --id <合并UUID> --accepted-rev <治理树验收文件>",
 "node cli/integration.mjs reconcile --db <来源DB> --id <合并UUID> --accepted-rev <治理树验收文件>",
 "node cli/integration.mjs check --db <来源DB> --id <合并UUID> --accepted-rev <治理树验收文件>",
 "node cli/integration.mjs get --db <来源DB> --id <合并UUID>",
 "node cli/integration.mjs abandon --db <来源DB> --id <合并UUID> --reason <未启动放弃原因>",
 "合并仅更新明确批准、未被工作区占用的来源引用；原基线不符即停止。reconcile 只核对已绑定提交，不重复更新。任务验收与关系退役另行处理。"
].join("\n");
let db;try{
 const [command,...args]=process.argv.slice(2);if(!command||command==="--help")console.log(usage);
 else{
  const fields={policy:["db","config","accepted-rev"],revoke:["db","policy"],prepare:["db","policy","verification","id","accepted-rev"],apply:["db","id","accepted-rev"],reconcile:["db","id","accepted-rev"],check:["db","id","accepted-rev"],get:["db","id"],abandon:["db","id","reason"]}[command],o={};
  if(!fields)throw Error(usage);for(let j=0;j<args.length;j+=2){const k=args[j].slice(2);if(!args[j].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||!args[j+1]||args[j+1].startsWith("--"))throw Error(usage);o[k]=args[j+1];}if(fields.some(k=>!o[k]))throw Error(usage);
  const sourceGate=o["accepted-rev"]?createSourceGate({codeRoot:resolve(dirname(fileURLToPath(import.meta.url)),".."),approvalFile:o["accepted-rev"]}):null;sourceGate?.check();db=openPeerDatabase(o.db);migrateIntegration(db);let r;
  if(command==="policy"){const config=readRecoveryJSON(o.config),allowed=["policyId","mappingId","ref","poolRoot","allowVerifiedContentMerge","exclusiveRefManagement"];if(!config||typeof config!=="object"||Array.isArray(config)||Object.keys(config).length!==allowed.length||Object.keys(config).some(k=>!allowed.includes(k)))throw Error("本机合并配置字段不完整或含未知字段");r=registerIntegrationPolicy(db,{...config,sourceGate});}
  else if(command==="revoke")r=revokeIntegrationPolicy(db,{policyId:o.policy});
  else if(command==="prepare")r=prepareIntegration(db,{integrationId:o.id,policyId:o.policy,verificationId:o.verification,sourceGate});
  else if(command==="apply")r=executeIntegration(db,{integrationId:o.id,sourceGate});
  else if(command==="reconcile")r=reconcileIntegration(db,{integrationId:o.id,sourceGate});
  else if(command==="check")r=captureAppliedIntegration(db,{integrationId:o.id,sourceGate});
  else if(command==="abandon")r=abandonIntegration(db,{integrationId:o.id,reason:o.reason});
  else r=integrationState(db,o.id);
  console.log(JSON.stringify(r,null,2));if(r.phase==="settled"&&!r.receipt.current_at_observation)process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
