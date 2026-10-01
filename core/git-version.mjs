import {execFileSync} from "node:child_process";
import {PeerError} from "./federation/protocol.mjs";

export const MIN_GIT_VERSION="2.45.0";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
export function requireGitVersion(output){
 const match=typeof output==="string"&&/^git version ([0-9]+)\.([0-9]+)\.([0-9]+)(?:[.-][A-Za-z0-9.+-]+)?$/.exec(output.trim());
 if(!match)fail("GIT_VERSION_UNVERIFIED","无法识别 Git 版本；需要 Git >= "+MIN_GIT_VERSION);
 const parts=match.slice(1,4).map(Number);
 if(parts.some(n=>!Number.isSafeInteger(n)))fail("GIT_VERSION_UNVERIFIED","Git 版本编号无效");
 if(parts[0]<2||parts[0]===2&&parts[1]<45)fail("GIT_TOO_OLD","需要 Git >= "+MIN_GIT_VERSION+"（--no-lazy-fetch）；当前 "+parts.join("."));
 return parts.join(".");
}
export function probeGitVersion(executable,{env=process.env,cwd}={}){
 const options={env,cwd,encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:4096,stdio:["ignore","pipe","pipe"]};
 let output;try{output=execFileSync(executable,["--version"],options);}catch{fail("GIT_UNAVAILABLE","Git 版本探测失败；检查已登记程序是否可执行");}
 const version=requireGitVersion(output);
 try{execFileSync(executable,["--no-lazy-fetch","--version"],options);}catch{fail("GIT_CAPABILITY_UNAVAILABLE","该 Git 构建不支持必需的 --no-lazy-fetch；请安装 Git >= "+MIN_GIT_VERSION);}
 return version;
}
