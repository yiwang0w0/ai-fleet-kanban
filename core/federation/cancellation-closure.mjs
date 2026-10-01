import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {PeerError,version} from "./protocol.mjs";
import {transaction} from "./peers.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {migrateCancellations,cancellationState,cancellationWork} from "./cancellation.mjs";
import {bindingState,cancelBinding} from "./bindings.mjs";
import {normalizeCancellationClosure,checkCancellationRetirement} from "./cancellation-contract.mjs";
const store=createRequire(import.meta.url)("../store.js"),at=()=>new Date().toISOString();
const has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function unit(db,fn){if(!db.isTransaction)return transaction(db,fn);db.exec("SAVEPOINT cancellation_closure_unit");try{const r=fn();db.exec("RELEASE cancellation_closure_unit");return r;}catch(e){db.exec("ROLLBACK TO cancellation_closure_unit; RELEASE cancellation_closure_unit");throw e;}}
export function migrateCancellationClosure(db){return unit(db,()=>{
 migrateCancellations(db);db.exec("CREATE TABLE IF NOT EXISTS cancellation_closure_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO cancellation_closure_schema VALUES(1,1)");if(db.prepare("SELECT version FROM cancellation_closure_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","取消退役存储格式不兼容");
 db.exec([
  "CREATE TABLE IF NOT EXISTS cancellation_registrar_attempts(request_id TEXT PRIMARY KEY,relation_id TEXT NOT NULL,args_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','acknowledged','rejected')),receipt_json TEXT,error_code TEXT,created_at TEXT NOT NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS cancellation_one_attempt ON cancellation_registrar_attempts(relation_id) WHERE state='pending';",
  "CREATE TABLE IF NOT EXISTS cancellation_retirements(relation_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS cancellation_settlements(relation_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TRIGGER IF NOT EXISTS cancellation_attempt_identity BEFORE UPDATE OF request_id,relation_id,args_json,created_at ON cancellation_registrar_attempts BEGIN SELECT RAISE(ABORT,'cancellation request is immutable'); END;",
  "CREATE TRIGGER IF NOT EXISTS cancellation_attempt_terminal BEFORE UPDATE ON cancellation_registrar_attempts WHEN OLD.state<>'pending' BEGIN SELECT RAISE(ABORT,'cancellation request is terminal'); END;"
 ].join("\n"));
 for(const t of ["cancellation_retirements","cancellation_settlements"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'cancellation closure is immutable'); END");
 for(const t of ["cancellation_registrar_attempts","cancellation_retirements","cancellation_settlements"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'cancellation closure must be retained'); END");
});}
function document(db,table,id){if(!has(db,table))return null;const r=db.prepare("SELECT * FROM "+table+" WHERE relation_id=?").get(id);if(!r)return null;const d=JSON.parse(r.receipt_json);if(digest(d)!==r.receipt_digest)fail("CANCELLATION_CORRUPT","取消退役记录摘要改变");return d;}
export function cancellationClosureState(db,relationId){
 const s=cancellationState(db,relationId),retirement=document(db,"cancellation_retirements",relationId),settlement=document(db,"cancellation_settlements",relationId),attempts=has(db,"cancellation_registrar_attempts")?db.prepare("SELECT request_id,state,error_code FROM cancellation_registrar_attempts WHERE relation_id=? ORDER BY rowid").all(relationId).map(r=>({...r})):[];
 return {...s,closure_phase:settlement?"settled":retirement?"retired":attempts.length?"voting":s.stopped?"stopped":"awaiting_stop",retirement,settlement,attempts,accepted:false,dispatch_started:false};
}
function contract(db,relationId){
 const s=cancellationState(db,relationId),b=bindingState(db,relationId);if(!s.stopped)fail("STOP_UNCONFIRMED","先保存执行端停止证明");
 if(!["prepared","confirmed","cancelled"].includes(b.state)||b.side!==s.side)fail("CONTRACT_MISMATCH","取消本机绑定不匹配");
 if(has(db,"completion_plans")&&db.prepare("SELECT 1 FROM completion_plans WHERE relation_id=?").get(relationId))fail("COMPLETION_COMMITTED","已经固定完成意图");
 if(s.side==="target"){
  const work=cancellationWork(db,relationId);if(work.downstream.length)fail("DOWNSTREAM_PENDING","先结算取消范围内的下游绑定");
  const p=db.prepare("SELECT * FROM cancellation_proofs WHERE cancel_id=?").get(s.cancel_id);if(!p||p.proof_digest!==s.receipt.proof_digest||digest(JSON.parse(p.proof_json))!==p.proof_digest)fail("STOP_UNCONFIRMED","本机停止证明不匹配");
 }
 return normalizeCancellationClosure({schema_version:1,kind:"delegation_cancellation",request:s.request,stopped:s.receipt});
}
export function startCancellationRetirement(db,{relationId,expectedVersion,authorize=()=>{}}){return unit(db,()=>{
 authorize();const c=contract(db,relationId),s=cancellationClosureState(db,relationId);if(s.retirement)fail("ALREADY_RETIRED","取消关系已退役");
 const prior=db.prepare("SELECT * FROM cancellation_registrar_attempts WHERE relation_id=? AND state='pending'").get(relationId);if(prior)return JSON.parse(prior.args_json);version(expectedVersion);
 const args={request_id:randomUUID(),expected_version:expectedVersion,cancellation:c};db.prepare("INSERT INTO cancellation_registrar_attempts VALUES(?,?,?,'pending',NULL,NULL,?)").run(args.request_id,relationId,canonical(args),at());return args;
});}
export function rejectCancellationRetirement(db,{relationId,requestId,code,authorize=()=>{}}){if(code!=="GRAPH_VERSION_CONFLICT")fail("UNKNOWN_REMOTE_OUTCOME","不能证明原登记请求未生效");return unit(db,()=>{
 authorize();cancellationState(db,relationId);const a=db.prepare("SELECT * FROM cancellation_registrar_attempts WHERE relation_id=? AND request_id=?").get(relationId,requestId);if(!a)fail("NOT_FOUND","未找到取消登记请求",404);if(a.state==="rejected"&&a.error_code===code)return cancellationClosureState(db,relationId);if(a.state!=="pending")fail("REQUEST_CONFLICT","取消登记响应已固定");db.prepare("UPDATE cancellation_registrar_attempts SET state='rejected',error_code=? WHERE request_id=?").run(code,requestId);return cancellationClosureState(db,relationId);
});}
export function recordCancellationRetirement(db,{relationId,requestId=null,receipt:r,authorize=()=>{}}){return unit(db,()=>{
 authorize();const c=contract(db,relationId),d=c.request.relation,b=bindingState(db,relationId),pending=r?.kind==="relation_cancellation_pending";
 if(pending){const expected={schema_version:1,kind:"relation_cancellation_pending",relation_id:relationId,cancellation_digest:digest(c),graph_id:d.graph_id,graph_epoch:d.graph_epoch,graph_version:r.graph_version,approved_by:r.approved_by,cancelled:false,dispatch_ready:false};version(r.graph_version);if(!requestId||canonical(expected)!==canonical(r)||!Array.isArray(r.approved_by)||r.approved_by.length!==1||r.approved_by.some(n=>![d.source_node_id,d.target_node_id].includes(n)))fail("RECEIPT_MISMATCH","取消待登记回执不同");}
 else checkCancellationRetirement(r,c,{registrarNodeId:b.registrar_node_id,registrarEpoch:b.registrar_epoch});
 if(requestId){const a=db.prepare("SELECT * FROM cancellation_registrar_attempts WHERE relation_id=? AND request_id=?").get(relationId,requestId);if(!a)fail("NOT_FOUND","未找到取消登记请求",404);if(a.state!=="pending"){if(a.state!=="acknowledged"||a.receipt_json!==canonical(r))fail("REQUEST_CONFLICT","取消登记响应不同");}else db.prepare("UPDATE cancellation_registrar_attempts SET state='acknowledged',receipt_json=? WHERE request_id=?").run(canonical(r),requestId);}
 if(!pending){const old=document(db,"cancellation_retirements",relationId);if(old){if(canonical(old)!==canonical(r))fail("REQUEST_CONFLICT","取消退役回执不同");}else db.prepare("INSERT INTO cancellation_retirements VALUES(?,?,?,?)").run(relationId,canonical(r),digest(r),at());}return cancellationClosureState(db,relationId);
});}
/** Local owner decision with CAS; target remains cancelled and evidence stays intact. */
export function settleCancellation(db,{relationId,expectedTaskVersion,authorize=()=>{}}){version(expectedTaskVersion);return unit(db,()=>{
 authorize();const s=cancellationClosureState(db,relationId);if(s.settlement){if(s.settlement.expected_task_version!==expectedTaskVersion)fail("REQUEST_CONFLICT","取消结算已固定原任务版本");return s;}
 if(!s.retirement)fail("CANCELLATION_NOT_RETIRED","先取得双端取消登记回执");const c=contract(db,relationId),b=bindingState(db,relationId),t=db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(b.task_uid);if(!t||t.aggregate_version!==expectedTaskVersion)fail("CONFLICT","取消结算任务版本已变化");if(t.status==="in_progress"||db.prepare("SELECT 1 FROM task_runs WHERE task_id=? AND state='running'").get(t.id))fail("ACTIVE_WORK","取消结算仍有本机活动运行");
 checkCancellationRetirement(s.retirement,c,{registrarNodeId:b.registrar_node_id,registrarEpoch:b.registrar_epoch});
 if(b.side==="source"&&t.released)store.setReleased(db,{id:t.id,released:false,expectedVersion:expectedTaskVersion,actor:"cancellation:"+s.cancel_id});cancelBinding(db,{relationId,receipt:s.retirement});
 const after=store.get(db,t.id),receipt={schema_version:1,kind:"cancellation_settled",cancel_id:s.cancel_id,relation_id:relationId,side:b.side,retirement_digest:digest(s.retirement),task_uid:t.task_uid,expected_task_version:expectedTaskVersion,task_version:after.aggregate_version,accepted:false,dispatch_started:false,settled_at:at()};
 db.prepare("INSERT INTO cancellation_settlements VALUES(?,?,?,?)").run(relationId,canonical(receipt),digest(receipt),at());db.prepare("INSERT INTO cancellation_events(relation_id,kind,detail_json,created_at) VALUES(?,?,?,?)").run(relationId,"cancel_settled",canonical({receipt_digest:digest(receipt)}),at());return cancellationClosureState(db,relationId);
});}
