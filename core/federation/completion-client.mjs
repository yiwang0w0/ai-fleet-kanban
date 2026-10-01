import {PeerError} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {completeRelation,relationStatus,localRegistrarPeer} from "./relations.mjs";
import {bindingState} from "./bindings.mjs";
import {checkRegistrarStatus,topologyState} from "./topology.mjs";
import {completionState,recordCompletionReady,startCompletionAttempt,rejectCompletionAttempt,recordCompletionRetirement} from "./completion.mjs";
function remote(db,{url,credentialFile,projectId,nodeId,epoch,scopes,fetchImpl,signal}){
 const n=localIdentity(db),base=endpoint(url),c=loadCredential(credentialFile,n,projectId,["peer:handshake",...scopes]);if(c.server_node_id!==nodeId||c.server_epoch!==epoch)throw new PeerError("IDENTITY_MISMATCH","完成协议凭据与固定端点不一致",403);let ready=false;
 return async(path,body,errors=[])=>{if(!ready){const h=await request(base,"/peer/v1/hello",c,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:["delegation-completion-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);if(h.protocol_version!==1||h.node?.node_id!==nodeId||h.node?.sync_epoch!==epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==c.credential_version||!h.capabilities?.includes("delegation-completion-v1"))throw new PeerError("IDENTITY_MISMATCH","完成协议握手未通过");ready=true;}return request(base,path,c,body,fetchImpl,signal,errors);};
}
function failure(e,stage){const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";return {delivery_state:["STORAGE_ERROR","TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
export async function deliverCompletion(db,{completionId,url,credentialFile,fetchImpl=fetch,signal,authorize=()=>{}}){
 const s=completionState(db,completionId),d=s.plan.relation;if(s.side!=="source")throw new PeerError("FORBIDDEN","只有来源发送验收意图",403);if(s.ready)return {...s,delivery_state:"acknowledged"};const send=remote(db,{url,credentialFile,projectId:d.project_id,nodeId:d.target_node_id,epoch:d.target_epoch,scopes:["delegation:complete"],fetchImpl,signal});let stage="network";
 try{const receipt=await send("/peer/v1/delegation/complete",s.plan);stage="persist";authorize();return {...recordCompletionReady(db,{completionId,ready:receipt,authorize}),delivery_state:"acknowledged"};}catch(e){const latest=completionState(db,completionId);return {...latest,...(latest.ready?{delivery_state:"acknowledged"}:failure(e,stage))};}
}
export async function submitCompletion(db,{completionId,mode="approve",url,credentialFile,fetchImpl=fetch,signal,authorize=()=>{}}){
 if(!["approve","poll"].includes(mode))throw new PeerError("BAD_INPUT","完成登记模式无效");const s=completionState(db,completionId);if(["retired","settled"].includes(s.phase))return {...s,delivery_state:"acknowledged"};if(!s.ready)throw new PeerError("COMPLETION_NOT_READY","先取得执行端就绪回执",409);
 const d=s.plan.relation,b=bindingState(db,d.relation_id),n=localIdentity(db);let call;if(b.registrar_node_id===n.node_id){if(b.registrar_epoch!==n.sync_epoch)throw new PeerError("GRAPH_RECOVERY_REQUIRED","登记节点已恢复换代",409);const p=localRegistrarPeer(db,d.project_id);call=async(action,args)=>{authorize();return action==="complete"?completeRelation(db,p,args):relationStatus(db,p,args);};}
 else{const send=remote(db,{url,credentialFile,projectId:d.project_id,nodeId:b.registrar_node_id,epoch:b.registrar_epoch,scopes:["relations:read","relations:complete"],fetchImpl,signal});call=(action,args)=>send("/peer/v1/relations/"+action,args,["GRAPH_VERSION_CONFLICT"]);}
 const statusArgs={project_id:d.project_id,graph_id:d.graph_id,graph_epoch:d.graph_epoch,relation_id:d.relation_id};let args=null,stage="network";
 try{
  if(mode==="poll"){const receipt=await call("status",statusArgs);stage="persist";authorize();if(receipt.kind==="relation_completed")return {...recordCompletionRetirement(db,{completionId,receipt,authorize}),delivery_state:"acknowledged"};if(receipt.kind!=="relation_confirmed"||receipt.descriptor_digest!==b.confirmation.descriptor_digest)throw new PeerError("RECEIPT_MISMATCH","登记状态不再匹配绑定");return {...completionState(db,completionId),delivery_state:"waiting_peer"};}
  const pending=s.attempts.find(a=>a.state==="pending");if(pending){stage="persist";authorize();args=startCompletionAttempt(db,{completionId,authorize});}else{const status=await call("status",{...statusArgs,relation_id:null});checkRegistrarStatus(topologyState(db,d.project_id),status);stage="persist";authorize();args=startCompletionAttempt(db,{completionId,expectedVersion:status.version,authorize});}
  stage="network";const receipt=await call("complete",args);stage="persist";authorize();return {...recordCompletionRetirement(db,{completionId,requestId:args.request_id,receipt,authorize}),delivery_state:receipt.completed?"acknowledged":"waiting_peer"};
 }catch(e){if(stage==="network"&&args&&e.code==="GRAPH_VERSION_CONFLICT")return {...rejectCompletionAttempt(db,{completionId,requestId:args.request_id,code:e.code,authorize}),delivery_state:"rejected",error_code:e.code};const latest=completionState(db,completionId);return {...latest,...(["retired","settled"].includes(latest.phase)?{delivery_state:"acknowledged"}:failure(e,stage))};}
}
