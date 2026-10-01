import {issueCredential,fixtureEndpoint} from "./helpers/peer-network.mjs";
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync,existsSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync,spawn} from 'node:child_process';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {migratePeers,localIdentity} from "../core/federation/peers.mjs";
import {migrateSync,shareTask,listReplicas} from '../core/federation/sync-store.mjs';
import {migrateBroker,putRole,issuePrincipal} from '../core/mcp/policy.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {createLifecycleRegistry,schedulerStatus} from '../core/execution/lifecycle.mjs';
import {runNodeRuntime,nodeRuntimeStatus,nodeLifecycle} from '../core/node-runtime.mjs';
import {createBridge} from '../core/mcp/stdio.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-node-runtime-')),source=join(TMP,'governance'),store=createRequire(import.meta.url)('../core/store.js'),dbs=[],hosts=[];
mkdirSync(source);for(const dir of ['core','cli'])cpSync(join(ROOT,dir),join(source,dir),{recursive:true});const git=args=>execFileSync('git',['-C',source,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();git(['init','--quiet','--template=']);git(['config','core.autocrlf','false']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);const approval=join(TMP,'accepted-fixture');writeFileSync(approval,git(['rev-parse','HEAD:']));const gate=createSourceGate({codeRoot:source,approvalFile:approval});
after(async()=>{for(const h of hosts){h.stop.abort();await h.done.catch(()=>{});}for(const db of dbs)db.close();const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function waitFor(check,label,ms=12000){const end=Date.now()+ms;for(;;){const result=check();if(result)return result;if(Date.now()>end)throw Error(label+' timed out');await delay(30);}}
async function fixture(){const dir=mkdtempSync(join(TMP,'node-')),dbPath=join(dir,'board.db'),db=new DatabaseSync(dbPath);dbs.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);store.renameNode(db,'alpha');const n=localIdentity(db);return {dir,dbPath,db,n,config:{format:'ai-fleet-node-runtime/v1',node_id:n.node_id,node_epoch:n.sync_epoch,peer:{host:'127.0.0.1',port:await freePort()},mcp:{port:await freePort(),board_url:null},sync:[],scheduler:null}};}
function start(f){const stop=new AbortController(),events=[],h={stop,events};h.done=runNodeRuntime({dbPath:f.dbPath,config:f.config,sourceGate:gate,stopSignal:stop.signal,onEvent:e=>events.push(e)});h.done.catch(e=>h.error=e);hosts.push(h);h.ready=()=>waitFor(()=>{if(h.error)throw h.error;return events.find(e=>e.kind==='started');},'runtime start');return h;}
const status=f=>nodeRuntimeStatus(f.db);
function connection(a,b){const file=join(b.dir,'from-'+a.n.node_id+'.json');issueCredential(a.db,{serverEndpoint:'http://127.0.0.1:'+a.config.peer.port,peerNodeId:b.n.node_id,peerEpoch:b.n.sync_epoch,scopes:['peer:handshake','sync:pull','sync:ack'],projects:['demo'],credentialFile:file});return {project_id:'demo',url:'http://127.0.0.1:'+a.config.peer.port,credential_file:file,server_node_id:a.n.node_id,server_epoch:a.n.sync_epoch,poll_ms:1000};}
function task(f,subject){const id=store.add(f.db,{subject});shareTask(f.db,{id,projectId:'demo',expectedVersion:store.get(f.db,id).aggregate_version});return store.get(f.db,id);}
const command=(f,name,args=[])=>JSON.parse(execFileSync(process.execPath,[join(source,'cli','node-runtime.mjs'),name,'--db',f.dbPath,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:10000}));

test('node host owns authenticated loopback components and a separate lifecycle namespace',async()=>{
 const f=await fixture(),before=schedulerStatus(f.db);assert.equal(before.configured,false);const h=start(f),ready=await h.ready(),s=status(f).instances[0];assert.equal(s.instance_id,ready.instance_id);assert.equal(s.components.filter(c=>c.state==='listening').length,2);assert.equal(schedulerStatus(f.db).configured,false);
 assert.equal((await fetch('http://127.0.0.1:'+f.config.mcp.port+'/local/v1/tools/list',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch('http://127.0.0.1:'+f.config.peer.port+'/peer/v1/hello',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.throws(()=>createLifecycleRegistry('constructor'),{code:'BAD_INPUT'});h.stop.abort();await h.done;const final=status(f).instances[0];assert.equal(final.state,'stopped');assert.ok(final.components.every(c=>c.state==='stopped'));assert.equal(existsSync(join(f.dir,'.board.db.fleet-node-runtime.lock')),false);assert.equal(f.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});

test('a second host cannot take over its database lock or disrupt the first listeners',async()=>{
 const f=await fixture(),h=start(f);await h.ready();await assert.rejects(runNodeRuntime({dbPath:f.dbPath,config:f.config,sourceGate:gate}),{code:'NODE_RUNTIME_BUSY'});assert.equal(status(f).instances.length,1);assert.equal(status(f).instances[0].ended_at,null);h.stop.abort();await h.done;
});

test('partial startup failure closes only its own listener and leaves an occupied external port intact',async()=>{
 const f=await fixture(),external=net.createServer(s=>s.end());await new Promise(r=>external.listen(f.config.mcp.port,'127.0.0.1',r));
 try{await assert.rejects(runNodeRuntime({dbPath:f.dbPath,config:f.config,sourceGate:gate}),{code:'EADDRINUSE'});assert.equal(external.listening,true);assert.equal(status(f).instances[0].state,'attention');assert.equal(status(f).instances[0].components.find(c=>c.name==='peer').state,'stopped');const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(f.config.peer.port,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));}finally{await new Promise(r=>external.close(r));}
});

test('two real loopback hosts sync both ways and resume after a source outage without restarting the receiver',async()=>{
 const a=await fixture(),b=await fixture();a.config.sync=[connection(b,a)];b.config.sync=[connection(a,b)];const at=task(a,'A first'),bt=task(b,'B first'),ha=start(a),hb=start(b);await Promise.all([ha.ready(),hb.ready()]);await waitFor(()=>listReplicas(a.db).some(t=>t.task_uid===bt.task_uid)&&listReplicas(b.db).some(t=>t.task_uid===at.task_uid),'bidirectional sync');
 ha.stop.abort();await ha.done;const later=task(a,'A offline change');await waitFor(()=>status(b).instances[0].components.some(c=>c.name.startsWith('sync:')&&['error','backoff'].includes(c.state)),'offline sync status');assert.equal(status(b).instances[0].ended_at,null);assert.ok(status(b).instances[0].components.some(c=>c.name==='mcp'&&c.state==='listening'));
 const ha2=start(a);await ha2.ready();await waitFor(()=>listReplicas(b.db).some(t=>t.task_uid===later.task_uid),'reconnected sync',18000);assert.equal(status(b).instances.length,1);assert.equal(new Set(listReplicas(b.db).map(t=>t.task_uid)).size,2);assert.equal(store.list(b.db).tasks.length,1);assert.equal(b.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);ha2.stop.abort();hb.stop.abort();await Promise.all([ha2.done,hb.done]);
});

test('configuration rejects public listeners and unbound credentials before creating a host instance',async()=>{
 const f=await fixture(),original=structuredClone(f.config);f.config.peer.host='0.0.0.0';await assert.rejects(runNodeRuntime({dbPath:f.dbPath,config:f.config,sourceGate:gate}),{code:'UNSAFE_BIND'});assert.equal(status(f).configured,false);
 f.config=original;const other=await fixture(),p=connection(other,f);p.server_node_id=randomUUID();f.config.sync=[p];await assert.rejects(runNodeRuntime({dbPath:f.dbPath,config:f.config,sourceGate:gate}),{code:'SOURCE_MISMATCH'});assert.equal(status(f).configured,false);assert.equal(existsSync(join(f.dir,'.board.db.fleet-node-runtime.lock')),false);
});

test('actual node CLI serves a scoped MCP desktop query and acknowledges durable drain',async()=>{
 const f=await fixture();putRole(f.db,{role_id:'observer',kind:'observe',projects:['demo'],capabilities:[],runtime:null,model:null,effort:null,tools:'read-only',priority:1,enabled:true,limits:{max_task_attempts:1,max_open_tasks:10,requests_per_minute:100}});const file=join(f.dir,'observer.json');issuePrincipal(f.db,{roleId:'observer',projects:['demo'],credentialFile:file});const config=join(f.dir,'runtime.json');writeFileSync(config,JSON.stringify(f.config));
 const child=spawn(process.execPath,[join(source,'cli','node-runtime.mjs'),'watch','--db',f.dbPath,'--config-file',config,'--accepted-rev',approval],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 try{
  await waitFor(()=>out.includes('"kind":"started"'),'CLI start');const bridge=createBridge({url:'http://127.0.0.1:'+f.config.mcp.port,credentialFile:file});assert.ok((await bridge({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'runtime-fixture',version:'1'}}})).result);await bridge({jsonrpc:'2.0',method:'notifications/initialized'});const answer=await bridge({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_board_overview',arguments:{}}});assert.equal(answer.result.isError,false);assert.equal(answer.result.structuredContent.local_node_id,f.n.node_id);
  const s=command(f,'status').instances[0],args=['--instance',s.instance_id,'--version',String(s.revision),'--request-id',randomUUID()],receipt=command(f,'drain',args);assert.equal(receipt.state,'requested');assert.deepEqual(command(f,'drain',args),receipt);await waitFor(()=>child.exitCode!==null,'CLI stopped');assert.equal(await done,0,err);assert.equal(command(f,'status',['--instance',s.instance_id]).instances[0].state,'stopped');assert.ok(!out.includes(JSON.parse(readFileSync(file,'utf8')).token));
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await done;}
});

test('replaced runtime lock remains untouched and cannot receive a successful terminal record',async()=>{
 const f=await fixture(),h=start(f);await h.ready();const lock=join(f.dir,'.board.db.fleet-node-runtime.lock'),replacement=JSON.stringify({instance_id:randomUUID(),pid:1});writeFileSync(lock,replacement);h.stop.abort();await assert.rejects(h.done,{code:'NODE_RUNTIME_LOCK_CHANGED'});assert.equal(readFileSync(lock,'utf8'),replacement);assert.equal(status(f).instances[0].ended_at,null);assert.equal(status(f).instances[0].executor_stop_confirmed,false);
});

import {migrateDispatch} from '../core/execution/dispatch.mjs';
import {migrateWorkspaces} from '../core/artifacts/workspaces.mjs';
test('node startup seals expired provisioning before exposing listeners and preserves fresh or old epoch rows',async()=>{
 const f=await fixture();migrateDispatch(f.db);migrateWorkspaces(f.db);const ids={expired:randomUUID(),fresh:randomUUID(),old:randomUUID()},kept=join(f.dir,'partial.txt');writeFileSync(kept,'incomplete copy retained');
 for(const [kind,id] of Object.entries(ids)){const stamp=kind==='fresh'?new Date().toISOString():'2020-01-01T00:00:00.000Z';f.db.prepare("INSERT INTO task_workspaces(workspace_id,pool_id,dispatch_id,run_id,node_id,node_epoch,binding_json,binding_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','fixture','provisioning',?,?)").run(id,randomUUID(),randomUUID(),randomUUID(),f.n.node_id,kind==='old'?randomUUID():f.n.sync_epoch,stamp,stamp);}
 const h=start(f);await h.ready();assert.equal(f.db.prepare('SELECT state FROM task_workspaces WHERE workspace_id=?').get(ids.expired).state,'failed');for(const id of [ids.fresh,ids.old])assert.equal(f.db.prepare('SELECT state FROM task_workspaces WHERE workspace_id=?').get(id).state,'provisioning');assert.equal(readFileSync(kept,'utf8'),'incomplete copy retained');const recovered=h.events.find(e=>e.kind==='workspace_recovery');assert.deepEqual(recovered.sealed,[ids.expired]);assert.equal(recovered.executor_stop_confirmed,false);assert.ok(h.events.indexOf(recovered)<h.events.findIndex(e=>e.state==='listening'));h.stop.abort();await h.done;
});
