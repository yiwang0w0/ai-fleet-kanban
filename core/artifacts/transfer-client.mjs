import {PeerError} from "../federation/protocol.mjs";
import {localIdentity} from "../federation/peers.mjs";
import {resultState} from "../federation/results.mjs";
import {endpoint,loadCredential,request} from "../federation/sync-client.mjs";
import {artifactState,artifactChunk,recordArtifactProgress,CHUNK_BYTES} from "./transfers.mjs";
/** Repeat the same transfer after interruption. Only immutable bytes are sent, never a new model run. */
export async function deliverArtifact(db,{transferId,url,credentialFile,maxChunks=64,fetchImpl=fetch,signal,authorize=()=>{}}){
 if(!Number.isSafeInteger(maxChunks)||maxChunks<1||maxChunks>768)throw new PeerError("BAD_INPUT","单轮分块上限须为 1..768");
 const state=artifactState(db,transferId);if(state.side!=="target")throw new PeerError("FORBIDDEN","仅执行端发送文件",403);
 const h=state.header,r=resultState(db,state.result_id),d=r.body.relation,n=localIdentity(db),base=endpoint(url),c=loadCredential(credentialFile,n,d.project_id,["peer:handshake","delegation:result","artifact:write"]);
 if(c.server_node_id!==d.source_node_id||c.server_epoch!==d.source_epoch)throw new PeerError("IDENTITY_MISMATCH","文件凭据未绑定固定来源端",403);
 let stage="network",sent=0;
 const call=async(path,body)=>{stage="network";return request(base,"/peer/v1/artifact/"+path,c,body,fetchImpl,signal,["RESULT_NOT_PENDING","ARTIFACT_TARGET_REQUIRED","ARTIFACT_STORAGE_LIMIT","BASE_MISMATCH","CHUNK_ORDER","PATH_NOT_ALLOWED"]);};
 const record=response=>{stage="persist";return recordArtifactProgress(db,{transferId,response,authorize});};
 try{
  if(r.review_state!=="pending_evidence")throw new PeerError("RESULT_NOT_PENDING","候选不再等待证据");
  const hello=await request(base,"/peer/v1/hello",c,{node_id:n.node_id,sync_epoch:n.sync_epoch,protocol:{min:1,max:1},required_capabilities:["artifact-transfer-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
  if(hello.protocol_version!==1||hello.node?.node_id!==d.source_node_id||hello.node?.sync_epoch!==d.source_epoch||hello.authorized?.peer_node_id!==n.node_id||hello.authorized?.credential_version!==c.credential_version||!hello.capabilities?.includes("artifact-transfer-v1"))throw new PeerError("IDENTITY_MISMATCH","文件传输握手身份不匹配");
  let progress=record(await call("offer",h)),next=progress.remote_next_chunk,total=Math.ceil(h.payload_bytes/CHUNK_BYTES);
  while(next<total&&sent<maxChunks){const chunk=artifactChunk(db,{transferId,index:next});progress=record(await call("chunk",chunk));if(progress.remote_next_chunk<=next)throw new PeerError("RECEIPT_MISMATCH","远端没有保存所发送的分块");next=progress.remote_next_chunk;sent++;}
  if(next===total)progress=record(await call("seal",{transfer_id:transferId,header_digest:state.header_digest}));
  return {...progress,sent_chunks:sent,delivery_state:next===total?"acknowledged":"more"};
 }catch(e){const code=e instanceof PeerError?e.code:stage==="persist"?"STORAGE_ERROR":"TRANSPORT_ERROR";return {...artifactState(db,transferId),sent_chunks:sent,delivery_state:["STORAGE_ERROR","TRANSPORT_ERROR","REMOTE_408","REMOTE_429"].includes(code)||/^REMOTE_5[0-9]{2}$/.test(code)?"retry_pending":"blocked",error_code:code};}
}
