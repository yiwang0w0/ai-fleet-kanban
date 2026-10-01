// Read-only, local operational health observations. Never stops a process or removes a lock.
import {basename,dirname,join,isAbsolute} from 'node:path';
import {lstatSync,openSync,readSync,fstatSync,closeSync,realpathSync,statfsSync,statSync} from 'node:fs';
import {localIdentity} from './federation/peers.mjs';
import {PeerError,UUID} from './federation/protocol.mjs';
import {digest} from './federation/sync-store.mjs';
import {executionResolution} from './execution/resolutions.mjs';
export const HEALTH_THRESHOLDS=Object.freeze({broker_prepared_ms:300000,delivery_retry_ms:1800000,scheduler_heartbeat_ms:60000,node_heartbeat_ms:60000,sync_observation_ms:60000,storage_low_bytes:512*1024*1024});
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
function lockObservation(db,kind='scheduler'){
 const file=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
 if(!file)return {state:'unavailable'};
 let fd;
 try{
  const database=realpathSync(file),path=join(dirname(database),'.'+basename(database)+'.fleet-'+kind+'.lock'),st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.size>4096)return {state:'unreadable'};
  fd=openSync(path,'r');const before=fstatSync(fd);if(!before.isFile()||before.size>4096||before.ino!==st.ino||before.dev!==st.dev)return {state:'changed'};
  const bytes=Buffer.alloc(4097),n=readSync(fd,bytes,0,bytes.length,0),after=fstatSync(fd),current=lstatSync(path);
  if(n>4096||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.ino!==current.ino||after.dev!==current.dev||current.isSymbolicLink())return {state:'changed'};
  const r=JSON.parse(bytes.subarray(0,n).toString('utf8'));
  const instanceId=kind==='scheduler'?r?.id:r?.instance_id;
  if(!r||!UUID.test(instanceId)||!UUID.test(r.node_id)||!UUID.test(r.node_epoch)||!Number.isSafeInteger(r.pid)||r.pid<1)return {state:'unreadable'};
  return {state:'recorded',instance_id:instanceId,node_id:r.node_id,node_epoch:r.node_epoch,pid:r.pid,pid_observation:pidState(r.pid),mtime_ms:after.mtimeMs};
 }catch(e){return {state:e.code==='ENOENT'?'absent':'unreadable'};}
 finally{if(fd!==undefined)closeSync(fd);}
}
export function readFleetHealth(db,{now=Date.now(),diskProbe=statfsSync}={}){
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)fail('BAD_INPUT');
 const owns=!db.isTransaction;if(owns)db.exec('BEGIN');
 try{
  const local=localIdentity(db),issues=new Map(),modules={},thresholds=HEALTH_THRESHOLDS;let scanned=0;
  function* scan(sql,...params){for(const r of db.prepare(sql+' LIMIT '+(CAP+1)).iterate(...params)){if(++scanned>CAP)fail('INSPECTION_LIMIT');yield r;}}
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
  modules.broker=schema(db,'broker_dispatch_schema',3,['broker_dispatches','broker_execution_records','broker_call_quotas'])?'available':'not_configured';
  const resolution=schema(db,'broker_execution_resolution_schema',1,['broker_execution_resolutions']);
  if(modules.broker==='available'){
   for(const r of scan("SELECT dispatch_id,node_id,node_epoch,phase,created_at FROM broker_dispatches WHERE phase IN('prepared','interrupted') AND result_digest IS NULL")){
    if(resolution){try{if(executionResolution(db,r.dispatch_id))continue;}catch{fail('RECORD_CORRUPT');}}
    if(!identity(r,r.dispatch_id))continue;
    if(r.phase==='interrupted')add('BROKER_INTERRUPTED','problem',r.dispatch_id,'dispatch_stale_then_reconcile');
    else if(stale(r,r.dispatch_id,'created_at',thresholds.broker_prepared_ms))add('BROKER_PREPARED_STALE','notice',r.dispatch_id,'review_prepared_dispatch');
   }
  }
  modules.call_budget=modules.broker;
  if(modules.call_budget==='available')for(const q of scan("SELECT q.quota_id,q.node_id,q.node_epoch,q.limit_total,q.used,q.enabled,count(d.dispatch_id) reserved FROM broker_call_quotas q LEFT JOIN broker_dispatches d ON d.quota_id=q.quota_id AND d.phase='prepared' GROUP BY q.quota_id")){
   if(!UUID.test(q.quota_id)||![q.limit_total,q.used,q.reserved].every(n=>Number.isSafeInteger(n)&&n>=0)||![0,1].includes(q.enabled))fail('RECORD_CORRUPT');
   if(!q.enabled)continue;if(!identity(q,q.quota_id))continue;
   if(q.used+q.reserved>q.limit_total)add('CALL_BUDGET_OVERRUN','problem',q.quota_id,'inspect_call_quota_ledger');
   else if(q.used+q.reserved===q.limit_total)add('CALL_BUDGET_EXHAUSTED','notice',q.quota_id,'review_explicit_call_budget');
  }
  // Storage observations are not reservations or write guarantees. No paths are returned.
  const storage={measurement:'filesystem_available_bytes',targets_checked:0,targets_unavailable:0,volumes_observed:0,lowest_available_bytes:null},volumes=new Map();
  function diskTarget(path,id,expected=null){
   storage.targets_checked++;
   try{
    if(typeof path!=='string'||!isAbsolute(path)||! /^[a-z]:[\\/]/i.test(path))throw Error();
    const root=realpathSync.native(path),st=statSync(root,{bigint:true});
    if(expected&&(!st.isDirectory()||root!==expected.root||st.dev.toString()!==expected.device||st.ino.toString()!==expected.inode))throw Error();
    const key=st.dev.toString();let available=volumes.get(key);
    if(available===undefined){const v=diskProbe(root,{bigint:true});if(!v||[v.bsize,v.blocks,v.bavail].some(x=>typeof x!=='bigint')||v.bsize<=0n||v.blocks<=0n||v.bavail<0n||v.bavail>v.blocks)throw Error();available=v.bsize*v.bavail;volumes.set(key,available);storage.volumes_observed++;}
    if(storage.lowest_available_bytes===null||available<BigInt(storage.lowest_available_bytes))storage.lowest_available_bytes=available.toString();
    if(available<BigInt(thresholds.storage_low_bytes))add('STORAGE_LOW','problem',id,'inspect_storage_before_new_work');
   }catch{storage.targets_unavailable++;add('STORAGE_UNAVAILABLE','problem',id,'inspect_storage_observation');}
  }
  const databaseFile=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
  if(databaseFile)diskTarget(databaseFile,local.node_id);
  const poolMarker=has(db,'workspace_schema');
  if(!poolMarker&&has(db,'workspace_pools'))fail('SCHEMA_INCOMPATIBLE');
  if(poolMarker){if(![1,2].includes(db.prepare('SELECT version FROM workspace_schema').get()?.version)||!has(db,'workspace_pools'))fail('SCHEMA_INCOMPATIBLE');
   for(const p of scan('SELECT pool_id,node_id,descriptor_json FROM workspace_pools')){
    if(!UUID.test(p.pool_id)||p.node_id!==local.node_id||typeof p.descriptor_json!=='string'||Buffer.byteLength(p.descriptor_json)>16384)fail('RECORD_CORRUPT');
    let d;try{d=JSON.parse(p.descriptor_json);}catch{fail('RECORD_CORRUPT');}if(!d?.identity||typeof d.identity.root!=='string'||typeof d.identity.device!=='string'||typeof d.identity.inode!=='string')fail('RECORD_CORRUPT');
    diskTarget(d.identity.root,p.pool_id,d.identity);
   }
  }
  modules.storage=storage.targets_checked?'available':'not_configured';
  // Delivery clients return transient outcomes; this queue is the durable record used by the operator service.
  modules.delivery=has(db,'fleet_operator_actions')?'available':'not_configured';
  if(modules.delivery==='available'){
   for(const r of scan("SELECT action_id,node_id,node_epoch,state,created_at FROM fleet_operator_actions WHERE state IN('retry_pending','blocked')")){
    if(!identity(r,r.action_id))continue;
    if(r.state==='blocked')add('DELIVERY_BLOCKED','problem',r.action_id,'review_fleet_action');
    else if(stale(r,r.action_id,'created_at',thresholds.delivery_retry_ms))add('DELIVERY_RETRY_PENDING','notice',r.action_id,'check_peer_then_resume_same_action');
   }
  }
  const locks={};
  for(const [prefix,kind,label,threshold] of [['scheduler','scheduler','SCHEDULER',thresholds.scheduler_heartbeat_ms],['node_runtime','node-runtime','NODE',thresholds.node_heartbeat_ms]]){
   modules[prefix]=schema(db,prefix+'_lifecycle_schema',1,[prefix+'_instances',prefix+'_control_requests'])?'available':'not_configured';
   const lock=lockObservation(db,kind),active=[],action=prefix==='scheduler'?'inspect_scheduler_owner':'inspect_node_runtime';locks[prefix]=lock;
   if(modules[prefix]==='available')for(const r of scan("SELECT instance_id,node_id,node_epoch,pid,heartbeat_at,state,ended_at,requested_mode FROM "+prefix+"_instances WHERE ended_at IS NULL OR state='attention'")){
    if(!identity(r,r.instance_id))continue;
    if(r.state==='attention'){add(label+'_ATTENTION','problem',r.instance_id,prefix==='scheduler'?'review_scheduler_stop_evidence':'review_node_stop_evidence');if(r.ended_at)continue;}
    active.push(r);
    if(stale(r,r.instance_id,'heartbeat_at',threshold))add(label+'_HEARTBEAT_STALE','problem',r.instance_id,action);
    if(lock.state==='absent'&&age(now,r.heartbeat_at)>=threshold)add(label+'_LOCK_MISSING','problem',r.instance_id,action);
   }
   if(['unreadable','changed','unavailable'].includes(lock.state)&&(lock.state!=='unavailable'||modules[prefix]==='available'))add(label+'_LOCK_UNREADABLE','problem',null,prefix==='scheduler'?'inspect_scheduler_lock':'inspect_node_lock');
   if(lock.state==='recorded'){
    const owner=modules[prefix]==='available'?db.prepare('SELECT node_id,node_epoch,pid,state,ended_at FROM '+prefix+'_instances WHERE instance_id=?').get(lock.instance_id):null;
    if(lock.pid_observation==='not_observed')add(label+'_LOCK_ORPHAN','problem',lock.instance_id,'verify_stop_before_lock_recovery');
    const old=Number.isFinite(lock.mtime_ms)&&now-lock.mtime_ms>=threshold;
    if(old&&(!owner||owner.ended_at||owner.node_id!==lock.node_id||owner.node_epoch!==lock.node_epoch||owner.pid!==lock.pid||lock.node_id!==local.node_id||lock.node_epoch!==local.sync_epoch))add(label+'_LOCK_MISMATCH','problem',lock.instance_id,prefix==='scheduler'?'inspect_scheduler_lock':'inspect_node_lock');
    if(lock.pid_observation==='unknown')add(label+'_OWNER_UNKNOWN','notice',lock.instance_id,action);
    for(const row of active)if(row.instance_id!==lock.instance_id&&age(now,row.heartbeat_at)>=threshold)add(label+'_LOCK_MISMATCH','problem',row.instance_id,prefix==='scheduler'?'inspect_scheduler_lock':'inspect_node_lock');
   }
   if(prefix==='node_runtime'){
    const components=has(db,'node_runtime_components');
    if(components&&(modules[prefix]!=='available'||db.prepare('SELECT 1 FROM node_runtime_components c LEFT JOIN node_runtime_instances i USING(instance_id) WHERE i.instance_id IS NULL LIMIT 1').get()))fail('SCHEMA_INCOMPATIBLE');
    for(const instance of active){let count=0;
     if(components)for(const c of scan('SELECT name,state,updated_at,summary_json FROM node_runtime_components WHERE instance_id=?',instance.instance_id)){
      count++;const sync=typeof c.name==='string'&&/^sync:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(c.name),states=sync?['synced','pending','error','backoff','stopped']:c.name==='scheduler'?['prepared','running','stopped','attention']:['peer','mcp'].includes(c.name)?['listening','stopped']:[];
      if(!states.includes(c.state)||typeof c.summary_json!=='string'||Buffer.byteLength(c.summary_json)>4096)fail('RECORD_CORRUPT');
      let summary;try{summary=JSON.parse(c.summary_json);}catch{fail('RECORD_CORRUPT');}if(!summary||typeof summary!=='object'||Array.isArray(summary))fail('RECORD_CORRUPT');
      const observedAge=age(now,c.updated_at);if(observedAge===null)add('CLOCK_UNKNOWN','notice',instance.instance_id,'check_local_clock');
      if(!sync)continue;
      if(['error','backoff'].includes(c.state))add('NODE_SYNC_RETRY','notice',instance.instance_id,'inspect_node_sync_then_peer');
      else if(c.state==='pending')add('NODE_SYNC_PENDING','notice',instance.instance_id,'inspect_sync_backlog');
      if(c.state!=='stopped'&&observedAge!==null&&observedAge>=thresholds.sync_observation_ms&&age(now,instance.heartbeat_at)!==null&&age(now,instance.heartbeat_at)<threshold)add('NODE_SYNC_OBSERVATION_STALE','problem',instance.instance_id,'inspect_node_sync_then_peer');
      if(c.state==='stopped'&&instance.requested_mode==='run'&&instance.state==='running')add('NODE_COMPONENT_STOPPED','problem',instance.instance_id,'inspect_node_runtime');
     }
     if(!count&&age(now,instance.heartbeat_at)>=threshold)add('NODE_COMPONENTS_MISSING','problem',instance.instance_id,'inspect_node_runtime');
    }
   }
  }
  const result={format:'ai-fleet-health/v3',node_id:local.node_id,node_epoch:local.sync_epoch,checked_at:new Date(now).toISOString(),thresholds,modules,
   issues:[...issues.values()].map(i=>{const ids=[...i.ids].sort();return {code:i.code,level:i.level,next_action:i.next_action,count:ids.length,sample_ids:ids.filter(x=>x!=='lock').slice(0,3),fingerprint:digest({code:i.code,action:i.next_action,ids})};}).sort((a,b)=>a.code.localeCompare(b.code)||a.next_action.localeCompare(b.next_action)),
   lock_observation:{state:locks.scheduler.state,pid_observation:locks.scheduler.pid_observation??'not_checked'},
   storage_observation:storage,
   node_lock_observation:{state:locks.node_runtime.state,pid_observation:locks.node_runtime.pid_observation??'not_checked'},
   coverage:'local_persisted_state_and_runtime_locks',state_changes:false,remote_state:'not_queried',executor_stop_confirmed:false};
  if(owns)db.exec('COMMIT');return result;
 }catch(e){if(owns&&db.isTransaction)db.exec('ROLLBACK');throw e;}
}
