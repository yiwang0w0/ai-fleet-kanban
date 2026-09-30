import {PeerError,uuid,version} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {localRegistrarPeer,publishTopology,relationStatus} from "./relations.mjs";
import {topologyState,topologyOperation,startTopologyAttempt,rejectTopologyAttempt,acceptTopologyReceipt,cancelPreparedTopology,checkRegistrarStatus,DEFINITIVE_TOPOLOGY_REJECTIONS} from "./topology.mjs";
import {digest} from "./sync-store.mjs";
/** One delivery, with durable replay after unknown outcomes; no retry loop or model calls. */
export async function sendTopology(db,{operationId,url,credentialFile,mode="publish",fetchImpl=fetch,signal}){
 if(!["publish","cancel"].includes(mode))throw new PeerError("BAD_INPUT","提交模式无效");
 const op=topologyOperation(db,operationId),b=topologyState(db,op.project_id),n=localIdentity(db);
 if(op.state!=="prepared")return {...op,delivery_state:op.state};
 if(mode==="cancel"&&!op.attempts.length)return {...cancelPreparedTopology(db,{operationId}),delivery_state:"cancelled"};
 if(mode==="cancel"&&op.attempts.some(a=>a.state!=="rejected"))throw new PeerError("UNKNOWN_REMOTE_OUTCOME","先重试未确定的请求，不能盲目恢复旧边",409);
 let call;
 if(b.registrar_node_id===n.node_id){
  if(b.registrar_epoch!==n.sync_epoch)throw new PeerError("GRAPH_RECOVERY_REQUIRED","登记节点已换代",409);
  const peer=localRegistrarPeer(db,b.project_id);
  call=async(action,body)=>action==="status"?relationStatus(db,peer,body):publishTopology(db,peer,body);
 }else{
  const base=endpoint(url),c=loadCredential(credentialFile,n,b.project_id,["peer:handshake","relations:publish","relations:read"]);
  if(c.server_node_id!==b.registrar_node_id||c.server_epoch!==b.registrar_epoch)throw new PeerError("IDENTITY_MISMATCH","凭据未绑定指定登记节点",403);
  let helloDone=false;
  call=async(action,body)=>{
   if(!helloDone){
    const h=await request(base,"/peer/v1/hello",c,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:["project-relations-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
    if(h.protocol_version!==1||h.node?.node_id!==c.server_node_id||h.node?.sync_epoch!==c.server_epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==c.credential_version||!h.capabilities?.includes("project-relations-v1"))throw new PeerError("SOURCE_MISMATCH","登记节点握手未通过身份核对");
    helloDone=true;
   }
   return request(base,"/peer/v1/relations/"+action,c,body,fetchImpl,signal,DEFINITIVE_TOPOLOGY_REJECTIONS);
  };
 }
 let args=null,stage="network";
 try{
  const pending=op.attempts.find(a=>a.state==="pending");
  if(pending&&mode==="publish")args={request_id:pending.request_id,expected_version:pending.expected_version,snapshot:op.desired};
  else{
   const s=await call("status",{project_id:b.project_id,graph_id:b.graph_id,graph_epoch:b.graph_epoch,relation_id:null});checkRegistrarStatus(b,s);
   if(mode==="cancel"){stage="persist";return {...cancelPreparedTopology(db,{operationId,observedGraph:s}),delivery_state:"cancelled"};}
   const own=s.topologies.find(t=>t.node_id===n.node_id);
   if(b.revision===0?own!==undefined:!own||own.node_epoch!==n.sync_epoch||own.revision!==b.revision||own.snapshot_digest!==digest(b.snapshot))throw new PeerError("TOPOLOGY_DIVERGED","登记节点与已提交本地图不一致",409);
   stage="persist";args=startTopologyAttempt(db,{operationId,expectedVersion:s.version});stage="network";
  }
  const receipt=await call("publish",args);stage="persist";
  return {...acceptTopologyReceipt(db,{operationId,requestId:args.request_id,receipt}),delivery_state:"acknowledged"};
 }catch(e){
  const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";
  const latest=topologyOperation(db,operationId);if(latest.state!=="prepared")return {...latest,delivery_state:latest.state==="applied"?"acknowledged":latest.state};
  if(stage==="network"&&args&&DEFINITIVE_TOPOLOGY_REJECTIONS.includes(code)){
   const result=rejectTopologyAttempt(db,{operationId,requestId:args.request_id,code});
   return result.state==="applied"?{...result,delivery_state:"acknowledged"}:{...result,delivery_state:"rejected",error_code:code};
  }
  // Even a later authentication failure cannot disprove success of an earlier lost-response attempt.
  return {...topologyOperation(db,operationId),delivery_state:["TRANSPORT_ERROR","STORAGE_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};
 }
}

/** Authenticated observation of the fixed registrar; never an execution grant. */
export async function readRegistrarStatus(db,{projectId,url,credentialFile,fetchImpl=fetch,signal}){
 const b=topologyState(db,projectId),n=localIdentity(db),args={project_id:projectId,graph_id:b.graph_id,graph_epoch:b.graph_epoch,relation_id:null};let s;
 if(b.registrar_node_id===n.node_id){
  if(b.registrar_epoch!==n.sync_epoch)throw new PeerError("GRAPH_RECOVERY_REQUIRED","登记节点已换代",409);
  s=relationStatus(db,localRegistrarPeer(db,projectId),args);
 }else{
  const base=endpoint(url),c=loadCredential(credentialFile,n,projectId,["peer:handshake","relations:read"]);
  if(c.server_node_id!==b.registrar_node_id||c.server_epoch!==b.registrar_epoch)throw new PeerError("IDENTITY_MISMATCH","凭据未绑定指定登记节点",403);
  const h=await request(base,"/peer/v1/hello",c,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:["project-relations-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
  if(h.protocol_version!==1||h.node?.node_id!==c.server_node_id||h.node?.sync_epoch!==c.server_epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==c.credential_version||!h.capabilities?.includes("project-relations-v1"))throw new PeerError("SOURCE_MISMATCH","登记节点握手未通过身份核对");
  s=await request(base,"/peer/v1/relations/status",c,args,fetchImpl,signal);
 }
 if(!s||!Array.isArray(s.members)||!Array.isArray(s.topologies)||[...s.members,...s.topologies].some(x=>!x||typeof x!=="object"||Array.isArray(x)))throw new PeerError("BAD_RESPONSE","登记状态集合无效");
 checkRegistrarStatus(b,s);
 // Persist only bounded, validated public fields, never arbitrary response contents.
 if(s.members.length>10000||s.topologies.length>10000)throw new PeerError("BAD_RESPONSE","登记状态超过上限");
 const members=s.members.map(m=>({node_id:uuid(m.node_id,"node_id"),node_epoch:uuid(m.node_epoch,"node_epoch")}));
 const topologies=s.topologies.map(t=>{version(t.revision);if(!/^[0-9a-f]{64}$/.test(t.snapshot_digest))throw new PeerError("BAD_RESPONSE","结构摘要无效");return {node_id:uuid(t.node_id,"node_id"),node_epoch:uuid(t.node_epoch,"node_epoch"),revision:t.revision,snapshot_digest:t.snapshot_digest};});
 if(new Set(members.map(m=>m.node_id)).size!==members.length||new Set(topologies.map(t=>t.node_id)).size!==topologies.length||topologies.some(t=>!members.some(m=>m.node_id===t.node_id&&m.node_epoch===t.node_epoch)))throw new PeerError("BAD_RESPONSE","登记节点集合不一致");
 return {project_id:b.project_id,graph_id:b.graph_id,graph_epoch:b.graph_epoch,registrar_node_id:b.registrar_node_id,registrar_epoch:b.registrar_epoch,version:s.version,members,topologies};
}
