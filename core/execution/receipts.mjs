import {isOutputActivity} from "./activity.mjs";
import {isStderrDiagnostic} from "./provider-error.mjs";
import {isLaunchFailureCode} from "./launch-request.mjs";
import {isProviderErrorMetadata} from "./provider-error.mjs";
import {exact,fail} from "../mcp/policy.mjs";
import {canonical} from "../federation/sync-store.mjs";
import {uuid} from "../federation/protocol.mjs";
const hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const text=x=>typeof x==="string"&&x.length>0&&x.length<=200&&!/[\u0000-\u001f\u007f]/.test(x);
const count=x=>Number.isSafeInteger(x)&&x>=0;
const bad=()=>fail("BAD_EXECUTION_RECEIPT","执行审计回执无效",400);
export function launchReceipt(value){
 const workspace=value?.format==="ai-fleet-process/v2",idle=value!==null&&typeof value==="object"&&Object.hasOwn(value,"idle_timeout_ms");
 exact(value,[...(idle?["idle_timeout_ms"]:[]),...(workspace?["workspace"]:[]),"format","adapter_contract","adapter_digest","runtime","model","effort","run_id","agent_instance_id","principal_id","command_sha256","python_sha256","files_digest","prompt_sha256","environment_sha256","timeout_ms","heartbeat_ms","stderr_limit"],"execution_launch");
 if(!["ai-fleet-process/v1","ai-fleet-process/v2"].includes(value.format)||!text(value.adapter_contract)||!["claude","codex","zcode"].includes(value.runtime)||!text(value.model)||!text(value.effort))bad();
 for(const k of ["adapter_digest","command_sha256","python_sha256","files_digest","prompt_sha256","environment_sha256"])if(!hash(value[k]))bad();
 for(const k of ["run_id","agent_instance_id","principal_id"])uuid(value[k],k);
 for(const [k,min,max] of [["timeout_ms",50,86400000],["heartbeat_ms",50,60000],["stderr_limit",1,1048576]])if(!Number.isSafeInteger(value[k])||value[k]<min||value[k]>max)bad();
 if(idle&&(!Number.isSafeInteger(value.idle_timeout_ms)||value.idle_timeout_ms<50||value.idle_timeout_ms>86400000))bad();
 if(workspace){
  exact(value.workspace,["workspace_id","descriptor_digest","base_commit","baseline_digest","access"],"workspace_launch");uuid(value.workspace.workspace_id,"workspace_id");
  if(!hash(value.workspace.descriptor_digest)||!hash(value.workspace.baseline_digest)||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.workspace.base_commit)||value.workspace.access!=="mcp-files-v1"||value.adapter_contract!=="ai-fleet-adapter/workspace-files-v1")bad();
 }else if(value.adapter_contract==="ai-fleet-adapter/workspace-files-v1")bad();
 return structuredClone(value);
}
/** Only structured supervisor metadata; never raw stdout, stderr, prompts or secrets. */
export function processObservation(value,{result,launch}){
 exact(value,["status","evidence","usage","diagnostic","observed","real_model_call_confirmed","process"],"execution_observation");
 if(value.status!==result.status||value.evidence!==result.evidence||canonical(value.usage)!==canonical(result.usage)||value.real_model_call_confirmed!==false||typeof value.diagnostic!=="string"||!/^[A-Z][A-Z0-9_]{0,79}$/.test(value.diagnostic))bad();
 const o=value.observed,p=value.process;
 if(o===null){
  if(value.status==="success"||value.diagnostic!=="SUPERVISOR_ERROR"&&!isLaunchFailureCode(value.diagnostic))bad();
 }else{
  const providerError=o!==null&&typeof o==="object"&&Object.hasOwn(o,"provider_error");
  exact(o,["runtime","session_id","turn_id","model","terminal_status","protocol_error","bytes","events","stdout_sha256",...(providerError?["provider_error"]:[])],"execution_observed");
  if(providerError&&(o.runtime!=="codex"||value.status==="success"||!isProviderErrorMetadata(o.provider_error)))bad();
  if(o.runtime!==launch.runtime||!count(o.bytes)||o.bytes>33554432||!count(o.events)||o.events>100001||!hash(o.stdout_sha256))bad();
  for(const k of ["session_id","turn_id","model","protocol_error"])if(o[k]!==null&&!text(o[k]))bad();
  if(value.status==="success"&&o.model!==null&&o.model!==launch.model)bad();
  if(o.terminal_status!==null&&!["success","failed","cancelled"].includes(o.terminal_status))bad();
 }
 if(p?.started===null){
  exact(p,["started","cleanup","containment"],"execution_process");
  if(o!==null||p.cleanup!=="unconfirmed"||p.containment!==null)bad();
 }else if(p?.started===false&&p.cleanup==="not_started"){
  exact(p,["started","cleanup","containment"],"execution_process");
  if(p.containment!==null||value.status==="success")bad();
 }else{
  const activity=Object.hasOwn(p??{},"activity"),stderrDiagnostic=Object.hasOwn(p??{},"stderr_diagnostic");
  exact(p,[...(activity?["activity"]:[]),...(stderrDiagnostic?["stderr_diagnostic"]:[]),"started","pid","containment","cleanup","host_sha256","executable_sha256","python_sha256","exit_code","host_error","host_exit_code","stderr_bytes","stderr_hashed_bytes","stderr_sha256"],"execution_process");
  if(typeof p.started!=="boolean"||p.pid!==null&&(!count(p.pid)||p.pid<1)||p.started&&!p.pid)bad();
  if(![null,"windows-job","posix-process-group"].includes(p.containment)||!["unconfirmed","job_empty","group_signalled"].includes(p.cleanup))bad();
  if(p.started&&p.containment===null||p.cleanup==="job_empty"&&p.containment!=="windows-job"||p.cleanup==="group_signalled"&&p.containment!=="posix-process-group")bad();
  for(const k of ["host_sha256","executable_sha256","python_sha256","stderr_sha256"])if(!hash(p[k]))bad();
  if(p.executable_sha256!==launch.command_sha256||p.python_sha256!==launch.python_sha256)bad();
  for(const k of ["exit_code","host_exit_code"])if(p[k]!==null&&(!Number.isSafeInteger(p[k])||p[k]< -128))bad();
  if(p.host_error!==null&&!text(p.host_error)||!count(p.stderr_bytes)||!count(p.stderr_hashed_bytes)||p.stderr_hashed_bytes>p.stderr_bytes||p.stderr_hashed_bytes>launch.stderr_limit)bad();
  if(activity){
   const a=p.activity;
   if(!isOutputActivity(a)||a.idle_timeout_ms!==(launch.idle_timeout_ms??null)||a.stderr_bytes!==p.stderr_bytes||o===null||a.stdout_bytes<o.bytes||a.events>o.events||p.started===(a.started_at===null))bad();
   if(a.idle_timeout_observed_ms!==null&&value.diagnostic!=="IDLE_TIMEOUT")bad();
  }else if(p.started&&Object.hasOwn(launch,"idle_timeout_ms"))bad();
  if(value.diagnostic==="IDLE_TIMEOUT"&&(value.status!=="timeout"||!activity||p.activity.idle_timeout_observed_ms===null))bad();
  if(stderrDiagnostic){
   const d=p.stderr_diagnostic;
   if(value.status==="success"||!p.stderr_bytes||!isStderrDiagnostic(d)||d.scan_limit_bytes!==Math.min(launch.stderr_limit,65536)||d.scanned_bytes!==Math.min(p.stderr_bytes,d.scan_limit_bytes)||(p.stderr_bytes>d.scan_limit_bytes||d.discarded_lines>0)!==d.truncated)bad();
  }
 }
 if(value.status==="success"&&(value.diagnostic!=="SUCCESS"||o?.terminal_status!=="success"||o.protocol_error!==null||p.started!==true||!["job_empty","group_signalled"].includes(p.cleanup)||p.exit_code!==0||p.host_exit_code!==0||p.host_error!==null))bad();
 return structuredClone(value);
}