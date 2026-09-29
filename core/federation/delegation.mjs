// Durable bilateral delegation proposals. Confirmation/execution is a separate protocol.
import {createRequire} from "node:module";
import {PeerError,keys,uuid,names,version} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
import {canonical,digest,taskUID} from "./sync-store.mjs";
import {migrateBroker} from "../mcp/policy.mjs";
const require=createRequire(import.meta.url),store=require("../store.js"),bindingGuard=require("../delegation_guard.js");
export const MAX_OFFER_BYTES=120*1024,MAX_OPEN_OFFERS=1000;
const at=()=>new Date().toISOString();
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
function text(x,label,max,{nonempty=false}={}){if(typeof x!=="string"||x.length>max||nonempty&&!x.trim()||/[\u0000]/.test(x))fail("BAD_INPUT",label+" 文本无效",400);return x;}
const project=x=>names([x],"project_id",null,1)[0];
function unit(db,fn){
 if(!db.isTransaction)return transaction(db,fn);
 db.exec("SAVEPOINT delegation_unit");
 try{const out=fn();db.exec("RELEASE delegation_unit");return out;}catch(e){db.exec("ROLLBACK TO delegation_unit; RELEASE delegation_unit");throw e;}
}
export function migrateDelegation(db){
 return unit(db,()=>{
  localIdentity(db);
  if(!db.prepare("PRAGMA table_info(tasks)").all().some(c=>c.name==="tree_mode"))fail("SCHEMA_INCOMPATIBLE","请先更新本机任务存储格式");
  migrateBroker(db);
  db.exec("CREATE TABLE IF NOT EXISTS federation_delegation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO federation_delegation_schema VALUES(1,1)");
  if(db.prepare("SELECT version FROM federation_delegation_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","委派存储格式不兼容");
  db.exec([
   "CREATE TABLE IF NOT EXISTS delegation_outgoing(delegation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_task_uid TEXT NOT NULL,target_node_id TEXT NOT NULL,target_epoch TEXT NOT NULL,request_digest TEXT NOT NULL,offer_digest TEXT NOT NULL,offer_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','received','accepted_unconfirmed','rejected')),receipt_version INTEGER NOT NULL DEFAULT 0,receipt_json TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_attempt_at TEXT,last_error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS delegation_incoming(delegation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_node_id TEXT NOT NULL,source_epoch TEXT NOT NULL,offer_digest TEXT NOT NULL,offer_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('received','accepted_unconfirmed','rejected')),version INTEGER NOT NULL CHECK(version IN(1,2)),target_task_id INTEGER UNIQUE,target_task_uid TEXT UNIQUE,decision_id TEXT,decision_digest TEXT,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS delegation_events(id INTEGER PRIMARY KEY,delegation_id TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN('outgoing','incoming')),kind TEXT NOT NULL,detail_json TEXT NOT NULL,at TEXT NOT NULL);",
   "CREATE INDEX IF NOT EXISTS delegation_incoming_project_state ON delegation_incoming(project_id,state);",
   "CREATE INDEX IF NOT EXISTS delegation_outgoing_project_state ON delegation_outgoing(project_id,state);",
   "CREATE TRIGGER IF NOT EXISTS delegation_outgoing_identity BEFORE UPDATE OF delegation_id,project_id,source_task_uid,target_node_id,target_epoch,request_digest,offer_digest,offer_json,created_at ON delegation_outgoing BEGIN SELECT RAISE(ABORT,'delegation outgoing identity is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_incoming_identity BEFORE UPDATE OF delegation_id,project_id,source_node_id,source_epoch,offer_digest,offer_json,created_at ON delegation_incoming BEGIN SELECT RAISE(ABORT,'delegation incoming identity is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_decision_once BEFORE UPDATE OF state,version,target_task_id,target_task_uid,decision_id,decision_digest,note ON delegation_incoming WHEN OLD.state<>'received' BEGIN SELECT RAISE(ABORT,'delegation decision is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_events_immutable BEFORE UPDATE ON delegation_events BEGIN SELECT RAISE(ABORT,'delegation event is immutable'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_events_retained BEFORE DELETE ON delegation_events BEGIN SELECT RAISE(ABORT,'delegation event retention is not enabled'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_outgoing_retained BEFORE DELETE ON delegation_outgoing BEGIN SELECT RAISE(ABORT,'delegation retention is not enabled'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_incoming_retained BEFORE DELETE ON delegation_incoming BEGIN SELECT RAISE(ABORT,'delegation retention is not enabled'); END;",
   // No confirmation mechanism is exposed in this schema. Neither a release button nor SQL claim bypasses the hold.
   "CREATE TRIGGER IF NOT EXISTS delegation_unconfirmed_execution BEFORE UPDATE OF released,status ON tasks WHEN (NEW.released=1 OR NEW.status IN('in_progress','done')) AND EXISTS(SELECT 1 FROM delegation_incoming i WHERE i.target_task_id=NEW.id AND i.state='accepted_unconfirmed') BEGIN SELECT RAISE(ABORT,'DELEGATION_UNCONFIRMED: relation confirmation is required'); END;",
   "CREATE TRIGGER IF NOT EXISTS delegation_target_retained BEFORE DELETE ON tasks WHEN EXISTS(SELECT 1 FROM delegation_incoming i WHERE i.target_task_id=OLD.id) BEGIN SELECT RAISE(ABORT,'delegated task identity must be retained'); END;"
  ].join("\n"));
 });
}
function event(db,id,direction,kind,detail={}){db.prepare("INSERT INTO delegation_events(delegation_id,direction,kind,detail_json,at) VALUES(?,?,?,?,?)").run(id,direction,kind,canonical(detail),at());}
export function validateOffer(o){
 exact(o,["schema_version","delegation_id","project_id","source_node_id","source_epoch","source_task_uid","source_task_version","target_node_id","target_epoch","task"],"offer");
 if(o.schema_version!==1)fail("SCHEMA_INCOMPATIBLE","委派协议不兼容");
 for(const k of ["delegation_id","source_node_id","source_epoch","target_node_id","target_epoch"])uuid(o[k],k);
 project(o.project_id);taskUID(o.source_task_uid,o.source_node_id);version(o.source_task_version);
 if(o.source_node_id===o.target_node_id)fail("IDENTITY_CONFLICT","跨端委派不能指向本机");
 exact(o.task,["subject","description","acceptance","work_kind","capabilities"],"offer.task");
 text(o.task.subject,"subject",500,{nonempty:true});text(o.task.description,"description",16384);text(o.task.acceptance,"acceptance",16384);
 if(!["implement","review"].includes(o.task.work_kind))fail("BAD_INPUT","工作种类无效",400);
 names(o.task.capabilities,"capabilities");
 if(Buffer.byteLength(canonical(o))>MAX_OFFER_BYTES)fail("TOO_LARGE","委派合同超过 120 KiB",413);
 return o;
}
function currentSource(db,o){const n=localIdentity(db);if(n.node_id!==o.source_node_id||n.sync_epoch!==o.source_epoch)fail("EPOCH_CHANGED","来源节点身份或代次已变化");return n;}
function currentTarget(db,o){const n=localIdentity(db);if(n.node_id!==o.target_node_id||n.sync_epoch!==o.target_epoch)fail("EPOCH_CHANGED","目标节点身份或代次已变化");return n;}
function sourcePeer(db,o){
 const p=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(o.source_node_id);
 if(!p||p.status!=="active"||p.peer_epoch!==o.source_epoch||!JSON.parse(p.projects_json).includes(o.project_id)||!JSON.parse(p.scopes_json).includes("delegation:offer"))fail("SOURCE_REVOKED","来源的委派授权已失效",403);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_retired_epochs'").get()&&db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(o.source_node_id,o.source_epoch))fail("RETIRED_EPOCH","来源代次已退役",403);
}
function peerForOffer(peer,o,scope){
 if(!peer.scopes.includes(scope)||!peer.projects.includes(o.project_id))fail("FORBIDDEN","该项目的委派权限不足",403);
 if(peer.peer_node_id!==o.source_node_id||peer.peer_epoch!==o.source_epoch)fail("IDENTITY_MISMATCH","来源身份与凭据绑定不一致",403);
}
const outgoingRow=(db,id)=>{uuid(id,"delegation_id");const r=db.prepare("SELECT * FROM delegation_outgoing WHERE delegation_id=?").get(id);if(!r)fail("NOT_FOUND","未找到来源委派",404);return r;};
const incomingRow=(db,id)=>{uuid(id,"delegation_id");const r=db.prepare("SELECT * FROM delegation_incoming WHERE delegation_id=?").get(id);if(!r)fail("NOT_FOUND","未找到接收委派",404);return r;};
export function outgoingStatus(db,id){
 const n=localIdentity(db),r=outgoingRow(db,id),o=JSON.parse(r.offer_json);
 return {binding:bindingGuard.projection(db,id),identity_current:n.node_id===o.source_node_id&&n.sync_epoch===o.source_epoch,delegation_id:id,project_id:r.project_id,state:r.state,offer:JSON.parse(r.offer_json),offer_digest:r.offer_digest,receipt:r.receipt_json?JSON.parse(r.receipt_json):null,attempts:r.attempts,last_error_code:r.last_error_code,dispatch_ready:false};
}
export function incomingStatus(db,id){const n=localIdentity(db),r=incomingRow(db,id),o=JSON.parse(r.offer_json);return {binding:bindingGuard.projection(db,id),identity_current:n.node_id===o.target_node_id&&n.sync_epoch===o.target_epoch,offer:o,receipt:receipt(r),target_task_id:r.target_task_id};}
function receipt(r){const o=JSON.parse(r.offer_json);return {schema_version:1,delegation_id:r.delegation_id,project_id:r.project_id,offer_digest:r.offer_digest,source_node_id:o.source_node_id,source_epoch:o.source_epoch,target_node_id:o.target_node_id,target_epoch:o.target_epoch,version:r.version,state:r.state,target_task_uid:r.target_task_uid,note:r.note,dispatch_ready:false};}
export function listDelegations(db,{direction,projectId,limit=100}){
 localIdentity(db);project(projectId);if(!["incoming","outgoing"].includes(direction)||!Number.isInteger(limit)||limit<1||limit>1000)fail("BAD_INPUT","委派列表参数无效",400);
 return db.prepare("SELECT delegation_id,project_id,state,created_at,updated_at FROM delegation_"+direction+" WHERE project_id=? ORDER BY created_at DESC,delegation_id LIMIT ?").all(projectId,limit);
}
/** Explicit local proposal captures only the admitted card's public work contract. */
export function createIntent(db,args){
 exact(args,["delegationId","taskUid","expectedVersion","targetNodeId","targetEpoch"],"intent");
 uuid(args.delegationId,"delegation_id");uuid(args.targetNodeId,"target_node_id");uuid(args.targetEpoch,"target_epoch");version(args.expectedVersion);
 return unit(db,()=>{
  const node=localIdentity(db);taskUID(args.taskUid,node.node_id);const requestDigest=digest(args);
  const old=db.prepare("SELECT * FROM delegation_outgoing WHERE delegation_id=?").get(args.delegationId);
  if(old){currentSource(db,JSON.parse(old.offer_json));if(old.request_digest!==requestDigest)fail("REQUEST_CONFLICT","委派 ID 已绑定其他合同");return outgoingStatus(db,args.delegationId);}
  const t=db.prepare("SELECT t.*,p.project_id,p.work_kind,p.capabilities_json FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE t.task_uid=?").get(args.taskUid);
  if(!t||t.owner_node_id!==node.node_id)fail("NOT_FOUND","本机未登记该项目任务",404);
  if(t.aggregate_version!==args.expectedVersion||t.status==="done"||t.archived_at)fail("CONFLICT","任务版本已变化或已关闭");
  const o=validateOffer({schema_version:1,delegation_id:args.delegationId,project_id:t.project_id,source_node_id:node.node_id,source_epoch:node.sync_epoch,source_task_uid:t.task_uid,source_task_version:t.aggregate_version,target_node_id:args.targetNodeId,target_epoch:args.targetEpoch,task:{subject:t.subject,description:t.description,acceptance:t.acceptance,work_kind:t.work_kind,capabilities:JSON.parse(t.capabilities_json)}});
  if(db.prepare("SELECT count(*) n FROM delegation_outgoing WHERE project_id=? AND state<>'rejected'").get(o.project_id).n>=MAX_OPEN_OFFERS)fail("QUEUE_LIMIT","项目待处理委派已达到上限");
  const ts=at();db.prepare("INSERT INTO delegation_outgoing(delegation_id,project_id,source_task_uid,target_node_id,target_epoch,request_digest,offer_digest,offer_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)")
   .run(o.delegation_id,o.project_id,o.source_task_uid,o.target_node_id,o.target_epoch,requestDigest,digest(o),canonical(o),ts,ts);
  event(db,o.delegation_id,"outgoing","proposed",{offer_digest:digest(o)});return outgoingStatus(db,o.delegation_id);
 });
}
/** The gateway re-authenticates inside its write lock before calling this function. */
export function receiveOffer(db,peer,offer){
 validateOffer(offer);
 return unit(db,()=>{
  currentTarget(db,offer);peerForOffer(peer,offer,"delegation:offer");sourcePeer(db,offer);
  const old=db.prepare("SELECT * FROM delegation_incoming WHERE delegation_id=?").get(offer.delegation_id);
  if(old){if(old.source_node_id!==peer.peer_node_id||old.source_epoch!==peer.peer_epoch)fail("NOT_FOUND","未找到该来源的委派",404);if(old.offer_digest!==digest(offer))fail("REQUEST_CONFLICT","相同委派 ID 的合同不同");return receipt(old);}
  if(db.prepare("SELECT count(*) n FROM delegation_incoming WHERE project_id=? AND state<>'rejected'").get(offer.project_id).n>=MAX_OPEN_OFFERS)fail("QUEUE_LIMIT","接收队列已达到上限");
  const ts=at();db.prepare("INSERT INTO delegation_incoming(delegation_id,project_id,source_node_id,source_epoch,offer_digest,offer_json,state,version,created_at,updated_at) VALUES(?,?,?,?,?,?,'received',1,?,?)")
   .run(offer.delegation_id,offer.project_id,offer.source_node_id,offer.source_epoch,digest(offer),canonical(offer),ts,ts);
  event(db,offer.delegation_id,"incoming","received",{offer_digest:digest(offer)});return receipt(incomingRow(db,offer.delegation_id));
 });
}
export function peerDelegationStatus(db,peer,args){
 exact(args,["delegation_id","project_id"],"delegation status");uuid(args.delegation_id,"delegation_id");project(args.project_id);
 return unit(db,()=>{
  const r=incomingRow(db,args.delegation_id),o=JSON.parse(r.offer_json);
  if(r.project_id!==args.project_id||r.source_node_id!==peer.peer_node_id||r.source_epoch!==peer.peer_epoch)fail("NOT_FOUND","授权范围内未找到委派",404);
  peerForOffer(peer,o,"delegation:status");currentTarget(db,o);return receipt(r);
 });
}
/** Local coordinator decision only. Acceptance creates a target-owned, unconfirmed task atomically. */
export function decideIncoming(db,args){
 exact(args,["delegationId","decisionId","expectedVersion","decision","note"],"decision");uuid(args.delegationId,"delegation_id");uuid(args.decisionId,"decision_id");version(args.expectedVersion);text(args.note,"note",512);
 if(!["accept","reject"].includes(args.decision))fail("BAD_INPUT","决定必须是 accept 或 reject",400);
 return unit(db,()=>{
  const r=incomingRow(db,args.delegationId),o=JSON.parse(r.offer_json);currentTarget(db,o);sourcePeer(db,o);
  const d=digest(args);
  if(r.decision_id===args.decisionId){if(r.decision_digest!==d)fail("REQUEST_CONFLICT","决定 ID 已绑定不同内容");return receipt(r);}
  if(r.version!==args.expectedVersion||r.state!=="received")fail("CONFLICT","委派已由另一决定处理");
  let id=null,uid=null;
  if(args.decision==="accept"){
   id=store.add(db,{subject:o.task.subject,description:o.task.description,acceptance:o.task.acceptance,treeMode:"hierarchical",kind:"task",released:0,route:"mcp",actor:"delegation:"+o.delegation_id});
   const t=store.get(db,id);uid=t.task_uid;
   db.prepare("INSERT INTO broker_task_projects VALUES(?,?,?,?,?)").run(id,uid,o.project_id,o.task.work_kind,canonical([...o.task.capabilities].sort()));
  }
  db.prepare("UPDATE delegation_incoming SET state=?,version=2,target_task_id=?,target_task_uid=?,decision_id=?,decision_digest=?,note=?,updated_at=? WHERE delegation_id=?")
   .run(id===null?"rejected":"accepted_unconfirmed",id,uid,args.decisionId,d,args.note,at(),args.delegationId);
  event(db,args.delegationId,"incoming",args.decision,{target_task_uid:uid,decision_id:args.decisionId});return receipt(incomingRow(db,args.delegationId));
 });
}
export function recordReceipt(db,id,response){
 exact(response,["schema_version","delegation_id","project_id","offer_digest","source_node_id","source_epoch","target_node_id","target_epoch","version","state","target_task_uid","note","dispatch_ready"],"receipt");
 return unit(db,()=>{
  const r=outgoingRow(db,id),o=JSON.parse(r.offer_json);currentSource(db,o);
  if(response.schema_version!==1||response.dispatch_ready!==false||response.offer_digest!==r.offer_digest||response.delegation_id!==id||["project_id","source_node_id","source_epoch","target_node_id","target_epoch"].some(k=>response[k]!==o[k]))fail("RECEIPT_MISMATCH","委派回执未绑定原合同与双方身份");
  text(response.note,"note",512);
  if(response.state==="received"){if(response.version!==1||response.target_task_uid!==null||response.note!=="")fail("BAD_RECEIPT","未决定回执无效");}
  else if(["accepted_unconfirmed","rejected"].includes(response.state)){
   if(response.version!==2)fail("BAD_RECEIPT","决定版本无效");
   if(response.state==="accepted_unconfirmed")taskUID(response.target_task_uid,o.target_node_id);
   else if(response.target_task_uid!==null)fail("BAD_RECEIPT","拒绝回执不能绑定执行任务");
  }else fail("BAD_RECEIPT","委派回执状态无效");
  if(response.version<=r.receipt_version){
   if(response.version===r.receipt_version&&canonical(response)!==r.receipt_json)fail("RECEIPT_CONFLICT","相同版本的回执内容不同");
   db.prepare("UPDATE delegation_outgoing SET last_error_code=NULL,updated_at=? WHERE delegation_id=?").run(at(),id);
   return outgoingStatus(db,id);
  }
  db.prepare("UPDATE delegation_outgoing SET state=?,receipt_version=?,receipt_json=?,last_error_code=NULL,updated_at=? WHERE delegation_id=?").run(response.state,response.version,canonical(response),at(),id);
  event(db,id,"outgoing","receipt",{version:response.version,state:response.state,receipt_digest:digest(response)});return outgoingStatus(db,id);
 });
}
export function startDelivery(db,id){return unit(db,()=>{const r=outgoingRow(db,id);currentSource(db,JSON.parse(r.offer_json));if(r.attempts>=Number.MAX_SAFE_INTEGER)fail("QUEUE_LIMIT","投递计数已达上限");const ts=at();db.prepare("UPDATE delegation_outgoing SET attempts=attempts+1,last_attempt_at=?,updated_at=? WHERE delegation_id=?").run(ts,ts,id);return outgoingStatus(db,id);});}
export function deliveryFailure(db,id,errorCode,{retryable=true}={}){return unit(db,()=>{const r=outgoingRow(db,id);currentSource(db,JSON.parse(r.offer_json));const code=typeof errorCode==="string"&&/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)?errorCode:"TRANSPORT_ERROR";db.prepare("UPDATE delegation_outgoing SET last_error_code=?,updated_at=? WHERE delegation_id=?").run(code,at(),id);return {...outgoingStatus(db,id),delivery_state:retryable?"retry_pending":"blocked"};});}
