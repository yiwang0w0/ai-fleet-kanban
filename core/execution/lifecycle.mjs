// Local administrative control of one scheduler instance. No PID-based termination.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,dirname,join} from 'node:path';
import {atomic,canonical,digest} from '../federation/sync-store.mjs';
import {localIdentity} from '../federation/peers.mjs';
import {uuid,version} from '../federation/protocol.mjs';
import {fail} from '../mcp/policy.mjs';
export function openSchedulerControlDatabase(path,{readOnly=false}={}){
 if(typeof path!=='string'||!isAbsolute(path)||!existsSync(path)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())fail('BAD_DATABASE','需要已初始化数据库的普通文件绝对路径',400);
 if(existsSync(join(dirname(path),'.incomplete'))||existsSync(join(dirname(realpathSync(path)),'.incomplete')))fail('RESTORE_HOLD','备份或恢复尚未完成');
 const db=new DatabaseSync(path,{readOnly});try{db.exec('PRAGMA busy_timeout=5000');if(readOnly)db.exec('PRAGMA query_only=ON');localIdentity(db);return db;}catch(e){db.close();throw e;}
}
export function createLifecycleRegistry(kind){
 const prefix=kind==="scheduler"?"scheduler":kind==="node-runtime"?"node_runtime":null;if(!prefix)fail("BAD_INPUT","运行实例种类无效",400);
const exists=db=>!!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='${prefix}_lifecycle_schema'`).get();
function ready(db){if(!exists(db))return false;if(db.prepare(`SELECT version FROM ${prefix}_lifecycle_schema WHERE singleton=1`).get()?.version!==1)fail('SCHEMA_INCOMPATIBLE','调度控制格式不兼容');return true;}

function migrate(db){atomic(db,()=>{
 localIdentity(db);if(exists(db)){ready(db);return;}
 db.exec(`CREATE TABLE ${prefix}_lifecycle_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
 INSERT INTO ${prefix}_lifecycle_schema VALUES(1,1);
 CREATE TABLE ${prefix}_instances(instance_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,pid INTEGER NOT NULL,config_digest TEXT NOT NULL,started_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL,requested_mode TEXT NOT NULL CHECK(requested_mode IN('run','drain','cancel')),revision INTEGER NOT NULL,observed_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('running','draining','cancelling','stopped','attention')),ended_at TEXT,unconfirmed_runs INTEGER,error_code TEXT);
 CREATE TABLE ${prefix}_control_requests(request_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,args_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER ${prefix}_instance_identity BEFORE UPDATE ON ${prefix}_instances WHEN OLD.instance_id<>NEW.instance_id OR OLD.node_id<>NEW.node_id OR OLD.node_epoch<>NEW.node_epoch OR OLD.pid<>NEW.pid OR OLD.config_digest<>NEW.config_digest OR OLD.started_at<>NEW.started_at BEGIN SELECT RAISE(ABORT,'scheduler instance identity is immutable'); END;
 CREATE TRIGGER ${prefix}_control_immutable BEFORE UPDATE ON ${prefix}_control_requests BEGIN SELECT RAISE(ABORT,'scheduler control receipt is immutable'); END;`);
});}
function row(db,id){uuid(id,'instance_id');if(!ready(db))fail('NOT_FOUND','未找到调度实例',404);const r=db.prepare(`SELECT * FROM ${prefix}_instances WHERE instance_id=?`).get(id);if(!r)fail('NOT_FOUND','未找到调度实例',404);return r;}
function current(db,r){const n=localIdentity(db);if(r.node_id!==n.node_id||r.node_epoch!==n.sync_epoch)fail('EPOCH_CHANGED','调度实例属于旧节点代次');return n;}
function register(db,{instanceId,pid,configDigest}){
 uuid(instanceId,'instance_id');if(!Number.isSafeInteger(pid)||pid<1||typeof configDigest!=='string'||!/^[0-9a-f]{64}$/.test(configDigest))fail('BAD_INPUT','调度实例标识无效',400);
 migrate(db);return atomic(db,()=>{const n=localIdentity(db),at=new Date().toISOString();db.prepare(`INSERT INTO ${prefix}_instances VALUES(?,?,?,?,?,?,?,'run',1,1,'running',NULL,NULL,NULL)`).run(instanceId,n.node_id,n.sync_epoch,pid,configDigest,at,at);return row(db,instanceId);});
}
function status(db,{instanceId=null,limit=20,now=Date.now()}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isFinite(now))fail('BAD_INPUT','状态查询范围无效',400);
 const n=localIdentity(db),configured=ready(db);if(instanceId!==null)uuid(instanceId,'instance_id');
 const rows=instanceId!==null?[row(db,instanceId)]:configured?db.prepare(`SELECT * FROM ${prefix}_instances ORDER BY started_at DESC,instance_id DESC LIMIT ?`).all(limit):[];
 return {format:`ai-fleet-${kind}-status/v1`,configured,node_id:n.node_id,node_epoch:n.sync_epoch,checked_at:new Date(now).toISOString(),process_liveness:'not_checked',instances:rows.map(r=>{
  const age=now-Date.parse(r.heartbeat_at),heartbeat_state=r.ended_at?'ended':!Number.isFinite(age)||age<0?'clock_unknown':age>10000?'stale':'recent';
  return {...r,identity_current:r.node_id===n.node_id&&r.node_epoch===n.sync_epoch,heartbeat_state,control_pending:r.observed_revision<r.revision,executor_stop_confirmed:r.state==='stopped'&&r.unconfirmed_runs===0};
 })};
}
function requestStop(db,{instanceId,expectedRevision,requestId,mode}){
 uuid(instanceId,'instance_id');uuid(requestId,'request_id');version(expectedRevision);if(!['drain','cancel'].includes(mode))fail('BAD_INPUT','只接受 drain 或 cancel',400);
 return atomic(db,()=>{
  const r=row(db,instanceId);current(db,r);const argsDigest=digest({instanceId,expectedRevision,mode}),prior=db.prepare(`SELECT * FROM ${prefix}_control_requests WHERE request_id=?`).get(requestId);
  if(prior){if(prior.instance_id!==instanceId||prior.args_digest!==argsDigest)fail('REQUEST_CONFLICT','同一请求号不能对应不同停止操作');return JSON.parse(prior.receipt_json);}
  if(r.revision!==expectedRevision)fail('CONFLICT','调度控制版本已变化');if(r.ended_at)fail('SCHEDULER_ENDED','调度实例已留下终态记录');
  if(r.requested_mode==='cancel'&&mode!=='cancel')fail('CONTROL_DOWNGRADE','不能把取消改回等待完成');if(r.revision>=Number.MAX_SAFE_INTEGER)fail('VERSION_EXHAUSTED','调度控制版本已达上限');
  const revision=r.revision+1,at=new Date().toISOString(),receipt={format:`ai-fleet-${kind}-control/v1`,request_id:requestId,instance_id:instanceId,node_id:r.node_id,node_epoch:r.node_epoch,mode,revision,state:'requested',requested_at:at,executor_stop_confirmed:false};
  db.prepare(`UPDATE ${prefix}_instances SET requested_mode=?,revision=? WHERE instance_id=?`).run(mode,revision,instanceId);
  db.prepare(`INSERT INTO ${prefix}_control_requests VALUES(?,?,?,?,?)`).run(requestId,instanceId,argsDigest,canonical(receipt),at);return receipt;
 });
}
function observe(db,instanceId){return atomic(db,()=>{
 const r=row(db,instanceId);current(db,r);if(r.ended_at)fail('SCHEDULER_ENDED','调度实例已经关闭');
 db.prepare(`UPDATE ${prefix}_instances SET heartbeat_at=?,observed_revision=revision,state=? WHERE instance_id=?`).run(new Date().toISOString(),{run:'running',drain:'draining',cancel:'cancelling'}[r.requested_mode],instanceId);
 return {mode:r.requested_mode,revision:r.revision,changed:r.observed_revision!==r.revision};
});}
function finish(db,instanceId,{unconfirmedRuns,errorCode=null}){return atomic(db,()=>{
 const r=row(db,instanceId);if(r.ended_at)return r;
 if(!Number.isSafeInteger(unconfirmedRuns)||unconfirmedRuns<0||errorCode!==null&&(typeof errorCode!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode)))fail('BAD_INPUT','调度终态无效',400);
 const n=localIdentity(db);if(n.node_id!==r.node_id||n.sync_epoch!==r.node_epoch)errorCode='EPOCH_CHANGED';
 const state=unconfirmedRuns||errorCode?'attention':'stopped',at=new Date().toISOString();
 db.prepare(`UPDATE ${prefix}_instances SET heartbeat_at=?,state=?,ended_at=?,unconfirmed_runs=?,error_code=? WHERE instance_id=?`).run(at,state,at,unconfirmedRuns,errorCode,instanceId);return row(db,instanceId);
});}

 return Object.freeze({register,status,requestStop,observe,finish});
}
const schedulerLifecycle=createLifecycleRegistry("scheduler");
export const {register:registerSchedulerInstance,status:schedulerStatus,requestStop:requestSchedulerStop,observe:observeSchedulerControl,finish:finishSchedulerInstance}=schedulerLifecycle;
