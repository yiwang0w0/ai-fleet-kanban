import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {basename,dirname,isAbsolute,relative,resolve,sep} from "node:path";
import {realpathSync,unlinkSync} from "node:fs";
import {atomic,canonical,digest} from "../federation/sync-store.mjs";
import {localIdentity} from "../federation/peers.mjs";
import {uuid,names,version} from "../federation/protocol.mjs";
import {exact,fail,getRole,issuePrincipal,migrateBroker} from "../mcp/policy.mjs";
import {chooseRole} from "../mcp/tools.mjs";
const require=createRequire(import.meta.url),store=require("../store.js");
const at=()=>new Date().toISOString();
const MODES=["fixture","provider"];
const table=db=>db.prepare("SELECT * FROM broker_dispatches WHERE dispatch_id=?");
function fresh(db,id){
 uuid(id,"dispatch_id");const node=localIdentity(db),d=table(db).get(id);
 if(!d)fail("NOT_FOUND","分派记录不存在",404);
 if(d.node_id!==node.node_id||d.node_epoch!==node.sync_epoch)fail("EPOCH_CHANGED","分派记录属于旧节点代次");
 return d;
}
export function migrateDispatch(db){
 return atomic(db,()=>{
  migrateBroker(db);
  db.exec([
   "CREATE TABLE IF NOT EXISTS broker_dispatch_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);",
   "INSERT OR IGNORE INTO broker_dispatch_schema VALUES(1,1);",
   "CREATE TABLE IF NOT EXISTS broker_call_quotas(quota_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,runtime TEXT NOT NULL,execution_mode TEXT NOT NULL,projects_json TEXT NOT NULL,limit_total INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS broker_dispatches(dispatch_id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL UNIQUE,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,task_id INTEGER NOT NULL,task_uid TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,agent_instance_id TEXT NOT NULL,worker TEXT NOT NULL,role_id TEXT NOT NULL,role_version INTEGER NOT NULL,policy_digest TEXT NOT NULL,quota_id TEXT NOT NULL,quota_version INTEGER NOT NULL,execution_mode TEXT NOT NULL,source_json TEXT NOT NULL,claimed_version INTEGER NOT NULL,principal_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN('prepared','launch_committed','settled','interrupted','abandoned')),reason TEXT,created_at TEXT NOT NULL,launch_at TEXT,finished_at TEXT,result_digest TEXT,result_json TEXT);",
   "CREATE INDEX IF NOT EXISTS broker_dispatch_quota ON broker_dispatches(quota_id,phase);",
   "CREATE TABLE IF NOT EXISTS broker_dispatch_events(id INTEGER PRIMARY KEY,dispatch_id TEXT,quota_id TEXT,kind TEXT NOT NULL,detail_json TEXT NOT NULL,at TEXT NOT NULL);",
   "CREATE TRIGGER IF NOT EXISTS broker_assignment_snapshot_immutable BEFORE UPDATE OF assignment_id,task_uid,task_version,project_id,role_id,role_version,policy_digest,policy_json,created_by,created_at ON broker_assignments BEGIN SELECT RAISE(ABORT,'assignment snapshot is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS broker_dispatch_identity_immutable BEFORE UPDATE OF dispatch_id,assignment_id,node_id,node_epoch,task_id,task_uid,run_id,agent_instance_id,worker,role_id,role_version,policy_digest,quota_id,quota_version,execution_mode,source_json,claimed_version,principal_id,created_at ON broker_dispatches BEGIN SELECT RAISE(ABORT,'dispatch identity is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS broker_dispatch_no_delete BEFORE DELETE ON broker_dispatches BEGIN SELECT RAISE(ABORT,'dispatch history is append-only'); END;",
   "CREATE TRIGGER IF NOT EXISTS broker_dispatch_run_ended AFTER UPDATE OF state ON task_runs WHEN NEW.state='ended' AND OLD.state='running' BEGIN UPDATE broker_assignments SET state='ended',reason='bound run ended' WHERE assignment_id IN(SELECT assignment_id FROM broker_dispatches WHERE run_id=NEW.run_id) AND state='claimed'; UPDATE broker_dispatches SET phase='interrupted',reason='run ended; awaiting executor receipt',finished_at=NEW.ended_at WHERE run_id=NEW.run_id AND phase IN('prepared','launch_committed'); END;"
  ].join("\n"));
  if(db.prepare("SELECT version FROM broker_dispatch_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","调度存储版本不兼容");
 });
}
function audit(db,{dispatchId=null,quotaId=null,kind,detail={}}){
 db.prepare("INSERT INTO broker_dispatch_events(dispatch_id,quota_id,kind,detail_json,at) VALUES(?,?,?,?,?)").run(dispatchId,quotaId,kind,canonical(detail),at());
}
function reserved(db,id){return db.prepare("SELECT count(*) n FROM broker_dispatches WHERE quota_id=? AND phase='prepared'").get(id).n;}
export function quotaStatus(db,id){
 uuid(id,"quota_id");
 const q=db.prepare("SELECT * FROM broker_call_quotas WHERE quota_id=?").get(id);
 return q?{...q,projects:JSON.parse(q.projects_json),reserved:reserved(db,id)}:null;
}
/** Local administration only. Never resets used calls, including failed/uncertain launches. */
export function putQuota(db,policy,expectedVersion){
 exact(policy,["quota_id","runtime","execution_mode","projects","limit_total","enabled"],"quota");
 uuid(policy.quota_id,"quota_id");const projects=names(policy.projects,"projects",null,1);
 if(!["claude","codex","zcode"].includes(policy.runtime)||!MODES.includes(policy.execution_mode)||typeof policy.enabled!=="boolean"||!Number.isSafeInteger(policy.limit_total)||policy.limit_total<0||policy.limit_total>1000000)fail("BAD_INPUT","调用预算配置无效",400);
 return atomic(db,()=>{
  const node=localIdentity(db),old=quotaStatus(db,policy.quota_id);
  if(old){
   version(expectedVersion);if(old.version!==expectedVersion)fail("CONFLICT","预算版本已变化");
   if(old.version>=Number.MAX_SAFE_INTEGER)fail("VERSION_EXHAUSTED","预算版本已达上限");
   if(old.node_id!==node.node_id||old.node_epoch!==node.sync_epoch)fail("EPOCH_CHANGED","旧代次预算不能直接续用");
   if(old.runtime!==policy.runtime||old.execution_mode!==policy.execution_mode)fail("CONFLICT","预算的运行时和执行类别不可改变");
   if(policy.limit_total<old.used+old.reserved)fail("BUDGET_RESERVED","新预算小于已消耗与已保留次数");
  }else if(expectedVersion!==undefined)fail("CONFLICT","预算尚未登记");
  const next=(old?.version??0)+1;
  db.prepare("INSERT INTO broker_call_quotas VALUES(?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(quota_id) DO UPDATE SET projects_json=excluded.projects_json,limit_total=excluded.limit_total,enabled=excluded.enabled,version=excluded.version,updated_at=excluded.updated_at")
   .run(policy.quota_id,node.node_id,node.sync_epoch,policy.runtime,policy.execution_mode,canonical(projects),policy.limit_total,Number(policy.enabled),next,at());
  audit(db,{quotaId:policy.quota_id,kind:"quota_policy",detail:{version:next,limit_total:policy.limit_total,enabled:policy.enabled}});
  return quotaStatus(db,policy.quota_id);
 });
}
function quotaFor(db,id,{node,runtime,project,mode,expectedVersion}){
 const q=quotaStatus(db,id);
 if(!q||q.node_id!==node.node_id||q.node_epoch!==node.sync_epoch||!q.enabled)fail("BUDGET_UNAVAILABLE","没有本节点当前代次的启用调用预算");
 if(q.runtime!==runtime||q.execution_mode!==mode||!q.projects.includes(project))fail("FORBIDDEN","预算不匹配运行时、项目或执行类别",403);
 if(expectedVersion!==undefined&&q.version!==expectedVersion)fail("POLICY_CHANGED","预算策略已变化，需重新安排");
 return q;
}
function creator(db,a,node){
 const p=db.prepare("SELECT * FROM broker_principals WHERE principal_id=?").get(a.created_by),role=p&&getRole(db,p.role_id);
 if(!p||p.status!=="active"||p.node_id!==node.node_id||p.node_epoch!==node.sync_epoch||!role?.policy.enabled||role.policy.kind!=="coordinate"||role.version!==p.role_version||!JSON.parse(p.projects_json).includes(a.project_id)||!role.policy.projects.includes(a.project_id))fail("AUTHORIZATION_CHANGED","原协调身份不再拥有该项目的分派权限",403);
}
function assignmentPolicy(db,a,t,node){
 creator(db,a,node);const role=getRole(db,a.role_id),chosen=chooseRole(db,t);
 if(!role?.policy.enabled||role.version!==a.role_version||role.policy_digest!==a.policy_digest||canonical(role.policy)!==a.policy_json||chosen?.role_id!==role.role_id)fail("POLICY_CHANGED","角色策略或确定性选择已变化");
 if(t.route!=="mcp"||t.line&&t.line!==role.role_id)fail("ROUTE_MISMATCH","任务路由或身份线不匹配");
 return role;
}
function task(db,uid){return db.prepare("SELECT t.*,p.project_id,p.work_kind,p.capabilities_json FROM tasks t JOIN broker_task_projects p ON t.id=p.task_id AND t.task_uid=p.task_uid WHERE t.task_uid=?").get(uid);}
function ancestorDigest(db,t){
 const parents=[];let id=t.parent_id;const seen=new Set();
 while(id!==null){
  if(seen.has(id)||seen.size>=32)fail("BAD_CHAIN","父任务链无效");seen.add(id);
  const p=db.prepare("SELECT id,parent_id,task_uid,subject,description,acceptance,status,released,last_note FROM tasks WHERE id=?").get(id);
  if(!p)fail("BAD_CHAIN","父任务不存在");parents.push(p);id=p.parent_id;
 }
 return digest(parents);
}
function credentialOutsideCode(file,codeRoot){
 if(typeof file!=="string"||!isAbsolute(file))fail("BAD_INPUT","执行凭据须使用绝对路径",400);
 const target=resolve(realpathSync(dirname(file)),basename(file)),rel=relative(codeRoot,target);
 if(!rel||!rel.startsWith(".."+sep)&&rel!==".."&&!isAbsolute(rel))fail("UNSAFE_CREDENTIAL_PATH","执行凭据必须放在治理仓之外",400);
}
export function dispatchStatus(db,id){
 const d=fresh(db,id),run=db.prepare("SELECT state,terminal_task_status FROM task_runs WHERE run_id=?").get(d.run_id);
 return {...d,source:JSON.parse(d.source_json),result:d.result_json?JSON.parse(d.result_json):null,run,
  launch_permit:false,real_model_call_confirmed:false};
}
/** Atomically reserves budget, claims through native gates and issues a run-bound MCP credential. Does not spawn. */
export function prepareDispatch(db,{assignmentId,quotaId,executionMode,credentialFile,sourceGate}){
 if(db.isTransaction)fail("TRANSACTION_CONTEXT","领取必须自行提交事务后才能交付运行凭据");
 uuid(assignmentId,"assignment_id");uuid(quotaId,"quota_id");
 if(!MODES.includes(executionMode)||typeof sourceGate?.check!=="function")fail("BAD_INPUT","需要显式执行类别和治理代码闸",400);
 let issued=false;
 try{return atomic(db,()=>{
  const node=localIdentity(db),source=sourceGate.check();credentialOutsideCode(credentialFile,source.code_root);
  const a=db.prepare("SELECT * FROM broker_assignments WHERE assignment_id=?").get(assignmentId);
  if(!a||a.state!=="waiting_executor")fail("NOT_READY","路由请求未处于等待执行器状态");
  const t=task(db,a.task_uid);
  if(!t||t.owner_node_id!==node.node_id||t.aggregate_version!==a.task_version)fail("CONFLICT","任务版本或所有者已变化");
  const role=assignmentPolicy(db,a,t,node),q=quotaFor(db,quotaId,{node,runtime:role.policy.runtime,project:a.project_id,mode:executionMode});
  if(q.used+q.reserved>=q.limit_total)fail("BUDGET_EXHAUSTED","调用预算已消耗或已被其他运行保留");
  if(t.attempts>=Math.min(t.max_attempts,role.policy.limits.max_task_attempts))fail("BUDGET_EXHAUSTED","任务已达到显式角色/任务尝试上限");
  const dispatchId=randomUUID(),agentInstanceId=randomUUID(),worker="mcp:"+role.role_id+":"+dispatchId;
  const claim=store.claimById(db,{id:t.id,worker,runtime:role.policy.runtime,agentInstanceId,expectedVersion:a.task_version,
   treeRev:source.tree,extra:{broker_role_digest:role.policy_digest,ancestor_context_digest:ancestorDigest(db,t)},
   runContext:{role_id:role.role_id,role_kind:role.policy.kind,tools:role.policy.tools,model:role.policy.model,effort:role.policy.effort,
    broker_role_version:role.version,broker_role_digest:role.policy_digest,dispatch_id:dispatchId,execution_mode:executionMode,
    source_tree:source.tree,ancestor_context_digest:ancestorDigest(db,t),enforcement:"board_tool_scope_only"}});
  if(!claim.ok)fail(claim.code??"CONFLICT",claim.why);
  const principal=issuePrincipal(db,{roleId:role.role_id,projects:[a.project_id],runId:claim.task.run_id,credentialFile});issued=true;
  db.prepare("INSERT INTO broker_dispatches(dispatch_id,assignment_id,node_id,node_epoch,task_id,task_uid,run_id,agent_instance_id,worker,role_id,role_version,policy_digest,quota_id,quota_version,execution_mode,source_json,claimed_version,principal_id,phase,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?)")
   .run(dispatchId,a.assignment_id,node.node_id,node.sync_epoch,t.id,t.task_uid,claim.task.run_id,agentInstanceId,worker,role.role_id,role.version,role.policy_digest,quotaId,q.version,executionMode,canonical(source),claim.task.aggregate_version,principal.principal_id,at());
  db.prepare("UPDATE broker_assignments SET state='claimed',reason='run claimed; executor not launched' WHERE assignment_id=?").run(assignmentId);
  audit(db,{dispatchId,quotaId,kind:"prepared",detail:{run_id:claim.task.run_id,execution_mode:executionMode}});
  return dispatchStatus(db,dispatchId);
 });}catch(e){if(issued){try{unlinkSync(credentialFile);}catch{}}throw e;}
}
/** Trusted runner only. A committed permit is never reissued or automatically refunded, even after a crash. */
export function authorizeLaunch(db,{dispatchId,sourceGate}){
 if(db.isTransaction)fail("TRANSACTION_CONTEXT","启动许可必须自行提交后才可交付");
 return atomic(db,()=>{
  const d=fresh(db,dispatchId);
  if(d.phase!=="prepared")fail("LAUNCH_NOT_AVAILABLE","启动许可已经消费或运行已结束；不能自动重启");
  const source=sourceGate.check();
  if(canonical(source)!==d.source_json)fail("SOURCE_CHANGED","领取后治理代码身份已变化");
  const node=localIdentity(db),t=task(db,d.task_uid),a=db.prepare("SELECT * FROM broker_assignments WHERE assignment_id=?").get(d.assignment_id);
  if(!t||t.run_id!==d.run_id||t.status!=="in_progress"||t.archived_at||t.aggregate_version!==d.claimed_version)fail("CONFLICT","领取后的任务或运行状态已变化");
  if(!t.released||t.human_gate||t.lease_until<=Date.now())fail("CONFLICT","任务未放行、被人工闸锁定或租约已过期");
  const deps=store.depsSatisfied(db,t);
  if(deps.broken||!deps.ok||store.unreleasedAncestor(db,t.parent_id)!==null||db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND archived_at IS NULL AND status<>'done' LIMIT 1").get(t.id))fail("CONFLICT","依赖、祖先放行或子任务已改变");
  if(t.lock_key&&db.prepare("SELECT 1 FROM tasks WHERE status='in_progress' AND lock_key=? AND id<>?").get(t.lock_key,t.id))fail("CONFLICT","任务锁冲突");
  const context=JSON.parse(db.prepare("SELECT policy_json FROM task_runs WHERE run_id=?").get(d.run_id).policy_json).context;
  if(context.ancestor_context_digest!==ancestorDigest(db,t))fail("CONTEXT_CHANGED","父任务上下文已变化");
  const role=assignmentPolicy(db,a,t,node),principal=db.prepare("SELECT status,role_version FROM broker_principals WHERE principal_id=?").get(d.principal_id);
  if(!principal||principal.status!=="active"||principal.role_version!==role.version)fail("AUTHORIZATION_CHANGED","运行凭据已撤销或失效",403);
  const q=quotaFor(db,d.quota_id,{node,runtime:role.policy.runtime,project:a.project_id,mode:d.execution_mode,expectedVersion:d.quota_version});
  if(q.used>=q.limit_total)fail("BUDGET_EXHAUSTED","调用预算已耗尽");
  db.prepare("UPDATE broker_call_quotas SET used=used+1 WHERE quota_id=?").run(d.quota_id);
  db.prepare("UPDATE broker_dispatches SET phase='launch_committed',launch_at=?,reason='single-use launch permit committed; process result not yet known' WHERE dispatch_id=?").run(at(),dispatchId);
  audit(db,{dispatchId,quotaId:d.quota_id,kind:"launch_committed",detail:{execution_mode:d.execution_mode}});
  return {...dispatchStatus(db,dispatchId),launch_permit:true};
 });
}
function revokeRunPrincipals(db,runId){
 const rows=db.prepare("SELECT principal_id,role_id,version FROM broker_principals WHERE run_id=? AND status='active'").all(runId);
 for(const p of rows){
  db.prepare("UPDATE broker_principals SET status='revoked',secret_hash='',version=version+1 WHERE principal_id=?").run(p.principal_id);
  db.prepare("INSERT INTO broker_auth_events(principal_id,role_id,action,version,at) VALUES(?,?,'dispatch_abandoned',?,?)").run(p.principal_id,p.role_id,p.version+1,at());
 }
}
export function abandonPrepared(db,{dispatchId,reason}){
 if(typeof reason!=="string"||!reason.trim()||reason.length>1000)fail("BAD_INPUT","需要简短放弃原因",400);
 return atomic(db,()=>{
  const d=fresh(db,dispatchId);if(d.phase!=="prepared")fail("CONFLICT","仅能直接放弃尚未消费启动许可的运行");
  const t=task(db,d.task_uid);
  if(t?.run_id===d.run_id&&t.status==="in_progress")store.report(db,{id:t.id,worker:d.worker,runId:d.run_id,outcome:"wait",evidence:"执行器未启动："+reason});
  revokeRunPrincipals(db,d.run_id);
  db.prepare("UPDATE broker_dispatches SET phase='abandoned',reason=?,finished_at=? WHERE dispatch_id=?").run(reason,at(),dispatchId);
  db.prepare("UPDATE broker_assignments SET state='ended',reason='prepared dispatch abandoned' WHERE assignment_id=?").run(d.assignment_id);
  audit(db,{dispatchId,quotaId:d.quota_id,kind:"abandoned",detail:{reason}});
  return dispatchStatus(db,dispatchId);
 });
}
function processResult(input){
 exact(input,["status","evidence","usage"],"process_result");
 if(!["success","failed","cancelled","timeout"].includes(input.status)||typeof input.evidence!=="string"||input.evidence.length>65536||input.status==="success"&&!input.evidence.trim())fail("BAD_INPUT","执行回执内容无效",400);
 if(input.usage!==null){
  exact(input.usage,["input_tokens","output_tokens"],"usage");
  for(const n of Object.values(input.usage))if(!Number.isSafeInteger(n)||n<0)fail("BAD_INPUT","用量必须是已观测的非负整数；未知用 null",400);
 }
 return input;
}
/** Records an observed process outcome. Late results are retained but never overwrite a replacement run. */
export function finishDispatch(db,{dispatchId,result}){
 result=processResult(result);const resultDigest=digest(result);
 return atomic(db,()=>{
  const d=fresh(db,dispatchId);
  if(d.result_digest){if(d.result_digest!==resultDigest)fail("RESULT_CONFLICT","同一运行不能提交不同终态回执");return dispatchStatus(db,dispatchId);}
  if(!d.launch_at)fail("LAUNCH_NOT_AVAILABLE","尚未消费启动许可，不能记录执行成功");
  const t=task(db,d.task_uid);let delivery="stale_run_retained";
  if(t?.run_id===d.run_id&&t.status==="in_progress"&&!t.archived_at){
   store.report(db,{id:t.id,worker:d.worker,runId:d.run_id,outcome:result.status==="success"?"done":"wait",
    evidence:(d.execution_mode==="fixture"?"[fixture; no real model call]\n":"")+result.evidence});delivery="reported";
  }else if(t?.run_id===d.run_id&&t.status==="waiting"&&!t.archived_at){
   const reported=db.prepare("SELECT 1 FROM broker_requests r JOIN broker_principals p ON r.principal_id=p.principal_id WHERE p.run_id=? AND r.tool_name='report_result' LIMIT 1").get(d.run_id);
   if(reported)delivery="existing_mcp_report_preserved";
  }
  const receipt={...result,delivery,accepted:false,execution_mode:d.execution_mode,real_model_call_confirmed:false};
  db.prepare("UPDATE broker_dispatches SET phase='settled',reason=?,finished_at=?,result_digest=?,result_json=? WHERE dispatch_id=?").run(delivery,at(),resultDigest,canonical(receipt),dispatchId);
  db.prepare("UPDATE broker_assignments SET state='ended',reason=? WHERE assignment_id=?").run(delivery,d.assignment_id);
  audit(db,{dispatchId,quotaId:d.quota_id,kind:"settled",detail:{status:result.status,delivery}});
  return dispatchStatus(db,dispatchId);
 });
}
