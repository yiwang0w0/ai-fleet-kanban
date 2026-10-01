import {normalizeCancellationClosure} from "./cancellation-contract.mjs";
import {normalizeCompletion} from "./completion-contract.mjs";
// Project-scoped, serialized relationship registry. Local topology enforcement is a separate integration.
import {randomUUID} from "node:crypto";
import {PeerError,keys,uuid,names,version} from "./protocol.mjs";
import {localIdentity,transaction} from "./peers.mjs";
import {canonical,digest,taskUID} from "./sync-store.mjs";
export const MAX_GRAPH_VERTICES=10000,MAX_GRAPH_EDGES=100000,MAX_TOPOLOGY_BYTES=4*1024*1024,MAX_PENDING_RELATIONS=1000;
const at=()=>new Date().toISOString();
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
const project=x=>names([x],"project_id",null,1)[0];
function unit(db,fn){if(!db.isTransaction)return transaction(db,fn);db.exec("SAVEPOINT relations_unit");try{const r=fn();db.exec("RELEASE relations_unit");return r;}catch(e){db.exec("ROLLBACK TO relations_unit; RELEASE relations_unit");throw e;}}
export function migrateRelations(db){return unit(db,()=>{
 localIdentity(db);db.exec("CREATE TABLE IF NOT EXISTS relation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO relation_schema VALUES(1,1)");
 if(![1,2,3].includes(db.prepare("SELECT version FROM relation_schema WHERE singleton=1").get().version))fail("SCHEMA_INCOMPATIBLE","关系登记存储格式不兼容");
 db.exec([
  "CREATE TABLE IF NOT EXISTS relation_graphs(project_id TEXT PRIMARY KEY,graph_id TEXT NOT NULL UNIQUE,graph_epoch TEXT NOT NULL,registrar_node_id TEXT NOT NULL,registrar_epoch TEXT NOT NULL,version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_members(graph_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,PRIMARY KEY(graph_id,node_id));",
  "CREATE TABLE IF NOT EXISTS relation_topologies(graph_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,revision INTEGER NOT NULL,snapshot_digest TEXT NOT NULL,snapshot_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(graph_id,node_id));",
  "CREATE TABLE IF NOT EXISTS relation_vertex_locations(task_uid TEXT PRIMARY KEY,graph_id TEXT NOT NULL,node_id TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_proposals(relation_id TEXT PRIMARY KEY,graph_id TEXT NOT NULL,descriptor_digest TEXT NOT NULL,descriptor_json TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_approvals(relation_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,credential_version INTEGER NOT NULL,descriptor_digest TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(relation_id,node_id,credential_version));",
  "CREATE TABLE IF NOT EXISTS relation_edges(relation_id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL UNIQUE,graph_id TEXT NOT NULL,from_uid TEXT NOT NULL,to_uid TEXT NOT NULL,graph_version INTEGER NOT NULL,receipt_json TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_withdrawals(relation_id TEXT PRIMARY KEY,graph_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_requests(graph_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,args_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(graph_id,node_id,node_epoch,request_id));",
  "CREATE TABLE IF NOT EXISTS relation_events(id INTEGER PRIMARY KEY,graph_id TEXT NOT NULL,graph_version INTEGER NOT NULL,kind TEXT NOT NULL,node_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_completion_proposals(relation_id TEXT PRIMARY KEY,completion_id TEXT NOT NULL UNIQUE,completion_json TEXT NOT NULL,completion_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_completion_votes(relation_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,credential_version INTEGER NOT NULL,completion_digest TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(relation_id,node_id,credential_version));",
  "CREATE TABLE IF NOT EXISTS relation_completions(relation_id TEXT PRIMARY KEY,graph_id TEXT NOT NULL,completion_id TEXT NOT NULL UNIQUE,completion_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_cancellation_proposals(relation_id TEXT PRIMARY KEY,cancel_id TEXT NOT NULL UNIQUE,cancellation_json TEXT NOT NULL,cancellation_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS relation_cancellation_votes(relation_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,credential_version INTEGER NOT NULL,cancellation_digest TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(relation_id,node_id,credential_version));",
  "CREATE TABLE IF NOT EXISTS relation_cancellations(relation_id TEXT PRIMARY KEY,graph_id TEXT NOT NULL,cancel_id TEXT NOT NULL UNIQUE,cancellation_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TRIGGER IF NOT EXISTS relation_completion_exclusive BEFORE INSERT ON relation_completion_proposals WHEN EXISTS(SELECT 1 FROM relation_cancellation_proposals WHERE relation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'CANCELLATION_COMMITTED: relation cannot complete'); END;",
  "CREATE TRIGGER IF NOT EXISTS relation_cancellation_exclusive BEFORE INSERT ON relation_cancellation_proposals WHEN EXISTS(SELECT 1 FROM relation_completion_proposals WHERE relation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'COMPLETION_COMMITTED: relation cannot cancel'); END;",
  "CREATE INDEX IF NOT EXISTS relation_edges_graph ON relation_edges(graph_id);",
  "CREATE INDEX IF NOT EXISTS relation_proposals_graph ON relation_proposals(graph_id);",
  "CREATE TRIGGER IF NOT EXISTS relation_graph_identity BEFORE UPDATE OF project_id,graph_id,graph_epoch,registrar_node_id,registrar_epoch,created_at ON relation_graphs BEGIN SELECT RAISE(ABORT,'relation graph identity is immutable'); END;"
 ].join("\n"));
 for(const table of ["relation_members","relation_vertex_locations","relation_proposals","relation_approvals","relation_edges","relation_withdrawals","relation_requests","relation_events","relation_completion_proposals","relation_completion_votes","relation_completions","relation_cancellation_proposals","relation_cancellation_votes","relation_cancellations"]){
  db.exec("CREATE TRIGGER IF NOT EXISTS "+table+"_immutable BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'relation history is immutable'); END");
 }
 for(const table of ["relation_graphs","relation_members","relation_vertex_locations","relation_topologies","relation_proposals","relation_approvals","relation_edges","relation_withdrawals","relation_requests","relation_events","relation_completion_proposals","relation_completion_votes","relation_completions","relation_cancellation_proposals","relation_cancellation_votes","relation_cancellations"]){
  db.exec("CREATE TRIGGER IF NOT EXISTS "+table+"_retained BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'relation retention is not enabled'); END");
 }
 db.exec("UPDATE relation_schema SET version=3 WHERE singleton=1 AND version<3");
});}
function graph(db,{project_id,graph_id,graph_epoch}){
 project(project_id);uuid(graph_id,"graph_id");uuid(graph_epoch,"graph_epoch");const node=localIdentity(db);
 const g=db.prepare("SELECT * FROM relation_graphs WHERE project_id=? AND graph_id=? AND graph_epoch=?").get(project_id,graph_id,graph_epoch);
 if(!g)fail("GRAPH_MISMATCH","项目关系图身份不匹配");
 if(g.registrar_node_id!==node.node_id||g.registrar_epoch!==node.sync_epoch)fail("GRAPH_RECOVERY_REQUIRED","关系登记节点已恢复换代，旧确认必须先核对");return g;
}
function authorize(db,g,peer,scope){
 const local=localIdentity(db);
 if(!peer.projects.includes(g.project_id)||!peer.scopes.includes(scope))fail("FORBIDDEN","节点未获该项目关系权限",403);
 if(peer.peer_node_id===local.node_id&&peer.peer_epoch===local.sync_epoch&&scope==="relations:read")return;
 const member=db.prepare("SELECT * FROM relation_members WHERE graph_id=? AND node_id=?").get(g.graph_id,peer.peer_node_id);
 if(!member||member.node_epoch!==peer.peer_epoch)fail("FORBIDDEN","节点未获该项目关系权限",403);
 if(peer.peer_node_id===local.node_id){if(peer.peer_epoch!==local.sync_epoch)fail("IDENTITY_MISMATCH","本机代次不一致",403);return;}
 const actual=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(peer.peer_node_id);
 if(!actual||actual.status!=="active"||actual.peer_epoch!==peer.peer_epoch||actual.credential_version!==peer.credential_version||!JSON.parse(actual.scopes_json).includes(scope)||!JSON.parse(actual.projects_json).includes(g.project_id))fail("AUTHORIZATION_CHANGED","对端关系权限已变化",403);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_retired_epochs'").get()&&db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(peer.peer_node_id,peer.peer_epoch))fail("RETIRED_EPOCH","对端代次已退役",403);
}
export function localRegistrarPeer(db,projectId){const n=localIdentity(db);return {peer_node_id:n.node_id,peer_epoch:n.sync_epoch,projects:[project(projectId)],scopes:["relations:publish","relations:approve","relations:read","relations:complete"]};}
function seenVersion(g,expected){version(expected);if(g.version!==expected)fail("GRAPH_VERSION_CONFLICT","关系图版本已变化，请获取新版本后重新评估");if(g.version===Number.MAX_SAFE_INTEGER)fail("GRAPH_VERSION_EXHAUSTED","关系图版本已达上限");}
function event(db,g,kind,nodeId,detail){db.prepare("INSERT INTO relation_events(graph_id,graph_version,kind,node_id,detail_json,created_at) VALUES(?,?,?,?,?,?)").run(g.graph_id,g.version,kind,nodeId,canonical(detail),at());}
/** Local administration chooses a single registrar and exact member epochs; no automatic failover. */
export function createRelationGraph(db,{projectId,members}){project(projectId);if(!Array.isArray(members)||!members.length||members.length>32)fail("BAD_INPUT","参与终端数量须为 1–32",400);
 const nodes=new Set();for(const m of members){exact(m,["node_id","node_epoch"],"member");uuid(m.node_id,"node_id");uuid(m.node_epoch,"node_epoch");if(nodes.has(m.node_id))fail("BAD_INPUT","参与节点重复",400);nodes.add(m.node_id);}
 return unit(db,()=>{const n=localIdentity(db);if(db.prepare("SELECT 1 FROM relation_graphs WHERE project_id=?").get(projectId))fail("CONFLICT","项目已经绑定关系图，不能静默替换");
  const g={project_id:projectId,graph_id:randomUUID(),graph_epoch:randomUUID(),registrar_node_id:n.node_id,registrar_epoch:n.sync_epoch,version:1,created_at:at()};
  db.prepare("INSERT INTO relation_graphs VALUES(?,?,?,?,?,?,?)").run(g.project_id,g.graph_id,g.graph_epoch,g.registrar_node_id,g.registrar_epoch,g.version,g.created_at);
  for(const m of members){if(m.node_id===n.node_id&&m.node_epoch!==n.sync_epoch)fail("IDENTITY_MISMATCH","登记本机时须使用当前代次");db.prepare("INSERT INTO relation_members VALUES(?,?,?)").run(g.graph_id,m.node_id,m.node_epoch);}
  event(db,g,"created",n.node_id,{members:[...members].sort((a,b)=>a.node_id.localeCompare(b.node_id))});return {...g,members};
 });}
