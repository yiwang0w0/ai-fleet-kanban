import {PeerError,CANCELLATION_CLOSURE,OPERATOR_STOP_EVIDENCE} from "./protocol.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {localIdentity} from "./peers.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {cancelRelation,relationStatus,localRegistrarPeer} from "./relations.mjs";
import {bindingState} from "./bindings.mjs";
import {topologyState,checkRegistrarStatus} from "./topology.mjs";
import {cancellationClosureState,startCancellationRetirement,rejectCancellationRetirement,recordCancellationRetirement} from "./cancellation-closure.mjs";
export async function submitCancellationRetirement(db,{relationId,mode="approve",url,credentialFile,fetchImpl=fetch,signal,authorize=()=>{}}){
 if(!["approve","poll"].includes(mode))throw new PeerError("BAD_INPUT","取消退役操作无效");authorize();const s=cancellationClosureState(db,relationId);if(s.retirement)return {...s,delivery_state:"acknowledged"};if(!s.stopped)throw new PeerError("STOP_UNCONFIRMED","先取得执行端停止证明",409);
 const d=s.request.relation,b=bindingState(db,relationId),n=localIdentity(db);let call;
 if(b.registrar_node_id===n.node_id){if(b.registrar_epoch!==n.sync_epoch)throw new PeerError("GRAPH_RECOVERY_REQUIRED","登记节点代次已变化",409);const peer=localRegistrarPeer(db,d.project_id);call=async(action,args)=>{authorize();return action==="cancel"?cancelRelation(db,peer,args):relationStatus(db,peer,args);};}
 else{
  const base=endpoint(url),c=loadCredential(credentialFile,n,d.project_id,["peer:handshake","relations:read","relations:complete"],base);if(c.server_node_id!==b.registrar_node_id||c.server_epoch!==b.registrar_epoch)throw new PeerError("IDENTITY_MISMATCH","凭据不是固定登记节点",403);let ready=false;const required=[CANCELLATION_CLOSURE,...(s.receipt.schema_version===2?[OPERATOR_STOP_EVIDENCE]:[])];
  call=async(action,args)=>{if(!ready){const h=await request(base,"/peer/v1/hello",c,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:required,required_extensions:[],extensions:{}},fetchImpl,signal,["REQUIRED_FEATURE_UNSUPPORTED"]);if(h.protocol_version!==1||h.node?.node_id!==b.registrar_node_id||h.node?.sync_epoch!==b.registrar_epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==c.credential_version)throw new PeerError("IDENTITY_MISMATCH","取消退役握手身份不匹配");if(!Array.isArray(h.capabilities)||required.some(cap=>!h.capabilities.includes(cap)))throw new PeerError("REQUIRED_FEATURE_UNSUPPORTED","登记节点未支持取消退役",426);ready=true;}return request(base,"/peer/v1/relations/"+action,c,args,fetchImpl,signal,["GRAPH_VERSION_CONFLICT","COMPLETION_COMMITTED","CANCELLATION_COMMITTED","REQUEST_CONFLICT"]);};
 }
 const query={project_id:d.project_id,graph_id:d.graph_id,graph_epoch:d.graph_epoch,relation_id:relationId};let args=null,stage="network";
 try{
  if(mode==="poll"){const r=await call("status",query);stage="persist";authorize();if(r.kind==="relation_cancelled")return {...recordCancellationRetirement(db,{relationId,receipt:r,authorize}),delivery_state:"acknowledged"};if(r.kind!=="relation_confirmed"||r.descriptor_digest!==digest(d)||canonical(r.relation)!==canonical(d))throw new PeerError("RECEIPT_MISMATCH","登记状态不属于当前关系");return {...cancellationClosureState(db,relationId),delivery_state:"waiting_peer"};}
  if(s.attempts.some(a=>a.state==="pending")){stage="persist";args=startCancellationRetirement(db,{relationId,authorize});}
  else{const r=await call("status",{...query,relation_id:null});checkRegistrarStatus(topologyState(db,d.project_id),r);stage="persist";args=startCancellationRetirement(db,{relationId,expectedVersion:r.version,authorize});}
  stage="network";const r=await call("cancel",args);stage="persist";authorize();return {...recordCancellationRetirement(db,{relationId,requestId:args.request_id,receipt:r,authorize}),delivery_state:r.cancelled?"acknowledged":"waiting_peer"};
 }catch(e){if(stage==="network"&&args&&e.code==="GRAPH_VERSION_CONFLICT")return {...rejectCancellationRetirement(db,{relationId,requestId:args.request_id,code:e.code,authorize}),delivery_state:"rejected",error_code:e.code};const latest=cancellationClosureState(db,relationId);if(latest.retirement)return {...latest,delivery_state:"acknowledged"};const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";return {...latest,delivery_state:["STORAGE_ERROR","TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
}
