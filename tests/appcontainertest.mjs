import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,connect} from 'node:net';
import {execFileSync} from 'node:child_process';
import {pinFile,superviseCommand,superviseProcess} from '../core/execution/supervisor.mjs';
const ROOT=mkdtempSync(join(tmpdir(),'fleet-appcontainer-')),outside=join(ROOT,'private.txt');writeFileSync(outside,'PRIVATE-OUTSIDE-DATA');let serial=0;
const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||'python',['-I','-S','-X','utf8','-c','import sys;print(sys.executable)'],{encoding:'utf8',windowsHide:true}).trim()),command=pinFile(process.execPath);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp'].includes(k.toLowerCase())));
const isolation={kind:'windows-appcontainer',network:'none',memory_limit_bytes:256*1024*1024,process_limit:4};
after(()=>{const rel=relative(resolve(tmpdir()),resolve(ROOT));assert.ok(rel&&!rel.startsWith('..'));rmSync(ROOT,{recursive:true,force:true});});
function fixture(code){const cwd=join(ROOT,'work-'+serial),script=join(ROOT,'check-'+serial+++'.mjs');mkdirSync(cwd);writeFileSync(join(cwd,'input.txt'),'input');writeFileSync(script,code);return {cwd,script,options:{python,command,pins:[pinFile(script)],args:["--preserve-symlinks","--preserve-symlinks-main",script],cwd,env,timeoutMs:10000,isolation}};}
const denied=code=>['EACCES','EPERM'].includes(code);

