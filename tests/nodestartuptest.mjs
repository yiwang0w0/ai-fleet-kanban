import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,rmSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {migratePeers,localIdentity} from '../core/federation/peers.mjs';
import {nodeRuntimeStatus,nodeLifecycle} from '../core/node-runtime.mjs';
import {startupTaskXML} from '../core/node-startup.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-startup-')),source=join(TMP,'治理 & ($literal) source'),store=createRequire(import.meta.url)('../core/store.js'),PS=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),dbs=[],children=[];
mkdirSync(source);for(const dir of ['core','cli','packaging/windows'])cpSync(join(ROOT,dir),join(source,dir),{recursive:true});
const git=args=>execFileSync('git',['-C',source,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();git(['init','--quiet','--template=']);git(['config','core.autocrlf','false']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);const approval=join(TMP,'accepted-fixture');writeFileSync(approval,git(['rev-parse','HEAD:']));
const sha=b=>createHash('sha256').update(b).digest('hex');
after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill();for(const db of dbs)db.close();const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
function node(args){return spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:30000});}
function cli(args){return node([join(source,'cli/node-startup.mjs'),...args]);}
function fixture(){const dir=mkdtempSync(join(TMP,'node-')),dbPath=join(dir,'board.db'),db=new DatabaseSync(dbPath);dbs.push(db);store.migrate(db);migratePeers(db);const n=localIdentity(db),config=join(dir,'config.json'),bundle=join(dir,'启动 & ($literal) bundle');writeFileSync(config,JSON.stringify({format:'ai-fleet-node-runtime/v1',node_id:n.node_id,node_epoch:n.sync_epoch,peer:null,mcp:{port:0,board_url:null},sync:[],scheduler:null}));return {dir,dbPath,db,n,config,bundle};}
function prepare(f){const r=cli(['prepare','--db',f.dbPath,'--config-file',f.config,'--accepted-rev',approval,'--output',f.bundle]);assert.equal(r.status,0,r.stderr);const plan=JSON.parse(r.stdout);f.digest=plan.manifest_sha256;return plan;}
const args=(f,action)=>['-NoLogo','-NoProfile','-NonInteractive','-File',join(source,'packaging/windows/node-startup.ps1'),'-Action',action,'-Bundle',f.bundle,'-Digest',f.digest];
const ps=(f,action)=>spawnSync(PS,args(f,action),{encoding:'utf8',windowsHide:true,timeout:30000});
const check=(f,command='check')=>cli([command,'--bundle',f.bundle,'--digest',f.digest]);
async function waitFor(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(50);}throw Error('startup wait timed out');}
const events=f=>readdirSync(f.bundle).filter(x=>x.endsWith('.jsonl')).flatMap(x=>readFileSync(join(f.bundle,x),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));

test('prepare is read-only for node data and actual Task Scheduler validates without registering',()=>{
 const f=fixture(),before=sha(readFileSync(f.dbPath)),plan=prepare(f);assert.equal(sha(readFileSync(f.dbPath)),before);assert.equal(plan.registered,false);assert.equal(plan.scheduler_enabled,false);const xml=readFileSync(join(f.bundle,'task.xml'),'utf8');assert.match(xml,/<LogonType>InteractiveToken/);assert.match(xml,/<RunLevel>LeastPrivilege/);assert.match(xml,/<ExecutionTimeLimit>PT0S/);assert.match(xml,/<Enabled>false/);assert.doesNotMatch(xml,/RestartOnFailure|BootTrigger|Password/);
 const r=ps(f,'Validate');assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).configuration_changed,false);const status=ps(f,'Status');assert.equal(status.status,0,status.stdout+status.stderr);assert.equal(JSON.parse(status.stdout).registered,false);assert.equal(nodeRuntimeStatus(f.db).configured,false);
});

