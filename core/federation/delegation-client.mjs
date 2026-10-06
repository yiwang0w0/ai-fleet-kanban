import {PeerError} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {migrateDelegation,outgoingStatus,startDelivery,recordReceipt,deliveryFailure} from "./delegation.mjs";
/** One bounded delivery/poll. The URL and credential file are local operator choices. */
export async function deliverIntent(db,{delegationId,url,credentialFile,mode="offer",fetchImpl=fetch,signal}){
 if(!["offer","status"].includes(mode))throw new PeerError("BAD_INPUT","投递模式无效");
 migrateDelegation(db);
 const base=endpoint(url),node=localIdentity(db),current=outgoingStatus(db,delegationId),o=current.offer;
 const c=loadCredential(credentialFile,node,o.project_id,["peer:handshake","delegation:"+mode],base);
 if(c.server_node_id!==o.target_node_id||c.server_epoch!==o.target_epoch)throw new PeerError("IDENTITY_MISMATCH","投递凭据与指定接收节点不匹配",403);
 startDelivery(db,delegationId);let stage="network";
 try{
  const hello=await request(base,"/peer/v1/hello",c,{node_id:node.node_id,sync_epoch:node.sync_epoch,protocol:{min:1,max:1},required_capabilities:["delegation-intents-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
  if(hello.protocol_version!==1||hello.node?.node_id!==c.server_node_id||hello.node?.sync_epoch!==c.server_epoch||hello.authorized?.peer_node_id!==node.node_id||hello.authorized?.credential_version!==c.credential_version||!hello.capabilities?.includes("delegation-intents-v1"))throw new PeerError("SOURCE_MISMATCH","接收节点握手身份未通过核对");
  const response=await request(base,"/peer/v1/delegation/"+mode,c,mode==="offer"?{offer:o}:{delegation_id:delegationId,project_id:o.project_id},fetchImpl,signal);
  stage="persist";return {...recordReceipt(db,delegationId,response),delivery_state:"acknowledged"};
 }catch(e){
  const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";
  const retryable=["TRANSPORT_ERROR","STORAGE_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code);
  return deliveryFailure(db,delegationId,code,{retryable});
 }
}
