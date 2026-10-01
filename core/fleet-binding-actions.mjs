import {PeerError,uuid} from "./federation/protocol.mjs";
import {canonical,digest} from "./federation/sync-store.mjs";
import {exact} from "./mcp/policy.mjs";
import {callTool} from "./mcp/tools.mjs";
import {topologyState,topologyOperation,checkRegistrarStatus} from "./federation/topology.mjs";
import {readRegistrarStatus,sendTopology} from "./federation/topology-client.mjs";
import {submitBinding,sendBindingMessage} from "./federation/binding-client.mjs";
import {outgoingStatus} from "./federation/delegation.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
export const BINDING_LOCAL=new Set(["publish_topology","propose_binding","accept_binding_proposal"]);
export const BINDING_NETWORK={refresh_registration:["registration","read"],resend_topology:["topology","publish"],cancel_topology:["topology","cancel"],approve_binding:["binding","approve"],poll_binding:["binding","poll"],withdraw_binding:["binding","withdraw"],cancel_binding:["binding","cancel"],send_binding_proposal:["binding_message","proposal"],send_source_ready:["binding_message","source_ready"]};
export function migrateFleetBindings(db){
 db.exec("CREATE TABLE IF NOT EXISTS fleet_registrar_observations(project_id TEXT PRIMARY KEY,status_json TEXT NOT NULL,observed_at TEXT NOT NULL)");
}
function observation(db,b){
 const row=db.prepare("SELECT * FROM fleet_registrar_observations WHERE project_id=?").get(b.project_id);
 if(!row)fail("REGISTRATION_REQUIRED","先读取登记节点状态");
 const s=JSON.parse(row.status_json);checkRegistrarStatus(b,s);return {...row,status:s};
}
export function fleetTopology(db,project){
 try{const b=topologyState(db,project);let observed=null;
  try{const o=observation(db,b);observed={observed_at:o.observed_at,graph_version:o.status.version};}catch(e){if(!(e instanceof PeerError))throw e;}
  return {project_id:project,configured:true,phase:b.phase,revision:b.revision,graph_id:b.graph_id,registrar_node_id:b.registrar_node_id,operation_id:b.operation?.operation_id??null,observed};
 }catch(e){if(e instanceof PeerError)return {project_id:project,configured:false,error_code:e.code};throw e;}
}
function sourceDraft(db,id){
 const v=outgoingStatus(db,id),o=v.offer,b=topologyState(db,o.project_id);
 if(!v.identity_current||v.state!=="accepted_unconfirmed")fail("DELEGATION_NOT_ACCEPTED","先取得对端接收回执");
 if(b.phase!=="ready")fail("TOPOLOGY_NOT_READY","先登记本机当前任务结构");
 if(db.prepare("SELECT 1 FROM delegation_bindings WHERE delegation_id=? AND state!='cancelled'").get(id))fail("BINDING_EXISTS","委派已有绑定记录");
 const observed=observation(db,b),s=observed.status,own=s.topologies.find(t=>t.node_id===o.source_node_id),other=s.topologies.find(t=>t.node_id===o.target_node_id);
 if(!own||own.node_epoch!==o.source_epoch||own.revision!==b.revision||own.snapshot_digest!==digest(b.snapshot))fail("TOPOLOGY_DIVERGED","登记状态与本机结构不一致，请刷新");
 if(!other||other.node_epoch!==o.target_epoch||!s.members.some(m=>m.node_id===o.target_node_id&&m.node_epoch===o.target_epoch))fail("TARGET_TOPOLOGY_REQUIRED","对端尚未登记当前代次的任务结构");
 const task=db.prepare("SELECT t.aggregate_version FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE t.task_uid=? AND p.project_id=? AND t.owner_node_id=?").get(o.source_task_uid,o.project_id,o.source_node_id);
 if(!task)fail("NOT_FOUND","本机来源任务不存在");
 const draft={delegation_id:id,project_id:o.project_id,graph_id:b.graph_id,graph_epoch:b.graph_epoch,source_node_id:o.source_node_id,source_epoch:o.source_epoch,source_task_uid:o.source_task_uid,target_node_id:o.target_node_id,target_epoch:o.target_epoch,target_task_uid:v.receipt.target_task_uid,offer_digest:v.offer_digest,source_topology_revision:b.revision,target_topology_revision:other.revision,expected_version:task.aggregate_version,registration_digest:digest(s)};
 return {...draft,review_digest:digest(draft),observed_at:observed.observed_at};
}
export function fleetBindingDraft(db,id){try{return {ready:true,...sourceDraft(db,id)};}catch(e){if(e instanceof PeerError)return {ready:false,error_code:e.code};throw e;}}
export function prepareFleetBinding(db,{command,args,project,requestId,auth}){
 if(command==="publish_topology"){
  exact(args,["expected_revision"],"publish_topology");
  const v=callTool(db,auth,"prepare_topology",{request_id:requestId,project_id:project,expected_revision:args.expected_revision,edits:[]});
  return {v,kind:"topology",id:v.operation_id,mode:"publish"};
 }
 if(command==="propose_binding"){
  exact(args,["delegation_id","review_digest"],"propose_binding");uuid(args.delegation_id,"delegation_id");
  const allowed=callTool(db,auth,"get_delegation",{delegation_id:args.delegation_id,direction:"outgoing"});
  if(allowed.project_id!==project)fail("NOT_FOUND","当前项目未找到委派");
  const draft=sourceDraft(db,args.delegation_id);
  if(draft.review_digest!==args.review_digest)fail("REVIEW_CHANGED","任务或登记状态已变化，请重新核对");
  const {review_digest,observed_at,expected_version,registration_digest,...fields}=draft;
  const relation={schema_version:1,type:"delegation",relation_id:requestId,...fields};
  const v=callTool(db,auth,"prepare_binding",{request_id:requestId,relation,expected_version});
  return {v,kind:"binding",id:requestId,mode:"approve"};
 }
 exact(args,["relation_id","descriptor_digest","expected_version"],"accept_binding_proposal");uuid(args.relation_id,"relation_id");
 const p=callTool(db,auth,"get_binding_proposal",{relation_id:args.relation_id});
 if(p.relation.project_id!==project)fail("NOT_FOUND","当前项目未找到绑定提案");
 if(p.descriptor_digest!==args.descriptor_digest)fail("REVIEW_CHANGED","提案摘要已变化");
 const v=callTool(db,auth,"prepare_binding",{request_id:requestId,relation:p.relation,expected_version:args.expected_version});
 return {v,kind:"binding",id:args.relation_id,mode:"approve"};
}
export function fleetBindingTransport(db,{kind,id,project,auth}){
 let v,nodeId,epoch;
 if(kind==="registration"||kind==="topology"){
  if(kind==="registration"&&id!==project)fail("NOT_FOUND","登记项目不匹配");
  if(kind==="topology"&&topologyOperation(db,id).project_id!==project)fail("NOT_FOUND","结构操作不属于当前项目");
  v=topologyState(db,project);nodeId=v.registrar_node_id;epoch=v.registrar_epoch;
 }else{
  v=callTool(db,auth,"get_binding",{relation_id:id});if(v.project_id!==project)fail("NOT_FOUND","绑定不属于当前项目");
  if(kind==="binding_message"){if(v.side!=="source")fail("FORBIDDEN","仅来源端可发送绑定提案和就绪证明");nodeId=v.relation.target_node_id;epoch=v.relation.target_epoch;}
  else{nodeId=v.registrar_node_id;epoch=v.registrar_epoch;}
 }
 return {v,binding:{kind,id,node_id:nodeId,node_epoch:epoch}};
}
export async function deliverFleetBinding(db,{binding,project,options,authorize,now}){
 if(binding.kind==="topology")return sendTopology(db,{...options,operationId:binding.id});
 if(binding.kind==="binding")return submitBinding(db,{...options,relationId:binding.id});
 if(binding.kind==="binding_message")return sendBindingMessage(db,{...options,relationId:binding.id,kind:binding.mode});
 try{
  const b=topologyState(db,project),s=await readRegistrarStatus(db,{...options,projectId:project});authorize();checkRegistrarStatus(topologyState(db,project),s);
  if(b.graph_id!==s.graph_id||b.graph_epoch!==s.graph_epoch)fail("GRAPH_MISMATCH","登记状态已变化");
  db.prepare("INSERT INTO fleet_registrar_observations VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET status_json=excluded.status_json,observed_at=excluded.observed_at").run(project,canonical(s),new Date(now()).toISOString());
  return {state:"observed",delivery_state:"acknowledged",dispatch_started:false};
 }catch(e){const code=e instanceof PeerError?e.code:"TRANSPORT_ERROR";return {delivery_state:["TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
}
