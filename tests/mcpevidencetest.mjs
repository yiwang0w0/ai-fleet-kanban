import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {evidenceFixture,addEvidenceHistory} from './helpers/fleet-evidence-fixture.mjs';
import {migrateBroker,putRole,issuePrincipal,revokePrincipal} from '../core/mcp/policy.mjs';
import {callTool,listTools,enrollTask} from '../core/mcp/tools.mjs';
import {listenBroker} from '../core/mcp/gateway.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const sections=['children','relations','runs','results','artifacts','verifications','integrations','completions'];
function policy(kind='observe'){return {role_id:kind,kind,projects:['demo','private'],capabilities:[],runtime:null,model:null,effort:null,tools:kind==='observe'?'read-only':'write',priority:10,enabled:true,limits:{max_task_attempts:1,max_open_tasks:300,requests_per_minute:300}};}
function grant(f,kind='observe',projects=['demo']){putRole(f.db,policy(kind));const file=join(f.dir,kind+'.json'),principal=issuePrincipal(f.db,{roleId:kind,projects,credentialFile:file}),credential=JSON.parse(readFileSync(file,'utf8'));return {file,principal,auth:'Bearer '+credential.token,credential};}
function fixture(t,count=205){const dir=mkdtempSync(join(tmpdir(),'fleet-mcp-evidence-')),f={...evidenceFixture(),dir};t.after(()=>{f.db.close();const rel=relative(resolve(tmpdir()),resolve(dir));assert.ok(rel&&!rel.startsWith('..'));rmSync(dir,{recursive:true,force:true});});migrateBroker(f.db);addEvidenceHistory(f,count);f.reader=grant(f);return f;}
const read=(f,args={},reader=f.reader)=>callTool(f.db,reader.auth,'get_task_evidence',{task_uid:f.root.task_uid,section:'runs',...args},{boardUrl:'http://127.0.0.1:48300/'});
function business(f){return JSON.stringify(['tasks','task_runs','task_events','broker_assignments','broker_requests','delegation_results'].map(name=>[name,f.db.prepare('SELECT * FROM '+name).all()]));}

test('observer and coordinator traverse all evidence pages without task changes or private payloads',t=>{
 const f=fixture(t),coord=grant(f,'coordinate'),before=business(f);
 for(const reader of [f.reader,coord]){const tool=listTools(f.db,reader.auth).tools.find(t=>t.name==='get_task_evidence');assert.ok(tool,'MCP must expose evidence pagination');assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
  for(const [section,key,total] of [['runs','run_id',205],['results','result_id',205],['relations','relation_id',206]]){
   let out=read(f,{section},reader),page=out.page;const id=page.snapshot_id,items=[...page.items],sizes=[page.items.length];assert.equal(out.read_only,true);assert.equal(out.content_is_untrusted,true);assert.equal(out.current_authorization_checked,false);assert.equal(out.coverage,'locally_recorded_history');assert.ok(out.task_url.includes(encodeURIComponent(f.root.task_uid)));
   while(page.next_cursor){out=read(f,{section,cursor:page.next_cursor},reader);page=out.page;assert.equal(page.snapshot_id,id);items.push(...page.items);sizes.push(page.items.length);}
   assert.deepEqual(sizes,[100,100,total-200]);assert.equal(new Set(items.map(r=>r[key])).size,total);assert.equal(page.next_cursor,null);assert.ok(!JSON.stringify(items).includes('PRIVATE-'));assert.ok(!JSON.stringify(out).includes(reader.credential.token));
  }
 }
 assert.equal(business(f),before);assert.ok(f.db.prepare("SELECT count(*) n FROM broker_audit WHERE tool_name='get_task_evidence' AND outcome='succeeded'").get().n>=18);
});

test('task context cursors continue through MCP and every section supports explicit first-page reads',t=>{
 const f=fixture(t,2),context=callTool(f.db,f.reader.auth,'get_task_context',{task_uid:f.root.task_uid});
 for(const section of sections){const out=read(f,{section,cursor:context.task.evidence[section].cursor});assert.deepEqual(out.page,context.task.evidence[section]);}
 const children=read(f,{section:'children',limit:1});assert.equal(children.page.items[0].task_uid,f.source.task_uid);assert.equal(children.page.total,1);
 const first=read(f,{limit:1}).page,next=read(f,{limit:1,cursor:first.next_cursor}).page;assert.notEqual(first.items[0].run_id,next.items[0].run_id);assert.deepEqual(read(f,{limit:1,cursor:first.cursor}).page,first);
});

