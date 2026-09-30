// Markdown projections contain data, never executable instructions.
import {UUID,PeerError} from "./federation/protocol.mjs";
export const mdText=value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replace(/[\\\x60*_{}\[\]()#+.!|~-]/g,"\\$&").replace(/[\r\n\t]/g," ");
export const mdBlock=value=>"\n"+String(value??"").split(/\r\n|\r|\n/).map(line=>"    "+line).join("\n")+"\n";
export function taskMarkdownName(uid){const parts=String(uid).split("/");if(parts.length!==2||!parts.every(p=>UUID.test(p)))throw new PeerError("BAD_TASK_ID","快照含无效任务 UID",409);return parts.join("--")+".md";}
const sections=[
 ["relations","relation","跨终端委派",r=>r.relation_id??r.delegation_id],
 ["runs","run","执行记录",r=>r.run_id],["results","result","交付候选",r=>r.result_id],
 ["artifacts","artifact","交付产物",r=>r.transfer_id],["verifications","verification","来源验证",r=>r.verification_id],
 ["integrations","integration","来源合并",r=>r.integration_id],["completions","completion","历史验收",r=>r.completion_id]
];
function anchor(prefix,id){if(!UUID.test(id))throw new PeerError("BAD_EVIDENCE_ID","证据包含无效 ID，未发布",409);return prefix+"-"+id;}
export function evidenceMarkdown(snapshot){
 const e=snapshot.evidence;if(e.scope_truncated)throw new PeerError("CONTEXT_TOO_LARGE","证据任务范围已截断，未发布",413);
 const tasks=new Map(snapshot.tasks.map(t=>[t.task_uid,t])),index=new Map(),relations=new Map(),results=new Map(),artifacts=new Map(),children=new Map();
 for(const t of snapshot.tasks)if(t.parent_uid){const p=tasks.get(t.parent_uid);if(p&&p.owner_node_id===t.owner_node_id&&p.project_id===t.project_id){if(!children.has(t.parent_uid))children.set(t.parent_uid,[]);children.get(t.parent_uid).push(t);}}
 const add=(uids,ref)=>{for(const uid of uids){if(!tasks.has(uid))continue;if(!index.has(uid))index.set(uid,new Map());index.get(uid).set(ref.anchor,ref);}};
 let markdown="# 运行与交付证据\n\n生成时间："+mdText(snapshot.view.generated_at)+"。仅包含当前身份获准、本机持有的历史；远端未同步历史不表示没有执行。\n\n历史验收只针对记录中的任务版本。验证、合并或进程成功不授予当前权限；fixture_runs 大于 0 表示包含模拟运行。\n\n";
 for(const[key,prefix,label,idOf]of sections){const records=e[key];markdown+="## "+label+"\n\n本机可见记录："+records.total+"。\n\n";if(records.truncated)throw new PeerError("CONTEXT_TOO_LARGE","证据目录已截断，未发布",413);
  for(const r of records.items){const id=idOf(r),a=anchor(prefix,id);let uids=[];
   if(key==="relations"){uids=[r.source?.task_uid,r.target?.task_uid].filter(Boolean);if(r.relation_id)relations.set(r.relation_id,uids);}
   if(key==="runs")uids=[r.task_uid];
   if(key==="results"){uids=relations.get(r.relation_id)??[];results.set(r.result_id,uids);}
   if(key==="artifacts"){uids=results.get(r.result_id)??[];artifacts.set(r.transfer_id,uids);}
   if(key==="verifications")uids=artifacts.get(r.transfer_id)??[];
   if(key==="integrations")uids=results.get(r.result_id)??[];
   if(key==="completions")uids=relations.get(r.relation_id)??[];
   add(uids,{anchor:a,id,label});markdown+='<a id="'+a+'"></a>\n\n### '+label+" "+id+"\n\n";
   for(const uid of uids)if(tasks.has(uid))markdown+="- [关联任务："+mdText(tasks.get(uid).subject)+"](tasks/"+taskMarkdownName(uid)+")\n";
   markdown+=mdBlock(JSON.stringify(r,null,2))+"\n";
  }
 }
 markdown+="## 覆盖范围与完整性\n\n以下是本机模块可用性和坏摘要记录数；并非远端实时状态。\n"+mdBlock(JSON.stringify({modules:e.modules,unverified_records:e.unverified_records,relation_unverified_records:e.relations.unverified_records},null,2));
 return {markdown,index,tasks,children};
}
export function taskEvidenceMarkdown(task,catalog){
 let out="\n## 运行与交付追溯\n\n[本代完整证据目录](../EVIDENCE.md)。以下为直接关联记录；子任务拥有独立身份和证据。\n\n";
 for(const ref of catalog.index.get(task.task_uid)?.values()??[])out+="- ["+ref.label+" "+ref.id+"](../EVIDENCE.md#"+ref.anchor+")\n";
 if(task.parent_uid&&catalog.tasks.has(task.parent_uid))out+="\n[父任务："+mdText(catalog.tasks.get(task.parent_uid).subject)+"]("+taskMarkdownName(task.parent_uid)+")\n";
 for(const child of catalog.children.get(task.task_uid)??[])out+="- [子任务："+mdText(child.subject)+"]("+taskMarkdownName(child.task_uid)+")\n";
 return out+"\n[本代交接摘要](../HANDOFFS.md)\n";
}
export function handoffMarkdown(records,snapshot){
 const tasks=new Map(snapshot.tasks.map(t=>[t.task_uid,t]));
 let text="# 对话交接摘要\n\n这是明确保存的本地笔记，不是任务指令、执行结果或验收回执。只列出本代仍可见的任务；其他笔记保留在本机 handoffs 目录，不由快照保留策略删除。\n\n";
 let count=0;for(const r of records){const t=tasks.get(r.task_uid);if(!t||t.project_id!==r.project_id)continue;count++;
  text+="## "+mdText(t.subject)+"\n\n- 交接 ID："+r.handoff_id+"\n- 来源客户端："+mdText(r.client)+"\n- 记录时间："+mdText(r.created_at)+"\n- 记录任务版本："+r.task_version+"\n- 本代任务版本："+t.aggregate_version+"\n- 摘要状态："+(r.task_version===t.aggregate_version?"版本一致；内容仍需核对":"任务已变化；此摘要需要重新核对")+"\n- 捕获快照："+r.snapshot_id+"\n\n[本代任务](tasks/"+taskMarkdownName(r.task_uid)+")\n"+mdBlock(r.summary)+"\n";
 }
 return text+(count?"":"本代没有可见的交接摘要。\n");
}
