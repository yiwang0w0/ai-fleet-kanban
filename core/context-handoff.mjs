// Explicit, immutable local handoff notes. The caller holds .publish.lock.
import {existsSync,lstatSync,readFileSync,readdirSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from "node:fs";
import {join,isAbsolute,basename,dirname,extname} from "node:path";
import {TextDecoder} from "node:util";
import {UUID,PeerError} from "./federation/protocol.mjs";
import {canonical,digest} from "./federation/sync-store.mjs";
import {checkDirectoryPath} from "./private-directory.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const MAX_NOTES=1024,MAX_SUMMARY=64*1024,HEX=/^[0-9a-f]{64}$/;
function ordinary(path,max){const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()||s.size>max)fail("HANDOFF_CHANGED","交接文件须为有界普通文件");return readFileSync(path);}
export function readHandoffSummary(path){
 if(typeof path!=="string"||!isAbsolute(path)||![".md",".txt"].includes(extname(path).toLowerCase())||basename(path).includes(":"))fail("BAD_INPUT","摘要文件须为本机 .md 或 .txt 绝对路径");
 checkDirectoryPath(dirname(path));let text;try{text=new TextDecoder("utf-8",{fatal:true}).decode(ordinary(path,MAX_SUMMARY));}catch(e){if(e instanceof PeerError)throw e;fail("BAD_INPUT","摘要必须为 UTF-8 文本");}
 return text;
}
export function handoffRequest({handoffId,taskUid,expectedVersion,client,summary}){
 if(!UUID.test(handoffId)||typeof taskUid!=="string"||taskUid.split("/").length!==2||!taskUid.split("/").every(p=>UUID.test(p))||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||typeof client!=="string"||!client.trim()||client.length>128||/[\u0000-\u001f]/.test(client)||typeof summary!=="string"||!summary.trim()||summary.includes("\0")||Buffer.byteLength(summary)>MAX_SUMMARY)fail("BAD_INPUT","交接需要 UUID、任务 UID/版本、来源客户端和不超过 64 KiB 的明确摘要");
 return {handoff_id:handoffId,task_uid:taskUid,task_version:expectedVersion,client,summary};
}
function directory(root){const dir=join(root,"handoffs");checkDirectoryPath(dir);if(!existsSync(dir))mkdirSync(dir);return dir;}
function record(path,bindingDigest,binding){
 let wrapped;try{wrapped=JSON.parse(ordinary(path,512*1024));}catch(e){if(e instanceof PeerError)throw e;fail("HANDOFF_CHANGED","交接文件未完整写入或格式已变化");}
 const r=wrapped?.record,fields=["format","handoff_id","binding_digest","request_digest","task_uid","task_version","project_id","client","summary","created_at","snapshot_id","evidence_digest"];
 if(!wrapped||Object.keys(wrapped).length!==2||!Object.hasOwn(wrapped,"sha256")||!r||typeof r!=="object"||Object.keys(r).length!==fields.length||fields.some(k=>!Object.hasOwn(r,k))||wrapped.sha256!==digest(r)||r.format!=="ai-fleet-handoff/v1"||r.binding_digest!==bindingDigest||!binding.projects.includes(r.project_id)||![r.request_digest,r.snapshot_id,r.evidence_digest].every(v=>HEX.test(v))||!Number.isFinite(Date.parse(r.created_at)))fail("HANDOFF_CHANGED","交接摘要、身份绑定或字段校验失败");
 const request=handoffRequest({handoffId:r.handoff_id,taskUid:r.task_uid,expectedVersion:r.task_version,client:r.client,summary:r.summary});
 if(digest(request)!==r.request_digest)fail("HANDOFF_CHANGED","交接请求摘要变化");return r;
}
export function readHandoffs(root,bindingDigest,binding){
 const dir=join(root,"handoffs");if(!existsSync(dir))return [];checkDirectoryPath(dir);const names=readdirSync(dir);if(names.length>MAX_NOTES)fail("HANDOFF_LIMIT","交接摘要达到 1,024 条，请先单独归档");
 const result=[];for(const name of names){const match=/^([0-9a-f-]{36})\.json$/.exec(name);if(!match||!UUID.test(match[1]))fail("HANDOFF_PENDING","交接目录存在未知或未完成文件；旧快照保留，请用原交接 ID 恢复或人工核对");const r=record(join(dir,name),bindingDigest,binding);if(r.handoff_id!==match[1])fail("HANDOFF_CHANGED","交接文件与 ID 不符");result.push(r);}
 return result.sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.handoff_id.localeCompare(b.handoff_id));
}
export function saveHandoffRecord(root,snapshot,bindingDigest,input){
 const request=handoffRequest(input),dir=directory(root),path=join(dir,request.handoff_id+".json"),pending=join(dir,"."+request.handoff_id+".tmp"),requestDigest=digest(request);
 const same=r=>{if(r.request_digest!==requestDigest)fail("HANDOFF_CONFLICT","该交接 ID 已用于不同内容，未覆盖原记录");return r;};
 function publish(){linkSync(pending,path);unlinkSync(pending);}
 if(existsSync(path)){const r=same(record(path,bindingDigest,snapshot.binding));if(existsSync(pending)){same(record(pending,bindingDigest,snapshot.binding));const a=lstatSync(path),b=lstatSync(pending);if(a.ino!==b.ino||a.dev!==b.dev)fail("HANDOFF_CONFLICT","交接临时文件与已保存文件不是同一次发布，未删除");unlinkSync(pending);}return {status:"already_saved",record:r};}
 if(existsSync(pending)){const r=same(record(pending,bindingDigest,snapshot.binding));publish();return {status:"saved",record:r};}
 readHandoffs(root,bindingDigest,snapshot.binding);
 if(readdirSync(dir).length>=MAX_NOTES)fail("HANDOFF_LIMIT","交接摘要达到 1,024 条，请先单独归档");
 const task=snapshot.tasks.find(t=>t.task_uid===request.task_uid);if(!task)fail("NOT_FOUND","当前授权活动快照中未找到该任务");
 if(task.aggregate_version!==request.task_version)fail("STALE_TASK","任务版本已变化，请核对当前上下文后重新保存");
 const r={format:"ai-fleet-handoff/v1",...request,binding_digest:bindingDigest,request_digest:requestDigest,project_id:task.project_id,created_at:new Date().toISOString(),snapshot_id:snapshot.view.snapshot_id,evidence_digest:digest({...snapshot.evidence,generated_at:null})};
 const fd=openSync(pending,"wx",0o600);try{writeFileSync(fd,canonical({record:r,sha256:digest(r)})+"\n","utf8");fsyncSync(fd);}finally{closeSync(fd);}
 publish();return {status:"saved",record:r};
}