test('history tool hides unauthorized and withdrawn tasks and never returns raw policies',t=>{
 const f=fixture(t,2),privateId=f.store.add(f.db,{subject:'PRIVATE-TASK'});enrollTask(f.db,{id:privateId,projectId:'private',workKind:'implement',capabilities:[],expectedVersion:1});const hidden=f.store.get(f.db,privateId);
 for(const task_uid of [hidden.task_uid,randomUUID()+'/'+randomUUID()])assert.throws(()=>read(f,{task_uid}),{code:'NOT_FOUND',status:404});
 const raw=JSON.stringify({context:{model:'fixture',effort:'low',token:'PRIVATE-TOKEN',command:'PRIVATE-COMMAND',path:'PRIVATE-PATH'}});
 f.db.prepare('INSERT INTO task_runs(run_id,task_id,task_uid,owner_node_id,executor_node_id,worker,role_id,runtime,agent_instance_id,policy_json,policy_sha256,started_at,first_attempt,last_attempt,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.source.id,f.source.task_uid,f.local.node_id,f.local.node_id,'fixture','implementer','fixture',randomUUID(),raw,createHash('sha256').update(raw).digest('hex'),f.now,1,1,'ended');
 let cursor=null;do{const out=read(f,{limit:1,...(cursor?{cursor}:{})});assert.ok(!JSON.stringify(out).includes('PRIVATE-'));cursor=out.page.next_cursor;}while(cursor);
 const old=read(f,{section:'relations'}).page;f.db.prepare('UPDATE federation_replicas SET withdrawn=1 WHERE task_uid=?').run(f.target);
 assert.throws(()=>read(f,{section:'relations',cursor:old.cursor}),{code:'EVIDENCE_CHANGED',status:409});assert.throws(()=>read(f,{task_uid:f.target}),{code:'NOT_FOUND',status:404});assert.ok(!JSON.stringify(read(f,{section:'relations'})).includes(f.target));
});

test('evidence paging rejects malformed schemas and cursors bound to another task, section or limit',t=>{
 const f=fixture(t,2),page=read(f,{limit:1}).page;
 for(const args of [{section:'secret'},{limit:0},{limit:101},{limit:1.5},{limit:'1'},{cursor:null},{cursor:''},{cursor:'x'.repeat(1025)},{cursor:'!invalid'},{offset:1},{request_id:randomUUID()},{project_id:'private'},{task_uid:f.source.task_uid,limit:1,cursor:page.next_cursor},{section:'results',limit:1,cursor:page.next_cursor},{cursor:page.next_cursor}])assert.throws(()=>read(f,args),{code:'BAD_INPUT',status:400});
 assert.throws(()=>callTool(f.db,f.reader.auth,'get_task_evidence',{task_uid:f.root.task_uid}),{code:'BAD_INPUT'});
});

test('new history, changed task, role version and revoked principal invalidate continuation',t=>{
 const f=fixture(t,2);let first=read(f,{limit:1}).page;addEvidenceHistory(f,1);assert.throws(()=>read(f,{limit:1,cursor:first.next_cursor}),{code:'EVIDENCE_CHANGED'});
 first=read(f,{limit:1}).page;f.db.prepare("UPDATE tasks SET description='new version' WHERE id=?").run(f.root.id);assert.throws(()=>read(f,{limit:1,cursor:first.next_cursor}),{code:'EVIDENCE_CHANGED'});
 first=read(f,{limit:1}).page;const coord=grant(f,'coordinate');putRole(f.db,{...policy('coordinate'),projects:['private']},1);assert.throws(()=>read(f,{limit:1,cursor:first.next_cursor},coord),{code:'POLICY_CHANGED',status:403});
 revokePrincipal(f.db,{principalId:f.reader.principal.principal_id,expectedVersion:1});assert.throws(()=>read(f,{limit:1,cursor:first.next_cursor}),{code:'UNAUTHENTICATED',status:401});
});

test('independent stdio client reads 205 runs and receives stale-page and revocation errors',async t=>{
 const f=fixture(t),server=await listenBroker(f.db,{port:0,boardUrl:'http://127.0.0.1:48300/'}),child=spawn(process.execPath,[join(ROOT,'cli/mcp.mjs'),'--url','http://127.0.0.1:'+server.address().port,'--credential-file',f.reader.file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stderr='',nextId=0;const pending=new Map(),done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),lines=createInterface({input:child.stdout});child.stderr.on('data',b=>stderr+=b.toString());lines.on('line',line=>{const out=JSON.parse(line),wait=pending.get(out.id);if(wait){clearTimeout(wait.timer);pending.delete(out.id);wait.resolve(out);}});
 const send=(method,params)=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('stdio response timeout'));},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  const init=await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'history-fixture',version:'1'}});assert.ok(init.result);child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  assert.ok((await send('tools/list',{})).result.tools.some(t=>t.name==='get_task_evidence'));
  const query=async(cursor=null)=>{const out=await send('tools/call',{name:'get_task_evidence',arguments:{task_uid:f.root.task_uid,section:'runs',...(cursor?{cursor}:{})}});assert.equal(out.error,undefined);return out.result;};
  let r=await query();assert.equal(r.isError,false);const first=r.structuredContent.page,ids=first.items.map(x=>x.run_id),sizes=[ids.length];let page=first;
  while(page.next_cursor){r=await query(page.next_cursor);assert.equal(r.isError,false);page=r.structuredContent.page;sizes.push(page.items.length);ids.push(...page.items.map(x=>x.run_id));}assert.deepEqual(sizes,[100,100,5]);assert.equal(new Set(ids).size,205);
  addEvidenceHistory(f,1);r=await query(first.next_cursor);assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'EVIDENCE_CHANGED');assert.equal(r.structuredContent.page,undefined);
  const fresh=await query();assert.equal(fresh.structuredContent.page.total,206);revokePrincipal(f.db,{principalId:f.reader.principal.principal_id,expectedVersion:1});r=await query();assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'UNAUTHENTICATED');assert.ok(!JSON.stringify(r).includes(f.reader.credential.token));
  child.stdin.end();assert.equal(await done,0,stderr);
 }finally{for(const w of pending.values()){clearTimeout(w.timer);w.reject(Error('test cleanup'));}if(child.exitCode===null)child.kill();await done;lines.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
