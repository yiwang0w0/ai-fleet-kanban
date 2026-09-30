import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync,unlinkSync,rmdirSync,lstatSync,readdirSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {PeerError} from "../federation/protocol.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {gitPin,gitEnvironment,repositoryReader,artifactPath} from "../artifacts/git-reader.mjs";
import {provisionGitWorkspace,verifyInitialWorkspace,verifyDirectory,overlaps} from "../artifacts/git-workspace.mjs";
import {verifyGitPackage} from "../artifacts/git-package.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
function gitRunner(root,pin){const deadline=performance.now()+120000;return (args,input=null)=>{
 gitPin(pin);const remaining=Math.floor(deadline-performance.now());if(remaining<=0)fail("VERIFICATION_WORKSPACE_TIMEOUT","验证目录准备或核对超时");
 try{return execFileSync(pin.path,["--no-pager","--no-lazy-fetch","--no-replace-objects","--no-optional-locks","-c","protocol.allow=never","-c","core.fsmonitor=false","-c","core.untrackedCache=false",...args],{cwd:root,env:gitEnvironment(pin.path),input,windowsHide:true,timeout:Math.min(30000,remaining),maxBuffer:2*1024*1024,stdio:["pipe","pipe","pipe"]}).toString("utf8").trim();}
 catch{fail("VERIFICATION_GIT_FAILED","固定 Git 无法核对验证目录");}
};}
function filePath(receipt,path,create){
 artifactPath(path);verifyDirectory(receipt.identities.repo);const parts=path.split("/");let dir=receipt.identities.repo.root;
 for(const part of parts.slice(0,-1)){dir=join(dir,part);if(!existsSync(dir)&&create)mkdirSync(dir,{mode:0o700});const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())fail("UNSAFE_VERIFICATION_PATH","验证目录中存在链接或非普通目录");}
 const file=join(dir,parts.at(-1));if(existsSync(file)){const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail("UNSAFE_VERIFICATION_PATH","验证输入不能是链接或特殊文件");}return file;
}
function prune(root,dir){while(dir!==root&&overlaps(root,dir)){const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())fail("UNSAFE_VERIFICATION_PATH","删除项父目录不安全");try{rmdirSync(dir);}catch(e){if(e.code==="ENOTEMPTY"||e.code==="EEXIST")break;throw e;}dir=dirname(dir);}}
/** Caller already approved full local history copying and the package's receiving grant. */
export function materializeVerificationInput({source,container,packageBytes,manifest,manifestDigest,allowFullHistoryCopy}){
 if(allowFullHistoryCopy!==true)fail("FULL_HISTORY_PERMISSION_REQUIRED","验证仓库副本需本机批准完整历史复制");
 const initial=provisionGitWorkspace({source,baseCommit:manifest.base_commit,container});verifyInitialWorkspace(initial);
 const verified=verifyGitPackage(packageBytes,{manifest,manifestDigest,baseline:initial.manifest,allowedPaths:source.allowed_paths}),root=initial.identities.repo.root,run=gitRunner(root,source.git);
 for(const f of manifest.files.filter(f=>f.operation==="delete")){const file=filePath(initial,f.path,false);unlinkSync(file);prune(root,dirname(file));}
 for(const f of verified.files){const metadata=manifest.files.find(x=>x.path===f.path),file=filePath(initial,f.path,true);writeFileSync(file,f.bytes,{flag:"w",mode:metadata.mode==="100755"?0o700:0o600});}
 for(const f of manifest.files){
  const oid=f.operation==="delete"?"0".repeat(manifest.commit.length):run(["hash-object","-w","--no-filters","--stdin"],verified.files.find(x=>x.path===f.path).bytes);
  if(f.operation!=="delete"&&oid!==f.blob_oid)fail("OBJECT_CORRUPT","验证副本的实际文件对象不同");
  run(["update-index","-z","--index-info"],Buffer.from((f.operation==="delete"?"0":f.mode)+" "+oid+"\t"+f.path+"\0"));
 }
 if(run(["write-tree"])!==manifest.tree||run(["hash-object","-t","commit","-w","--stdin"],verified.commit_bytes)!==manifest.commit)fail("OBJECT_CORRUPT","验证副本的目录或提交不同");
 run(["update-ref","--no-deref","HEAD",manifest.commit,manifest.base_commit]);
 const g=repositoryReader({root,git:source.git}),actual=g.snapshot({commit:manifest.commit,consume(){}});g.verify();if(digest(actual)!==manifest.content_snapshot_digest)fail("OBJECT_CORRUPT","验证副本完整内容不匹配");
 const receipt={format:"ai-fleet-verification-input/v1",manifest:actual,artifact_manifest_digest:manifestDigest,base_manifest_digest:digest(initial.manifest),identities:initial.identities,git:source.git,source_isolation:initial.source_isolation,filesystem_sandbox:false};assertVerificationInput(receipt);return receipt;
}
/** Checks original input files before and after commands; generated files never enter an accepted artifact. */
export function assertVerificationInput(receipt,{allowGenerated=false}={}){
 if(receipt.format!=="ai-fleet-verification-input/v1")fail("BAD_VERIFICATION_INPUT","验证输入类型不匹配");verifyInitialWorkspace(receipt);
 const root=receipt.identities.repo.root,expected=new Set(receipt.manifest.files.map(f=>f.path)),queue=[{dir:root,path:""}];let count=0,bytes=0;
 for(let i=0;i<queue.length;i++)for(const entry of readdirSync(queue[i].dir,{withFileTypes:true})){
  if(i===0&&entry.name===".git")continue;const path=queue[i].path+entry.name,full=join(queue[i].dir,entry.name),s=lstatSync(full);artifactPath(path);
  if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory()||s.isFile()&&s.nlink!==1)fail("UNSAFE_VERIFICATION_PATH","验证输出中出现链接或特殊文件");
  if(++count>50000)fail("VERIFICATION_OUTPUT_LIMIT","验证目录条目过多");if(s.isDirectory())queue.push({dir:full,path:path+"/"});else{bytes+=s.size;if(bytes>512*1024*1024)fail("VERIFICATION_OUTPUT_LIMIT","验证目录文件超过 512 MiB");if(!allowGenerated&&!expected.has(path))fail("VERIFICATION_INPUT_CHANGED","启动前出现未登记文件");}
 }
 const run=gitRunner(root,receipt.git);if(run(["rev-parse","--verify","HEAD"])!==receipt.manifest.commit)fail("VERIFICATION_INPUT_CHANGED","验证提交指针已变化");run(["diff-index","--cached","--no-ext-diff","--quiet",receipt.manifest.commit,"--"]);
 const g=repositoryReader({root,git:receipt.git}),current=g.snapshot({commit:receipt.manifest.commit,consume(){}});g.verify();if(canonical(current)!==canonical(receipt.manifest))fail("VERIFICATION_INPUT_CHANGED","验证 Git 对象已变化");
 return {input_digest:digest(receipt.manifest),artifact_manifest_digest:receipt.artifact_manifest_digest,commit:receipt.manifest.commit,inputs_unchanged:true};
}
