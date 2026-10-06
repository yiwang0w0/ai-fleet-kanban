import {boardURL} from "./context.mjs";
import http from "node:http";
import {localIdentity} from "../federation/peers.mjs";
import {PeerError,keys} from "../federation/protocol.mjs";
import {authenticateCredential,fail} from "./policy.mjs";
import {listTools,callTool} from "./tools.mjs";
function send(res,status,data){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(data));}
async function readBody(req){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"]??"")||req.headers["content-encoding"])fail("BAD_INPUT","仅接受 UTF-8 JSON 请求",415);
 const max=128*1024;if(Number(req.headers["content-length"])>max)fail("TOO_LARGE","请求超过128KiB",413);
 const chunks=await new Promise((resolve,reject)=>{
  let size=0,finished=false;const items=[],timer=setTimeout(()=>end(new PeerError("BODY_TIMEOUT","请求正文超时",408)),5000);
  const data=b=>{size+=b.length;if(size>max)return end(new PeerError("TOO_LARGE","请求超过128KiB",413));items.push(b);};
  const finish=()=>end(),broken=()=>end(new PeerError("BAD_INPUT","请求正文中断",400));
  function end(error){if(finished)return;finished=true;clearTimeout(timer);req.removeListener("data",data);req.removeListener("end",finish);req.removeListener("aborted",broken);req.removeListener("error",broken);if(error){req.pause();reject(error);}else resolve(items);}
  req.on("data",data);req.once("end",finish);req.once("aborted",broken);req.once("error",broken);
 });
 try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail("BAD_INPUT","无效 UTF-8 JSON",400);}
}
/** Internal loopback API used by the stdio bridge; it is not an MCP HTTP transport. */
export async function listenBroker(db,{host="127.0.0.1",port,boardUrl=null}){
 if(!["127.0.0.1","::1"].includes(host)||!Number.isInteger(port)||port<0||port>65535)fail("UNSAFE_BIND","MCP代理仅接受显式回环端口",400);
 boardUrl=boardURL(boardUrl);
 localIdentity(db);
 const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
  try{
   const authCount=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==="authorization").length;
   if(authCount!==1)fail("UNAUTHENTICATED","需要唯一的身份凭据",401);
   authenticateCredential(db,req.headers.authorization);
   if(req.headers.origin)fail("FORBIDDEN","本机工具代理不接受浏览器来源",403);
   if(req.method!=="POST"||!["/local/v1/tools/list","/local/v1/tools/call"].includes(req.url))fail("NOT_FOUND","接口不存在",404);
   const body=await readBody(req);
   // These functions reauthenticate after body upload and under their transaction.
   let result;
   if(req.url.endsWith("/list")){keys(body,[],"list");result=listTools(db,req.headers.authorization);}
   else{
    keys(body,["name","arguments"],"call");
    if(typeof body.name!=="string"||body.name.length>80)fail("BAD_INPUT","工具名称无效",400);
    result=callTool(db,req.headers.authorization,body.name,body.arguments,{boardUrl});
   }
   const node=localIdentity(db);send(res,200,{node_id:node.node_id,node_epoch:node.sync_epoch,result});
  }catch(e){const known=e instanceof PeerError||["BAD_INPUT","CONFLICT","NOT_FOUND","INTERNAL"].includes(e.code);
   const status=e.status??({BAD_INPUT:400,CONFLICT:409,NOT_FOUND:404}[e.code]??500);
   send(res,status,{code:known?e.code:"INTERNAL",error:known?e.message:"本机工具代理内部错误"});
  }
 });
 server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;server.setTimeout(10000,s=>s.destroy());
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,resolve);});
 return server;
}