export function normalizeTopology(s){
 exact(s,["schema_version","project_id","graph_id","graph_epoch","owner_node_id","owner_epoch","revision","vertices"],"topology");
 if(s.schema_version!==1)fail("SCHEMA_INCOMPATIBLE","本地图协议不兼容");project(s.project_id);for(const k of ["graph_id","graph_epoch","owner_node_id","owner_epoch"])uuid(s[k],k);version(s.revision);
 if(!Array.isArray(s.vertices)||s.vertices.length>MAX_GRAPH_VERTICES)fail("GRAPH_LIMIT","本地图顶点数超过上限");
 const map=new Map(),vertices=s.vertices.map(v=>{
  exact(v,["task_uid","parent_uid","blocked_by"],"vertex");taskUID(v.task_uid,s.owner_node_id);
  if(map.has(v.task_uid))fail("BAD_INPUT","本地图重复任务",400);map.set(v.task_uid,v);
  if(v.parent_uid!==null)taskUID(v.parent_uid,s.owner_node_id);
  if(!Array.isArray(v.blocked_by)||v.blocked_by.length>MAX_GRAPH_VERTICES||new Set(v.blocked_by).size!==v.blocked_by.length)fail("BAD_INPUT","依赖集合无效",400);
  for(const uid of v.blocked_by)taskUID(uid,s.owner_node_id);
  return {...v,blocked_by:[...v.blocked_by].sort()};
 }).sort((a,b)=>a.task_uid.localeCompare(b.task_uid));
 for(const v of vertices){
  for(const uid of [...v.blocked_by,...(v.parent_uid===null?[]:[v.parent_uid])])if(!map.has(uid))fail("MISSING_LOCAL_REFERENCE","本地图必须包含全部同项目父子与依赖顶点");
 }
 const normalized={...s,vertices};if(Buffer.byteLength(canonical(normalized))>MAX_TOPOLOGY_BYTES)fail("GRAPH_LIMIT","本地图正文超过 4 MiB");return normalized;
}
/** Every edge means 'from waits for to', including parent -> child. */
export function validateCombinedGraph(snapshots,relations=[]){
 if(relations.length>MAX_GRAPH_EDGES)fail("GRAPH_LIMIT","跨端关系数量超过上限");
 const vertices=new Map(),edges=new Set(),adj=new Map(),indegree=new Map();
 for(const s of snapshots)for(const v of s.vertices){if(vertices.has(v.task_uid))fail("OWNER_MISMATCH","任务在多个本地图出现");vertices.set(v.task_uid,v);if(vertices.size>MAX_GRAPH_VERTICES)fail("GRAPH_LIMIT","全局顶点数超过上限");}
 for(const uid of vertices.keys()){adj.set(uid,[]);indegree.set(uid,0);}
 const add=(from,to)=>{
  if(!vertices.has(from)||!vertices.has(to))fail("DANGLING_RELATION","关系引用了未登记或被移除的任务");
  const key=from+"\0"+to;if(edges.has(key))return;edges.add(key);if(edges.size>MAX_GRAPH_EDGES)fail("GRAPH_LIMIT","全局关系数超过上限");adj.get(from).push(to);indegree.set(to,indegree.get(to)+1);
 };
 for(const v of vertices.values()){if(v.parent_uid!==null)add(v.parent_uid,v.task_uid);for(const uid of v.blocked_by)add(v.task_uid,uid);}
 for(const e of relations)add(e.from_uid,e.to_uid);
 const queue=[...indegree].filter(([,n])=>n===0).map(([uid])=>uid);let visited=0;
 for(let i=0;i<queue.length;i++){visited++;for(const child of adj.get(queue[i])){const n=indegree.get(child)-1;indegree.set(child,n);if(n===0)queue.push(child);}}
 if(visited!==vertices.size)fail("RELATION_CYCLE","本地父子、依赖与跨端关系组合成环");
 return {vertices:vertices.size,edges:edges.size,graph_digest:digest({vertices:[...vertices.keys()].sort(),edges:[...edges].sort()})};
}
function snapshots(db,g,replacement=null){
 const all=db.prepare("SELECT node_id,snapshot_json FROM relation_topologies WHERE graph_id=?").all(g.graph_id).filter(r=>r.node_id!==replacement?.owner_node_id).map(r=>JSON.parse(r.snapshot_json));if(replacement)all.push(replacement);return all;
}
function edges(db,g,exclude=null){const rows=db.prepare("SELECT from_uid,to_uid FROM relation_edges e WHERE graph_id=? AND NOT EXISTS(SELECT 1 FROM relation_completions c WHERE c.relation_id=e.relation_id) AND NOT EXISTS(SELECT 1 FROM relation_cancellations c WHERE c.relation_id=e.relation_id) AND (? IS NULL OR e.relation_id<>?) LIMIT ?").all(g.graph_id,exclude,exclude,MAX_GRAPH_EDGES+1);if(rows.length>MAX_GRAPH_EDGES)fail("GRAPH_LIMIT","跨端关系数量超过上限");return rows;}
function request(db,g,peer,id,operation,args,work){
 uuid(id,"request_id");const hash=digest(args),prior=db.prepare("SELECT * FROM relation_requests WHERE graph_id=? AND node_id=? AND node_epoch=? AND request_id=?").get(g.graph_id,peer.peer_node_id,peer.peer_epoch,id);
 if(prior){if(prior.operation!==operation||prior.args_digest!==hash)fail("REQUEST_CONFLICT","请求 ID 已绑定不同操作或内容");return JSON.parse(prior.result_json);}
 const result=work();db.prepare("INSERT INTO relation_requests VALUES(?,?,?,?,?,?,?,?)").run(g.graph_id,peer.peer_node_id,peer.peer_epoch,id,operation,hash,canonical(result),at());return result;
}
export function publishTopology(db,peer,args){
 exact(args,["request_id","expected_version","snapshot"],"publish");const s=normalizeTopology(args.snapshot);version(args.expected_version);
 return unit(db,()=>{const g=graph(db,s);authorize(db,g,peer,"relations:publish");if(s.owner_node_id!==peer.peer_node_id||s.owner_epoch!==peer.peer_epoch)fail("OWNER_MISMATCH","只能申报本终端关系",403);
  return request(db,g,peer,args.request_id,"publish",{...args,snapshot:s},()=>{
   seenVersion(g,args.expected_version);const previous=db.prepare("SELECT * FROM relation_topologies WHERE graph_id=? AND node_id=?").get(g.graph_id,peer.peer_node_id);
   if(s.revision!==(previous?.revision??0)+1)fail("TOPOLOGY_VERSION_CONFLICT","本地图修订须严格递增一版");
   for(const v of s.vertices){const loc=db.prepare("SELECT * FROM relation_vertex_locations WHERE task_uid=?").get(v.task_uid);if(loc&&(loc.graph_id!==g.graph_id||loc.node_id!==s.owner_node_id))fail("OWNER_MISMATCH","任务已绑定其他项目或终端");}
   const proof=validateCombinedGraph(snapshots(db,g,s),edges(db,g));
   db.prepare("INSERT INTO relation_topologies VALUES(?,?,?,?,?,?,?) ON CONFLICT(graph_id,node_id) DO UPDATE SET revision=excluded.revision,snapshot_digest=excluded.snapshot_digest,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at")
    .run(g.graph_id,s.owner_node_id,s.owner_epoch,s.revision,digest(s),canonical(s),at());
   for(const v of s.vertices)db.prepare("INSERT OR IGNORE INTO relation_vertex_locations VALUES(?,?,?)").run(v.task_uid,g.graph_id,s.owner_node_id);
   db.prepare("UPDATE relation_graphs SET version=version+1 WHERE graph_id=?").run(g.graph_id);g.version++;
   const receipt={schema_version:1,kind:"topology_registered",project_id:g.project_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,registrar_node_id:g.registrar_node_id,registrar_epoch:g.registrar_epoch,owner_node_id:s.owner_node_id,owner_epoch:s.owner_epoch,revision:s.revision,snapshot_digest:digest(s),...proof};
   event(db,g,"topology_registered",peer.peer_node_id,{snapshot_digest:digest(s),revision:s.revision,...proof});return receipt;
  });
 });
}
export function normalizeRelation(d){
 exact(d,["schema_version","type","relation_id","delegation_id","project_id","graph_id","graph_epoch","source_node_id","source_epoch","source_task_uid","target_node_id","target_epoch","target_task_uid","offer_digest","source_topology_revision","target_topology_revision"],"relation");
 if(d.schema_version!==1||d.type!=="delegation")fail("SCHEMA_INCOMPATIBLE","关系协议或种类不兼容");
 project(d.project_id);for(const k of ["relation_id","delegation_id","graph_id","graph_epoch","source_node_id","source_epoch","target_node_id","target_epoch"])uuid(d[k],k);
 taskUID(d.source_task_uid,d.source_node_id);taskUID(d.target_task_uid,d.target_node_id);version(d.source_topology_revision);version(d.target_topology_revision);
 if(d.source_node_id===d.target_node_id)fail("IDENTITY_CONFLICT","委派关系必须跨终端");
 if(typeof d.offer_digest!=="string"||!(/^[0-9a-f]{64}$/).test(d.offer_digest))fail("BAD_INPUT","合同摘要无效",400);return {...d};
}
function relationEndpoints(db,g,d){
 for(const side of ["source","target"]){
  const node=d[side+"_node_id"],epoch=d[side+"_epoch"],revision=d[side+"_topology_revision"],uid=d[side+"_task_uid"];
  const m=db.prepare("SELECT * FROM relation_members WHERE graph_id=? AND node_id=?").get(g.graph_id,node),t=db.prepare("SELECT * FROM relation_topologies WHERE graph_id=? AND node_id=?").get(g.graph_id,node);
  if(!m||m.node_epoch!==epoch||!t||t.node_epoch!==epoch||t.revision!==revision)fail("TOPOLOGY_VERSION_CONFLICT","参与节点本地图或代次已变化");
  if(!JSON.parse(t.snapshot_json).vertices.some(v=>v.task_uid===uid))fail("DANGLING_RELATION","委派端点未登记");
 }
}
function validApprovals(db,g,d,{completion=null,cancellation=null}={}){
 const local=localIdentity(db),out=[];
 for(const nodeId of [d.source_node_id,d.target_node_id]){
  const epoch=nodeId===d.source_node_id?d.source_epoch:d.target_epoch;let credentialVersion;
  if(nodeId===local.node_id){if(epoch!==local.sync_epoch)continue;credentialVersion=0;}
  else{
   const p=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(nodeId);
   if(!p||p.status!=="active"||p.peer_epoch!==epoch||!JSON.parse(p.scopes_json).includes(completion||cancellation?"relations:complete":"relations:approve")||!JSON.parse(p.projects_json).includes(g.project_id))continue;
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_retired_epochs'").get()&&db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(nodeId,epoch))continue;
   credentialVersion=p.credential_version;
  }
  const row=db.prepare("SELECT node_id,node_epoch,credential_version,"+(cancellation?"cancellation_digest":completion?"completion_digest":"descriptor_digest")+" AS bound_digest FROM "+(cancellation?"relation_cancellation_votes":completion?"relation_completion_votes":"relation_approvals")+" WHERE relation_id=? AND node_id=? AND credential_version=?").get(d.relation_id,nodeId,credentialVersion);
  if(row&&row.node_epoch===epoch&&row.bound_digest===digest(cancellation??completion??d))out.push({...row,descriptor_digest:digest(d)});
 }
 return out.sort((a,b)=>a.node_id.localeCompare(b.node_id));
}
export function approveRelation(db,peer,args){
 exact(args,["request_id","expected_version","relation"],"approve");const d=normalizeRelation(args.relation);version(args.expected_version);
 return unit(db,()=>{const g=graph(db,d);authorize(db,g,peer,"relations:approve");
  const side=peer.peer_node_id===d.source_node_id?"source":peer.peer_node_id===d.target_node_id?"target":null;
  if(!side||peer.peer_epoch!==d[side+"_epoch"])fail("FORBIDDEN","只有委派双方可确认本方关系",403);
  return request(db,g,peer,args.request_id,"approve",{...args,relation:d},()=>{
   const prior=db.prepare("SELECT * FROM relation_proposals WHERE relation_id=?").get(d.relation_id);
   if(prior&&(prior.graph_id!==g.graph_id||prior.descriptor_digest!==digest(d)))fail("REQUEST_CONFLICT","关系 ID 已绑定其他合同");
   if(db.prepare("SELECT 1 FROM relation_withdrawals WHERE relation_id=?").get(d.relation_id))fail("RELATION_WITHDRAWN","该确认申请已撤回，须使用新的关系 ID");
   if(db.prepare("SELECT 1 FROM relation_completions WHERE relation_id=?").get(d.relation_id))fail("RELATION_COMPLETED","已结束关系不能重新确认");
   if(db.prepare("SELECT 1 FROM relation_cancellations WHERE relation_id=?").get(d.relation_id))fail("RELATION_CANCELLED","已取消关系不能重新确认");
   const confirmed=db.prepare("SELECT receipt_json FROM relation_edges WHERE relation_id=? AND graph_id=?").get(d.relation_id,g.graph_id);if(confirmed)return JSON.parse(confirmed.receipt_json);
   if(db.prepare("SELECT 1 FROM relation_edges WHERE delegation_id=?").get(d.delegation_id))fail("DELEGATION_ALREADY_REGISTERED","该委派已有已确认关系");
   seenVersion(g,args.expected_version);relationEndpoints(db,g,d);
   if(!prior){if(db.prepare("SELECT count(*) n FROM relation_proposals p LEFT JOIN relation_edges e USING(relation_id) LEFT JOIN relation_withdrawals w USING(relation_id) WHERE p.graph_id=? AND e.relation_id IS NULL AND w.relation_id IS NULL").get(g.graph_id).n>=MAX_PENDING_RELATIONS)fail("GRAPH_LIMIT","待确认关系达到上限");db.prepare("INSERT INTO relation_proposals VALUES(?,?,?,?,?)").run(d.relation_id,g.graph_id,digest(d),canonical(d),at());}
   db.prepare("INSERT OR IGNORE INTO relation_approvals VALUES(?,?,?,?,?,?)").run(d.relation_id,peer.peer_node_id,peer.peer_epoch,peer.peer_node_id===localIdentity(db).node_id?0:peer.credential_version,digest(d),at());
   const approvals=validApprovals(db,g,d);
   if(approvals.length<2)return {schema_version:1,kind:"relation_pending",relation_id:d.relation_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,descriptor_digest:digest(d),approved_by:approvals.map(a=>a.node_id),confirmed:false,dispatch_ready:false};
   if(approvals.some(a=>a.descriptor_digest!==digest(d)||![d.source_node_id,d.target_node_id].includes(a.node_id)||a.node_epoch!==(a.node_id===d.source_node_id?d.source_epoch:d.target_epoch)))fail("APPROVAL_MISMATCH","双方确认记录不匹配");
   const proof=validateCombinedGraph(snapshots(db,g),[...edges(db,g),{from_uid:d.source_task_uid,to_uid:d.target_task_uid}]);
   db.prepare("UPDATE relation_graphs SET version=version+1 WHERE graph_id=?").run(g.graph_id);g.version++;
   const receipt={schema_version:1,kind:"relation_confirmed",project_id:g.project_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,registrar_node_id:g.registrar_node_id,registrar_epoch:g.registrar_epoch,relation_id:d.relation_id,descriptor_digest:digest(d),relation:d,approved_by:approvals.map(a=>({node_id:a.node_id,node_epoch:a.node_epoch,credential_version:a.credential_version})),...proof,confirmed:true,dispatch_ready:false};
   db.prepare("INSERT INTO relation_edges VALUES(?,?,?,?,?,?,?)").run(d.relation_id,d.delegation_id,g.graph_id,d.source_task_uid,d.target_task_uid,g.version,canonical(receipt));
   event(db,g,"relation_confirmed",peer.peer_node_id,{relation_id:d.relation_id,descriptor_digest:digest(d),...proof});return receipt;
  });
 });
}
/** Either endpoint can withdraw only an unconfirmed attempt; historical records stay intact. */
export function withdrawRelation(db,peer,args){
 exact(args,["request_id","project_id","graph_id","graph_epoch","relation_id"],"withdraw");uuid(args.relation_id,"relation_id");
 return unit(db,()=>{const g=graph(db,args);authorize(db,g,peer,"relations:approve");
  const p=db.prepare("SELECT * FROM relation_proposals WHERE graph_id=? AND relation_id=?").get(g.graph_id,args.relation_id);
  if(!p)fail("NOT_FOUND","关系未登记",404);const d=JSON.parse(p.descriptor_json);
  const side=peer.peer_node_id===d.source_node_id?"source":peer.peer_node_id===d.target_node_id?"target":null;
  if(!side||peer.peer_epoch!==d[side+"_epoch"])fail("FORBIDDEN","只有委派双方可撤回待确认申请",403);
  return request(db,g,peer,args.request_id,"withdraw",args,()=>{
   if(db.prepare("SELECT 1 FROM relation_edges WHERE relation_id=?").get(d.relation_id))fail("RELATION_CONFIRMED","已确认关系不能通过撤回申请删除");
   if(!db.prepare("SELECT 1 FROM relation_withdrawals WHERE relation_id=?").get(d.relation_id)){
    db.prepare("INSERT INTO relation_withdrawals VALUES(?,?,?,?,?)").run(d.relation_id,g.graph_id,peer.peer_node_id,peer.peer_epoch,at());
    event(db,g,"relation_withdrawn",peer.peer_node_id,{relation_id:d.relation_id});
   }
   return {schema_version:1,kind:"relation_withdrawn",relation_id:d.relation_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,confirmed:false,dispatch_ready:false};
  });
 });
}
export function relationStatus(db,peer,args){
 exact(args,["project_id","graph_id","graph_epoch","relation_id"],"relation status");if(args.relation_id!==null)uuid(args.relation_id,"relation_id");
 return unit(db,()=>{const g=graph(db,args);authorize(db,g,peer,"relations:read");
  if(args.relation_id!==null){
   const p=db.prepare("SELECT * FROM relation_proposals WHERE graph_id=? AND relation_id=?").get(g.graph_id,args.relation_id);if(!p)fail("NOT_FOUND","关系未登记",404);
   if(db.prepare("SELECT 1 FROM relation_withdrawals WHERE relation_id=?").get(args.relation_id))return {schema_version:1,kind:"relation_withdrawn",relation_id:args.relation_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,confirmed:false,dispatch_ready:false};
   const cancelled=db.prepare("SELECT receipt_json FROM relation_cancellations WHERE relation_id=?").get(args.relation_id);if(cancelled)return JSON.parse(cancelled.receipt_json);
   const completed=db.prepare("SELECT receipt_json FROM relation_completions WHERE relation_id=?").get(args.relation_id);if(completed)return JSON.parse(completed.receipt_json);
   const r=db.prepare("SELECT receipt_json FROM relation_edges WHERE relation_id=?").get(args.relation_id);if(r)return JSON.parse(r.receipt_json);
   return {schema_version:1,kind:"relation_pending",relation_id:args.relation_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,descriptor_digest:p.descriptor_digest,approved_by:validApprovals(db,g,JSON.parse(p.descriptor_json)).map(a=>a.node_id),confirmed:false,dispatch_ready:false};
  }
  return {...g,members:db.prepare("SELECT node_id,node_epoch FROM relation_members WHERE graph_id=? ORDER BY node_id").all(g.graph_id),topologies:db.prepare("SELECT node_id,node_epoch,revision,snapshot_digest FROM relation_topologies WHERE graph_id=? ORDER BY node_id").all(g.graph_id),...validateCombinedGraph(snapshots(db,g),edges(db,g)),pending:db.prepare("SELECT count(*) n FROM relation_proposals p LEFT JOIN relation_edges e USING(relation_id) LEFT JOIN relation_withdrawals w USING(relation_id) WHERE p.graph_id=? AND e.relation_id IS NULL AND w.relation_id IS NULL").get(g.graph_id).n};
 });
}