test('actual AppContainer confines reads and writes while pinned support code remains read-only',async()=>{
 const f=fixture(`import {readFileSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {join,dirname,basename} from 'node:path';
 const attempt=fn=>{try{fn();return 'ALLOWED'}catch(e){return e.code}};
 const value={input:readFileSync('input.txt','utf8'),read:attempt(()=>readFileSync(process.argv[2])),write:attempt(()=>writeFileSync(process.argv[2],'BAD')),support_write:attempt(()=>writeFileSync(fileURLToPath(import.meta.url),'BAD')),original_support:attempt(()=>readFileSync(join(dirname(process.argv[2]),basename(fileURLToPath(import.meta.url)))))};writeFileSync('output.txt','allowed output');console.log(JSON.stringify(value));`);
 f.options.args.push(outside,f.script);const out=await superviseCommand(f.options);assert.equal(out.status,'success',JSON.stringify(out));const result=JSON.parse(out.stdout.text);
 assert.equal(result.input,'input');for(const key of ['read','write','support_write','original_support'])assert.ok(denied(result[key]),key+': '+result[key]);
 assert.equal(readFileSync(outside,'utf8'),'PRIVATE-OUTSIDE-DATA');assert.equal(readFileSync(join(f.cwd,'output.txt'),'utf8'),'allowed output');
 const s=out.process.sandbox;assert.equal(s.token_verified,true);assert.equal(s.capability_count,0);assert.equal(s.network,'none');assert.equal(s.profile_removed,true);assert.equal(s.staging_removed,true);assert.equal(out.process.cleanup,'job_empty');assert.equal(s.memory_limit_bytes,isolation.memory_limit_bytes);
});
test('no-network AppContainer cannot contact a confirmed live loopback listener',async()=>{
 let connections=0;const server=createServer(socket=>{connections++;socket.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{await new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);});const baseline=connections;
 const f=fixture(`import {connect} from 'node:net';const code=await new Promise(resolve=>{const s=connect(Number(process.argv[2]),'127.0.0.1');s.on('connect',()=>{s.destroy();resolve('ALLOWED')});s.on('error',e=>resolve(e.code));s.setTimeout(1500,()=>{s.destroy();resolve('TIMEOUT')})});console.log(code);`);f.options.args.push(String(port));const out=await superviseCommand(f.options);assert.equal(out.status,'success',JSON.stringify(out));assert.ok(['EACCES','EPERM','ETIMEDOUT','TIMEOUT'].includes(out.stdout.text.trim()),out.stdout.text);assert.equal(connections,baseline);await new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);});assert.equal(connections,baseline+1);assert.equal(out.process.sandbox.profile_removed,true);
 }finally{await new Promise(r=>server.close(r));}
});
test('one-process Job limit blocks a child that runs with a two-process allowance',async()=>{
 const f=fixture(`import {spawnSync} from 'node:child_process';console.log('SPAWN-START');const p=spawnSync(process.execPath,['-e','require("fs").writeFileSync("child-ran.txt","ran")'],{stdio:'inherit',windowsHide:true,timeout:1500});console.log(JSON.stringify({error:p.error?.code??null,status:p.status,signal:p.signal}));`);
 const one=await superviseCommand({...f.options,isolation:{...isolation,process_limit:1}});assert.ok(one.stdout.text.includes('SPAWN-START'),JSON.stringify(one));assert.equal(existsSync(join(f.cwd,'child-ran.txt')),false);assert.equal(one.process.cleanup,'job_empty');
 const two=await superviseCommand({...f.options,isolation:{...isolation,process_limit:2}});assert.equal(two.status,'success',JSON.stringify(two));assert.ok(existsSync(join(f.cwd,'child-ran.txt')),JSON.stringify(two));assert.equal(readFileSync(join(f.cwd,'child-ran.txt'),'utf8'),'ran');assert.equal(two.process.sandbox.profile_removed,true);
});
test('memory exhaustion is bounded by the Job and never becomes a passing command',async()=>{
 const f=fixture(`console.log('ALLOCATION-START');const memory=[];for(let i=0;i<512;i++)memory.push(Buffer.alloc(1024*1024,1));console.log('UNBOUNDED');`);f.options.isolation={...isolation,memory_limit_bytes:96*1024*1024};const out=await superviseCommand(f.options);assert.notEqual(out.status,'success',JSON.stringify(out));assert.ok(out.stdout.text.includes('ALLOCATION-START'),JSON.stringify(out));assert.ok(!out.stdout.text.includes('UNBOUNDED'));assert.equal(out.process.cleanup,'job_empty');assert.equal(out.process.sandbox.profile_removed,true);assert.equal(out.process.sandbox.staging_removed,true);
});
test('invalid isolation and unsafe workspace junction fail without an unconfined retry',async()=>{
 const f=fixture(`console.log('SHOULD-NOT-RUN');`);
 for(const value of [{...isolation,network:'internet'},{...isolation,memory_limit_bytes:0},{...isolation,process_limit:0},{...isolation,unknown:true}])await assert.rejects(superviseCommand({...f.options,isolation:value}),{code:'BAD_ISOLATION'});
 await assert.rejects(superviseProcess({...f.options,runtime:'claude'}),{code:'PROVIDER_ISOLATION_UNSUPPORTED'});
 const {symlinkSync}=await import('node:fs');symlinkSync(ROOT,join(f.cwd,'outside-link'),'junction');const out=await superviseCommand(f.options);assert.notEqual(out.status,'success');assert.equal(out.process.started,false);assert.ok(!out.stdout.text.includes('SHOULD-NOT-RUN'));assert.equal(readFileSync(outside,'utf8'),'PRIVATE-OUTSIDE-DATA');
});

test('cancellation stops sandbox descendants and removes the profile and staged inputs',async()=>{
 const f=fixture(`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});child.once('spawn',()=>writeFileSync('child.pid',String(child.pid)));setInterval(()=>{},1000);`),controller=new AbortController(),running=superviseCommand({...f.options,signal:controller.signal});
 let pid;try{for(let i=0;i<200;i++){if(existsSync(join(f.cwd,'child.pid'))){pid=Number(readFileSync(join(f.cwd,'child.pid'),'utf8'));break;}await new Promise(r=>setTimeout(r,20));}assert.ok(pid);}
 finally{controller.abort();}
 const out=await running;assert.equal(out.status,'cancelled',JSON.stringify(out));assert.equal(out.process.cleanup,'job_empty');assert.equal(out.process.sandbox.profile_removed,true);assert.equal(out.process.sandbox.staging_removed,true);assert.throws(()=>process.kill(pid,0));
});
