import {PeerError} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
import {localRegistrarPeer,approveRelation,withdrawRelation,relationStatus} from "./relations.mjs";
import {checkRegistrarStatus,topologyState} from "./topology.mjs";
import {bindingState,startBindingAttempt,acceptBindingReceipt,rejectBindingAttempt,cancelUnsentBinding,bindingMessage,recordBindingMessage,BINDING_REJECTIONS} from "./bindings.mjs";
function remote(db,{url,credentialFile,projectId,nodeId,epoch,scopes,capability,fetchImpl,signal}){
 const n=localIdentity(db),base=endpoint(url),c=loadCredential(credentialFile,n,projectId,["peer:handshake",...scopes],base);
 if(c.server_node_id!==nodeId||c.server_epoch!==epoch)throw new PeerError("IDENTITY_MISMATCH","凭据与固定服务节点身份不一致",403);let ready=false;
 return async(path,body,errors=[])=>{
  if(!ready){const h=await request(base,"/peer/v1/hello",c,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:[capability],required_extensions:[],extensions:{}},fetchImpl,signal);
   if(h.protocol_version!==1||h.node?.node_id!==nodeId||h.node?.sync_epoch!==epoch||h.authorized?.peer_node_id!==n.node_id||h.authorized?.credential_version!==c.credential_version||!h.capabilities?.includes(capability))throw new PeerError("SOURCE_MISMATCH","节点握手身份未通过核对");ready=true;
  }return request(base,path,c,body,fetchImpl,signal,errors);
 };
}
function failure(e,stage){const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";return {delivery_state:["STORAGE_ERROR","TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
export async function submitBinding(db,{relationId,mode="approve",url,credentialFile,fetchImpl=fetch,signal}){
 if(!["approve","poll","withdraw","cancel"].includes(mode))throw new PeerError("BAD_INPUT","绑定提交模式无效");
 const b=bindingState(db,relationId),d=b.relation,n=localIdentity(db);
 if(b.state==="confirmed"&&["cancel","withdraw"].includes(mode))throw new PeerError("RELATION_CONFIRMED","关系已确认，不能按未确认申请撤回；执行取消需单独协议",409);
 if(b.state!=="prepared")return {...b,delivery_state:b.state};
 if(mode==="cancel"&&b.side==="source"&&b.attempts.every(a=>a.state==="rejected"))return {...cancelUnsentBinding(db,relationId),delivery_state:"cancelled"};
 if(mode==="cancel")mode="withdraw";
 const pending=b.attempts.find(a=>a.state==="pending");if(pending&&mode!==pending.action)throw new PeerError("UNKNOWN_REMOTE_OUTCOME","先用 "+pending.action+" 恢复未确定的原请求",409);
 let call;if(b.registrar_node_id===n.node_id){if(b.registrar_epoch!==n.sync_epoch)throw new PeerError("GRAPH_RECOVERY_REQUIRED","登记节点已换代",409);const p=localRegistrarPeer(db,d.project_id);call=async(action,args)=>action==="approve"?approveRelation(db,p,args):action==="withdraw"?withdrawRelation(db,p,args):relationStatus(db,p,args);}
 else{const send=remote(db,{url,credentialFile,projectId:d.project_id,nodeId:b.registrar_node_id,epoch:b.registrar_epoch,scopes:["relations:read","relations:approve"],capability:"project-relations-v1",fetchImpl,signal});call=(action,args)=>send("/peer/v1/relations/"+action,args,BINDING_REJECTIONS);}
 let args=null,stage="network";
 try{
  if(mode==="poll"){const r=await call("status",{project_id:d.project_id,graph_id:d.graph_id,graph_epoch:d.graph_epoch,relation_id:relationId});stage="persist";return {...acceptBindingReceipt(db,{relationId,receipt:r}),delivery_state:"acknowledged"};}
  if(pending){stage="persist";args=startBindingAttempt(db,{relationId,action:mode});}
  else if(mode==="withdraw"){stage="persist";args=startBindingAttempt(db,{relationId,action:mode});}
  else{const s=await call("status",{project_id:d.project_id,graph_id:d.graph_id,graph_epoch:d.graph_epoch,relation_id:null});checkRegistrarStatus(topologyState(db,d.project_id),s);stage="persist";args=startBindingAttempt(db,{relationId,action:mode,expectedVersion:s.version});}
  stage="network";const r=await call(mode,args);stage="persist";return {...acceptBindingReceipt(db,{relationId,requestId:args.request_id,receipt:r}),delivery_state:"acknowledged"};
 }catch(e){
  const latest=bindingState(db,relationId);if(latest.state!=="prepared")return {...latest,delivery_state:latest.state};
  if(stage==="network"&&args&&(mode==="approve"&&BINDING_REJECTIONS.includes(e.code)||mode==="withdraw"&&e.code==="RELATION_CONFIRMED"))return {...rejectBindingAttempt(db,{relationId,requestId:args.request_id,code:e.code}),delivery_state:"rejected",error_code:e.code};
  return {...latest,...failure(e,stage)};
 }
}
export async function sendBindingMessage(db,{relationId,kind,url,credentialFile,fetchImpl=fetch,signal}){
 const body=bindingMessage(db,{relationId,kind}),d=body.relation;
 const call=remote(db,{url,credentialFile,projectId:d.project_id,nodeId:d.target_node_id,epoch:d.target_epoch,scopes:["delegation:offer","delegation:binding"],capability:"delegation-bindings-v1",fetchImpl,signal});let stage="network";
 try{const r=await call("/peer/v1/delegation/binding",body,["PROPOSAL_DECLINED"]);stage="persist";return {...recordBindingMessage(db,{requestId:body.request_id,receipt:r}),delivery_state:"acknowledged"};}
 catch(e){return {...bindingState(db,relationId),...failure(e,stage)};}
}