/** Read-only preview only: does not freeze local structures or authorize publication/execution. */
export function previewTopology(db,{projectId,graphId,graphEpoch,revision}){
 const n=localIdentity(db);project(projectId);uuid(graphId,"graph_id");uuid(graphEpoch,"graph_epoch");version(revision);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'broker_task_projects\'").get())fail("BROKER_NOT_INITIALIZED","本机尚未建立明确的项目任务登记");
 const rows=db.prepare("SELECT t.id,t.task_uid,t.owner_node_id,t.kind,t.parent_id,t.blocked_by FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE p.project_id=? ORDER BY t.id LIMIT ?").all(projectId,MAX_GRAPH_VERTICES+1),ids=new Map(rows.map(t=>[t.id,t.task_uid]));
 if(rows.length>MAX_GRAPH_VERTICES)fail("GRAPH_LIMIT","本地项目任务数超过上限");
 const vertices=rows.map(t=>{
  if(t.owner_node_id!==n.node_id||t.kind==="goal"&&t.parent_id!==null)fail("BAD_LOCAL_GRAPH","本地任务身份或目标层级无效");
  let deps;try{deps=JSON.parse(t.blocked_by);}catch{fail("BAD_LOCAL_GRAPH","本地依赖格式损坏");}
  if(!Array.isArray(deps)||deps.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(deps).size!==deps.length)fail("BAD_LOCAL_GRAPH","本地依赖集合无效");
  if((t.parent_id!==null&&!ids.has(t.parent_id))||deps.some(id=>!ids.has(id)))fail("MISSING_LOCAL_REFERENCE","关系端点未登记到同一项目，不能隐式共享其他任务");
  return {task_uid:t.task_uid,parent_uid:t.parent_id===null?null:ids.get(t.parent_id),blocked_by:deps.map(id=>ids.get(id))};
 });
 const s=normalizeTopology({schema_version:1,project_id:projectId,graph_id:graphId,graph_epoch:graphEpoch,owner_node_id:n.node_id,owner_epoch:n.sync_epoch,revision,vertices});validateCombinedGraph([s]);return {snapshot:s,snapshot_digest:digest(s),frozen:false,dispatch_ready:false};
}
export function listRelationGraphs(db){const n=localIdentity(db);return db.prepare("SELECT * FROM relation_graphs ORDER BY project_id").all().map(g=>({...g,identity_current:g.registrar_node_id===n.node_id&&g.registrar_epoch===n.sync_epoch}));}

