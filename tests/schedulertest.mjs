import {issueCredential,fixtureEndpoint} from "./helpers/peer-network.mjs";
import {readFleetHealth} from '../core/fleet-health.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,cpSync,readdirSync,realpathSync,unlinkSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {openSchedulerControlDatabase,schedulerStatus,requestSchedulerStop} from '../core/execution/lifecycle.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {migrateSync} from '../core/federation/sync-store.mjs';
import {localIdentity,migratePeers} from "../core/federation/peers.mjs";
import net from 'node:net';
import {runNodeRuntime,nodeRuntimeStatus,nodeLifecycle} from '../core/node-runtime.mjs';
import {migrateDispatch,putQuota,quotaStatus} from '../core/execution/dispatch.mjs';
import {putRole,issuePrincipal,revokePrincipal} from '../core/mcp/policy.mjs';
import {callTool} from '../core/mcp/tools.mjs';
import {openScheduler} from '../core/execution/scheduler.mjs';
import {createBackup,restoreBackup} from '../core/backup.mjs';
import {prepareRecovery,activateRecovery,retireNode} from '../core/recovery.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {pinFile} from '../core/execution/supervisor.mjs';
import {registerRepository} from '../core/artifacts/repositories.mjs';
import {migrateWorkspaces,registerWorkspacePool} from '../core/artifacts/workspaces.mjs';
const store=createRequire(import.meta.url)('../core/store.js'),ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-scheduler-'));
const dbs=[],schedulers=[],git=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const source=join(TMP,'governance');mkdirSync(source);for(const d of ['core','cli'])cpSync(join(ROOT,d),join(source,d),{recursive:true});
git(source,['init','--quiet','--template=']);git(source,['config','core.autocrlf','false']);git(source,['add','.']);git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);
const approval=join(TMP,'accepted-fixture');writeFileSync(approval,git(source,['rev-parse','HEAD:']));
const gate=createSourceGate({codeRoot:source,approvalFile:approval});
const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||'python',['-I','-S','-X','utf8','-c','import sys; print(sys.executable)'],{encoding:'utf8',windowsHide:true}).trim());
const environment=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp'].includes(k.toLowerCase())));
after(()=>{for(const s of schedulers)try{s.close();}catch{}for(const d of dbs)try{d.close();}catch{}const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
function fixture({limit=5,max=1,wait=0,capability='board-tools'}={}){
 const base=mkdtempSync(join(TMP,'case-')),dbPath=join(base,'board.db'),setup=new DatabaseSync(dbPath);
 try{store.migrate(setup);migrateSync(setup);migrateDispatch(setup);}finally{setup.close();}
 // Observe a concurrently running scheduler through the same bounded policy as its control CLI.
 const db=openSchedulerControlDatabase(dbPath);dbs.push(db);
 const limits={max_task_attempts:2,max_open_tasks:100,requests_per_minute:300};
 putRole(db,{role_id:'coordinator',kind:'coordinate',projects:['demo'],capabilities:[],runtime:null,model:null,effort:null,tools:'write',priority:10,enabled:true,limits});
 putRole(db,{role_id:'engine',kind:'implement',projects:['demo'],capabilities:[capability],runtime:'zcode',model:'GLM-5.3',effort:'low',tools:'write',priority:10,enabled:true,limits});
 const coordFile=join(base,'coord.json'),principal=issuePrincipal(db,{roleId:'coordinator',projects:['demo'],credentialFile:coordFile}),auth='Bearer '+JSON.parse(readFileSync(coordFile,'utf8')).token;
 const q=putQuota(db,{quota_id:randomUUID(),runtime:'zcode',execution_mode:'provider',projects:['demo'],limit_total:limit,enabled:true});
 const authHome=join(base,'auth','.zcode','v2');mkdirSync(authHome,{recursive:true});
 const bundle=join(base,'synthetic.cjs'),builtin=join(base,'builtin.json'),marker=join(base,'started.log');
 writeFileSync(bundle,"const fs=require('node:fs');fs.appendFileSync("+JSON.stringify(marker)+",String(process.pid)+'\\n');const input=process.argv[process.argv.indexOf('--prompt')+1],out=e=>process.stdout.write(JSON.stringify(e)+'\\n'),e=(type,seq,payload)=>({type,seq,eventId:'event'+seq,sessionId:'fixture',turnId:'turn',traceId:'trace',timestamp:seq,payload});out(e('turn.started',1,{input}));out(e('session.updated',2,{providerId:'account:bigmodel-individual-coding-plan',modelId:'GLM-5.3',messageCount:1,toolCount:5,iteration:0}));setTimeout(()=>{out(e('turn.completed',3,{resultType:'success',response:'synthetic only'}));out({type:'result',sessionId:'fixture',turnId:'turn',traceId:'trace',response:'synthetic only',eventCount:3,projection:{status:'completed',turnCount:1,totalTokenCount:0}});},"+wait+");");
 writeFileSync(builtin,JSON.stringify({schemaVersion:1,revision:30,config:{providerConfigRules:{templateRules:[],providerRules:[{providerId:'account:bigmodel-individual-coding-plan',config:{group:'bigmodel-family',builtinModelIds:['GLM-5.3'],access:{type:'zhipu-account',accountType:'bigmodel',mode:'individual-coding-plan'},api:{type:'anthropic-messages',baseUrl:'https://open.bigmodel.cn/api/anthropic'}}}]},modelConfigRules:{modelRules:[],modelApiRules:[],providerSiteRules:[],templateModelRules:[],builtinProviderModelRules:[]}}}));
 const n=localIdentity(db),config={format:'ai-fleet-scheduler/v1',node_id:n.node_id,node_epoch:n.sync_epoch,root:join(base,'运行 根 & private'),max_active:max,poll_ms:1000,profiles:[{project_id:'demo',role_id:'engine',quota_id:q.quota_id,installation:{runtime:'zcode',version:'0.16.9',program:pinFile(process.execPath),bundle:pinFile(bundle),builtin_config:pinFile(builtin),auth_home:authHome},python,node:pinFile(process.execPath),mcp_url:'http://127.0.0.1:43111',timeout_ms:10000,workspace:null}]};
 return {base,db,dbPath,auth,principal,q,config,marker,capability,events:[]};
}
function card(f,{release=true}={}){
 const c=callTool(f.db,f.auth,'create_task',{request_id:randomUUID(),project_id:'demo',kind:'task',subject:'synthetic task',description:'PRIVATE-TASK-BODY',acceptance:'synthetic receipt only',work_kind:'implement',required_capabilities:[f.capability]}).task;
 if(release)store.setReleased(f.db,{id:c.id,expectedVersion:c.aggregate_version,released:true});
 const t=store.get(f.db,c.id),a=callTool(f.db,f.auth,'request_assignment',{request_id:randomUUID(),task_uid:t.task_uid,expected_version:t.aggregate_version});return {t,a};
}
function open(f,extra={}){const s=openScheduler(f.db,{dbPath:f.dbPath,sourceGate:gate,config:f.config,environment,onEvent:e=>f.events.push(e),...extra});schedulers.push(s);return s;}
const used=f=>quotaStatus(f.db,f.q.quota_id).used;
const launches=f=>f.db.prepare('SELECT count(*) n FROM broker_execution_records').get().n;
async function started(f){const deadline=Date.now()+10000;while(!existsSync(f.marker)){if(Date.now()>deadline)throw Error('Synthetic process did not start');await delay(30);}}

test('queue request reaches an actual supervised synthetic process once and remains awaiting acceptance',async()=>{
 const f=fixture({limit:1}),{t}=card(f),s=open(f),r=await s.tick();assert.equal(r.results[0].phase,'settled');assert.equal(used(f),1);assert.equal(launches(f),1);
 const d=f.db.prepare('SELECT * FROM broker_dispatches').get(),o=JSON.parse(f.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json);
 assert.equal(o.process.cleanup,'job_empty');assert.equal(o.real_model_call_confirmed,false);assert.equal(store.get(f.db,t.id).waiting_for,'review');assert.equal(JSON.parse(d.result_json).accepted,false);
 await s.tick();s.close();const next=open(f);await next.tick();assert.equal(used(f),1);assert.equal(launches(f),1);assert.ok(!JSON.stringify(f.events).includes('PRIVATE-TASK-BODY'));next.close();
});
test('bounded concurrent batch consumes only available explicit quota and leaves excess request pending',async()=>{
 const f=fixture({limit:2,max:2,wait:300});for(let i=0;i<3;i++)card(f);const s=open(f),r=await s.tick();
 assert.equal(r.results.length,2);assert.equal(used(f),2);assert.equal(launches(f),2);assert.equal(r.inflight,0);
 await s.tick();assert.equal(used(f),2);assert.equal(f.db.prepare("SELECT count(*) n FROM broker_assignments WHERE state='waiting_executor'").get().n,1);s.close();
});
test('watch observes a later MCP request without restarting and drains on requested stop',async()=>{
 const f=fixture({limit:2}),stop=new AbortController();card(f);let settled=0;
 const s=open(f,{onEvent:e=>{f.events.push(e);if(e.kind==='settled'){settled++;if(settled===1)card(f);else stop.abort();}}});
 const timeout=setTimeout(()=>stop.abort(),15000);try{await s.watch({stopSignal:stop.signal});}finally{clearTimeout(timeout);}
 assert.equal(settled,2);assert.equal(used(f),2);assert.equal(f.events.at(-1).kind,'stopped');s.close();
});
test('disabled quota waits without claiming; explicit quota enable permits the same request',async()=>{
 const f=fixture({limit:1});card(f);putQuota(f.db,{quota_id:f.q.quota_id,runtime:'zcode',execution_mode:'provider',projects:['demo'],limit_total:1,enabled:false},1);
 const s=open(f);await s.tick();assert.equal(used(f),0);assert.equal(launches(f),0);assert.equal(readdirSync(f.config.root).length,1);
 putQuota(f.db,{quota_id:f.q.quota_id,runtime:'zcode',execution_mode:'provider',projects:['demo'],limit_total:1,enabled:true},2);
 await s.tick();assert.equal(used(f),1);s.close();
});
test('unreleased tasks and revoked coordinators never become runnable by polling',async()=>{
 const f=fixture();card(f,{release:false});card(f);const s=open(f);revokePrincipal(f.db,{principalId:f.principal.principal_id,expectedVersion:1});
 await s.tick();await s.tick();assert.equal(used(f),0);assert.equal(f.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);assert.equal(f.events.filter(e=>e.code==='AUTHORIZATION_CHANGED').length,1);s.close();
});
test('dirty governance and altered node configuration fail without consuming model quota',async()=>{
 const f=fixture();card(f);const bad=structuredClone(f.config);bad.node_id=randomUUID();assert.throws(()=>open(f,{config:bad}),{code:'EPOCH_CHANGED'});
 const s=open(f),dirty=join(source,'dirty.txt');writeFileSync(dirty,'fixture change');try{await assert.rejects(s.tick(),{code:'SOURCE_DIRTY'});}finally{unlinkSync(dirty);}
 assert.equal(used(f),0);assert.equal(launches(f),0);s.close();
});
test('canonical database singleton lock rejects another root and preserves the existing owner',()=>{
 const f=fixture(),s=open(f),other=structuredClone(f.config);other.root=join(f.base,'other-root');
 const next=new DatabaseSync(f.dbPath);dbs.push(next);
 assert.throws(()=>openScheduler(next,{dbPath:f.dbPath,sourceGate:gate,config:other,environment}),{code:'SCHEDULER_BUSY'});assert.equal(existsSync(other.root),false);s.close();
});
test('stop requested after preparation drains the launched task and leaves the next task pending',async()=>{
 const f=fixture({max:2,wait:300}),stop=new AbortController();card(f);card(f);
 const s=open(f,{onEvent:e=>{f.events.push(e);if(e.kind==='prepared')stop.abort();}});
 const r=await s.tick({stopSignal:stop.signal});assert.equal(used(f),1);assert.equal(r.results.length,1);assert.equal(r.results[0].phase,'settled');assert.equal(f.events.find(e=>e.kind==='settled').result,'success');s.close();
});
test('explicit active cancellation observes native Job cleanup without refunding its permit',async()=>{
 const f=fixture({wait:9000}),cancel=new AbortController();card(f);const s=open(f),running=s.tick({cancelSignal:cancel.signal});
 await started(f);cancel.abort();await running;
 const o=JSON.parse(f.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json);
 assert.equal(o.status,'cancelled');assert.equal(o.process.cleanup,'job_empty');assert.equal(used(f),1);s.close();
});
test('settlement failure preserves journal and blocks another start until explicit reconciliation',async()=>{
 const f=fixture({limit:2}),one=card(f);card(f);const s=open(f);
 f.db.exec("CREATE TRIGGER reject_settle BEFORE INSERT ON broker_dispatch_events WHEN NEW.kind='settled' BEGIN SELECT RAISE(ABORT,'fixture database failure'); END");
 const r=await s.tick();assert.equal(r.results[0].phase,'attention');assert.equal(used(f),1);assert.equal(r.inflight,1);
 await s.tick();assert.equal(used(f),1);f.db.exec('DROP TRIGGER reject_settle');
 assert.equal(s.reconcile(one.a.assignment_id).launched,false);assert.equal(s.reconcile(one.a.assignment_id).phase,'settled');assert.equal(used(f),1);
 await s.tick();assert.equal(used(f),2);s.close();
});
test('prelaunch adapter refusal abandons only the unlaunched reservation and retains its files',async()=>{
 const f=fixture();const {t,a}=card(f),s=open(f);writeFileSync(join(f.config.root,'.env'),'fixture marker');
 const r=await s.tick();assert.equal(r.results[0].code,'STARTUP_CONFIG_PRESENT');assert.equal(used(f),0);assert.equal(launches(f),0);
 assert.equal(f.db.prepare('SELECT phase FROM broker_dispatches').get().phase,'abandoned');assert.equal(store.get(f.db,t.id).waiting_for,'decision');
 assert.equal(existsSync(join(f.config.root,a.assignment_id,'private','principal.json')),true);s.close();
});
test('workspace profile provisions the registered Git baseline and binds its file session to the launch',async()=>{
 const f=fixture({capability:'workspace-files'}),repo=join(f.base,'repository'),pool=join(f.base,'pool');mkdirSync(repo);mkdirSync(pool);mkdirSync(join(repo,'src'));writeFileSync(join(repo,'src','example.txt'),'original');
 git(repo,['init','--quiet','--template=']);git(repo,['-c','core.autocrlf=false','add','.']);git(repo,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base']);const commit=git(repo,['rev-parse','HEAD']);
 const execPath=execFileSync('git',['--exec-path'],{encoding:'utf8',windowsHide:true}).trim(),gitPin=pinFile(realpathSync.native(join(execPath,'../../bin/git.exe')));
 const mapping=registerRepository(f.db,{mappingId:randomUUID(),projectId:'demo',repoId:'app',root:repo,git:gitPin,baseCommit:commit,paths:['src/']});migrateWorkspaces(f.db);const poolId=randomUUID();registerWorkspacePool(f.db,{poolId,mappingId:mapping.mapping_id,root:pool,allowFullHistoryCopy:true});
 f.config.profiles[0].workspace={pool_id:poolId,base_commit:commit,write_paths:['src/']};card(f);const s=open(f),r=await s.tick();
 assert.equal(r.results[0].phase,'settled',JSON.stringify(r));assert.equal(used(f),1);assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_sessions').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_launches').get().n,1);assert.equal(f.db.prepare('SELECT written_bytes FROM workspace_sessions').get().written_bytes,0);s.close();
});

test('actual scheduler CLI executes a queued synthetic task with the same source gate and receipt contract',()=>{
 const f=fixture({limit:1});card(f);const configFile=join(f.base,'scheduler.json');writeFileSync(configFile,JSON.stringify(f.config));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp','path','pathext','pythonutf8'].includes(k.toLowerCase())));
 const out=execFileSync(process.execPath,[join(source,'cli','scheduler.mjs'),'once','--db',f.dbPath,'--config-file',configFile,'--accepted-rev',approval],{env,encoding:'utf8',windowsHide:true,timeout:20000});
 const rows=out.trim().split('\n').map(x=>JSON.parse(x));assert.ok(rows.some(x=>x.kind==='settled'));assert.equal(used(f),1);assert.equal(launches(f),1);assert.ok(!out.includes('PRIVATE-TASK-BODY'));
});
test('removing the root identity while running cannot silently initialize a new binding',async()=>{
 const f=fixture();card(f);const s=open(f);unlinkSync(join(f.config.root,'ROOT.json'));await assert.rejects(s.tick(),{code:'SCHEDULER_BINDING_CHANGED'});assert.equal(used(f),0);s.close();
});
test('malformed or duplicate profiles and changed runtime pins fail before making a private root',()=>{
 const f=fixture();for(const mutate of [c=>c.profiles.push(structuredClone(c.profiles[0])),c=>c.max_active=0,c=>c.profiles[0].node.sha256='0'.repeat(64),c=>c.profiles[0].mcp_url='http://192.0.2.1:43111']){
  const c=structuredClone(f.config);mutate(c);assert.throws(()=>open(f,{config:c}));assert.equal(existsSync(c.root),false);
 }assert.equal(used(f),0);
});
test('existing private files after a gate refusal are retained and cannot be reused for an automatic start',async()=>{
 const f=fixture(),{a}=card(f),s=open(f);revokePrincipal(f.db,{principalId:f.principal.principal_id,expectedVersion:1});await s.tick();
 const file=join(f.config.root,a.assignment_id,'private','sentinel.txt');writeFileSync(file,'keep');await s.tick();
 assert.equal(readFileSync(file,'utf8'),'keep');assert.equal(used(f),0);assert.equal(f.events.at(-1).code,'ORPHANED_PREPARATION');s.close();
});

const status=(f,id=null)=>schedulerStatus(f.db,{instanceId:id});
const command=(f,name,args=[])=>JSON.parse(execFileSync(process.execPath,[join(source,'cli','scheduler.mjs'),name,'--db',f.dbPath,...args],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}));
const request=(f,s,mode='drain',revision=1,id=randomUUID())=>requestSchedulerStop(f.db,{instanceId:s.instance_id,expectedRevision:revision,requestId:id,mode});
async function waitFor(check,label,timeout=10000){const end=Date.now()+timeout;for(;;){const value=check();if(value)return value;if(Date.now()>end)throw Error(label+' timed out');await delay(30);}}
function cliWatch(f){
 const config=join(f.base,'scheduler.json');writeFileSync(config,JSON.stringify(f.config));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp','path','pathext','pythonutf8'].includes(k.toLowerCase())));
 const child=spawn(process.execPath,[join(source,'cli','scheduler.mjs'),'watch','--db',f.dbPath,'--config-file',config,'--accepted-rev',approval],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 return {child,done,output:()=>({out,err}),async close(){if(child.exitCode===null&&child.signalCode===null)child.kill();await done;}};
}

test('status CLI opens an existing database read-only without initializing lifecycle or launching work',()=>{
 const f=fixture(),before=f.db.prepare('SELECT count(*) n FROM sqlite_master').get().n;
 const output=command(f,'status');assert.equal(output.configured,false);assert.deepEqual(output.instances,[]);assert.equal(output.process_liveness,'not_checked');assert.equal(f.db.prepare('SELECT count(*) n FROM sqlite_master').get().n,before);assert.equal(used(f),0);
 const readonly=openSchedulerControlDatabase(f.dbPath,{readOnly:true});assert.throws(()=>readonly.exec('CREATE TABLE forbidden(n)'));readonly.close();
});

test('durable drain is versioned and idempotent, prevents a new claim and cannot affect the next instance',async()=>{
 const f=fixture();card(f);const s=open(f),id=randomUUID(),receipt=request(f,s,'drain',1,id);
 assert.equal(receipt.state,'requested');assert.equal(receipt.executor_stop_confirmed,false);assert.equal(status(f,s.instance_id).instances[0].control_pending,true);assert.deepEqual(request(f,s,'drain',1,id),receipt);
 assert.throws(()=>request(f,s,'cancel',1,id),{code:'REQUEST_CONFLICT'});assert.throws(()=>request(f,s,'cancel',1),{code:'CONFLICT'});
 const r=await s.tick();assert.equal(r.results.length,0);assert.equal(used(f),0);let instance=status(f,s.instance_id).instances[0];assert.equal(instance.state,'draining');assert.equal(instance.observed_revision,2);assert.equal(instance.executor_stop_confirmed,false);
 s.close();instance=status(f,s.instance_id).instances[0];assert.equal(instance.state,'stopped');assert.equal(instance.executor_stop_confirmed,true);assert.equal(instance.unconfirmed_runs,0);assert.deepEqual(request(f,s,'drain',1,id),receipt);assert.throws(()=>request(f,s,'cancel',2),{code:'SCHEDULER_ENDED'});
 const next=open(f);assert.notEqual(next.instance_id,s.instance_id);assert.equal(status(f,next.instance_id).instances[0].requested_mode,'run');assert.equal(status(f,next.instance_id).instances[0].revision,1);next.close();assert.equal(used(f),0);
});

test('separate CLI drain wakes a long-poll scheduler and lets only the in-flight synthetic task finish',async()=>{
 const f=fixture({wait:3000,limit:2});card(f);card(f);f.config.poll_ms=60000;const host=cliWatch(f);
 try{
  await started(f);const instance=command(f,'status').instances[0],r=command(f,'drain',['--instance',instance.instance_id,'--version',String(instance.revision),'--request-id',randomUUID()]);assert.equal(r.state,'requested');assert.equal(r.executor_stop_confirmed,false);
  await waitFor(()=>host.child.exitCode!==null,'draining scheduler',15000);assert.equal(await host.done,0,host.output().err);const terminal=command(f,'status',['--instance',instance.instance_id]).instances[0];assert.equal(terminal.state,'stopped');assert.equal(terminal.observed_revision,2);assert.equal(terminal.executor_stop_confirmed,true);
  assert.equal(used(f),1);assert.equal(launches(f),1);assert.equal(f.db.prepare("SELECT count(*) n FROM broker_assignments WHERE state='waiting_executor'").get().n,1);assert.equal(JSON.parse(f.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json).status,'success');assert.ok(host.output().out.includes('control_observed'));assert.ok(!host.output().out.includes('PRIVATE-TASK-BODY'));
 }finally{await host.close();}
});

test('separate cancel command escalates drain and confirms actual Job cleanup without refunding quota',async()=>{
 const f=fixture({wait:9000,limit:2});card(f);card(f);f.config.poll_ms=60000;const host=cliWatch(f);
 try{
  await started(f);const instance=command(f,'status').instances[0];command(f,'drain',['--instance',instance.instance_id,'--version','1','--request-id',randomUUID()]);const cancelId=randomUUID(),args=['--instance',instance.instance_id,'--version','2','--request-id',cancelId];const receipt=command(f,'cancel',args);assert.deepEqual(command(f,'cancel',args),receipt);
  assert.throws(()=>requestSchedulerStop(f.db,{instanceId:instance.instance_id,expectedRevision:3,requestId:randomUUID(),mode:'drain'}),{code:'CONTROL_DOWNGRADE'});
  await waitFor(()=>host.child.exitCode!==null,'cancelled scheduler',15000);assert.equal(await host.done,0,host.output().err);const terminal=command(f,'status',['--instance',instance.instance_id]).instances[0];assert.equal(terminal.state,'stopped');assert.equal(terminal.observed_revision,3);assert.equal(terminal.executor_stop_confirmed,true);
  const o=JSON.parse(f.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json);assert.equal(o.status,'cancelled');assert.equal(o.process.cleanup,'job_empty');assert.equal(o.real_model_call_confirmed,false);assert.equal(used(f),1);assert.equal(launches(f),1);
 }finally{await host.close();}
});

test('hard-stopped scheduler remains unconfirmed and its stale control cannot stop a replacement instance',async()=>{
 const f=fixture();f.config.poll_ms=60000;const host=cliWatch(f);let instance;
 try{instance=await waitFor(()=>status(f).instances[0],'registered instance');host.child.kill();await host.done;}finally{await host.close();}
 const health=readFleetHealth(f.db);assert.ok(health.issues.some(i=>i.code==='SCHEDULER_LOCK_ORPHAN'));assert.equal(health.executor_stop_confirmed,false);
 const stale=status(f,instance.instance_id).instances[0];assert.equal(stale.ended_at,null);assert.equal(stale.executor_stop_confirmed,false);assert.equal(stale.state,'running');assert.equal(schedulerStatus(f.db,{instanceId:instance.instance_id,now:Date.parse(stale.heartbeat_at)+11000}).instances[0].heartbeat_state,'stale');
 requestSchedulerStop(f.db,{instanceId:instance.instance_id,expectedRevision:1,requestId:randomUUID(),mode:'cancel'});assert.equal(status(f,instance.instance_id).instances[0].control_pending,true);assert.throws(()=>open(f),{code:'SCHEDULER_BUSY'});assert.equal(used(f),0);
 // Fixture-only manual recovery: the exact child handle is terminal and no worker was started.
 const lock=join(f.base,'.board.db.fleet-scheduler.lock'),rel=relative(resolve(f.base),resolve(lock));assert.ok(rel&&!rel.startsWith('..'));assert.equal(JSON.parse(readFileSync(lock,'utf8')).id,instance.instance_id);unlinkSync(lock);
 const replacement=open(f);await replacement.tick();assert.notEqual(replacement.instance_id,instance.instance_id);assert.equal(status(f,replacement.instance_id).instances[0].state,'running');assert.equal(status(f,instance.instance_id).instances[0].control_pending,true);replacement.close();
});

test('missing execution settlement produces attention on close instead of a false stopped receipt',async()=>{
 const f=fixture();card(f);const s=open(f);f.db.exec("CREATE TRIGGER lifecycle_reject_settle BEFORE INSERT ON broker_dispatch_events WHEN NEW.kind='settled' BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END");
 const r=await s.tick();assert.equal(r.inflight,1);s.close();const terminal=status(f,s.instance_id).instances[0];assert.equal(terminal.state,'attention');assert.equal(terminal.unconfirmed_runs,1);assert.equal(terminal.executor_stop_confirmed,false);assert.equal(used(f),1);
});

test('control observation failure stops new claims and is retained in the terminal record',async()=>{
 const f=fixture();card(f);const s=open(f);f.db.exec("CREATE TRIGGER lifecycle_reject_observe BEFORE UPDATE OF observed_revision ON scheduler_instances BEGIN SELECT RAISE(ABORT,'fixture observation failure'); END");
 await assert.rejects(s.tick());f.db.exec('DROP TRIGGER lifecycle_reject_observe');s.close();const terminal=status(f,s.instance_id).instances[0];assert.equal(terminal.state,'attention');assert.equal(terminal.error_code,'ERR_SQLITE_ERROR');assert.equal(used(f),0);assert.equal(launches(f),0);
});

test('actual backup recovery preserves control history but fences its prior node epoch',()=>{
 const f=fixture(),s=open(f),requestId=randomUUID(),args={instanceId:s.instance_id,expectedRevision:1,requestId,mode:'drain'};requestSchedulerStop(f.db,args);s.close();
 const evidence=join(f.base,'evidence');mkdirSync(evidence);writeFileSync(join(evidence,'sentinel.txt'),'fixture only');const backup=createBackup({dbPath:f.dbPath,evidenceDir:evidence,destination:join(TMP,'lifecycle-backup-'+randomUUID())}),restored=join(TMP,'lifecycle-restored-'+randomUUID());restoreBackup({backupDirectory:backup.destination,destination:restored});const dbPath=join(restored,'board.db'),db=new DatabaseSync(dbPath);dbs.push(db);
 assert.throws(()=>schedulerStatus(db),{code:'RESTORE_HOLD'});retireNode({dbPath:f.dbPath,expectedEpoch:f.config.node_epoch});const plan=prepareRecovery({dbPath});
 const attestation={format:'ai-fleet-retirement-attestation/v1',node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:'isolated scheduler lifecycle fixture; no physical devices',attested_at:new Date().toISOString()};activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation});
 const prior=schedulerStatus(db,{instanceId:s.instance_id}).instances[0];assert.equal(prior.identity_current,false);assert.equal(prior.node_epoch,f.config.node_epoch);assert.throws(()=>requestSchedulerStop(db,args),{code:'EPOCH_CHANGED'});assert.equal(db.prepare('SELECT count(*) n FROM scheduler_control_requests').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});

