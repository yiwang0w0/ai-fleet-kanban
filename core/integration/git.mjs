import {execFileSync} from "node:child_process";
import {mkdirSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {PeerError} from "../federation/protocol.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {gitPin,gitEnvironment,objectId,repositoryReader} from "../artifacts/git-reader.mjs";
import {verifyGitPackage,gitObjectHash,contentHash} from "../artifacts/git-package.mjs";
import {directoryIdentity,verifyDirectory} from "../artifacts/git-workspace.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
export function integrationRef(ref){
 if(typeof ref!=="string"||ref.length>240||!/^refs\/(?:heads|ai-fleet\/integrations)\/[a-z0-9][a-z0-9._/-]*$/.test(ref)||ref.includes("..")||ref.includes("//")||ref.split("/").some(x=>!x||x.startsWith(".")||x.endsWith(".")||x.endsWith(".lock")))fail("BAD_INTEGRATION_REF","需要本机批准的小写分支或集成引用，不能使用 HEAD 或远端引用");return ref;
}
/** Fixed local Git, no hooks, shell, checkout, attributes, lazy fetch or source index writes. */
export function integrationGit({source,identities,container}){
 const pin=gitPin(source.git),deadline=performance.now()+120000;
 function verify(){verifyDirectory(identities.repo);verifyDirectory(identities.common);if(container){verifyDirectory(container.root);verifyDirectory(container.hooks);if(readdirSync(container.hooks.root).length)fail("INTEGRATION_HOOKS_CHANGED","固定空 hooks 目录发生变化");}gitPin(pin);}
 function run(args,input=null,{index=false,limit=2*1024*1024}={}){
  verify();const remain=Math.floor(deadline-performance.now());if(remain<=0)fail("INTEGRATION_GIT_TIMEOUT","来源 Git 操作超过期限");
  const env={...gitEnvironment(pin.path),GIT_DIR:source.common_dir,GIT_COMMON_DIR:source.common_dir,GIT_WORK_TREE:source.root};if(index){if(!container)fail("INTEGRATION_CONTAINER_REQUIRED","需要私有索引目录");env.GIT_INDEX_FILE=join(container.root.root,"source-index");}
  try{return execFileSync(pin.path,["--no-pager","--no-lazy-fetch","--no-replace-objects","--no-optional-locks","-c","protocol.allow=never","-c","core.fsmonitor=false","-c","core.untrackedCache=false","-c","core.hooksPath="+(container?.hooks.root??"NUL"),"-c","user.name=AI Fleet","-c","user.email=local@ai-fleet.invalid",...args],{cwd:source.root,env,input,windowsHide:true,timeout:Math.min(15000,remain),maxBuffer:limit,stdio:["pipe","pipe","pipe"]});}
  catch(e){const error=new PeerError("INTEGRATION_GIT_FAILED","固定来源 Git 操作未成功；不自动重试引用更新",409);error.command_completed=Number.isInteger(e.status)&&!e.signal;throw error;}
 }
 const text=(args,input=null,opts={})=>new TextDecoder("utf-8",{fatal:true}).decode(run(args,input,opts)).trim();
 function refValue(ref){integrationRef(ref);const all=text(["for-each-ref","--format=%(refname)%00%(objectname)%00%(symref)"]);let value=null;
  for(const line of all.split("\n")){if(!line)continue;const [name,oid,sym,...extra]=line.split("\0");if(extra.length||sym===undefined)fail("BAD_REF_OBSERVATION","来源引用输出无效");if(name.toLowerCase()!==ref.toLowerCase())continue;if(name!==ref||sym)fail("UNSAFE_INTEGRATION_REF","引用存在大小写别名或符号跳转");value=objectId(oid,source.object_format);}
  return value;
 }
 function checkoutGuard(ref){integrationRef(ref);const fields=run(["worktree","list","--porcelain","-z"]).toString("utf8").split("\0");if(fields.some(s=>s.startsWith("branch ")&&s.slice(7).toLowerCase()===ref.toLowerCase()))fail("INTEGRATION_REF_CHECKED_OUT","目标引用正在某个工作区使用，拒绝更新该工作区的分支");}
 function compareAndSwap({ref,expected,next}){integrationRef(ref);objectId(expected,source.object_format);objectId(next,source.object_format);checkoutGuard(ref);if(refValue(ref)!==expected)fail("SOURCE_REF_CONFLICT","来源引用已偏离原始批准基线");text(["update-ref","--no-deref","--create-reflog","-m","ai-fleet verified integration",ref,next,expected]);return refValue(ref);}
 return {run,text,refValue,checkoutGuard,compareAndSwap,verify};
}
export function sourceIdentities(source){return {repo:directoryIdentity(source.root),common:directoryIdentity(source.common_dir)};}
export function integrationCommitBytes({manifest,intent,timestamp}){
 if(!Number.isSafeInteger(timestamp)||timestamp<1)fail("BAD_INTEGRATION_TIME","合并时间无效");
 return Buffer.from("tree "+manifest.tree+"\nparent "+manifest.base_commit+"\nparent "+manifest.commit+"\nauthor AI Fleet <local@ai-fleet.invalid> "+timestamp+" +0000\ncommitter AI Fleet <local@ai-fleet.invalid> "+timestamp+" +0000\n\nai-fleet source integration\n\n"+canonical(intent)+"\n");
}
/** Adds actual objects and a bound merge commit. No source reference changes here. */
export function importIntegrationObjects({source,identities,containerPath,packageBytes,manifest,manifestDigest,intent,timestamp}){
 const g=repositoryReader({root:source.root,git:source.git}),baseline=g.snapshot({commit:manifest.base_commit,consume(){}});g.verify();
 const verified=verifyGitPackage(packageBytes,{manifest,manifestDigest,baseline,allowedPaths:source.allowed_paths});
 mkdirSync(containerPath,{mode:0o700});const hooks=join(containerPath,"empty-hooks");mkdirSync(hooks);const container={root:directoryIdentity(containerPath),hooks:directoryIdentity(hooks)},git=integrationGit({source,identities,container});
 git.text(["read-tree",manifest.base_commit],null,{index:true});
 for(const f of [...manifest.files.filter(x=>x.operation==="delete"),...manifest.files.filter(x=>x.operation!=="delete")]){
  const oid=f.operation==="delete"?"0".repeat(manifest.commit.length):git.text(["hash-object","-w","--no-filters","--stdin"],verified.files.find(x=>x.path===f.path).bytes);
  if(f.operation!=="delete"&&oid!==f.blob_oid)fail("OBJECT_CORRUPT","导入文件对象与清单不同");
  git.text(["update-index","-z","--index-info"],Buffer.from((f.operation==="delete"?"0":f.mode)+" "+oid+"\t"+f.path+"\0"),{index:true});
 }
 if(git.text(["write-tree"],null,{index:true})!==manifest.tree||git.text(["hash-object","-t","commit","-w","--stdin"],verified.commit_bytes)!==manifest.commit)fail("OBJECT_CORRUPT","来源实际导入的目录或提交不同");
 const bytes=integrationCommitBytes({manifest,intent,timestamp}),merge=gitObjectHash("commit",bytes,source.object_format);if(git.text(["hash-object","-t","commit","-w","--stdin"],bytes)!==merge)fail("OBJECT_CORRUPT","来源合并提交摘要不匹配");
 const receipt={format:"ai-fleet-integration-objects/v1",container,source_identities:identities,artifact_commit:manifest.commit,base_commit:manifest.base_commit,merge_commit:merge,tree:manifest.tree,raw_commit_sha256:contentHash(bytes),intent_digest:digest(intent)};
 verifyIntegrationObjects({source,receipt,manifest,intent,timestamp});return receipt;
}
export function verifyIntegrationObjects({source,receipt,manifest,intent,timestamp}){
 if(receipt.format!=="ai-fleet-integration-objects/v1"||receipt.intent_digest!==digest(intent)||receipt.artifact_commit!==manifest.commit||receipt.base_commit!==manifest.base_commit||receipt.tree!==manifest.tree)fail("INTEGRATION_OBJECT_MISMATCH","来源对象回执与固定意图不符");
 const git=integrationGit({source,identities:receipt.source_identities,container:receipt.container});git.verify();
 const expected=integrationCommitBytes({manifest,intent,timestamp}),g=repositoryReader({root:source.root,git:source.git});
 if(receipt.raw_commit_sha256!==contentHash(expected)||receipt.merge_commit!==gitObjectHash("commit",expected,source.object_format)||!g.commitBytes(receipt.merge_commit).equals(expected))fail("INTEGRATION_OBJECT_MISMATCH","来源合并提交实际内容不同");
 const actual=g.snapshot({commit:manifest.commit,consume(){}});g.verify();if(digest(actual)!==manifest.content_snapshot_digest)fail("INTEGRATION_OBJECT_MISMATCH","导入产物完整内容变化");return git;
}
