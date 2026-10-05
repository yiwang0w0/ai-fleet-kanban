import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildDesktopPackage} from '../core/desktop-package.mjs';
import {migrateBroker,putRole,issuePrincipal,revokePrincipal,authenticatePrincipal} from '../core/mcp/policy.mjs';
import {enrollTask} from '../core/mcp/tools.mjs';
import {listenBroker} from '../core/mcp/gateway.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-desktop-package-')),PS=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const store=createRequire(import.meta.url)('../core/store.js'),hash=b=>createHash('sha256').update(b).digest('hex');let kit,unpacked,db,server,credential,url,task,principal,zipMetadata;
function run(exe,args,input=''){
 return new Promise((resolve,reject)=>{const child=spawn(exe,args,{cwd:TMP,windowsHide:true,stdio:['pipe','pipe','pipe']}),timer=setTimeout(()=>{child.kill();reject(Error('child timed out'));},45000);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(input);});
}
before(async()=>{
 kit=buildDesktopPackage(join(TMP,'接入 包 & kit'));unpacked=join(TMP,'解包 后 & separate');mkdirSync(unpacked);
 const script='import sys,zipfile,os,json\na,d=sys.argv[1:3]\nwith zipfile.ZipFile(a) as z:\n assert z.testzip() is None\n assert all(os.path.commonpath([d,os.path.abspath(os.path.join(d,n))])==d for n in z.namelist())\n z.extractall(d)\n print(json.dumps([{\"path\":i.filename,\"bytes\":i.file_size,\"method\":i.compress_type,\"date\":i.date_time,\"flags\":i.flag_bits,\"extra\":len(i.extra),\"comment\":len(i.comment)} for i in z.infolist()]))';
 const extracted=spawnSync(process.env.PYTHON||'python',['-c',script,join(kit.output,kit.archive),unpacked],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});assert.equal(extracted.status,0,extracted.stderr);zipMetadata=JSON.parse(extracted.stdout);
 db=new DatabaseSync(join(TMP,'board.db'));store.migrate(db);migrateBroker(db);putRole(db,{role_id:'desktop-observe',kind:'observe',projects:['demo'],capabilities:[],runtime:null,model:null,effort:null,tools:'read-only',priority:10,enabled:true,limits:{max_task_attempts:1,max_open_tasks:10,requests_per_minute:300}});
 const id=store.add(db,{subject:'可查看任务',description:'PRIVATE-BODY-NOT-IN-CHECK-RECEIPT',acceptance:'fixture',treeMode:'hierarchical'});task=store.get(db,id);enrollTask(db,{id,projectId:'demo',workKind:'implement',capabilities:['board-tools'],expectedVersion:task.aggregate_version});
 credential=join(TMP,'观察者 凭据 & local.json');principal=issuePrincipal(db,{roleId:'desktop-observe',projects:['demo'],credentialFile:credential});server=await listenBroker(db,{port:0,boardUrl:'http://127.0.0.1:48319/'});url='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}db?.close();const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});

test('actual MCPB ZIP extracts independently and includes only the declared public bridge files',()=>{
 const files=JSON.parse(readFileSync(join(unpacked,'FILES.json'),'utf8'));assert.equal(files.files.length,10);assert.equal(existsSync(join(unpacked,'core/mcp/policy.mjs')),false);assert.equal(existsSync(join(unpacked,'core/store.js')),false);assert.equal(existsSync(join(kit.output,'.incomplete')),false);assert.equal(hash(readFileSync(join(kit.output,kit.archive))),kit.sha256);
 for(const f of files.files){const bytes=readFileSync(join(unpacked,f.path));assert.equal(bytes.length,f.bytes);assert.equal(hash(bytes),f.sha256);assert.ok(!f.path.includes('.data'));}
 const manifest=JSON.parse(readFileSync(join(unpacked,'manifest.json'),'utf8'));assert.equal(manifest.server.entry_point,'cli/mcp.mjs');assert.deepEqual(manifest.compatibility.platforms,['win32']);assert.equal(manifest.user_config.credential_file.type,'file');
});


test('ZIP metadata and independent Windows extraction match the staged public snapshot',async()=>{
 const files=JSON.parse(readFileSync(join(unpacked,'FILES.json'),'utf8')),expected=[...files.files.map(f=>f.path),'FILES.json'].sort();
 assert.deepEqual(zipMetadata.map(f=>f.path),expected);
 for(const entry of zipMetadata){assert.equal(entry.method,entry.bytes?8:0);assert.deepEqual(entry.date,[2020,1,1,0,0,0]);assert.equal(entry.flags,0x800);assert.equal(entry.extra,0);assert.equal(entry.comment,0);}
 const script=join(TMP,'read-archive.ps1'),destination=join(TMP,'Windows 解包 & output');
 writeFileSync(script,[
  'param([Parameter(Mandatory=$true)][string]$ArchivePath,[Parameter(Mandatory=$true)][string]$OutputPath)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '[System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $OutputPath)',
  'Write-Output "WINDOWS_ZIP_OK"'
 ].join('\n')+'\n');
 const result=await run(PS,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-ArchivePath',join(kit.output,kit.archive),'-OutputPath',destination]);
 assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.trim(),'WINDOWS_ZIP_OK');
 for(const path of expected){
  const staged=readFileSync(join(kit.output,'bundle',path)),python=readFileSync(join(unpacked,path)),windows=readFileSync(join(destination,path));
  assert.deepEqual(python,staged,path+' Python bytes');assert.deepEqual(windows,staged,path+' Windows bytes');
 }
});

test('building the package requires no PowerShell installation or PATH lookup',()=>{
 const saved=new Map(['SystemRoot','windir','PATH'].map(key=>[key,process.env[key]]));let isolated;
 try{
  process.env.SystemRoot=join(TMP,'unavailable-windows');process.env.windir=process.env.SystemRoot;process.env.PATH='';
  isolated=buildDesktopPackage(join(TMP,'without shell'));
 }finally{
  for(const [key,value] of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
 assert.equal(isolated.sha256,kit.sha256);assert.equal(existsSync(join(isolated.output,'.incomplete')),false);assert.equal(existsSync(join(TMP,'unavailable-windows')),false);
});

test('same source produces identical archive and existing output remains untouched',()=>{
 const second=buildDesktopPackage(join(TMP,'second kit'));assert.equal(second.sha256,kit.sha256);assert.throws(()=>buildDesktopPackage(second.output),/new directory/);assert.equal(hash(readFileSync(join(second.output,second.archive))),second.sha256);
 const occupied=join(TMP,'user-output');mkdirSync(occupied);writeFileSync(join(occupied,'keep.txt'),'keep');assert.throws(()=>buildDesktopPackage(occupied));assert.equal(readFileSync(join(occupied,'keep.txt'),'utf8'),'keep');
});

test('package output refuses a junction without touching its target',()=>{
 const target=join(TMP,'outside');mkdirSync(target);writeFileSync(join(target,'sentinel.txt'),'keep');const link=join(TMP,'linked');symlinkSync(target,link,'junction');try{assert.throws(()=>buildDesktopPackage(join(link,'kit')));assert.deepEqual(readdirSync(target),['sentinel.txt']);}finally{unlinkSync(link);}
});

test('extracted standalone stdio initializes, queries context and rejects mutations',async()=>{
 const lines=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'extracted-package',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_task_context',arguments:{task_uid:task.task_uid}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'create_task',arguments:{}}}];
 const result=await run(process.execPath,[join(unpacked,'cli/mcp.mjs'),'--url',url,'--credential-file',credential],lines.map(x=>JSON.stringify(x)).join('\n')+'\n');assert.equal(result.code,0,result.stderr);const messages=result.stdout.trim().split('\n').map(x=>JSON.parse(x));assert.equal(messages.length,4);assert.ok(messages[1].result.tools.some(t=>t.name==='get_board_overview'));assert.equal(messages[2].result.structuredContent.task.task_uid,task.task_uid);assert.equal(messages[3].result.isError,true);assert.equal(messages[3].result.structuredContent.code,'FORBIDDEN');assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});

test('portable connection check reports identity and counts without task bodies or credentials',async()=>{
 const result=await run(process.execPath,[join(unpacked,'cli/desktop-check.mjs'),'--url',url,'--credential-file',credential]);assert.equal(result.code,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.status,'ready');assert.equal(receipt.task_count,1);assert.equal(receipt.actual_desktop_client_verified,false);assert.equal(receipt.real_model_called,false);assert.ok(!result.stdout.includes('PRIVATE-BODY'));assert.ok(!result.stdout.includes(JSON.parse(readFileSync(credential,'utf8')).token));
});

test('extracted Windows preflight measures SQLite and connects with Unicode spaced ampersand paths',async()=>{
 const result=await run(PS,['-NoLogo','-NoProfile','-NonInteractive','-File',join(unpacked,'preflight.ps1'),'-NodePath',process.execPath,'-GitPath',join(TMP,'missing','git.exe'),'-TailscalePath',join(TMP,'missing','tailscale.exe'),'-BrokerUrl',url,'-CredentialFile',credential]);assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.node.supported,true);assert.equal(report.node.sqlite_available,true);assert.equal(report.git.supported,false);assert.equal(report.tailscale.status,'not_found');assert.equal(report.desktop_connection.status,'ready');assert.equal(report.providers_called,false);assert.equal(report.configuration_changed,false);assert.ok(!result.stdout.includes('PRIVATE-BODY'));assert.equal(db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});

test('preflight clearly records explicitly missing runtimes without installing or probing replacements',async()=>{
 const result=await run(PS,['-NoLogo','-NoProfile','-NonInteractive','-File',join(unpacked,'preflight.ps1'),'-NodePath',join(TMP,'missing','node.exe'),'-GitPath',join(TMP,'missing','git.exe'),'-TailscalePath',join(TMP,'missing','tailscale.exe')]);assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.node.supported,false);assert.equal(report.node.sqlite_available,false);assert.equal(report.git.supported,false);assert.equal(report.desktop_connection.status,'not_requested');assert.equal(existsSync(join(TMP,'missing')),false);
});

test('revoked portable credential returns failure without leaking its content',async()=>{
 const token=JSON.parse(readFileSync(credential,'utf8')).token;revokePrincipal(db,{principalId:principal.principal_id,expectedVersion:1});assert.equal(existsSync(credential),false);assert.throws(()=>authenticatePrincipal(db,'Bearer '+token),{code:'UNAUTHENTICATED'});const result=await run(process.execPath,[join(unpacked,'cli/desktop-check.mjs'),'--url',url,'--credential-file',credential]);assert.equal(result.code,1);const error=JSON.parse(result.stderr);assert.equal(error.status,'failed');assert.equal(error.real_model_called,false);assert.equal(error.code,'BAD_CREDENTIAL');assert.ok(!result.stderr.includes(token)&&!result.stdout.includes(token));assert.ok(!result.stderr.includes(credential));assert.equal(db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});
