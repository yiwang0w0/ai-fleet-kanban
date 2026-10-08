import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
const ROOT=resolve(process.env.BOARD_AUTH_TEST_ROOT||fileURLToPath(new URL('../',import.meta.url)));
const DIR=mkdtempSync(join(tmpdir(),'fleet-panel-auth-'));let child,base,operator,worker,review,logs='';
const headers=token=>({'X-Board-Token':token,'Content-Type':'application/json'});
let port;
// One board on DIR; H6 starts a second one on the same data to measure what survives a restart.
async function startBoard(){
 const config=join(DIR,'fixture.json');writeFileSync(config,JSON.stringify({lines:[{id:'alpha'}],roles:[],routes:['default']}));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('BOARD_')));
 child=spawn(process.execPath,[join(ROOT,'core/server.mjs')],{cwd:ROOT,env:{...env,BOARD_NODE_NAME:'node-test',BOARD_CONFIG:config,BOARD_DATA_DIR:DIR,BOARD_DB:join(DIR,'board.db'),BOARD_PORT:String(port),BOARD_ALLOW_UNPINNED:'1',BOARD_NO_RESTORE:'1',BOARD_POOL_TEST_MODE:'1',BOARD_POOL_TEST_PROBE:'ok',BOARD_EXTRA_ORIGINS:'https://paired.example',BOARD_PYTHON:process.env.PYTHON||'',BOARD_TEST_SHUTDOWN_MS:'45000'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error('Fixture stopped');try{if((await fetch(base+'/health')).ok)break;}catch{}await delay(100);}
}
before(async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;await new Promise(r=>server.close(r));base='http://127.0.0.1:'+port;
 await startBoard();
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

test('H3 fleet health is operator-only, sanitized and reads an unconfigured board without enabling services',async()=>{
 const path='/api/fleet/health';
 assert.equal((await fetch(base+path)).status,401);
 const r=await fetch(base+path,{headers:headers(operator)});assert.equal(r.status,200);
 const value=await r.json();assert.equal(value.format,'ai-fleet-health/v3');assert.equal(value.state_changes,false);assert.deepEqual(value.issues,[]);
 for(const token of [worker,review])assert.equal((await fetch(base+path,{headers:headers(token)})).status,403);
 assert.equal((await fetch(base+path,{headers:{...headers(operator),Origin:'https://foreign.example'}})).status,403);
 for(const secret of [DIR,operator,worker,review])assert.ok(!JSON.stringify(value).includes(secret));
 assert.match(r.headers.get('cache-control'),/no-store/);
});

test('H3 watcher reads actual authenticated health and cannot treat unavailable health as recovered',()=>{
 const db=new DatabaseSync(join(DIR,'board.db'));db.exec('PRAGMA busy_timeout=5000');
 try{
  db.exec('CREATE TABLE fleet_operator_actions(action_id TEXT PRIMARY KEY,node_id TEXT,node_epoch TEXT,state TEXT,created_at TEXT)');
  const n=db.prepare('SELECT node_id,sync_epoch FROM board_node').get();
  db.prepare('INSERT INTO fleet_operator_actions VALUES(?,?,?,?,?)').run(randomUUID(),n.node_id,n.sync_epoch,'blocked',new Date().toISOString());
  const run=()=>spawnSync(process.env.PYTHON||'python',[join(ROOT,'watchers/board_health_watch.py'),'--once'],{cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,BOARD_URL:base,BOARD_DATA_DIR:DIR,BOARD_GATED_SUBTREE:'',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  const observed=run();assert.equal(observed.status,1,observed.stderr);assert.match(observed.stdout,/投递受阻/);for(const token of [operator,worker,review])assert.ok(!observed.stdout.includes(token));
  db.exec('DROP TABLE fleet_operator_actions; CREATE TABLE fleet_operator_actions(private TEXT)');
  const unavailable=run();assert.equal(unavailable.status,1,unavailable.stderr);assert.match(unavailable.stdout,/联邦体检不可读/);assert.doesNotMatch(unavailable.stdout,/体检恢复正常/);
 }finally{db.close();}
});

let paired=null;   // a panel credential H4 leaves for H6
test('H4 one-time pairing: the operator mints a code, the board page trades it once, wrong guesses burn it',async()=>{
 const trade=(code,origin=base)=>fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify({code})});
 const mint=async()=>{const r=await fetch(base+'/api/pair/code',{method:'POST',headers:headers(operator),body:'{}'});assert.equal(r.status,201);const v=await r.json();
  assert.match(v.code,/^\d{6}$/);assert.ok(Date.parse(v.expires_at)-Date.now()<=10*60*1000+2000,'a code lives ten minutes at most');return v.code;};
 assert.equal((await fetch(base+'/api/pair/code',{method:'POST',body:'{}'})).status,401);
 for(const token of [worker,review])assert.equal((await fetch(base+'/api/pair/code',{method:'POST',headers:headers(token),body:'{}'})).status,403,'only the operator hands out pairing');
 assert.equal((await trade('123456')).status,401,'no live code, nothing to trade');
 let code=await mint();
 assert.equal((await trade(code,null)).status,403,'no Origin: not a board page');
 assert.equal((await trade(code,'https://foreign.example')).status,403,'another site cannot even try');
 const r=await trade(code);assert.equal(r.status,200);const got=await r.json();
 assert.equal(got.role,'operator');assert.match(got.token,/^[0-9a-f]{64}$/);assert.notEqual(got.token,operator,'a browser gets its own credential, never board_token');
 assert.ok(Date.parse(got.expires_at)-Date.now()>29*24*3600*1000&&Date.parse(got.expires_at)-Date.now()<=30*24*3600*1000+5000,'it lapses after 30 days');
 assert.deepEqual(await (await fetch(base+'/api/auth',{headers:headers(got.token)})).json(),{role:'operator'},'the panel credential is the operator in the panel');
 assert.equal((await fetch(base+'/api/tasks',{headers:headers(got.token)})).status,200);
 assert.equal((await trade(code)).status,401,'single use');
 const stored=readFileSync(join(DIR,'panel_sessions.json'),'utf8');assert.equal(stored.includes(got.token),false,'kept as a hash: the list opens nothing');
 // 退出连接: the credential revokes itself; board_token cannot be revoked this way.
 assert.deepEqual(await (await fetch(base+'/api/pair/revoke',{method:'POST',headers:headers(got.token),body:'{}'})).json(),{revoked:1});
 assert.equal((await fetch(base+'/api/auth',{headers:headers(got.token)})).status,401,'revoked means refused');
 assert.deepEqual(await (await fetch(base+'/api/pair/revoke',{method:'POST',headers:headers(operator),body:'{}'})).json(),{revoked:0});
 assert.equal((await fetch(base+'/api/auth',{headers:headers(operator)})).status,200,'board_token is untouched');
 for(const token of [worker,review])assert.equal((await fetch(base+'/api/pair/revoke',{method:'POST',headers:headers(token),body:'{"all":true}'})).status,403);
 code=await mint();const wrong=code==='000000'?'000001':'000000';
 for(let i=0;i<5;i++){const miss=await trade(wrong);assert.equal(miss.status,401);assert.equal((await miss.text()).includes(operator),false);}
 assert.equal((await trade(code)).status,401,'five wrong guesses burn the code');
 const first=await mint(),second=await mint();
 if(first!==second)assert.equal((await trade(first)).status,401,'a new code replaces the old one');
 const fromExtra=await trade(second,'https://paired.example');assert.equal(fromExtra.status,200,'an allowed extra origin is a board page too');
 paired=(await fromExtra.json()).token;
 assert.equal((await fetch(base+'/api/pair',{headers:headers(operator)})).status,404,'GET is not a pairing route');
});

// It stops the fixture board; H6 starts it again on the same data.
test('H5 node cli/stop.mjs: operator-only, refuses while a card runs unless forced, then the board exits cleanly',async()=>{
 const stop=(token,body={})=>fetch(base+'/api/setup/stop',{method:'POST',headers:token?headers(token):{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await stop(null)).status,401);
 for(const token of [worker,review])assert.equal((await stop(token)).status,403);
 const created=await fetch(base+'/api/tasks',{method:'POST',headers:headers(operator),body:JSON.stringify({subject:'Synthetic running card',line:'alpha'})});assert.equal(created.status,201);
 const claimed=await fetch(base+'/api/claim',{method:'POST',headers:headers(operator),body:JSON.stringify({worker:'alpha',line:'alpha',route:'default'})});assert.equal(claimed.status,200);
 const held=await stop(operator);assert.equal(held.status,409);const why=await held.json();assert.equal(why.needs_force,true);assert.ok(why.in_progress>=1);
 assert.equal((await fetch(base+'/health')).status,200,'refused means nothing stopped');
 const exited=new Promise(r=>child.once('exit',code=>r(code)));
 const forced=await stop(operator,{force:true});assert.equal(forced.status,202);assert.deepEqual(await forced.json(),{stopping:true});
 assert.equal(await Promise.race([exited,delay(15000,'timeout',{ref:false})]),0);
 assert.match(logs,/停止看板\(操作员请求,node cli\/stop\.mjs\)/,'the log says who stopped it');
});

test('H6 a remembered browser survives a board restart; forgetting every browser needs the operator',async()=>{
 assert.ok(paired,'H4 left a panel credential');
 await startBoard();
 assert.equal((await fetch(base+'/api/auth',{headers:headers(paired)})).status,200,'still paired after the restart');
 assert.deepEqual(await (await fetch(base+'/api/pair/revoke',{method:'POST',headers:headers(operator),body:'{"all":true}'})).json(),{revoked:1});
 assert.equal((await fetch(base+'/api/auth',{headers:headers(paired)})).status,401,'every browser pairs again');
 assert.equal((await fetch(base+'/api/auth',{headers:headers(operator)})).status,200);
});
