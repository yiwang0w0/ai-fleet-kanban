import {PeerError,keys} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {atomic} from "./sync-store.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {resultState,recordResultReceipt,recordResultDecision} from "./results.mjs";
export async function deliverResult(db,{resultId,mode="send",url,credentialFile,fetchImpl=fetch,signal}){
 if(!["send","poll"].includes(mode))throw new PeerError("BAD_INPUT","交付投递模式无效");
 const state=resultState(db,resultId);if(state.side!=="target")throw new PeerError("FORBIDDEN","仅执行端回传交付",403);
 if(state.decision)return {...state,delivery_state:"acknowledged"};
 const body=state.body,d=body.relation,n=localIdentity(db),base=endpoint(url),credential=loadCredential(credentialFile,n,d.project_id,["peer:handshake","delegation:result"],base);
 if(credential.server_node_id!==d.source_node_id||credential.server_epoch!==d.source_epoch)throw new PeerError("IDENTITY_MISMATCH","凭据不匹配固定来源端",403);
 let stage="network";
 try{
  const h=await request(base,"/peer/v1/hello",credential,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:["delegation-results-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
  if(h.protocol_version!==1||h.node?.node_id!==d.source_node_id||h.node?.sync_epoch!==d.source_epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==credential.credential_version||!h.capabilities?.includes("delegation-results-v1"))throw new PeerError("IDENTITY_MISMATCH","交付握手身份不匹配");
  const r=await request(base,"/peer/v1/delegation/"+(mode==="send"?"result":"result-status"),credential,mode==="send"?body:{result_id:resultId,project_id:d.project_id},fetchImpl,signal);
  stage="persist";
  const result=atomic(db,()=>{
   if(mode==="send")return recordResultReceipt(db,{resultId,receipt:r});
   keys(r,["receipt","decision"],"result status");if(!Object.hasOwn(r,"receipt")||!Object.hasOwn(r,"decision"))throw new PeerError("BAD_INPUT","交付状态缺少字段");
   recordResultReceipt(db,{resultId,receipt:r.receipt});
   return r.decision===null?resultState(db,resultId):recordResultDecision(db,{resultId,decision:r.decision});
  });
  return {...result,delivery_state:"acknowledged"};
 }catch(e){const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";return {...resultState(db,resultId),delivery_state:["STORAGE_ERROR","TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
}
