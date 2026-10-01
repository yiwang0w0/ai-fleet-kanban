import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {lstatSync,statSync,realpathSync,readdirSync,readFileSync,mkdirSync,writeFileSync,chmodSync,existsSync} from "node:fs";
import {isAbsolute,join,dirname,relative,sep} from "node:path";
import {PeerError} from "../federation/protocol.mjs";
import {gitPin,gitEnvironment,repositoryReader} from "./git-reader.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
export const overlaps=(a,b)=>{const r=relative(a,b);return !r||r!==".."&&!r.startsWith(".."+sep)&&!isAbsolute(r);};
export function directoryIdentity(path){
 if(typeof path!=="string"||!isAbsolute(path))fail("ABSOLUTE_PATH_REQUIRED","工作区必须使用本机绝对目录");
 try{const root=realpathSync.native(path),s=statSync(root,{bigint:true});if(!s.isDirectory()||s.ino===0n)throw Error();return {root,device:s.dev.toString(),inode:s.ino.toString()};}catch{fail("WORKSPACE_DIRECTORY_UNAVAILABLE","工作区目录不可用");}
}
export function verifyDirectory(identity){
 let now;try{now=directoryIdentity(identity.root);}catch{fail("WORKSPACE_DIRECTORY_CHANGED","已登记目录缺失或不可用");}
 if(now.root!==identity.root||now.device!==identity.device||now.inode!==identity.inode)fail("WORKSPACE_DIRECTORY_CHANGED","已登记目录已被替换");
}
function ordinaryTree(root,{maxBytes=512*1024*1024,maxFiles=50000,independent=false}={}){
 let bytes=0,files=0;const queue=[root];
 for(let i=0;i<queue.length;i++){
  const d=lstatSync(queue[i]);if(!d.isDirectory()||d.isSymbolicLink())fail("UNSAFE_OBJECT_STORE","对象目录不是普通目录");
  for(const e of readdirSync(queue[i],{withFileTypes:true})){
   const path=join(queue[i],e.name),s=lstatSync(path);
   if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())fail("UNSAFE_OBJECT_STORE","不能复制对象目录中的链接或特殊文件");
   if(++files>maxFiles)fail("WORKSPACE_COPY_LIMIT","对象目录条目超过上限");
   if(s.isDirectory())queue.push(path);
   else{if(independent&&s.nlink!==1)fail("SHARED_OBJECT_STORE","工作区不能共享对象硬链接");bytes+=s.size;if(bytes>maxBytes)fail("WORKSPACE_COPY_LIMIT","本机对象副本超过 512 MiB");}
  }
 }
 if(existsSync(join(root,"info","alternates"))||existsSync(join(root,"info","http-alternates")))fail("SHARED_OBJECT_STORE","不能复制依赖外部对象目录的仓库");
 return {bytes,entries:files};
}
/** Private, new directory only. No checkout/filter/hook is invoked. Partial work is retained on error. */
export function provisionGitWorkspace({source,baseCommit,container}){
 const sourceReader=repositoryReader({root:source.root,git:source.git}),base=sourceReader.commit(baseCommit);
 if(sourceReader.info.common_dir!==source.common_dir||sourceReader.info.object_format!==source.object_format)fail("REPOSITORY_CHANGED","源仓库身份改变");
 ordinaryTree(join(source.common_dir,"objects"));
 const pin=gitPin(source.git),env=gitEnvironment(pin.path),deadline=performance.now()+120000;
 const run=(cwd,args)=>{
  gitPin(pin);const remaining=Math.floor(deadline-performance.now());if(remaining<=0)fail("WORKSPACE_PROVISION_TIMEOUT","工作区准备超过期限");
  try{return execFileSync(pin.path,["--no-pager","--no-lazy-fetch","--no-replace-objects","--no-optional-locks","-c","protocol.allow=never","-c","core.fsmonitor=false","-c","core.autocrlf=false","-c","core.hooksPath="+join(container,"empty-template"),...args],{cwd,env,windowsHide:true,timeout:Math.min(60000,remaining),maxBuffer:2*1024*1024,stdio:["ignore","pipe","pipe"]});}
  catch{fail("WORKSPACE_GIT_FAILED","本机工作区 Git 操作失败；未自动访问网络");}
 };
 mkdirSync(container,{mode:0o700});const containerIdentity=directoryIdentity(container),template=join(container,"empty-template"),root=join(container,"repo");mkdirSync(template);
 run(container,["-c","protocol.file.allow=always","clone","--local","--no-hardlinks","--no-checkout","--template="+template,"--",source.root,root]);
 verifyDirectory(containerIdentity);const repoIdentity=directoryIdentity(root),gitIdentity=directoryIdentity(join(root,".git"));
 if(lstatSync(join(root,".git")).isSymbolicLink())fail("SHARED_OBJECT_STORE","工作区 Git 目录不是独立目录");
 ordinaryTree(join(root,".git","objects"),{independent:true});
 run(root,["remote","remove","origin"]);
 const reader=repositoryReader({root,git:pin});
 if(reader.info.common_dir!==gitIdentity.root||reader.info.object_format!==source.object_format)fail("SHARED_OBJECT_STORE","工作区对象目录或格式不匹配");
 const manifest=reader.snapshot({commit:baseCommit,consume(metadata,bytes){
  verifyDirectory(containerIdentity);verifyDirectory(repoIdentity);
  const file=join(root,...metadata.path.split("/"));mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,bytes,{flag:"wx",mode:metadata.mode==="100755"?0o700:0o600});
  if(process.platform!=="win32")chmodSync(file,metadata.mode==="100755"?0o700:0o600);
 }});
 if(manifest.tree!==base.tree)fail("OBJECT_CORRUPT","副本基线树与源仓库不一致");
 // Populate index and detached HEAD without checkout's attribute conversion.
 run(root,["read-tree",baseCommit]);run(root,["update-ref","--no-deref","HEAD",baseCommit]);
 run(root,["config","core.autocrlf","false"]);run(root,["config","core.hooksPath",template]);
 reader.verify();sourceReader.verify();verifyDirectory(containerIdentity);verifyDirectory(repoIdentity);verifyDirectory(gitIdentity);
 return {manifest,identities:{container:containerIdentity,repo:repoIdentity,git:gitIdentity},source_isolation:"copied_objects_no_hardlinks",filesystem_sandbox:false};
}
/** Verifies provisioning content, not an adversarial OS sandbox or a later result. */
export function verifyInitialWorkspace(receipt){
 for(const i of Object.values(receipt.identities))verifyDirectory(i);
 const root=receipt.identities.repo.root;
 for(const f of receipt.manifest.files){
  const parts=f.path.split("/");let path=root;
  for(let i=0;i<parts.length;i++){path=join(path,parts[i]);const s=lstatSync(path);if(s.isSymbolicLink()||i<parts.length-1&&!s.isDirectory()||i===parts.length-1&&(!s.isFile()||s.size!==f.size))fail("WORKSPACE_CONTENT_CHANGED","工作区内容已改变");}
  if(createHash("sha256").update(readFileSync(path)).digest("hex")!==f.sha256)fail("WORKSPACE_CONTENT_CHANGED","工作区文件摘要已改变");
 }
 return true;
}
