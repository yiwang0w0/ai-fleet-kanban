import {createAuthFailureGuard} from "./auth-failures.mjs";
import {migrateCompletion,receiveCompletion} from "./completion.mjs";
import {migrateArtifacts,receiveArtifactOffer,receiveArtifactChunk,sealArtifact,peerArtifactStatus,MAX_ARTIFACT_HEADER} from "../artifacts/transfers.mjs";
import {migrateResults,receiveResult,peerResultStatus,MAX_RESULT_BYTES} from "./results.mjs";
import {receiveCancellation,peerCancellationState} from "./cancellation.mjs";
import {migrateBindings,receiveBindingMessage} from "./bindings.mjs";
import http from "node:http";
import {migrateRelations,publishTopology,approveRelation,withdrawRelation,completeRelation,cancelRelation,relationStatus,MAX_TOPOLOGY_BYTES} from "./relations.mjs";
import {migrateDelegation,receiveOffer,peerDelegationStatus} from "./delegation.mjs";
import {sourceRecoveryMarker,sourceRecoveryLineage} from "./epoch-state.mjs";
import {startSnapshot,snapshotPage} from "./snapshots.mjs";
import {migrateSync,exportBatch,acknowledge} from "./sync-store.mjs";
import { PeerError, negotiateHello, keys } from "./protocol.mjs";
import { authenticate, localIdentity, transaction } from "./peers.mjs";

