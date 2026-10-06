import {createHash} from "node:crypto";
import {PeerError,keys,uuid,names} from "../federation/protocol.mjs";
import {canonical,digest,taskUID} from "../federation/sync-store.mjs";
import {artifactPath,objectId,MAX_FILE_BYTES,MAX_CAPTURE_BYTES,MAX_CAPTURE_FILES} from "./git-reader.mjs";
export const MAX_PACKAGE_BYTES=48*1024*1024;
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const exact=(v,fields)=>{keys(v,fields,"artifact");if(Object.keys(v).length!==fields.length)fail("BAD_ARTIFACT","产物字段缺失");};
export const contentHash=b=>createHash("sha256").update(b).digest("hex");
const hash=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
export function gitObjectHash(type,bytes,format){return createHash(format).update(type+" "+bytes.length+"\0").update(bytes).digest("hex");}
export function base64Bytes(s,max){
 if(typeof s!=="string"||s.length>Math.ceil(max/3)*4||s.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))fail("BAD_ARTIFACT_BYTES","内容编码无效或超限");
 const bytes=Buffer.from(s,"base64");if(bytes.length>max||bytes.toString("base64")!==s)fail("BAD_ARTIFACT_BYTES","内容编码不规范");return bytes;
}
export function validateDeliveryManifest(m){
 exact(m,["schema_version","kind","node_id","node_epoch","workspace_id","project_id","repo_id","task_uid","run_id","dispatch_id","agent_instance_id","base_commit","commit","tree","content_snapshot_digest","session_descriptor_digest","session_revision","launch_digest","process_result_digest","stop_proofs","fixture_runs","files","real_model_call_confirmed"]);
 if(m.schema_version!==1||m.kind!=="workspace_delivery_commit"||m.real_model_call_confirmed!==false)fail("BAD_ARTIFACT","交付清单版本或种类无效");
 for(const k of ["node_id","node_epoch","workspace_id","run_id","dispatch_id","agent_instance_id"])uuid(m[k],k);
 taskUID(m.task_uid,m.node_id);
 names([m.project_id],"project_id",null,1);names([m.repo_id],"repo_id",null,1);const format=m.commit?.length===64?"sha256":"sha1";
 for(const k of ["base_commit","commit","tree"])objectId(m[k],format);
 for(const k of ["content_snapshot_digest","session_descriptor_digest","launch_digest","process_result_digest"])if(!hash(m[k]))fail("BAD_ARTIFACT","交付摘要无效");
 if(!Number.isSafeInteger(m.session_revision)||m.session_revision<0||m.session_revision>512||!Number.isSafeInteger(m.fixture_runs)||m.fixture_runs<0||m.fixture_runs>1||!Array.isArray(m.stop_proofs)||m.stop_proofs.length!==1)fail("BAD_ARTIFACT","交付运行边界无效");
 const proof=m.stop_proofs[0];if(!proof||typeof proof!=="object"||Array.isArray(proof))fail("BAD_ARTIFACT","停止证明无效");
 if(proof.kind==="fixture_terminal"){exact(proof,["run_id","kind","result_digest"]);if(proof.result_digest!==m.process_result_digest||m.fixture_runs!==1)fail("BAD_ARTIFACT","合成停止证明不匹配");}
 else{exact(proof,["run_id","kind","observation_digest","launch_digest"]);if(!["not_started","windows_job_empty"].includes(proof.kind)||!hash(proof.observation_digest)||proof.launch_digest!==m.launch_digest||m.fixture_runs!==0)fail("BAD_ARTIFACT","实际停止证明不匹配");}
 if(proof.run_id!==m.run_id)fail("BAD_ARTIFACT","停止证明不属于本次运行");
 if(!Array.isArray(m.files)||m.files.length>MAX_CAPTURE_FILES)fail("BAD_ARTIFACT","交付文件过多");
 const seen=new Set();let total=0;
 for(const f of m.files){
  exact(f,["path","operation","mode","sha256","size","blob_oid","base_sha256"]);artifactPath(f.path);if(seen.has(f.path.toUpperCase()))fail("PATH_COLLISION","交付路径重复");seen.add(f.path.toUpperCase());
  if(!Number.isSafeInteger(f.size)||f.size<0||f.size>MAX_FILE_BYTES||f.base_sha256!==null&&!hash(f.base_sha256))fail("BAD_ARTIFACT","文件长度或原摘要无效");
  if(f.operation==="delete"){if(f.mode!==null||f.sha256!==null||f.blob_oid!==null||f.size!==0||!hash(f.base_sha256))fail("BAD_ARTIFACT","删除记录无效");}
  else if(f.operation==="write"){if(!["100644","100755"].includes(f.mode)||!hash(f.sha256))fail("BAD_ARTIFACT","文件模式或摘要无效");objectId(f.blob_oid,format);total+=f.size;}
  else fail("BAD_ARTIFACT","文件操作无效");
 }
 if(total>MAX_CAPTURE_BYTES||Buffer.byteLength(canonical(m))>256*1024)fail("BAD_ARTIFACT","交付清单或实际内容超限");return format;
}
/** Rebuild Git's canonical tree identities without invoking a checkout or interpreting file contents. */
export function treeFromFiles(files,format){
 const root=new Map(),prefixes=new Map();
 if(files.length>4096)fail("WORKSPACE_CONTENT_LIMIT","完整交付目录超过 4096 文件");
 for(const f of files){
  artifactPath(f.path);objectId(f.blob_oid,format);if(!["100644","100755"].includes(f.mode))fail("BAD_ARTIFACT","不接受链接或子模块");
  const parts=f.path.split("/");let current=root,prefix="";
  for(let i=0;i<parts.length;i++){
   prefix+=(i?"/":"")+parts[i];const last=i===parts.length-1,key=prefix.toUpperCase(),prior=prefixes.get(key);
   if(prior&&(prior.path!==prefix||prior.file!==last||last))fail("PATH_COLLISION","完整交付目录存在路径冲突");prefixes.set(key,{path:prefix,file:last});
   if(last)current.set(parts[i],{mode:f.mode,oid:f.blob_oid});else{if(!current.has(parts[i]))current.set(parts[i],new Map());current=current.get(parts[i]);}
  }
 }
 function tree(entries){
  const sorted=[...entries].sort(([a,av],[b,bv])=>Buffer.compare(Buffer.from(a+(av instanceof Map?"/":"")),Buffer.from(b+(bv instanceof Map?"/":""))));
  const parts=sorted.map(([name,value])=>{const dir=value instanceof Map,mode=dir?"40000":value.mode,oid=dir?tree(value):value.oid;return Buffer.concat([Buffer.from(mode+" "+name+"\0"),Buffer.from(oid,"hex")]);});
  return gitObjectHash("tree",Buffer.concat(parts),format);
 }
 return tree(root);
}
export function encodeGitPackage({manifest,manifest_digest,files,commitBytes}){
 validateDeliveryManifest(manifest);if(digest(manifest)!==manifest_digest)fail("BAD_ARTIFACT","清单摘要不一致");
 const bytes=Buffer.from(canonical({format:"ai-fleet-git-package/v1",manifest,manifest_digest,commit_bytes:Buffer.from(commitBytes).toString("base64"),files:files.map(f=>({path:f.path,content:Buffer.from(f.bytes).toString("base64")}))}));
 if(bytes.length>MAX_PACKAGE_BYTES)fail("ARTIFACT_LIMIT","交付包超过 48 MiB");return bytes;
}
/** The caller obtained a full approved baseline under an explicit local read grant. */
export function verifyGitPackage(bytes,{manifest,manifestDigest,baseline,allowedPaths}){
 const format=validateDeliveryManifest(manifest);if(digest(manifest)!==manifestDigest||bytes.length>MAX_PACKAGE_BYTES)fail("BAD_ARTIFACT","清单或包长度无效");
 let value;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{fail("BAD_ARTIFACT","产物不是有效 UTF-8 JSON");}
 exact(value,["format","manifest","manifest_digest","commit_bytes","files"]);
 if(value.format!=="ai-fleet-git-package/v1"||value.manifest_digest!==manifestDigest||canonical(value.manifest)!==canonical(manifest))fail("ARTIFACT_MISMATCH","产物包与固定清单不同");
 const raw=base64Bytes(value.commit_bytes,1024*1024);if(gitObjectHash("commit",raw,format)!==manifest.commit)fail("OBJECT_CORRUPT","原始提交字节摘要不一致");
 const end=raw.indexOf(Buffer.from("\n\n"));if(end<0)fail("OBJECT_CORRUPT","提交头不完整");const lines=raw.subarray(0,end).toString("latin1").split("\n"),parents=lines.filter(s=>s.startsWith("parent "));
 if(lines[0]!=="tree "+manifest.tree||canonical(parents)!==canonical(["parent "+manifest.base_commit])||lines.filter(s=>s.startsWith("tree ")).length!==1)fail("OBJECT_CORRUPT","提交未绑定精确原始基线与树");
 if(baseline.commit!==manifest.base_commit||baseline.object_format!==format||treeFromFiles(baseline.files,format)!==baseline.tree)fail("BASE_MISMATCH","接收端基线不匹配");
 const files=new Map(baseline.files.map(f=>[f.path,f])),writes=manifest.files.filter(f=>f.operation==="write"),actual=[];
 if(!Array.isArray(value.files)||value.files.length!==writes.length)fail("ARTIFACT_MISMATCH","实际文件集合不匹配");
 for(const f of manifest.files){
  if(!allowedPaths.some(p=>p.endsWith("/")?f.path.startsWith(p):f.path===p))fail("PATH_NOT_ALLOWED","交付变化超出接收端允许范围");
  const old=files.get(f.path);if((old?.sha256??null)!==f.base_sha256)fail("BASE_MISMATCH","变化文件的原始字节摘要不匹配");
  if(f.operation==="delete")files.delete(f.path);
  else{
   const candidates=value.files.filter(x=>x?.path===f.path);if(candidates.length!==1)fail("ARTIFACT_MISMATCH","实际文件重复或缺失");const entry=candidates[0];exact(entry,["path","content"]);const content=base64Bytes(entry.content,MAX_FILE_BYTES);
   if(content.length!==f.size||contentHash(content)!==f.sha256||gitObjectHash("blob",content,format)!==f.blob_oid)fail("OBJECT_CORRUPT","实际文件长度或内容地址不匹配");
   if(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(content.subarray(0,80).toString("utf8")))fail("LFS_CONTENT_REQUIRED","LFS 指针不能当作文件内容");
   if(old&&old.sha256===f.sha256&&old.mode===f.mode)fail("ARTIFACT_MISMATCH","交付包含非净变化");
   files.set(f.path,{path:f.path,mode:f.mode,blob_oid:f.blob_oid,size:f.size,sha256:f.sha256});actual.push({path:f.path,bytes:content});
  }
 }
 const all=[...files.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),tree=treeFromFiles(all,format),full={object_format:format,commit:manifest.commit,tree,total_bytes:all.reduce((n,f)=>n+f.size,0),files:all};
 if(tree!==manifest.tree||digest(full)!==manifest.content_snapshot_digest||full.total_bytes>256*1024*1024)fail("OBJECT_CORRUPT","完整目录或内容清单不匹配");
 return {manifest,manifest_digest:manifestDigest,files:actual,commit_bytes:raw,content_verified:true,accepted:false};
}
