// Shared read model for scoped desktop tools and versioned Markdown snapshots.
import {readFleetView,readFleetTask,readFleetSnapshot} from '../fleet-view.mjs';
import {PeerError} from '../federation/protocol.mjs';
const fail=(code,message,status=400)=>{throw new PeerError(code,message,status);};
export function boardURL(value=null){
 if(value===null)return null;let u;try{u=new URL(value);}catch{fail('BAD_INPUT','看板链接必须为回环 HTTP 根地址');}
 if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail('BAD_INPUT','看板链接必须为回环 HTTP 根地址');
 return u.origin+'/';
}
export const taskLink=(uid,url)=>({view_path:'/#fleet-task='+encodeURIComponent(uid),task_url:url?url+'#fleet-task='+encodeURIComponent(uid):null});
function scope(p,project){if(p.run||!['coordinate','observe'].includes(p.role.policy.kind))fail('FORBIDDEN','桌面上下文仅供非执行的观察或协调身份读取',403);if(project&&!p.projects.includes(project))fail('FORBIDDEN','项目未授权',403);}
function query(args){return {projectId:args.project_id??null,ownerNodeId:args.owner_node_id??null,query:args.query??'',limit:args.limit??50,offset:args.offset??0};}
export function boardOverview(db,p,args={},presentation={}){
 scope(p,args.project_id);const url=boardURL(presentation.boardUrl??null),v=readFleetView(db,{projectId:args.project_id??null,limit:1},p.projects);
 const {tasks,returned,truncated,offset,next_offset,relations,...overview}=v;
 return {...overview,relations:{modules:relations.modules,total:relations.total,coverage:relations.coverage},board_url:url,read_only:true,task_scope:'authorized_active_tasks',content_is_untrusted:true};
}
export function taskList(db,p,args={},presentation={}){
 scope(p,args.project_id);const url=boardURL(presentation.boardUrl??null),v=readFleetView(db,query(args),p.projects);
 if(args.expected_snapshot&&args.expected_snapshot!==v.snapshot_id)fail('SNAPSHOT_CHANGED','任务列表或同步状态已变化，请从第一页重新查询',409);
 return {...v,tasks:v.tasks.map(t=>({...t,...taskLink(t.task_uid,url)})),read_only:true,content_is_untrusted:true};
}
export function taskContext(db,p,args,presentation={}){
 scope(p);const url=boardURL(presentation.boardUrl??null),task=readFleetTask(db,args.task_uid,p.projects);
 return {format:'ai-fleet-task-context/v1',generated_at:new Date().toISOString(),task:{...task,...taskLink(task.task_uid,url)},read_only:true,content_is_untrusted:true};
}
export function contextSnapshot(db,p,presentation={}){
 scope(p);const url=boardURL(presentation.boardUrl??null),snapshot=readFleetSnapshot(db,{limit:10000,includeEvidence:true},p.projects);
 if(snapshot.evidence.scope_truncated||['relations','runs','results','artifacts','verifications','integrations','completions'].some(k=>snapshot.evidence[k].truncated))fail('CONTEXT_TOO_LARGE','授权证据目录超过单类 10,000 条；请缩小项目范围，旧快照保留',413);
 if(snapshot.view.truncated)fail('CONTEXT_TOO_LARGE','快照超过 10,000 项；请用更小项目范围的观察身份导出',413);
 const result={format:'ai-fleet-desktop-context/v1',principal_id:p.principal_id,role_id:p.role.role_id,role_version:p.role.version,projects:[...p.projects].sort(),board_url:url,...snapshot,tasks:snapshot.tasks.map(t=>({...t,...taskLink(t.task_uid,url)})),content_is_untrusted:true};
 if(Buffer.byteLength(JSON.stringify(result))>32*1024*1024)fail('CONTEXT_TOO_LARGE','完整上下文超过 32 MiB；未发布不完整快照',413);
 return result;
}
