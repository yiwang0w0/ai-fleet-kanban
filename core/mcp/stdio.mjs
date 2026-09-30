// MCP stdio transport contains no database path, administrator token, or process-launch tool.
import {once} from "node:events";
import {Agent,request} from "node:http";
import {Readable} from "node:stream";
import {loadPrincipalCredential,fail} from "./policy.mjs";
const MAX_BYTES=128*1024,SUPPORTED=["2025-11-25","2025-06-18"];
function endpoint(value){
 let u;try{u=new URL(value);}catch{fail("BAD_ENDPOINT","MCP代理地址无效",400);}
 if(u.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=="/")fail("BAD_ENDPOINT","MCP代理地址必须是显式回环 HTTP 根地址",400);
 return u.origin;
}
// Own non-proxy agent: never use ambient fetch dispatchers or the global HTTP agent.
// A new connection per call also avoids retaining a credential-bearing socket.
function directLoopbackRequest(url,{method,headers,body,signal}){
 return new Promise((resolve,reject)=>{
  const agent=new Agent({keepAlive:false,proxyEnv:{}});
  const req=request(url,{method,headers,signal,agent,maxHeaderSize:16384},res=>{
   res.once("close",()=>agent.destroy());
   if(res.statusCode>=300&&res.statusCode<400){res.destroy();reject(Error("redirect refused"));return;}
   resolve({ok:res.statusCode>=200&&res.statusCode<300,body:Readable.toWeb(res)});
  });
  req.once("error",error=>{agent.destroy();reject(error);});req.end(body);
 });
}
export function createBridge({url,credentialFile,fetchImpl=directLoopbackRequest}){
 const base=endpoint(url),credential=loadPrincipalCredential(credentialFile);
 let state="new";const usedIds=new Set();
 async function broker(path,body){
  const r=await fetchImpl(base+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{Authorization:"Bearer "+credential.token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const reader=r.body?.getReader();if(!reader)throw Error("empty response");
  let length=0;const parts=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1024*1024)throw Error("response too large");parts.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  let data;try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)));}catch{throw Error("invalid response");}
  if(!r.ok){const e=Error(typeof data.error==="string"?data.error:"工具请求失败");e.code=typeof data.code==="string"&&/^[A-Z_]{1,64}$/.test(data.code)?data.code:"INTERNAL";throw e;}
  if(data.node_id!==credential.node_id||data.node_epoch!==credential.node_epoch)fail("SOURCE_MISMATCH","代理身份与凭据不匹配",403);
  return data.result;
 }
 const error=(id,code,message)=>({jsonrpc:"2.0",id,error:{code,message}});
 return async message=>{
  const id=message?.id,hasId=message&&Object.hasOwn(message,"id");
  if(!message||Array.isArray(message)||message.jsonrpc!=="2.0"||typeof message.method!=="string"||(hasId&&!(typeof id==="string"&&id.length<=128||Number.isSafeInteger(id))))return error(null,-32600,"Invalid Request");
  if(!hasId){
   if(message.method==="notifications/initialized"&&state==="initializing")state="ready";
   // Notifications never execute tools. Cancellation does not undo a committed board mutation.
   return null;
  }
  const key=typeof id+":"+id;
  if(usedIds.has(key))return error(id,-32600,"Request id already used");
  if(usedIds.size>=10000)return error(id,-32000,"Session request limit reached; reconnect");
  usedIds.add(key);
  try{
   if(message.method==="ping")return {jsonrpc:"2.0",id,result:{}};
   if(message.method==="initialize"){
    const p=message.params;
    if(state!=="new"||!p||typeof p.protocolVersion!=="string"||!p.capabilities||typeof p.capabilities!=="object"||Array.isArray(p.capabilities)||typeof p.clientInfo?.name!=="string"||typeof p.clientInfo?.version!=="string")return error(id,-32602,"Invalid initialization");
    await broker("/local/v1/tools/list",{});state="initializing";
    return {jsonrpc:"2.0",id,result:{protocolVersion:SUPPORTED.includes(p.protocolVersion)?p.protocolVersion:SUPPORTED[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:"ai-fleet-board",version:"1.0.0"},instructions:"工具权限由本机授权身份决定。交付不等于验收；分派请求不代表执行器已启动。"}};
   }
   if(state!=="ready")return error(id,-32002,"Initialize and send notifications/initialized first");
   if(message.method==="tools/list"){
    const p=message.params??{};if(!p||Array.isArray(p)||typeof p!=="object"||Object.keys(p).some(k=>k!=="_meta")||(p._meta!==undefined&&(!p._meta||typeof p._meta!=="object"||Array.isArray(p._meta))))return error(id,-32602,"Invalid tools/list parameters");
    return {jsonrpc:"2.0",id,result:await broker("/local/v1/tools/list",{})};
   }
   if(message.method==="tools/call"){
    const p=message.params;if(!p||Array.isArray(p)||typeof p.name!=="string"||Object.keys(p).some(x=>!["name","arguments","_meta"].includes(x)))return error(id,-32602,"Invalid tools/call parameters");
    try{
     const result=await broker("/local/v1/tools/call",{name:p.name,arguments:p.arguments??{}});
     return {jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result,isError:false}};
    }catch(e){
     if(e.code==="UNKNOWN_TOOL")return error(id,-32602,"Unknown tool");
     const result={code:e.code??"CONNECTION_ERROR",message:e.code?e.message:"本机工具代理连接失败"};
     return {jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result,isError:true}};
    }
   }
   return error(id,-32601,"Method not found");
  }catch(e){return error(id,-32000,e.code?e.code+": "+e.message:"Local broker connection failed");}
 };
}
export async function serveStdio(options,{input=process.stdin,output=process.stdout}={}){
 const handle=createBridge(options);let pending=Buffer.alloc(0);
 const write=async value=>{if(value&&!output.write(JSON.stringify(value)+"\n"))await once(output,"drain");};
 for await(const chunk of input){
  pending=Buffer.concat([pending,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
  for(;;){
   const end=pending.indexOf(10);if(end<0)break;
   const line=pending.subarray(0,end);pending=pending.subarray(end+1);
   if(line.length>MAX_BYTES)throw Error("MCP message exceeds128KiB");
   let message;try{message=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(line));}
   catch{await write({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}});continue;}
   await write(await handle(message));
  }
  if(pending.length>MAX_BYTES)throw Error("MCP message exceeds128KiB");
 }
 if(pending.length)await write({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Truncated message"}});
}