/** Both authenticated endpoints approve the same source decision and target readiness.
 * Historical edges remain; the active graph excludes only durable completion receipts. */
export function completeRelation(db,peer,args){
 exact(args,["request_id","expected_version","completion"],"complete relation");const c=normalizeCompletion(args.completion),d=c.plan.relation;version(args.expected_version);
 return unit(db,()=>{const g=graph(db,d);authorize(db,g,peer,"relations:complete");const side=peer.peer_node_id===d.source_node_id?"source":peer.peer_node_id===d.target_node_id?"target":null;if(!side||peer.peer_epoch!==d[side+"_epoch"])fail("FORBIDDEN","只有原委派双方可确认完成",403);
  return request(db,g,peer,args.request_id,"complete",args,()=>{
   const edge=db.prepare("SELECT receipt_json FROM relation_edges WHERE relation_id=? AND graph_id=?").get(d.relation_id,g.graph_id);if(!edge||canonical(JSON.parse(edge.receipt_json).relation)!==canonical(d))fail("CONTRACT_MISMATCH","完成不属于已确认关系");
   if(db.prepare("SELECT 1 FROM relation_cancellation_proposals WHERE relation_id=?").get(d.relation_id))fail("CANCELLATION_COMMITTED","关系已进入取消退役");
   const prior=db.prepare("SELECT * FROM relation_completion_proposals WHERE relation_id=?").get(d.relation_id);if(prior&&prior.completion_digest!==digest(c))fail("REQUEST_CONFLICT","完成合同已固定");
   const done=db.prepare("SELECT receipt_json FROM relation_completions WHERE relation_id=?").get(d.relation_id);if(done)return JSON.parse(done.receipt_json);
   seenVersion(g,args.expected_version);
   if(!prior)db.prepare("INSERT INTO relation_completion_proposals VALUES(?,?,?,?,?)").run(d.relation_id,c.plan.completion_id,canonical(c),digest(c),at());
   db.prepare("INSERT OR IGNORE INTO relation_completion_votes VALUES(?,?,?,?,?,?)").run(d.relation_id,peer.peer_node_id,peer.peer_epoch,peer.peer_node_id===g.registrar_node_id?0:peer.credential_version,digest(c),at());
   const approvals=validApprovals(db,g,d,{completion:c});if(approvals.length<2)return {schema_version:1,kind:"relation_completion_pending",relation_id:d.relation_id,completion_digest:digest(c),graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,approved_by:approvals.map(a=>a.node_id),completed:false,dispatch_ready:false};
   const proof=validateCombinedGraph(snapshots(db,g),edges(db,g,d.relation_id));
   db.prepare("UPDATE relation_graphs SET version=version+1 WHERE graph_id=?").run(g.graph_id);g.version++;
   const receipt={schema_version:1,kind:"relation_completed",project_id:g.project_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,registrar_node_id:g.registrar_node_id,registrar_epoch:g.registrar_epoch,relation_id:d.relation_id,descriptor_digest:digest(d),completion:c,completion_digest:digest(c),approved_by:approvals.map(a=>({node_id:a.node_id,node_epoch:a.node_epoch,credential_version:a.credential_version})),...proof,completed:true,dispatch_ready:false};
   db.prepare("INSERT INTO relation_completions VALUES(?,?,?,?,?,?)").run(d.relation_id,g.graph_id,c.plan.completion_id,digest(c),canonical(receipt),at());event(db,g,"relation_completed",peer.peer_node_id,{relation_id:d.relation_id,completion_digest:digest(c),...proof});return receipt;
  });
 });
}

