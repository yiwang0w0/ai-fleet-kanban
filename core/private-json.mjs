// Credential files are created with a protected Windows DACL before secret bytes exist.
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {join,isAbsolute} from "node:path";
import {PeerError} from "./federation/protocol.mjs";
const script=readFileSync(new URL("./private-json.ps1",import.meta.url),"utf8");
const encoded=Buffer.from(script,"utf16le").toString("base64");
// 独占创建路只此一条:JSON 与裸文本(看板令牌)只差编码,不差保护等级
// (外部审计 2026-10-05:看板令牌此前仅 POSIX 0600 位,Windows 忽略之)。
function createPrivateFile(file,bytes){
 if(typeof file!=="string"||!isAbsolute(file)||!(/^[a-z]:[\\/]/i.test(file))||file.slice(2).includes(":")||file.includes("\0")||file.split(/[\\/]/).slice(1).some(p=>/^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p)))throw new PeerError("BAD_INPUT","凭据需要本地磁盘普通文件的绝对路径",400);
 if(bytes.length>1024*1024)throw new PeerError("BAD_INPUT","凭据文件超过 1 MiB",400);
 const systemRoot=process.env.SystemRoot;
 if(!systemRoot||!isAbsolute(systemRoot))throw new PeerError("PRIVATE_FILE_FAILED","Windows 凭据保护接口不可用",409);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase())));
 // Allow a bounded margin for Windows cold startup on hosted runners. Stay closed
 // and fail closed without retrying an operation that may have created a file.
 const result=spawnSync(join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",encoded],{
  input:Buffer.from(file,"utf8").toString("base64")+"|"+bytes.toString("base64"),env,windowsHide:true,timeout:30000,maxBuffer:16384,encoding:"utf8",stdio:["pipe","pipe","pipe"]});
 if(result.status===0&&result.stdout.trim()==="PRIVATE_FILE_OK")return;
 if(result.status===2&&result.stdout.trim()==="PRIVATE_FILE_EXISTS")throw Object.assign(Error("EEXIST: credential file already exists"),{code:"EEXIST"});
 // Never forward PowerShell exception output, credential bytes or destination paths.
 const reason=result.error?.code==="ETIMEDOUT"?"helper_timeout":result.error?"helper_unavailable":result.status!==0?"helper_failed":"unverified_response";
 throw Object.assign(new PeerError("PRIVATE_FILE_FAILED","无法创建并核验受保护的 Windows 凭据文件；未授权本次凭据",409),{reason});
}
export function writePrivateJSON(file,value){
 if(process.platform!=="win32")throw new PeerError("WINDOWS_REQUIRED","凭据文件创建只支持 Windows",409);
 createPrivateFile(file,Buffer.from(JSON.stringify(value,null,2)+"\n","utf8"));
}
// 裸文本变体:同一 ps1、同样的独占创建与回读校验,只是内容为任意字符串——
// 令牌文件以读取方 trim 收尾,不追加换行。
export function writePrivateText(file,text){
 if(process.platform!=="win32")throw new PeerError("WINDOWS_REQUIRED","凭据文件创建只支持 Windows",409);
 if(typeof text!=="string")throw new PeerError("BAD_INPUT","凭据文本需要字符串",400);
 createPrivateFile(file,Buffer.from(text,"utf8"));
}
