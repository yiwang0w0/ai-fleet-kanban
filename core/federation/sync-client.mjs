import {readFileSync,statSync} from "node:fs";
import {PeerError,uuid,names,SCOPES} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {migrateSync,cursor,applyBatch,recordSource,MAX_BATCH_BYTES} from "./sync-store.mjs";

export function endpoint(value){
 let url;try{url=new URL(value);}catch{throw new PeerError("BAD_ENDPOINT","同步地址无效");}
 if(url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new PeerError("BAD_ENDPOINT","同步地址必须是没有账号、查询参数或子路径的根地址");
 const loop=["127.0.0.1","[::1]"].includes(url.hostname);
 if(!(url.protocol==="http:"&&loop)&&!(url.protocol==="https:"&&url.hostname.endsWith(".ts.net")))
  throw new PeerError("BAD_ENDPOINT","只接受回环 HTTP 或显式指定的 Tailscale HTTPS 地址");
 return url.origin;
}
export function loadCredential(file,local,projectId){
 if(statSync(file).size>16384)throw new PeerError("BAD_CREDENTIAL","凭据文件超限");
 const c=JSON.parse(readFileSync(file,"utf8"));
 for(const k of ["server_node_id","server_epoch","peer_node_id","peer_epoch","key_id"])uuid(c[k],k);
 if(c.format!==1||!Number.isSafeInteger(c.credential_version)||c.credential_version<1||
   typeof c.token!=="string"||!new RegExp("^"+c.key_id+"\\.[A-Za-z0-9_-]{43}$").test(c.token))
  throw new PeerError("BAD_CREDENTIAL","凭据格式无效");
 names(c.scopes,"scopes",SCOPES,1);names(c.projects,"projects",null,1);
 if(c.peer_node_id!==local.node_id||c.peer_epoch!==local.sync_epoch||c.server_node_id===local.node_id)
  throw new PeerError("IDENTITY_MISMATCH","凭据未绑定本机身份与 epoch",403);
 if(!c.projects.includes(projectId)||["peer:handshake","sync:pull","sync:ack"].some(s=>!c.scopes.includes(s)))
  throw new PeerError("FORBIDDEN","凭据没有该项目的拉取与确认权限",403);
 return c;
}
async function request(base,path,c,body,fetchImpl,signal){
 const r=await fetchImpl(base+path,{method:"POST",redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),
  headers:{Authorization:"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify(body)});
 const reader=r.body?.getReader();if(!reader)throw new PeerError("BAD_RESPONSE","对端响应为空");
 let bytes=0;const chunks=[];
 try{
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;
   if(bytes>MAX_BATCH_BYTES)throw new PeerError("BAD_RESPONSE","对端响应超限");chunks.push(value);}
 }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 if(!r.ok)throw new PeerError("REMOTE_"+r.status,"对端拒绝同步请求",r.status);
 try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}
 catch{throw new PeerError("BAD_RESPONSE","对端响应不是有效 JSON");}
}
function initAttempts(db){
 db.exec("CREATE TABLE IF NOT EXISTS federation_sync_attempts(origin_node_id TEXT NOT NULL,project_id TEXT NOT NULL,last_attempt_at TEXT NOT NULL,last_success_at TEXT,error_code TEXT,failure_count INTEGER NOT NULL DEFAULT 0,retry_after INTEGER NOT NULL DEFAULT 0,has_more INTEGER CHECK(has_more IN(0,1)),PRIMARY KEY(origin_node_id,project_id))");
}
/** The URL is a local operator choice; it is never taken from a remote response or task text. */
export async function syncOnce(db,{url,credentialFile,projectId,fetchImpl=fetch,now=Date.now(),maxBatches=10,signal}){
 const started=performance.now();
 const base=endpoint(url),local=localIdentity(db);names([projectId],"project_id",null,1);
 const c=loadCredential(credentialFile,local,projectId);migrateSync(db);initAttempts(db);
 if(!Number.isInteger(maxBatches)||maxBatches<1||maxBatches>20)throw new PeerError("BAD_INPUT","maxBatches 无效");
 const previous=db.prepare("SELECT * FROM federation_sync_attempts WHERE origin_node_id=? AND project_id=?").get(c.server_node_id,projectId);
 if(previous?.retry_after>now && previous.retry_after-now<=30000)return {state:"backoff",retry_after:previous.retry_after,error_code:previous.error_code};
 let applied=0,batches=0,more=false;
 try{
  // Check stored epoch before sending a credential or requesting a reset.
  cursor(db,c.server_node_id,c.server_epoch,projectId);
  const hello=await request(base,"/peer/v1/hello",c,{node_id:local.node_id,sync_epoch:local.sync_epoch,
   protocol:{min:1,max:1},required_capabilities:["task-projection-sync-v1"],required_extensions:[],extensions:{}},fetchImpl,signal);
  if(hello.protocol_version!==1||hello.node?.node_id!==c.server_node_id||hello.node?.sync_epoch!==c.server_epoch||
    hello.authorized?.peer_node_id!==local.node_id||hello.authorized?.credential_version!==c.credential_version||
    (!Array.isArray(hello.capabilities)||!hello.capabilities.includes("task-projection-sync-v1")))
   throw new PeerError("SOURCE_MISMATCH","握手未匹配固定对端身份");
  recordSource(db,hello.node);
  do{
   const after=cursor(db,c.server_node_id,c.server_epoch,projectId);
   const batch=await request(base,"/peer/v1/pull",c,{project_id:projectId,after_seq:after,limit:25},fetchImpl,signal);
   if(batch.after_seq!==after)throw new PeerError("CURSOR_MISMATCH","对端未按请求游标返回");
   const result=applyBatch(db,{origin:c.server_node_id,epoch:c.server_epoch,projectId},batch);
   applied+=result.applied;batches++;more=result.has_more;
   if(result.checkpoint){
    const ack=await request(base,"/peer/v1/ack",c,{project_id:projectId,...result.checkpoint},fetchImpl,signal);
    if(!Number.isSafeInteger(ack.acked_seq)||ack.acked_seq<result.cursor)throw new PeerError("INVALID_ACK","对端未确认已持久化的游标");
   }
  }while(more&&batches<maxBatches);
  const at=new Date(now).toISOString();
  db.prepare("INSERT INTO federation_sync_attempts(origin_node_id,project_id,last_attempt_at,last_success_at,has_more) VALUES(?,?,?,?,?) ON CONFLICT(origin_node_id,project_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error_code=NULL,failure_count=0,retry_after=0,has_more=excluded.has_more")
   .run(c.server_node_id,projectId,at,at,Number(more));
  return {state:more?"pending":"synced",applied,batches,has_more:more,cursor:cursor(db,c.server_node_id,c.server_epoch,projectId)};
 }catch(e){
  const failures=(previous?.failure_count??0)+1,retryAfter=now+Math.floor(performance.now()-started)+Math.min(30000,1000*2**Math.min(failures-1,5));
  const code=typeof e.code==="string"&&/^[A-Z0-9_]{1,64}$/.test(e.code)?e.code:"NETWORK_ERROR";
  db.prepare("INSERT INTO federation_sync_attempts(origin_node_id,project_id,last_attempt_at,error_code,failure_count,retry_after) VALUES(?,?,?,?,?,?) ON CONFLICT(origin_node_id,project_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error_code=excluded.error_code,failure_count=excluded.failure_count,retry_after=excluded.retry_after")
   .run(c.server_node_id,projectId,new Date(now).toISOString(),code,failures,retryAfter);
  return {state:"error",error_code:code,retry_after:retryAfter,applied,batches};
 }
}
