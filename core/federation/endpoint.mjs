import {PeerError} from "./protocol.mjs";
export function endpoint(value){
 let url;try{url=new URL(value);}catch{throw new PeerError("BAD_ENDPOINT","同步地址无效");}
 if(url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new PeerError("BAD_ENDPOINT","同步地址必须是没有账号、查询参数或子路径的根地址");
 const loop=["127.0.0.1","[::1]"].includes(url.hostname);
 if(!(url.protocol==="http:"&&loop)&&!(url.protocol==="https:"&&url.hostname.endsWith(".ts.net")))
  throw new PeerError("BAD_ENDPOINT","只接受回环 HTTP 或显式指定的 Tailscale HTTPS 地址");
 return url.origin;
}
export function assertCredentialEndpoint(c,value){
 if(c?.format===1||!c?.server_endpoint)throw new PeerError("CREDENTIAL_REISSUE_REQUIRED","旧对端凭据未绑定地址，请由签发端重新签发",403);
 if(c.format!==2)throw new PeerError("BAD_CREDENTIAL","不支持的凭据格式",403);
 let bound;try{bound=endpoint(c.server_endpoint);}catch{throw new PeerError("BAD_CREDENTIAL","凭据绑定地址无效",403);}
 if(bound!==c.server_endpoint)throw new PeerError("BAD_CREDENTIAL","凭据绑定地址必须规范化",403);
 const actual=endpoint(value);if(actual!==bound)throw new PeerError("ENDPOINT_MISMATCH","请求地址与凭据签发时绑定的地址不同，未发送凭据",403);return actual;
}
