import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
const ROOT=resolve(process.env.BOARD_AUTH_TEST_ROOT||fileURLToPath(new URL('../',import.meta.url)));
const DIR=mkdtempSync(join(tmpdir(),'fleet-panel-auth-'));let child,base,operator,worker,review,logs='';
const headers=token=>({'X-Board-Token':token,'Content-Type':'application/json'});
before(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));base='http://127.0.0.1:'+port;
 const config=join(DIR,'fixture.json');writeFileSync(config,JSON.stringify({lines:[{id:'alpha'}],roles:[],routes:['default']}));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('BOARD_')));
 child=spawn(process.execPath,[join(ROOT,'core/server.mjs')],{cwd:ROOT,env:{...env,BOARD_NODE_NAME:'node-test',BOARD_CONFIG:config,BOARD_DATA_DIR:DIR,BOARD_DB:join(DIR,'board.db'),BOARD_PORT:String(port),BOARD_ALLOW_UNPINNED:'1',BOARD_NO_RESTORE:'1',BOARD_POOL_TEST_MODE:'1',BOARD_POOL_TEST_PROBE:'ok',BOARD_EXTRA_ORIGINS:'https://paired.example',BOARD_PYTHON:process.env.PYTHON||'',BOARD_TEST_SHUTDOWN_MS:'45000'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error('Fixture stopped');try{if((await fetch(base+'/health')).ok)break;}catch{}await delay(100);}
 operator=readFileSync(join(DIR,'board_token'),'utf8').trim();worker=readFileSync(join(DIR,'worker_token'),'utf8').trim();review=readFileSync(join(DIR,'review_token'),'utf8').trim();
});
after(async()=>{if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}assert.ok(!relative(tmpdir(),DIR).startsWith('..'));rmSync(DIR,{recursive:true,force:true});});
test('H2 anonymous panel has no credentials and supplies a protected pairing page',async()=>{
 for(const path of ['/','/panel.html']){const r=await fetch(base+path),html=await r.text();assert.equal(r.status,200);for(const token of [operator,worker,review])assert.equal(html.includes(token),false,'HTML must not contain a credential');assert.ok(html.includes('board-pair-form'));assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(r.headers.get('x-frame-options'),'DENY');assert.equal(r.headers.get('referrer-policy'),'no-referrer');}
 assert.match(logs,/BOARD_EXTRA_ORIGINS.*认证/);
});
test('H2 anonymous metadata preserves protocol discovery but no board identity or task reads',async()=>{
 assert.deepEqual(await (await fetch(base+'/api/meta')).json(),{worker_protocol_version:2});
 assert.equal((await fetch(base+'/api/meta',{headers:headers('wrong')})).status,401);
});
test('H2 every operational read and event stream rejects anonymous callers',async()=>{
 for(const path of ['/api/tasks','/api/workers','/api/context','/api/usage','/api/requests','/api/setup','/api/task-events','/api/events','/api/tasks/1/related','/api/fleet','/api/auth']){
  const r=await fetch(base+path,{signal:AbortSignal.timeout(1500)});assert.equal(r.status,401,path);const body=await r.text();assert.equal(body.includes(DIR),false);assert.equal(body.includes(operator),false);
 }
 assert.equal((await fetch(base+'/api/tasks',{method:'HEAD'})).status,401);
});
test('H2 authenticated roles keep protocol, board reads and operator-only pairing',async()=>{
 for(const token of [operator,worker,review]){const r=await fetch(base+'/api/meta',{headers:headers(token)});assert.equal(r.status,200);const meta=await r.json();assert.equal(meta.worker_protocol_version,2);assert.ok(meta.node.node_id);assert.ok(meta.status_labels);assert.equal((await fetch(base+'/api/tasks',{headers:headers(token)})).status,200);}
 assert.deepEqual(await (await fetch(base+'/api/auth',{headers:headers(operator)})).json(),{role:'operator'});
 for(const token of [worker,review])assert.equal((await fetch(base+'/api/auth',{headers:headers(token)})).status,403);
 for(const method of ['GET','POST'])assert.equal((await fetch(base+'/api/tasks',{method,headers:{...headers(operator),Origin:'https://foreign.example'},...(method==='POST'?{body:'{}'}:{})})).status,403);
 assert.equal((await fetch(base+'/api/auth',{headers:{...headers(operator),Origin:'https://paired.example'}})).status,200);
});
test('H2 authenticated SSE receives task changes without putting credentials in URLs',async()=>{
 const ctl=new AbortController();let reader;
 try{const r=await fetch(base+'/api/events?as=sentry',{headers:headers(operator),signal:ctl.signal});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/event-stream/);reader=r.body.getReader();await reader.read();
  const change=await fetch(base+'/api/tasks',{method:'POST',headers:headers(operator),body:JSON.stringify({subject:'Synthetic pairing test',line:'alpha'})});assert.equal(change.status,201);
  const observed=await Promise.race([reader.read(),delay(3000).then(()=>{throw Error('Missing SSE event');})]);assert.match(new TextDecoder().decode(observed.value),/task.created/);
 }finally{ctl.abort();await reader?.cancel().catch(()=>{});}
});

test('H3 authenticated task reads expose current blockers without changing task state',async()=>{
 const created=await fetch(base+'/api/tasks',{method:'POST',headers:headers(operator),body:JSON.stringify({subject:'Synthetic human-held work',line:'alpha',humanGate:true})});
 assert.equal(created.status,201);const t=(await created.json()).task;
 assert.ok(t.progress_blockers.some(r=>r.code==='HUMAN_GATE'));
 for(const token of [operator,worker,review]){
  const result=await (await fetch(base+'/api/tasks',{headers:headers(token)})).json(),read=result.tasks.find(x=>x.id===t.id);
  assert.equal(read.human_gate,true);assert.equal(read.aggregate_version,t.aggregate_version);assert.equal(read.attempts,0);
  assert.ok(read.progress_blockers.some(r=>r.code==='HUMAN_GATE'&&r.action==='claim'));
 }
 assert.equal((await fetch(base+'/api/tasks')).status,401);
});
