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
