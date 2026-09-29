import {execFileSync} from "node:child_process";
import {readFileSync,realpathSync} from "node:fs";
import {isAbsolute} from "node:path";
import {fail} from "../mcp/policy.mjs";
const TREE=/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function git(root,args){
 try{return execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,timeout:10000,maxBuffer:1024*1024,stdio:["ignore","pipe","pipe"]}).trim();}
 catch{fail("SOURCE_UNVERIFIED","无法核验治理代码的 Git 状态");}
}
/** Trusted host configuration only. Construct once at startup, never per task. */
export function createSourceGate({codeRoot,approvalFile}){
 if(typeof codeRoot!=="string"||typeof approvalFile!=="string"||!isAbsolute(codeRoot)||!isAbsolute(approvalFile))fail("BAD_INPUT","治理目录和验收文件必须使用绝对路径",400);
 const root=realpathSync(codeRoot),approvedFile=realpathSync(approvalFile),loadedTree=git(root,["rev-parse","HEAD:"]);
 if(!TREE.test(loadedTree))fail("SOURCE_UNVERIFIED","无法识别已加载的治理树");
 return Object.freeze({codeRoot:root,loadedTree,check(){
  let accepted;try{accepted=readFileSync(approvedFile,"utf8").trim();}catch{fail("SOURCE_UNVERIFIED","无法读取治理代码验收记录");}
  const current=git(root,["rev-parse","HEAD:"]);
  if(!TREE.test(accepted)||current!==accepted)fail("SOURCE_UNAPPROVED","治理代码尚未验收");
  if(current!==loadedTree)fail("SOURCE_STALE","当前进程加载的治理代码已过期，需重启");
  if(git(root,["status","--porcelain","--untracked-files=all","--","."]))fail("SOURCE_DIRTY","治理目录包含未提交变更");
  return {code_root:root,tree:current};
 }});
}
