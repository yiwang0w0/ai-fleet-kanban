import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {isAbsolute,join} from "node:path";
import {fail} from "../mcp/policy.mjs";
import {gitPin,gitEnvironment} from "../artifacts/git-reader.mjs";
const TREE=/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function selectedGit(configured,approvalFile){
 if(configured!==undefined)return gitPin(configured);
 const sidecar=approvalFile+".git.json";let bytes;
 try{if(statSync(sidecar).size>16384)fail("BAD_GIT_PIN","Git 配置文件过大");bytes=readFileSync(sidecar,'utf8');}catch(e){if(e.code!=="ENOENT")fail("BAD_GIT_PIN","无法读取固定 Git 配置");}
 if(bytes!==undefined){let parsed;try{parsed=JSON.parse(bytes);}catch{fail("BAD_GIT_PIN","Git 配置不是有效 JSON");}return gitPin(parsed);}
 // Fixed Windows installation fallback, never command lookup through PATH.
 if(process.platform!=="win32")fail("WINDOWS_REQUIRED","治理代码检查仅支持 Windows");
 const path=join(process.env.ProgramW6432||process.env.ProgramFiles||"C:\\Program Files","Git","bin","git.exe");let content;
 try{if(statSync(path).size>64*1024*1024)throw Error();content=readFileSync(path);}catch{fail("GIT_UNAVAILABLE","未找到标准 Git 安装；请在验收文件旁提供 .git.json 路径与摘要配置");}
 return gitPin({path,sha256:createHash("sha256").update(content).digest("hex")});
}
function runGit(root,pin,args){
 gitPin(pin);
 try{return execFileSync(pin.path,["--no-pager","--no-lazy-fetch","--no-replace-objects","--no-optional-locks","-c","safe.directory="+root,"-c","protocol.allow=never","-c","core.fsmonitor=false","-c","core.untrackedCache=false","-C",root,...args],{env:gitEnvironment(pin.path),encoding:"utf8",windowsHide:true,timeout:10000,maxBuffer:1024*1024,stdio:["ignore","pipe","pipe"]}).trim();}
 catch{fail("SOURCE_UNVERIFIED","无法核验治理代码的 Git 状态");}
}
/** Trusted host configuration only. Construct once at startup, never per task. */
export function createSourceGate({codeRoot,approvalFile,git:configuredGit}){
 if(typeof codeRoot!=="string"||typeof approvalFile!=="string"||!isAbsolute(codeRoot)||!isAbsolute(approvalFile))fail("BAD_INPUT","治理目录和验收文件必须使用绝对路径",400);
 // ⭐ realpath 失败走编码错误而不是裸 ENOENT(外部审计 2026-10-05)。
 let root,approvedFile;try{root=realpathSync(codeRoot);approvedFile=realpathSync(approvalFile);}
 catch{fail("BAD_INPUT","治理目录或验收文件路径不可达,请核对绝对路径",400);}
 const pin=Object.freeze(selectedGit(configuredGit,approvedFile)),loadedTree=runGit(root,pin,["rev-parse","HEAD:"]);
 if(!TREE.test(loadedTree))fail("SOURCE_UNVERIFIED","无法识别已加载的治理树");
 return Object.freeze({codeRoot:root,loadedTree,git:pin,check(){
  let accepted;try{accepted=readFileSync(approvedFile,"utf8").trim();}catch{fail("SOURCE_UNVERIFIED","无法读取治理代码验收记录");}
  const current=runGit(root,pin,["rev-parse","HEAD:"]);
  if(!TREE.test(accepted)||current!==accepted)fail("SOURCE_UNAPPROVED","治理代码尚未验收");
  if(current!==loadedTree)fail("SOURCE_STALE","当前进程加载的治理代码已过期，需重启");
  if(runGit(root,pin,["status","--porcelain","--untracked-files=all","--","."]))fail("SOURCE_DIRTY","治理目录包含未提交变更");
  return {code_root:root,tree:current,git:pin};
 }});
}
