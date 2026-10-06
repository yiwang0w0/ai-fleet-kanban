import {endpoint} from "./endpoint.mjs";
// Durable task projections. All sequence numbers are scoped by origin epoch + project.
import {migrateEpochState,assertSourceEpoch,pendingRecovery,bindReplicaLocation,resolveRecoveryMissing} from "./epoch-state.mjs";
import {createHash,randomUUID} from "node:crypto";
import {PeerError,uuid,names,keys,version} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
function safeDigest(x){try{return digest(x);}catch{return createHash("sha256").update("invalid-unserializable-batch").digest("hex");}}
export const MAX_EVENT_BYTES=256*1024, MAX_BATCH_BYTES=1024*1024;
export const MAX_CANONICAL_DEPTH=64;
export function canonical(x){return canonicalValue(x,0);}
function canonicalValue(x,depth){
 if(depth>MAX_CANONICAL_DEPTH)throw new PeerError("BAD_INPUT","JSON 嵌套层数超过上限",400);
 if(x===null || typeof x!=="object")return JSON.stringify(x);
 if(Array.isArray(x))return "["+x.map(v=>canonicalValue(v,depth+1)).join(",")+"]";
 return "{"+Object.keys(x).sort().map(k=>JSON.stringify(k)+":"+canonicalValue(x[k],depth+1)).join(",")+"}";
}
export const digest=x=>createHash("sha256").update(canonical(x)).digest("hex");
const conflict=(code,message)=>new PeerError(code,message,409);
const project=p=>names([p],"project_id",null,1)[0];
export function integer(n,label){if(!Number.isSafeInteger(n)||n<0)throw new PeerError("BAD_INPUT",label+" 必须是非负安全整数");return n;}
export function atomic(db,fn){
 if(typeof db.isTransaction!=="boolean")throw new PeerError("RUNTIME_INCOMPATIBLE","同步功能需要支持 SQLite isTransaction 的 Node 运行时；请使用已验证的 Node 24",500);
 return db.isTransaction ? fn() : transaction(db,fn);
}
export function migrateSync(db){
 return atomic(db,()=>{
  localIdentity(db);
  db.exec([
   "CREATE TABLE IF NOT EXISTS federation_sync_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);",
   "INSERT OR IGNORE INTO federation_sync_schema VALUES(1,1);"
  ].join("\n"));
  const schemaVersion=db.prepare("SELECT version FROM federation_sync_schema").get().version;
  if(![1,2,3,4,5].includes(schemaVersion))throw conflict("SCHEMA_INCOMPATIBLE","同步存储格式不兼容");
  db.exec([
   "CREATE TABLE IF NOT EXISTS federation_shares(task_id INTEGER PRIMARY KEY,task_uid TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991));",
   "CREATE TABLE IF NOT EXISTS federation_dirty(task_id INTEGER PRIMARY KEY);",
   "CREATE TABLE IF NOT EXISTS federation_streams(project_id TEXT PRIMARY KEY,seq INTEGER NOT NULL DEFAULT 0);",
   "CREATE TABLE IF NOT EXISTS federation_outbox(event_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,seq INTEGER NOT NULL,event_digest TEXT NOT NULL,event_json TEXT NOT NULL,UNIQUE(project_id,seq));",
   "CREATE TABLE IF NOT EXISTS federation_deliveries(peer_node_id TEXT NOT NULL,peer_epoch TEXT NOT NULL,project_id TEXT NOT NULL,offered_seq INTEGER NOT NULL DEFAULT 0,acked_seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(peer_node_id,peer_epoch,project_id));",
   "CREATE TABLE IF NOT EXISTS federation_inbox(event_id TEXT PRIMARY KEY,origin_node_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,project_id TEXT NOT NULL,seq INTEGER NOT NULL,event_digest TEXT NOT NULL,UNIQUE(origin_node_id,origin_epoch,project_id,seq));",
   "CREATE TABLE IF NOT EXISTS federation_sources(origin_node_id TEXT PRIMARY KEY,origin_epoch TEXT NOT NULL,display_name TEXT NOT NULL,last_seen_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS federation_cursors(origin_node_id TEXT NOT NULL,project_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,seq INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(origin_node_id,project_id));",
   "CREATE TABLE IF NOT EXISTS federation_replicas(task_uid TEXT PRIMARY KEY,owner_node_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,project_id TEXT NOT NULL,projection_version INTEGER NOT NULL,task_version INTEGER NOT NULL,withdrawn INTEGER NOT NULL,task_json TEXT,last_seq INTEGER NOT NULL,received_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS federation_quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT,origin_node_id TEXT NOT NULL,project_id TEXT NOT NULL,code TEXT NOT NULL,batch_digest TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(origin_node_id,project_id,code,batch_digest));",
   "CREATE TRIGGER IF NOT EXISTS federation_share_identity BEFORE UPDATE OF task_id,task_uid,project_id ON federation_shares WHEN NEW.task_id IS NOT OLD.task_id OR NEW.task_uid IS NOT OLD.task_uid OR NEW.project_id IS NOT OLD.project_id BEGIN SELECT RAISE(ABORT,'shared task identity/project is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS federation_share_insert AFTER INSERT ON federation_shares BEGIN INSERT OR IGNORE INTO federation_dirty VALUES(NEW.task_id); END;",
   "CREATE TRIGGER IF NOT EXISTS federation_share_revision AFTER UPDATE OF revision ON federation_shares WHEN NEW.revision<>OLD.revision BEGIN INSERT OR IGNORE INTO federation_dirty VALUES(NEW.task_id); END;",
   // No application hook is needed: this marker commits/rolls back with the business write.
   "CREATE TRIGGER IF NOT EXISTS federation_task_dirty AFTER UPDATE OF aggregate_version ON tasks WHEN NEW.aggregate_version<>OLD.aggregate_version BEGIN UPDATE federation_shares SET revision=revision+1 WHERE task_id=NEW.id AND enabled=1; END;",
   "CREATE TRIGGER IF NOT EXISTS federation_task_deleted AFTER DELETE ON tasks BEGIN UPDATE federation_shares SET revision=revision+1,enabled=0 WHERE task_id=OLD.id; END;",
   "CREATE TRIGGER IF NOT EXISTS federation_outbox_no_update BEFORE UPDATE ON federation_outbox BEGIN SELECT RAISE(ABORT,'published event is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS federation_outbox_no_delete BEFORE DELETE ON federation_outbox BEGIN SELECT RAISE(ABORT,'published event retention is not enabled'); END;"
  ].join("\n"));
  if(!db.prepare("PRAGMA table_info(federation_sources)").all().some(c=>c.name==='server_endpoint'))db.exec("ALTER TABLE federation_sources ADD COLUMN server_endpoint TEXT");
  db.exec("CREATE TRIGGER IF NOT EXISTS federation_source_endpoint_immutable BEFORE UPDATE OF server_endpoint ON federation_sources WHEN OLD.server_endpoint IS NOT NULL AND NEW.server_endpoint IS NOT OLD.server_endpoint BEGIN SELECT RAISE(ABORT,'source endpoint is immutable'); END; CREATE TRIGGER IF NOT EXISTS federation_source_endpoint_retained BEFORE DELETE ON federation_sources WHEN OLD.server_endpoint IS NOT NULL BEGIN SELECT RAISE(ABORT,'bound source endpoint must be retained'); END");
  db.exec("CREATE TABLE IF NOT EXISTS federation_published(project_id TEXT NOT NULL,task_uid TEXT NOT NULL,seq INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(project_id,task_uid));\nCREATE TABLE IF NOT EXISTS federation_retention(project_id TEXT PRIMARY KEY,floor_seq INTEGER NOT NULL DEFAULT 0);\nCREATE TABLE IF NOT EXISTS federation_snapshots(snapshot_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,head_seq INTEGER NOT NULL,manifest_json TEXT NOT NULL,expires_at INTEGER NOT NULL);\nCREATE TABLE IF NOT EXISTS federation_snapshot_items(snapshot_id TEXT NOT NULL,ordinal INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,ordinal));\nCREATE TABLE IF NOT EXISTS federation_snapshot_offers(peer_node_id TEXT NOT NULL,peer_epoch TEXT NOT NULL,snapshot_id TEXT NOT NULL,PRIMARY KEY(peer_node_id,peer_epoch,snapshot_id));\nCREATE TABLE IF NOT EXISTS federation_snapshot_staging(origin_node_id TEXT NOT NULL,project_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,snapshot_id TEXT NOT NULL UNIQUE,manifest_json TEXT NOT NULL,next_offset INTEGER NOT NULL DEFAULT 0,received_bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(origin_node_id,project_id));\nCREATE TABLE IF NOT EXISTS federation_snapshot_received(snapshot_id TEXT NOT NULL,ordinal INTEGER NOT NULL,task_uid TEXT NOT NULL,event_json TEXT NOT NULL,event_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(snapshot_id,ordinal),UNIQUE(snapshot_id,task_uid),UNIQUE(snapshot_id,event_id),UNIQUE(snapshot_id,seq));\nCREATE TABLE IF NOT EXISTS federation_snapshot_anchors(origin_node_id TEXT NOT NULL,project_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,seq INTEGER NOT NULL,event_digest TEXT,snapshot_id TEXT NOT NULL,content_digest TEXT NOT NULL,PRIMARY KEY(origin_node_id,project_id));\nCREATE TABLE IF NOT EXISTS federation_retention_events(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,floor_seq INTEGER NOT NULL,head_seq INTEGER NOT NULL,snapshot_id TEXT NOT NULL,deleted_count INTEGER NOT NULL,lagging_peer_count INTEGER NOT NULL,at TEXT NOT NULL);");
  if(schemaVersion===1){
   db.exec("INSERT OR REPLACE INTO federation_published SELECT o.project_id,json_extract(o.event_json,'$.aggregate_uid'),o.seq,o.event_json FROM federation_outbox o JOIN (SELECT project_id,json_extract(event_json,'$.aggregate_uid') AS uid,MAX(seq) AS seq FROM federation_outbox GROUP BY project_id,uid) latest ON o.project_id=latest.project_id AND o.seq=latest.seq");
  }
  migrateEpochState(db);
  if(schemaVersion<4){
   // Event UUIDs are chosen by independent sources. One peer must not reserve
   // another peer's UUID; sequence and event reuse within a source still conflict.
   db.exec("CREATE TABLE federation_inbox_v4(event_id TEXT NOT NULL,origin_node_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,project_id TEXT NOT NULL,seq INTEGER NOT NULL,event_digest TEXT NOT NULL,PRIMARY KEY(origin_node_id,event_id),UNIQUE(origin_node_id,origin_epoch,project_id,seq)); INSERT INTO federation_inbox_v4 SELECT * FROM federation_inbox; DROP TABLE federation_inbox; ALTER TABLE federation_inbox_v4 RENAME TO federation_inbox; UPDATE federation_sync_schema SET version=4 WHERE singleton=1");
  }
  db.exec("UPDATE federation_sync_schema SET version=5 WHERE singleton=1");
 });
}
/** Explicit opt-in. A stable project prevents accidental cross-project relocation. */
export function shareTask(db,{id,projectId,expectedVersion,enabled=true}){
 projectId=project(projectId);version(expectedVersion);
 if(typeof enabled!=="boolean")throw new PeerError("BAD_INPUT","enabled 必须为布尔值");
 return atomic(db,()=>{
  localIdentity(db);
  const t=db.prepare("SELECT id,task_uid,aggregate_version FROM tasks WHERE id=?").get(Number(id));
  if(!t)throw new PeerError("NOT_FOUND","本机任务不存在",404);
  if(t.aggregate_version!==expectedVersion)throw conflict("CONFLICT","任务版本已变化，重新核对共享范围");
  const prior=db.prepare("SELECT * FROM federation_shares WHERE task_id=?").get(t.id);
  if(prior && prior.project_id!==projectId)throw conflict("PROJECT_CONFLICT","已登记任务不能静默改换共享项目");
  if(!prior && !enabled)throw conflict("CONFLICT","任务尚未共享");
  if(!prior)db.prepare("INSERT INTO federation_shares VALUES(?,?,?,?,1)").run(t.id,t.task_uid,projectId,1);
  else if(prior.enabled!==Number(enabled))db.prepare("UPDATE federation_shares SET enabled=?,revision=revision+1 WHERE task_id=?").run(Number(enabled),t.id);
  // Parent visibility changes the projected edge even if a child's task version does not move.
  if(!prior || prior.enabled!==Number(enabled))
   db.prepare("UPDATE federation_shares SET revision=revision+1 WHERE enabled=1 AND task_id IN (SELECT id FROM tasks WHERE parent_id=?)").run(t.id);
  return {...db.prepare("SELECT * FROM federation_shares WHERE task_id=?").get(t.id),enabled:Boolean(enabled)};
 });
}
function taskProjection(db,t,projectId){
 const parent=t.parent_id==null?null:db.prepare("SELECT task_uid FROM federation_shares WHERE task_id=? AND project_id=? AND enabled=1").get(t.parent_id,projectId)?.task_uid ?? null;
 return {task_uid:t.task_uid,owner_node_id:t.owner_node_id,aggregate_version:t.aggregate_version,
  subject:t.subject,description:t.description,acceptance:t.acceptance,status:t.status,waiting_for:t.waiting_for,
  kind:t.kind,parent_uid:parent,line:t.line,run_id:t.run_id,attempts:t.attempts,max_attempts:t.max_attempts,
  released:Boolean(t.released),result:t.result,verdict_note:t.verdict_note,archived_at:t.archived_at,
  created_at:t.created_at,updated_at:t.updated_at};
}
function materialize(db,projectId,limit){
 const node=localIdentity(db);
 db.prepare("INSERT OR IGNORE INTO federation_streams(project_id) VALUES(?)").run(projectId);
 const pending=db.prepare("SELECT s.* FROM federation_dirty d JOIN federation_shares s ON s.task_id=d.task_id WHERE s.project_id=? ORDER BY d.task_id LIMIT ?").all(projectId,limit);
 for(const s of pending){
  const t=db.prepare("SELECT * FROM tasks WHERE id=?").get(s.task_id);
  const live=s.enabled===1 && !!t;
  const payload=live?{task:taskProjection(db,t,projectId)}:{};
  const seq=db.prepare("UPDATE federation_streams SET seq=seq+1 WHERE project_id=? RETURNING seq").get(projectId).seq;
  const event={schema_version:1,event_id:randomUUID(),origin_node_id:node.node_id,origin_epoch:node.sync_epoch,project_id:projectId,
   seq,aggregate_uid:s.task_uid,aggregate_version:s.revision,kind:live?"task.snapshot":"task.withdrawn",payload,payload_digest:digest(payload)};
  const eventDigest=digest(event);event.event_digest=eventDigest;
  const text=canonical(event);
  if(Buffer.byteLength(text)>MAX_EVENT_BYTES)throw new PeerError("PROJECTION_TOO_LARGE","任务共享内容超过 256 KiB，待发送记录仍保留",413);
  db.prepare("INSERT INTO federation_outbox VALUES(?,?,?,?,?)").run(event.event_id,projectId,seq,eventDigest,text);
  db.prepare("INSERT INTO federation_published VALUES(?,?,?,?) ON CONFLICT(project_id,task_uid) DO UPDATE SET seq=excluded.seq,event_json=excluded.event_json").run(projectId,s.task_uid,seq,text);
  db.prepare("DELETE FROM federation_dirty WHERE task_id=?").run(s.task_id);
 }
}
export function allowed(peer,projectId,scope){
 project(projectId);
 if(!peer.scopes.includes(scope)||!peer.projects.includes(projectId))throw new PeerError("FORBIDDEN","对端不具备该项目的同步权限",403);
}
export function exportBatch(db,peer,{project_id:projectId,after_seq:after,limit=25}){
 allowed(peer,projectId,"sync:pull");integer(after,"after_seq");
 if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new PeerError("BAD_INPUT","limit 必须为 1..25");
 return atomic(db,()=>{
  const node=localIdentity(db);
  const oldHead=db.prepare("SELECT seq FROM federation_streams WHERE project_id=?").get(projectId)?.seq??0;
  const floor=db.prepare("SELECT floor_seq FROM federation_retention WHERE project_id=?").get(projectId)?.floor_seq??0;
  if(after<floor)throw conflict("SNAPSHOT_REQUIRED","增量历史已压缩，请从授权快照重建");
  if(after>oldHead)throw conflict("CURSOR_AHEAD","游标超过本机流末尾；拒绝静默重置");
  materialize(db,projectId,limit);
  const head=db.prepare("SELECT seq FROM federation_streams WHERE project_id=?").get(projectId).seq;
  const rows=db.prepare("SELECT * FROM federation_outbox WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?").all(projectId,after,limit);
  const events=[];let bytes=2048;
  for(const r of rows){if(bytes+Buffer.byteLength(r.event_json)>MAX_BATCH_BYTES)break;events.push(JSON.parse(r.event_json));bytes+=Buffer.byteLength(r.event_json);}
  const end=events.at(-1)?.seq??after;
  const checkpoint=end?db.prepare("SELECT seq,event_digest FROM federation_outbox WHERE project_id=? AND seq=?").get(projectId,end):null;
  db.prepare("INSERT INTO federation_deliveries(peer_node_id,peer_epoch,project_id,offered_seq) VALUES(?,?,?,?) ON CONFLICT(peer_node_id,peer_epoch,project_id) DO UPDATE SET offered_seq=MAX(offered_seq,excluded.offered_seq)").run(peer.peer_node_id,peer.peer_epoch,projectId,end);
  const pending=db.prepare("SELECT count(*) AS n FROM federation_dirty d JOIN federation_shares s ON s.task_id=d.task_id WHERE project_id=?").get(projectId).n;
  return {protocol_version:1,origin_node_id:node.node_id,origin_epoch:node.sync_epoch,project_id:projectId,after_seq:after,
   head_seq:head,pending_count:pending,checkpoint:checkpoint?{...checkpoint}:null,events};
 });
}
export function acknowledge(db,peer,{project_id:projectId,seq,event_digest:eventDigest}){
 allowed(peer,projectId,"sync:ack");version(seq);
 return atomic(db,()=>{
  const d=db.prepare("SELECT * FROM federation_deliveries WHERE peer_node_id=? AND peer_epoch=? AND project_id=?").get(peer.peer_node_id,peer.peer_epoch,projectId);
  const e=db.prepare("SELECT event_digest FROM federation_outbox WHERE project_id=? AND seq=?").get(projectId,seq);
  if(!d || seq>d.offered_seq || !e || eventDigest!==e.event_digest)throw conflict("INVALID_ACK","确认未对应已提供的事件");
  db.prepare("UPDATE federation_deliveries SET acked_seq=MAX(acked_seq,?) WHERE peer_node_id=? AND peer_epoch=? AND project_id=?").run(seq,peer.peer_node_id,peer.peer_epoch,projectId);
  return {acked_seq:Math.max(d.acked_seq,seq)};
 });
}
const TASK_FIELDS=["task_uid","owner_node_id","aggregate_version","subject","description","acceptance","status","waiting_for","kind","parent_uid","line","run_id","attempts","max_attempts","released","result","verdict_note","archived_at","created_at","updated_at"];
export function validateTask(t,e){
 keys(t,TASK_FIELDS,"task");
 if(Object.keys(t).length!==TASK_FIELDS.length)throw new PeerError("BAD_INPUT","任务投影字段缺失");
 if(t.task_uid!==e.aggregate_uid||t.owner_node_id!==e.origin_node_id)throw conflict("OWNER_MISMATCH","任务所有者不匹配");
 version(t.aggregate_version);
 if(!["not_started","in_progress","waiting","done"].includes(t.status)||!["task","goal"].includes(t.kind)||typeof t.released!=="boolean")throw new PeerError("BAD_INPUT","任务状态无效");
 for(const k of ["subject","description","acceptance","created_at","updated_at"])if(typeof t[k]!=="string")throw new PeerError("BAD_INPUT","任务文本格式无效");
 for(const k of ["waiting_for","line","result","verdict_note","archived_at"])if(t[k]!==null&&typeof t[k]!=="string")throw new PeerError("BAD_INPUT","任务可空字段无效");
 if(t.run_id!==null)uuid(t.run_id,"run_id");
 if(t.parent_uid!==null)taskUID(t.parent_uid,e.origin_node_id);
 integer(t.attempts,"attempts");version(t.max_attempts);
}
export function taskUID(uid,owner){
 if(typeof uid!=="string"||uid.slice(0,37)!==owner+"/")throw conflict("OWNER_MISMATCH","任务 UID 不属于已认证来源");
 uuid(uid.slice(37),"task UID");
}
export function cursor(db,origin,epoch,projectId){
 assertSourceEpoch(db,origin,epoch);
 const c=db.prepare("SELECT * FROM federation_cursors WHERE origin_node_id=? AND project_id=?").get(origin,projectId);
 if(c && c.origin_epoch!==epoch)throw conflict("EPOCH_CHANGED","来源 epoch 已变化，需要显式快照恢复");
 return c?.seq??0;
}
export function applyBatch(db,{origin,epoch,projectId},batch){
 uuid(origin,"origin");uuid(epoch,"epoch");project(projectId);
 try{return atomic(db,()=>{
  if(origin===localIdentity(db).node_id)throw conflict("OWNER_MISMATCH","远端副本不能冒充本机");
  keys(batch,["protocol_version","origin_node_id","origin_epoch","project_id","after_seq","head_seq","pending_count","checkpoint","events"],"batch");
  if(Object.keys(batch).length!==9)throw new PeerError("BAD_INPUT","批次字段缺失");
  if(batch.protocol_version!==1||batch.origin_node_id!==origin||batch.origin_epoch!==epoch||batch.project_id!==projectId)throw conflict("SOURCE_MISMATCH","批次来源或协议不匹配");
  integer(batch.after_seq,"after_seq");integer(batch.head_seq,"head_seq");integer(batch.pending_count,"pending_count");
  if(batch.checkpoint!==null){keys(batch.checkpoint,["seq","event_digest"],"checkpoint");version(batch.checkpoint.seq);}
  if(batch.head_seq<batch.after_seq)throw conflict("CURSOR_AHEAD","对端流末尾落后于请求游标，拒绝假报同步完成");
  if(!Array.isArray(batch.events)||batch.events.length>25||Buffer.byteLength(canonical(batch))>MAX_BATCH_BYTES)throw new PeerError("BAD_INPUT","批次超出限额");
  assertSourceEpoch(db,origin,epoch);
  if(pendingRecovery(db,{origin,epoch,projectId}))throw conflict("SNAPSHOT_REQUIRED","已批准新代次，但必须先完成项目快照");
  let current=cursor(db,origin,epoch,projectId),expected=batch.after_seq+1,applied=0;
  if(batch.after_seq>current)throw conflict("SEQUENCE_GAP","事件流存在缺口");
  for(const e of batch.events){
   keys(e,["schema_version","event_id","origin_node_id","origin_epoch","project_id","seq","aggregate_uid","aggregate_version","kind","payload","payload_digest","event_digest"],"event");
   if(Object.keys(e).length!==12)throw new PeerError("BAD_INPUT","事件字段缺失");
   uuid(e.event_id,"event_id");version(e.seq);version(e.aggregate_version);taskUID(e.aggregate_uid,origin);
   if(e.schema_version!==1||e.origin_node_id!==origin||e.origin_epoch!==epoch||e.project_id!==projectId)throw conflict("SOURCE_MISMATCH","事件来源不匹配");
   const {event_digest:eventDigest,...unsigned}=e;
   if(eventDigest!==digest(unsigned)||e.payload_digest!==digest(e.payload)||Buffer.byteLength(canonical(e))>MAX_EVENT_BYTES)throw conflict("CONTENT_MISMATCH","事件内容摘要不匹配");
   if(e.seq!==expected++ || e.seq>batch.head_seq)throw conflict("SEQUENCE_GAP","事件乱序或存在缺口");
   const prior=db.prepare("SELECT * FROM federation_inbox WHERE origin_node_id=? AND (event_id=? OR (origin_epoch=? AND project_id=? AND seq=?))").all(origin,e.event_id,epoch,projectId,e.seq);
   if(prior.length){if(prior.length!==1||prior[0].event_digest!==eventDigest)throw conflict("CONTENT_MISMATCH","相同事件身份出现不同内容");
    if(e.seq>current)throw conflict("SEQUENCE_GAP","本机游标与收件箱不一致");continue;}
   if(e.seq!==current+1)throw conflict("SEQUENCE_GAP","不能跳过未确认事件");
   bindReplicaLocation(db,e.aggregate_uid,origin,projectId);
   const prev=db.prepare("SELECT * FROM federation_replicas WHERE task_uid=?").get(e.aggregate_uid);
   if(prev&&(prev.owner_node_id!==origin||prev.origin_epoch!==epoch||prev.project_id!==projectId||e.aggregate_version<=prev.projection_version))throw conflict("VERSION_REGRESSION","副本身份或版本回退");
   let task=null;
   if(e.kind==="task.snapshot"){keys(e.payload,["task"],"payload");task=e.payload.task;validateTask(task,e);
    if(prev&&task.aggregate_version<prev.task_version)throw conflict("VERSION_REGRESSION","任务版本回退");}
   else if(e.kind==="task.withdrawn")keys(e.payload,[],"payload");
   else throw new PeerError("BAD_INPUT","未知事件类型");
   const now=new Date().toISOString();
   db.prepare("INSERT INTO federation_replicas VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_uid) DO UPDATE SET projection_version=excluded.projection_version,task_version=excluded.task_version,withdrawn=excluded.withdrawn,task_json=excluded.task_json,last_seq=excluded.last_seq,received_at=excluded.received_at")
    .run(e.aggregate_uid,origin,epoch,projectId,e.aggregate_version,task?.aggregate_version??prev?.task_version??0,Number(!task),task?canonical(task):null,e.seq,now);
   db.prepare("INSERT INTO federation_inbox VALUES(?,?,?,?,?,?)").run(e.event_id,origin,epoch,projectId,e.seq,eventDigest);
   resolveRecoveryMissing(db,e.aggregate_uid);
   current=e.seq;applied++;
  }
  const last=current?receivedCheckpoint(db,origin,epoch,projectId,current):null;
  const end=batch.events.at(-1)?.seq??batch.after_seq;
  const cp=end?receivedCheckpoint(db,origin,epoch,projectId,end):null;
  if(end ? batch.checkpoint?.seq!==end||batch.checkpoint?.event_digest!==cp?.event_digest : batch.checkpoint!==null)throw conflict("CONTENT_MISMATCH","批次末尾回执不匹配");
  db.prepare("INSERT INTO federation_cursors VALUES(?,?,?,?,?) ON CONFLICT(origin_node_id,project_id) DO UPDATE SET seq=excluded.seq,updated_at=excluded.updated_at").run(origin,projectId,epoch,current,new Date().toISOString());
  return {applied,cursor:current,checkpoint:last?{seq:current,event_digest:last.event_digest}:null,has_more:current<batch.head_seq||batch.pending_count>0};
 });}catch(e){
  // The rejected transaction is already rolled back; quarantine contains a digest, never task text.
  if(!db.isTransaction)db.prepare("INSERT OR IGNORE INTO federation_quarantine(origin_node_id,project_id,code,batch_digest,at) VALUES(?,?,?,?,?)").run(origin,projectId,e.code||"INTERNAL",safeDigest(batch),new Date().toISOString());
  throw e;
 }
}
export function receivedCheckpoint(db,origin,epoch,projectId,seq){
 return db.prepare("SELECT event_digest FROM federation_inbox WHERE origin_node_id=? AND origin_epoch=? AND project_id=? AND seq=? UNION ALL SELECT event_digest FROM federation_snapshot_anchors WHERE origin_node_id=? AND origin_epoch=? AND project_id=? AND seq=? LIMIT 1").get(origin,epoch,projectId,seq,origin,epoch,projectId,seq);
}
export function assertSourceEndpoint(db,nodeId,value){
 const base=endpoint(value),known=db.prepare("SELECT server_endpoint FROM federation_sources WHERE origin_node_id=?").get(nodeId);
 if(known?.server_endpoint&&known.server_endpoint!==base)throw conflict("SOURCE_ENDPOINT_CHANGED","来源已绑定另一地址；未发送凭据，不能隐式更换来源端点");return base;
}
export function recordSource(db,{node_id,display_name,sync_epoch},serverEndpoint=null){
 return atomic(db,()=>{
 uuid(node_id,"node_id");uuid(sync_epoch,"sync_epoch");
 assertSourceEpoch(db,node_id,sync_epoch);
 if(typeof display_name!=="string"||!display_name.trim()||display_name.length>80||/[\u0000-\u001f\u007f]/.test(display_name))throw new PeerError("BAD_INPUT","来源终端名无效");
 const bound=serverEndpoint===null?null:assertSourceEndpoint(db,node_id,serverEndpoint);
 const prior=db.prepare("SELECT origin_epoch FROM federation_sources WHERE origin_node_id=?").get(node_id);
 if(prior&&prior.origin_epoch!==sync_epoch)throw conflict("EPOCH_CHANGED","已登记来源 epoch 改变，需要恢复流程");
 db.prepare("INSERT INTO federation_sources(origin_node_id,origin_epoch,display_name,last_seen_at,server_endpoint) VALUES(?,?,?,?,?) ON CONFLICT(origin_node_id) DO UPDATE SET display_name=excluded.display_name,last_seen_at=excluded.last_seen_at,server_endpoint=coalesce(federation_sources.server_endpoint,excluded.server_endpoint)").run(node_id,sync_epoch,display_name,new Date().toISOString(),bound);
 });
}
export function listReplicas(db,{projectId}={}){
 if(projectId)project(projectId);
 const params=projectId?[projectId]:[];
 const rows=db.prepare("SELECT * FROM federation_replicas WHERE withdrawn=0"+(projectId?" AND project_id=?":"")+" ORDER BY owner_node_id,task_uid").all(...params);
 const missing=db.prepare("SELECT * FROM federation_recovery_missing WHERE resolved_at IS NULL"+(projectId?" AND project_id=?":"")).all(...params);
 return [...rows.map(r=>({r,missing:false})),...missing.map(x=>({r:JSON.parse(x.replica_json),missing:true}))].map(({r,missing})=>{
  const state=db.prepare("SELECT * FROM federation_epoch_projects WHERE origin_node_id=? AND project_id=?").get(r.owner_node_id,r.project_id);
  return {...JSON.parse(r.task_json),project_id:r.project_id,source_epoch:r.origin_epoch,source_seq:r.last_seq,received_at:r.received_at,read_only:true,
   recovery_state:missing?"missing_review":state?.state==="pending"?"pending_snapshot":null,
   accepted_source_epoch:db.prepare("SELECT origin_epoch FROM federation_sources WHERE origin_node_id=?").get(r.owner_node_id)?.origin_epoch??r.origin_epoch,
   owner_name:db.prepare("SELECT display_name FROM federation_sources WHERE origin_node_id=?").get(r.owner_node_id)?.display_name??r.owner_node_id,
   last_sync_at:db.prepare("SELECT updated_at FROM federation_cursors WHERE origin_node_id=? AND project_id=?").get(r.owner_node_id,r.project_id)?.updated_at??null};
 });
}
export function syncStatus(db){
 return {epoch_projects:db.prepare("SELECT * FROM federation_epoch_projects").all(),
  retired_epochs:db.prepare("SELECT * FROM federation_retired_epochs").all(),
  recovery_missing:db.prepare("SELECT task_uid,owner_node_id,origin_epoch,project_id,acceptance_id,resolved_at FROM federation_recovery_missing").all(),
  pending:db.prepare("SELECT s.project_id,count(*) AS tasks FROM federation_dirty d JOIN federation_shares s ON s.task_id=d.task_id GROUP BY s.project_id").all(),
  deliveries:db.prepare("SELECT * FROM federation_deliveries").all(),cursors:db.prepare("SELECT * FROM federation_cursors").all(),
  sources:db.prepare("SELECT * FROM federation_sources").all(),
  attempts:db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_sync_attempts'").get()?db.prepare("SELECT * FROM federation_sync_attempts").all():[],
  streams:db.prepare("SELECT project_id,seq AS head_seq FROM federation_streams").all(),
  snapshots:db.prepare("SELECT snapshot_id,project_id,head_seq,expires_at FROM federation_snapshots").all(),
  snapshot_staging:db.prepare("SELECT origin_node_id,project_id,snapshot_id,next_offset FROM federation_snapshot_staging").all(),
  retention:db.prepare("SELECT * FROM federation_retention").all(),
  quarantined:db.prepare("SELECT count(*) AS n FROM federation_quarantine").get().n};
}
