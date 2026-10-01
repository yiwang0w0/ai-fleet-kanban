// Local operational inventory. No migration, network I/O or execution-state transitions.
import {createRequire} from 'node:module';
import {localIdentity} from './federation/peers.mjs';
import {digest} from './federation/sync-store.mjs';
import {UUID} from './federation/protocol.mjs';
import {executionResolution} from './execution/resolutions.mjs';
const guard=createRequire(import.meta.url)('./delegation_guard.js');
const CAP=10000,NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;
const messages={
 BAD_INPUT:'巡检参数无效；请检查项目、每页数量和游标。',
 SCHEMA_INCOMPATIBLE:'巡检所需存储版本不兼容或表不完整；请先核对数据库版本。',
 RECORD_CORRUPT:'待处理记录不完整或摘要不匹配；请保留数据库并核对本机证据。',
 INSPECTION_LIMIT:'候选记录超过巡检上限；请按项目缩小范围。',
 SNAPSHOT_CHANGED:'待处理记录已变化；请去掉游标，从第一页重新读取。',
 BAD_DATABASE:'需要已初始化数据库的现存绝对文件路径。',
 RESTORE_HOLD:'恢复副本尚未激活，不能作为当前节点巡检。',
 NODE_RETIRED:'节点已退役；请使用当前节点数据库。',
 IDENTITY_MISSING:'数据库缺少已初始化的本机身份。',
 INSPECTION_FAILED:'无法读取巡检清单；请在本机核对数据库访问和完整性。'
};
class InspectionError extends Error {constructor(code){super(messages[code]);this.code=code;}}
const fail=code=>{throw new InspectionError(code);};
export function inspectionError(error){
 const code=Object.hasOwn(messages,error?.code)?error.code:'INSPECTION_FAILED';
 return {format:'ai-fleet-inspection-error/v1',code,message:messages[code],state_changes:false};
}
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
function moduleState(db,marker,versions,tables,owned=tables){
 if(!exists(db,marker)){if(owned.some(t=>exists(db,t)))fail('SCHEMA_INCOMPATIBLE');return 'not_configured';}
 if(!versions.includes(db.prepare('SELECT version FROM '+marker+' WHERE singleton=1').get()?.version)||tables.some(t=>!exists(db,t)))fail('SCHEMA_INCOMPATIBLE');
 return 'available';
}
function objectJSON(raw,hash){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)fail('RECORD_CORRUPT');
 let value;try{value=JSON.parse(raw);}catch{fail('RECORD_CORRUPT');}
 if(!value||typeof value!=='object'||Array.isArray(value)||digest(value)!==hash)fail('RECORD_CORRUPT');
 return value;
}
function options({projectId=null,limit=100,cursor=null,now=Date.now()}={}){
 if(projectId!==null&&(typeof projectId!=='string'||!NAME.test(projectId))||!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(now)||now<0||now>8640000000000000)fail('BAD_INPUT');
 let page=null;
 if(cursor!==null){
  if(typeof cursor!=='string'||cursor.length>1024||!cursor.length||!/^[A-Za-z0-9_-]+$/.test(cursor))fail('BAD_INPUT');
  try{const raw=Buffer.from(cursor,'base64url');if(raw.toString('base64url')!==cursor)fail('BAD_INPUT');page=JSON.parse(raw.toString('utf8'));}catch{fail('BAD_INPUT');}
  if(!page||Object.keys(page).sort().join(',')!=='format,limit,offset,project_id,snapshot_id'||page.project_id!==projectId||page.limit!==limit||!Number.isSafeInteger(page.offset)||page.offset<1||page.offset%limit||typeof page.snapshot_id!=='string'||!/^[a-f0-9]{64}$/.test(page.snapshot_id))fail('BAD_INPUT');
 }
 return {projectId,limit,page,now};
}
function inspect(db,kind,input,collect){
 const q=options(input),owns=!db.isTransaction;
 if(owns)db.exec('BEGIN');
 try{
  const local=localIdentity(db),items=[],modules={};let scanned=0;
  const scan=(sql)=>{const rows=db.prepare(sql+' LIMIT ?').all(q.projectId,q.projectId,CAP+1);scanned+=rows.length;if(scanned>CAP)fail('INSPECTION_LIMIT');return rows;};
  const add=(category,row,reason,nextAction,extra={})=>{
   if(!UUID.test(row.record_id)||(typeof row.project_id!=='string'||!NAME.test(row.project_id))||!UUID.test(row.node_id)||!UUID.test(row.node_epoch)||row.related_id!=null&&!UUID.test(row.related_id)||row.task_id!=null&&(!Number.isSafeInteger(row.task_id)||row.task_id<1))fail('RECORD_CORRUPT');
   const time=typeof row.created_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(row.created_at)&&Number.isFinite(Date.parse(row.created_at))?row.created_at:null;
   const current=row.node_id===local.node_id&&row.node_epoch===local.sync_epoch;
   items.push({category,record_id:row.record_id,related_id:row.related_id??null,project_id:row.project_id,task_id:row.task_id??null,
    state:row.state,recorded_at:time,identity_current:current,reason,next_action:current?nextAction:'review_epoch_recovery',...extra});
  };
  collect({local,modules,scan,add});
  items.sort((a,b)=>(a.recorded_at??'').localeCompare(b.recorded_at??'')||a.category.localeCompare(b.category)||a.record_id.localeCompare(b.record_id));
  const format='ai-fleet-'+kind+'/v1',snapshotId=digest({format,node_id:local.node_id,node_epoch:local.sync_epoch,project_id:q.projectId,modules,items});
  if(q.page&&(q.page.format!==format||q.page.snapshot_id!==snapshotId))fail('SNAPSHOT_CHANGED');
  const offset=q.page?.offset??0;if(offset>items.length)fail('BAD_INPUT');
  const end=offset+q.limit,next=end<items.length?Buffer.from(JSON.stringify({format,project_id:q.projectId,limit:q.limit,offset:end,snapshot_id:snapshotId})).toString('base64url'):null;
  const result={format,node_id:local.node_id,node_epoch:local.sync_epoch,project_id:q.projectId,checked_at:new Date(q.now).toISOString(),modules,
   coverage:'locally_recorded_state',snapshot_id:snapshotId,items:items.slice(offset,end).map(i=>{const t=i.recorded_at===null?NaN:Date.parse(i.recorded_at);return {...i,age_ms:Number.isFinite(t)&&t<=q.now?q.now-t:null,clock_unknown:!Number.isFinite(t)||t>q.now};}),
   total:items.length,limit:q.limit,next_cursor:next,state_changes:false,process_liveness:'not_checked',remote_state:'not_queried'};
  if(owns)db.exec('COMMIT');return result;
 }catch(error){if(owns&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
const scope=column=>'(? IS NULL OR '+column+'=? OR '+column+' IS NULL)';
export function federationStuck(db,input){
 return inspect(db,'federation-stuck',input,({modules,scan,add})=>{
  modules.binding=moduleState(db,'binding_schema',[3,4],['delegation_bindings','binding_attempts','binding_source_commits','federation_peers','federation_retired_epochs'],['delegation_bindings','binding_attempts','binding_source_commits']);
  modules.topology=moduleState(db,'topology_schema',[1],['topology_bindings','topology_operations','topology_attempts']);
  modules.completion=moduleState(db,'completion_schema',[1],['completion_plans','completion_ready','completion_registrar_attempts','completion_retirements','completion_settlements']);
  modules.cancellation=moduleState(db,'cancellation_schema',[1],['delegation_cancellations','cancellation_members']);
  modules.delegation=moduleState(db,'federation_delegation_schema',[1],['delegation_incoming']);
  if(modules.binding==='available'){
   for(const r of scan("SELECT a.request_id record_id,a.relation_id related_id,a.action,a.state,a.created_at,b.project_id,b.node_id,b.node_epoch,b.task_id FROM binding_attempts a LEFT JOIN delegation_bindings b USING(relation_id) WHERE a.state='pending' AND "+scope('b.project_id'))){
    if(!['approve','withdraw'].includes(r.action))fail('RECORD_CORRUPT');
    add('binding_attempt',r,'BINDING_RECEIPT_PENDING',r.action==='approve'?'resume_binding_submit':'resume_binding_withdraw',{action:r.action});
   }
  }
  if(modules.topology==='available'){
   for(const r of scan("SELECT a.request_id record_id,a.operation_id related_id,a.state,a.created_at,o.project_id,b.owner_node_id node_id,o.owner_epoch node_epoch FROM topology_attempts a LEFT JOIN topology_operations o USING(operation_id) LEFT JOIN topology_bindings b USING(project_id) WHERE a.state='pending' AND "+scope('o.project_id')))
    add('topology_attempt',r,'TOPOLOGY_RECEIPT_PENDING','resume_topology_submit');
  }
  if(modules.completion==='available'){
   if(modules.binding!=='available')fail('SCHEMA_INCOMPATIBLE');
   const base=' FROM completion_plans p LEFT JOIN delegation_bindings b USING(relation_id) ';
   for(const r of scan("SELECT a.request_id record_id,a.completion_id related_id,a.state,a.created_at,b.project_id,p.node_id,p.node_epoch,p.task_id FROM completion_registrar_attempts a LEFT JOIN completion_plans p USING(completion_id) LEFT JOIN delegation_bindings b USING(relation_id) WHERE a.state='pending' AND "+scope('b.project_id')))
    add('completion_attempt',r,'COMPLETION_RECEIPT_PENDING','resume_completion_submit');
   for(const r of scan("SELECT p.completion_id record_id,p.relation_id related_id,'ready' state,c.created_at,b.project_id,p.node_id,p.node_epoch,p.task_id"+base+"JOIN completion_ready c USING(completion_id) WHERE NOT EXISTS(SELECT 1 FROM completion_retirements r WHERE r.completion_id=p.completion_id) AND NOT EXISTS(SELECT 1 FROM completion_settlements s WHERE s.completion_id=p.completion_id) AND "+scope('b.project_id')))
    add('completion_ready',r,'REGISTRAR_COMPLETION_NOT_RECORDED','review_and_submit_completion');
  }
  if(modules.cancellation==='available'){
   for(const r of scan("SELECT cancel_id record_id,relation_id related_id,state,created_at,project_id,node_id,node_epoch FROM delegation_cancellations WHERE side='source' AND state='received' AND "+scope('project_id')))
    add('cancellation_received',r,'TARGET_STOP_RECEIPT_NOT_RECORDED','progress_target_then_poll_source');
  }
  if(modules.delegation==='available'){
   for(const r of scan("SELECT delegation_id record_id,project_id,state,created_at,target_task_id task_id,offer_json,offer_digest FROM delegation_incoming WHERE state='accepted_unconfirmed' AND "+scope('project_id'))){
    const offer=objectJSON(r.offer_json,r.offer_digest);
    if(offer.delegation_id!==r.record_id||offer.project_id!==r.project_id||r.task_id==null)fail('RECORD_CORRUPT');
    if(modules.binding==='available'){
     const binding=db.prepare('SELECT state,closed FROM delegation_bindings WHERE delegation_id=? ORDER BY rowid DESC LIMIT 1').get(r.record_id);
     if(binding?.closed===1||binding?.state==='cancelled'||guard.ready(db,r.task_id))continue;
    }
    add('delegation_unbound',{...r,node_id:offer.target_node_id,node_epoch:offer.target_epoch},'TARGET_BINDING_NOT_AUTHORIZED','review_endpoint_binding',{binding_authorized:false});
   }
  }
 });
}
export function dispatchStale(db,input){
 return inspect(db,'dispatch-stale',input,({modules,scan,add})=>{
  modules.dispatch=moduleState(db,'broker_dispatch_schema',[3],['broker_dispatches','broker_assignments','broker_execution_records'],['broker_dispatches','broker_execution_records']);
  modules.resolution=moduleState(db,'broker_execution_resolution_schema',[1],['broker_execution_resolutions']);
  if(modules.dispatch!=='available')return;
  for(const r of scan("SELECT d.dispatch_id record_id,d.run_id related_id,a.project_id,d.node_id,d.node_epoch,d.task_id,d.phase state,d.created_at,d.launch_at FROM broker_dispatches d LEFT JOIN broker_assignments a USING(assignment_id) WHERE d.phase IN('prepared','interrupted') AND d.result_digest IS NULL AND "+scope('a.project_id'))){
   if(modules.resolution==='available'){
    try{if(executionResolution(db,r.record_id))continue;}catch{fail('RECORD_CORRUPT');}
   }
   add('dispatch',r,r.state==='prepared'?'DISPATCH_PREPARED':'EXECUTION_UNSETTLED',r.state==='prepared'?'review_prepared_dispatch':'reconcile_or_attest_stopped',{launch_recorded:r.launch_at!==null});
  }
 });
}
