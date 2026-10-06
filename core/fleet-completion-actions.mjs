// Operator-only closure of an already verified delivery; no new execution path.
import {PeerError,uuid,version} from "./federation/protocol.mjs";
import {exact} from "./mcp/policy.mjs";
import {digest} from "./federation/sync-store.mjs";
import {localIdentity} from "./federation/peers.mjs";
import {resultState} from "./federation/results.mjs";
import {bindingState} from "./federation/bindings.mjs";
import {verificationState} from "./verification/service.mjs";
import {migrateIntegration,prepareIntegration,executeIntegration,reconcileIntegration,captureAppliedIntegration,integrationState} from "./integration/service.mjs";
import {migrateCompletion,prepareCompletion,completionState,settleCompletion} from "./federation/completion.mjs";
import {deliverCompletion,submitCompletion} from "./federation/completion-client.mjs";
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
const fields={prepare_integration:["verification_id","policy_id"],apply_integration:["id"],reconcile_integration:["id"],check_integration:["id"],prepare_completion:["integration_id","expected_version","note","allow_fixture"],send_completion:["id"],register_completion:["id"],poll_completion:["id"],settle_completion:["id"]};
export const COMPLETION_COMMANDS=new Set(Object.keys(fields));
export function openFleetCompletion(db,{policyIds,mapping,profile}){
 if(policyIds===undefined)return null;
 if(!Array.isArray(policyIds)||policyIds.length>64)fail("BAD_INPUT","合并策略清单无效",400);
 const policies=new Set();for(const id of policyIds){uuid(id,"policy_id");if(policies.has(id))fail("BAD_INPUT","合并策略重复",400);policies.add(id);}
 migrateIntegration(db);migrateCompletion(db);
 function policy(id,project){
  if(!policies.has(id))fail("FORBIDDEN","未批准从面板使用此合并策略",403);
  const p=db.prepare("SELECT * FROM integration_policies WHERE policy_id=?").get(id),n=localIdentity(db);
  if(!p||p.node_id!==n.node_id||p.node_epoch!==n.sync_epoch||db.prepare("SELECT 1 FROM integration_revocations WHERE policy_id=?").get(id))fail("INTEGRATION_REVOKED","合并策略不可用");
  const d=JSON.parse(p.descriptor_json);if(digest(d)!==p.descriptor_digest)fail("INTEGRATION_CORRUPT","合并策略摘要改变");mapping(p.mapping_id,project);return {...p,descriptor:d};
 }
 function scopedResult(id,project){const r=resultState(db,id);if(r.body.relation.project_id!==project)fail("NOT_FOUND","当前项目没有此候选",404);return r;}
 function scope(command,args,project){
  exact(args,fields[command],"completion_arguments");
  for(const [key,value] of Object.entries(args))if(key==="id"||key.endsWith("_id"))uuid(value,key);
  let i=null,v=null,p=null,c=null,r,context,remote=false,nodeId,nodeEpoch;
  const n=localIdentity(db);
  if(command==="prepare_integration"){
   v=verificationState(db,args.verification_id);r=scopedResult(v.binding.result_id,project);p=policy(args.policy_id,project);const vp=profile(v.profile_id,project);
   if(vp.mapping_id!==p.mapping_id)fail("INTEGRATION_MAPPING_MISMATCH","验证与合并仓库不同");
  }else if(["apply_integration","reconcile_integration","check_integration","prepare_completion"].includes(command)){
   i=integrationState(db,args.integration_id??args.id);r=scopedResult(i.binding.result_id,project);p=policy(i.binding.policy_id,project);v=verificationState(db,i.binding.verification_id);profile(v.profile_id,project);
  }else{
   c=completionState(db,args.id);r=scopedResult(c.plan.result_id,project);
   if(command==="send_completion"){if(c.side!=="source")fail("FORBIDDEN","只有来源发送验收意图",403);remote=true;nodeId=c.plan.relation.target_node_id;nodeEpoch=c.plan.relation.target_epoch;}
   if(["register_completion","poll_completion"].includes(command)){const b=bindingState(db,c.plan.relation.relation_id);nodeId=b.registrar_node_id;nodeEpoch=b.registrar_epoch;remote=nodeId!==n.node_id;if(!remote&&nodeEpoch!==n.sync_epoch)fail("EPOCH_CHANGED","登记节点代次不同");}
   context={plan_digest:c.plan_digest,side:c.side};
  }
  if(!c){
   if(r.side!=="source"||r.review_state!=="pending_evidence")fail("RESULT_NOT_PENDING","来源候选不再等待核验");
   const task=db.prepare("SELECT aggregate_version FROM tasks WHERE task_uid=?").get(r.body.relation.source_task_uid);if(!task)fail("NOT_FOUND","来源任务不存在",404);
   if(command==="prepare_completion"){
    version(args.expected_version);if(typeof args.note!=="string"||!args.note.trim()||Buffer.byteLength(args.note)>4096||typeof args.allow_fixture!=="boolean")fail("BAD_INPUT","验收说明或模拟声明无效",400);
    if(task.aggregate_version!==args.expected_version)fail("VERSION_CONFLICT","来源任务版本已变化");
    if(r.body.scope.fixture_runs>0&&!args.allow_fixture)fail("FIXTURE_ACCEPTANCE_REQUIRED","候选包含模拟执行，须明确确认模拟验收");
   }
   context={body_digest:r.body_digest,task_version:task.aggregate_version,verification_binding:v.binding_digest,verification_receipt:v.receipt_digest,policy_digest:p.descriptor_digest,integration_binding:i?.binding_digest??null};
  }
  return {result:r,integration:i,verification:v,completion:c,context_digest:digest(context),remote,node_id:nodeId??n.node_id,node_epoch:nodeEpoch??n.sync_epoch};
 }
 function publicState(s){
  if(s.completion_id)return {completion_id:s.completion_id,result_id:s.plan.result_id,state:s.phase==="settled"?"completion_settled":s.phase==="retired"?"completion_retired":s.phase==="ready"?"completion_ready":"completion_prepared",phase:s.phase,accepted:s.accepted===true,fixture_runs:s.plan.fixture_runs};
  return {integration_id:s.integration_id,result_id:s.binding?.result_id??null,verification_id:s.binding?.verification_id??null,state:s.phase==="settled"?"source_applied":s.phase==="ready"?"integration_ready":s.phase==="launch_committed"?"integration_launched":s.phase,phase:s.phase,source_applied:s.receipt?.source_applied===true,context_current:s.receipt?.current_at_observation===true,accepted:false};
 }
 async function execute(binding,{project,authorize,options,sourceGate}){
  const {command,args,id}=binding;authorize();let s;
  if(command==="prepare_integration"){
   const old=db.prepare("SELECT integration_id FROM integration_attempts WHERE integration_id=?").get(id);
   s=old?integrationState(db,id):prepareIntegration(db,{integrationId:id,policyId:args.policy_id,verificationId:args.verification_id,sourceGate});
  }else if(["apply_integration","reconcile_integration","check_integration"].includes(command)){
   const current=integrationState(db,args.id);
   if(command==="check_integration"){captureAppliedIntegration(db,{integrationId:args.id,sourceGate});s=current;}
   else s=current.phase==="settled"?current:command==="apply_integration"&&current.phase==="ready"?executeIntegration(db,{integrationId:args.id,sourceGate}):reconcileIntegration(db,{integrationId:args.id,sourceGate,authorize});
  }else if(command==="prepare_completion"){
   const old=db.prepare("SELECT completion_id FROM completion_plans WHERE integration_id=?").get(args.integration_id);
   if(old&&old.completion_id!==id)fail("COMPLETION_EXISTS","已有冻结的验收决定，请继续原流程");
   s=prepareCompletion(db,{completionId:id,integrationId:args.integration_id,expectedSourceVersion:args.expected_version,note:args.note,allowFixture:args.allow_fixture,sourceGate});
  }else if(command==="send_completion")s=await deliverCompletion(db,{...options,completionId:args.id,authorize});
  else if(["register_completion","poll_completion"].includes(command))s=await submitCompletion(db,{...options,completionId:args.id,mode:command==="register_completion"?"approve":"poll",authorize});
  else s=settleCompletion(db,{completionId:args.id,sourceGate,authorize});
  return {...publicState(s),delivery_state:s.delivery_state==="waiting_peer"?"applied":s.delivery_state??"applied",error_code:s.error_code??null};
 }
 function catalog(projects){
  const available=[],integrations=[],completions=[];let truncated=false;
  for(const id of policies){const row=db.prepare("SELECT mapping_id FROM integration_policies WHERE policy_id=?").get(id);if(!row)continue;const m=db.prepare("SELECT project_id,repo_id FROM repository_mappings WHERE mapping_id=?").get(row.mapping_id);if(!m||!projects.includes(m.project_id))continue;try{const p=policy(id,m.project_id);available.push({policy_id:id,project_id:m.project_id,mapping_id:p.mapping_id,repo_id:m.repo_id,ref:p.descriptor.ref});}catch(e){if(e instanceof PeerError)continue;throw e;}}
  const n=localIdentity(db),marks=projects.map(()=>"?").join(",");
  const rows=table=>db.prepare("SELECT x.*,r.project_id FROM "+table+" x JOIN delegation_results r ON r.result_id=x.result_id WHERE r.project_id IN("+marks+") AND x.node_id=? AND x.node_epoch=? ORDER BY x.created_at DESC LIMIT 101").all(...projects,n.node_id,n.sync_epoch);
  const ir=rows("integration_attempts");truncated=ir.length>100;
  for(const row of ir.slice(0,100)){const s=integrationState(db,row.integration_id),r=scopedResult(s.binding.result_id,row.project_id),task=db.prepare("SELECT aggregate_version FROM tasks WHERE task_uid=?").get(r.body.relation.source_task_uid);integrations.push({...publicState(s),project_id:row.project_id,policy_id:s.binding.policy_id,ref:s.binding.ref,base_commit:s.binding.base_commit,artifact_commit:s.binding.artifact_commit,merge_commit:s.receipt?.merge_commit??null,receipt_digest:s.receipt_digest,source_task_version:task?.aggregate_version??null,fixture_runs:r.body.scope.fixture_runs});}
  const cr=rows("completion_plans");truncated=truncated||cr.length>100;
  for(const row of cr.slice(0,100)){const s=completionState(db,row.completion_id);completions.push({...publicState(s),project_id:row.project_id,side:s.side,integration_id:row.integration_id,note:s.plan.decision.note,source_merge_commit:s.plan.source_merge_commit,plan_digest:s.plan_digest});}
  return {enabled:true,policies:available,integrations,completions,truncated};
 }
 return {scope,execute,catalog};
}
