import {COMPLETION_COMMANDS,openFleetCompletion} from "./fleet-completion-actions.mjs";
import {isAbsolute,resolve,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {PeerError,uuid,names} from "./federation/protocol.mjs";
import {localIdentity} from "./federation/peers.mjs";
import {digest} from "./federation/sync-store.mjs";
import {exact} from "./mcp/policy.mjs";
import {resultState} from "./federation/results.mjs";
import {repositoryState} from "./artifacts/repositories.mjs";
import {registerArtifactTarget,prepareArtifact,artifactState,verifyArtifact} from "./artifacts/transfers.mjs";
import {deliverArtifact} from "./artifacts/transfer-client.mjs";
import {migrateVerification,prepareVerification,executeVerification,reconcileVerification,verificationState} from "./verification/service.mjs";
import {createSourceGate} from "./execution/source-gate.mjs";
export const DELIVERY_COMMANDS=new Set([...COMPLETION_COMMANDS,"register_artifact_target","prepare_artifact","send_artifact","verify_artifact","prepare_verification","run_verification","reconcile_verification"]);
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
const ROOT=fileURLToPath(new URL("../",import.meta.url));
const fields={register_artifact_target:["result_id","mapping_id"],prepare_artifact:["result_id"],send_artifact:["id"],verify_artifact:["id"],prepare_verification:["transfer_id","profile_id"],run_verification:["id"],reconcile_verification:["id"]};
export function openFleetDelivery(db,{config,sourceGate}){
 if(config===undefined)return null;
 exact(config,["approval_file","receivers","verification_profiles",...(Object.hasOwn(config??{},"integration_policies")?["integration_policies"]:[])],"fleet_delivery");
 if(typeof config.approval_file!=="string"||!isAbsolute(config.approval_file)||!Array.isArray(config.receivers)||config.receivers.length>64||!Array.isArray(config.verification_profiles)||config.verification_profiles.length>64)fail("BAD_INPUT","交付配置格式或数量无效",400);
 const seen=new Set();
 for(const r of config.receivers){exact(r,["project_id","mapping_id","base_commit","allow_full_baseline_read"],"fleet_receiver");names([r.project_id],"project_id",null,1);uuid(r.mapping_id,"mapping_id");
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(r.base_commit)||r.allow_full_baseline_read!==true||seen.has(r.mapping_id))fail("BAD_INPUT","接收映射必须唯一，并明确批准基线读取",400);seen.add(r.mapping_id);
 }
 const profiles=new Set();for(const id of config.verification_profiles){uuid(id,"profile_id");if(profiles.has(id))fail("BAD_INPUT","验证配置重复",400);profiles.add(id);}
 const gate=sourceGate??createSourceGate({codeRoot:resolve(ROOT),approvalFile:config.approval_file}),configDigest=digest(config);
 gate.check();migrateVerification(db);
 function mapping(id,project){const m=repositoryState(db,{mappingId:id});if(m.project_id!==project)fail("NOT_FOUND","此项目没有该仓库映射",404);return m;}
 function profile(id,project){
  if(!profiles.has(id))fail("FORBIDDEN","未批准从面板启动此验证配置",403);
  const p=db.prepare("SELECT * FROM verification_profiles WHERE profile_id=?").get(id),n=localIdentity(db);
  if(!p||p.node_id!==n.node_id||p.node_epoch!==n.sync_epoch||db.prepare("SELECT 1 FROM verification_revocations WHERE profile_id=?").get(id))fail("VERIFICATION_REVOKED","验证配置不可用");
  if(digest(JSON.parse(p.descriptor_json))!==p.descriptor_digest)fail("VERIFICATION_CORRUPT","验证配置摘要改变");mapping(p.mapping_id,project);return p;
 }
 function receiver(id,project){const r=config.receivers.find(x=>x.mapping_id===id&&x.project_id===project);if(!r)fail("FORBIDDEN","未配置该项目的接收基线",403);mapping(id,project);return r;}
 const completion=openFleetCompletion(db,{policyIds:config.integration_policies,mapping,profile});
 function scope(command,args,project){
  if(COMPLETION_COMMANDS.has(command)){if(!completion)fail("COMPLETION_NOT_CONFIGURED","尚未配置面板合并与结案");return completion.scope(command,args,project); }
  exact(args,fields[command],"delivery_arguments");for(const value of Object.values(args))uuid(value,"delivery_id");
  let a=null,v=null,resultId=args.result_id;
  if(["send_artifact","verify_artifact","prepare_verification"].includes(command)){a=artifactState(db,args.transfer_id??args.id);resultId=a.result_id;}
  if(["run_verification","reconcile_verification"].includes(command)){v=verificationState(db,args.id);a=artifactState(db,v.transfer_id);resultId=a.result_id;profile(v.profile_id,project);}
  const r=resultState(db,resultId);
  if(r.body.relation.project_id!==project)fail("NOT_FOUND","此项目没有该交付候选",404);
  const side=["prepare_artifact","send_artifact"].includes(command)?"target":"source";
  if(r.side!==side||r.review_state!=="pending_evidence")fail("RESULT_NOT_PENDING","此端点的交付不在待核验状态");
  const t=db.prepare("SELECT aggregate_version FROM tasks WHERE task_uid=?").get(r.body.relation[side+"_task_uid"]);
  if(!t)fail("NOT_FOUND","本机任务不存在",404);
  let selection=null;
  if(command==="register_artifact_target")selection=receiver(args.mapping_id,project);
  if(command==="prepare_verification"){const p=profile(args.profile_id,project),target=db.prepare("SELECT mapping_id FROM artifact_targets WHERE result_id=?").get(resultId);if(target?.mapping_id!==p.mapping_id)fail("VERIFICATION_MAPPING_MISMATCH","验证配置与产物接收仓库不同");selection={profile_id:p.profile_id,digest:p.descriptor_digest};}
  return {result:r,context_digest:digest({result_id:resultId,body_digest:r.body_digest,task_version:t.aggregate_version,side,header_digest:a?.header_digest??null,verification_binding:v?.binding_digest??null,selection})};
 }
 function prepare({command,args,project,requestId}){
  const s=scope(command,args,project),n=localIdentity(db),remote=command==="send_artifact",d=s.result.body.relation;
  return {kind:"delivery",id:requestId,command,args,config_digest:configDigest,context_digest:s.context_digest,remote:s.remote??remote,node_id:s.node_id??(remote?d.source_node_id:n.node_id),node_epoch:s.node_epoch??(remote?d.source_epoch:n.sync_epoch)};
 }
 function publicState(v){return {state:v.phase==="settled"?(v.receipt?.checks_passed?"checks_passed":"checks_failed"):v.phase??v.state??"target_registered",result_id:v.result_id??v.binding?.result_id??null,transfer_id:v.transfer_id??null,verification_id:v.verification_id??null,checks_passed:v.receipt?.checks_passed??null,accepted:false};}
 async function execute(binding,{project,authorize,options}){
  authorize();if(binding.config_digest!==configDigest)fail("DELIVERY_CONFIG_CHANGED","交付配置变化，原操作不可继续");
  const {command,args,id}=binding,s=scope(command,args,project);
  if(s.context_digest!==binding.context_digest)fail("DELIVERY_CONTEXT_CHANGED","候选、任务版本或验证配置变化，需重新核对");
  const sourceGate={check(){authorize();return gate.check();}};sourceGate.check();let v;
  if(COMPLETION_COMMANDS.has(command))return completion.execute(binding,{project,authorize,options,sourceGate});
  if(command==="register_artifact_target"){const r=receiver(args.mapping_id,project);v=registerArtifactTarget(db,{resultId:args.result_id,mappingId:r.mapping_id,baseCommit:r.base_commit,allowFullBaselineRead:true,authorize});}
  else if(command==="prepare_artifact"){
   const old=db.prepare("SELECT transfer_id FROM artifact_transfers WHERE result_id=?").get(args.result_id);
   v=old?artifactState(db,old.transfer_id):prepareArtifact(db,{resultId:args.result_id,transferId:id,authorize});
  }else if(command==="send_artifact"){
   v=await deliverArtifact(db,{...options,transferId:args.id,authorize,maxChunks:64});
   return {...publicState(v),delivery_state:v.delivery_state==="more"?"retry_pending":v.delivery_state,error_code:v.error_code??null};
  }else if(command==="verify_artifact")v=verifyArtifact(db,{transferId:args.id,authorize});
  else if(command==="prepare_verification")v=prepareVerification(db,{verificationId:id,profileId:args.profile_id,transferId:args.transfer_id,sourceGate});
  else{
   const state=verificationState(db,args.id);
   v=state.phase==="settled"?state:command==="run_verification"&&state.phase==="ready"?await executeVerification(db,{verificationId:args.id,sourceGate,signal:options.signal}):reconcileVerification(db,{verificationId:args.id,sourceGate});
  }
  return {...publicState(v),delivery_state:"applied"};
 }
 function catalog(projects){
  const receivers=[],availableProfiles=[],targets=[],artifacts=[],verifications=[];let truncated=false;
  for(const r of config.receivers.filter(x=>projects.includes(x.project_id))){try{const m=mapping(r.mapping_id,r.project_id);receivers.push({project_id:r.project_id,mapping_id:r.mapping_id,repo_id:m.repo_id,base_commit:r.base_commit});}catch(e){if(e instanceof PeerError)continue;throw e;}}
  for(const id of profiles){const p=db.prepare("SELECT mapping_id FROM verification_profiles WHERE profile_id=?").get(id);if(!p)continue;const m=db.prepare("SELECT project_id FROM repository_mappings WHERE mapping_id=?").get(p.mapping_id);if(!m||!projects.includes(m.project_id))continue;try{const checked=profile(id,m.project_id),definition=JSON.parse(checked.descriptor_json).definition;availableProfiles.push({profile_id:id,project_id:m.project_id,mapping_id:p.mapping_id,command_name:basename(definition.command.path),check_files:definition.pins.map(p=>basename(p.path))});}catch(e){if(e instanceof PeerError)continue;throw e;}}
  const placeholders=projects.map(()=>"?").join(","),n=localIdentity(db);
  const allowedTargets=db.prepare("SELECT t.result_id,t.mapping_id,t.base_commit,r.project_id FROM artifact_targets t JOIN delegation_results r ON r.result_id=t.result_id WHERE r.project_id IN("+placeholders+") AND t.node_id=? AND t.node_epoch=? ORDER BY t.created_at DESC,t.result_id LIMIT 101").all(...projects,n.node_id,n.sync_epoch);
  targets.push(...allowedTargets.slice(0,100));truncated=allowedTargets.length>100;
  const transfers=db.prepare("SELECT a.transfer_id,r.project_id FROM artifact_transfers a JOIN delegation_results r ON r.result_id=a.result_id WHERE r.project_id IN("+placeholders+") AND a.node_id=? AND a.node_epoch=? ORDER BY a.created_at DESC,a.transfer_id LIMIT 101").all(...projects,n.node_id,n.sync_epoch);
  truncated=truncated||transfers.length>100;
  for(const row of transfers.slice(0,100)){const a=artifactState(db,row.transfer_id),target=a.side==="source"?db.prepare("SELECT mapping_id FROM artifact_targets WHERE result_id=?").get(a.result_id):null;artifacts.push({...publicState(a),project_id:row.project_id,side:a.side,bytes:a.header.payload_bytes,received_bytes:a.received_bytes,base_commit:a.header.manifest.base_commit,repo_id:a.header.manifest.repo_id,mapping_id:target?.mapping_id??null});}
  const attempts=db.prepare("SELECT v.verification_id,r.project_id FROM verification_attempts v JOIN artifact_transfers a ON a.transfer_id=v.transfer_id JOIN delegation_results r ON r.result_id=a.result_id WHERE r.project_id IN("+placeholders+") AND v.node_id=? AND v.node_epoch=? ORDER BY v.created_at DESC,v.verification_id LIMIT 101").all(...projects,n.node_id,n.sync_epoch);
  truncated=truncated||attempts.length>100;
  for(const row of attempts.slice(0,100)){const v=verificationState(db,row.verification_id);verifications.push({...publicState(v),project_id:row.project_id,profile_id:v.profile_id,mapping_id:db.prepare("SELECT mapping_id FROM verification_profiles WHERE profile_id=?").get(v.profile_id)?.mapping_id??null,phase:v.phase,receipt_digest:v.receipt_digest,diagnostic:v.receipt?.observation?.diagnostic??null});}
  const closure=completion?completion.catalog(projects):{enabled:false};
  return {enabled:true,receivers,profiles:availableProfiles,targets,artifacts,verifications,closure,truncated:truncated||closure.truncated===true};
 }
 return {prepare,execute,catalog};
}
