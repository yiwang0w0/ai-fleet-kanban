import {createHash} from "node:crypto";
const CODES=Object.freeze({
 model_not_found:"model_unavailable",unsupported_model:"model_unavailable",invalid_model:"model_unavailable",
 invalid_api_key:"authentication",authentication_error:"authentication",
 rate_limit_exceeded:"rate_limit",insufficient_quota:"quota",
 context_length_exceeded:"context_limit",invalid_request_error:"request_rejected",
 server_error:"provider_internal",timeout:"network"
});
/** Advisory metadata only. Never copy provider prose, credentials or arbitrary codes into receipts. */
export function providerErrorMetadata(value){
 const record=value!==null&&typeof value==="object"&&!Array.isArray(value)?value:{};
 const message=typeof record.message==="string"?record.message:null;
 const code=typeof record.code==="string"&&Object.hasOwn(CODES,record.code)?record.code:null;
 let category=code?CODES[code]:"unclassified",basis=code?"known_code":"unclassified";
 // Exact anchored provider wording is only a hint; it cannot grant a retry or change policy.
 if(!code&&message!==null&&Buffer.byteLength(message)<=4096){
  if(/^The ['"][a-zA-Z0-9._:-]+['"] model is not supported when using Codex with a ChatGPT account\.?$/.test(message)){category="model_unavailable";basis="known_message";}
  else if(/^Your authentication token has expired\. Please try signing in again\.$/.test(message)){category="authentication";basis="known_message";}
 }
 const status=Number.isInteger(record.status)&&record.status>=400&&record.status<=599?record.status:null;
 return {category,basis,code,http_status:status,message_bytes:message===null?null:Buffer.byteLength(message),message_sha256:message===null?null:createHash("sha256").update(message).digest("hex")};
}

export function isProviderErrorMetadata(value){
 if(value===null||typeof value!=="object"||Array.isArray(value))return false;
 const keys=["category","basis","code","http_status","message_bytes","message_sha256"];
 if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))return false;
 const {category,basis,code,http_status:status,message_bytes:bytes,message_sha256:sha}=value;
 if(status!==null&&(!Number.isInteger(status)||status<400||status>599))return false;
 if(bytes===null?sha!==null:(!Number.isSafeInteger(bytes)||bytes<0||bytes>1048576||typeof sha!=="string"||!/^[a-f0-9]{64}$/.test(sha)))return false;
 if(basis==="known_code")return typeof code==="string"&&Object.hasOwn(CODES,code)&&category===CODES[code];
 if(code!==null)return false;
 if(basis==="known_message")return ["model_unavailable","authentication"].includes(category)&&bytes>0&&bytes<=4096;
 return basis==="unclassified"&&category==="unclassified";
}


/** Retain only metadata from a bounded stderr prefix; never return provider prose. */
export function createStderrClassifier({limit=65536}={}){
 const lineLimit=4096;
 if(!Number.isInteger(limit)||limit<1||limit>65536)throw new Error("BAD_STDERR_SCAN_LIMIT");
 let total=0,scanned=0,pending=[],pendingBytes=0,dropping=false,discarded=0,selected=null,cached=null;
 function line(){
  const bytes=Buffer.concat(pending,pendingBytes);pending=[];pendingBytes=0;
  if(!bytes.length||selected)return;
  let text;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes).trim();}catch{discarded++;return;}
  if(!text)return;
  let value;
  try{
   const parsed=JSON.parse(text);
   const r=parsed?.error&&typeof parsed.error==="object"?parsed.error:parsed;
   value=r&&typeof r==="object"&&!Array.isArray(r)?{code:r.code??r.type,message:r.message,status:r.status??parsed.status}:{};
  }catch{value={message:text};}
  const metadata=providerErrorMetadata(value);
  if(metadata.category!=="unclassified")selected=metadata;
 }
 return {
  push(chunk){
   if(cached)throw new Error("STDERR_SCAN_CLOSED");
   const b=Buffer.from(chunk),keep=Math.min(b.length,Math.max(0,limit-scanned));
   total+=b.length;scanned+=keep;
   let offset=0;
   while(offset<keep){
    const end=b.indexOf(10,offset),last=end<0||end>=keep?keep:end;
    const piece=b.subarray(offset,last);
    if(!dropping){
     if(pendingBytes+piece.length>lineLimit){pending=[];pendingBytes=0;dropping=true;discarded++;}
     else{pending.push(piece);pendingBytes+=piece.length;}
    }
    if(last===keep)break;
    if(!dropping)line();else{pending=[];pendingBytes=0;}
    dropping=false;offset=last+1;
   }
  },
  finish(){
   if(cached)return structuredClone(cached);
   if(total<=limit&&!dropping)line();
   pending=[];pendingBytes=0;
   cached={format:"ai-fleet-stderr/v1",coverage:"bounded_prefix",scanned_bytes:scanned,
    scan_limit_bytes:limit,line_limit_bytes:lineLimit,discarded_lines:discarded,
    truncated:total>limit||discarded>0,provider_error:selected??providerErrorMetadata({})};
   return structuredClone(cached);
  }
 };
}
export function isStderrDiagnostic(value){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const keys=["format","coverage","scanned_bytes","scan_limit_bytes","line_limit_bytes","discarded_lines","truncated","provider_error"];
 if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))return false;
 return value.format==="ai-fleet-stderr/v1"&&value.coverage==="bounded_prefix"&&
  Number.isInteger(value.scan_limit_bytes)&&value.scan_limit_bytes>=1&&value.scan_limit_bytes<=65536&&value.line_limit_bytes===4096&&
  Number.isInteger(value.scanned_bytes)&&value.scanned_bytes>=0&&value.scanned_bytes<=value.scan_limit_bytes&&
  Number.isInteger(value.discarded_lines)&&value.discarded_lines>=0&&value.discarded_lines<=value.scanned_bytes&&
  typeof value.truncated==="boolean"&&(!value.discarded_lines||value.truncated)&&isProviderErrorMetadata(value.provider_error)&&
  (value.provider_error.message_bytes===null||value.provider_error.message_bytes<=4096);
}
