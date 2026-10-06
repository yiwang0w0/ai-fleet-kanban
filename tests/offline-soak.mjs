// Opt-in real-duration, single-host offline drill. No real provider or Tailscale change.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,cpSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import net from 'node:net';
import {migratePeers,localIdentity,issueCredential} from '../core/federation/peers.mjs';
import {migrateSync,shareTask,listReplicas} from '../core/federation/sync-store.mjs';
import {migrateDispatch,putQuota,quotaStatus} from '../core/execution/dispatch.mjs';
import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {putRole,issuePrincipal} from '../core/mcp/policy.mjs';
import {callTool} from '../core/mcp/tools.mjs';
import {runNodeRuntime,nodeRuntimeStatus} from '../core/node-runtime.mjs';
import {readFleetView} from '../core/fleet-view.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {pinFile} from '../core/execution/supervisor.mjs';
assert.equal(process.platform,'win32');assert.ok(process.argv.length===3||process.argv.length===4,'Usage: node tests/offline-soak.mjs <new-report.json> [offline-ms, default 1800000]');
const output=resolve(process.argv[2]),offlineMs=Number(process.argv[3]??1800000);assert.ok(Number.isSafeInteger(offlineMs)&&offlineMs>=10000&&offlineMs<=3600000);
assert.ok(!existsSync(output),'Preserve prior evidence; choose a new output file.');
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-offline-soak-')),store=createRequire(import.meta.url)('../core/store.js'),dbs=[],hosts=[];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),git=(root,args)=>execFileSync('git',['-c','safe.directory='+resolve(root).replaceAll('\\','/'),'-C',root,...args],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const report={format:'ai-fleet-single-host-offline-soak/v1',started_at:new Date().toISOString(),code_sha:git(ROOT,['rev-parse','HEAD']),requested_offline_ms:offlineMs,scope:{physical_hosts:1,isolated_nodes:2,tailscale:false,providers_called:false,executor:'synthetic Zcode-shaped program in actual Windows Job',formal_acceptance:false},sources:Object.fromEntries(['tests/offline-soak.mjs','core/node-runtime.mjs','core/execution/scheduler.mjs','core/execution/runner.mjs','core/federation/sync-client.mjs'].map(p=>[p,hash(join(ROOT,p))])),samples:[]};
const environment=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp'].includes(k.toLowerCase())));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(check,label,ms=30000){const deadline=performance.now()+ms;for(;;){const v=check();if(v)return v;if(performance.now()>deadline)throw Error(label+' timed out');await delay(100);}}
async function node(alias){const dir=join(TMP,alias);mkdirSync(dir);const dbPath=join(dir,'board.db'),setup=new DatabaseSync(dbPath);setup.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');store.migrate(setup);migratePeers(setup);migrateSync(setup);migrateDispatch(setup);store.renameNode(setup,alias);setup.close();const db=openSchedulerControlDatabase(dbPath);dbs.push(db);const n=localIdentity(db);return {dir,dbPath,db,n,config:{format:'ai-fleet-node-runtime/v1',node_id:n.node_id,node_epoch:n.sync_epoch,peer:{host:'127.0.0.1',port:await port()},mcp:{port:await port(),board_url:null},sync:[],scheduler:null}};}
function connection(source,receiver){const credentialFile=join(receiver.dir,'from-'+source.n.display_name+'.json'),url='http://127.0.0.1:'+source.config.peer.port;issueCredential(source.db,{serverEndpoint:url,peerNodeId:receiver.n.node_id,peerEpoch:receiver.n.sync_epoch,scopes:['peer:handshake','sync:pull','sync:ack'],projects:['soak'],credentialFile});return {project_id:'soak',url,credential_file:credentialFile,server_node_id:source.n.node_id,server_epoch:source.n.sync_epoch,poll_ms:1000};}
let gate;
function start(f){const stop=new AbortController(),events=[],h={stop,events};h.done=runNodeRuntime({dbPath:f.dbPath,config:f.config,sourceGate:gate,environment,stopSignal:stop.signal,onEvent:e=>events.push(e)});h.done.catch(e=>h.error=e);hosts.push(h);h.ready=()=>until(()=>{if(h.error)throw h.error;return events.find(e=>e.kind==='started');},'node startup');return h;}
const count=(db,table)=>db.prepare('SELECT count(*) n FROM '+table).get().n;
try{
 const source=join(TMP,'governance');mkdirSync(source);for(const d of ['core','cli'])cpSync(join(ROOT,d),join(source,d),{recursive:true});git(source,['init','--quiet','--template=']);git(source,['config','core.autocrlf','false']);git(source,['add','.']);git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);const approval=join(TMP,'accepted-fixture');writeFileSync(approval,git(source,['rev-parse','HEAD:']));gate=createSourceGate({codeRoot:source,approvalFile:approval});
 const a=await node('A'),b=await node('B');a.config.sync=[connection(b,a)];b.config.sync=[connection(a,b)];
 const limits={max_task_attempts:1,max_open_tasks:10,requests_per_minute:100};
 for(const r of [{role_id:'coord',kind:'coordinate',capabilities:[],runtime:null,model:null,effort:null},{role_id:'engine',kind:'implement',capabilities:['board-tools'],runtime:'zcode',model:'GLM-5.3',effort:'low'}])putRole(a.db,{...r,projects:['soak'],tools:'write',priority:10,enabled:true,limits});
 const coordFile=join(a.dir,'coord.json');issuePrincipal(a.db,{roleId:'coord',projects:['soak'],credentialFile:coordFile});const auth='Bearer '+JSON.parse(readFileSync(coordFile,'utf8')).token;
 const q=putQuota(a.db,{quota_id:randomUUID(),runtime:'zcode',execution_mode:'provider',projects:['soak'],limit_total:1,enabled:true});
 const authHome=join(a.dir,'auth','.zcode','v2');mkdirSync(authHome,{recursive:true});const bundle=join(a.dir,'synthetic.cjs'),builtin=join(a.dir,'builtin.json'),marker=join(a.dir,'started.log');
 const wait=offlineMs>=60000?30000:7000;
 writeFileSync(bundle,"const fs=require('node:fs');fs.appendFileSync("+JSON.stringify(marker)+",String(process.pid)+'\\n');const input=process.argv[process.argv.indexOf('--prompt')+1],out=e=>process.stdout.write(JSON.stringify(e)+'\\n'),e=(type,seq,payload)=>({type,seq,eventId:'event'+seq,sessionId:'fixture',turnId:'turn',traceId:'trace',timestamp:seq,payload});out(e('turn.started',1,{input}));out(e('session.updated',2,{providerId:'account:bigmodel-individual-coding-plan',modelId:'GLM-5.3',messageCount:1,toolCount:5,iteration:0}));setTimeout(()=>{out(e('turn.completed',3,{resultType:'success',response:'synthetic offline result'}));out({type:'result',sessionId:'fixture',turnId:'turn',traceId:'trace',response:'synthetic offline result',eventCount:3,projection:{status:'completed',turnCount:1,totalTokenCount:0}});},"+wait+");");
 writeFileSync(builtin,JSON.stringify({schemaVersion:1,revision:30,config:{providerConfigRules:{templateRules:[],providerRules:[{providerId:'account:bigmodel-individual-coding-plan',config:{group:'bigmodel-family',builtinModelIds:['GLM-5.3'],access:{type:'zhipu-account',accountType:'bigmodel',mode:'individual-coding-plan'},api:{type:'anthropic-messages',baseUrl:'https://open.bigmodel.cn/api/anthropic'}}}]},modelConfigRules:{modelRules:[],modelApiRules:[],providerSiteRules:[],templateModelRules:[],builtinProviderModelRules:[]}}}));
 const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||'python',['-I','-S','-X','utf8','-c','import sys; print(sys.executable)'],{windowsHide:true,encoding:'utf8'}).trim());
 a.config.scheduler={format:'ai-fleet-scheduler/v1',node_id:a.n.node_id,node_epoch:a.n.sync_epoch,root:join(a.dir,'runs'),max_active:1,poll_ms:1000,profiles:[{project_id:'soak',role_id:'engine',quota_id:q.quota_id,installation:{runtime:'zcode',version:'0.16.9',program:pinFile(process.execPath),bundle:pinFile(bundle),builtin_config:pinFile(builtin),auth_home:authHome},python,node:pinFile(process.execPath),mcp_url:'http://127.0.0.1:'+a.config.mcp.port,timeout_ms:60000,workspace:null}]};
 const card=callTool(a.db,auth,'create_task',{request_id:randomUUID(),project_id:'soak',kind:'task',subject:'offline synthetic task',description:'fixture',acceptance:'pending independent review',work_kind:'implement',required_capabilities:['board-tools']}).task;shareTask(a.db,{id:card.id,projectId:'soak',expectedVersion:store.get(a.db,card.id).aggregate_version});store.setReleased(a.db,{id:card.id,released:true,expectedVersion:store.get(a.db,card.id).aggregate_version});const t=store.get(a.db,card.id);callTool(a.db,auth,'request_assignment',{request_id:randomUUID(),task_uid:t.task_uid,expected_version:t.aggregate_version});
 const hb=start(b);await hb.ready();const ha=start(a);await ha.ready();await until(()=>existsSync(marker),'native synthetic start');await until(()=>listReplicas(b.db).some(r=>r.task_uid===t.task_uid&&r.status==='in_progress'),'remote running projection');
 const instance=nodeRuntimeStatus(a.db).instances[0].instance_id,run=store.get(a.db,t.id).run_id;assert.ok(run);hb.stop.abort();await hb.done;
 const offStart=performance.now();report.offline_started_at=new Date().toISOString();console.log(JSON.stringify({phase:'offline',duration_ms:offlineMs,claimed_before_disconnect:true}));
 let firstCompletion=null,lastSample=-1;
 do{
  if(ha.error)throw ha.error;const task=store.get(a.db,t.id),s=nodeRuntimeStatus(a.db).instances.find(x=>x.instance_id===instance);assert.equal(s.ended_at,null);assert.equal(s.state,'running');assert.ok(s.components.some(c=>c.name==='mcp'&&c.state==='listening'));assert.equal(quotaStatus(a.db,q.quota_id).used,1);assert.equal(count(a.db,'broker_dispatches'),1);assert.equal(readFileSync(marker,'utf8').trim().split('\n').length,1);
  if(task.status==='waiting'&&!firstCompletion){const observation=JSON.parse(a.db.prepare('SELECT observation_json FROM broker_execution_records').get().observation_json);assert.equal(observation.status,'success');assert.equal(observation.process.cleanup,'job_empty');assert.equal(observation.real_model_call_confirmed,false);firstCompletion=performance.now()-offStart;report.completed_while_offline_ms=firstCompletion;console.log(JSON.stringify({phase:'completed_while_offline',elapsed_ms:firstCompletion,job_empty:true}));}
  assert.notEqual(task.status,'done');assert.equal(listReplicas(b.db).find(r=>r.task_uid===t.task_uid).status,'in_progress');
  const minute=Math.floor((performance.now()-offStart)/60000);if(minute!==lastSample){lastSample=minute;const sample={elapsed_ms:Math.round(performance.now()-offStart),local_status:task.status,remote_cached_status:'in_progress',dispatch_count:1,used:1,sync_states:s.components.filter(c=>c.name.startsWith('sync:')).map(c=>c.state)};report.samples.push(sample);console.log(JSON.stringify({phase:'sample',...sample}));}
  await delay(1000);
 }while(performance.now()-offStart<offlineMs);
 report.actual_offline_ms=performance.now()-offStart;assert.ok(firstCompletion!==null&&firstCompletion<report.actual_offline_ms);
 assert.ok(nodeRuntimeStatus(a.db).instances.find(x=>x.instance_id===instance).components.some(c=>c.name.startsWith('sync:')&&['error','backoff'].includes(c.state)));
 if(offlineMs>=60000)assert.equal(readFleetView(b.db).nodes.find(n=>n.node_id===a.n.node_id).connection_state,'stale');
 const reconnect=performance.now(),hb2=start(b);await hb2.ready();await until(()=>listReplicas(b.db).some(r=>r.task_uid===t.task_uid&&r.status==='waiting'),'reconnected waiting result',45000);report.reconnect_ms=performance.now()-reconnect;
 assert.equal(nodeRuntimeStatus(a.db).instances.length,1);assert.equal(count(a.db,'task_runs'),1);assert.equal(count(a.db,'broker_execution_records'),1);assert.equal(count(b.db,'tasks'),0);assert.equal(count(b.db,'task_runs'),0);assert.equal(new Set(listReplicas(b.db).map(t=>t.task_uid)).size,1);assert.equal(quotaStatus(a.db,q.quota_id).used,1);
 ha.stop.abort();hb2.stop.abort();await Promise.all([ha.done,hb2.done]);assert.equal(nodeRuntimeStatus(a.db).instances[0].state,'stopped');assert.equal(nodeRuntimeStatus(a.db).instances[0].executor_stop_confirmed,true);
 report.result='passed';report.offline_30_minutes_observed=report.actual_offline_ms>=1800000;report.final={owner_task_status:store.get(a.db,t.id).status,remote_task_status:listReplicas(b.db)[0].status,local_runs:1,remote_runs:0,accepted:false,job_empty:true,hosts_stopped:true};console.log(JSON.stringify({phase:'passed',actual_offline_ms:report.actual_offline_ms,reconnect_ms:report.reconnect_ms,offline_30_minutes_observed:report.offline_30_minutes_observed}));
}catch(e){report.result='failed';report.error={code:e.code??'ASSERTION',message:e.message};throw e;}finally{
 for(const h of hosts){h.stop.abort();await h.done.catch(()=>{});}for(const db of dbs)try{db.close();}catch{}report.finished_at=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});const r=relative(resolve(tmpdir()),resolve(TMP));assert.ok(r&&!r.startsWith('..'));rmSync(TMP,{recursive:true,force:true});
}