/** Retire only after both current authenticated endpoints bind the same stop proof.
 * Original edges and cancellation evidence stay in history; no business acceptance. */
export function cancelRelation(db,peer,args){
 exact(args,["request_id","expected_version","cancellation"],"cancel relation");const c=normalizeCancellationClosure(args.cancellation),d=c.request.relation;version(args.expected_version);
 return unit(db,()=>{const g=graph(db,d);authorize(db,g,peer,"relations:complete");const side=peer.peer_node_id===d.source_node_id?"source":peer.peer_node_id===d.target_node_id?"target":null;if(!side||peer.peer_epoch!==d[side+"_epoch"])fail("FORBIDDEN","只有原委派双方可确认取消退役",403);
  return request(db,g,peer,args.request_id,"cancel",args,()=>{
   const edge=db.prepare("SELECT receipt_json FROM relation_edges WHERE relation_id=? AND graph_id=?").get(d.relation_id,g.graph_id);if(!edge||canonical(JSON.parse(edge.receipt_json).relation)!==canonical(d))fail("CONTRACT_MISMATCH","取消不属于已确认关系");
   if(db.prepare("SELECT 1 FROM relation_completion_proposals WHERE relation_id=?").get(d.relation_id))fail("COMPLETION_COMMITTED","关系已进入完成登记");
   const prior=db.prepare("SELECT * FROM relation_cancellation_proposals WHERE relation_id=?").get(d.relation_id);if(prior&&prior.cancellation_digest!==digest(c))fail("REQUEST_CONFLICT","取消停止证明已固定");
   const done=db.prepare("SELECT receipt_json FROM relation_cancellations WHERE relation_id=?").get(d.relation_id);if(done)return JSON.parse(done.receipt_json);seenVersion(g,args.expected_version);
   if(!prior)db.prepare("INSERT INTO relation_cancellation_proposals VALUES(?,?,?,?,?)").run(d.relation_id,c.request.cancel_id,canonical(c),digest(c),at());
   db.prepare("INSERT OR IGNORE INTO relation_cancellation_votes VALUES(?,?,?,?,?,?)").run(d.relation_id,peer.peer_node_id,peer.peer_epoch,peer.peer_node_id===g.registrar_node_id?0:peer.credential_version,digest(c),at());
   const approvals=validApprovals(db,g,d,{cancellation:c});if(approvals.length<2)return {schema_version:1,kind:"relation_cancellation_pending",relation_id:d.relation_id,cancellation_digest:digest(c),graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,approved_by:approvals.map(a=>a.node_id),cancelled:false,dispatch_ready:false};
   const proof=validateCombinedGraph(snapshots(db,g),edges(db,g,d.relation_id));db.prepare("UPDATE relation_graphs SET version=version+1 WHERE graph_id=?").run(g.graph_id);g.version++;
   const receipt={schema_version:1,kind:"relation_cancelled",project_id:g.project_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,graph_version:g.version,registrar_node_id:g.registrar_node_id,registrar_epoch:g.registrar_epoch,relation_id:d.relation_id,descriptor_digest:digest(d),cancellation:c,cancellation_digest:digest(c),approved_by:approvals.map(a=>({node_id:a.node_id,node_epoch:a.node_epoch,credential_version:a.credential_version})),...proof,cancelled:true,dispatch_ready:false};
   db.prepare("INSERT INTO relation_cancellations VALUES(?,?,?,?,?,?)").run(d.relation_id,g.graph_id,c.request.cancel_id,digest(c),canonical(receipt),at());event(db,g,"relation_cancelled",peer.peer_node_id,{relation_id:d.relation_id,cancellation_digest:digest(c),...proof});return receipt;
  });
 });
}
