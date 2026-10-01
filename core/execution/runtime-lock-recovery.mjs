// Explicit local recovery of an exited host's exact lock. No process termination or task retry.
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {atomic,canonical,digest} from '../federation/sync-store.mjs';
import {localIdentity} from '../federation/peers.mjs';
import {uuid} from '../federation/protocol.mjs';
import {exact,fail} from '../mcp/policy.mjs';
import {createLifecycleRegistry} from './lifecycle.mjs';
import {inspectStoppedRuns} from './stop-proof.mjs';
import {removePrivateCredential as removePinnedLock} from '../mcp/credential-cleanup.mjs';
const PLAN='ai-fleet-runtime-lock-plan/v1',RECEIPT='ai-fleet-runtime-lock-recovery/v1';
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hash=x=>createHash('sha256').update(x).digest('hex');
function kindPrefix(kind){if(kind==='scheduler')return 'scheduler';if(kind==='node-runtime')return 'node_runtime';fail('BAD_INPUT','仅支持 scheduler 或 node-runtime',400);}
function location(db,kind){
 kindPrefix(kind);const file=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
 if(!file||!isAbsolute(file))fail('BAD_DATABASE','恢复需要本机持久数据库',400);
 const database=realpathSync(file);return join(dirname(database),'.'+basename(database)+'.fleet-'+kind+'.lock');
}
function processState(pid){
 if(!Number.isSafeInteger(pid)||pid<1||pid>0x7fffffff)fail('LOCK_RECOVERY_CHANGED','锁中的宿主 PID 无效');
 // Signal 0 probes existence only. A reused PID is present and must be refused too.
 try{process.kill(pid,0);return 'present';}catch(e){return e.code==='ESRCH'?'absent':'unknown';}
}
function lockRecord(db,kind,instanceId,row){
 let bytes,record;
 try{const file=location(db,kind),st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>16384||st.nlink!==1)throw Error();bytes=readFileSync(file);if(bytes.length>16384)throw Error();record=JSON.parse(bytes.toString('utf8'));}catch{fail('LOCK_RECOVERY_CHANGED','锁不存在、不可读或不是受支持的原文件');}
 const fields=kind==='scheduler'?['id','pid','node_id','node_epoch','at']:['instance_id','pid','node_id','node_epoch'];
 try{exact(record,fields,'runtime_lock');}catch{fail('LOCK_RECOVERY_CHANGED','锁文件字段不匹配');}
 if((record.instance_id??record.id)!==instanceId||record.pid!==row.pid||record.node_id!==row.node_id||record.node_epoch!==row.node_epoch)fail('LOCK_RECOVERY_CHANGED','锁已变化或不属于所选实例');
 return {record,sha256:hash(bytes)};
}
function schema(db,{install=false}={}){
 if(exists(db,'runtime_lock_recovery_schema')){if(db.prepare('SELECT version FROM runtime_lock_recovery_schema WHERE singleton=1').get()?.version!==1)fail('SCHEMA_INCOMPATIBLE','锁恢复记录格式不兼容');return true;}
 if(!install)return false;
 db.exec("CREATE TABLE runtime_lock_recovery_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT INTO runtime_lock_recovery_schema VALUES(1,1); CREATE TABLE runtime_lock_recoveries(kind TEXT NOT NULL,instance_id TEXT NOT NULL,plan_digest TEXT NOT NULL UNIQUE,plan_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(kind,instance_id)); CREATE TRIGGER runtime_lock_recovery_immutable BEFORE UPDATE ON runtime_lock_recoveries BEGIN SELECT RAISE(ABORT,'lock recovery is immutable'); END; CREATE TRIGGER runtime_lock_recovery_retained BEFORE DELETE ON runtime_lock_recoveries BEGIN SELECT RAISE(ABORT,'lock recovery is retained'); END");return true;
}
function previous(db,kind,instanceId){
 if(!schema(db))return null;const r=db.prepare('SELECT * FROM runtime_lock_recoveries WHERE kind=? AND instance_id=?').get(kind,instanceId);if(!r)return null;
 const receipt=JSON.parse(r.receipt_json),plan=JSON.parse(r.plan_json),{plan_digest,...payload}=plan;
 if(receipt.format!==RECEIPT||plan_digest!==r.plan_digest||digest(payload)!==r.plan_digest||digest(receipt)!==r.receipt_digest||receipt.plan_digest!==r.plan_digest||receipt.kind!==kind||receipt.instance_id!==instanceId)fail('LOCK_RECOVERY_CORRUPT','锁恢复记录摘要不匹配');return {receipt,plan};
}
function snapshot(db,{kind,instanceId}){
 const prefix=kindPrefix(kind);uuid(instanceId,'instance_id');const n=localIdentity(db);
 const observed=createLifecycleRegistry(kind).status(db,{instanceId}).instances[0];
 if(!observed.identity_current)fail('EPOCH_CHANGED','旧代次实例不能从当前节点解除锁');
 const row=db.prepare('SELECT * FROM '+prefix+'_instances WHERE instance_id=?').get(instanceId),lock=lockRecord(db,kind,instanceId,row);
 const runs=exists(db,'broker_dispatches')?db.prepare("SELECT r.* FROM task_runs r LEFT JOIN broker_dispatches d ON d.run_id=r.run_id WHERE (d.node_id=? AND d.node_epoch=?) OR (r.executor_node_id=? AND r.state='running') ORDER BY r.run_id").all(n.node_id,n.sync_epoch,n.node_id):db.prepare("SELECT * FROM task_runs WHERE executor_node_id=? AND state='running' ORDER BY run_id").all(n.node_id);
 const members=db.prepare("SELECT id AS task_id,task_uid FROM tasks WHERE owner_node_id=? AND status='in_progress' AND archived_at IS NULL ORDER BY id").all(n.node_id);
 const stopped=inspectStoppedRuns(db,{nodeId:n.node_id,nodeEpoch:n.sync_epoch,members,runs,allowOperatorAttested:true}),host=processState(row.pid),blockers=[...stopped.blockers];
 if(host!=='absent')blockers.unshift({kind:'host_process_'+host,pid:row.pid});
 return {kind,instance_id:instanceId,node_id:n.node_id,node_epoch:n.sync_epoch,host_pid:row.pid,host_process_state:host,lock_sha256:lock.sha256,lock_record:lock.record,instance_state_digest:digest(row),execution_state_digest:digest({runs,members,stopped}),blockers,proofs:stopped.proofs,operator_attested_runs:stopped.operatorAttestedRuns,automatic_restart:false,quota_refunded:false,accepted:false};
}
export function prepareRuntimeLockRecovery(db,options){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED','实例锁恢复仅支持 Windows');
 const own=!db.isTransaction;if(own)db.exec('BEGIN');try{const state=snapshot(db,options);if(previous(db,state.kind,state.instance_id))fail('ALREADY_RESOLVED','此实例已有锁恢复回执，可重放原计划重试清理');const payload={format:PLAN,...state,prepared_at:new Date().toISOString()};return {...payload,plan_digest:digest(payload)};}finally{if(own)db.exec('ROLLBACK');}
}
export function applyRuntimeLockRecovery(db,{plan,expectedPlanDigest}){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED','实例锁恢复仅支持 Windows');if(db.isTransaction)fail('TRANSACTION_CONTEXT','锁恢复需要独立事务，以便先提交回执再清理原锁');
 exact(plan,['format','kind','instance_id','node_id','node_epoch','host_pid','host_process_state','lock_sha256','lock_record','instance_state_digest','execution_state_digest','blockers','proofs','operator_attested_runs','automatic_restart','quota_refunded','accepted','prepared_at','plan_digest'],'runtime_lock_plan');
 const {plan_digest,...payload}=plan;
 if(plan.format!==PLAN||typeof expectedPlanDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedPlanDigest)||plan_digest!==expectedPlanDigest||digest(payload)!==plan_digest||!Number.isFinite(Date.parse(plan.prepared_at)))fail('PLAN_MISMATCH','恢复计划与明确核对的摘要不符');
 const receipt=atomic(db,()=>{
  const n=localIdentity(db);if(n.node_id!==plan.node_id||n.sync_epoch!==plan.node_epoch)fail('EPOCH_CHANGED','恢复计划不属于本机当前代次');
  const prior=previous(db,plan.kind,plan.instance_id);if(prior){if(prior.receipt.plan_digest!==plan_digest)fail('REQUEST_CONFLICT','此实例已有不同恢复决定');return prior.receipt;}
  const state=snapshot(db,{kind:plan.kind,instanceId:plan.instance_id});
  if(state.lock_sha256!==plan.lock_sha256)fail('LOCK_RECOVERY_CHANGED','原锁字节已改变');
  if(Object.entries(state).some(([k,v])=>canonical(v)!==canonical(plan[k])))fail('PLAN_STALE','实例、宿主进程或运行证明已改变，需重新核对计划');
  if(state.blockers.length)fail('LOCK_RECOVERY_BLOCKED','宿主仍存在、停止证明不足或无法确认；未解除锁');
  schema(db,{install:true});createLifecycleRegistry(plan.kind).finish(db,plan.instance_id,{unconfirmedRuns:0,errorCode:'RUNTIME_LOCK_RECOVERED'});
  const recorded_at=new Date().toISOString(),r={format:RECEIPT,kind:plan.kind,instance_id:plan.instance_id,node_id:n.node_id,node_epoch:n.sync_epoch,plan_digest,lock_sha256:plan.lock_sha256,host_pid:plan.host_pid,host_process_state:'absent',run_proofs:plan.proofs,operator_attested_runs:plan.operator_attested_runs,process_stop_evidence:plan.operator_attested_runs?'includes_operator_attestation':'registered_run_proofs',automatic_restart:false,quota_refunded:false,accepted:false,recorded_at};
  db.prepare('INSERT INTO runtime_lock_recoveries VALUES(?,?,?,?,?,?,?)').run(plan.kind,plan.instance_id,plan_digest,canonical(plan),digest(r),canonical(r),recorded_at);return r;
 });
 // The durable decision survives cleanup failure. The native helper compares and
 // deletes one exclusive handle, so a replaced/new instance lock is preserved.
 const host=processState(receipt.host_pid),cleanup=host==='absent'?removePinnedLock(location(db,receipt.kind),receipt.lock_sha256):'host_process_'+host;
 return {receipt,cleanup,lock_released:cleanup==='deleted'||cleanup==='missing',automatic_restart:false};
}