function send(res, status, body, close = false) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff", ...(close ? {Connection:"close"} : {})});
  res.end(JSON.stringify(body));
}
async function bodyJSON(req,limit=8192) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || ""))
    throw new PeerError("BAD_INPUT","需要 application/json",415);
  if (req.headers["content-encoding"]) throw new PeerError("BAD_INPUT","不接受压缩请求",415);
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new PeerError("TOO_LARGE","请求超过 "+(limit/1024)+" KiB",413);
  const chunks = await new Promise((resolve,reject)=>{
    const parts=[];let bytes=0,settled=false;
    const timer=setTimeout(()=>finish(new PeerError("BODY_TIMEOUT","请求正文超时",408)),5000);
    function finish(error){
      if(settled)return;settled=true;clearTimeout(timer);
      req.removeListener("data",onData);req.removeListener("end",onEnd);
      req.removeListener("error",onError);req.removeListener("aborted",onAbort);
      if(error){req.pause();reject(error);}else resolve(parts);
    }
    function onData(chunk){bytes+=chunk.length;
      if(bytes>limit)return finish(new PeerError("TOO_LARGE","请求超过 "+(limit/1024)+" KiB",413));
      parts.push(chunk);
    }
    function onEnd(){finish();}
    function onError(){finish(new PeerError("BAD_INPUT","请求正文读取失败",400));}
    function onAbort(){finish(new PeerError("BAD_INPUT","请求已中止",400));}
    req.on("data",onData);req.once("end",onEnd);req.once("error",onError);req.once("aborted",onAbort);
  });
  try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))); }
  catch { throw new PeerError("BAD_INPUT","请求不是有效 UTF-8 JSON",400); }
}
/** Separate authenticated node surface: explicit projections and delegation proposals; no operator UI, secrets or model execution. */
function createPeerServer(db) {
  localIdentity(db);migrateSync(db);migrateDelegation(db);migrateRelations(db);migrateResults(db);migrateArtifacts(db);migrateCompletion(db);
  const failures=createAuthFailureGuard(db);
  const server = http.createServer({maxHeaderSize:8192}, async (req,res) => {
    try {
      const authCount = req.rawHeaders.filter((_,i)=>i%2===0 && req.rawHeaders[i].toLowerCase()==="authorization").length;
      if (authCount !== 1) throw new PeerError("UNAUTHENTICATED","需要唯一的对端凭据",401);
      authenticate(db,req.headers.authorization); // Refuse before accepting a body.
      if (req.headers.origin) throw new PeerError("FORBIDDEN","节点接口不接受浏览器来源",403);
      if (req.url === "/peer/v1/hello" && req.method === "POST") {
        const body = await bodyJSON(req);
        const hello = transaction(db,()=>{
          // Upload may span credential rotation/revocation. Recheck inside the write lock.
          const peer = authenticate(db,req.headers.authorization,"peer:handshake");
          const result=negotiateHello(body,peer,localIdentity(db));
          const marker=sourceRecoveryMarker(db);if(marker)result.extensions.source_recovery=marker;
          return result;
        });
        return send(res,200,hello);
      }
      if(req.url==="/peer/v1/recovery/lineage"&&req.method==="POST"){
        const body=await bodyJSON(req);
        const lineage=transaction(db,()=>{authenticate(db,req.headers.authorization,"sync:pull");return sourceRecoveryLineage(db,body);});
        return send(res,200,lineage);
      }
      if (["/peer/v1/pull","/peer/v1/ack"].includes(req.url) && req.method === "POST") {
        const body=await bodyJSON(req),pull=req.url.endsWith("/pull");
        keys(body,pull?["project_id","after_seq","limit"]:["project_id","seq","event_digest"],pull?"pull":"ack");
        const result=transaction(db,()=>{
          const peer=authenticate(db,req.headers.authorization,pull?"sync:pull":"sync:ack");
          return pull?exportBatch(db,peer,body):acknowledge(db,peer,body);
        });
        return send(res,200,result);
      }
      if (["/peer/v1/snapshot/start","/peer/v1/snapshot/page"].includes(req.url) && req.method==="POST"){
        const body=await bodyJSON(req),start=req.url.endsWith("/start");
        keys(body,start?["project_id","min_seq"]:["project_id","snapshot_id","offset"],"snapshot request");
        const result=transaction(db,()=>{
          const peer=authenticate(db,req.headers.authorization,"sync:pull");
          return start?startSnapshot(db,peer,body):snapshotPage(db,peer,body);
        });
        return send(res,200,result);
      }
      if (["/peer/v1/delegation/offer","/peer/v1/delegation/status"].includes(req.url) && req.method==="POST") {
        const offering=req.url.endsWith("/offer"),body=await bodyJSON(req,offering?128*1024:8192);
        keys(body,offering?["offer"]:["delegation_id","project_id"],"delegation request");
        const result=transaction(db,()=>{
          const peer=authenticate(db,req.headers.authorization,offering?"delegation:offer":"delegation:status");
          return offering?receiveOffer(db,peer,body.offer):peerDelegationStatus(db,peer,body);
        });
        return send(res,200,result);
      }
      if(req.url==="/peer/v1/delegation/complete"&&req.method==="POST"){
        const body=await bodyJSON(req,32768);const result=transaction(db,()=>receiveCompletion(db,authenticate(db,req.headers.authorization,"delegation:complete"),body));return send(res,200,result);
      }
      if(["/peer/v1/delegation/result","/peer/v1/delegation/result-status"].includes(req.url)&&req.method==="POST"){
        const receiving=req.url.endsWith("/result"),body=await bodyJSON(req,receiving?MAX_RESULT_BYTES:8192);
        if(!receiving)keys(body,["result_id","project_id"],"result status");
        const result=transaction(db,()=>{const peer=authenticate(db,req.headers.authorization,"delegation:result");return receiving?receiveResult(db,peer,body):peerResultStatus(db,peer,body);});
        return send(res,200,result);
      }
      if(["/peer/v1/artifact/offer","/peer/v1/artifact/chunk","/peer/v1/artifact/seal","/peer/v1/artifact/status"].includes(req.url)&&req.method==="POST"){
        const action=req.url.slice(req.url.lastIndexOf("/")+1),body=await bodyJSON(req,action==="offer"?MAX_ARTIFACT_HEADER:action==="chunk"?96*1024:8192);
        const result=transaction(db,()=>{
          const peer=authenticate(db,req.headers.authorization,"artifact:write");
          return action==="offer"?receiveArtifactOffer(db,peer,body):action==="chunk"?receiveArtifactChunk(db,peer,body):action==="seal"?sealArtifact(db,peer,body):peerArtifactStatus(db,peer,body);
        });return send(res,200,result);
      }
      if(["/peer/v1/delegation/cancel","/peer/v1/delegation/cancel-status"].includes(req.url)&&req.method==="POST"){
        const body=await bodyJSON(req,16384),receiving=req.url.endsWith("/cancel");
        if(!receiving)keys(body,["relation_id","project_id","cancel_id"],"cancellation status");
        const result=transaction(db,()=>{const peer=authenticate(db,req.headers.authorization,"delegation:control");
          if(receiving)return receiveCancellation(db,peer,body);
          return peerCancellationState(db,peer,body);
        });return send(res,200,result);
      }
      if(req.url==="/peer/v1/delegation/binding"&&req.method==="POST"){
        const body=await bodyJSON(req,16384);
        const result=transaction(db,()=>receiveBindingMessage(db,authenticate(db,req.headers.authorization,"delegation:binding"),body));
        return send(res,200,result);
      }
      if (["/peer/v1/relations/publish","/peer/v1/relations/approve","/peer/v1/relations/status","/peer/v1/relations/withdraw","/peer/v1/relations/complete","/peer/v1/relations/cancel"].includes(req.url) && req.method==="POST") {
        const action=req.url.slice(req.url.lastIndexOf("/")+1),body=await bodyJSON(req,action==="publish"?MAX_TOPOLOGY_BYTES+4096:["complete","cancel"].includes(action)?32768:8192);
        const result=transaction(db,()=>{
          const peer=authenticate(db,req.headers.authorization,action==="status"?"relations:read":action==="withdraw"?"relations:approve":action==="cancel"?"relations:complete":"relations:"+action);
          return action==="publish"?publishTopology(db,peer,body):action==="approve"?approveRelation(db,peer,body):action==="withdraw"?withdrawRelation(db,peer,body):action==="complete"?completeRelation(db,peer,body):action==="cancel"?cancelRelation(db,peer,body):relationStatus(db,peer,body);
        });
        return send(res,200,result);
      }
      if (req.url === "/peer/v1/health" && req.method === "GET") {
        const health = transaction(db,()=>{
          authenticate(db,req.headers.authorization,"peer:health");
          return {ok:true,protocol_version:1,node_id:localIdentity(db).node_id};
        });
        return send(res,200,health);
      }
      throw new PeerError("NOT_FOUND","节点接口不存在",404);
    } catch (e) {
      if(e instanceof PeerError&&e.status===401){
        const denial=failures.failure(req.headers.authorization);
        if(denial.retry_after)res.setHeader("Retry-After",String(denial.retry_after));
        return send(res,denial.status,{code:denial.code,error:denial.status===401?"需要有效的独立对端凭据":denial.status===429?"无效凭据请求过多，请稍后重试":"鉴权失败审计暂不可用"},true);
      }
      const known = e instanceof PeerError;
      send(res,known ? e.status : 500,{error:known ? e.message : "节点接口内部错误",code:known ? e.code : "INTERNAL"},true);
    }
  });
  const closeAudit=()=>{try{failures.close();}catch{console.error("节点鉴权失败审计关闭时写入失败；部分计数未持久化");}};
  server.once("close",closeAudit);
  server.once("error",()=>{if(!server.listening)closeAudit();});
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(10000,socket=>socket.destroy());
  return server;
}
export async function listenPeerServer(db, {host="127.0.0.1",port}) {
  if (!["127.0.0.1","::1"].includes(host)) throw new PeerError("UNSAFE_BIND","节点网关仅监听回环地址；远端入口另行配置",400);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PeerError("BAD_INPUT","端口无效",400);
  const server = createPeerServer(db);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,resolve);});
  return server;
}
