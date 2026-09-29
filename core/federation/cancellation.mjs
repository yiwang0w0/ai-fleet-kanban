import {inspectStoppedRuns} from "../execution/stop-proof.mjs";
import {createRequire} from "node:module";
import {PeerError,keys,uuid,version,names} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {migrateBindings,bindingState} from "./bindings.mjs";
import {normalizeRelation} from "./relations.mjs";
const require=createRequire(import.meta.url),store=require("../store.js"),guard=require("../cancellation_guard.js");
const at=()=>new Date().toISOString(),exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t);
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(x,fields){keys(x,fields,"cancellation");if(Object.keys(x).length!==fields.length)fail("BAD_INPUT","取消消息字段缺失",400);}
function unit(db,fn){if(!db.isTransaction)return transaction(db,fn);db.exec("SAVEPOINT cancellation_unit");try{const r=fn();db.exec("RELEASE cancellation_unit");return r;}catch(e){db.exec("ROLLBACK TO cancellation_unit; RELEASE cancellation_unit");throw e;}}
const reasons=["operator_cancelled","upstream_cancelled","deadline_exceeded"];
export function migrateCancellations(db){return unit(db,()=>{
 migrateBindings(db);
 db.exec("CREATE TABLE IF NOT EXISTS cancellation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO cancellation_schema VALUES(1,1)");
 if(db.prepare("SELECT version FROM cancellation_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","取消存储版本不兼容");
 db.exec([
 "CREATE TABLE IF NOT EXISTS delegation_cancellations(relation_id TEXT PRIMARY KEY,cancel_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN('source','target')),node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,request_json TEXT NOT NULL,request_digest TEXT NOT NULL,expected_task_version INTEGER,state TEXT NOT NULL CHECK(state IN('pending','received','stopped')),received_json TEXT,stopped_json TEXT,scope_digest TEXT,created_at TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS cancellation_members(cancel_id TEXT NOT NULL,task_id INTEGER NOT NULL,task_uid TEXT NOT NULL,PRIMARY KEY(cancel_id,task_id));",
 "CREATE INDEX IF NOT EXISTS cancellation_member_task ON cancellation_members(task_id);",
 "CREATE TABLE IF NOT EXISTS cancellation_proofs(cancel_id TEXT PRIMARY KEY,proof_json TEXT NOT NULL,proof_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS cancellation_events(id INTEGER PRIMARY KEY,relation_id TEXT NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TRIGGER IF NOT EXISTS cancellation_identity BEFORE UPDATE OF relation_id,cancel_id,project_id,side,node_id,node_epoch,request_json,request_digest,expected_task_version,scope_digest,created_at ON delegation_cancellations BEGIN SELECT RAISE(ABORT,'cancellation identity is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS cancellation_terminal BEFORE UPDATE ON delegation_cancellations WHEN OLD.state='stopped' BEGIN SELECT RAISE(ABORT,'stopped receipt is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS cancellation_task_hold BEFORE UPDATE OF released,status ON tasks WHEN (NEW.released=1 AND OLD.released<>1 OR NEW.status IN('in_progress','done') AND NEW.status<>OLD.status) AND "+guard.heldSQL("OLD.id")+" BEGIN SELECT RAISE(ABORT,'CANCELLATION_PENDING: work cannot restart or be accepted'); END;",
 "CREATE TRIGGER IF NOT EXISTS cancellation_child_hold BEFORE INSERT ON tasks WHEN "+guard.heldSQL("NEW.parent_id")+" BEGIN SELECT RAISE(ABORT,'CANCELLATION_PENDING: cancelled subtree cannot grow'); END;",
 "CREATE TRIGGER IF NOT EXISTS cancellation_binding_hold BEFORE INSERT ON delegation_bindings WHEN NEW.side='source' AND "+guard.heldSQL("NEW.task_id")+" BEGIN SELECT RAISE(ABORT,'CANCELLATION_PENDING: cancelled subtree cannot delegate new work'); END;",
 "CREATE TRIGGER IF NOT EXISTS cancellation_member_retention BEFORE DELETE ON tasks WHEN "+guard.heldSQL("OLD.id")+" BEGIN SELECT RAISE(ABORT,'cancelled task identity must be retained'); END;",
 "CREATE TRIGGER IF NOT EXISTS cancellation_topology_hold BEFORE INSERT ON topology_operations WHEN EXISTS(SELECT 1 FROM json_each(NEW.desired_json,'$.vertices') v JOIN json_each(NEW.before_json,'$.vertices') b ON json_extract(b.value,'$.task_uid')=json_extract(v.value,'$.task_uid') WHERE json_extract(v.value,'$.parent_uid') IS NOT json_extract(b.value,'$.parent_uid') AND EXISTS(SELECT 1 FROM cancellation_members m WHERE m.task_uid IN(json_extract(v.value,'$.task_uid'),json_extract(v.value,'$.parent_uid'),json_extract(b.value,'$.parent_uid')))) BEGIN SELECT RAISE(ABORT,'CANCELLATION_PENDING: frozen cancellation scope cannot be reparented'); END;"
 ].join("\n"));
 for(const t of ["cancellation_members","cancellation_proofs","cancellation_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'cancellation history is immutable'); END");
 for(const t of ["delegation_cancellations","cancellation_members","cancellation_proofs","cancellation_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'cancellation history must be retained'); END");
 if(exists(db,"broker_dispatches"))db.exec("CREATE TRIGGER IF NOT EXISTS cancellation_launch_hold BEFORE UPDATE OF launch_at ON broker_dispatches WHEN NEW.launch_at IS NOT NULL AND OLD.launch_at IS NULL AND "+guard.heldSQL("NEW.task_id")+" BEGIN SELECT RAISE(ABORT,'CANCELLATION_PENDING: launch refused'); END");
});}
function event(db,relation,kind,detail){db.prepare("INSERT INTO cancellation_events(relation_id,kind,detail_json,created_at) VALUES(?,?,?,?)").run(relation,kind,canonical(detail),at());}
function row(db,relation){uuid(relation,"relation_id");const c=db.prepare("SELECT * FROM delegation_cancellations WHERE relation_id=?").get(relation);if(!c)fail("NOT_FOUND","未找到取消记录",404);const n=localIdentity(db);if(n.node_id!==c.node_id||n.sync_epoch!==c.node_epoch)fail("CANCELLATION_RECOVERY_REQUIRED","旧代次取消不能继续");return c;}
function targetGrant(db,d,peer){
 const n=localIdentity(db),p=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(d.source_node_id);
 if(n.node_id!==d.target_node_id||n.sync_epoch!==d.target_epoch)fail("IDENTITY_MISMATCH","取消目标身份不匹配");
 if(!p||p.status!=="active"||p.peer_epoch!==d.source_epoch||!JSON.parse(p.projects_json).includes(d.project_id)||!["delegation:offer","delegation:control"].every(s=>JSON.parse(p.scopes_json).includes(s))||peer.peer_node_id!==p.peer_node_id||peer.peer_epoch!==p.peer_epoch||peer.credential_version!==p.credential_version||!peer.projects.includes(d.project_id)||!peer.scopes.includes("delegation:control"))fail("FORBIDDEN","来源取消授权无效",403);
 if(db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(d.source_node_id,d.source_epoch))fail("RETIRED_EPOCH","来源代次已退役",403);
}
function message(body){exact(body,["schema_version","kind","cancel_id","relation","reason_code"]);uuid(body.cancel_id,"cancel_id");const d=normalizeRelation(body.relation);if(body.schema_version!==1||body.kind!=="cancel_delegation"||!reasons.includes(body.reason_code))fail("BAD_INPUT","取消消息无效",400);return d;}
export function listCancellations(db,{projectId,limit=100}){
 names([projectId],"project",null,1);if(!Number.isInteger(limit)||limit<1||limit>100)fail("BAD_INPUT","取消列表上限无效",400);
 const n=localIdentity(db);return {cancellations:db.prepare("SELECT relation_id,cancel_id,side,state,node_id=? AND node_epoch=? identity_current FROM delegation_cancellations WHERE project_id=? ORDER BY rowid DESC LIMIT ?").all(n.node_id,n.sync_epoch,projectId,limit)};
}
export function cancellationState(db,relationId){const c=row(db,relationId);return {relation_id:c.relation_id,cancel_id:c.cancel_id,project_id:c.project_id,side:c.side,state:c.state,stopped:c.state==="stopped",request:JSON.parse(c.request_json),receipt:c.stopped_json?JSON.parse(c.stopped_json):c.received_json?JSON.parse(c.received_json):null,dispatch_started:false};}
export function prepareCancellation(db,{relationId,cancelId,expectedTaskVersion,reasonCode="operator_cancelled"}){
 uuid(cancelId,"cancel_id");version(expectedTaskVersion);if(!reasons.includes(reasonCode))fail("BAD_INPUT","取消原因无效",400);
 return unit(db,()=>{const b=bindingState(db,relationId);if(b.side!=="source"||b.state!=="confirmed")fail("CONFIRMATION_REQUIRED","已确认的来源委派才能请求执行取消");
  const prior=db.prepare("SELECT * FROM delegation_cancellations WHERE relation_id=?").get(relationId);if(prior){row(db,relationId);if(prior.cancel_id!==cancelId||prior.expected_task_version!==expectedTaskVersion||JSON.parse(prior.request_json).reason_code!==reasonCode)fail("REQUEST_CONFLICT","取消请求已固定");return cancellationState(db,relationId);}
  const n=localIdentity(db),t=db.prepare("SELECT aggregate_version FROM tasks WHERE task_uid=?").get(b.task_uid);if(!t||t.aggregate_version!==expectedTaskVersion)fail("CONFLICT","来源任务版本已变化");
  const body={schema_version:1,kind:"cancel_delegation",cancel_id:cancelId,relation:b.relation,reason_code:reasonCode};
  db.prepare("INSERT INTO delegation_cancellations VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,?)").run(relationId,cancelId,b.project_id,"source",n.node_id,n.sync_epoch,canonical(body),digest(body),expectedTaskVersion,at());event(db,relationId,"cancel_requested",{cancel_id:cancelId});return cancellationState(db,relationId);
 });
}
function scope(db,d){
 const tasks=db.prepare("SELECT t.id,t.task_uid,t.parent_id,p.project_id FROM tasks t LEFT JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid").all(),uids=new Map(tasks.map(t=>[t.id,t.task_uid]));
 const graphs=[tasks.map(t=>({task_uid:t.task_uid,parent_uid:uids.get(t.parent_id)||null}))];
 for(const o of db.prepare("SELECT before_json,desired_json FROM topology_operations WHERE project_id=? AND state='prepared'").all(d.project_id))graphs.push(JSON.parse(o.before_json).vertices,JSON.parse(o.desired_json).vertices);
 const selected=new Set([d.target_task_uid]);
 for(const graph of graphs){const children=new Map();for(const v of graph){if(!children.has(v.parent_uid))children.set(v.parent_uid,[]);children.get(v.parent_uid).push(v.task_uid);}const seen=new Set(),queue=[d.target_task_uid];for(let i=0;i<queue.length;i++){const uid=queue[i];if(seen.has(uid))continue;seen.add(uid);selected.add(uid);queue.push(...(children.get(uid)||[]));if(seen.size>10000)fail("SCOPE_LIMIT","取消子树超过上限");}}
 if(selected.size>10000)fail("SCOPE_LIMIT","取消子树超过上限");
 const result=tasks.filter(t=>selected.has(t.task_uid));if(result.length!==selected.size||result.some(t=>t.project_id!==d.project_id))fail("PROJECT_BOUNDARY","取消子树含未登记或跨项目任务");return result.sort((a,b)=>a.task_uid.localeCompare(b.task_uid));
}
function receipt(c,kind,extra={}){const d=JSON.parse(c.request_json).relation;return {schema_version:1,kind,cancel_id:c.cancel_id,relation_id:c.relation_id,request_digest:c.request_digest,source_node_id:d.source_node_id,source_epoch:d.source_epoch,target_node_id:d.target_node_id,target_epoch:d.target_epoch,stopped:kind==="cancel_stopped",...extra};}
export function receiveCancellation(db,peer,body){const d=message(body);return unit(db,()=>{
 targetGrant(db,d,peer);const b=bindingState(db,d.relation_id);if(b.side!=="target"||!["prepared","confirmed"].includes(b.state)||canonical(b.relation)!==canonical(d))fail("CONTRACT_MISMATCH","取消不属于本方实际委派绑定");
 const prior=db.prepare("SELECT * FROM delegation_cancellations WHERE relation_id=? OR cancel_id=?").get(d.relation_id,body.cancel_id);if(prior){if(prior.request_digest!==digest(body))fail("REQUEST_CONFLICT","取消请求内容改变");const c=row(db,d.relation_id);return JSON.parse(c.stopped_json||c.received_json);}
 const n=localIdentity(db),members=scope(db,d),scopeDigest=digest(members.map(t=>t.task_uid));
 db.prepare("INSERT INTO delegation_cancellations VALUES(?,?,?,?,?,?,?,?,NULL,'received',NULL,NULL,?,?)").run(d.relation_id,body.cancel_id,d.project_id,"target",n.node_id,n.sync_epoch,canonical(body),digest(body),scopeDigest,at());
 for(const t of members)db.prepare("INSERT INTO cancellation_members VALUES(?,?,?)").run(body.cancel_id,t.id,t.task_uid);
 const c=row(db,d.relation_id),ack=receipt(c,"cancel_received");db.prepare("UPDATE delegation_cancellations SET received_json=? WHERE relation_id=?").run(canonical(ack),d.relation_id);event(db,d.relation_id,"cancel_received",{cancel_id:body.cancel_id,members:members.length,scope_digest:scopeDigest});return ack;
});}
export function peerCancellationState(db,peer,{relation_id,project_id,cancel_id}){const c=row(db,relation_id),body=JSON.parse(c.request_json);targetGrant(db,body.relation,peer);if(c.side!=="target"||c.project_id!==project_id||c.cancel_id!==cancel_id)fail("NOT_FOUND","授权范围内未找到取消记录",404);return JSON.parse(c.stopped_json||c.received_json);}
export function recordCancellationReceipt(db,{relationId,receipt:r}){return unit(db,()=>{
 const c=row(db,relationId);if(c.side!=="source")fail("FORBIDDEN","仅来源记录远端停止回执",403);
 const fields=["schema_version","kind","cancel_id","relation_id","request_digest","source_node_id","source_epoch","target_node_id","target_epoch","stopped"];
 const stopped=r?.kind==="cancel_stopped";exact(r,stopped?[...fields,"scope_digest","member_count","run_count","downstream_count","proof_digest","fixture_runs"]:fields);
 const expected=receipt(c,stopped?"cancel_stopped":"cancel_received");if(fields.some(k=>r[k]!==expected[k]))fail("RECEIPT_MISMATCH","取消回执身份或请求摘要不匹配");
 if(stopped){for(const k of ["scope_digest","proof_digest"])if(typeof r[k]!=="string"||!/^[0-9a-f]{64}$/.test(r[k]))fail("RECEIPT_MISMATCH","停止证明摘要无效");for(const k of ["member_count","run_count","downstream_count","fixture_runs"])if(!Number.isSafeInteger(r[k])||r[k]<(k==="member_count"?1:0)||r[k]>100000)fail("RECEIPT_MISMATCH","停止证明范围无效");if(r.fixture_runs>r.run_count)fail("RECEIPT_MISMATCH","夹具运行计数无效");}
 if(c.state==="stopped"){if(stopped&&c.stopped_json!==canonical(r))fail("RECEIPT_MISMATCH","停止证明不能替换");return cancellationState(db,relationId);}
 if(stopped)db.prepare("UPDATE delegation_cancellations SET state='stopped',stopped_json=? WHERE relation_id=?").run(canonical(r),relationId);
 else if(c.state==="pending")db.prepare("UPDATE delegation_cancellations SET state='received',received_json=? WHERE relation_id=?").run(canonical(r),relationId);
 else if(c.received_json!==canonical(r))fail("RECEIPT_MISMATCH","接收回执不同");else return cancellationState(db,relationId);
 event(db,relationId,r.kind,{receipt_digest:digest(r)});return cancellationState(db,relationId);
});}
export function cancellationWork(db,relationId){
 const c=row(db,relationId);if(c.side!=="target")fail("FORBIDDEN","仅接收端检查本机取消范围",403);
 const members=db.prepare("SELECT task_id,task_uid FROM cancellation_members WHERE cancel_id=? ORDER BY task_uid").all(c.cancel_id);
 const runs=db.prepare("SELECT r.* FROM task_runs r JOIN cancellation_members m ON r.task_id=m.task_id AND r.task_uid=m.task_uid WHERE m.cancel_id=? ORDER BY r.run_id LIMIT 100001").all(c.cancel_id);if(runs.length>100000)fail("SCOPE_LIMIT","运行历史超过本次检查上限");
 const downstream=db.prepare("SELECT b.relation_id,b.task_id,b.task_uid,b.state FROM delegation_bindings b JOIN cancellation_members m ON b.task_id=m.task_id AND b.task_uid=m.task_uid WHERE m.cancel_id=? AND b.side='source' AND b.state IN('prepared','confirmed') ORDER BY b.relation_id").all(c.cancel_id);
 return {c,members,runs,downstream};
}
export function confirmCancellationStopped(db,relationId){return unit(db,()=>{
 const {c,members,runs,downstream}=cancellationWork(db,relationId);if(c.state==="stopped")return {receipt:JSON.parse(c.stopped_json),blockers:[]};
 const {blockers,proofs,fixtureRuns}=inspectStoppedRuns(db,{nodeId:c.node_id,nodeEpoch:c.node_epoch,members,runs}),downproofs=[];
 for(const b of downstream){const child=db.prepare("SELECT state,stopped_json,node_id,node_epoch FROM delegation_cancellations WHERE relation_id=? AND side='source'").get(b.relation_id);if(b.state==="prepared"||child?.state!=="stopped"||child.node_id!==c.node_id||child.node_epoch!==c.node_epoch)blockers.push({kind:"downstream_pending",relation_id:b.relation_id});else downproofs.push({relation_id:b.relation_id,receipt_digest:digest(JSON.parse(child.stopped_json))});}
 if(blockers.length)return {receipt:JSON.parse(c.received_json),blockers:blockers.slice(0,100),blocker_count:blockers.length};
 const proof={cancel_id:c.cancel_id,scope_digest:c.scope_digest,member_uids:members.map(t=>t.task_uid),runs:proofs,downstream:downproofs};
 const ack=receipt(c,"cancel_stopped",{scope_digest:c.scope_digest,member_count:members.length,run_count:runs.length,downstream_count:downstream.length,proof_digest:digest(proof),fixture_runs:fixtureRuns});
 db.prepare("INSERT INTO cancellation_proofs VALUES(?,?,?,?)").run(c.cancel_id,canonical(proof),digest(proof),at());db.prepare("UPDATE delegation_cancellations SET state='stopped',stopped_json=? WHERE relation_id=?").run(canonical(ack),relationId);event(db,relationId,"stop_confirmed",{proof_digest:digest(proof)});return {receipt:ack,blockers:[]};
});}
