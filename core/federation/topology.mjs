import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {PeerError,keys,uuid,names,version} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {migrateBroker} from "../mcp/policy.mjs";
import {normalizeTopology,validateCombinedGraph,previewTopology,MAX_GRAPH_VERTICES} from "./relations.mjs";
const require=createRequire(import.meta.url),store=require("../store.js");
const at=()=>new Date().toISOString();
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
const project=x=>names([x],"project_id",null,1)[0];
function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
function unit(db,work){if(!db.isTransaction)return transaction(db,work);db.exec("SAVEPOINT topology_unit");try{const r=work();db.exec("RELEASE topology_unit");return r;}catch(e){db.exec("ROLLBACK TO topology_unit; RELEASE topology_unit");throw e;}}
const owns=id=>"EXISTS(SELECT 1 FROM broker_task_projects p JOIN topology_bindings b USING(project_id) WHERE p.task_id="+id+")";
const touches=prefix=>"("+owns(prefix+".parent_id")+" OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid("+prefix+".blocked_by) THEN "+prefix+".blocked_by ELSE '[]' END) d JOIN broker_task_projects p ON p.task_id=d.value JOIN topology_bindings b USING(project_id)))";
const titleKey=value=>"lower(replace(replace("+value+", ' ', ''), '　', ''))";
function reservedSibling(column){return "EXISTS(SELECT 1 FROM topology_operations o JOIN json_each(o."+column+", '$.vertices') v JOIN json_each(o."+column+", '$.vertices') sibling JOIN tasks t ON t.task_uid=json_extract(sibling.value, '$.task_uid') WHERE o.state='prepared' AND json_extract(v.value, '$.task_uid')=OLD.task_uid AND json_extract(v.value, '$.parent_uid') IS NOT NULL AND json_extract(v.value, '$.parent_uid')=json_extract(sibling.value, '$.parent_uid') AND t.id<>OLD.id AND t.archived_at IS NULL AND "+titleKey("t.subject")+"="+titleKey("NEW.subject")+")";}
export function migrateTopology(db){return unit(db,()=>{
 localIdentity(db);migrateBroker(db);
 db.exec("CREATE TABLE IF NOT EXISTS topology_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO topology_schema VALUES(1,1)");
 if(db.prepare("SELECT version FROM topology_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","本地关系提交存储格式不兼容");
 db.exec([
 "CREATE TABLE IF NOT EXISTS topology_bindings(project_id TEXT PRIMARY KEY,graph_id TEXT NOT NULL,graph_epoch TEXT NOT NULL,registrar_node_id TEXT NOT NULL,registrar_epoch TEXT NOT NULL,owner_node_id TEXT NOT NULL,owner_epoch TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL CHECK(phase IN('unregistered','ready','pending')),snapshot_json TEXT,receipt_json TEXT,created_at TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS topology_operations(operation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,owner_epoch TEXT NOT NULL,base_revision INTEGER NOT NULL,args_digest TEXT NOT NULL,before_json TEXT NOT NULL,intersection_json TEXT NOT NULL,desired_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('prepared','applied','cancelled')),receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
 "CREATE UNIQUE INDEX IF NOT EXISTS topology_one_prepared ON topology_operations(project_id) WHERE state='prepared';",
 "CREATE TABLE IF NOT EXISTS topology_attempts(request_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,expected_version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','acknowledged','rejected')),receipt_json TEXT,error_code TEXT,created_at TEXT NOT NULL);",
 "CREATE UNIQUE INDEX IF NOT EXISTS topology_one_pending_attempt ON topology_attempts(operation_id) WHERE state='pending';",
 "CREATE TABLE IF NOT EXISTS topology_vertices(task_id INTEGER PRIMARY KEY,task_uid TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS topology_holds(operation_id TEXT NOT NULL,task_id INTEGER NOT NULL,block_finish INTEGER NOT NULL CHECK(block_finish IN(0,1)),PRIMARY KEY(operation_id,task_id));",
 "CREATE TABLE IF NOT EXISTS topology_write_permits(task_id INTEGER PRIMARY KEY,parent_id INTEGER,blocked_by TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS topology_events(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,operation_id TEXT,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TRIGGER IF NOT EXISTS topology_binding_identity BEFORE UPDATE OF project_id,graph_id,graph_epoch,registrar_node_id,registrar_epoch,owner_node_id,owner_epoch,created_at ON topology_bindings BEGIN SELECT RAISE(ABORT,'topology binding identity is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_operation_identity BEFORE UPDATE OF operation_id,project_id,owner_epoch,base_revision,args_digest,before_json,intersection_json,desired_json,created_at ON topology_operations BEGIN SELECT RAISE(ABORT,'topology operation is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_operation_terminal BEFORE UPDATE ON topology_operations WHEN OLD.state<>'prepared' BEGIN SELECT RAISE(ABORT,'topology operation is terminal'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_attempt_identity BEFORE UPDATE OF request_id,operation_id,expected_version,created_at ON topology_attempts BEGIN SELECT RAISE(ABORT,'topology request identity is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_attempt_terminal BEFORE UPDATE ON topology_attempts WHEN OLD.state<>'pending' BEGIN SELECT RAISE(ABORT,'topology request is terminal'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_structure_update BEFORE UPDATE OF parent_id,blocked_by,kind ON tasks WHEN (NEW.parent_id IS NOT OLD.parent_id OR NEW.blocked_by IS NOT OLD.blocked_by OR NEW.kind IS NOT OLD.kind) AND ("+owns("OLD.id")+" OR "+touches("NEW")+") AND NOT EXISTS(SELECT 1 FROM topology_write_permits w WHERE w.task_id=OLD.id AND w.parent_id IS NEW.parent_id AND w.blocked_by=NEW.blocked_by AND NEW.kind=OLD.kind) BEGIN SELECT RAISE(ABORT,'TOPOLOGY_MANAGED: submit a registered topology change'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_structure_insert BEFORE INSERT ON tasks WHEN "+touches("NEW")+" BEGIN SELECT RAISE(ABORT,'TOPOLOGY_MANAGED: create an isolated task before registered placement'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_task_id BEFORE UPDATE OF id ON tasks WHEN NEW.id<>OLD.id AND "+owns("OLD.id")+" BEGIN SELECT RAISE(ABORT,\'topology task identity is immutable\'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_task_retained BEFORE DELETE ON tasks WHEN "+owns("OLD.id")+" BEGIN SELECT RAISE(ABORT,'topology task must be retained'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_admission_delete BEFORE DELETE ON broker_task_projects WHEN EXISTS(SELECT 1 FROM topology_bindings WHERE project_id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'topology project admission must be retained'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_admission_insert BEFORE INSERT ON broker_task_projects WHEN EXISTS(SELECT 1 FROM topology_bindings WHERE project_id=NEW.project_id) AND (EXISTS(SELECT 1 FROM topology_bindings WHERE project_id=NEW.project_id AND (phase='pending' OR owner_epoch<>(SELECT sync_epoch FROM board_node WHERE singleton=1))) OR NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=NEW.task_id AND t.task_uid=NEW.task_uid AND t.parent_id IS NULL AND t.blocked_by='[]' AND t.status<>'in_progress' AND t.owner_node_id=(SELECT node_id FROM board_node WHERE singleton=1)) OR EXISTS(SELECT 1 FROM tasks t WHERE t.parent_id=NEW.task_id OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(t.blocked_by) THEN t.blocked_by ELSE '[]' END) d WHERE d.value=NEW.task_id))) BEGIN SELECT RAISE(ABORT,'TOPOLOGY_MANAGED: only isolated idle tasks can enter a ready project'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_claim_hold BEFORE UPDATE OF status ON tasks WHEN NEW.status='in_progress' AND OLD.status<>'in_progress' AND EXISTS(SELECT 1 FROM broker_task_projects p JOIN topology_bindings b USING(project_id) WHERE p.task_id=NEW.id AND (b.phase<>'ready' OR b.owner_epoch<>(SELECT sync_epoch FROM board_node WHERE singleton=1) OR NOT EXISTS(SELECT 1 FROM topology_vertices v WHERE v.task_id=NEW.id AND v.task_uid=NEW.task_uid))) BEGIN SELECT RAISE(ABORT,'TOPOLOGY_PENDING: local structure is not committed'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_subject_reservation BEFORE UPDATE OF subject,archived_at ON tasks WHEN NEW.archived_at IS NULL AND (NEW.subject IS NOT OLD.subject OR NEW.archived_at IS NOT OLD.archived_at) AND ("+reservedSibling("desired_json")+" OR "+reservedSibling("before_json")+") BEGIN SELECT RAISE(ABORT,'TOPOLOGY_PENDING: title conflicts with reserved sibling placement'); END;",
 "CREATE TRIGGER IF NOT EXISTS topology_transition_hold BEFORE UPDATE OF status,archived_at ON tasks WHEN EXISTS(SELECT 1 FROM topology_holds h JOIN topology_operations o USING(operation_id) WHERE h.task_id=NEW.id AND o.state='prepared' AND (NEW.archived_at IS NOT OLD.archived_at OR h.block_finish=1 AND NEW.status='done' AND OLD.status<>'done')) BEGIN SELECT RAISE(ABORT,'TOPOLOGY_PENDING: task participates in a structure transition'); END;"
 ].join("\n"));
 for(const t of ["topology_vertices","topology_holds","topology_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'topology history is immutable'); END");
 for(const t of ["topology_bindings","topology_operations","topology_attempts","topology_vertices","topology_holds","topology_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'topology history must be retained'); END");
});}
function binding(db,id){project(id);const n=localIdentity(db),b=db.prepare("SELECT * FROM topology_bindings WHERE project_id=?").get(id);if(!b)fail("NOT_FOUND","项目尚未绑定关系登记节点",404);if(b.owner_node_id!==n.node_id||b.owner_epoch!==n.sync_epoch)fail("TOPOLOGY_RECOVERY_REQUIRED","恢复换代后须重新核对本地关系提交");return b;}
function event(db,b,op,kind,detail){db.prepare("INSERT INTO topology_events(project_id,operation_id,kind,detail_json,created_at) VALUES(?,?,?,?,?)").run(b.project_id,op,kind,canonical(detail),at());}
function rows(db,b){const rs=db.prepare("SELECT t.id,t.task_uid,t.parent_id,t.blocked_by,t.kind,t.tree_mode,t.status,t.archived_at,t.aggregate_version,lower(replace(replace(t.subject, ' ', ''), '　', '')) normalized_subject FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE p.project_id=? ORDER BY t.id LIMIT ?").all(b.project_id,MAX_GRAPH_VERTICES+1);if(rs.length>MAX_GRAPH_VERTICES)fail("GRAPH_LIMIT","项目任务数超限");return rs;}
function capture(db,b,revision){
 const s=previewTopology(db,{projectId:b.project_id,graphId:b.graph_id,graphEpoch:b.graph_epoch,revision}).snapshot;
 const external=db.prepare("SELECT 1 FROM tasks t WHERE NOT EXISTS(SELECT 1 FROM broker_task_projects p WHERE p.task_id=t.id AND p.task_uid=t.task_uid AND p.project_id=?) AND (EXISTS(SELECT 1 FROM broker_task_projects p WHERE p.project_id=? AND p.task_id=t.parent_id) OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(t.blocked_by) THEN t.blocked_by ELSE '[]' END) d JOIN broker_task_projects p ON p.task_id=d.value WHERE p.project_id=?)) LIMIT 1").get(b.project_id,b.project_id,b.project_id);
 if(external)fail("PROJECT_BOUNDARY","项目存在未登记或跨项目的入边，不能省略关系端点");return s;
}
export function bindTopology(db,{projectId,graphId,graphEpoch,registrarNodeId,registrarEpoch}){
 project(projectId);for(const [k,v] of Object.entries({graphId,graphEpoch,registrarNodeId,registrarEpoch}))uuid(v,k);
 return unit(db,()=>{const n=localIdentity(db);if(db.prepare("SELECT 1 FROM topology_bindings WHERE project_id=?").get(projectId))fail("CONFLICT","项目已绑定，不能静默替换");
  if(registrarNodeId===n.node_id&&registrarEpoch!==n.sync_epoch)fail("IDENTITY_MISMATCH","本机登记节点代次不匹配");
  const b={project_id:projectId,graph_id:graphId,graph_epoch:graphEpoch,registrar_node_id:registrarNodeId,registrar_epoch:registrarEpoch,owner_node_id:n.node_id,owner_epoch:n.sync_epoch};
  capture(db,b,1);
  db.prepare("INSERT INTO topology_bindings(project_id,graph_id,graph_epoch,registrar_node_id,registrar_epoch,owner_node_id,owner_epoch,phase,created_at) VALUES(?,?,?,?,?,?,?,'unregistered',?)").run(projectId,graphId,graphEpoch,registrarNodeId,registrarEpoch,n.node_id,n.sync_epoch,at());
  event(db,b,null,"bound",{});return topologyState(db,projectId);
 });
}
function operation(db,id){uuid(id,"operation_id");const o=db.prepare("SELECT * FROM topology_operations WHERE operation_id=?").get(id);if(!o)fail("NOT_FOUND","未找到本地结构提交",404);binding(db,o.project_id);return o;}
export function topologyState(db,projectId){
 const b=binding(db,projectId),o=db.prepare("SELECT * FROM topology_operations WHERE project_id=? AND state='prepared'").get(projectId);
 const {snapshot_json,receipt_json,...meta}=b;return {...meta,snapshot:snapshot_json?JSON.parse(snapshot_json):null,receipt:receipt_json?JSON.parse(receipt_json):null,operation:o?operationState(db,o):null};
}
function operationState(db,o){return {operation_id:o.operation_id,project_id:o.project_id,base_revision:o.base_revision,state:o.state,desired:JSON.parse(o.desired_json),receipt:o.receipt_json?JSON.parse(o.receipt_json):null,attempts:db.prepare("SELECT request_id,expected_version,state,error_code FROM topology_attempts WHERE operation_id=? ORDER BY rowid").all(o.operation_id)};}
export function topologyOperation(db,id){return operationState(db,operation(db,id));}
function metadataCheck(desired,rs,before){
 const map=new Map(rs.map(r=>[r.task_uid,r])),verts=new Map(desired.vertices.map(v=>[v.task_uid,v])),prior=new Map(before.vertices.map(v=>[v.task_uid,v]));
 const siblings=new Map();
 for(const v of desired.vertices){
  const row=map.get(v.task_uid);let x=v,depth=0;
  if(v.parent_uid!==null&&!row.archived_at){const key=canonical([v.parent_uid,row.normalized_subject]);if(siblings.has(key))fail("DUPLICATE_SIBLING","目标结构存在同名子任务");siblings.set(key,v.task_uid);}
  while(x){const r=map.get(x.task_uid);if(r.kind==="goal"&&x.parent_uid!==null||r.tree_mode!==row.tree_mode)fail("BAD_LOCAL_GRAPH","目标层级或任务树模式不一致");
   if(depth>32)fail("BAD_LOCAL_GRAPH","任务树超过32层");x=x.parent_uid?verts.get(x.parent_uid):null;depth++;
  }
  const old=prior.get(v.task_uid);
  if(v.parent_uid!==old.parent_uid){let p=v.parent_uid;while(p){const r=map.get(p);if(r.status==="done"||r.archived_at)fail("BAD_LOCAL_GRAPH","不能挂到已关闭的祖先");p=verts.get(p).parent_uid;}}
  if(canonical(v.blocked_by)!==canonical(old.blocked_by))for(const uid of v.blocked_by)if(map.get(uid).archived_at)fail("BAD_LOCAL_GRAPH","不能依赖已归档任务");
 }
}
function apply(db,b,op,snapshot){
 const current=rows(db,b),map=new Map(current.map(r=>[r.task_uid,r]));
 for(const v of snapshot.vertices){const r=map.get(v.task_uid);if(!r)fail("TOPOLOGY_DIVERGED","任务顶点已变化");
  const parent=v.parent_uid===null?null:map.get(v.parent_uid)?.id,deps=v.blocked_by.map(uid=>map.get(uid)?.id).sort((a,b)=>a-b);
  if(parent===undefined||deps.includes(undefined))fail("TOPOLOGY_DIVERGED","本地关系引用已变化");
  const encoded=JSON.stringify(deps),depsSame=JSON.stringify(JSON.parse(r.blocked_by).sort((a,b)=>a-b))===encoded;if(parent===r.parent_id&&depsSame)continue;
  db.prepare("INSERT INTO topology_write_permits VALUES(?,?,?)").run(r.id,parent,depsSame?r.blocked_by:encoded);
  try{store.update(db,{id:r.id,expectedVersion:r.aggregate_version,...(parent!==r.parent_id?{parentId:parent}:{}),...(!depsSame?{blockedBy:deps}:{}),actor:"topology:"+op});}
  finally{db.prepare("DELETE FROM topology_write_permits WHERE task_id=?").run(r.id);}
 }
}
function holdsFor(before,desired,rs){
 const held=new Map(),prior=new Map(before.vertices.map(v=>[v.task_uid,v])),next=new Map(desired.vertices.map(v=>[v.task_uid,v]));
 const children=new Map(before.vertices.map(v=>[v.task_uid,[]]));for(const v of before.vertices)if(v.parent_uid)children.get(v.parent_uid).push(v.task_uid);
 const mustIdle=new Set();const hold=(uid,finish)=>held.set(uid,Math.max(held.get(uid)??0,finish));
 const parents=(uid,map,idle=false)=>{while(uid){hold(uid,1);if(idle)mustIdle.add(uid);uid=map.get(uid).parent_uid;}};
 for(const v of desired.vertices){const old=prior.get(v.task_uid);if(canonical(v)===canonical(old))continue;
  hold(v.task_uid,1);mustIdle.add(v.task_uid);parents(old.parent_uid,prior,old.parent_uid!==v.parent_uid);parents(v.parent_uid,next);
  if(old.parent_uid!==v.parent_uid){const q=[v.task_uid];for(let i=0;i<q.length;i++)for(const uid of children.get(q[i])){hold(uid,1);mustIdle.add(uid);q.push(uid);}}
  for(const uid of [...old.blocked_by,...v.blocked_by])hold(uid,0);
 }
 for(const r of rs)if(mustIdle.has(r.task_uid)&&r.status==="in_progress")fail("ACTIVE_STRUCTURE","受影响的任务、祖先或子树正在执行");
 return held;
}
/** Remove old edges first; while awaiting registration the actual local graph is a subset of both versions. */
export function prepareTopology(db,{projectId,operationId,expectedRevision,edits=[]}){
 project(projectId);uuid(operationId,"operation_id");if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail("BAD_INPUT","本地修订无效",400);
 if(!Array.isArray(edits)||edits.length>MAX_GRAPH_VERTICES)fail("BAD_INPUT","结构修改集合无效",400);
 const ids=new Set();for(const e of edits){exact(e,["task_uid","expected_version","parent_uid","blocked_by"],"edit");version(e.expected_version);if(ids.has(e.task_uid))fail("BAD_INPUT","同一任务不能重复修改",400);ids.add(e.task_uid);}
 const argsHash=digest({projectId,operationId,expectedRevision,edits});
 return unit(db,()=>{const b=binding(db,projectId),existing=db.prepare("SELECT * FROM topology_operations WHERE operation_id=?").get(operationId);
  if(existing){if(existing.project_id!==projectId||existing.args_digest!==argsHash)fail("REQUEST_CONFLICT","提交ID已绑定其他内容");return operationState(db,existing);}
  if(b.phase==="pending")fail("TOPOLOGY_PENDING","当前项目已有待提交结构");if(b.revision!==expectedRevision)fail("CONFLICT","本地关系修订已变化");if(b.revision>=Number.MAX_SAFE_INTEGER)fail("GRAPH_LIMIT","本地修订已达上限");
  const before=capture(db,b,b.revision+1),rs=rows(db,b),map=new Map(rs.map(r=>[r.task_uid,r])),byUid=new Map(edits.map(e=>[e.task_uid,e]));
  for(const e of edits){const r=map.get(e.task_uid);if(!r||r.aggregate_version!==e.expected_version)fail("CONFLICT","任务或版本已变化");}
  if(b.snapshot_json){
   const registered=JSON.parse(b.snapshot_json),actuals=new Map(before.vertices.map(v=>[v.task_uid,v]));for(const old of registered.vertices){const actual=actuals.get(old.task_uid);if(!actual||canonical(old)!==canonical(actual))fail("TOPOLOGY_DIVERGED","已登记任务结构与本地不一致");}
  }
  const desired=normalizeTopology({...before,vertices:before.vertices.map(v=>{const e=byUid.get(v.task_uid);return e?{task_uid:v.task_uid,parent_uid:e.parent_uid,blocked_by:e.blocked_by}:v;})});
  validateCombinedGraph([desired]);metadataCheck(desired,rs,before);
  const held=holdsFor(before,desired,rs),next=new Map(desired.vertices.map(v=>[v.task_uid,v]));
  const intersection=normalizeTopology({...before,vertices:before.vertices.map(v=>({task_uid:v.task_uid,parent_uid:v.parent_uid===next.get(v.task_uid).parent_uid?v.parent_uid:null,blocked_by:v.blocked_by.filter(uid=>next.get(v.task_uid).blocked_by.includes(uid))}))});
  db.prepare("INSERT INTO topology_operations VALUES(?,?,?,?,?,?,?,?,'prepared',NULL,?,?)").run(operationId,projectId,b.owner_epoch,b.revision,argsHash,canonical(before),canonical(intersection),canonical(desired),at(),at());
  for(const [uid,finish] of held)db.prepare("INSERT INTO topology_holds VALUES(?,?,?)").run(operationId,map.get(uid).id,finish);
  db.prepare("UPDATE topology_bindings SET phase='pending' WHERE project_id=?").run(projectId);
  apply(db,b,operationId,intersection);
  // Both roll-forward and cancellation must satisfy native constraints before publication.
  for(const snapshot of [before,desired]){db.exec("SAVEPOINT topology_preview");try{apply(db,b,operationId,snapshot);}finally{db.exec("ROLLBACK TO topology_preview; RELEASE topology_preview");}}
  event(db,b,operationId,"prepared",{before_digest:digest(before),intersection_digest:digest(intersection),desired_digest:digest(desired)});
  return topologyOperation(db,operationId);
 });
}
export function startTopologyAttempt(db,{operationId,expectedVersion}){
 version(expectedVersion);return unit(db,()=>{const o=operation(db,operationId),b=binding(db,o.project_id);if(o.state!=="prepared")fail("CONFLICT","本地提交已经结束");
  let a=db.prepare("SELECT * FROM topology_attempts WHERE operation_id=? AND state='pending'").get(operationId);
  if(!a){a={request_id:randomUUID(),expected_version:expectedVersion};db.prepare("INSERT INTO topology_attempts VALUES(?,?,?,'pending',NULL,NULL,?)").run(a.request_id,operationId,expectedVersion,at());event(db,b,operationId,"publish_requested",{request_id:a.request_id,expected_version:expectedVersion});}
  return {request_id:a.request_id,expected_version:a.expected_version,snapshot:JSON.parse(o.desired_json)};
 });
}
export const DEFINITIVE_TOPOLOGY_REJECTIONS=Object.freeze(["GRAPH_VERSION_CONFLICT","GRAPH_VERSION_EXHAUSTED","TOPOLOGY_VERSION_CONFLICT","RELATION_CYCLE","DANGLING_RELATION","GRAPH_LIMIT"]);
export function rejectTopologyAttempt(db,{operationId,requestId,code}){
 if(!DEFINITIVE_TOPOLOGY_REJECTIONS.includes(code))fail("UNKNOWN_REMOTE_OUTCOME","该失败不能证明先前请求未成功");
 return unit(db,()=>{const o=operation(db,operationId),b=binding(db,o.project_id),a=db.prepare("SELECT * FROM topology_attempts WHERE request_id=? AND operation_id=?").get(requestId,operationId);if(!a)fail("NOT_FOUND","请求不存在",404);
  if(a.state==="rejected"&&a.error_code===code)return topologyOperation(db,operationId);
  if(a.state!=="pending"||o.state!=="prepared")fail("CONFLICT","请求状态已变化");
  db.prepare("UPDATE topology_attempts SET state='rejected',error_code=? WHERE request_id=?").run(code,requestId);event(db,b,operationId,"publish_rejected",{request_id:requestId,code});return topologyOperation(db,operationId);
 });
}
function verifyReceipt(b,o,a,r){
 exact(r,["schema_version","kind","project_id","graph_id","graph_epoch","graph_version","registrar_node_id","registrar_epoch","owner_node_id","owner_epoch","revision","snapshot_digest","vertices","edges","graph_digest"],"topology receipt");
 version(r.graph_version);const s=JSON.parse(o.desired_json),proof=validateCombinedGraph([s]);
 if(r.schema_version!==1||r.kind!=="topology_registered"||r.project_id!==b.project_id||r.graph_id!==b.graph_id||r.graph_epoch!==b.graph_epoch||r.registrar_node_id!==b.registrar_node_id||r.registrar_epoch!==b.registrar_epoch||r.owner_node_id!==b.owner_node_id||r.owner_epoch!==b.owner_epoch||r.revision!==s.revision||r.graph_version!==a.expected_version+1||r.snapshot_digest!==digest(s)||!Number.isSafeInteger(r.vertices)||r.vertices<proof.vertices||r.vertices>MAX_GRAPH_VERTICES||!Number.isSafeInteger(r.edges)||r.edges<proof.edges||r.edges>100000||!(/^[0-9a-f]{64}$/).test(r.graph_digest))fail("RECEIPT_MISMATCH","登记回执未绑定本次结构、身份和修订");
}
export function acceptTopologyReceipt(db,{operationId,requestId,receipt}){
 return unit(db,()=>{const o=operation(db,operationId),b=binding(db,o.project_id),a=db.prepare("SELECT * FROM topology_attempts WHERE request_id=? AND operation_id=?").get(requestId,operationId);if(!a)fail("NOT_FOUND","请求不存在",404);verifyReceipt(b,o,a,receipt);
  if(o.state==="applied"){if(o.receipt_json!==canonical(receipt))fail("RECEIPT_MISMATCH","重复回执内容不同");return topologyOperation(db,operationId);}
  if(o.state!=="prepared"||a.state!=="pending"||b.revision!==o.base_revision)fail("CONFLICT","提交状态已变化");
  const current=capture(db,b,o.base_revision+1);if(canonical(current)!==o.intersection_json)fail("TOPOLOGY_DIVERGED","等待期间本地结构发生变化");
  const desired=JSON.parse(o.desired_json);metadataCheck(desired,rows(db,b),current);apply(db,b,operationId,desired);
  const map=new Map(rows(db,b).map(r=>[r.task_uid,r.id]));for(const v of desired.vertices)db.prepare("INSERT OR IGNORE INTO topology_vertices VALUES(?,?,?)").run(map.get(v.task_uid),v.task_uid,b.project_id);
  db.prepare("UPDATE topology_attempts SET state='acknowledged',receipt_json=? WHERE request_id=?").run(canonical(receipt),requestId);
  db.prepare("UPDATE topology_operations SET state='applied',receipt_json=?,updated_at=? WHERE operation_id=?").run(canonical(receipt),at(),operationId);
  db.prepare("UPDATE topology_bindings SET phase='ready',revision=?,snapshot_json=?,receipt_json=? WHERE project_id=?").run(desired.revision,canonical(desired),canonical(receipt),b.project_id);
  event(db,b,operationId,"applied",{request_id:requestId,snapshot_digest:receipt.snapshot_digest,graph_version:receipt.graph_version});return topologyOperation(db,operationId);
 });
}
/** Cancellation after transmission requires a fresh, authenticated registrar status proving the old owner snapshot remains current. */
export function cancelPreparedTopology(db,{operationId,observedGraph=null}){
 return unit(db,()=>{const o=operation(db,operationId),b=binding(db,o.project_id);if(o.state==="cancelled")return topologyOperation(db,operationId);if(o.state!=="prepared")fail("CONFLICT","已提交的结构不能直接取消");
  const attempts=db.prepare("SELECT * FROM topology_attempts WHERE operation_id=?").all(operationId);
  if(attempts.some(a=>a.state!=="rejected"))fail("UNKNOWN_REMOTE_OUTCOME","先重试未确定的远程请求，不能盲目恢复旧边");
  if(attempts.length){checkRegistrarStatus(b,observedGraph);const t=observedGraph.topologies.find(t=>t.node_id===b.owner_node_id);
   if(b.revision===0?t!==undefined:!t||t.revision!==b.revision||t.snapshot_digest!==digest(JSON.parse(b.snapshot_json)))fail("TOPOLOGY_DIVERGED","登记节点的本地图已变化，不能恢复旧边");
  }
  if(canonical(capture(db,b,o.base_revision+1))!==o.intersection_json)fail("TOPOLOGY_DIVERGED","本地中间结构已变化");
  apply(db,b,operationId,JSON.parse(o.before_json));
  db.prepare("UPDATE topology_operations SET state='cancelled',updated_at=? WHERE operation_id=?").run(at(),operationId);
  db.prepare("UPDATE topology_bindings SET phase=? WHERE project_id=?").run(b.revision?"ready":"unregistered",b.project_id);
  event(db,b,operationId,"cancelled",{});return topologyOperation(db,operationId);
 });
}
export function checkRegistrarStatus(b,s){
 if(!s||s.project_id!==b.project_id||s.graph_id!==b.graph_id||s.graph_epoch!==b.graph_epoch||s.registrar_node_id!==b.registrar_node_id||s.registrar_epoch!==b.registrar_epoch||!Array.isArray(s.topologies)||!Array.isArray(s.members))fail("GRAPH_MISMATCH","关系登记状态身份不匹配");
 version(s.version);if(!s.members.some(m=>m.node_id===b.owner_node_id&&m.node_epoch===b.owner_epoch))fail("FORBIDDEN","登记节点未授权本机当前代次",403);
}
