// Credential parsing for the standalone stdio bridge; no database or administration imports.
import {readFileSync,statSync} from "node:fs";
import {PeerError,keys,uuid,version} from "../federation/protocol.mjs";
export const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
export function loadPrincipalCredential(file){
 if(statSync(file).size>16384)fail("BAD_CREDENTIAL","MCP凭据文件超限",400);
 let c;try{c=JSON.parse(readFileSync(file,"utf8"));}catch{fail("BAD_CREDENTIAL","MCP凭据不是有效 JSON",400);}exact(c,["format","node_id","node_epoch","principal_id","credential_version","token"],"credential");
 for(const k of ["node_id","node_epoch","principal_id"])uuid(c[k],k);version(c.credential_version);
 if(c.format!=="ai-fleet-mcp-credential/v1"||typeof c.token!=="string"||!new RegExp("^"+c.principal_id+"\\.[A-Za-z0-9_-]{43}$").test(c.token))fail("BAD_CREDENTIAL","MCP凭据格式无效",400);
 return c;
}
