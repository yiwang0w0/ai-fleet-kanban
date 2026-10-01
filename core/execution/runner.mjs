import {DEFAULT_PROVIDER_IDLE_MS} from "./activity.mjs";
import {buildLaunchRequest,launchFailureCode} from "./launch-request.mjs";
import {watchDelegationCancellation} from "./control.mjs";
import {createRequire} from "node:module";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {validatePreparedAdapter} from "./adapters.mjs";
import {pinFile,superviseProcess} from "./supervisor.mjs";
import {executionJournal,verifyExecutionJournal} from "./journal.mjs";
import {launchReceipt} from "./receipts.mjs";
import {authorizeLaunch,finishDispatch,dispatchStatus} from "./dispatch.mjs";
import {digest} from "../federation/sync-store.mjs";
import {exact,fail} from "../mcp/policy.mjs";
import {writeRecoveryJSON,readRecoveryJSON} from "../recovery.mjs";
const require=createRequire(import.meta.url),store=require("../store.js");

/** This entry point launches a provider. It never polls queues or restarts a committed dispatch. */
export async function executePreparedDispatch(db,{dispatchId,sourceGate,prepared,python,privateDirectory,
 timeoutMs=60000,idleTimeoutMs=DEFAULT_PROVIDER_IDLE_MS,heartbeatMs=10000,stderrLimit=1048576,signal=null}){
 if(process.platform!=="win32")fail("WINDOWS_REQUIRED","执行器仅支持 Windows；未领取启动许可");
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
 const execution=launchReceipt({format:plan.workspaceBinding?"ai-fleet-process/v2":"ai-fleet-process/v1",...(plan.workspaceBinding?{workspace:plan.workspaceBinding}:{}),adapter_contract:plan.contract,adapter_digest:prepared.manifestDigest,
  runtime:plan.runtime,model:plan.model,effort:plan.effort,run_id:plan.runId,agent_instance_id:plan.agentInstanceId,principal_id:plan.principalId,
  command_sha256:plan.command.sha256,python_sha256:python.sha256,files_digest:digest(plan.pins),prompt_sha256:plan.promptHash,
  environment_sha256:prepared.manifest.environment_sha256,idle_timeout_ms:idleTimeoutMs,timeout_ms:timeoutMs,heartbeat_ms:heartbeatMs,stderr_limit:stderrLimit});
 // Validate the complete serialized payload and all deterministic supervisor
 // settings before spending the single-use budget; prompt length alone is not enough.
 const launchOptions={python,command:plan.command,args:plan.args,cwd:plan.cwd,env:plan.env,input:plan.input,
  pins:plan.pins,runtime:plan.runtime,decoder:plan.decoder,timeoutMs,idleTimeoutMs,heartbeatMs,stderrLimit};
 buildLaunchRequest(launchOptions);
 // No await between final validation and the transactional, single-use permit.
 validatePreparedAdapter(prepared);
 const permit=authorizeLaunch(db,{dispatchId,sourceGate,execution});
 const cancellation=watchDelegationCancellation(db,permit.task_id,{signal});
 let observation;
 try{
  observation=await superviseProcess({...launchOptions,signal:cancellation.signal,
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
 }catch(error){
  // Uncertainty never grants a retry/refund. Do not echo provider/host exceptions.
  observation={status:"failed",evidence:"Executor supervisor did not return a complete observation.",usage:null,diagnostic:launchFailureCode(error),
   observed:null,real_model_call_confirmed:false,process:{started:null,cleanup:"unconfirmed",containment:null}};
 }
 cancellation.close();
 const receipt=executionJournal(db,{dispatchId,observation});
 // A secondary journal failure must not prevent the authoritative DB settlement
 // and credential revocation. Only a successfully persisted file is advertised.
 let journalWritten=false;
 try{writeRecoveryJSON(journalFile,receipt);journalWritten=true;}catch{}
 const settled=finishDispatch(db,{dispatchId,result:{status:observation.status,evidence:observation.evidence,usage:observation.usage},observation});
 return {...settled,journal_file:journalWritten?journalFile:null,journal_error:journalWritten?null:"JOURNAL_WRITE_FAILED"};
}

/** Local recovery only. Safe to repeat; it never invokes an executor. */
export function reconcileExecutionJournal(db,journalFile){
 const journal=readRecoveryJSON(journalFile);
 dispatchStatus(db,journal.dispatch_id); // Enforce current local identity and epoch.
 const observation=verifyExecutionJournal(db,journal);
 return finishDispatch(db,{dispatchId:journal.dispatch_id,result:{status:observation?.status,evidence:observation?.evidence,usage:observation?.usage},observation});
}