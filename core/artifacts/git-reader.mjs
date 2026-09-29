import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {basename,dirname,isAbsolute,join} from "node:path";
import {PeerError} from "../federation/protocol.mjs";

export const MAX_FILE_BYTES=8*1024*1024,MAX_CAPTURE_BYTES=32*1024*1024,MAX_CAPTURE_FILES=256;
const fail=(code,message)=>{throw new PeerError(code,message,409);};
export function objectId(value,format=null){
 if(typeof value!=="string"||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)||format&&value.length!==(format==="sha1"?40:64))fail("BAD_OBJECT_ID","需要完整的当前对象格式提交编号");
 return value;
}
export function artifactPath(value){
 if(typeof value!=="string"||!value||Buffer.byteLength(value)>1024||value!==value.normalize("NFC")||/[\\:*?"<>|\p{C}]/u.test(value)||value.startsWith("/"))fail("UNSAFE_ARTIFACT_PATH","产物须使用可移植的规范相对路径");
 const parts=value.split("/");
 if(parts.length>32||parts.some(p=>!p||p.startsWith(" ")||p==="."||p===".."||/[. ]$/.test(p)||Buffer.byteLength(p)>240||/^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p)||/^\.?git(?:~[0-9]+)?$/i.test(p)))fail("UNSAFE_ARTIFACT_PATH","产物路径包含保留名、空段或不可移植段");
 return value;
}
export function allowedPaths(values){
 if(!Array.isArray(values)||!values.length||values.length>32)fail("BAD_PATH_POLICY","本机需显式登记 1 至 32 个可读取文件或目录");
 const out=values.map(v=>{if(typeof v!=="string")fail("BAD_PATH_POLICY","路径策略必须为文本");const prefix=v.endsWith("/");return artifactPath(prefix?v.slice(0,-1):v)+(prefix?"/":"");}).sort();
 if(new Set(out.map(p=>p.toUpperCase())).size!==out.length)fail("BAD_PATH_POLICY","路径策略重复或大小写冲突");
 return out;
}
export function gitPin(pin){
 if(!pin||Object.keys(pin).sort().join(",")!=="path,sha256"||typeof pin.path!=="string"||!isAbsolute(pin.path)||!/^[a-f0-9]{64}$/.test(pin.sha256))fail("BAD_GIT_PIN","需要固定 Git 程序绝对路径与 SHA-256");
 let path,bytes;try{path=realpathSync.native(pin.path);if(!statSync(path).isFile()||statSync(path).size>64*1024*1024)throw Error();bytes=readFileSync(path);}catch{fail("GIT_UNAVAILABLE","无法读取已登记 Git 程序");}
 if(process.platform==="win32"&&basename(dirname(path)).toLowerCase()==="cmd")fail("GIT_LAUNCHER_UNSUPPORTED","请固定 Git 的实际 bin/git.exe，不能使用 cmd 启动器");
 if(createHash("sha256").update(bytes).digest("hex")!==pin.sha256)fail("GIT_CHANGED","Git 程序与已登记摘要不一致");
 return {path,sha256:pin.sha256};
}
function directory(path){
 if(typeof path!=="string"||!isAbsolute(path))fail("ABSOLUTE_PATH_REQUIRED","仓库路径须由本机管理者指定为绝对路径");
 try{const real=realpathSync.native(path);if(!statSync(real).isDirectory())throw Error();return real;}catch{fail("REPOSITORY_MISSING","本机仓库目录不可用");}
}
export function gitEnvironment(executable){
 const env={PATH:dirname(executable),LANG:"C",LC_ALL:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_CONFIG_SYSTEM:process.platform==="win32"?"NUL":"/dev/null",GIT_ATTR_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"Never",GIT_NO_LAZY_FETCH:"1",GIT_NO_REPLACE_OBJECTS:"1",GIT_OPTIONAL_LOCKS:"0"};
 for(const k of ["SystemRoot","WINDIR","SystemDrive","TEMP","TMP"])if(process.env[k])env[k]=process.env[k];
 if(process.platform==="win32"&&process.env.SystemRoot)env.PATH+=";"+join(process.env.SystemRoot,"System32");
 return env;
}
/** Local administrator-selected repository only. No checkout, filters, network or shell. */
export function repositoryReader({root,git}){
 const deadline=performance.now()+30000,path=directory(root),pin=gitPin(git),env=gitEnvironment(pin.path),rootIdentity=statSync(path,{bigint:true});
 const sameRoot=value=>{try{const s=statSync(value,{bigint:true});return s.isDirectory()&&s.ino!==0n&&s.ino===rootIdentity.ino&&s.dev===rootIdentity.dev;}catch{return false;}};
 function run(args,limit=1024*1024){
  const remaining=Math.floor(deadline-performance.now());if(remaining<=0)fail("REPOSITORY_READ_TIMEOUT","仓库读取超过 30 秒总期限");
  try{return execFileSync(pin.path,["--no-pager","--no-lazy-fetch","--no-replace-objects","--no-optional-locks","-c","protocol.allow=never","-c","core.fsmonitor=false","-c","core.untrackedCache=false",...args],{cwd:path,env,windowsHide:true,timeout:Math.min(10000,remaining),maxBuffer:limit,stdio:["ignore","pipe","pipe"]});}
  catch{fail("GIT_READ_FAILED","本机 Git 对象读取失败或超出资源限制；不自动获取远端对象");}
 }
 const text=(args,limit)=>new TextDecoder("utf-8",{fatal:true}).decode(run(args,limit)).trim();
 if(text(["rev-parse","--is-bare-repository"])!=="false")fail("REPOSITORY_REQUIRED","需登记非裸仓库的实际工作根目录");
 if(!sameRoot(directory(text(["rev-parse","--show-toplevel"]))))fail("REPOSITORY_ROOT_REQUIRED","不能把仓库内的子目录登记为仓库根");
 const common=directory(text(["rev-parse","--path-format=absolute","--git-common-dir"])),format=text(["rev-parse","--show-object-format=storage"]);
 if(!["sha1","sha256"].includes(format))fail("OBJECT_FORMAT_UNSUPPORTED","Git 对象格式不受支持");
 const info={root:path,common_dir:common,object_format:format,git:pin};
 function object(type,oid,max){
  objectId(oid,format);const bytes=run(["cat-file",type,oid],max+1),actual=createHash(format).update(type+" "+bytes.length+"\0").update(bytes).digest("hex");
  if(bytes.length>max||actual!==oid)fail("OBJECT_CORRUPT","Git 对象长度或内容地址不一致");return bytes;
 }
 const commits=new Map();
 function readCommit(oid,withTree=true){
  objectId(oid,format);let info=commits.get(oid);
  if(!info){
   const bytes=object("commit",oid,1024*1024),first=bytes.indexOf(10),end=bytes.indexOf(Buffer.from("\n\n"));
   if(first<0||end<0)fail("COMMIT_INVALID","提交头未完整结束");
   const line=bytes.subarray(0,first).toString("latin1");if(!line.startsWith("tree "))fail("COMMIT_INVALID","提交没有规范根目录对象");
   const tree=objectId(line.slice(5),format),parents=bytes.subarray(0,end).toString("latin1").split("\n").filter(x=>x.startsWith("parent ")).map(x=>objectId(x.slice(7),format));
   if(parents.length>128)fail("ANCESTRY_LIMIT","单次合并包含过多父提交");info={commit:oid,tree,parents};commits.set(oid,info);
  }
  if(withTree)object("tree",info.tree,4*1024*1024);return info;
 }
 const commit=oid=>readCommit(oid);
 function ancestry(base,head){
  const queue=[head],seen=new Set();
  for(let i=0;i<queue.length;i++){
   const oid=queue[i];if(oid===base)return;if(seen.has(oid))continue;seen.add(oid);
   if(seen.size>1000)fail("ANCESTRY_LIMIT","交付至基线的提交遍历超过 1000 项");
   for(const parent of readCommit(oid,false).parents)if(!seen.has(parent))queue.push(parent);
  }
  fail("BASE_NOT_ANCESTOR","交付提交不继承已批准基础版本");
 }
 function treeReader(){
   const trees=new Map();let visitedEntries=0;
   function entries(tree){
    if(trees.has(tree))return trees.get(tree);
    const bytes=object("tree",tree,4*1024*1024),out=new Map(),oidBytes=format==="sha1"?20:32;let offset=0;
    while(offset<bytes.length){
     const zero=bytes.indexOf(0,offset),space=bytes.indexOf(32,offset);
     if(zero<0||space<offset||space>=zero||zero+1+oidBytes>bytes.length)fail("TREE_INVALID","目录对象结构不完整");
     const mode=bytes.subarray(offset,space).toString("latin1");let name;
     try{name=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(space+1,zero));}catch{fail("TREE_INVALID","目录名称不是有效 UTF-8");}
     if(!name||name.includes("/")||out.has(name)||!["40000","100644","100755","120000","160000"].includes(mode))fail("TREE_INVALID","目录名称或对象模式无效");
     out.set(name,{mode,oid:bytes.subarray(zero+1,zero+1+oidBytes).toString("hex")});offset=zero+1+oidBytes;
     if(++visitedEntries>10000)fail("TREE_LIMIT","选定路径涉及的目录超过 10000 项");
    }
    trees.set(tree,out);return out;
   }
   return entries;
 }
 return {info,verify(){gitPin(pin);if(directory(root)!==path||!sameRoot(path))fail("REPOSITORY_CHANGED","仓库路径已改变");},commit,
  /** Full baseline export requires a separately approved local workspace pool. */
  snapshot({commit:oid,consume}){
   if(typeof consume!=="function")fail("BAD_INPUT","需要本机基线内容接收器");
   const head=commit(oid),entries=treeReader(),selected=[],prefixes=new Map(),queue=[{tree:head.tree,prefix:""}];
   for(let i=0;i<queue.length;i++)for(const [name,e] of entries(queue[i].tree)){
    const path=artifactPath(queue[i].prefix+name),key=path.toUpperCase();
    if(prefixes.has(key))fail("PATH_COLLISION","基线存在大小写路径冲突");prefixes.set(key,path);if(prefixes.size>10000)fail("TREE_LIMIT","基线展开路径超过 10000 项");
    if(e.mode==="40000"){queue.push({tree:e.oid,prefix:path+"/"});continue;}
    if(!["100644","100755"].includes(e.mode))fail("FILE_TYPE_UNSUPPORTED","任务基线不支持符号链接或子模块");
    if(selected.length>=4096)fail("WORKSPACE_CONTENT_LIMIT","任务基线超过 4096 文件");selected.push({path,...e});
   }
   const files=[];let total=0;
   for(const e of selected.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){
    const sizeText=text(["cat-file","-s",e.oid],128),size=Number(sizeText);
    if(!/^(?:0|[1-9][0-9]*)$/.test(sizeText)||!Number.isSafeInteger(size))fail("OBJECT_CORRUPT","对象长度无效");
    if(size>MAX_FILE_BYTES||total+size>256*1024*1024)fail("WORKSPACE_CONTENT_LIMIT","任务基线单文件超过 8 MiB 或总计超过 256 MiB");
    const bytes=object("blob",e.oid,MAX_FILE_BYTES);
    if(bytes.length!==size)fail("OBJECT_CORRUPT","对象长度改变");
    if(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(bytes.subarray(0,80).toString("utf8")))fail("LFS_CONTENT_REQUIRED","基线需要实际 LFS 内容");
    const metadata={path:e.path,mode:e.mode,blob_oid:e.oid,size,sha256:createHash("sha256").update(bytes).digest("hex")};
    consume(metadata,bytes);total+=size;files.push(metadata);
   }
   gitPin(pin);return {object_format:format,commit:head.commit,tree:head.tree,total_bytes:total,files};
  },
  capture({baseCommit,commit:oid,paths,allowed}){
   const base=commit(baseCommit),head=commit(oid);
   ancestry(baseCommit,oid);
   if(!Array.isArray(paths)||!paths.length||paths.length>MAX_CAPTURE_FILES)fail("CAPTURE_LIMIT","每次需指定 1 至 256 个产物文件");
   const wanted=paths.map(artifactPath).sort(),policy=allowedPaths(allowed);
   if(new Set(wanted.map(p=>p.toUpperCase())).size!==wanted.length)fail("PATH_COLLISION","文件路径重复或大小写冲突");
   const prefixes=new Map();
   for(const path of wanted){let prefix="";const parts=path.split("/");for(let i=0;i<parts.length;i++){
    prefix+=(i?"/":"")+parts[i];const key=prefix.toUpperCase(),file=i===parts.length-1,old=prefixes.get(key);
    if(old&&(old.path!==prefix||old.file!==file))fail("PATH_COLLISION","路径前缀存在大小写或文件/目录冲突");prefixes.set(key,{path:prefix,file});
   }}
   if(wanted.some(p=>!policy.some(a=>a.endsWith("/")?p.startsWith(a):p===a)))fail("PATH_NOT_ALLOWED","产物不在本机批准的路径范围内");
   // Verify every tree object along selected paths ourselves. ls-tree alone
   // would trust a corrupt child object stored under another object's filename.
   const entries=treeReader();
   const files=[];let total=0;
   for(const name of wanted){
    let tree=head.tree,e;const parts=name.split("/");
    for(let i=0;i<parts.length;i++){
     e=entries(tree).get(parts[i]);if(!e)fail("FILE_NOT_COMMITTED","指定产物不在固定提交中");
     if(i<parts.length-1){if(e.mode!=="40000")fail("FILE_TYPE_UNSUPPORTED","不能穿越符号链接、子模块或非目录对象");tree=e.oid;}
    }
    if(!["100644","100755"].includes(e.mode))fail("FILE_TYPE_UNSUPPORTED","不接收符号链接、子模块或特殊文件");
    const sizeText=text(["cat-file","-s",e.oid],128);if(!/^(?:0|[1-9][0-9]*)$/.test(sizeText))fail("OBJECT_CORRUPT","对象长度不规范");const size=Number(sizeText);
    if(!Number.isSafeInteger(size)||size>MAX_FILE_BYTES||total+size>MAX_CAPTURE_BYTES)fail("CAPTURE_LIMIT","文件超过 8 MiB 或总内容超过 32 MiB");
    const bytes=object("blob",e.oid,MAX_FILE_BYTES);if(bytes.length!==size)fail("OBJECT_CORRUPT","对象读取期间长度改变");
    if(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(bytes.subarray(0,80).toString("utf8")))fail("LFS_CONTENT_REQUIRED","LFS 指针不是实际产物内容");
    total+=size;files.push({path:name,mode:e.mode,blob_oid:e.oid,size,sha256:createHash("sha256").update(bytes).digest("hex"),bytes});
   }
   gitPin(pin);return {object_format:format,base_commit:base.commit,base_tree:base.tree,commit:head.commit,tree:head.tree,total_bytes:total,files};
  }
 };
}
