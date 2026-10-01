// Read-only, local operational health observations. Never stops a process or removes a lock.
import {basename,dirname,join} from 'node:path';
import {lstatSync,openSync,readSync,fstatSync,closeSync,realpathSync} from 'node:fs';
import {localIdentity} from './federation/peers.mjs';
import {PeerError,UUID} from './federation/protocol.mjs';
import {digest} from './federation/sync-store.mjs';
import {executionResolution} from './execution/resolutions.mjs';
export const HEALTH_THRESHOLDS=Object.freeze({broker_prepared_ms:300000,delivery_retry_ms:1800000,scheduler_heartbeat_ms:60000});
const CAP=10000,has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const fail=code=>{throw new PeerError(code,'本机健康记录不完整或不可读',503);};
function schema(db,marker,version,tables){
 if(!has(db,marker)){if(tables.some(t=>has(db,t)))fail('SCHEMA_INCOMPATIBLE');return false;}
 if(db.prepare('SELECT version FROM '+marker+' WHERE singleton=1').get()?.version!==version||tables.some(t=>!has(db,t)))fail('SCHEMA_INCOMPATIBLE');return true;
}
function age(now,text){const t=typeof text==='string'&&/Z$|[+-]\d\d:\d\d$/.test(text)?Date.parse(text):NaN;return Number.isFinite(t)&&t<=now?now-t:null;}
function pidState(pid){
 try{process.kill(pid,0);return 'present_not_identity_verified';}
 catch(e){return e.code==='ESRCH'?'not_observed':'unknown';}
}
function lockObservation(db){
 const file=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
 if(!file)return {state:'unavailable'};
 let fd;
 try{
  const database=realpathSync(file),path=join(dirname(database),'.'+basename(database)+'.fleet-scheduler.lock'),st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.size>4096)return {state:'unreadable'};
  fd=openSync(path,'r');const before=fstatSync(fd);if(!before.isFile()||before.size>4096||before.ino!==st.ino||before.dev!==st.dev)return {state:'changed'};
  const bytes=Buffer.alloc(4097),n=readSync(fd,bytes,0,bytes.length,0),after=fstatSync(fd),current=lstatSync(path);
  if(n>4096||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.ino!==current.ino||after.dev!==current.dev||current.isSymbolicLink())return {state:'changed'};
  const r=JSON.parse(bytes.subarray(0,n).toString('utf8'));
  if(!r||!UUID.test(r.id)||!UUID.test(r.node_id)||!UUID.test(r.node_epoch)||!Number.isSafeInteger(r.pid)||r.pid<1)return {state:'unreadable'};
  return {state:'recorded',instance_id:r.id,node_id:r.node_id,node_epoch:r.node_epoch,pid:r.pid,pid_observation:pidState(r.pid),mtime_ms:after.mtimeMs};
 }catch(e){return {state:e.code==='ENOENT'?'absent':'unreadable'};}
 finally{if(fd!==undefined)closeSync(fd);}
}
export function readFleetHealth(db,{now=Date.now()}={}){
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)fail('BAD_INPUT');
 const owns=!db.isTransaction;if(owns)db.exec('BEGIN');
 try{
  const local=localIdentity(db),issues=new Map(),modules={},thresholds=HEALTH_THRESHOLDS;let scanned=0;
  function* scan(sql){for(const r of db.prepare(sql+' LIMIT '+(CAP+1)).iterate()){if(++scanned>CAP)fail('INSPECTION_LIMIT');yield r;}}
  function add(code,level,id,action){
   if(id!==null&&!UUID.test(id))fail('RECORD_CORRUPT');
   const key=code+'|'+action;if(!issues.has(key))issues.set(key,{code,level,next_action:action,ids:new Set()});
   issues.get(key).ids.add(id??'lock');
  }
  function identity(r,id){
   if(!UUID.test(r.node_id)||!UUID.test(r.node_epoch)||!UUID.test(id))fail('RECORD_CORRUPT');
   if(r.node_id!==local.node_id||r.node_epoch!==local.sync_epoch){add('STALE_EPOCH_RECORD','problem',id,'review_epoch_recovery');return false;}return true;
  }
  function stale(r,id,field,threshold){
   const a=age(now,r[field]);if(a===null){add('CLOCK_UNKNOWN','notice',id,'check_local_clock');return false;}return a>=threshold;
  }
  modules.broker=schema(db,'broker_dispatch_schema',3,['broker_dispatches','broker_execution_records'])?'available':'not_configured';
  const resolution=schema(db,'broker_execution_resolution_schema',1,['broker_execution_resolutions']);
  if(modules.broker==='available'){
   for(const r of scan("SELECT dispatch_id,node_id,node_epoch,phase,created_at FROM broker_dispatches WHERE phase IN('prepared','interrupted') AND result_digest IS NULL")){
    if(resolution){try{if(executionResolution(db,r.dispatch_id))continue;}catch{fail('RECORD_CORRUPT');}}
    if(!identity(r,r.dispatch_id))continue;
    if(r.phase==='interrupted')add('BROKER_INTERRUPTED','problem',r.dispatch_id,'dispatch_stale_then_reconcile');
    else if(stale(r,r.dispatch_id,'created_at',thresholds.broker_prepared_ms))add('BROKER_PREPARED_STALE','notice',r.dispatch_id,'review_prepared_dispatch');
   }
  }
  // Delivery clients return transient outcomes; this queue is the durable record used by the operator service.
  modules.delivery=has(db,'fleet_operator_actions')?'available':'not_configured';
  if(modules.delivery==='available'){
   for(const r of scan("SELECT action_id,node_id,node_epoch,state,created_at FROM fleet_operator_actions WHERE state IN('retry_pending','blocked')")){
    if(!identity(r,r.action_id))continue;
    if(r.state==='blocked')add('DELIVERY_BLOCKED','problem',r.action_id,'review_fleet_action');
    else if(stale(r,r.action_id,'created_at',thresholds.delivery_retry_ms))add('DELIVERY_RETRY_PENDING','notice',r.action_id,'check_peer_then_resume_same_action');
   }
  }
  modules.scheduler=schema(db,'scheduler_lifecycle_schema',1,['scheduler_instances','scheduler_control_requests'])?'available':'not_configured';
  const lock=lockObservation(db),active=[];
  if(modules.scheduler==='available')for(const r of scan("SELECT instance_id,node_id,node_epoch,pid,heartbeat_at,state,ended_at FROM scheduler_instances WHERE ended_at IS NULL OR state='attention'")){
   if(!identity(r,r.instance_id))continue;
   if(r.state==='attention'){add('SCHEDULER_ATTENTION','problem',r.instance_id,'review_scheduler_stop_evidence');if(r.ended_at)continue;}
   active.push(r);
   if(stale(r,r.instance_id,'heartbeat_at',thresholds.scheduler_heartbeat_ms))add('SCHEDULER_HEARTBEAT_STALE','problem',r.instance_id,'inspect_scheduler_owner');
   if(lock.state==='absent'&&age(now,r.heartbeat_at)>=thresholds.scheduler_heartbeat_ms)add('SCHEDULER_LOCK_MISSING','problem',r.instance_id,'inspect_scheduler_owner');
  }
  if(['unreadable','changed','unavailable'].includes(lock.state)&&(lock.state!=='unavailable'||modules.scheduler==='available'))
   add('SCHEDULER_LOCK_UNREADABLE','problem',null,'inspect_scheduler_lock');
  if(lock.state==='recorded'){
   const owner=modules.scheduler==='available'?db.prepare('SELECT node_id,node_epoch,pid,state,ended_at FROM scheduler_instances WHERE instance_id=?').get(lock.instance_id):null;
   if(lock.pid_observation==='not_observed')add('SCHEDULER_LOCK_ORPHAN','problem',lock.instance_id,'verify_stop_before_lock_recovery');
   // DB registration and file creation are separate observations; a just-created lock may be between them.
   const old=Number.isFinite(lock.mtime_ms)&&now-lock.mtime_ms>=thresholds.scheduler_heartbeat_ms;
   if(old&&(!owner||owner.ended_at||owner.node_id!==lock.node_id||owner.node_epoch!==lock.node_epoch||owner.pid!==lock.pid||lock.node_id!==local.node_id||lock.node_epoch!==local.sync_epoch))
    add('SCHEDULER_LOCK_MISMATCH','problem',lock.instance_id,'inspect_scheduler_lock');
   if(lock.pid_observation==='unknown')add('SCHEDULER_OWNER_UNKNOWN','notice',lock.instance_id,'inspect_scheduler_owner');
   for(const row of active)if(row.instance_id!==lock.instance_id&&age(now,row.heartbeat_at)>=thresholds.scheduler_heartbeat_ms)
    add('SCHEDULER_LOCK_MISMATCH','problem',row.instance_id,'inspect_scheduler_lock');
  }
  const result={format:'ai-fleet-health/v1',node_id:local.node_id,node_epoch:local.sync_epoch,checked_at:new Date(now).toISOString(),thresholds,modules,
   issues:[...issues.values()].map(i=>{const ids=[...i.ids].sort();return {code:i.code,level:i.level,next_action:i.next_action,count:ids.length,sample_ids:ids.filter(x=>x!=='lock').slice(0,3),fingerprint:digest({code:i.code,action:i.next_action,ids})};}).sort((a,b)=>a.code.localeCompare(b.code)||a.next_action.localeCompare(b.next_action)),
   lock_observation:{state:lock.state,pid_observation:lock.pid_observation??'not_checked'},
   coverage:'local_persisted_state_and_scheduler_lock',state_changes:false,remote_state:'not_queried',executor_stop_confirmed:false};
  if(owns)db.exec('COMMIT');return result;
 }catch(e){if(owns&&db.isTransaction)db.exec('ROLLBACK');throw e;}
}
