// Actual HTTP and supervised-child credentials; no model/provider calls.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixtureVersion} from './http-version-fixture.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-runtime-auth-'));
const PY=process.env.BOARD_PYTHON||process.env.PYTHON||'python';
let server,callback,base,operator,shared,output='';const seats=new Map();
async function api(token,method,path,body){
 body=await fixtureVersion(base,token,method,path,body);
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Board-Token':token},...(method==='GET'?{}:{body:JSON.stringify(body??{})})});
 return {status:r.status,body:await r.json().catch(()=>({}))};
}
const claim=(token,worker,runtime)=>api(token,'POST','/api/claim',{worker,runtime,worker_protocol_version:2,agent_instance_id:randomUUID()});
async function card(line){const r=await api(operator,'POST','/api/tasks',{subject:'Synthetic runtime boundary',...(line?{line}:{}),released:1});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.task;}
function evidence(task){
 const p=spawnSync(PY,['-c',"import sys,json;sys.path.insert(0,sys.argv[1]);import reviewer_loop as r;print(json.dumps(r.machine_evidence(json.loads(sys.argv[2]))))",join(ROOT,'loops'),JSON.stringify({...task,result:'PASS rc=0'})],{windowsHide:true,encoding:'utf8',timeout:15000,env:{...process.env,BOARD_DATA_DIR:TMP,BOARD_CONFIG:join(TMP,'fleet.json'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout.trim());
}
before(async()=>{
 callback=httpServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const b=JSON.parse(raw);seats.set(b.worker,b.token);res.end('ok');});});
 await new Promise(r=>callback.listen(0,'127.0.0.1',r));
 const stub=join(TMP,'seat.py');writeFileSync(stub,"import os,sys,json,urllib.request,time\nargs=sys.argv\nname=args[args.index('--worker')+1] if '--worker' in args else args[args.index('--as')+1]\ndata=json.dumps({'worker':name,'token':os.environ.get('WORKER_BOARD_TOKEN','')}).encode()\nurllib.request.urlopen(urllib.request.Request(os.environ['BOARD_RUNTIME_TEST_CALLBACK'],data=data),timeout=10).read()\ntime.sleep(90)\n");
 const original=join(ROOT,'core/server.mjs'),src=readFileSync(original,'utf8'),anchor='[loopScriptOf(line), "--as", line,';
 assert.equal(src.split(anchor).length,2);
 const fixture=join(TMP,'server.mjs');writeFileSync(fixture,src.replace(anchor,`[${JSON.stringify(stub)}, "--as", line,`).replaceAll('import.meta.url',JSON.stringify(pathToFileURL(original).href)).replace(/from\s+(['"])\.\/([^'"]+)\1/g,(_,q,p)=>'from '+JSON.stringify(pathToFileURL(join(dirname(original),p)).href)));
 const probe=netServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
 const config=join(TMP,'fleet.json');writeFileSync(config,JSON.stringify({lines:[{id:'alpha'},{id:'beta'}],roles:[],routes:['default']}));
 const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('BOARD_')));
 server=spawn(process.execPath,[fixture],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,BOARD_CONFIG:config,BOARD_DATA_DIR:TMP,BOARD_DB:join(TMP,'board.db'),BOARD_PORT:String(port),BOARD_PYTHON:PY,BOARD_ALLOW_UNPINNED:'1',BOARD_NO_RESTORE:'1',BOARD_POOL_TEST_MODE:'1',BOARD_POOL_TEST_PROBE:'ok',BOARD_CODEX_RELEASED:'1',BOARD_CODEX_CMD:process.execPath,WORKER_CLAUDE_CLI:process.execPath,BOARD_UNTIL:'2099-01-01T12:00',BOARD_RUNTIME_TEST_CALLBACK:`http://127.0.0.1:${callback.address().port}/`,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Fixture stopped before ready');try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'Fixture ready');
 operator=readFileSync(join(TMP,'board_token'),'utf8').trim();shared=readFileSync(join(TMP,'worker_token'),'utf8').trim();
 for(const [line,runtime,model] of [['alpha','claude','claude-opus-5'],['beta','codex','gpt-5.3-codex-spark']]){
  const ws=(await api(operator,'GET','/api/workers')).body.workers.find(w=>w.line===line);
  const saved=await api(operator,'POST',`/api/workers/${line}/settings`,{agents:[{runtime,model,effort:runtime==='codex'?'xhigh':'high',window:false}],rev:ws.settings.rev});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const started=await api(operator,'POST',`/api/workers/${line}/start`,{});assert.equal(started.status,200,JSON.stringify(started.body));
 }
 for(let i=0;i<100&&seats.size<2;i++)await delay(50);assert.equal(seats.size,2,'Both fixture children started');
});
after(async()=>{
 if(server?.exitCode===null){for(const line of ['alpha','beta'])await api(operator,'POST',`/api/workers/${line}/stop`,{}).catch(()=>{});const done=new Promise(r=>server.once('exit',r));server.kill();await done;}
 if(callback)await new Promise(r=>callback.close(r));
 for(const token of seats.values())if(token)assert.ok(!output.includes(token),'Credential must not appear in server logs');
 rmSync(TMP,{recursive:true,force:true});
});
test('P4 same shared worker token cannot rename itself into trusted Codex machine evidence',async()=>{
 const t=await card();const r=await claim(shared,'audit-hand-runner','codex');assert.equal(r.status,200);
 assert.equal(r.body.task.id,t.id);assert.equal(evidence(r.body.task).ok,false,'Invented PASS must not become machine evidence');assert.equal(r.body.task.last_runtime,null,'Unbound runtime cannot be trusted');
});
test('P4 supervised credentials bind the worker name and preserve both seat runtime stamps',async()=>{
 assert.ok(seats.get('alpha')&&seats.get('beta'),'Server hands each child a credential');assert.notEqual(seats.get('alpha'),shared);assert.notEqual(seats.get('alpha'),seats.get('beta'));
 for(const name of ['audit-hand-runner','beta']){const r=await claim(seats.get('alpha'),name,'codex');assert.equal(r.status,409,'Bound Claude token cannot rename into another identity');}
 for(const [worker,lie,want] of [['alpha','codex','claude'],['beta','claude','codex']]){
  const t=await card(worker);const r=await claim(seats.get(worker),worker,lie);assert.equal(r.status,200);assert.equal(r.body.task.id,t.id);assert.equal(r.body.task.last_runtime,want);assert.equal(evidence(r.body.task).ok,want==='codex');
  if(worker==='beta'){const forged=await api(seats.get('alpha'),'POST',`/api/tasks/${t.id}/report`,{worker:'beta',run_id:r.body.task.run_id,outcome:'done',evidence:'PASS rc=0'});assert.equal(forged.status,409,'Claude credential cannot report as Codex');}
  const report=await api(seats.get(worker),'POST',`/api/tasks/${t.id}/report`,{worker,run_id:r.body.task.run_id,outcome:'done',evidence:'Synthetic receipt'});assert.equal(report.status,200);
 }
 const impersonation=await claim(shared,'beta','codex');assert.equal(impersonation.status,409,'Shared token cannot borrow a registered seat');
});
test('P4 unbound claims clear a previous trusted runtime stamp on a new run',async()=>{
 const t=await card();const initial=await api(operator,'POST',`/api/tasks/${t.id}/claim`,{worker:'audit-hand-runner',runtime:'codex'});assert.equal(initial.status,200);
 const report=await api(shared,'POST',`/api/tasks/${t.id}/report`,{worker:'audit-hand-runner',run_id:initial.body.task.run_id,outcome:'done',evidence:'Synthetic old delivery'});assert.equal(report.status,200);
 const retry=await api(operator,'POST',`/api/tasks/${t.id}/resolve`,{verdict:'reject',resolved_by:'human',note:'Test next execution'});assert.equal(retry.status,200,JSON.stringify(retry.body));
 const r=await claim(shared,'audit-hand-runner','codex');assert.equal(r.status,200);assert.equal(r.body.task.id,t.id);assert.equal(r.body.task.last_runtime,null);assert.equal(evidence(r.body.task).ok,false);
});
test('P4 stopping a seat revokes its credential',async()=>{
 const token=seats.get('alpha');assert.ok(token);const r=await api(operator,'POST','/api/workers/alpha/stop',{});assert.equal(r.status,200);
 assert.equal((await claim(token,'alpha','codex')).status,401);
});
test('P4 loop uses a supervised credential without passing it to provider subprocesses',()=>{
 const r=spawnSync(PY,['-c',"import os,sys;sys.path.insert(0,sys.argv[1]);import worker_loop as w;assert w._board_token()=='synthetic-supervised-token';assert 'WORKER_BOARD_TOKEN' not in os.environ",join(ROOT,'loops')],{windowsHide:true,encoding:'utf8',timeout:15000,env:{...process.env,BOARD_DATA_DIR:TMP,BOARD_CONFIG:join(TMP,'fleet.json'),WORKER_BOARD_TOKEN:'synthetic-supervised-token',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(r.status,0,r.stderr);
});
