import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,relative,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {readFleetHealth,HEALTH_THRESHOLDS} from '../core/fleet-health.mjs';
import {migrateDispatch} from '../core/execution/dispatch.mjs';
import {registerSchedulerInstance} from '../core/execution/lifecycle.mjs';
const store=createRequire(import.meta.url)('../core/store.js'),TMP=mkdtempSync(join(tmpdir(),'fleet-health-')),dbs=[];let serial=0;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),codes=v=>v.issues.map(i=>i.code);
after(()=>{for(const db of dbs)db.close();const p=relative(resolve(tmpdir()),resolve(TMP));assert.ok(p&&!p.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
function fixture(){const path=join(TMP,'board-'+serial+++'.db'),db=new DatabaseSync(path);dbs.push(db);store.migrate(db);return {db,path,node:store.localNode(db)};}
function deliveries(f){
 // Synthetic persisted queue metadata. Real HTTP action transitions are covered in fleetactionstest.
 f.db.exec("CREATE TABLE fleet_operator_actions(action_id TEXT PRIMARY KEY,node_id TEXT,node_epoch TEXT,state TEXT,created_at TEXT,attempts INTEGER,summary_json TEXT)");
}
function action(f,state,created=new Date().toISOString(),epoch=f.node.sync_epoch){
 const id=randomUUID();f.db.prepare('INSERT INTO fleet_operator_actions VALUES(?,?,?,?,?,0,?)').run(id,f.node.node_id,epoch,state,created,'PRIVATE-DELIVERY-CONTENT');return id;
}
function dispatch(f,phase,created=new Date().toISOString(),epoch=f.node.sync_epoch){
 const id=randomUUID(),fields={dispatch_id:id,assignment_id:randomUUID(),node_id:f.node.node_id,node_epoch:epoch,task_id:1,task_uid:f.node.node_id+'/'+randomUUID(),run_id:randomUUID(),agent_instance_id:randomUUID(),worker:'fixture',role_id:'fixture',role_version:1,policy_digest:'0'.repeat(64),quota_id:randomUUID(),quota_version:1,execution_mode:'fixture',source_json:'PRIVATE-SOURCE',claimed_version:1,principal_id:randomUUID(),phase,created_at:created};
 const keys=Object.keys(fields);f.db.prepare('INSERT INTO broker_dispatches('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(fields));return id;
}
test('H3 health leaves legacy board bytes and schema unchanged, including inside caller transaction',()=>{
 const f=fixture(),before=hash(f.path),schema=f.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();f.db.exec('PRAGMA query_only=ON');
 let out=readFleetHealth(f.db);assert.deepEqual(out.issues,[]);assert.equal(out.modules.broker,'not_configured');assert.equal(out.executor_stop_confirmed,false);assert.equal(out.state_changes,false);
 f.db.exec('BEGIN');readFleetHealth(f.db);assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');
 assert.equal(hash(f.path),before);assert.deepEqual(f.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(),schema);
});
test('H3 broker observations distinguish fresh preparation, aged preparation, interruption and settled history',()=>{
 const f=fixture();migrateDispatch(f.db);const now=Date.now(),old=new Date(now-HEALTH_THRESHOLDS.broker_prepared_ms-1).toISOString();
 const a=dispatch(f,'prepared',old),b=dispatch(f,'interrupted',new Date(now).toISOString());dispatch(f,'prepared',new Date(now).toISOString());dispatch(f,'launch_committed',old);dispatch(f,'settled',old);dispatch(f,'abandoned',old);
 const before=hash(f.path),out=readFleetHealth(f.db,{now});
 assert.deepEqual(codes(out),['BROKER_INTERRUPTED','BROKER_PREPARED_STALE']);assert.equal(out.issues.find(i=>i.code==='BROKER_PREPARED_STALE').sample_ids[0],a);assert.equal(out.issues.find(i=>i.code==='BROKER_INTERRUPTED').sample_ids[0],b);
 assert.doesNotMatch(JSON.stringify(out),/PRIVATE-|fixture|fleet-health-/);assert.equal(hash(f.path),before);
});
test('H3 retry is a delayed notice, blocked is immediate, and retries do not continuously change alarm identity',()=>{
 const f=fixture();deliveries(f);const now=Date.now(),old=new Date(now-HEALTH_THRESHOLDS.delivery_retry_ms-1).toISOString();
 const id=action(f,'retry_pending',old);action(f,'retry_pending',new Date(now).toISOString());action(f,'blocked',new Date(now).toISOString());action(f,'acknowledged',old);
 const a=readFleetHealth(f.db,{now});assert.deepEqual(codes(a),['DELIVERY_BLOCKED','DELIVERY_RETRY_PENDING']);assert.equal(a.issues[1].level,'notice');assert.equal(a.issues[1].count,1);
 f.db.prepare('UPDATE fleet_operator_actions SET attempts=99 WHERE action_id=?').run(id);
 assert.deepEqual(readFleetHealth(f.db,{now:now+1000}).issues,a.issues);
 f.db.prepare("UPDATE fleet_operator_actions SET state='acknowledged'").run();assert.deepEqual(readFleetHealth(f.db,{now}).issues,[]);
});
test('H3 old epochs and future clocks remain observable without diagnosing a timeout',()=>{
 const f=fixture();deliveries(f);action(f,'retry_pending','2999-01-01T00:00:00Z');action(f,'blocked',new Date().toISOString(),randomUUID());
 assert.deepEqual(codes(readFleetHealth(f.db)),['CLOCK_UNKNOWN','STALE_EPOCH_RECORD']);
});
test('H3 stored attention and stale heartbeat do not assert process or executor termination',()=>{
 const f=fixture(),id=randomUUID();registerSchedulerInstance(f.db,{instanceId:id,pid:process.pid,configDigest:'0'.repeat(64)});
 const row=f.db.prepare('SELECT * FROM scheduler_instances').get(),before=hash(f.path),out=readFleetHealth(f.db,{now:Date.parse(row.heartbeat_at)+61000});
 assert.ok(codes(out).includes('SCHEDULER_HEARTBEAT_STALE'));assert.ok(codes(out).includes('SCHEDULER_LOCK_MISSING'));assert.equal(out.executor_stop_confirmed,false);assert.equal(hash(f.path),before);
 f.db.prepare("UPDATE scheduler_instances SET state='attention',ended_at=?,unconfirmed_runs=1").run(new Date().toISOString());
 assert.deepEqual(codes(readFleetHealth(f.db)),['SCHEDULER_ATTENTION']);
});
test('H3 malformed and unmatched locks are reported without removing or exposing file contents',()=>{
 const f=fixture(),lock=join(TMP,'.'+basename(f.path)+'.fleet-scheduler.lock');writeFileSync(lock,'PRIVATE-LOCK-PATH-TOKEN');
 const before=hash(lock);assert.deepEqual(codes(readFleetHealth(f.db)),['SCHEDULER_LOCK_UNREADABLE']);assert.equal(hash(lock),before);
 writeFileSync(lock,JSON.stringify({id:randomUUID(),pid:process.pid,node_id:f.node.node_id,node_epoch:f.node.sync_epoch,private:'PRIVATE-LOCK-PATH-TOKEN'}));
 const out=readFleetHealth(f.db,{now:Date.now()+61000});assert.ok(codes(out).includes('SCHEDULER_LOCK_MISMATCH'));assert.equal(out.lock_observation.pid_observation,'present_not_identity_verified');assert.equal(out.executor_stop_confirmed,false);assert.doesNotMatch(JSON.stringify(out),/PRIVATE-|fleet-health-/);
});
test('H3 unknown schemas and malformed state fail visibly and preserve caller transactions',()=>{
 const f=fixture();migrateDispatch(f.db);f.db.exec('BEGIN; UPDATE broker_dispatch_schema SET version=999');
 assert.throws(()=>readFleetHealth(f.db),{code:'SCHEMA_INCOMPATIBLE'});assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');assert.deepEqual(readFleetHealth(f.db).issues,[]);
 const g=fixture();deliveries(g);action(g,'blocked',new Date().toISOString(),'not-an-epoch');assert.throws(()=>readFleetHealth(g.db),{code:'RECORD_CORRUPT'});
});
test('H3 capped scans never return a false complete healthy result',()=>{
 const f=fixture();deliveries(f);f.db.exec('BEGIN');for(let i=0;i<10001;i++)action(f,'blocked');f.db.exec('COMMIT');
 assert.throws(()=>readFleetHealth(f.db),{code:'INSPECTION_LIMIT'});
});

import {createLifecycleRegistry} from '../core/execution/lifecycle.mjs';
const nodeRegistry=createLifecycleRegistry('node-runtime');
function nodeInstance(f){const id=randomUUID();nodeRegistry.register(f.db,{instanceId:id,pid:process.pid,configDigest:'0'.repeat(64)});f.db.exec('CREATE TABLE node_runtime_components(instance_id TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,summary_json TEXT NOT NULL,PRIMARY KEY(instance_id,name))');writeFileSync(join(TMP,'.'+basename(f.path)+'.fleet-node-runtime.lock'),JSON.stringify({instance_id:id,pid:process.pid,node_id:f.node.node_id,node_epoch:f.node.sync_epoch}));return id;}
function nodeComponent(f,id,name,state,now,summary={}){f.db.prepare('INSERT OR REPLACE INTO node_runtime_components VALUES(?,?,?,?,?)').run(id,name,state,new Date(now).toISOString(),JSON.stringify(summary));}
test('node health covers the separate runtime lifecycle and retains its lock during a stale-heartbeat alert',()=>{
 const f=fixture(),id=nodeInstance(f),now=Date.now();nodeComponent(f,id,'peer','listening',now,{host:'PRIVATE-HOST',port:47925});const lock=join(TMP,'.'+basename(f.path)+'.fleet-node-runtime.lock'),before=hash(f.path),lockHash=hash(lock);f.db.exec('PRAGMA query_only=ON');const out=readFleetHealth(f.db,{now:now+61000});assert.equal(out.format,'ai-fleet-health/v3');assert.equal(out.modules.node_runtime,'available');assert.ok(codes(out).includes('NODE_HEARTBEAT_STALE'));assert.equal(out.node_lock_observation.pid_observation,'present_not_identity_verified');assert.equal(out.executor_stop_confirmed,false);assert.equal(hash(f.path),before);assert.equal(hash(lock),lockHash);assert.doesNotMatch(JSON.stringify(out),/PRIVATE|fleet-health-/);
});
test('node health distinguishes sync retry, pending backlog and missing fresh observations without claiming remote failure',()=>{
 const f=fixture(),id=nodeInstance(f),now=Date.now(),name='sync:'+randomUUID()+':private-project';nodeComponent(f,id,name,'error',now,{error_code:'REMOTE_401',credential:'PRIVATE-TOKEN'});const a=readFleetHealth(f.db,{now});assert.ok(codes(a).includes('NODE_SYNC_RETRY'));assert.equal(a.remote_state,'not_queried');assert.equal(a.issues.find(i=>i.code==='NODE_SYNC_RETRY').level,'notice');assert.doesNotMatch(JSON.stringify(a),/PRIVATE|private-project|REMOTE_401/);
 nodeComponent(f,id,name,'backoff',now+1,{error_code:'REMOTE_401'});assert.equal(readFleetHealth(f.db,{now:now+1}).issues.find(i=>i.code==='NODE_SYNC_RETRY').fingerprint,a.issues.find(i=>i.code==='NODE_SYNC_RETRY').fingerprint);nodeComponent(f,id,name,'pending',now+2);assert.deepEqual(codes(readFleetHealth(f.db,{now:now+2})),['NODE_SYNC_PENDING']);nodeComponent(f,id,name,'synced',now+3);assert.deepEqual(codes(readFleetHealth(f.db,{now:now+3})),[]);f.db.prepare('UPDATE node_runtime_instances SET heartbeat_at=?').run(new Date(now+61010).toISOString());assert.deepEqual(codes(readFleetHealth(f.db,{now:now+61010})),['NODE_SYNC_OBSERVATION_STALE']);f.db.prepare('UPDATE node_runtime_instances SET heartbeat_at=?').run(new Date(now+120000).toISOString());assert.deepEqual(codes(readFleetHealth(f.db,{now:now+61010})),['CLOCK_UNKNOWN']);
});
test('node health reports attention after exit and rejects unknown schema or malformed component data',()=>{
 const f=fixture(),id=nodeInstance(f),now=Date.now();nodeComponent(f,id,'peer','listening',now);f.db.exec('BEGIN; UPDATE node_runtime_lifecycle_schema SET version=999');assert.throws(()=>readFleetHealth(f.db),{code:'SCHEMA_INCOMPATIBLE'});assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');f.db.prepare("UPDATE node_runtime_components SET summary_json='PRIVATE-NOT-JSON'").run();assert.throws(()=>readFleetHealth(f.db),{code:'RECORD_CORRUPT'});f.db.prepare("UPDATE node_runtime_components SET summary_json='{}'").run();nodeRegistry.finish(f.db,id,{unconfirmedRuns:1,errorCode:'FIXTURE_ERROR'});assert.ok(codes(readFleetHealth(f.db)).includes('NODE_ATTENTION'));
});

import {putQuota} from '../core/execution/dispatch.mjs';
import {migrateWorkspaces} from '../core/artifacts/workspaces.mjs';
import {directoryIdentity} from '../core/artifacts/git-workspace.mjs';
const plenty=()=>({bsize:4096n,blocks:1024n*1024n,bavail:1024n*512n});
function quota(f,total=1){migrateDispatch(f.db);const id=randomUUID();putQuota(f.db,{quota_id:id,runtime:'codex',execution_mode:'fixture',projects:['private-project'],limit_total:total,enabled:true});return id;}
test('capacity health counts prepared reservations without consuming or refunding calls',()=>{
 const f=fixture(),id=quota(f),d=dispatch(f,'prepared');f.db.prepare('UPDATE broker_call_quotas SET quota_id=? WHERE quota_id=?').run(f.db.prepare('SELECT quota_id FROM broker_dispatches WHERE dispatch_id=?').get(d).quota_id,id);const before=hash(f.path);let out=readFleetHealth(f.db,{diskProbe:plenty});assert.equal(out.modules.call_budget,'available');assert.ok(codes(out).includes('CALL_BUDGET_EXHAUSTED'));assert.equal(hash(f.path),before);assert.doesNotMatch(JSON.stringify(out),/private-project|codex|PRIVATE/);
 f.db.prepare("UPDATE broker_dispatches SET phase='abandoned'").run();assert.ok(!codes(readFleetHealth(f.db,{diskProbe:plenty})).includes('CALL_BUDGET_EXHAUSTED'));f.db.prepare('UPDATE broker_call_quotas SET used=2').run();assert.ok(codes(readFleetHealth(f.db,{diskProbe:plenty})).includes('CALL_BUDGET_OVERRUN'));assert.equal(f.db.prepare('SELECT used FROM broker_call_quotas').get().used,2);
});
test('capacity health observes disk pressure and probe failures without leaking paths or writing data',()=>{
 const f=fixture(),before=hash(f.path),low=()=>({bsize:4096n,blocks:1024n*1024n,bavail:1n});let out=readFleetHealth(f.db,{diskProbe:low});assert.ok(codes(out).includes('STORAGE_LOW'));assert.equal(out.storage_observation.targets_checked,1);const fp=out.issues.find(i=>i.code==='STORAGE_LOW').fingerprint;assert.equal(readFleetHealth(f.db,{diskProbe:()=>({...low(),bavail:2n})}).issues.find(i=>i.code==='STORAGE_LOW').fingerprint,fp);
 out=readFleetHealth(f.db,{diskProbe:()=>{throw Error('PRIVATE-PATH-TOKEN');}});assert.ok(codes(out).includes('STORAGE_UNAVAILABLE'));assert.doesNotMatch(JSON.stringify(out),/PRIVATE|fleet-health-/);assert.ok(!codes(readFleetHealth(f.db,{diskProbe:plenty})).includes('STORAGE_LOW'));assert.equal(hash(f.path),before);
});
test('capacity health includes retained workspace pools and verifies real Windows volume observation',()=>{
 const f=fixture();migrateDispatch(f.db);migrateWorkspaces(f.db);const id=randomUUID(),identity=directoryIdentity(TMP);f.db.prepare('INSERT INTO workspace_pools VALUES(?,?,?,?,?,?)').run(id,f.node.node_id,randomUUID(),randomUUID(),JSON.stringify({identity,allow_full_history_copy:true}),new Date().toISOString());const out=readFleetHealth(f.db);assert.equal(out.modules.storage,'available');assert.equal(out.storage_observation.targets_checked,2);assert.equal(out.storage_observation.targets_unavailable,0);assert.equal(out.storage_observation.measurement,'filesystem_available_bytes');assert.equal(out.state_changes,false);assert.doesNotMatch(JSON.stringify(out),/fleet-health-|[A-Z]:\\/);
});