test('short-path source preparation preserves wrapper identity and refuses identical copies',t=>{
 const f=fixture(),wrapper=join(source,'packaging/windows/node-startup.ps1');
 const script=String.raw`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));(New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath`;
 const r=spawnSync(PS,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:Buffer.from(source,'utf8').toString('base64'),encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.status,0,r.stderr);const alias=r.stdout.trim();
 if(alias.toLowerCase()===source.toLowerCase()){t.skip('This volume does not provide 8.3 aliases');return;}
 const nested=join(alias,'unapproved-startup-bundle'),actualNested=join(realpathSync.native(source),'unapproved-startup-bundle');
 try {const unsafe=node([join(alias,'cli/node-startup.mjs'),'prepare','--db',f.dbPath,'--config-file',f.config,'--accepted-rev',approval,'--output',nested]);assert.equal(unsafe.status,1,unsafe.stderr);assert.match(unsafe.stderr,/UNSAFE_RUNTIME_PATH/);}
 finally {const rel=relative(realpathSync.native(source),resolve(actualNested));assert.equal(rel,'unapproved-startup-bundle');rmSync(actualNested,{recursive:true,force:true});}
 assert.equal(realpathSync.native(alias),realpathSync.native(source));
 assert.notEqual(realpathSync(alias).toLowerCase(),realpathSync.native(alias).toLowerCase());
 t.diagnostic('Node ordinary realpath preserves the 8.3 spelling; native realpath expands it');
 const prepared=node([join(alias,'cli/node-startup.mjs'),'prepare','--db',f.dbPath,'--config-file',f.config,'--accepted-rev',approval,'--output',f.bundle]);assert.equal(prepared.status,0,prepared.stderr);f.digest=JSON.parse(prepared.stdout).manifest_sha256;
 const validated=ps(f,'Validate');assert.equal(validated.status,0,validated.stdout+validated.stderr);assert.equal(JSON.parse(validated.stdout).configuration_changed,false);
 const manifest=JSON.parse(readFileSync(join(f.bundle,'STARTUP.json'),'utf8'));assert.equal(manifest.wrapper.path,realpathSync.native(wrapper));assert.equal(manifest.source_root,realpathSync.native(source));assert.equal(check(f).status,0);
 const argv=args(f,'Validate');argv[4]=join(alias,'packaging/windows/node-startup.ps1');const viaAlias=spawnSync(PS,argv,{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(viaAlias.status,0,viaAlias.stdout+viaAlias.stderr);
 const copy=join(f.dir,'copied-wrapper.ps1');writeFileSync(copy,readFileSync(wrapper));argv[4]=copy;const rejected=spawnSync(PS,argv,{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(rejected.status,1,rejected.stdout+rejected.stderr);assert.match(rejected.stdout,/STARTUP_BINDING_CHANGED/);assert.equal(nodeRuntimeStatus(f.db).configured,false);
});

test('hidden PowerShell launcher handles literal metacharacter paths, serves real MCP and drains its exact instance',async()=>{
 const f=fixture();prepare(f);const child=spawn(PS,args(f,'Run'),{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 try{
  await waitFor(()=>{if(child.exitCode!==null)throw Error(out+err);return nodeRuntimeStatus(f.db).instances[0]?.components.some(c=>c.name==='mcp'&&c.state==='listening');});const s=nodeRuntimeStatus(f.db).instances[0],port=s.components.find(c=>c.name==='mcp').summary.port;
  assert.equal((await fetch('http://127.0.0.1:'+port+'/local/v1/tools/list',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const second=ps(f,'Run');assert.equal(second.status,1,second.stdout+second.stderr);assert.ok(events(f).some(e=>e.kind==='attention'&&e.code==='NODE_RUNTIME_BUSY'));assert.equal(nodeRuntimeStatus(f.db).instances.length,1);
  nodeLifecycle.requestStop(f.db,{instanceId:s.instance_id,expectedRevision:s.revision,requestId:randomUUID(),mode:'drain'});await waitFor(()=>child.exitCode!==null);assert.equal(await done,0,out+err);assert.equal(nodeRuntimeStatus(f.db).instances[0].state,'stopped');assert.ok(events(f).some(e=>e.kind==='closed'));assert.equal(f.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
 }finally{const s=nodeRuntimeStatus(f.db).instances.find(s=>!s.ended_at);if(s)try{nodeLifecycle.requestStop(f.db,{instanceId:s.instance_id,expectedRevision:s.revision,requestId:randomUUID(),mode:'cancel'});}catch{}if(child.exitCode===null&&child.signalCode===null){await Promise.race([done,delay(5000)]);if(child.exitCode===null&&child.signalCode===null)child.kill();}await done;}
});

test('review digest and independently modified XML are refused before any host instance',()=>{
 const f=fixture();prepare(f);const digest=f.digest;f.digest='0'.repeat(64);assert.match(check(f).stderr,/STARTUP_REVIEW_CHANGED/);f.digest=digest;const xml=join(f.bundle,'task.xml');writeFileSync(xml,readFileSync(xml,'utf8').replace('LeastPrivilege','HighestAvailable'));const r=ps(f,'Validate');assert.equal(r.status,1);assert.equal(nodeRuntimeStatus(f.db).configured,false);
});

test('changed config blocks startup while read-only bundle inspection and task status remain available',()=>{
 const f=fixture();prepare(f);writeFileSync(f.config,readFileSync(f.config,'utf8')+' ');assert.match(check(f).stderr,/STARTUP_INPUT_CHANGED/);assert.equal(check(f,'inspect').status,0);const r=ps(f,'Status');assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).registered,false);assert.equal(nodeRuntimeStatus(f.db).configured,false);
});

test('dirty governance source refuses launch instead of silently adopting a later checkout',()=>{
 const f=fixture();prepare(f);const extra=join(source,'unexpected.txt');writeFileSync(extra,'changed');try{assert.match(check(f).stderr,/SOURCE_DIRTY/);assert.equal(nodeRuntimeStatus(f.db).configured,false);}finally{rmSync(extra);}
});

test('a changed pinned Node binary and changed user identity are rejected even with a recomputed bundle digest',()=>{
 const f=fixture();prepare(f);const file=join(f.bundle,'STARTUP.json'),original=JSON.parse(readFileSync(file,'utf8'));function replace(m){const bytes=JSON.stringify(m,null,2)+'\n';writeFileSync(file,bytes);f.digest=sha(bytes);writeFileSync(join(f.bundle,'task.xml'),startupTaskXML(m,f.digest));}
 const m=structuredClone(original);m.node.sha256='0'.repeat(64);replace(m);assert.match(check(f).stderr,/STARTUP_INPUT_CHANGED/);m.node=original.node;m.user_sid='S-1-5-21-123-456-789-1001';replace(m);assert.match(check(f).stderr,/STARTUP_BINDING_CHANGED/);assert.equal(nodeRuntimeStatus(f.db).configured,false);
});

test('existing bundle output is preserved and paths with task-environment expansion are refused',()=>{
 const f=fixture();prepare(f);const before=readFileSync(join(f.bundle,'STARTUP.json'),'utf8'),r=cli(['prepare','--db',f.dbPath,'--config-file',f.config,'--accepted-rev',approval,'--output',f.bundle]);assert.match(r.stderr,/STARTUP_EXISTS/);assert.equal(readFileSync(join(f.bundle,'STARTUP.json'),'utf8'),before);f.bundle=join(f.dir,'%TEMP%');const bad=cli(['prepare','--db',f.dbPath,'--config-file',f.config,'--accepted-rev',approval,'--output',f.bundle]);assert.match(bad.stderr,/BAD_INPUT/);
});

// Mutation adapter tests use an in-memory registry; real COM only normalizes definitions.
// No test creates, enables, starts, disables or removes an actual scheduled task.
function management(f,scenario){
 const wrapper=join(source,'packaging/windows/node-startup.ps1'),payload=Buffer.from(JSON.stringify({bundle:f.bundle,digest:f.digest,wrapper,scenario}),'utf8').toString('base64');
 const script=String.raw`
 $ErrorActionPreference='Stop'
 $ProgressPreference='SilentlyContinue'
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
 $global:inputPlan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
 $global:realService=New-Object -ComObject Schedule.Service
 $realService.Connect()
 $global:registry=@{}
 $global:trace=[Collections.Generic.List[string]]::new()
 $global:mockFolder=[pscustomobject]@{}
 $mockFolder | Add-Member ScriptMethod GetTask { param($name) if($global:registry.ContainsKey($name)){return $global:registry[$name]};return $null }
 $mockFolder | Add-Member ScriptMethod RegisterTask { param($name,$xml,$flags,$sid,$password,$logon,$sddl)
   $global:trace.Add('register:'+ $name+':'+$flags)
   if($flags -ne 2 -or $null -ne $password -or $logon -ne 3) {throw 'bad registration contract'}
   $def=$global:realService.NewTask(0);$def.XmlText=$xml
   $task=[pscustomobject]@{Definition=$def;Enabled=[bool]$def.Settings.Enabled;State=3;LastTaskResult=0;Name=$name;ActiveCount=0}
   $task | Add-Member ScriptMethod GetInstances {param($flags) return [pscustomobject]@{Count=$this.ActiveCount} }
   $task | Add-Member ScriptMethod Run {param($parameters) $global:trace.Add('run:'+$this.Name);return $null }
   $global:registry[$name]=$task;return $task
 }
 $mockFolder | Add-Member ScriptMethod DeleteTask {param($name,$flags) $global:trace.Add('delete:'+$name);$global:registry.Remove($name) }
 $global:mockService=[pscustomobject]@{}
 $mockService | Add-Member ScriptMethod Connect { }
 $mockService | Add-Member ScriptMethod GetFolder {param($name) if($name -cne '\'){throw 'wrong folder'};return $global:mockFolder }
 $mockService | Add-Member ScriptMethod NewTask {param($flags) return $global:realService.NewTask($flags) }
 function global:New-Object { param([string]$ComObject) if($ComObject -cne 'Schedule.Service'){throw 'unexpected COM object'};return $global:mockService }
 & $inputPlan.wrapper -Action Install -Bundle $inputPlan.bundle -Digest $inputPlan.digest
 if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
 $name=([IO.File]::ReadAllText((Join-Path $inputPlan.bundle 'STARTUP.json')) | ConvertFrom-Json).task_name
 if($inputPlan.scenario -eq 'lifecycle') {
   if($registry[$name].Enabled){throw 'installed enabled'}
   & $inputPlan.wrapper -Action Enable -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   if(-not $registry[$name].Enabled){throw 'enable missing'}
   & $inputPlan.wrapper -Action Start -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   & $inputPlan.wrapper -Action Disable -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   if($registry[$name].Enabled){throw 'disable missing'}
   & $inputPlan.wrapper -Action Remove -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   if($registry.Count -ne 0){throw 'not removed'}
   @{mock_registry=$true;trace=@($trace)} | ConvertTo-Json -Compress
 } elseif($inputPlan.scenario -eq 'foreign') {
   $registry[$name].Definition.Actions.Item(1).Arguments+=' changed'
   & $inputPlan.wrapper -Action Enable -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   throw 'foreign definition incorrectly accepted'
 } elseif($inputPlan.scenario -eq 'duplicate') {
   & $inputPlan.wrapper -Action Install -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   throw 'duplicate incorrectly accepted'
 } elseif($inputPlan.scenario -eq 'active') {
   $registry[$name].ActiveCount=1
   & $inputPlan.wrapper -Action Remove -Bundle $inputPlan.bundle -Digest $inputPlan.digest
   throw 'active task incorrectly removed'
 }
 `;
 return spawnSync(PS,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:payload,encoding:'utf8',windowsHide:true,timeout:60000});
}

test('management adapter creates only disabled tasks then explicitly enables, starts, disables and removes the exact definition',()=>{
 const f=fixture(),plan=prepare(f),r=management(f,'lifecycle');assert.equal(r.status,0,r.stdout+r.stderr);const result=JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));assert.equal(result.mock_registry,true);assert.deepEqual(result.trace,['register:'+plan.task_name+':2','run:'+plan.task_name,'delete:'+plan.task_name]);assert.equal(nodeRuntimeStatus(f.db).configured,false);
});

test('management adapter refuses altered registered definitions, duplicate registration and active removal',()=>{
 const f=fixture();prepare(f);for(const [scenario,code] of [['foreign','STARTUP_TASK_CHANGED'],['duplicate','STARTUP_TASK_EXISTS'],['active','STARTUP_TASK_ACTIVE']]){const r=management(f,scenario);assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,new RegExp(code));}assert.equal(nodeRuntimeStatus(f.db).configured,false);
});
