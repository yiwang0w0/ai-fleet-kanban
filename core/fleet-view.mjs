// Operator-only projection of local tasks and previously authorized remote copies.
// No migrations, writes, network requests or credential material are exposed here.
import {createRequire} from "node:module";
import {listReplicas,syncStatus} from "./federation/sync-store.mjs";
import {PeerError,names} from "./federation/protocol.mjs";
import {createHash} from "node:crypto";
const store=createRequire(import.meta.url)("./store.js");
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function snapshot(db,work){if(db.isTransaction)return work();db.exec("BEGIN");try{return work();}finally{db.exec("ROLLBACK");}}
function options({projectId=null,ownerNodeId=null,query="",limit=1000,offset=0,now=Date.now()}={}){
 if(projectId!==null&&(typeof projectId!=="string"||!projectId||projectId.length>128)||ownerNodeId!==null&&(typeof ownerNodeId!=="string"||!store.UUID_RE.test(ownerNodeId))||typeof query!=="string"||query.length>160||!Number.isInteger(limit)||limit<1||limit>10000||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isFinite(now))throw new PeerError("BAD_INPUT","全局视图筛选参数无效",400);
 return {projectId,ownerNodeId,query:query.trim().toLocaleLowerCase(),limit,offset,now};
}
function data(db,authorizedProjects=null){
 const scope=authorizedProjects===null?null:new Set(names(authorizedProjects,"projects",null,1));
 const local=store.localNode(db),shares=new Map(exists(db,"federation_shares")?db.prepare("SELECT task_id,project_id FROM federation_shares").all().map(r=>[r.task_id,r.project_id]):[]);
 const parents=new Map(db.prepare("SELECT id,task_uid FROM tasks").all().map(t=>[t.id,t.task_uid]));
 let localTasks=store.list(db).tasks.map(t=>({...t,parent_uid:t.parent_id===null?null:parents.get(t.parent_id)??null,project_id:shares.get(t.id)??null,read_only:false,owner_name:local.display_name,recovery_state:null}));
 const schema=exists(db,"federation_sync_schema")?db.prepare("SELECT version FROM federation_sync_schema WHERE singleton=1").get()?.version:null;
 const ready=schema===4,sync=ready?syncStatus(db):{sources:[],cursors:[],attempts:[],epoch_projects:[],snapshot_staging:[],pending:[],deliveries:[]};
 let remote=ready?listReplicas(db).filter(t=>!t.archived_at):[];
 let peers=exists(db,"federation_peers")?db.prepare("SELECT peer_node_id,status,projects_json FROM federation_peers").all():[];
 if(scope){
  const admitted=new Map(exists(db,"broker_task_projects")?db.prepare("SELECT task_uid,project_id FROM broker_task_projects").all().filter(p=>scope.has(p.project_id)).map(p=>[p.task_uid,p.project_id]):[]);
  localTasks=localTasks.filter(t=>admitted.has(t.task_uid)).map(t=>({...t,project_id:admitted.get(t.task_uid)}));
  remote=remote.filter(t=>scope.has(t.project_id));
  const visible=new Map([...localTasks,...remote].map(t=>[t.task_uid,t.project_id]));
  for(const t of [...localTasks,...remote])if(t.parent_uid&&visible.get(t.parent_uid)!==t.project_id){t.parent_uid=null;t.parent_unavailable=true;}
  for(const key of ["cursors","attempts","epoch_projects","snapshot_staging","pending","deliveries"])sync[key]=sync[key].filter(p=>scope.has(p.project_id));
  peers=peers.filter(p=>JSON.parse(p.projects_json).some(id=>scope.has(id)));
  const origins=new Set([...remote.map(t=>t.owner_node_id),...peers.map(p=>p.peer_node_id),...sync.cursors.map(p=>p.origin_node_id),...sync.attempts.map(p=>p.origin_node_id),...sync.epoch_projects.map(p=>p.origin_node_id),...sync.snapshot_staging.map(p=>p.origin_node_id)]);
  sync.sources=sync.sources.filter(s=>origins.has(s.origin_node_id));
 }
 peers=peers.map(({projects_json,...p})=>({...p,projects:JSON.parse(projects_json).filter(id=>!scope||scope.has(id))}));
 return {local,localTasks,remote,sync,peers,syncState:ready?"available":schema===null?"not_configured":"upgrade_required"};
}
function summary(t){return {task_uid:t.task_uid,owner_node_id:t.owner_node_id,owner_name:t.owner_name,local_id:t.read_only?null:t.id,project_id:t.project_id,parent_uid:t.parent_uid??null,parent_unavailable:!!t.parent_unavailable,subject:t.subject,status:t.status,waiting_for:t.waiting_for??null,kind:t.kind,aggregate_version:t.aggregate_version,run_id:t.run_id??null,updated_at:t.updated_at,read_only:!!t.read_only,recovery_state:t.recovery_state??null,received_at:t.received_at??null,source_epoch:t.source_epoch??null,last_sync_at:t.last_sync_at??null};}
function freshness(p,now){
 if(p.recovery)return "recovery";if(p.error_code)return "failed";if(p.has_more)return "syncing";if(!p.last_sync_at)return "unknown";
 const at=Date.parse(p.last_sync_at);if(!Number.isFinite(at)||at>now+60000)return "clock_unknown";return now-at>60000?"stale":"recent";
}
function buildView(d,o){
  const nodes=new Map(),projects=new Set();
  nodes.set(d.local.node_id,{node_id:d.local.node_id,display_name:d.local.display_name,local:true,projects:[],last_seen_at:null,peer_status:null});
  const node=id=>{if(!nodes.has(id))nodes.set(id,{node_id:id,display_name:id,local:false,projects:[],last_seen_at:null,peer_status:null});return nodes.get(id);};
  for(const p of d.peers)node(p.peer_node_id).peer_status=p.status;
  for(const s of d.sync.sources)Object.assign(node(s.origin_node_id),{display_name:s.display_name,last_seen_at:s.last_seen_at});
  const project=(origin,id)=>{projects.add(id);const n=node(origin);let p=n.projects.find(p=>p.project_id===id);if(!p){p={project_id:id,last_sync_at:null,last_attempt_at:null,error_code:null,has_more:false,recovery:false,received:false};n.projects.push(p);}return p;};
  for(const p of d.peers)for(const id of p.projects)project(p.peer_node_id,id);
  for(const c of d.sync.cursors)Object.assign(project(c.origin_node_id,c.project_id),{last_sync_at:c.updated_at,received:true});
  for(const a of d.sync.attempts)Object.assign(project(a.origin_node_id,a.project_id),{last_sync_at:a.last_success_at??null,last_attempt_at:a.last_attempt_at,error_code:a.error_code,has_more:a.has_more===1});
  for(const p of d.sync.epoch_projects)if(p.state==="pending")project(p.origin_node_id,p.project_id).recovery=true;
  for(const p of d.sync.snapshot_staging)project(p.origin_node_id,p.project_id).recovery=true;
  for(const t of d.remote){const p=project(t.owner_node_id,t.project_id);p.received=true;if(t.recovery_state)p.recovery=true;}
  for(const t of d.localTasks)if(t.project_id)projects.add(t.project_id);
  for(const n of nodes.values())for(const p of n.projects)p.state=freshness(p,o.now);
  const matching=[...d.localTasks,...d.remote].map(summary).filter(t=>(!o.projectId||t.project_id===o.projectId)&&(!o.ownerNodeId||t.owner_node_id===o.ownerNodeId)&&(!o.query||(t.subject+" "+t.task_uid).toLocaleLowerCase().includes(o.query)));
  const totals=new Map();for(const t of matching){let c=totals.get(t.owner_node_id);if(!c){c={total:0,not_started:0,in_progress:0,waiting:0,done:0};totals.set(t.owner_node_id,c);}c.total++;if(["not_started","in_progress","waiting","done"].includes(t.status))c[t.status]++;}
  const visibleNodes=[...nodes.values()].filter(n=>!o.ownerNodeId||n.node_id===o.ownerNodeId).sort((a,b)=>Number(b.local)-Number(a.local)||a.display_name.localeCompare(b.display_name)||a.node_id.localeCompare(b.node_id));
  for(const n of visibleNodes){const relevant=n.projects.filter(p=>!o.projectId||p.project_id===o.projectId),received=n.local||relevant.some(p=>p.received||p.last_sync_at);n.counts=received?(totals.get(n.node_id)??{total:0,not_started:0,in_progress:0,waiting:0,done:0}):null;n.projects=relevant;n.connection_state=n.local?"local":["recovery","failed","syncing","clock_unknown","unknown","stale","recent"].find(state=>relevant.some(p=>p.state===state))??"unknown";}
  matching.sort((a,b)=>a.task_uid.localeCompare(b.task_uid));
  const snapshot_id=createHash("sha256").update(JSON.stringify({matching,nodes:visibleNodes})).digest("hex");
  const selected=matching.slice(o.offset,o.offset+o.limit),included=new Set(selected.map(t=>t.task_uid));
  return {format:"ai-fleet-view/v1",snapshot_id,offset:o.offset,next_offset:o.offset+selected.length<matching.length?o.offset+selected.length:null,generated_at:new Date(o.now).toISOString(),local_node_id:d.local.node_id,sync_state:d.syncState,projects:[...projects].sort(),nodes:visibleNodes,tasks:selected.map(t=>({...t,parent_in_view:!!t.parent_uid&&included.has(t.parent_uid)})),total_matching:matching.length,returned:selected.length,truncated:o.offset+selected.length<matching.length,pending_publications:d.sync.pending.reduce((n,p)=>n+p.tasks,0),pending_acknowledgements:d.sync.deliveries.filter(p=>p.offered_seq>p.acked_seq).length};
}
export function readFleetView(db,query={},authorizedProjects=null){return snapshot(db,()=>buildView(data(db,authorizedProjects),options(query)));}
const detail=t=>({...summary(t),description:t.description??"",acceptance:t.acceptance??"",result:t.result??null,verdict_note:t.verdict_note??null});
export function readFleetSnapshot(db,query={},authorizedProjects=null){return snapshot(db,()=>{const d=data(db,authorizedProjects),view=buildView(d,options(query)),byUid=new Map([...d.localTasks,...d.remote].map(t=>[t.task_uid,t]));return {view,tasks:view.tasks.map(t=>detail(byUid.get(t.task_uid)))};});}
export function readFleetTask(db,uid,authorizedProjects=null){
 if(typeof uid!=="string"||uid.length>100)throw new PeerError("BAD_INPUT","任务 UID 无效",400);
 return snapshot(db,()=>{const d=data(db,authorizedProjects),t=[...d.localTasks,...d.remote].find(t=>t.task_uid===uid);if(!t)throw new PeerError("NOT_FOUND","当前视图中未找到任务",404);return detail(t);});
}