async function runtimeConfig(f){const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));f.config.profiles[0].mcp_url='http://127.0.0.1:'+port;return {format:'ai-fleet-node-runtime/v1',node_id:f.config.node_id,node_epoch:f.config.node_epoch,peer:null,mcp:{port,board_url:null},sync:[],scheduler:f.config};}

test('node host drain retains MCP during an offline in-flight synthetic task and closes components afterward',async()=>{
 const f=fixture({wait:3000,limit:2}),other=fixture(),config=await runtimeConfig(f),stop=new AbortController();card(f);card(f);migratePeers(other.db);const file=join(f.base,'offline-peer.json');issueCredential(other.db,{peerNodeId:f.config.node_id,peerEpoch:f.config.node_epoch,scopes:['peer:handshake','sync:pull','sync:ack'],projects:['demo'],credentialFile:file});
 config.sync=[{project_id:'demo',url:fixtureEndpoint(other.db),credential_file:file,server_node_id:other.config.node_id,server_epoch:other.config.node_epoch,poll_ms:1000}];
 const events=[],running=runNodeRuntime({dbPath:f.dbPath,config,sourceGate:gate,environment,stopSignal:stop.signal,onEvent:e=>events.push(e)});running.catch(()=>{});
 try{await started(f);await waitFor(()=>nodeRuntimeStatus(f.db).instances[0]?.components.some(c=>c.name.startsWith('sync:')&&['error','backoff'].includes(c.state)),'offline component');stop.abort();
  const r=await fetch('http://127.0.0.1:'+config.mcp.port+'/local/v1/tools/list',{method:'POST',headers:{Authorization:f.auth,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,200);assert.ok((await r.json()).result.tools.length>0);
  await running;assert.equal(used(f),1);assert.equal(launches(f),1);const o=JSON.parse(f.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json);assert.equal(o.status,'success');assert.equal(o.process.cleanup,'job_empty');const final=nodeRuntimeStatus(f.db).instances[0];assert.equal(final.state,'stopped');assert.ok(final.components.every(c=>c.state==='stopped'));assert.equal(f.db.prepare("SELECT count(*) n FROM broker_assignments WHERE state='waiting_executor'").get().n,1);assert.ok(!JSON.stringify(events).includes('PRIVATE-TASK-BODY'));
 }finally{stop.abort();await running.catch(()=>{});}
});

test('node host durable cancellation reaches its owned scheduler and records both terminal instances',async()=>{
 const f=fixture({wait:9000,limit:2}),config=await runtimeConfig(f),stop=new AbortController();card(f);card(f);const running=runNodeRuntime({dbPath:f.dbPath,config,sourceGate:gate,environment,stopSignal:stop.signal});running.catch(()=>{});
 try{await started(f);const instance=nodeRuntimeStatus(f.db).instances[0];assert.equal(schedulerStatus(f.db).instances.length,1);const r=nodeLifecycle.requestStop(f.db,{instanceId:instance.instance_id,expectedRevision:1,requestId:randomUUID(),mode:'cancel'});assert.equal(r.state,'requested');await running;const node=nodeRuntimeStatus(f.db).instances[0],scheduler=schedulerStatus(f.db).instances[0];assert.equal(node.state,'stopped');assert.equal(node.observed_revision,2);assert.equal(scheduler.state,'stopped');assert.notEqual(node.instance_id,scheduler.instance_id);assert.equal(node.executor_stop_confirmed,true);const o=JSON.parse(f.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json);assert.equal(o.status,'cancelled');assert.equal(o.process.cleanup,'job_empty');assert.equal(used(f),1);assert.equal(launches(f),1);
 }finally{stop.abort();await running.catch(()=>{});}
});

test('node host observes a durable startup drain before launching the first queued task',async()=>{
 const f=fixture({limit:1}),config=await runtimeConfig(f);card(f);let requested=false;
 await runNodeRuntime({dbPath:f.dbPath,config,sourceGate:gate,environment,onEvent:e=>{if(e.kind==='component'&&e.name==='mcp'&&e.state==='listening'){nodeLifecycle.requestStop(f.db,{instanceId:e.instance_id,expectedRevision:1,requestId:randomUUID(),mode:'drain'});requested=true;}}});
 assert.equal(requested,true);assert.equal(used(f),0);assert.equal(launches(f),0);assert.equal(nodeRuntimeStatus(f.db).instances[0].observed_revision,2);
});

async function duringSchedulerWrite(f,read){
 const script="const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000;BEGIN EXCLUSIVE');process.send({locked:true});setTimeout(()=>{db.exec('ROLLBACK');db.close();process.disconnect();},1000);";
 const writer=spawn(process.execPath,['-e',script,f.dbPath],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],timeout:10000});let error='';
 writer.stderr.on('data',b=>error+=b);
 const closed=new Promise((resolve,reject)=>{writer.once('error',reject);writer.once('close',code=>code===0?resolve():reject(Error('isolated scheduler writer failed: '+error)));});
 closed.catch(()=>{});
 try{
  await new Promise((resolve,reject)=>{writer.once('message',m=>m.locked?resolve():reject(Error('lock not held')));writer.once('error',reject);writer.once('exit',()=>reject(Error('writer exited before lock observation')));});
  return await read();
 }finally{await closed;}
}
const fileHash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
test('scheduler fixture status waits for an actual independent writer without changing data or starting work',async()=>{
 const f=fixture(),before=fileHash(f.dbPath);
 await duringSchedulerWrite(f,()=>{const s=status(f);assert.equal(s.node_id,f.config.node_id);assert.equal(s.configured,false);assert.deepEqual(s.instances,[]);assert.equal(s.process_liveness,'not_checked');});
 assert.equal(fileHash(f.dbPath),before);assert.equal(used(f),0);assert.equal(launches(f),0);assert.equal(existsSync(f.marker),false);
});
test('production scheduler read-only control already tolerates a transient writer and refuses mutations',async()=>{
 const f=fixture(),before=fileHash(f.dbPath);
 await duringSchedulerWrite(f,()=>{
  const db=openSchedulerControlDatabase(f.dbPath,{readOnly:true});
  try{const s=schedulerStatus(db);assert.equal(s.node_id,f.config.node_id);assert.equal(s.configured,false);assert.deepEqual(s.instances,[]);assert.equal(db.prepare('PRAGMA query_only').get().query_only,1);assert.throws(()=>db.prepare("UPDATE board_node SET display_name='forbidden'").run(),/readonly/);}
  finally{db.close();}
 });
 assert.equal(fileHash(f.dbPath),before);assert.equal(used(f),0);assert.equal(launches(f),0);
});

