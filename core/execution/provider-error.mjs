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
