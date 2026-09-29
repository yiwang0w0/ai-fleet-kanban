import {createRequire} from "node:module";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {validatePreparedAdapter} from "./adapters.mjs";
import {pinFile,superviseProcess} from "./supervisor.mjs";
import {launchReceipt} from "./receipts.mjs";
import {authorizeLaunch,finishDispatch,dispatchStatus} from "./dispatch.mjs";
import {digest} from "../federation/sync-store.mjs";
import {exact,fail} from "../mcp/policy.mjs";
import {writeRecoveryJSON,readRecoveryJSON} from "../recovery.mjs";
const require=createRequire(import.meta.url),store=require("../store.js");

/** This entry point launches a provider. It never polls queues or restarts a committed dispatch. */
export async function executePreparedDispatch(db,{dispatchId,sourceGate,prepared,python,privateDirectory,
 timeoutMs=60000,heartbeatMs=10000,stderrLimit=1048576,signal=null}){
 validatePreparedAdapter(prepared);
 const plan=prepared.plan,d=dispatchStatus(db,dispatchId);
 if(d.execution_mode!=="provider")fail("EXECUTION_MODE_MISMATCH","供应商适配器仅允许 provider 调用预算");
 if(d.phase!=="prepared")fail("LAUNCH_NOT_AVAILABLE","启动许可已消费或运行已结束");
 if(plan.codeRoot!==sourceGate.codeRoot||plan.codeRoot!==d.source.code_root)fail("SOURCE_CHANGED","启动适配器与治理代码根不一致");
 if(signal!==null&&(!(signal instanceof AbortSignal)))fail("BAD_INPUT","需要有效的取消信号",400);
 if(signal?.aborted)fail("EXECUTION_CANCELLED","调用尚未启动，取消不消耗额度");
 exact(python,["path","sha256"],"python_pin");
 const actualPython=pinFile(python.path);
 if(actualPython.sha256!==python.sha256)fail("RUNTIME_CHANGED","监管 Python 已变化");
 // The journal belongs to the same private run directory as the credential.
 const credential=plan.pins.find(p=>p.path===plan.credentialFile);
 if(!credential||privateDirectory!==plan.privateDirectory)fail("UNSAFE_CREDENTIAL_PATH","执行回执必须写入本次已绑定的私有运行目录");
 const journalFile=join(privateDirectory,"execution-observation.json");
 if(existsSync(journalFile))fail("JOURNAL_EXISTS","该私有目录已有执行回执，不能用于新调用");
 const execution=launchReceipt({format:"ai-fleet-process/v1",adapter_contract:plan.contract,adapter_digest:prepared.manifestDigest,
  runtime:plan.runtime,model:plan.model,effort:plan.effort,run_id:plan.runId,agent_instance_id:plan.agentInstanceId,principal_id:plan.principalId,
  command_sha256:plan.command.sha256,python_sha256:python.sha256,files_digest:digest(plan.pins),prompt_sha256:plan.promptHash,
  environment_sha256:prepared.manifest.environment_sha256,timeout_ms:timeoutMs,heartbeat_ms:heartbeatMs,stderr_limit:stderrLimit});
 // No await between final validation and the transactional, single-use permit.
 validatePreparedAdapter(prepared);
 const permit=authorizeLaunch(db,{dispatchId,sourceGate,execution});
 let observation;
 try{
  observation=await superviseProcess({python,command:plan.command,args:plan.args,cwd:plan.cwd,env:plan.env,input:plan.input,
   pins:plan.pins,runtime:plan.runtime,decoder:plan.decoder,timeoutMs,heartbeatMs,stderrLimit,signal,
   heartbeat:()=>{
    const current=dispatchStatus(db,dispatchId),t=store.get(db,permit.task_id);
    const p=db.prepare("SELECT status,role_version FROM broker_principals WHERE principal_id=?").get(permit.principal_id);
    const role=db.prepare("SELECT version FROM broker_roles WHERE role_id=?").get(permit.role_id);
    if(!p||p.status!=="active"||p.role_version!==role?.version||!t||t.run_id!==permit.run_id||t.archived_at)return false;
    if(t.status==="waiting"){
     return !!db.prepare("SELECT 1 FROM broker_requests WHERE principal_id=? AND tool_name='report_result' LIMIT 1").get(permit.principal_id);
    }
    if(current.phase!=="launch_committed")return false;
    store.heartbeat(db,{id:permit.task_id,worker:permit.worker,runId:permit.run_id,leaseMin:5});return true;
   }});
 }catch{
  // Uncertainty never grants a retry/refund. Do not echo provider/host exceptions.
  observation={status:"failed",evidence:"Executor supervisor did not return a complete observation.",usage:null,diagnostic:"SUPERVISOR_ERROR",
   observed:null,real_model_call_confirmed:false,process:{started:null,cleanup:"unconfirmed",containment:null}};
 }
 const receipt={format:"ai-fleet-execution-journal/v1",dispatch_id:dispatchId,launch_digest:permit.execution.launch_digest,observation};
 // If disk/DB persistence fails, leave the spent permit spent; reconciliation only
 // submits this terminal receipt and cannot spawn another process.
 writeRecoveryJSON(journalFile,receipt);
 const settled=finishDispatch(db,{dispatchId,result:{status:observation.status,evidence:observation.evidence,usage:observation.usage},observation});
 return {...settled,journal_file:journalFile};
}

/** Local recovery only. Safe to repeat; it never invokes an executor. */
export function reconcileExecutionJournal(db,journalFile){
 const journal=readRecoveryJSON(journalFile);
 exact(journal,["format","dispatch_id","launch_digest","observation"],"execution_journal");
 const d=dispatchStatus(db,journal.dispatch_id);
 if(journal.format!=="ai-fleet-execution-journal/v1"||!d.execution||journal.launch_digest!==d.execution.launch_digest)fail("EXECUTION_MISMATCH","回执不属于该已消费的启动配置");
 const observation=journal.observation;
 return finishDispatch(db,{dispatchId:journal.dispatch_id,result:{status:observation?.status,evidence:observation?.evidence,usage:observation?.usage},observation});
}