test('scheduler profile idle timeout reaches the real runner and cannot restart its spent assignment',async()=>{
 const f=fixture({limit:1,wait:5000});f.config.profiles[0].idle_timeout_ms=600;card(f);
 const s=open(f),r=await s.tick();assert.equal(r.results[0].phase,'settled');
 const record=f.db.prepare('SELECT launch_json,observation_json FROM broker_execution_records').get(),launch=JSON.parse(record.launch_json),o=JSON.parse(record.observation_json);
 assert.equal(launch.idle_timeout_ms,600);assert.equal(o.diagnostic,'IDLE_TIMEOUT');
 assert.equal(o.status,'timeout');assert.equal(o.process.cleanup,'job_empty');assert.ok(o.process.activity.events>=2);
 assert.equal(used(f),1);await s.tick();assert.equal(launches(f),1);s.close();
});
test('invalid scheduler idle profiles are refused before private root creation or quota spend',()=>{
 const f=fixture();
 for(const idle of [null,0,86400001]){
  const config=structuredClone(f.config);config.profiles[0].idle_timeout_ms=idle;
  assert.throws(()=>open(f,{config}),{code:'BAD_INPUT'});assert.equal(existsSync(config.root),false);
  assert.equal(used(f),0);assert.equal(launches(f),0);
 }
});
