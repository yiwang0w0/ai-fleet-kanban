import {topologyBindingsTable} from "./topology-generations.mjs";
// Local operator control only; never classify an unknown network reply as rejection.
import {createRequire} from "node:module";
import {PeerError,keys,uuid} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {atomic,canonical,digest} from "./sync-store.mjs";
const store=createRequire(import.meta.url)("../store.js");
const PLAN="ai-fleet-binding-recovery-plan/v1",ATTESTATION="ai-fleet-binding-recovery-attestation/v1",RECEIPT="ai-fleet-binding-recovery-receipt/v1";
export const BINDING_RECOVERY_CODE="OPERATOR_ATTESTED_REGISTRAR_RETIRED";
const at=()=>new Date().toISOString(),has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const hash=x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失");}
function schema(db){if(!has(db,"binding_recovery_schema"))return false;if(db.prepare("SELECT version FROM binding_recovery_schema WHERE singleton=1").get()?.version!==1)fail("SCHEMA_INCOMPATIBLE","绑定人工恢复格式不兼容");return true;}
export function migrateBindingRecovery(db){return atomic(db,()=>{
 if(schema(db))return;
 db.exec([
 "CREATE TABLE binding_recovery_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);",
 "INSERT INTO binding_recovery_schema VALUES(1,1);",
 "CREATE TABLE binding_recoveries(relation_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL,plan_json TEXT NOT NULL,attestation_digest TEXT NOT NULL,attestation_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TRIGGER binding_recovery_immutable BEFORE UPDATE ON binding_recoveries BEGIN SELECT RAISE(ABORT,'binding recovery is immutable'); END;",
 "CREATE TRIGGER binding_recovery_retained BEFORE DELETE ON binding_recoveries BEGIN SELECT RAISE(ABORT,'binding recovery must be retained'); END;"
 ].join("\n"));
});}
export function bindingRecovery(db,relationId){
 if(!schema(db))return null;
 const row=db.prepare("SELECT * FROM binding_recoveries WHERE relation_id=?").get(relationId);if(!row)return null;
 let r;try{r=JSON.parse(row.receipt_json);}catch{fail("RECEIPT_MISMATCH","绑定恢复回执损坏");}
 if(!r||r.format!==RECEIPT||r.code!==BINDING_RECOVERY_CODE||r.relation_id!==relationId||r.plan_digest!==row.plan_digest||r.attestation_digest!==row.attestation_digest||digest(r)!==row.receipt_digest)fail("RECEIPT_MISMATCH","绑定恢复回执摘要不匹配");
 return r;
}
function localBinding(db,relationId){
 uuid(relationId,"relation_id");const n=localIdentity(db),b=db.prepare("SELECT * FROM delegation_bindings WHERE relation_id=?").get(relationId);
 if(!b)fail("NOT_FOUND","未找到端点绑定");
 if(b.node_id!==n.node_id)fail("IDENTITY_MISMATCH","不能裁定其他节点的绑定");
 return {n,b};
}
export function inspectBindingRecovery(db,relationId){localBinding(db,relationId);return bindingRecovery(db,relationId);}
function snapshot(db,relationId,registrarEpoch){
 const {n,b}=localBinding(db,relationId);uuid(registrarEpoch,"registrar_epoch");
 if(b.state!=="prepared"||b.closed)fail("RECOVERY_NOT_AVAILABLE","只允许退出未确认绑定；已确认关系需执行取消协议");
 if(registrarEpoch===b.registrar_epoch||b.registrar_node_id===n.node_id&&registrarEpoch!==n.sync_epoch)fail("REGISTRAR_EPOCH_MISMATCH","需要同一登记节点实际观察到的新代次");
 if(bindingRecovery(db,relationId))fail("ALREADY_RESOLVED","绑定已有人工退出回执");
 const t=db.prepare("SELECT * FROM tasks WHERE id=? AND task_uid=?").get(b.task_id,b.task_uid);
 if(!t||t.owner_node_id!==n.node_id||t.archived_at||t.status==="done")fail("CONFLICT","任务身份或终态已变化");
 const runs=db.prepare("SELECT * FROM task_runs WHERE task_id=? ORDER BY run_id").all(b.task_id);
 if(t.status==="in_progress"||runs.some(r=>r.state==="running"))fail("ACTIVE_WORK","先停止并结算本机运行，再记录绑定退出");
 const attempts=db.prepare("SELECT * FROM binding_attempts WHERE relation_id=? ORDER BY request_id").all(relationId);
 const outbox=db.prepare("SELECT * FROM binding_outbox WHERE relation_id=? ORDER BY request_id").all(relationId);
 const commits=db.prepare("SELECT * FROM binding_source_commits WHERE relation_id=? ORDER BY credential_version").all(relationId);
 const topology=db.prepare("SELECT * FROM "+topologyBindingsTable(db)+" WHERE project_id=?").get(b.project_id)??null;
 const d=JSON.parse(b.descriptor_json);
 return {node_id:n.node_id,node_epoch:n.sync_epoch,binding_epoch:b.node_epoch,relation_id:relationId,delegation_id:b.delegation_id,project_id:b.project_id,side:b.side,task_uid:b.task_uid,task_version:t.aggregate_version,
  graph_id:d.graph_id,graph_epoch:d.graph_epoch,registrar_node_id:b.registrar_node_id,retired_registrar_epoch:b.registrar_epoch,observed_registrar_epoch:registrarEpoch,descriptor_digest:b.descriptor_digest,
  pending_request_ids:attempts.filter(a=>a.state==="pending").map(a=>a.request_id),state_digest:digest({binding:b,task:t,runs,attempts,outbox,commits,topology}),
  remote_outcome_known:false,automatic_release:false,graph_recovered:false};
}
/** Read-only snapshot; output is not evidence that a remote node stopped. */
export function prepareBindingRecovery(db,{relationId,registrarEpoch}){
 const own=!db.isTransaction;if(own)db.exec("BEGIN");
 try{const payload={format:PLAN,...snapshot(db,relationId,registrarEpoch),prepared_at:at()},plan={...payload,plan_digest:digest(payload)};if(own)db.exec("COMMIT");return plan;}catch(e){if(own)db.exec("ROLLBACK");throw e;}
}
/** No MCP/peer endpoint. Full attestation stays in the private local database. */
export function recordBindingRecovery(db,{plan,expectedPlanDigest,attestation}){
 const fields=["format","node_id","node_epoch","binding_epoch","relation_id","delegation_id","project_id","side","task_uid","task_version","graph_id","graph_epoch","registrar_node_id","retired_registrar_epoch","observed_registrar_epoch","descriptor_digest","pending_request_ids","state_digest","remote_outcome_known","automatic_release","graph_recovered","prepared_at","plan_digest"];
 exact(plan,fields,"binding_recovery_plan");const {plan_digest,...payload}=plan;
 if(plan.format!==PLAN||!hash(expectedPlanDigest)||plan_digest!==expectedPlanDigest||digest(payload)!==expectedPlanDigest||!Number.isFinite(Date.parse(plan.prepared_at)))fail("PLAN_MISMATCH","退出计划与明确核对的摘要不匹配");
 const identity=["node_id","node_epoch","binding_epoch","relation_id","registrar_node_id","retired_registrar_epoch","observed_registrar_epoch","plan_digest"];
 exact(attestation,["format",...identity,"old_registrar_disabled","both_endpoint_workers_stopped","remote_outcome_unknown","no_automatic_release","evidence_ref","attested_at"],"binding_recovery_attestation");
 if(attestation.format!==ATTESTATION||identity.some(k=>attestation[k]!==plan[k]))fail("ATTESTATION_MISMATCH","声明未绑定当前节点、旧绑定与登记节点换代计划");
 if(["old_registrar_disabled","both_endpoint_workers_stopped","remote_outcome_unknown","no_automatic_release"].some(k=>attestation[k]!==true)||typeof attestation.evidence_ref!=="string"||attestation.evidence_ref.trim().length<8||attestation.evidence_ref.length>2048||/[\x00-\x1f\x7f]/.test(attestation.evidence_ref)||typeof attestation.attested_at!=="string"||!Number.isFinite(Date.parse(attestation.attested_at)))fail("RETIREMENT_ATTESTATION_REQUIRED","需声明旧登记节点已禁用、双方执行器已停止、结果仍未知且不自动放行，并提供证据引用与时间");
 return atomic(db,()=>{
  const {n,b}=localBinding(db,plan.relation_id);
  if(n.node_id!==plan.node_id||n.sync_epoch!==plan.node_epoch||b.node_epoch!==plan.binding_epoch)fail("IDENTITY_MISMATCH","计划的本机身份或代次已变化");
  const attestationDigest=digest(attestation),old=bindingRecovery(db,b.relation_id);
  if(old){if(old.plan_digest!==plan_digest||old.attestation_digest!==attestationDigest)fail("REQUEST_CONFLICT","此绑定已有不同的人工退出决定");return old;}
  const current=snapshot(db,b.relation_id,plan.observed_registrar_epoch);
  if(Object.entries(current).some(([k,v])=>canonical(v)!==canonical(plan[k])))fail("PLAN_STALE","任务、绑定、请求或拓扑已变化；需重新核对计划");
  migrateBindingRecovery(db);
  // Local terminal state, not a fabricated registrar withdrawal or cancellation receipt.
  db.prepare("UPDATE binding_attempts SET state='rejected',error_code=? WHERE relation_id=? AND state='pending'").run(BINDING_RECOVERY_CODE,b.relation_id);
  db.prepare("UPDATE delegation_bindings SET state='cancelled' WHERE relation_id=? AND state='prepared'").run(b.relation_id);
  store.update(db,{id:b.task_id,expectedVersion:plan.task_version,humanGate:true,actor:"human"});
  store.setReleased(db,{id:b.task_id,expectedVersion:store.get(db,b.task_id).aggregate_version,released:false,actor:"human"});
  const receipt={format:RECEIPT,code:BINDING_RECOVERY_CODE,node_id:n.node_id,node_epoch:n.sync_epoch,binding_epoch:b.node_epoch,relation_id:b.relation_id,task_uid:b.task_uid,
   registrar_node_id:b.registrar_node_id,retired_registrar_epoch:b.registrar_epoch,observed_registrar_epoch:plan.observed_registrar_epoch,plan_digest,attestation_digest:attestationDigest,
   authority:"operator_attested_not_machine_verified",remote_outcome_known:false,automatic_release:false,graph_recovered:false,task_disposition:"held_for_human",recorded_at:at()};
  db.prepare("INSERT INTO binding_recoveries VALUES(?,?,?,?,?,?,?,?)").run(b.relation_id,plan_digest,canonical(plan),attestationDigest,canonical(attestation),digest(receipt),canonical(receipt),receipt.recorded_at);
  const detail=canonical({relation_id:b.relation_id,code:receipt.code,receipt_digest:digest(receipt),remote_outcome_known:false,task_disposition:receipt.task_disposition});
  db.prepare("INSERT INTO binding_events(relation_id,kind,detail_json,created_at) VALUES(?,'operator_recovery',?,?)").run(b.relation_id,detail,receipt.recorded_at);
  db.prepare("INSERT INTO task_events(at,task_id,kind,actor,detail) VALUES(?,?,'binding_operator_recovery','human',?)").run(receipt.recorded_at,b.task_id,detail);
  return receipt;
 });
}
