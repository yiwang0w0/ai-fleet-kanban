import {createHash} from "node:crypto";
import {OutputError} from "./output.mjs";
/** Ordinary command bytes are evidence, not provider events or instructions. */
export function createCommandOutput({stdoutLimit=65536,stderrLimit=65536}={}){
 for(const n of [stdoutLimit,stderrLimit])if(!Number.isSafeInteger(n)||n<1||n>1024*1024)throw new OutputError("BAD_LIMITS");
 let failure=null,closed=false,cached=null;
 const stream=limit=>({limit,bytes:0,retained:0,chunks:[],hash:createHash("sha256")}),stdout=stream(stdoutLimit),stderr=stream(stderrLimit);
 function push(s,b){
  if(closed)throw new OutputError("OUTPUT_CLOSED");if(!(b instanceof Uint8Array))throw new OutputError("BAD_OUTPUT_BYTES");
  s.bytes+=b.byteLength;s.hash.update(b);const keep=Math.min(b.byteLength,s.limit-s.retained);
  if(keep){s.chunks.push(Buffer.from(b.subarray(0,keep)));s.retained+=keep;}if(s.bytes>s.limit)failure??="OUTPUT_LIMIT";return failure===null;
 }
 function snapshot(s){
  const bytes=Buffer.concat(s.chunks),sha256=s.hash.digest("hex");let text,utf8Valid=true;
  try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{utf8Valid=false;text=new TextDecoder("utf-8").decode(bytes);failure??="OUTPUT_ENCODING";}
  s.chunks=[];return {bytes:s.bytes,retained_bytes:s.retained,sha256,text,utf8_valid:utf8Valid,truncated:s.bytes>s.retained};
 }
 return {push:b=>push(stdout,b),pushError:b=>push(stderr,b),get failure(){return failure;},finish({exitCode=null,signal=null,stopReason=null,spawnError=false}={}){
  if(cached)return cached;closed=true;const out=snapshot(stdout),err=snapshot(stderr);
  const cause=stopReason??failure??(spawnError?"SPAWN_ERROR":signal?"SIGNALLED":exitCode===0?null:"NONZERO_EXIT");
  const status=cause===null?"success":cause.toLowerCase()==="cancelled"?"cancelled":cause.toLowerCase()==="timeout"?"timeout":"failed";
  cached={format:"ai-fleet-command-observation/v1",status,diagnostic:cause===null?"SUCCESS":cause.toUpperCase(),stdout:out,stderr:err};return cached;
 }};
}
