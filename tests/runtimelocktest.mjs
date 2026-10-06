import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createLifecycleRegistry,openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {runNodeRuntime} from '../core/node-runtime.mjs';
import {localIdentity} from '../core/federation/peers.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-lock-recovery-')),store=createRequire(import.meta.url)('../core/store.js'),dbs=[];
const moduleURL=new URL('../core/execution/runtime-lock-recovery.mjs',import.meta.url),api=existsSync(moduleURL)?await import(moduleURL):{};
after(()=>{for(const db of dbs)try{db.close();}catch{}const r=relative(resolve(tmpdir()),resolve(TMP));assert.ok(r&&!r.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(TMP,'node-')),path=join(dir,'board.db'),db=new DatabaseSync(path);dbs.push(db);store.migrate(db);const n=localIdentity(db);return {dir,path,db,n,config:{format:'ai-fleet-node-runtime/v1',node_id:n.node_id,node_epoch:n.sync_epoch,peer:{host:'127.0.0.1',port:0},mcp:null,sync:[],scheduler:null}};}
function apiReady(){assert.equal(typeof api.prepareRuntimeLockRecovery,'function','an audited recovery path must exist');assert.equal(typeof api.applyRuntimeLockRecovery,'function');}
function crash(f){const script=join(f.dir,'crash.mjs');writeFileSync(script,`import {runNodeRuntime} from ${JSON.stringify(new URL('../core/node-runtime.mjs',import.meta.url).href)};await runNodeRuntime({dbPath:process.argv[2],config:JSON.parse(process.argv[3]),sourceGate:{check:()=>({})},onEvent:e=>{if(e.kind==='started')process.exit(77);}});`);const r=spawnSync(process.execPath,[script,f.path,JSON.stringify(f.config)],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,77,r.stderr);const row=f.db.prepare('SELECT * FROM node_runtime_instances').get();return {kind:'node-runtime',instanceId:row.instance_id,lock:join(f.dir,'.board.db.fleet-node-runtime.lock'),row};}
function register(f,{kind='scheduler',pid=process.pid}={}){const id=randomUUID(),reg=createLifecycleRegistry(kind);reg.register(f.db,{instanceId:id,pid,configDigest:'0'.repeat(64)});const record={...(kind==='scheduler'?{id,at:new Date().toISOString()}:{instance_id:id}),pid,node_id:f.n.node_id,node_epoch:f.n.sync_epoch},lock=join(f.dir,'.board.db.fleet-'+kind+'.lock');writeFileSync(lock,JSON.stringify(record)+'\n');return {kind,instanceId:id,lock,reg};}
const plan=(f,x)=>api.prepareRuntimeLockRecovery(f.db,x);
const apply=(f,p)=>api.applyRuntimeLockRecovery(f.db,{plan:p,expectedPlanDigest:p.plan_digest});

test('crashed node host has a read-only recovery plan and audited unlock enables an explicit restart',async()=>{
 const f=fixture(),x=crash(f);await assert.rejects(runNodeRuntime({dbPath:f.path,config:f.config,sourceGate:{check:()=>({})}}),{code:'NODE_RUNTIME_BUSY'});apiReady();
 const before=f.db.prepare('SELECT total_changes() n').get().n,ro=openSchedulerControlDatabase(f.path,{readOnly:true});let p;try{p=api.prepareRuntimeLockRecovery(ro,x);}finally{ro.close();}assert.equal(p.host_process_state,'absent');assert.deepEqual(p.blockers,[]);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='runtime_lock_recoveries'").get().n,0);
 const r=apply(f,p);assert.equal(r.cleanup,'deleted');assert.equal(r.receipt.automatic_restart,false);assert.equal(r.receipt.accepted,false);assert.equal(existsSync(x.lock),false);assert.equal(f.db.prepare('SELECT state FROM node_runtime_instances WHERE instance_id=?').get(x.instanceId).state,'attention');assert.deepEqual(apply(f,p).receipt,r.receipt);
 let replay,callbackError,lockKept;const stop=new AbortController();await runNodeRuntime({dbPath:f.path,config:f.config,sourceGate:{check:()=>({})},stopSignal:stop.signal,onEvent:e=>{if(e.kind==='started'){try{replay=apply(f,p);lockKept=existsSync(x.lock);}catch(e){callbackError=e;}finally{stop.abort();}}}});assert.equal(callbackError,undefined);assert.equal(lockKept,true);assert.ok(['changed','busy'].includes(replay.cleanup));assert.equal(f.db.prepare('SELECT count(*) n FROM runtime_lock_recoveries').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});

test('live or reused PID and unresolved execution block recovery without clearing the lock',()=>{
 apiReady();const live=fixture(),x=register(live),p=plan(live,x);assert.equal(p.host_process_state,'present');assert.ok(p.blockers.some(b=>b.kind==='host_process_present'));assert.throws(()=>apply(live,p),{code:'LOCK_RECOVERY_BLOCKED'});assert.equal(existsSync(x.lock),true);
 const f=fixture(),dead=crash(f),id=store.add(f.db,{subject:'unfinished legacy run'}),uid=store.get(f.db,id).task_uid,run=randomUUID(),at=new Date().toISOString();f.db.prepare("INSERT INTO task_runs(run_id,task_id,task_uid,owner_node_id,executor_node_id,worker,role_id,policy_json,policy_sha256,started_at,first_attempt,last_attempt,state) VALUES(?,?,?,?,?,'fixture','fixture','{}','fixture',?,1,1,'running')").run(run,id,uid,f.n.node_id,f.n.node_id,at);const blocked=plan(f,dead);assert.ok(blocked.blockers.some(b=>b.kind==='unmanaged_run'));assert.throws(()=>apply(f,blocked),{code:'LOCK_RECOVERY_BLOCKED'});assert.equal(existsSync(dead.lock),true);assert.equal(f.db.prepare('SELECT state FROM task_runs WHERE run_id=?').get(run).state,'running');
});

test('changed lock and instance state refuse stale recovery and a failed audit commit retains the original lock',()=>{
 apiReady();const f=fixture(),x=crash(f),p=plan(f,x),bytes=readFileSync(x.lock),replacement=JSON.stringify({...p.lock_record,pid:process.pid});writeFileSync(x.lock,replacement);assert.throws(()=>apply(f,p),{code:'LOCK_RECOVERY_CHANGED'});assert.equal(readFileSync(x.lock,'utf8'),replacement);writeFileSync(x.lock,bytes);
 f.db.prepare('UPDATE node_runtime_instances SET revision=revision+1 WHERE instance_id=?').run(x.instanceId);assert.throws(()=>apply(f,p),{code:'PLAN_STALE'});const newer=plan(f,x);f.db.exec("CREATE TRIGGER reject_recovery_finish BEFORE UPDATE ON node_runtime_instances BEGIN SELECT RAISE(ABORT,'fixture rejected'); END");assert.throws(()=>apply(f,newer),/fixture rejected/);assert.deepEqual(readFileSync(x.lock),bytes);assert.equal(f.db.prepare('SELECT ended_at FROM node_runtime_instances').get().ended_at,null);assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='runtime_lock_recoveries'").get().n,0);
});

test('scheduler lock recovery CLI preserves evidence and applies only the explicitly supplied plan digest',()=>{
 apiReady();const f=fixture(),pidRun=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8',windowsHide:true}),pid=Number(pidRun.stdout.trim());assert.equal(pidRun.status,0);const x=register(f,{pid}),cli=(args)=>spawnSync(process.execPath,[join(ROOT,'cli/runtime-lock.mjs'),...args,'--db',f.path],{encoding:'utf8',windowsHide:true,timeout:15000});
 const p=cli(['prepare','--kind','scheduler','--instance',x.instanceId]);assert.equal(p.status,0,p.stderr);const parsed=JSON.parse(p.stdout),file=join(f.dir,'plan.json');writeFileSync(file,p.stdout);const wrong=cli(['apply','--plan-file',file,'--digest','0'.repeat(64)]);assert.equal(wrong.status,1);assert.equal(JSON.parse(wrong.stderr).code,'PLAN_MISMATCH');assert.equal(existsSync(x.lock),true);
 const r=cli(['apply','--plan-file',file,'--digest',parsed.plan_digest]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).cleanup,'deleted');assert.equal(readFileSync(file,'utf8'),p.stdout);assert.throws(()=>f.db.exec('DELETE FROM runtime_lock_recoveries'),/retained/);assert.throws(()=>f.db.exec("UPDATE runtime_lock_recoveries SET receipt_json='{}'"),/immutable/);
});


test('cleanup failure keeps the committed recovery and the same plan retries only its original lock',()=>{
 apiReady();const f=fixture(),x=crash(f),p=plan(f,x),root=process.env.SystemRoot,bytes=readFileSync(x.lock);let first;
 try{process.env.SystemRoot=join(f.dir,'missing-windows');first=apply(f,p);}finally{process.env.SystemRoot=root;}
 assert.equal(first.cleanup,'unavailable');assert.equal(first.lock_released,false);assert.deepEqual(readFileSync(x.lock),bytes);assert.equal(f.db.prepare('SELECT count(*) n FROM runtime_lock_recoveries').get().n,1);
 const again=apply(f,p);assert.deepEqual(again.receipt,first.receipt);assert.equal(again.cleanup,'deleted');assert.equal(again.lock_released,true);assert.equal(f.db.prepare('SELECT count(*) n FROM runtime_lock_recoveries').get().n,1);
});
