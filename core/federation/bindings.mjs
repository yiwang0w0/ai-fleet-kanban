import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {PeerError,keys,uuid,version,names} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
import {canonical,digest,migrateSync} from "./sync-store.mjs";
import {migrateDelegation,validateOffer} from "./delegation.mjs";
import {migrateTopology,topologyState} from "./topology.mjs";
import {normalizeRelation} from "./relations.mjs";
const require=createRequire(import.meta.url),guard=require("../delegation_guard.js"),topologyGuard=require("../topology_guard.js"),store=require("../store.js");
const at=()=>new Date().toISOString(),active="state IN('prepared','confirmed')";
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
function unit(db,fn){if(!db.isTransaction)return transaction(db,fn);db.exec("SAVEPOINT binding_unit");try{const r=fn();db.exec("RELEASE binding_unit");return r;}catch(e){db.exec("ROLLBACK TO binding_unit; RELEASE binding_unit");throw e;}}
export function migrateBindings(db){return unit(db,()=>{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_peers'").get())fail("PEERS_NOT_INITIALIZED","先初始化节点认证存储");
 migrateSync(db);migrateDelegation(db);migrateTopology(db);
 db.exec("CREATE TABLE IF NOT EXISTS binding_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO binding_schema VALUES(1,1)");
 if(![1,2].includes(db.prepare("SELECT version FROM binding_schema").get().version))fail("SCHEMA_INCOMPATIBLE","端点绑定存储格式不兼容");
 db.exec([
 "CREATE TABLE IF NOT EXISTS delegation_bindings(relation_id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL,project_id TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN('source','target')),node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,task_id INTEGER NOT NULL,task_uid TEXT NOT NULL,task_version INTEGER NOT NULL,registrar_node_id TEXT NOT NULL,registrar_epoch TEXT NOT NULL,descriptor_digest TEXT NOT NULL,descriptor_json TEXT NOT NULL,contract_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('prepared','confirmed','cancelled')),confirmation_json TEXT,created_at TEXT NOT NULL);",
 "CREATE UNIQUE INDEX IF NOT EXISTS binding_one_delegation ON delegation_bindings(delegation_id) WHERE "+active+";",
 "CREATE UNIQUE INDEX IF NOT EXISTS binding_one_task ON delegation_bindings(task_uid,side) WHERE "+active+";",
 "CREATE TABLE IF NOT EXISTS binding_attempts(request_id TEXT PRIMARY KEY,relation_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('approve','withdraw')),args_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','acknowledged','rejected')),receipt_json TEXT,error_code TEXT,created_at TEXT NOT NULL);",
 "CREATE UNIQUE INDEX IF NOT EXISTS binding_one_attempt ON binding_attempts(relation_id) WHERE state='pending';",
 "CREATE TABLE IF NOT EXISTS binding_proposals(relation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_node_id TEXT NOT NULL,source_epoch TEXT NOT NULL,descriptor_json TEXT NOT NULL,descriptor_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TABLE IF NOT EXISTS binding_proposal_decisions(relation_id TEXT PRIMARY KEY,descriptor_digest TEXT NOT NULL,reason_code TEXT NOT NULL CHECK(reason_code IN('stale_topology','contract_changed','duplicate','operator_declined')),created_at TEXT NOT NULL);",
 "CREATE TRIGGER IF NOT EXISTS binding_decline_unprepared BEFORE INSERT ON binding_proposal_decisions WHEN NOT EXISTS(SELECT 1 FROM binding_proposals WHERE relation_id=NEW.relation_id AND descriptor_digest=NEW.descriptor_digest) OR EXISTS(SELECT 1 FROM delegation_bindings WHERE relation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'PROPOSAL_BOUND: only an unprepared proposal may be declined'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_declined_hold BEFORE INSERT ON delegation_bindings WHEN EXISTS(SELECT 1 FROM binding_proposal_decisions WHERE relation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'PROPOSAL_DECLINED: a declined proposal cannot be prepared'); END;",
 "CREATE TABLE IF NOT EXISTS binding_outbox(request_id TEXT PRIMARY KEY,relation_id TEXT NOT NULL,kind TEXT NOT NULL,body_json TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,UNIQUE(relation_id,kind));",
 "CREATE TABLE IF NOT EXISTS binding_inbox(source_node_id TEXT NOT NULL,source_epoch TEXT NOT NULL,request_id TEXT NOT NULL,body_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(source_node_id,source_epoch,request_id));",
 "CREATE TABLE IF NOT EXISTS binding_source_commits(relation_id TEXT NOT NULL,credential_version INTEGER NOT NULL,confirmation_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(relation_id,credential_version));",
 "CREATE TABLE IF NOT EXISTS binding_events(id INTEGER PRIMARY KEY,relation_id TEXT NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);",
 "CREATE TRIGGER IF NOT EXISTS binding_identity BEFORE UPDATE OF relation_id,delegation_id,project_id,side,node_id,node_epoch,task_id,task_uid,task_version,registrar_node_id,registrar_epoch,descriptor_digest,descriptor_json,contract_json,created_at ON delegation_bindings BEGIN SELECT RAISE(ABORT,'binding identity is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_terminal BEFORE UPDATE ON delegation_bindings WHEN OLD.state<>'prepared' BEGIN SELECT RAISE(ABORT,'binding outcome is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_attempt_identity BEFORE UPDATE OF request_id,relation_id,action,args_json,created_at ON binding_attempts BEGIN SELECT RAISE(ABORT,'binding request is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_attempt_terminal BEFORE UPDATE ON binding_attempts WHEN OLD.state<>'pending' BEGIN SELECT RAISE(ABORT,'binding request is terminal'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_outbox_identity BEFORE UPDATE OF request_id,relation_id,kind,body_json,created_at ON binding_outbox BEGIN SELECT RAISE(ABORT,'binding message is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_outbox_receipt BEFORE UPDATE ON binding_outbox WHEN OLD.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'binding message already acknowledged'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_contract_hold BEFORE UPDATE OF subject,description,acceptance,kind,route,archived_at ON tasks WHEN (NEW.subject IS NOT OLD.subject OR NEW.description IS NOT OLD.description OR NEW.acceptance IS NOT OLD.acceptance OR NEW.kind IS NOT OLD.kind OR NEW.route IS NOT OLD.route OR NEW.archived_at IS NOT OLD.archived_at) AND EXISTS(SELECT 1 FROM delegation_bindings b WHERE b.task_id=OLD.id AND b."+active+") BEGIN SELECT RAISE(ABORT,'BINDING_CONTRACT: bound work contract is immutable'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_source_hold BEFORE UPDATE OF status ON tasks WHEN (NEW.status='in_progress' AND OLD.status<>'in_progress' OR NEW.status='done' AND OLD.status<>'done') AND "+guard.heldSQL("OLD.id")+" BEGIN SELECT RAISE(ABORT,'BINDING_PENDING: delegated source awaits remote acceptance'); END;",
 "CREATE TRIGGER IF NOT EXISTS binding_topology_hold BEFORE INSERT ON topology_operations WHEN EXISTS(SELECT 1 FROM delegation_bindings b WHERE b.project_id=NEW.project_id AND b.state='prepared') BEGIN SELECT RAISE(ABORT,'BINDING_PENDING: relation approval uses this topology revision'); END;",
 "DROP TRIGGER IF EXISTS delegation_unconfirmed_execution;",
 "CREATE TRIGGER delegation_unconfirmed_execution BEFORE UPDATE OF released,status ON tasks WHEN (NEW.released=1 AND OLD.released<>1 OR NEW.status IN('in_progress','done') AND NEW.status<>OLD.status) AND EXISTS(SELECT 1 FROM delegation_incoming i WHERE i.target_task_id=NEW.id AND i.state='accepted_unconfirmed') AND NOT "+guard.readySQL("NEW.id")+" BEGIN SELECT RAISE(ABORT,'DELEGATION_UNCONFIRMED: both endpoint commitments are required'); END;"
 ].join("\n"));
 for(const t of ["binding_proposals","binding_proposal_decisions","binding_inbox","binding_source_commits","binding_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'binding history is immutable'); END");
 for(const t of ["delegation_bindings","binding_attempts","binding_proposals","binding_proposal_decisions","binding_outbox","binding_inbox","binding_source_commits","binding_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'binding history must be retained'); END");
 db.exec("UPDATE binding_schema SET version=2 WHERE singleton=1 AND version=1");
});}
function event(db,id,kind,detail={}){db.prepare("INSERT INTO binding_events(relation_id,kind,detail_json,created_at) VALUES(?,?,?,?)").run(id,kind,canonical(detail),at());}
function row(db,id){uuid(id,"relation_id");const b=db.prepare("SELECT * FROM delegation_bindings WHERE relation_id=?").get(id);if(!b)fail("NOT_FOUND","未找到端点绑定",404);const n=localIdentity(db);if(n.node_id!==b.node_id||n.sync_epoch!==b.node_epoch)fail("BINDING_RECOVERY_REQUIRED","恢复换代后的旧端点绑定不能继续");return b;}
function contract(t){return {subject:t.subject,description:t.description,acceptance:t.acceptance,work_kind:t.work_kind,capabilities:JSON.parse(t.capabilities_json).sort()};}
function endpointTask(db,d,side){
 const n=localIdentity(db);if(n.node_id!==d[side+"_node_id"]||n.sync_epoch!==d[side+"_epoch"])fail("IDENTITY_MISMATCH","本方端点身份或代次不匹配");
 const t=db.prepare("SELECT t.*,p.project_id,p.work_kind,p.capabilities_json FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE t.task_uid=?").get(d[side+"_task_uid"]);
 if(!t||t.owner_node_id!==n.node_id||t.project_id!==d.project_id)fail("ENDPOINT_MISMATCH","端点不是本机已登记的同项目任务");return t;
}
function acceptedOffer(db,d,side){
 const r=db.prepare("SELECT * FROM delegation_"+(side==="source"?"outgoing":"incoming")+" WHERE delegation_id=?").get(d.delegation_id);
 if(!r||r.state!=="accepted_unconfirmed"||r.offer_digest!==d.offer_digest)fail("CONTRACT_MISMATCH","委派尚未接受或合同摘要不匹配");
 const o=validateOffer(JSON.parse(r.offer_json));
 if(["project_id","source_node_id","source_epoch","source_task_uid","target_node_id","target_epoch"].some(k=>o[k]!==d[k])||digest(o)!==d.offer_digest)fail("CONTRACT_MISMATCH","委派合同身份不匹配");
 const target=side==="source"?(r.receipt_json?JSON.parse(r.receipt_json).target_task_uid:null):r.target_task_uid;
 if(target!==d.target_task_uid)fail("ENDPOINT_MISMATCH","接收任务不匹配实际接受回执");return o;
}
function topology(db,d,side,{prepared=true}={}){
 const b=topologyState(db,d.project_id);
 if(b.graph_id!==d.graph_id||b.graph_epoch!==d.graph_epoch||b.phase!=="ready"||!b.snapshot?.vertices.some(v=>v.task_uid===d[side+"_task_uid"])||(prepared?b.revision!==d[side+"_topology_revision"]:b.revision<d[side+"_topology_revision"]))fail("TOPOLOGY_PENDING","本方端点结构未按指定修订完成登记");return b;
}
function sourceGrant(db,d,peer=null){
 const p=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(d.source_node_id);
 if(!p||p.status!=="active"||p.peer_epoch!==d.source_epoch||!JSON.parse(p.projects_json).includes(d.project_id)||!["delegation:offer","delegation:binding"].every(s=>JSON.parse(p.scopes_json).includes(s))||peer&&(peer.peer_node_id!==p.peer_node_id||peer.peer_epoch!==p.peer_epoch||peer.credential_version!==p.credential_version||!peer.scopes.includes("delegation:binding")||!peer.projects.includes(d.project_id)))fail("SOURCE_REVOKED","来源端点绑定授权无效",403);
 if(db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(d.source_node_id,d.source_epoch))fail("RETIRED_EPOCH","来源代次已退役",403);return p;
}
export function bindingState(db,id){
 const b=row(db,id);return {relation_id:id,delegation_id:b.delegation_id,project_id:b.project_id,side:b.side,state:b.state,task_uid:b.task_uid,task_version:b.task_version,registrar_node_id:b.registrar_node_id,registrar_epoch:b.registrar_epoch,relation:JSON.parse(b.descriptor_json),confirmation:b.confirmation_json?JSON.parse(b.confirmation_json):null,binding_authorized:b.side==="target"&&guard.ready(db,b.task_id),execution_authorized:b.side==="target"&&guard.ready(db,b.task_id)&&topologyGuard.claimable(db,b.task_id)&&!guard.sourceHeld(db,b.task_id),dispatch_started:false,cancellation:guard.cancellationProjection(db,id),attempts:db.prepare("SELECT request_id,action,state,error_code FROM binding_attempts WHERE relation_id=? ORDER BY rowid").all(id)};
}
export const PROPOSAL_DECLINE_REASONS=Object.freeze(["stale_topology","contract_changed","duplicate","operator_declined"]);
const hasDecisions=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='binding_proposal_decisions'").get();
function proposalView(db,p){
 const d=JSON.parse(p.descriptor_json),n=localIdentity(db),b=db.prepare("SELECT state FROM delegation_bindings WHERE relation_id=?").get(p.relation_id),c=hasDecisions(db)?db.prepare("SELECT reason_code FROM binding_proposal_decisions WHERE relation_id=?").get(p.relation_id):null;
 return {relation_id:p.relation_id,relation:d,descriptor_digest:p.descriptor_digest,state:c?"declined":b?.state||"pending",reason_code:c?.reason_code||null,identity_current:d.target_node_id===n.node_id&&d.target_epoch===n.sync_epoch,dispatch_started:false};
}
export function bindingProposalState(db,relationId){uuid(relationId,"relation_id");const p=db.prepare("SELECT * FROM binding_proposals WHERE relation_id=?").get(relationId);if(!p)fail("NOT_FOUND","未找到认证绑定提案",404);return proposalView(db,p);}
function pendingProposals(db,projectId,{unprepared=false,limit=null}={}){
 const n=localIdentity(db),join=hasDecisions(db)?" LEFT JOIN binding_proposal_decisions c USING(relation_id)":"",filter=hasDecisions(db)?" AND c.relation_id IS NULL":"";
 const sql=" FROM binding_proposals p LEFT JOIN delegation_bindings b USING(relation_id)"+join+" WHERE p.project_id=? AND json_extract(p.descriptor_json,'$.target_node_id')=? AND json_extract(p.descriptor_json,'$.target_epoch')=? AND "+(unprepared?"b.relation_id IS NULL":"(b.state IS NULL OR b.state='prepared')")+filter;
 return limit===null?db.prepare("SELECT count(*) n"+sql).get(projectId,n.node_id,n.sync_epoch).n:db.prepare("SELECT p.*"+sql+" ORDER BY p.rowid LIMIT ?").all(projectId,n.node_id,n.sync_epoch,limit);
}
export function listBindings(db,{projectId,limit=100}){
 names([projectId],"project",null,1);if(!Number.isInteger(limit)||limit<1||limit>1000)fail("BAD_INPUT","列表上限无效",400);
 return {bindings:db.prepare("SELECT relation_id,delegation_id,side,state,task_uid,node_epoch=(SELECT sync_epoch FROM board_node WHERE singleton=1) identity_current FROM delegation_bindings WHERE project_id=? ORDER BY rowid DESC LIMIT ?").all(projectId,limit),
 proposals:db.prepare("SELECT * FROM binding_proposals WHERE project_id=? ORDER BY rowid DESC LIMIT ?").all(projectId,limit).map(p=>proposalView(db,p)),
 pending_proposals:pendingProposals(db,projectId,{unprepared:true,limit}).map(p=>proposalView(db,p)),pending_count:pendingProposals(db,projectId)};
}
export function declineBindingProposal(db,{relationId,expectedDescriptorDigest,reasonCode}){
 if(typeof expectedDescriptorDigest!=="string"||!/^[0-9a-f]{64}$/.test(expectedDescriptorDigest)||!PROPOSAL_DECLINE_REASONS.includes(reasonCode))fail("BAD_INPUT","提案摘要或拒绝原因无效",400);
 return unit(db,()=>{const p=bindingProposalState(db,relationId);if(!p.identity_current)fail("BINDING_RECOVERY_REQUIRED","不能裁定恢复换代前的旧端点提案");if(p.descriptor_digest!==expectedDescriptorDigest)fail("REQUEST_CONFLICT","审核的提案摘要不匹配");
  if(p.state==="declined"){if(p.reason_code!==reasonCode)fail("REQUEST_CONFLICT","拒绝决定已固定");return p;}
  if(p.state!=="pending")fail("PROPOSAL_BOUND","提案已有本方绑定，须恢复审批或通过登记节点撤回");
  db.prepare("INSERT INTO binding_proposal_decisions VALUES(?,?,?,?)").run(relationId,expectedDescriptorDigest,reasonCode,at());event(db,relationId,"proposal_declined",{descriptor_digest:expectedDescriptorDigest,reason_code:reasonCode});
  return bindingProposalState(db,relationId);
 });
}

export function prepareBinding(db,{relation,expectedTaskVersion}){
 const d=normalizeRelation(relation);version(expectedTaskVersion);
 return unit(db,()=>{const n=localIdentity(db),side=n.node_id===d.source_node_id?"source":n.node_id===d.target_node_id?"target":null;if(!side)fail("FORBIDDEN","本机不是委派端点",403);
  const existing=db.prepare("SELECT * FROM delegation_bindings WHERE relation_id=?").get(d.relation_id);if(existing){if(existing.descriptor_digest!==digest(d)||existing.task_version!==expectedTaskVersion)fail("REQUEST_CONFLICT","关系ID已绑定不同的本机审核");return bindingState(db,d.relation_id);}
  const t=endpointTask(db,d,side),o=acceptedOffer(db,d,side),b=topology(db,d,side);
  if(t.aggregate_version!==expectedTaskVersion||t.status==="done"||t.archived_at)fail("CONFLICT","端点版本已变化或已关闭");
  if(t.status==="in_progress"||db.prepare("SELECT 1 FROM task_runs WHERE task_id=? AND state='running'").get(t.id))fail("ACTIVE_WORK","先结束已有本机运行，再委派该工作");
  if(canonical(contract(t))!==canonical({...o.task,capabilities:[...o.task.capabilities].sort()}))fail("CONTRACT_CHANGED","实际任务公开工作字段与已接受合同不同");
  if(side==="target"){if(db.prepare("SELECT 1 FROM binding_proposal_decisions WHERE relation_id=?").get(d.relation_id))fail("PROPOSAL_DECLINED","本方已拒绝该绑定提案");sourceGrant(db,d);const p=db.prepare("SELECT descriptor_digest FROM binding_proposals WHERE relation_id=?").get(d.relation_id);if(!p||p.descriptor_digest!==digest(d))fail("PROPOSAL_REQUIRED","先取得认证来源发送的同一绑定提案");if(t.released||t.route!=="mcp")fail("ENDPOINT_MISMATCH","接收任务必须保持未放行的MCP工作");}
  if(db.prepare("SELECT 1 FROM delegation_bindings WHERE (delegation_id=? OR task_uid=? AND side=?) AND "+active).get(d.delegation_id,t.task_uid,side))fail("BINDING_EXISTS","同一工作已有未结束的委派绑定");
  db.prepare("INSERT INTO delegation_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',NULL,?)").run(d.relation_id,d.delegation_id,d.project_id,side,n.node_id,n.sync_epoch,t.id,t.task_uid,t.aggregate_version,b.registrar_node_id,b.registrar_epoch,digest(d),canonical(d),canonical(contract(t)),at());
  event(db,d.relation_id,"prepared",{side,task_version:t.aggregate_version});return bindingState(db,d.relation_id);
 });
}
function checkLocal(db,b){const d=JSON.parse(b.descriptor_json),t=endpointTask(db,d,b.side);acceptedOffer(db,d,b.side);if(canonical(contract(t))!==b.contract_json||t.archived_at)fail("CONTRACT_CHANGED","端点合同已变化");if(b.side==="target")sourceGrant(db,d);return d;}
export const BINDING_REJECTIONS=Object.freeze(["GRAPH_VERSION_CONFLICT","GRAPH_VERSION_EXHAUSTED","TOPOLOGY_VERSION_CONFLICT","RELATION_CYCLE","DANGLING_RELATION","GRAPH_LIMIT","RELATION_WITHDRAWN","DELEGATION_ALREADY_REGISTERED","RELATION_CONFIRMED"]);
export function startBindingAttempt(db,{relationId,action="approve",expectedVersion}){
 if(!["approve","withdraw"].includes(action))fail("BAD_INPUT","绑定提交类型无效",400);
 return unit(db,()=>{const b=row(db,relationId);if(b.state!=="prepared")fail("CONFLICT","绑定已确认或取消");const d=action==="approve"?checkLocal(db,b):JSON.parse(b.descriptor_json);if(action==="approve")topology(db,d,b.side);
  const old=db.prepare("SELECT * FROM binding_attempts WHERE relation_id=? AND state='pending'").get(relationId);
  if(old){if(old.action!==action)fail("UNKNOWN_REMOTE_OUTCOME","先恢复尚未确定的原请求");return JSON.parse(old.args_json);}
  const request_id=randomUUID();let args;if(action==="approve"){version(expectedVersion);args={request_id,expected_version:expectedVersion,relation:d};}else args={request_id,project_id:d.project_id,graph_id:d.graph_id,graph_epoch:d.graph_epoch,relation_id:relationId};
  db.prepare("INSERT INTO binding_attempts VALUES(?,?,?,?,'pending',NULL,NULL,?)").run(request_id,relationId,action,canonical(args),at());event(db,relationId,action+"_requested",{request_id});return args;
 });
}
export function rejectBindingAttempt(db,{relationId,requestId,code}){
 if(!BINDING_REJECTIONS.includes(code))fail("UNKNOWN_REMOTE_OUTCOME","失败不能证明原审批未成功");
 return unit(db,()=>{row(db,relationId);const a=db.prepare("SELECT * FROM binding_attempts WHERE relation_id=? AND request_id=?").get(relationId,requestId);if(!a)fail("NOT_FOUND","绑定请求不存在",404);if(a.state==="rejected"&&a.error_code===code)return bindingState(db,relationId);if(a.state!=="pending")fail("CONFLICT","请求已结束");db.prepare("UPDATE binding_attempts SET state='rejected',error_code=? WHERE request_id=?").run(code,requestId);event(db,relationId,"rejected",{request_id:requestId,code});return bindingState(db,relationId);});
}
function confirmed(b,r){
 exact(r,["schema_version","kind","project_id","graph_id","graph_epoch","graph_version","registrar_node_id","registrar_epoch","relation_id","descriptor_digest","relation","approved_by","vertices","edges","graph_digest","confirmed","dispatch_ready"],"confirmation");
 const d=normalizeRelation(r.relation);version(r.graph_version);
 if(r.schema_version!==1||r.kind!=="relation_confirmed"||r.confirmed!==true||r.dispatch_ready!==false||r.relation_id!==b.relation_id||r.project_id!==b.project_id||r.graph_id!==d.graph_id||r.graph_epoch!==d.graph_epoch||r.registrar_node_id!==b.registrar_node_id||r.registrar_epoch!==b.registrar_epoch||r.descriptor_digest!==b.descriptor_digest||canonical(d)!==b.descriptor_json||!Number.isSafeInteger(r.vertices)||r.vertices<2||r.vertices>10000||!Number.isSafeInteger(r.edges)||r.edges<1||r.edges>100000||!(/^[0-9a-f]{64}$/).test(r.graph_digest)||!Array.isArray(r.approved_by)||r.approved_by.length!==2)fail("RECEIPT_MISMATCH","关系回执未绑定本方合同和登记节点");
 const seen=new Set();for(const a of r.approved_by){exact(a,["node_id","node_epoch","credential_version"],"approval");const side=a.node_id===d.source_node_id?"source":a.node_id===d.target_node_id?"target":null;
  if(!side||seen.has(side)||a.node_epoch!==d[side+"_epoch"]||!Number.isSafeInteger(a.credential_version)||a.credential_version<(a.node_id===r.registrar_node_id?0:1)||a.node_id===r.registrar_node_id&&a.credential_version!==0)fail("RECEIPT_MISMATCH","双方审批证明无效");seen.add(side);
 }return r;
}
function pending(b,r){
 exact(r,["schema_version","kind","relation_id","graph_id","graph_epoch","graph_version","descriptor_digest","approved_by","confirmed","dispatch_ready"],"pending confirmation");const d=JSON.parse(b.descriptor_json);version(r.graph_version);
 if(r.schema_version!==1||r.kind!=="relation_pending"||r.relation_id!==b.relation_id||r.graph_id!==d.graph_id||r.graph_epoch!==d.graph_epoch||r.descriptor_digest!==b.descriptor_digest||r.confirmed!==false||r.dispatch_ready!==false||!Array.isArray(r.approved_by)||r.approved_by.length>2||new Set(r.approved_by).size!==r.approved_by.length||r.approved_by.some(x=>![d.source_node_id,d.target_node_id].includes(x)))fail("RECEIPT_MISMATCH","待确认回执无效");
}
function withdrawn(b,r){exact(r,["schema_version","kind","relation_id","graph_id","graph_epoch","confirmed","dispatch_ready"],"withdrawal");const d=JSON.parse(b.descriptor_json);if(r.schema_version!==1||r.kind!=="relation_withdrawn"||r.relation_id!==b.relation_id||r.graph_id!==d.graph_id||r.graph_epoch!==d.graph_epoch||r.confirmed!==false||r.dispatch_ready!==false)fail("RECEIPT_MISMATCH","撤回回执无效");}
export function acceptBindingReceipt(db,{relationId,requestId=null,receipt}){
 return unit(db,()=>{const b=row(db,relationId),a=requestId?db.prepare("SELECT * FROM binding_attempts WHERE relation_id=? AND request_id=?").get(relationId,requestId):null;
  if(requestId&&!a)fail("NOT_FOUND","审批请求不存在",404);
  if(receipt.kind==="relation_confirmed")confirmed(b,receipt);else if(receipt.kind==="relation_pending")pending(b,receipt);else withdrawn(b,receipt);
  if(b.state!=="prepared"){if(b.state==="confirmed"&&b.confirmation_json===canonical(receipt)||b.state==="cancelled"&&receipt.kind==="relation_withdrawn")return bindingState(db,relationId);fail("CONFLICT","本机绑定已结束");}
  if(a&&a.state!=="pending"){if(a.state==="acknowledged"&&a.receipt_json===canonical(receipt))return bindingState(db,relationId);fail("CONFLICT","请求已结束");}
  if(a&&((a.action==="withdraw")!==(receipt.kind==="relation_withdrawn")))fail("RECEIPT_MISMATCH","回执操作类型不同");
  if(receipt.kind==="relation_confirmed"){
   const d=checkLocal(db,b);topology(db,d,b.side);
   const commits=db.prepare("SELECT confirmation_json FROM binding_source_commits WHERE relation_id=?").all(relationId);if(commits.some(c=>c.confirmation_json!==canonical(receipt)))fail("RECEIPT_MISMATCH","来源就绪与独立登记证明不一致");
   db.prepare("UPDATE delegation_bindings SET state='confirmed',confirmation_json=? WHERE relation_id=?").run(canonical(receipt),relationId);
  }else if(receipt.kind==="relation_withdrawn")db.prepare("UPDATE delegation_bindings SET state='cancelled' WHERE relation_id=?").run(relationId);
  if(a)db.prepare("UPDATE binding_attempts SET state='acknowledged',receipt_json=? WHERE request_id=?").run(canonical(receipt),requestId);
  event(db,relationId,receipt.kind,{request_id:requestId,receipt_digest:digest(receipt)});return bindingState(db,relationId);
 });
}
export function cancelUnsentBinding(db,relationId){return unit(db,()=>{const b=row(db,relationId);if(b.state==="cancelled")return bindingState(db,relationId);if(b.state!=="prepared"||b.side!=="source"||db.prepare("SELECT 1 FROM binding_attempts WHERE relation_id=? AND state<>'rejected'").get(relationId)||db.prepare("SELECT 1 FROM binding_outbox WHERE relation_id=?").get(relationId))fail("UNKNOWN_REMOTE_OUTCOME","须确认登记节点撤回后再取消");db.prepare("UPDATE delegation_bindings SET state='cancelled' WHERE relation_id=?").run(relationId);event(db,relationId,"cancelled_unsent");return bindingState(db,relationId);});}
export function bindingMessage(db,{relationId,kind}){
 if(!["proposal","source_ready"].includes(kind))fail("BAD_INPUT","消息类型无效",400);
 return unit(db,()=>{const b=row(db,relationId),d=checkLocal(db,b);if(b.side!=="source"||b.state==="cancelled")fail("CONFLICT","来源绑定不可发送");
  if(kind==="source_ready"&&b.state!=="confirmed")fail("CONFIRMATION_REQUIRED","先独立提交登记节点的确认回执");
  if(kind==="proposal"&&b.state!=="confirmed"&&!db.prepare("SELECT 1 FROM binding_attempts WHERE relation_id=? AND action='approve' AND state='acknowledged'").get(relationId))fail("APPROVAL_REQUIRED","来源先取得登记审批回执再发送提案");
  const old=db.prepare("SELECT body_json FROM binding_outbox WHERE relation_id=? AND kind=?").get(relationId,kind);if(old)return JSON.parse(old.body_json);
  const body={schema_version:1,request_id:randomUUID(),kind,relation:d,confirmation:kind==="source_ready"?JSON.parse(b.confirmation_json):null};
  db.prepare("INSERT INTO binding_outbox VALUES(?,?,?,?,NULL,?)").run(body.request_id,relationId,kind,canonical(body),at());event(db,relationId,"message_prepared",{kind,request_id:body.request_id});return body;
 });
}
export function receiveBindingMessage(db,peer,body){
 exact(body,["schema_version","request_id","kind","relation","confirmation"],"binding message");uuid(body.request_id,"request_id");const d=normalizeRelation(body.relation);
 if(body.schema_version!==1||!["proposal","source_ready"].includes(body.kind)||body.kind==="proposal"&&body.confirmation!==null)fail("BAD_INPUT","绑定消息无效",400);
 return unit(db,()=>{
  const p=sourceGrant(db,d,peer);endpointTask(db,d,"target");acceptedOffer(db,d,"target");
  const hash=digest(body),prior=db.prepare("SELECT * FROM binding_inbox WHERE source_node_id=? AND source_epoch=? AND request_id=?").get(d.source_node_id,d.source_epoch,body.request_id);
  if(prior&&prior.body_digest!==hash)fail("REQUEST_CONFLICT","相同消息号内容不同");
  const proposal=db.prepare("SELECT descriptor_digest FROM binding_proposals WHERE relation_id=?").get(d.relation_id);if(proposal&&proposal.descriptor_digest!==digest(d))fail("REQUEST_CONFLICT","提案ID已经绑定不同关系");
  if(db.prepare("SELECT 1 FROM binding_proposal_decisions WHERE relation_id=?").get(d.relation_id))fail("PROPOSAL_DECLINED","接收方已明确拒绝本提案；来源仍须撤回未确认登记申请");
  if(body.kind==="proposal"){
   if(!proposal){if(pendingProposals(db,d.project_id)>=1000)fail("QUEUE_LIMIT","项目绑定提案达到上限");db.prepare("INSERT INTO binding_proposals VALUES(?,?,?,?,?,?,?)").run(d.relation_id,d.project_id,d.source_node_id,d.source_epoch,canonical(d),digest(d),at());}
  }else{
   const b=row(db,d.relation_id);if(b.side!=="target"||b.state==="cancelled"||b.descriptor_digest!==digest(d))fail("CONTRACT_MISMATCH","本机未接受同一关系");confirmed(b,body.confirmation);checkLocal(db,b);
   if(b.confirmation_json&&b.confirmation_json!==canonical(body.confirmation))fail("RECEIPT_MISMATCH","来源证明与本机独立登记回执不同");
   const old=db.prepare("SELECT confirmation_json FROM binding_source_commits WHERE relation_id=? AND credential_version=?").get(d.relation_id,p.credential_version);
   if(old&&old.confirmation_json!==canonical(body.confirmation))fail("RECEIPT_MISMATCH","就绪证明不能替换");
   db.prepare("INSERT OR IGNORE INTO binding_source_commits VALUES(?,?,?,?)").run(d.relation_id,p.credential_version,canonical(body.confirmation),at());
  }
  const n=localIdentity(db),receipt={schema_version:1,kind:"binding_message_received",request_id:body.request_id,relation_id:d.relation_id,message_digest:hash,target_node_id:n.node_id,target_epoch:n.sync_epoch};
  if(!prior){db.prepare("INSERT INTO binding_inbox VALUES(?,?,?,?,?)").run(d.source_node_id,d.source_epoch,body.request_id,hash,canonical(receipt));event(db,d.relation_id,"message_received",{kind:body.kind,credential_version:p.credential_version,request_id:body.request_id});}
  return receipt;
 });
}
export function recordBindingMessage(db,{requestId,receipt}){
 exact(receipt,["schema_version","kind","request_id","relation_id","message_digest","target_node_id","target_epoch"],"message receipt");
 return unit(db,()=>{const m=db.prepare("SELECT * FROM binding_outbox WHERE request_id=?").get(requestId);if(!m)fail("NOT_FOUND","消息不存在",404);const b=row(db,m.relation_id),body=JSON.parse(m.body_json),d=body.relation;
  if(receipt.schema_version!==1||receipt.kind!=="binding_message_received"||receipt.request_id!==requestId||receipt.relation_id!==b.relation_id||receipt.message_digest!==digest(body)||receipt.target_node_id!==d.target_node_id||receipt.target_epoch!==d.target_epoch)fail("RECEIPT_MISMATCH","消息确认不匹配");
  if(m.receipt_json){if(m.receipt_json!==canonical(receipt))fail("RECEIPT_MISMATCH","消息回执不同");}else{db.prepare("UPDATE binding_outbox SET receipt_json=? WHERE request_id=?").run(canonical(receipt),requestId);event(db,b.relation_id,"message_acknowledged",{request_id:requestId});}
  return bindingState(db,b.relation_id);
 });
}

export function releaseBoundTask(db,{relationId,expectedTaskVersion}){version(expectedTaskVersion);return unit(db,()=>{const b=row(db,relationId),state=bindingState(db,relationId);if(b.side!=="target"||!state.execution_authorized)fail("CONFIRMATION_REQUIRED","双方就绪、当前授权和本地结构尚未满足放行条件");const t=endpointTask(db,state.relation,"target");if(t.status!=="not_started"||t.archived_at)fail("CONFLICT","只能放行尚未执行的接收任务");store.setReleased(db,{id:t.id,released:true,expectedVersion:expectedTaskVersion,actor:"binding:"+relationId});event(db,relationId,"released",{expected_task_version:expectedTaskVersion});return {relation_id:relationId,task_uid:t.task_uid,released:true,dispatch_started:false};});}
