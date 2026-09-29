import {PeerError} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {cancellationState,recordCancellationReceipt} from "./cancellation.mjs";
export async function deliverCancellation(db,{relationId,mode="send",url,credentialFile,fetchImpl=fetch,signal}){
 if(!["send","poll"].includes(mode))throw new PeerError("BAD_INPUT","取消投递模式无效");
 const state=cancellationState(db,relationId);if(state.side!=="source")throw new PeerError("FORBIDDEN","仅来源可以投递取消",403);if(state.state==="stopped")return {...state,delivery_state:"acknowledged"};
 const body=state.request,d=body.relation,n=localIdentity(db),base=endpoint(url),credential=loadCredential(credentialFile,n,d.project_id,["peer:handshake","delegation:offer","delegation:control"]);
 if(credential.server_node_id!==d.target_node_id||credential.server_epoch!==d.target_epoch)throw new PeerError("IDENTITY_MISMATCH","取消凭据不匹配固定接收端",403);
 let stage="network";
 try{
  const h=await request(base,"/peer/v1/hello",credential,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:["delegation-cancellation-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
  if(h.protocol_version!==1||h.node?.node_id!==d.target_node_id||h.node?.sync_epoch!==d.target_epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==credential.credential_version||!h.capabilities?.includes("delegation-cancellation-v1"))throw new PeerError("IDENTITY_MISMATCH","取消握手身份不匹配");
  const r=await request(base,"/peer/v1/delegation/"+(mode==="send"?"cancel":"cancel-status"),credential,mode==="send"?body:{relation_id:relationId,project_id:d.project_id,cancel_id:state.cancel_id},fetchImpl,signal);
  stage="persist";return {...recordCancellationReceipt(db,{relationId,receipt:r}),delivery_state:"acknowledged"};
 }catch(e){const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";return {...cancellationState(db,relationId),delivery_state:["STORAGE_ERROR","TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
}
