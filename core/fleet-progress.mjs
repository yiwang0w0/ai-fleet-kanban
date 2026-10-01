// Read-only projection of administrator-enrolled plans and external review records.
// This module never signs, accepts, imports or changes a task or a gate.
import {openSync,closeSync,fstatSync,readSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {PeerError} from './federation/protocol.mjs';
import {digest} from './federation/sync-store.mjs';
const fail=(message,code='PROGRESS_INVALID')=>{throw new PeerError(code,message,409);};
const hash=b=>createHash('sha256').update(b).digest('hex');
const text=(v,max=4096)=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max;
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
function fields(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('进度配置或回执字段无效');}
function list(v,max=10000){if(!Array.isArray(v)||v.length>max)fail('进度记录数量无效');return v;}
function ids(v,max=10000){list(v,max);if(v.some(x=>!id(x))||new Set(v).size!==v.length)fail('进度标识无效或重复');return v;}
function reader(){
 const cache=new Map();let bytes=0;
 return (path,limit=2*1024*1024)=>{
  if(!isAbsolute(path??''))fail('进度文件必须由管理者配置绝对路径');
  if(cache.has(path)){const b=cache.get(path);if(b.length>limit)fail('进度文件过大');return b;}
  let fd;try{fd=openSync(path,'r');const a=fstatSync(fd);if(!a.isFile()||a.size>limit||bytes+a.size>16*1024*1024)fail('进度文件过大或不是普通文件');const buffer=Buffer.alloc(a.size+1);let n=0,count;while(n<buffer.length&&(count=readSync(fd,buffer,n,buffer.length-n,null))>0)n+=count;const b=buffer.subarray(0,n),z=fstatSync(fd);if(a.size!==z.size||a.mtimeMs!==z.mtimeMs||b.length!==a.size)fail('进度文件正在变化，请刷新');bytes+=b.length;cache.set(path,b);return b;}catch(e){if(e instanceof PeerError)throw e;fail('已配置进度文件不可读','PROGRESS_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
 };
}
function json(read,path,limit){try{return JSON.parse(read(path,limit).toString('utf8').replace(/^\ufeff/,''));}catch(e){if(e instanceof PeerError)throw e;fail('进度文件不是有效 JSON');}}
function manifest(value){
 if(value?.artifact_type!=='planning_manifest'||!id(value.plan_id)||!text(value.plan_version,80))fail('计划清单格式无效');
 const phases=list(value.phases,100),tasks=list(value.tasks),pm=new Map(),tm=new Map(),gates=new Map();if(!phases.length||!tasks.length)fail('计划不能为空');
 for(const p of phases){if(!id(p.id)||!id(p.gate_id)||!text(p.title)||pm.has(p.id)||gates.has(p.gate_id)||typeof p.operator_confirmation_required!=='boolean')fail('阶段定义无效');ids(p.depends_on,100);ids(p.task_ids);pm.set(p.id,p);gates.set(p.gate_id,p.id);}
 for(const t of tasks){if(!id(t.id)||!pm.has(t.phase_id)||!text(t.subject)||tm.has(t.id)||!id(t.lead_role)||!['planned','ready','in_progress','verifying','implemented_pending_acceptance','accepted','blocked'].includes(t.status))fail('计划任务定义无效');ids(t.depends_on);ids(t.requires_gates,100);for(const k of ['acceptance_criteria','evidence_required'])if(!list(t[k],100).length||t[k].some(x=>!text(x)))fail('任务验收合同无效');tm.set(t.id,t);}
 const included=new Set();for(const p of phases){if(!p.task_ids.length||p.depends_on.some(x=>!pm.has(x)||x===p.id))fail('阶段依赖无效');for(const tid of p.task_ids){if(!tm.has(tid)||tm.get(tid).phase_id!==p.id||included.has(tid))fail('阶段任务不完整或重复');included.add(tid);}}
 if(included.size!==tasks.length)fail('存在未归入阶段的任务');
 for(const t of tasks)if(t.depends_on.some(x=>!tm.has(x)||x===t.id)||t.requires_gates.some(x=>!gates.has(x)))fail('任务依赖无效');
 const visited=new Set(),visiting=new Set();function walk(t){if(visiting.has(t.id))fail('任务依赖存在循环');if(visited.has(t.id))return;visiting.add(t.id);for(const d of t.depends_on)walk(tm.get(d));visiting.delete(t.id);visited.add(t.id);}tasks.forEach(walk);
 return {value,phases,tasks,pm,tm,gates};
}
function policy(raw,m,read){
 fields(raw,['phase_id','required_roles','implementer_ids','inputs','receipts']);if(!m.pm.has(raw.phase_id))fail('进度策略引用未知阶段');ids(raw.required_roles,32);ids(raw.implementer_ids,64);if(!raw.required_roles.length||!raw.implementer_ids.length)fail('阶段必须登记确认角色和实现身份');
 const inputs=list(raw.inputs,64).map(x=>{fields(x,['id','path']);if(!id(x.id))fail('验证输入标识无效');return {id:x.id,sha256:hash(read(x.path,4*1024*1024))};});if(!inputs.length||new Set(inputs.map(x=>x.id)).size!==inputs.length)fail('阶段必须登记不同的验证输入');
 const receipts=list(raw.receipts,128);for(const r of receipts){fields(r,['path','sha256','registered_by','registered_at']);if(!sha(r.sha256)||!id(r.registered_by)||!date(r.registered_at))fail('回执登记摘要或来源无效');}
 return {...raw,input_hashes:inputs.sort((a,b)=>a.id.localeCompare(b.id))};
}
function receipt(entry,p,m,contract,read){
 const history={sha256:entry.sha256,registered_by:entry.registered_by,registered_at:entry.registered_at,state:'invalid',reason:null,decision:null,accepted_task_ids:[],confirmations:[]};
 try{
  const bytes=read(entry.path,256*1024);if(hash(bytes)!==entry.sha256)fail('确认文件与管理者登记的摘要不同','RECEIPT_CHANGED');
  const r=JSON.parse(bytes.toString('utf8').replace(/^\ufeff/,''));
  if(r.artifact_type==='phase_gate_receipt_draft'&&r.decision==='pending'&&r.plan_id===m.value.plan_id&&r.phase_id===p.phase_id){history.state='pending';history.decision='pending';history.reason='现有阶段草稿尚未签收';return history;}
  fields(r,['format','plan_id','phase_id','gate_id','contract_sha256','decision','accepted_task_ids','confirmations','evidence_refs','note','verified_at']);
  if(r.format!=='ai-fleet-phase-receipt/v1'||r.plan_id!==m.value.plan_id||r.phase_id!==p.phase_id||r.gate_id!==m.pm.get(p.phase_id).gate_id||!sha(r.contract_sha256)||!['pending','accepted','rejected'].includes(r.decision)||!text(r.note))fail('阶段确认格式无效');
  ids(r.accepted_task_ids);if(r.accepted_task_ids.some(x=>!m.pm.get(p.phase_id).task_ids.includes(x)))fail('回执包含其他阶段任务');
  history.decision=r.decision;history.note=r.note;history.verified_at=date(r.verified_at)?r.verified_at:null;history.contract_sha256=r.contract_sha256;
  if(r.contract_sha256!==contract){history.state='stale';history.reason='合同、依赖、确认策略或登记的验证输入已变化';return history;}
  if(r.decision!=='accepted'){if(r.accepted_task_ids.length)fail('未通过的回执不能声明已验收任务');history.state=r.decision;return history;}
  if(p.implementer_ids.includes(entry.registered_by))fail('实现者不能单独登记通过回执');
  if(!date(r.verified_at)||!list(r.evidence_refs,64).length||r.evidence_refs.some(x=>!text(x)))fail('通过回执缺少证据或确认时间');
  const confirmations=list(r.confirmations,64),roles=new Set(),instances=new Set();
  for(const c of confirmations){fields(c,['role','instance_id','decision','at','reference']);if(!id(c.role)||!id(c.instance_id)||c.decision!=='approve'||!date(c.at)||!text(c.reference)||p.implementer_ids.includes(c.instance_id))fail('确认记录无效或实现者自签');const key=c.role+':'+c.instance_id;if(instances.has(key))fail('确认记录重复');instances.add(key);roles.add(c.role);}
  const required=new Set([...p.required_roles,...(m.pm.get(p.phase_id).operator_confirmation_required?['OP']:[])]);if([...required].some(x=>!roles.has(x)))fail('所需独立角色或操作者确认尚未齐全','CONFIRMATION_REQUIRED');
  history.state='accepted';history.accepted_task_ids=r.accepted_task_ids;history.confirmations=confirmations.map(c=>({...c}));history.evidence_refs=[...r.evidence_refs];return history;
 }catch(e){history.reason=e instanceof PeerError?e.message:'确认文件格式无效';history.code=e instanceof PeerError?e.code:'RECEIPT_INVALID';return history;}
}
function projectPlan(raw,read){
 fields(raw,['project_id','manifest_file','phases']);if(!id(raw.project_id))fail('项目标识无效');const m=manifest(json(read,raw.manifest_file)),policies=new Map();
 for(const x of list(raw.phases,100)){const p=policy(x,m,read);if(policies.has(p.phase_id))fail('阶段进度策略重复');policies.set(p.phase_id,p);}if(policies.size!==m.phases.length)fail('每个阶段必须登记进度策略');
 const contracts=new Map(),deps=new Map(),visiting=new Set();
 for(const p of m.phases){const d=new Set(p.depends_on);for(const tid of p.task_ids){const t=m.tm.get(tid);for(const g of t.requires_gates)d.add(m.gates.get(g));for(const t2 of t.depends_on){const other=m.tm.get(t2).phase_id;if(other!==p.id)d.add(other);}}if(d.has(p.id))fail('阶段不能依赖自身门禁');deps.set(p.id,[...d].sort());}
 function contract(id){if(contracts.has(id))return contracts.get(id);if(visiting.has(id))fail('阶段依赖存在循环');visiting.add(id);const p=m.pm.get(id),v=policies.get(id);const tasks=p.task_ids.map(id=>{const t=m.tm.get(id);return {id:t.id,subject:t.subject,lead_role:t.lead_role,depends_on:[...t.depends_on].sort(),requires_gates:[...t.requires_gates].sort(),acceptance_criteria:t.acceptance_criteria,evidence_required:t.evidence_required};}).sort((a,b)=>a.id.localeCompare(b.id));
  const hash=digest({plan_id:m.value.plan_id,phase:{id,title:p.title,gate_id:p.gate_id,operator_confirmation_required:p.operator_confirmation_required},tasks,requirements:(m.value.confirmed_requirements??[]).filter(r=>r.phases?.includes(id)),decisions:m.value.decisions??[],platform_scope:m.value.platform_scope??null,required_roles:[...v.required_roles].sort(),implementer_ids:[...v.implementer_ids].sort(),inputs:v.input_hashes,dependencies:deps.get(id).map(d=>({phase_id:d,contract_sha256:contract(d)}))});visiting.delete(id);contracts.set(id,hash);return hash;
 }
 for(const p of m.phases)contract(p.id);
 const stages=new Map(),acceptedTasks=new Set();
 function stage(id){if(stages.has(id))return stages.get(id);const p=m.pm.get(id),v=policies.get(id),dependencies=deps.get(id).map(stage),history=v.receipts.map(e=>receipt(e,v,m,contracts.get(id),read)),latest=history.at(-1),blockedBy=dependencies.filter(x=>!x.accepted).map(x=>x.phase_id),candidate=new Set(latest?.state==='accepted'?latest.accepted_task_ids:[]);
  const memo=new Map();function accepted(t){if(memo.has(t.id))return memo.get(t.id);const yes=t.status!=='blocked'&&blockedBy.length===0&&candidate.has(t.id)&&t.depends_on.every(d=>m.tm.get(d).phase_id===id?accepted(m.tm.get(d)):acceptedTasks.has(d));memo.set(t.id,yes);if(yes)acceptedTasks.add(t.id);return yes;}
  const tasks=p.task_ids.map(id=>{const t=m.tm.get(id),ok=accepted(t),blocked=t.status==='blocked';let blocker=null;if(blocked){const b=t.blocker??{};blocker={reason:text(b.reason)?b.reason:'尚未填写阻塞原因',release_condition:text(b.release_condition)?b.release_condition:null,responsible_role:idValue(b.responsible_role),next_review_at:date(b.next_review_at)?b.next_review_at:null};}
   return {id:t.id,subject:t.subject,declared_status:t.status??'planned',state:ok?'accepted':blocked?'blocked':['verifying','implemented_pending_acceptance','accepted'].includes(t.status)||candidate.has(id)?'pending_acceptance':t.status??'planned',accepted:ok,implementation_evidence_count:Array.isArray(t.implementation_evidence)?t.implementation_evidence.length:0,verification_result:text(t.verification_result?.result,100)?t.verification_result.result:null,blocker};});
  const phaseAccepted=latest?.state==='accepted'&&blockedBy.length===0&&tasks.every(t=>t.accepted);const result={phase_id:id,title:p.title,gate_id:p.gate_id,contract_sha256:contracts.get(id),required_roles:[...new Set([...v.required_roles,...(p.operator_confirmation_required?['OP']:[])])],accepted:phaseAccepted,state:phaseAccepted?'accepted':latest?.state==='accepted'?'pending_acceptance':latest?.state??'not_submitted',blocked_by:blockedBy,tasks,history};stages.set(id,result);return result;
 }
 const phases=m.phases.map(p=>stage(p.id)),tasks=phases.flatMap(p=>p.tasks),acceptedPhases=phases.filter(p=>p.accepted).length;
 return {project_id:raw.project_id,plan_id:m.value.plan_id,plan_version:m.value.plan_version,phases,counts:{accepted_tasks:acceptedTasks.size,total_tasks:tasks.length,task_percent:Math.floor(10000*acceptedTasks.size/tasks.length)/100,accepted_phases:acceptedPhases,total_phases:phases.length,phase_percent:Math.floor(10000*acceptedPhases/phases.length)/100,blocked_tasks:tasks.filter(t=>t.state==='blocked').length,pending_acceptance_tasks:tasks.filter(t=>t.state==='pending_acceptance').length,with_implementation_evidence:tasks.filter(t=>t.implementation_evidence_count>0).length,with_verification_records:tasks.filter(t=>t.verification_result!==null).length}};
}
const idValue=v=>id(v)?v:null;
export function readFleetProgress(configFile,{projectId=null}={}){
 if(!configFile)return {enabled:false,plans:[]};if(projectId!==null&&!id(projectId))throw new PeerError('BAD_INPUT','项目标识无效',400);
 const read=reader(),config=json(read,configFile,128*1024);fields(config,['format','plans']);if(config.format!=='ai-fleet-progress/v1')fail('进度配置版本无效');list(config.plans,32);
 // Filter before opening any project files; all returned fields are an explicit public projection.
 const plans=config.plans.filter(p=>projectId===null||p.project_id===projectId).map(p=>projectPlan(p,read));if(new Set(plans.map(p=>p.plan_id)).size!==plans.length)fail('计划标识重复');
 return {enabled:true,generated_at:new Date().toISOString(),source:'local_administrator_enrollment',plans};
}
export function progressReceiptDraft(view,planId,phaseId){
 const plan=view.plans.find(p=>p.plan_id===planId),phase=plan?.phases.find(p=>p.phase_id===phaseId);if(!phase)throw new PeerError('NOT_FOUND','没有对应阶段',404);
 return {format:'ai-fleet-phase-receipt/v1',plan_id:planId,phase_id:phaseId,gate_id:phase.gate_id,contract_sha256:phase.contract_sha256,decision:'pending',accepted_task_ids:[],confirmations:[],evidence_refs:[],note:'待独立审阅与必要的操作者确认',verified_at:null};
}
