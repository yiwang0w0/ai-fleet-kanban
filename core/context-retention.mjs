// Explicit retention for complete generated snapshots. No recursive deletion.
import {existsSync,lstatSync,realpathSync,readFileSync,readdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync,rmdirSync,renameSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PeerError,UUID} from './federation/protocol.mjs';
import {checkDirectoryPath} from './private-directory.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const HEX=/^[0-9a-f]{64}$/;
const fail=(code,text)=>{throw new PeerError(code,text,409);};
export function retentionPolicy(value=null){
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['keep','minAgeMinutes'].includes(k))||!Number.isInteger(value.keep)||value.keep<2||value.keep>200||!Number.isInteger(value.minAgeMinutes)||value.minAgeMinutes<1||value.minAgeMinutes>10080)fail('BAD_INPUT','保留策略需要 2–200 代和 1–10080 分钟最短保留期');
 return {keep:value.keep,minAgeMinutes:value.minAgeMinutes};
}
function ordinary(path,max=32*1024*1024){const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()||s.size>max)fail('CONTEXT_CHANGED','保留候选含链接、非普通文件或超限内容');return readFileSync(path);}
function generationPath(root,id){
 if(!UUID.test(id))fail('CONTEXT_CHANGED','保留候选代号无效');
 const base=resolve(root,'snapshots',id),rel=relative(resolve(root),base);
 if(rel!==join('snapshots',id))fail('UNSAFE_CONTEXT_ROOT','保留候选超出上下文目录');
 for(const path of [root,join(root,'snapshots'),base])if(existsSync(path)){const s=lstatSync(path);if(s.isSymbolicLink()||!s.isDirectory())fail('UNSAFE_CONTEXT_ROOT','保留路径含链接或非目录');if(realpathSync(path).toLowerCase()!==resolve(path).toLowerCase())fail('UNSAFE_CONTEXT_ROOT','保留路径真实位置不符');}
 return base;
}
function validPath(path){if(path==='BOARD.md'||path==='PROJECTS.md'||path==='manifest.json')return true;const m=/^tasks\/([0-9a-f-]+)--([0-9a-f-]+)\.md$/.exec(path);return Boolean(m&&UUID.test(m[1])&&UUID.test(m[2]));}
function fileRecords(files){
 if(!Array.isArray(files)||files.length<3||files.length>10003)fail('CONTEXT_CHANGED','保留文件清单无效');
 const paths=new Set();for(const f of files){if(!f||!validPath(f.path)||paths.has(f.path)||!HEX.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>32*1024*1024)fail('CONTEXT_CHANGED','保留文件摘要或路径无效');paths.add(f.path);}
 for(const p of ['BOARD.md','PROJECTS.md','manifest.json'])if(!paths.has(p))fail('CONTEXT_CHANGED','保留清单缺少必要文件');
 return paths;
}
function inventory(base,files,{partial=false}={}){
 const allowed=fileRecords(files);if(!existsSync(base)){if(partial)return;fail('CONTEXT_CHANGED','保留候选目录缺失');}
 for(const name of readdirSync(base)){const path=join(base,name),s=lstatSync(path);if(s.isSymbolicLink())fail('UNSAFE_CONTEXT_ROOT','保留候选含链接');if(name==='tasks'&&s.isDirectory()){for(const task of readdirSync(path)){const f=join(path,task),st=lstatSync(f);if(st.isSymbolicLink()||!st.isFile()||!allowed.has('tasks/'+task))fail('CONTEXT_CHANGED','保留候选含未登记内容');}}else if(!s.isFile()||!allowed.has(name))fail('CONTEXT_CHANGED','保留候选含未登记内容');}
 for(const f of files){const path=join(base,f.path);if(!existsSync(path)){if(partial)continue;fail('CONTEXT_CHANGED','保留候选文件缺失');}const bytes=ordinary(path);if(bytes.length!==f.bytes||sha(bytes)!==f.sha256)fail('CONTEXT_CHANGED','保留候选文件被修改');}
}
function candidate(root,id,bindingDigest){
 const base=generationPath(root,id),path=join(base,'manifest.json');if(!existsSync(path))return null;
 const raw=ordinary(path),m=JSON.parse(raw);if(m.format!=='ai-fleet-context-manifest/v1'||m.generation!==id||m.binding_digest!==bindingDigest||typeof m.generated_at!=='string'||!Number.isFinite(Date.parse(m.generated_at))||new Date(m.generated_at).toISOString()!==m.generated_at)fail('CONTEXT_CHANGED','保留候选清单或权限绑定不符');
 if(!Array.isArray(m.files)||m.files.some(f=>f?.path==='manifest.json'))fail('CONTEXT_CHANGED','保留候选文件清单无效');
 const files=[...m.files,{path:'manifest.json',bytes:raw.length,sha256:sha(raw)}];fileRecords(files);
 return {generation:id,generated_at:m.generated_at,manifest_sha256:sha(raw),files};
}
function currentGeneration(root){const text=ordinary(join(root,'ENTRY.md'),16384).toString('utf8'),m=text.match(/^<!-- ai-fleet-context\/v1 ([0-9a-f-]{36}) ([0-9a-f]{64}) -->\n/);if(!m||!UUID.test(m[1]))fail('CONTEXT_CHANGED','当前入口无效');const raw=ordinary(join(generationPath(root,m[1]),'manifest.json'));if(sha(raw)!==m[2])fail('CONTEXT_CHANGED','当前入口摘要不符');return m[1];}
function readIntent(path,bindingDigest,policy){
 const j=JSON.parse(ordinary(path,4*1024*1024));if(j.format!=='ai-fleet-context-prune/v1'||j.binding_digest!==bindingDigest||JSON.stringify(retentionPolicy(j.policy))!==JSON.stringify(policy)||!UUID.test(j.generation)||!Number.isFinite(Date.parse(j.selected_at))||!Number.isFinite(Date.parse(j.generated_at))||!Number.isFinite(Date.parse(j.noncurrent_since))||Date.parse(j.selected_at)-Date.parse(j.noncurrent_since)<policy.minAgeMinutes*60000)fail('CONTEXT_RETENTION_CHANGED','未完成清理与当前身份或保留策略不符');fileRecords(j.files);return j;
}
function removeRecorded(root,j){
 if(currentGeneration(root)===j.generation)fail('CONTEXT_CHANGED','不能清理当前入口代');const base=generationPath(root,j.generation);inventory(base,j.files,{partial:true});let bytes=0;
 // Recheck every named file, never traverse an unlisted path or follow a link.
 for(const f of j.files){generationPath(root,j.generation);const path=join(base,f.path);if(!existsSync(path))continue;const b=ordinary(path);if(b.length!==f.bytes||sha(b)!==f.sha256)fail('CONTEXT_CHANGED','清理前内容发生变化');unlinkSync(path);bytes+=b.length;}
 if(existsSync(join(base,'tasks')))rmdirSync(join(base,'tasks'));if(existsSync(base))rmdirSync(base);return bytes;
}
function readRetired(root,bindingDigest){
 const path=join(root,'.retention.json');if(!existsSync(path))return new Map();const state=JSON.parse(ordinary(path,1024*1024));if(state.format!=='ai-fleet-context-retention/v1'||state.binding_digest!==bindingDigest||!Array.isArray(state.generations)||state.generations.length>256)fail('CONTEXT_CHANGED','保留观察记录无效');const result=new Map();
 for(const g of state.generations){if(!g||!UUID.test(g.generation)||!HEX.test(g.manifest_sha256)||!Number.isFinite(Date.parse(g.noncurrent_since))||result.has(g.generation))fail('CONTEXT_CHANGED','保留观察记录无效');result.set(g.generation,g);}return result;
}
function saveRetired(root,bindingDigest,items){
 const path=join(root,'.retention.json'),raw=JSON.stringify({format:'ai-fleet-context-retention/v1',binding_digest:bindingDigest,generations:[...items.values()].sort((a,b)=>a.generation.localeCompare(b.generation))})+'\n';if(existsSync(path)&&ordinary(path,1024*1024).toString('utf8')===raw)return;
 const next=join(root,'.retention-'+randomUUID()+'.tmp'),fd=openSync(next,'wx',0o600);try{writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}renameSync(next,path);
}
export function pruneDesktopGenerations(root,{bindingDigest,policy}){
 policy=retentionPolicy(policy);if(!policy)return {enabled:false,completed_generations:0,removed_bytes:0};root=realpathSync(checkDirectoryPath(root));
 if(sha(ordinary(join(root,'ROOT.json'),16384))!==bindingDigest)fail('CONTEXT_SCOPE_CHANGED','保留目录权限绑定改变');
 const generations=join(root,'snapshots'),journal=join(root,'.prune.json'),result={enabled:true,policy,completed_generations:0,removed_bytes:0,resumed:false};
 if(existsSync(journal)){const j=readIntent(journal,bindingDigest,policy);result.removed_bytes+=removeRecorded(root,j);unlinkSync(journal);result.completed_generations++;result.resumed=true;}
 if(!existsSync(generations)||!existsSync(join(root,'ENTRY.md')))return result;
 const current=currentGeneration(root),items=[],observed=readRetired(root,bindingDigest),retired=new Map(),selectedAt=new Date().toISOString();
 for(const id of readdirSync(generations)){if(!UUID.test(id))fail('CONTEXT_CHANGED','快照目录含未知条目');const c=candidate(root,id,bindingDigest);if(c){items.push(c);if(id!==current){const old=observed.get(id);if(old&&old.manifest_sha256!==c.manifest_sha256)fail('CONTEXT_CHANGED','已记录快照清单被修改');retired.set(id,old??{generation:id,manifest_sha256:c.manifest_sha256,noncurrent_since:selectedAt});}}}
 items.sort((a,b)=>Date.parse(b.generated_at)-Date.parse(a.generated_at)||a.generation.localeCompare(b.generation));
 saveRetired(root,bindingDigest,retired);
 const selected=items.slice(policy.keep).filter(c=>c.generation!==current&&Date.parse(selectedAt)-Date.parse(retired.get(c.generation).noncurrent_since)>=policy.minAgeMinutes*60000).map(c=>({...c,noncurrent_since:retired.get(c.generation).noncurrent_since}));
 // Validate the full candidate set before removing any generation.
 for(const c of selected)inventory(generationPath(root,c.generation),c.files);
 for(const c of selected){const intent={format:'ai-fleet-context-prune/v1',binding_digest:bindingDigest,policy,selected_at:selectedAt,...c},pending=join(root,'.prune-'+randomUUID()+'.tmp'),fd=openSync(pending,'wx',0o600);try{writeFileSync(fd,JSON.stringify(intent)+'\n');fsyncSync(fd);}finally{closeSync(fd);}if(existsSync(journal))fail('CONTEXT_BUSY','清理意图已存在');renameSync(pending,journal);result.removed_bytes+=removeRecorded(root,intent);unlinkSync(journal);result.completed_generations++;retired.delete(c.generation);}
 saveRetired(root,bindingDigest,retired);
 result.remaining_generations=readdirSync(generations).length;return result;
}
