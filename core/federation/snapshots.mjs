// Authorized, frozen snapshots. Only a complete verified staging set can replace visible replicas.
import {assertSourceEpoch,replicationCursor,pendingRecovery,archiveRecoveryProject,bindReplicaLocation,resolveRecoveryMissing} from "./epoch-state.mjs";
import {randomUUID} from "node:crypto";
import {PeerError,uuid,names,keys,version} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {atomic,integer,allowed,canonical,digest,validateTask,taskUID,receivedCheckpoint,MAX_EVENT_BYTES,MAX_BATCH_BYTES} from "./sync-store.mjs";

export const MAX_SNAPSHOT_RECORDS=10000,MAX_SNAPSHOT_BYTES=32*1024*1024,SNAPSHOT_TTL_MS=15*60*1000;
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
const hash=value=>typeof value==="string"&&/^[0-9a-f]{64}$/.test(value);
const project=p=>names([p],"project_id",null,1)[0];
function exact(value,fields,label){keys(value,fields,label);if(Object.keys(value).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
function disposeSnapshot(db,id){
 db.prepare("DELETE FROM federation_snapshot_items WHERE snapshot_id=?").run(id);
 db.prepare("DELETE FROM federation_snapshot_offers WHERE snapshot_id=?").run(id);
 db.prepare("DELETE FROM federation_snapshots WHERE snapshot_id=?").run(id);
}
function sourceSnapshot(db,projectId,minSeq,now){
 const node=localIdentity(db),head=db.prepare("SELECT seq FROM federation_streams WHERE project_id=?").get(projectId)?.seq??0;
 const floor=db.prepare("SELECT floor_seq FROM federation_retention WHERE project_id=?").get(projectId)?.floor_seq??0;
 if(minSeq>head)fail("CURSOR_AHEAD","快照不能恢复到来源尚未发布的游标");
 const cached=db.prepare("SELECT * FROM federation_snapshots WHERE project_id=? AND head_seq>=? AND expires_at>? ORDER BY head_seq DESC LIMIT 1").get(projectId,Math.max(minSeq,floor),now);
 if(cached)return JSON.parse(cached.manifest_json);
 const events=[];let bytes=2;
 for(const row of db.prepare("SELECT event_json FROM federation_published WHERE project_id=? ORDER BY task_uid").iterate(projectId)){
  bytes+=Buffer.byteLength(row.event_json)+1;
  if(events.length>=MAX_SNAPSHOT_RECORDS||bytes>MAX_SNAPSHOT_BYTES)fail("SNAPSHOT_TOO_LARGE","项目快照超过 10000 条或 32 MiB",413);
  events.push(JSON.parse(row.event_json));
 }
 const checkpoint=head?db.prepare("SELECT seq,event_digest FROM federation_outbox WHERE project_id=? AND seq=?").get(projectId,head):null;
 if(head&&!checkpoint)fail("SNAPSHOT_INCONSISTENT","来源流缺少末尾摘要");
 const manifest={snapshot_version:1,snapshot_id:randomUUID(),origin_node_id:node.node_id,origin_epoch:node.sync_epoch,
  project_id:projectId,head_seq:head,checkpoint:checkpoint?{...checkpoint}:null,record_count:events.length,
  content_digest:digest(events),created_at:new Date(now).toISOString(),expires_at:new Date(now+SNAPSHOT_TTL_MS).toISOString()};
 db.prepare("INSERT INTO federation_snapshots VALUES(?,?,?,?,?)").run(manifest.snapshot_id,projectId,head,canonical(manifest),now+SNAPSHOT_TTL_MS);
 const insert=db.prepare("INSERT INTO federation_snapshot_items VALUES(?,?,?)");
 for(let i=0;i<events.length;i++)insert.run(manifest.snapshot_id,i,canonical(events[i]));
 // Keep at most two generations per project. An interrupted client can safely start again.
 for(const row of db.prepare("SELECT snapshot_id FROM federation_snapshots WHERE project_id=? ORDER BY rowid DESC LIMIT -1 OFFSET 2").all(projectId))disposeSnapshot(db,row.snapshot_id);
 return manifest;
}
export function startSnapshot(db,peer,{project_id:projectId,min_seq:minSeq=0},{now=Date.now()}={}){
 allowed(peer,projectId,"sync:pull");integer(minSeq,"min_seq");integer(now,"now");
 return atomic(db,()=>{
  const manifest=sourceSnapshot(db,projectId,minSeq,now);
  db.prepare("INSERT OR IGNORE INTO federation_snapshot_offers VALUES(?,?,?)").run(peer.peer_node_id,peer.peer_epoch,manifest.snapshot_id);
  return manifest;
 });
}
export function snapshotPage(db,peer,{project_id:projectId,snapshot_id:id,offset},{now=Date.now()}={}){
 allowed(peer,projectId,"sync:pull");uuid(id,"snapshot_id");integer(offset,"offset");
 return atomic(db,()=>{
  localIdentity(db);
  const offer=db.prepare("SELECT 1 FROM federation_snapshot_offers WHERE peer_node_id=? AND peer_epoch=? AND snapshot_id=?").get(peer.peer_node_id,peer.peer_epoch,id);
  const s=db.prepare("SELECT * FROM federation_snapshots WHERE snapshot_id=? AND project_id=?").get(id,projectId);
  if(!offer||!s)fail("SNAPSHOT_EXPIRED","快照不可用，请重新取得授权清单",410);
  if(s.expires_at<=now)fail("SNAPSHOT_EXPIRED","快照已过期",410);
  const manifest=JSON.parse(s.manifest_json);if(offset>manifest.record_count)fail("BAD_INPUT","分页偏移超限",400);
  const events=[];let bytes=2048;
  for(const r of db.prepare("SELECT event_json FROM federation_snapshot_items WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT 25").all(id,offset)){
   if(bytes+Buffer.byteLength(r.event_json)>MAX_BATCH_BYTES)break;
   events.push(JSON.parse(r.event_json));bytes+=Buffer.byteLength(r.event_json);
  }
  const next=offset+events.length,done=next===manifest.record_count;
  if(done)db.prepare("INSERT INTO federation_deliveries(peer_node_id,peer_epoch,project_id,offered_seq) VALUES(?,?,?,?) ON CONFLICT(peer_node_id,peer_epoch,project_id) DO UPDATE SET offered_seq=MAX(offered_seq,excluded.offered_seq)").run(peer.peer_node_id,peer.peer_epoch,projectId,manifest.head_seq);
  const page={snapshot_id:id,offset,next_offset:next,done,events};
  return {...page,page_digest:digest(page)};
 });
}
export function validateManifest(m,{origin,epoch,projectId}){
 exact(m,["snapshot_version","snapshot_id","origin_node_id","origin_epoch","project_id","head_seq","checkpoint","record_count","content_digest","created_at","expires_at"],"snapshot");
 uuid(m.snapshot_id,"snapshot_id");uuid(origin,"origin");uuid(epoch,"epoch");project(projectId);
 if(m.snapshot_version!==1||m.origin_node_id!==origin||m.origin_epoch!==epoch||m.project_id!==projectId)fail("SOURCE_MISMATCH","快照来源、项目或协议不匹配");
 integer(m.head_seq,"head_seq");integer(m.record_count,"record_count");
 if(m.record_count>m.head_seq||m.record_count>MAX_SNAPSHOT_RECORDS||!hash(m.content_digest)||!Number.isFinite(Date.parse(m.created_at))||!Number.isFinite(Date.parse(m.expires_at))||Date.parse(m.expires_at)<=Date.parse(m.created_at))fail("BAD_INPUT","快照清单无效",400);
 if(m.head_seq){
  exact(m.checkpoint,["seq","event_digest"],"checkpoint");
  if(m.checkpoint.seq!==m.head_seq||!hash(m.checkpoint.event_digest))fail("CONTENT_MISMATCH","快照游标摘要不匹配");
 }else if(m.checkpoint!==null||m.record_count!==0)fail("CONTENT_MISMATCH","空流快照无效");
}
function validateEvent(e,m){
 exact(e,["schema_version","event_id","origin_node_id","origin_epoch","project_id","seq","aggregate_uid","aggregate_version","kind","payload","payload_digest","event_digest"],"snapshot event");
 uuid(e.event_id,"event_id");version(e.seq);version(e.aggregate_version);taskUID(e.aggregate_uid,m.origin_node_id);
 if(e.schema_version!==1||e.origin_node_id!==m.origin_node_id||e.origin_epoch!==m.origin_epoch||e.project_id!==m.project_id||e.seq>m.head_seq)fail("SOURCE_MISMATCH","快照记录来源或序号不匹配");
 const {event_digest,...rest}=e;
 if(event_digest!==digest(rest)||e.payload_digest!==digest(e.payload)||Buffer.byteLength(canonical(e))>MAX_EVENT_BYTES)fail("CONTENT_MISMATCH","快照记录摘要或大小无效");
 if(e.kind==="task.snapshot"){exact(e.payload,["task"],"payload");validateTask(e.payload.task,e);}
 else if(e.kind==="task.withdrawn")exact(e.payload,[],"payload");
 else fail("BAD_INPUT","未知快照记录类型",400);
}
export function snapshotStage(db,{origin,projectId}){
 const s=db.prepare("SELECT * FROM federation_snapshot_staging WHERE origin_node_id=? AND project_id=?").get(origin,projectId);
 return s?{manifest:JSON.parse(s.manifest_json),next_offset:s.next_offset}:null;
}
export function discardSnapshotStage(db,{origin,projectId}){
 return atomic(db,()=>{
  const s=snapshotStage(db,{origin,projectId});
  if(s)db.prepare("DELETE FROM federation_snapshot_received WHERE snapshot_id=?").run(s.manifest.snapshot_id);
  db.prepare("DELETE FROM federation_snapshot_staging WHERE origin_node_id=? AND project_id=?").run(origin,projectId);
 });
}
export function beginSnapshot(db,source,manifest){
 validateManifest(manifest,source);
 return atomic(db,()=>{
  if(localIdentity(db).node_id===source.origin)fail("OWNER_MISMATCH","远端快照不能覆盖本机");
  const current=replicationCursor(db,source.origin,source.epoch,source.projectId);
  const known=db.prepare("SELECT origin_epoch FROM federation_sources WHERE origin_node_id=?").get(source.origin);
  if(known&&known.origin_epoch!==source.epoch)fail("EPOCH_CHANGED","来源恢复需要显式重新绑定");
  if(manifest.head_seq<current)fail("VERSION_REGRESSION","快照游标落后于本机已接收状态");
  const previous=snapshotStage(db,source);
  if(previous?.manifest.snapshot_id===manifest.snapshot_id){
   if(canonical(previous.manifest)!==canonical(manifest))fail("CONTENT_MISMATCH","同一快照清单被改写");
   return previous;
  }
  discardSnapshotStage(db,source);
  db.prepare("INSERT INTO federation_snapshot_staging(origin_node_id,project_id,origin_epoch,snapshot_id,manifest_json) VALUES(?,?,?,?,?)").run(source.origin,source.projectId,source.epoch,manifest.snapshot_id,canonical(manifest));
  return snapshotStage(db,source);
 });
}
function installSnapshot(db,m,events){
 const boundary=events.find(e=>e.seq===m.head_seq);
 if(m.head_seq&&boundary?.event_digest!==m.checkpoint.event_digest)fail("CONTENT_MISMATCH","快照必须包含与末尾摘要一致的最终事件");
 const current=replicationCursor(db,m.origin_node_id,m.origin_epoch,m.project_id);
 if(current>m.head_seq)fail("VERSION_REGRESSION","下载期间副本已前进，拒绝旧快照");
 const priorAnchor=receivedCheckpoint(db,m.origin_node_id,m.origin_epoch,m.project_id,m.head_seq);
 if(priorAnchor&&priorAnchor.event_digest!==m.checkpoint?.event_digest)fail("CONTENT_MISMATCH","相同游标的快照摘要冲突");
 const source={origin:m.origin_node_id,epoch:m.origin_epoch,projectId:m.project_id};
 const recovering=pendingRecovery(db,source);
 for(const e of events)bindReplicaLocation(db,e.aggregate_uid,m.origin_node_id,m.project_id);
 const existing=recovering?[]:db.prepare("SELECT * FROM federation_replicas WHERE owner_node_id=? AND project_id=?").all(m.origin_node_id,m.project_id),byId=new Map(events.map(e=>[e.aggregate_uid,e]));
 for(const prev of existing){
  const e=byId.get(prev.task_uid);
  if(!e||prev.origin_epoch!==m.origin_epoch||e.aggregate_version<prev.projection_version||
    (e.kind==="task.snapshot"&&e.payload.task.aggregate_version<prev.task_version))fail("VERSION_REGRESSION","快照缺少已接收任务或回退任务版本");
  if(e.aggregate_version===prev.projection_version&&((e.kind==="task.withdrawn")!==Boolean(prev.withdrawn)||e.kind==="task.snapshot"&&canonical(e.payload.task)!==prev.task_json))fail("CONTENT_MISMATCH","同一发布版本的快照内容不同");
 }
 archiveRecoveryProject(db,source,events);
 const now=new Date().toISOString(),insert=db.prepare("INSERT INTO federation_replicas VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_uid) DO UPDATE SET projection_version=excluded.projection_version,task_version=excluded.task_version,withdrawn=excluded.withdrawn,task_json=excluded.task_json,last_seq=excluded.last_seq,received_at=excluded.received_at");
 for(const e of events){
  const seen=db.prepare("SELECT event_digest FROM federation_inbox WHERE event_id=? OR (origin_node_id=? AND origin_epoch=? AND project_id=? AND seq=?)").all(e.event_id,m.origin_node_id,m.origin_epoch,m.project_id,e.seq);
  if(seen.some(r=>r.event_digest!==e.event_digest))fail("CONTENT_MISMATCH","快照与已经接收的事件身份冲突");
  const prev=db.prepare("SELECT * FROM federation_replicas WHERE task_uid=?").get(e.aggregate_uid),t=e.payload.task??null;
  if(prev&&(prev.owner_node_id!==m.origin_node_id||prev.origin_epoch!==m.origin_epoch||prev.project_id!==m.project_id))fail("OWNER_MISMATCH","快照任务与其他来源冲突");
  db.prepare("INSERT OR IGNORE INTO federation_inbox VALUES(?,?,?,?,?,?)").run(e.event_id,m.origin_node_id,m.origin_epoch,m.project_id,e.seq,e.event_digest);
  resolveRecoveryMissing(db,e.aggregate_uid);
  insert.run(e.aggregate_uid,m.origin_node_id,m.origin_epoch,m.project_id,e.aggregate_version,t?.aggregate_version??prev?.task_version??0,Number(!t),t?canonical(t):null,e.seq,now);
 }
 db.prepare("INSERT INTO federation_snapshot_anchors VALUES(?,?,?,?,?,?,?) ON CONFLICT(origin_node_id,project_id) DO UPDATE SET origin_epoch=excluded.origin_epoch,seq=excluded.seq,event_digest=excluded.event_digest,snapshot_id=excluded.snapshot_id,content_digest=excluded.content_digest")
  .run(m.origin_node_id,m.project_id,m.origin_epoch,m.head_seq,m.checkpoint?.event_digest??null,m.snapshot_id,m.content_digest);
 db.prepare("INSERT INTO federation_cursors VALUES(?,?,?,?,?) ON CONFLICT(origin_node_id,project_id) DO UPDATE SET origin_epoch=excluded.origin_epoch,seq=excluded.seq,updated_at=excluded.updated_at").run(m.origin_node_id,m.project_id,m.origin_epoch,m.head_seq,now);
 discardSnapshotStage(db,{origin:m.origin_node_id,projectId:m.project_id});
 return {installed:true,records:events.length,cursor:m.head_seq,checkpoint:m.checkpoint};
}
export function receiveSnapshotPage(db,source,page){
 try{return atomic(db,()=>{
  localIdentity(db);assertSourceEpoch(db,source.origin,source.epoch);
  const staged=snapshotStage(db,source);if(!staged)fail("SNAPSHOT_MISSING","没有待下载快照");
  const m=staged.manifest;validateManifest(m,source);
  exact(page,["snapshot_id","offset","next_offset","done","events","page_digest"],"page");
  integer(page.offset,"offset");integer(page.next_offset,"next_offset");
  const {page_digest,...unsigned}=page;
  if(page.snapshot_id!==m.snapshot_id||page_digest!==digest(unsigned)||!Array.isArray(page.events)||page.events.length>25||Buffer.byteLength(canonical(page))>MAX_BATCH_BYTES)fail("CONTENT_MISMATCH","快照页身份、摘要或大小无效");
  if(page.next_offset!==page.offset+page.events.length||page.next_offset>m.record_count||page.done!==(page.next_offset===m.record_count)||(!page.done&&!page.events.length))fail("SEQUENCE_GAP","快照页范围或完成状态无效");
  if(page.offset<staged.next_offset){
   if(page.next_offset>staged.next_offset)fail("SEQUENCE_GAP","快照页部分重叠");
   for(let i=0;i<page.events.length;i++){
    const r=db.prepare("SELECT event_json FROM federation_snapshot_received WHERE snapshot_id=? AND ordinal=?").get(m.snapshot_id,page.offset+i);
    if(r?.event_json!==canonical(page.events[i]))fail("CONTENT_MISMATCH","重复快照页内容改变");
   }
   return {installed:false,next_offset:staged.next_offset,duplicate:true};
  }
  if(page.offset!==staged.next_offset)fail("SEQUENCE_GAP","快照页缺口");
  let previous=db.prepare("SELECT task_uid FROM federation_snapshot_received WHERE snapshot_id=? ORDER BY ordinal DESC LIMIT 1").get(m.snapshot_id)?.task_uid;
  let bytes=db.prepare("SELECT received_bytes FROM federation_snapshot_staging WHERE snapshot_id=?").get(m.snapshot_id).received_bytes;
  const put=db.prepare("INSERT INTO federation_snapshot_received VALUES(?,?,?,?,?,?)");
  for(let i=0;i<page.events.length;i++){
   const e=page.events[i];validateEvent(e,m);
   if(db.prepare("SELECT 1 FROM federation_snapshot_received WHERE snapshot_id=? AND (event_id=? OR seq=?)").get(m.snapshot_id,e.event_id,e.seq))fail("CONTENT_MISMATCH","快照事件身份或序号重复");
   if(previous&&e.aggregate_uid<=previous)fail("SEQUENCE_GAP","快照任务必须严格排序且不能重复");
   const text=canonical(e);bytes+=Buffer.byteLength(text)+1;
   if(bytes+2>MAX_SNAPSHOT_BYTES)fail("SNAPSHOT_TOO_LARGE","快照总量超限",413);
   put.run(m.snapshot_id,page.offset+i,e.aggregate_uid,text,e.event_id,e.seq);previous=e.aggregate_uid;
  }
  db.prepare("UPDATE federation_snapshot_staging SET next_offset=?,received_bytes=? WHERE snapshot_id=?").run(page.next_offset,bytes,m.snapshot_id);
  if(!page.done)return {installed:false,next_offset:page.next_offset};
  const events=db.prepare("SELECT event_json FROM federation_snapshot_received WHERE snapshot_id=? ORDER BY ordinal").all(m.snapshot_id).map(r=>JSON.parse(r.event_json));
  if(events.length!==m.record_count||digest(events)!==m.content_digest)fail("CONTENT_MISMATCH","完整快照摘要不匹配");
  return installSnapshot(db,m,events);
 });}catch(e){
  if(!db.isTransaction){
   let receipt;try{receipt=digest(page);}catch{receipt=digest({invalid:true});}
   db.prepare("INSERT OR IGNORE INTO federation_quarantine(origin_node_id,project_id,code,batch_digest,at) VALUES(?,?,?,?,?)").run(source.origin,source.projectId,e.code||"INTERNAL",receipt,new Date().toISOString());
  }
  throw e;
 }
}
/** Local administration only. No scheduled deletion and no peer endpoint. */
export function pruneHistory(db,{projectId,throughSeq,expectedHead,allowLagging=false}){
 project(projectId);version(throughSeq);version(expectedHead);
 if(typeof allowLagging!=="boolean")fail("BAD_INPUT","allowLagging 必须为布尔值",400);
 return atomic(db,()=>{
  localIdentity(db);
  const head=db.prepare("SELECT seq FROM federation_streams WHERE project_id=?").get(projectId)?.seq??0;
  const floor=db.prepare("SELECT floor_seq FROM federation_retention WHERE project_id=?").get(projectId)?.floor_seq??0;
  if(head!==expectedHead||throughSeq>head||throughSeq<floor)fail("CONFLICT","流末尾或清理边界已改变");
  const peers=db.prepare("SELECT peer_node_id,peer_epoch,projects_json,scopes_json FROM federation_peers WHERE status='active'").all().filter(p=>JSON.parse(p.projects_json).includes(projectId)&&JSON.parse(p.scopes_json).includes("sync:pull"));
  const lagging=peers.filter(p=>(db.prepare("SELECT acked_seq FROM federation_deliveries WHERE peer_node_id=? AND peer_epoch=? AND project_id=?").get(p.peer_node_id,p.peer_epoch,projectId)?.acked_seq??0)<throughSeq);
  if(lagging.length&&!allowLagging)fail("UNACKNOWLEDGED","仍有对端未确认；仅显式允许压缩为快照后才能清理");
  const snapshot=sourceSnapshot(db,projectId,throughSeq,Date.now());
  // SQLite transactional DDL: the deletion guard is never absent outside this transaction.
  db.exec("DROP TRIGGER federation_outbox_no_delete");
  const removed=db.prepare("DELETE FROM federation_outbox WHERE project_id=? AND seq<?").run(projectId,throughSeq).changes;
  db.exec("CREATE TRIGGER federation_outbox_no_delete BEFORE DELETE ON federation_outbox BEGIN SELECT RAISE(ABORT,'published event retention is not enabled'); END");
  db.prepare("INSERT INTO federation_retention VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET floor_seq=excluded.floor_seq").run(projectId,throughSeq);
  db.prepare("INSERT INTO federation_retention_events(project_id,floor_seq,head_seq,snapshot_id,deleted_count,lagging_peer_count,at) VALUES(?,?,?,?,?,?,?)").run(projectId,throughSeq,head,snapshot.snapshot_id,removed,lagging.length,new Date().toISOString());
  return {project_id:projectId,floor_seq:throughSeq,head_seq:head,snapshot_id:snapshot.snapshot_id,deleted_count:removed,lagging_peer_count:lagging.length};
 });
}
