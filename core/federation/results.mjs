import {createRequire} from "node:module";
import {PeerError,keys,uuid,version,names} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {normalizeRelation} from "./relations.mjs";
import {bindingState} from "./bindings.mjs";
import {migrateCancellations} from "./cancellation.mjs";
import {topologyState} from "./topology.mjs";
import {inspectStoppedRuns} from "../execution/stop-proof.mjs";
const require=createRequire(import.meta.url),store=require("../store.js"),guard=require("../result_guard.js"),cancel=require("../cancellation_guard.js");
export const MAX_RESULT_BYTES=384*1024;
const at=()=>new Date().toISOString(),has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t);
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(x,fields){keys(x,fields,"result");if(Object.keys(x).length!==fields.length)fail("BAD_INPUT","交付字段缺失",400);}
function unit(db,fn){if(!db.isTransaction)return transaction(db,fn);db.exec("SAVEPOINT result_unit");try{const r=fn();db.exec("RELEASE result_unit");return r;}catch(e){db.exec("ROLLBACK TO result_unit; RELEASE result_unit");throw e;}}
const hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
function text(x,max=128*1024){return typeof x==="string"&&Buffer.byteLength(x)<=max;}
export function migrateResults(db){return unit(db,()=>{
 migrateCancellations(db);
 db.exec("CREATE TABLE IF NOT EXISTS result_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO result_schema VALUES(1,1)");
 if(db.prepare("SELECT version FROM result_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","交付存储版本不兼容");
 db.exec([
 "CREATE TABLE IF NOT EXISTS delegation_results(result_id TEXT PRIMARY KEY,relation_id TEXT NOT NULL,project_id TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN('target','source')),node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,sequence INTEGER NOT NULL,task_uid TEXT NOT NULL,task_version INTEGER NOT NULL,run_id TEXT NOT NULL,body_json TEXT NOT NULL,body_digest TEXT NOT NULL,scope_json TEXT,created_at TEXT NOT NULL,UNIQUE(relation_id,sequence),UNIQUE(relation_id,run_id));",
 "CREATE TABLE IF NOT EXISTS result_recovery_permits(task_id INTEGER PRIMARY KEY);",
 "CREATE TABLE IF NOT EXISTS result_members(result_id TEXT NOT NULL,task_id INTEGER NOT NULL,task_uid TEXT NOT NULL,task_version INTEGER NOT NULL,PRIMARY KEY(result_id,task_id));",
 "CREATE INDEX IF NOT EXISTS result_member_task ON result_members(task_id);",
 "CREATE TABLE IF NOT EXISTS result_receipts(result_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS result_decisions(result_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL UNIQUE,decision_json TEXT NOT NULL,decision_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS result_events(id INTEGER PRIMARY KEY,result_id TEXT NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TRIGGER IF NOT EXISTS result_one_candidate BEFORE INSERT ON delegation_results WHEN EXISTS(SELECT 1 FROM delegation_results r WHERE r.relation_id=NEW.relation_id AND NOT EXISTS(SELECT 1 FROM result_decisions d WHERE d.result_id=r.result_id)) BEGIN SELECT RAISE(ABORT,'RESULT_PENDING: previous candidate awaits owner decision'); END;",
 "CREATE TRIGGER IF NOT EXISTS result_task_freeze BEFORE UPDATE ON tasks WHEN "+guard.heldSQL("OLD.id")+" AND NOT EXISTS(SELECT 1 FROM result_recovery_permits w WHERE w.task_id=OLD.id) BEGIN SELECT RAISE(ABORT,'RESULT_PENDING: candidate task version is sealed'); END;",
 "CREATE TRIGGER IF NOT EXISTS result_child_freeze BEFORE INSERT ON tasks WHEN "+guard.heldSQL("NEW.parent_id")+" BEGIN SELECT RAISE(ABORT,'RESULT_PENDING: candidate subtree is sealed'); END;",
 "CREATE TRIGGER IF NOT EXISTS result_member_retained BEFORE DELETE ON tasks WHEN "+guard.heldSQL("OLD.id")+" BEGIN SELECT RAISE(ABORT,'RESULT_PENDING: candidate task must be retained'); END;",
 "CREATE TRIGGER IF NOT EXISTS result_binding_freeze BEFORE INSERT ON delegation_bindings WHEN NEW.side='source' AND "+guard.heldSQL("NEW.task_id")+" BEGIN SELECT RAISE(ABORT,'RESULT_PENDING: sealed candidate cannot delegate new work'); END;",
 "CREATE TRIGGER IF NOT EXISTS result_topology_freeze BEFORE INSERT ON topology_operations WHEN EXISTS(SELECT 1 FROM json_each(NEW.desired_json,'$.vertices') v JOIN json_each(NEW.before_json,'$.vertices') b ON json_extract(b.value,'$.task_uid')=json_extract(v.value,'$.task_uid') WHERE json_extract(v.value,'$.parent_uid') IS NOT json_extract(b.value,'$.parent_uid') AND EXISTS(SELECT 1 FROM result_members m JOIN delegation_results r USING(result_id) WHERE r.side='target' AND NOT EXISTS(SELECT 1 FROM result_decisions d WHERE d.result_id=r.result_id) AND m.task_uid IN(json_extract(v.value,'$.task_uid'),json_extract(v.value,'$.parent_uid'),json_extract(b.value,'$.parent_uid')))) BEGIN SELECT RAISE(ABORT,'RESULT_PENDING: sealed subtree cannot be reparented'); END;"
 ].join("\n"));
 for(const t of ["delegation_results","result_members","result_receipts","result_decisions","result_events"]){
  db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'result history is immutable'); END");
  db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'result history must be retained'); END");
 }
});}
function event(db,id,kind,detail){db.prepare("INSERT INTO result_events(result_id,kind,detail_json,created_at) VALUES(?,?,?,?)").run(id,kind,canonical(detail),at());}
function row(db,id){uuid(id,"result_id");const r=db.prepare("SELECT * FROM delegation_results WHERE result_id=?").get(id);if(!r)fail("NOT_FOUND","未找到候选交付",404);const n=localIdentity(db);if(r.node_id!==n.node_id||r.node_epoch!==n.sync_epoch)fail("RESULT_RECOVERY_REQUIRED","旧代次交付不可继续");return r;}
function grant(db,d,peer,side){
 const n=localIdentity(db),own=side==="source"?"target":"source",p=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(d[side+"_node_id"]);
 if(n.node_id!==d[own+"_node_id"]||n.sync_epoch!==d[own+"_epoch"])fail("IDENTITY_MISMATCH","交付端点身份不匹配");
 if(!p||p.status!=="active"||p.peer_epoch!==d[side+"_epoch"]||!JSON.parse(p.projects_json).includes(d.project_id)||!JSON.parse(p.scopes_json).includes("delegation:result")||peer.peer_node_id!==p.peer_node_id||peer.peer_epoch!==p.peer_epoch||peer.credential_version!==p.credential_version||!peer.projects.includes(d.project_id)||!peer.scopes.includes("delegation:result"))fail("FORBIDDEN","交付授权无效",403);
 if(db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(p.peer_node_id,p.peer_epoch))fail("RETIRED_EPOCH","交付来源代次已退役",403);
}
function validate(body){
 exact(body,["schema_version","kind","result_id","relation","sequence","target_task_version","target_status","execution","report","process_result","scope"]);
 if(body.schema_version!==1||body.kind!=="delegation_result"||Buffer.byteLength(canonical(body))>MAX_RESULT_BYTES)fail("BAD_INPUT","交付类型或长度无效",400);
 uuid(body.result_id,"result_id");version(body.sequence);version(body.target_task_version);if(!["waiting","done"].includes(body.target_status))fail("BAD_INPUT","交付任务状态无效",400);const d=normalizeRelation(body.relation),e=body.execution,p=body.process_result,s=body.scope;
 exact(e,["dispatch_id","run_id","agent_instance_id","role_id","role_version","policy_digest","runtime","model","effort","execution_mode","real_model_call_confirmed","result_digest","launch_digest","observation_digest","quiescence"]);
 for(const k of ["dispatch_id","run_id","agent_instance_id"])uuid(e[k],k);names([e.role_id],"role_id",null,1);version(e.role_version);
 if(e.real_model_call_confirmed!==false||!hash(e.policy_digest)||!hash(e.result_digest)||!["claude","codex","zcode"].includes(e.runtime)||!["fixture","provider"].includes(e.execution_mode)||!text(e.model,120)||!e.model||!text(e.effort,120)||!e.effort)fail("BAD_INPUT","执行身份或策略无效",400);
 if(e.execution_mode==="fixture"){if(e.launch_digest!==null||e.observation_digest!==null||e.quiescence!=="fixture_terminal")fail("BAD_INPUT","合成交付标签无效",400);}
 else if(!hash(e.launch_digest)||!hash(e.observation_digest)||!["not_started","windows_job_empty"].includes(e.quiescence))fail("BAD_INPUT","缺少实际终止观察",400);
 exact(p,["status","evidence","usage"]);
 if(!["success","failed","cancelled","timeout"].includes(p.status)||!text(p.evidence)||!text(body.report)||digest(p)!==e.result_digest)fail("BAD_INPUT","执行结果摘要或正文无效",400);
 if(p.usage!==null){exact(p.usage,["input_tokens","output_tokens"]);if(Object.values(p.usage).some(n=>!Number.isSafeInteger(n)||n<0))fail("BAD_INPUT","用量无效",400);}
 exact(s,["scope_digest","proof_digest","member_count","run_count","fixture_runs"]);
 if(!hash(s.scope_digest)||!hash(s.proof_digest)||![s.member_count,s.run_count,s.fixture_runs].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000)||s.member_count<1||s.member_count>10000||s.run_count<1||s.fixture_runs>s.run_count||e.execution_mode==="fixture"&&s.fixture_runs<1)fail("BAD_INPUT","停止范围无效",400);
 return d;
}
function scope(db,d){
 const all=db.prepare("SELECT t.id task_id,t.task_uid,t.aggregate_version task_version,t.parent_id,t.status,p.project_id FROM tasks t LEFT JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid").all(),root=all.find(t=>t.task_uid===d.target_task_uid),children=new Map();
 if(!root)fail("ENDPOINT_MISMATCH","接收任务不存在");for(const t of all){if(!children.has(t.parent_id))children.set(t.parent_id,[]);children.get(t.parent_id).push(t);}
 const members=[],seen=new Set(),queue=[root];for(let i=0;i<queue.length;i++){const t=queue[i];if(seen.has(t.task_uid))continue;seen.add(t.task_uid);members.push(t);queue.push(...(children.get(t.task_id)||[]));if(members.length>10000)fail("SCOPE_LIMIT","交付子树过大");}
 if(members.some(t=>t.project_id!==d.project_id))fail("PROJECT_BOUNDARY","交付子树存在未登记或跨项目卡片");
 if(members.some(t=>t.task_id!==root.task_id&&t.status!=="done"))fail("CHILDREN_PENDING","先完成本机子任务再准备交付");
 return members.sort((a,b)=>a.task_uid.localeCompare(b.task_uid));
}
function receipt(r){const b=JSON.parse(r.body_json),d=b.relation;return {schema_version:1,kind:"result_received",result_id:r.result_id,relation_id:r.relation_id,body_digest:r.body_digest,sequence:r.sequence,source_node_id:d.source_node_id,source_epoch:d.source_epoch,target_node_id:d.target_node_id,target_epoch:d.target_epoch};}
export function resultState(db,id){
 const r=row(db,id),decision=db.prepare("SELECT decision_json FROM result_decisions WHERE result_id=?").get(id),ack=db.prepare("SELECT receipt_json FROM result_receipts WHERE result_id=?").get(id);
 const accepted=decision&&JSON.parse(decision.decision_json).kind==="result_accepted";
 const cancellation=db.prepare("SELECT state FROM delegation_cancellations WHERE relation_id=?").get(r.relation_id),body=JSON.parse(r.body_json);
 return {result_id:id,relation_id:r.relation_id,project_id:r.project_id,side:r.side,sequence:r.sequence,state:accepted?"accepted":decision?"rejected":r.side==="source"?"received":ack?"delivered":"prepared",body,body_digest:r.body_digest,receipt:ack?JSON.parse(ack.receipt_json):r.side==="source"?receipt(r):null,decision:decision?JSON.parse(decision.decision_json):null,review_state:accepted?"accepted":cancellation?"cancel_pending":decision?"rejected":body.process_result.status==="success"?"pending_evidence":"execution_unsuccessful",accepted:!!accepted,dispatch_started:false};
}
export function listResults(db,{projectId,limit=100}){
 names([projectId],"project",null,1);if(!Number.isInteger(limit)||limit<1||limit>100)fail("BAD_INPUT","列表上限无效",400);const n=localIdentity(db);
 return {results:db.prepare("SELECT r.result_id,r.relation_id,r.sequence,r.side,r.node_id=? AND r.node_epoch=? identity_current,CASE WHEN json_extract(d.decision_json,'$.kind')='result_accepted' THEN 'accepted' WHEN d.result_id IS NOT NULL THEN 'rejected' WHEN r.side='source' THEN 'received' WHEN a.result_id IS NOT NULL THEN 'delivered' ELSE 'prepared' END state FROM delegation_results r LEFT JOIN result_decisions d USING(result_id) LEFT JOIN result_receipts a USING(result_id) WHERE r.project_id=? ORDER BY r.rowid DESC LIMIT ?").all(n.node_id,n.sync_epoch,projectId,limit)};
}
export function prepareResult(db,{resultId,relationId,expectedTaskVersion}){
 uuid(resultId,"result_id");version(expectedTaskVersion);
 return unit(db,()=>{
  const b=bindingState(db,relationId),old=db.prepare("SELECT * FROM delegation_results WHERE result_id=?").get(resultId);
  if(old){if(old.relation_id!==relationId||old.task_version!==expectedTaskVersion)fail("REQUEST_CONFLICT","交付编号已绑定其他内容");return resultState(db,resultId);}
  if(b.side!=="target"||b.state!=="confirmed")fail("CONFIRMATION_REQUIRED","已确认接收任务才能交付");
  if(topologyState(db,b.project_id).phase!=="ready")fail("TOPOLOGY_PENDING","先恢复待提交结构");
  if(db.prepare("SELECT 1 FROM delegation_results r WHERE relation_id=? AND NOT EXISTS(SELECT 1 FROM result_decisions d WHERE d.result_id=r.result_id)").get(relationId))fail("RESULT_PENDING","上一候选尚待来源决定");
  const t=db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(b.task_uid);
  if(!t||t.aggregate_version!==expectedTaskVersion||!["waiting","done"].includes(t.status)||t.archived_at||!t.run_id)fail("CONFLICT","接收任务版本或候选状态已变化");
  if(db.prepare("SELECT 1 FROM delegation_results WHERE relation_id=? AND run_id=?").get(relationId,t.run_id))fail("RESULT_RUN_REUSED","已退回的旧运行不能重新包装为新交付");
  const n=localIdentity(db),members=scope(db,b.relation),runs=members.flatMap(m=>db.prepare("SELECT * FROM task_runs WHERE task_id=? AND task_uid=?").all(m.task_id,m.task_uid));
  if(runs.length>100000)fail("SCOPE_LIMIT","运行历史过大");
  const stopped=inspectStoppedRuns(db,{nodeId:n.node_id,nodeEpoch:n.sync_epoch,members,runs});
  if(stopped.blockers.length)fail("STOP_UNCONFIRMED","交付仍有未确认停止的运行");
  if(db.prepare("SELECT 1 FROM delegation_bindings b WHERE b.side='source' AND b.closed=0 AND b.state IN('prepared','confirmed') AND b.task_uid IN(SELECT value FROM json_each(?))").get(JSON.stringify(members.map(m=>m.task_uid))))fail("DOWNSTREAM_PENDING","下游委派尚未完成来源验收");
  const dispatch=has(db,"broker_dispatches")?db.prepare("SELECT * FROM broker_dispatches WHERE run_id=?").get(t.run_id):null;
  if(!dispatch||dispatch.phase!=="settled"||!dispatch.launch_at||dispatch.node_id!==n.node_id||dispatch.node_epoch!==n.sync_epoch)fail("OUTCOME_REQUIRED","需要当前受控执行终态");
  const process=JSON.parse(dispatch.result_json),assignment=db.prepare("SELECT policy_json FROM broker_assignments WHERE assignment_id=?").get(dispatch.assignment_id),policy=JSON.parse(assignment.policy_json),proof=stopped.proofs.find(p=>p.run_id===t.run_id);
  const observed=db.prepare("SELECT launch_digest,observation_digest FROM broker_execution_records WHERE dispatch_id=?").get(dispatch.dispatch_id);
  const sequence=(db.prepare("SELECT max(sequence) n FROM delegation_results WHERE relation_id=?").get(relationId).n||0)+1;version(sequence);
  const scopeProof={members:members.map(m=>({task_uid:m.task_uid,task_version:m.task_version})),runs:stopped.proofs};
  const body={schema_version:1,kind:"delegation_result",result_id:resultId,relation:b.relation,sequence,target_task_version:t.aggregate_version,target_status:t.status,
   execution:{dispatch_id:dispatch.dispatch_id,run_id:t.run_id,agent_instance_id:dispatch.agent_instance_id,role_id:dispatch.role_id,role_version:dispatch.role_version,policy_digest:dispatch.policy_digest,runtime:policy.runtime,model:policy.model,effort:policy.effort,execution_mode:dispatch.execution_mode,real_model_call_confirmed:false,result_digest:dispatch.result_digest,launch_digest:dispatch.execution_mode==="fixture"?null:observed?.launch_digest,observation_digest:dispatch.execution_mode==="fixture"?null:observed?.observation_digest,quiescence:proof.kind},
   report:t.result||"",process_result:{status:process.status,evidence:process.evidence,usage:process.usage},scope:{scope_digest:digest(scopeProof.members),proof_digest:digest(scopeProof),member_count:members.length,run_count:runs.length,fixture_runs:stopped.fixtureRuns}};
  validate(body);
  const count=db.prepare("SELECT count(*) n FROM delegation_results r WHERE project_id=? AND node_epoch=? AND side='target' AND NOT EXISTS(SELECT 1 FROM result_decisions d WHERE d.result_id=r.result_id)").get(b.project_id,n.sync_epoch).n;if(count>=1000)fail("QUEUE_LIMIT","待裁定交付已达上限");
  db.prepare("INSERT INTO delegation_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(resultId,relationId,b.project_id,"target",n.node_id,n.sync_epoch,sequence,t.task_uid,t.aggregate_version,t.run_id,canonical(body),digest(body),canonical(scopeProof),at());
  for(const m of members)db.prepare("INSERT INTO result_members VALUES(?,?,?,?)").run(resultId,m.task_id,m.task_uid,m.task_version);
  event(db,resultId,"prepared",{body_digest:digest(body),members:members.length});return resultState(db,resultId);
 });
}
export function receiveResult(db,peer,body){
 const d=validate(body);
 return unit(db,()=>{
  grant(db,d,peer,"target");const b=bindingState(db,d.relation_id);
  if(b.side!=="source"||b.state!=="confirmed"||canonical(b.relation)!==canonical(d))fail("CONTRACT_MISMATCH","交付不属于已确认的来源合同");
  const prior=db.prepare("SELECT * FROM delegation_results WHERE result_id=?").get(body.result_id);
  if(prior){if(prior.body_digest!==digest(body))fail("REQUEST_CONFLICT","同一交付号内容不同");row(db,body.result_id);return receipt(prior);}
  if(db.prepare("SELECT 1 FROM delegation_results WHERE relation_id=? AND run_id=?").get(d.relation_id,body.execution.run_id))fail("RESULT_RUN_REUSED","旧运行已有候选交付");
  const sequence=(db.prepare("SELECT max(sequence) n FROM delegation_results WHERE relation_id=?").get(d.relation_id).n||0)+1;
  if(body.sequence!==sequence)fail("SEQUENCE_CONFLICT","交付轮次不连续");
  const n=localIdentity(db);if(db.prepare("SELECT count(*) n FROM delegation_results r WHERE project_id=? AND node_epoch=? AND side='source' AND NOT EXISTS(SELECT 1 FROM result_decisions x WHERE x.result_id=r.result_id)").get(d.project_id,n.sync_epoch).n>=1000)fail("QUEUE_LIMIT","来源待裁定交付已达上限");
  db.prepare("INSERT INTO delegation_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)").run(body.result_id,d.relation_id,d.project_id,"source",n.node_id,n.sync_epoch,body.sequence,d.target_task_uid,body.target_task_version,body.execution.run_id,canonical(body),digest(body),at());
  event(db,body.result_id,"received",{body_digest:digest(body),cancel_pending:!!db.prepare("SELECT 1 FROM delegation_cancellations WHERE relation_id=?").get(d.relation_id)});return receipt(row(db,body.result_id));
 });
}
export function recordResultReceipt(db,{resultId,receipt:ack}){return unit(db,()=>{
 const r=row(db,resultId);if(r.side!=="target")fail("FORBIDDEN","仅执行端记录接收回执",403);
 exact(ack,Object.keys(receipt(r)));if(canonical(ack)!==canonical(receipt(r)))fail("RECEIPT_MISMATCH","交付回执不匹配");
 const old=db.prepare("SELECT receipt_json FROM result_receipts WHERE result_id=?").get(resultId);
 if(!old){db.prepare("INSERT INTO result_receipts VALUES(?,?,?)").run(resultId,canonical(ack),at());event(db,resultId,"acknowledged",{receipt_digest:digest(ack)});}
 return resultState(db,resultId);
});}
export function rejectResult(db,{resultId,decisionId,expectedSourceVersion,note}){
 uuid(decisionId,"decision_id");version(expectedSourceVersion);if(!text(note,4096)||!note.trim())fail("BAD_INPUT","退回需具体说明",400);
 return unit(db,()=>{
  const r=row(db,resultId);if(r.side!=="source")fail("FORBIDDEN","仅来源可以裁定交付",403);
  const body=JSON.parse(r.body_json),old=db.prepare("SELECT decision_json FROM result_decisions WHERE result_id=?").get(resultId);
  const decision={schema_version:1,kind:"result_rejected",result_id:resultId,relation_id:r.relation_id,body_digest:r.body_digest,decision_id:decisionId,source_task_version:expectedSourceVersion,note,source_node_id:body.relation.source_node_id,source_epoch:body.relation.source_epoch,target_node_id:body.relation.target_node_id,target_epoch:body.relation.target_epoch};
  if(old){if(old.decision_json!==canonical(decision))fail("REQUEST_CONFLICT","交付决定已固定");return resultState(db,resultId);}
  if(db.prepare("SELECT 1 FROM delegation_cancellations WHERE relation_id=?").get(r.relation_id))fail("CANCELLATION_PENDING","已有取消决定，不再要求远端返工");
  const t=db.prepare("SELECT aggregate_version FROM tasks WHERE task_uid=?").get(body.relation.source_task_uid);if(!t||t.aggregate_version!==expectedSourceVersion)fail("CONFLICT","来源任务版本已变化");
  db.prepare("INSERT INTO result_decisions VALUES(?,?,?,?,?)").run(resultId,decisionId,canonical(decision),digest(decision),at());event(db,resultId,"rejected",{decision_digest:digest(decision)});return resultState(db,resultId);
 });
}
export function peerResultStatus(db,peer,{result_id,project_id}){
 const r=row(db,result_id),body=JSON.parse(r.body_json);grant(db,body.relation,peer,"target");if(r.side!=="source"||r.project_id!==project_id)fail("NOT_FOUND","授权范围内未找到交付",404);
 const decision=db.prepare("SELECT decision_json FROM result_decisions WHERE result_id=?").get(result_id);return {receipt:receipt(r),decision:decision?JSON.parse(decision.decision_json):null};
}
export function recordResultDecision(db,{resultId,decision:d}){return unit(db,()=>{
 const r=row(db,resultId),body=JSON.parse(r.body_json);if(r.side!=="target")fail("FORBIDDEN","仅执行端应用来源返工决定",403);
 exact(d,["schema_version","kind","result_id","relation_id","body_digest","decision_id","source_task_version","note","source_node_id","source_epoch","target_node_id","target_epoch"]);uuid(d.decision_id,"decision_id");version(d.source_task_version);
 if(d.schema_version!==1||d.kind!=="result_rejected"||d.result_id!==resultId||d.relation_id!==r.relation_id||d.body_digest!==r.body_digest||["source_node_id","source_epoch","target_node_id","target_epoch"].some(k=>d[k]!==body.relation[k])||!text(d.note,4096)||!d.note.trim())fail("RECEIPT_MISMATCH","来源决定不匹配候选内容");
 const old=db.prepare("SELECT decision_json FROM result_decisions WHERE result_id=?").get(resultId);if(old){if(old.decision_json!==canonical(d))fail("REQUEST_CONFLICT","来源决定不能替换");return resultState(db,resultId);}
 if(!db.prepare("SELECT 1 FROM result_receipts WHERE result_id=?").get(resultId))fail("RECEIPT_REQUIRED","先记录来源已收到交付");
 const t=db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(r.task_uid);if(!t||t.aggregate_version!==r.task_version||t.run_id!==r.run_id||t.status!==body.target_status)fail("CONFLICT","封存交付版本已变化");
 db.prepare("INSERT INTO result_decisions VALUES(?,?,?,?,?)").run(resultId,d.decision_id,canonical(d),digest(d),at());
 const cancelled=cancel.held(db,t.id);
 if(!cancelled)store.resolve(db,{id:t.id,verdict:"reject",note:d.note,resolvedBy:"federation",disposition:"hand_back",expectedVersion:r.task_version,prepareResolution:()=>{
  if(t.status==="done")db.prepare("UPDATE tasks SET status='waiting',waiting_for='review' WHERE id=?").run(t.id);
  return {};
 }});
 event(db,resultId,"rejection_recorded",{decision_digest:digest(d),rework_applied:!cancelled});return resultState(db,resultId);
});}
