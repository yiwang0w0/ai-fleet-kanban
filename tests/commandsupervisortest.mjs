import test,{after} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {pinFile,superviseCommand,superviseProcess} from "../core/execution/supervisor.mjs";
import {createCommandOutput} from "../core/execution/command-output.mjs";
const TMP=mkdtempSync(join(tmpdir(),"fleet-command-中文-")),script=join(TMP,"trusted check.mjs"),file=join(TMP,"child.pid");
const python=pinFile(execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys;print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim()),command=pinFile(process.execPath),env=Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase())));
writeFileSync(script,`import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const mode=process.argv[2];let input='';for await(const b of process.stdin)input+=b.toString('utf8');
if(mode==='echo')console.log(JSON.stringify({input,marker:process.env.FLEET_COMMAND_MARKER??null}));
else if(mode==='failed'){process.stderr.write('测试失败\\n');process.exitCode=7;}
else if(mode==='invalid')process.stdout.write(Buffer.from([255]));
else if(mode==='noise'||mode==='stderr')setInterval(()=>(mode==='noise'?process.stdout:process.stderr).write('x'.repeat(65536)),1);
else if(mode==='tree'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});writeFileSync(process.argv[3],String(child.pid));setInterval(()=>{},1000);}
else if(mode==='hang')setInterval(()=>{},1000);
else if(mode==='silent'){}
else console.log('provider-looking text is not a provider receipt');
`);
const pin=pinFile(script),hash=b=>createHash("sha256").update(b).digest("hex");
const run=(mode="echo",extra={})=>superviseCommand({python,command,args:[script,mode,file],cwd:TMP,env,input:"",pins:[pin],timeoutMs:5000,...extra});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
after(()=>rmSync(TMP,{recursive:true,force:true}));

test("ordinary command receipt binds actual stdout/stderr hashes, native exit and Windows cleanup",async()=>{
 const input='中文 \"quotes\" $() & literal',out=await run("echo",{input});assert.equal(out.format,"ai-fleet-command-observation/v1");assert.equal(out.status,"success",JSON.stringify(out));assert.deepEqual(JSON.parse(out.stdout.text),{input,marker:null});assert.equal(out.stdout.sha256,hash(Buffer.from(out.stdout.text)));assert.equal(out.stderr.bytes,0);assert.equal(out.process.exit_code,0);assert.equal(out.process.containment,"windows-job");assert.equal(out.process.cleanup,"job_empty");assert.equal(Object.hasOwn(out,"real_model_call_confirmed"),false);
});
test("nonzero exit preserves bounded actual error evidence and cannot become success",async()=>{
 const out=await run("failed");assert.equal(out.status,"failed");assert.equal(out.diagnostic,"NONZERO_EXIT");assert.equal(out.process.exit_code,7);assert.equal(out.stderr.text,"测试失败\n");assert.equal(out.stderr.sha256,hash(Buffer.from(out.stderr.text)));assert.equal(out.process.cleanup,"job_empty");
});
test("invalid UTF8 and oversized stdout or stderr never produce a successful command receipt",async()=>{
 const invalid=await run("invalid");assert.equal(invalid.status,"failed");assert.equal(invalid.diagnostic,"OUTPUT_ENCODING");assert.equal(invalid.stdout.utf8_valid,false);
 for(const mode of ["noise","stderr"]){const out=await run(mode,{stdoutLimit:1024,stderrLimit:1024});assert.equal(out.status,"failed");assert.equal(out.diagnostic,"OUTPUT_LIMIT");const stream=mode==="noise"?out.stdout:out.stderr;assert.equal(stream.retained_bytes,1024);assert.ok(stream.bytes>1024);assert.equal(stream.truncated,true);assert.equal(out.process.cleanup,"job_empty");}
});
test("timeout and explicit cancellation terminate ordinary command descendants",async()=>{
 const timeout=await run("hang",{timeoutMs:250});assert.equal(timeout.status,"timeout");assert.equal(timeout.process.cleanup,"job_empty");
 const controller=new AbortController(),running=run("tree",{signal:controller.signal});let pid;for(let i=0;i<100;i++){if(existsSync(file)){pid=Number(readFileSync(file,"utf8"));break;}await delay(20);}assert.ok(pid);controller.abort();const out=await running;assert.equal(out.status,"cancelled");assert.equal(out.process.cleanup,"job_empty");for(let i=0;i<100&&alive(pid);i++)await delay(20);assert.equal(alive(pid),false);
});
test("changed command support files and invalid bounds fail before launching; pre-abort starts nothing",async()=>{
 const copy=join(TMP,"changed.mjs");writeFileSync(copy,"console.log('before')");const old=pinFile(copy);writeFileSync(copy,"console.log('after')");await assert.rejects(run("echo",{pins:[old]}),{code:"PIN_CHANGED"});await assert.rejects(run("echo",{stdoutLimit:0}),{code:"BAD_LIMITS"});const controller=new AbortController();controller.abort();const out=await run("echo",{signal:controller.signal});assert.equal(out.status,"cancelled");assert.equal(out.process.started,false);assert.equal(out.process.cleanup,"not_started");
});
test("provider supervision cannot be switched to ordinary command output by an option",async()=>{
 const out=await superviseProcess({python,command,args:[script,"other"],cwd:TMP,env,input:"",pins:[pin],runtime:"claude",commandOutput:true,timeoutMs:5000});assert.notEqual(out.status,"success");assert.equal(Object.hasOwn(out,"stdout"),false);
});
test("empty output records a zero exit without inventing test or provider evidence",async()=>{
 const out=await run("silent");assert.equal(out.status,"success");assert.equal(out.stdout.text,"");assert.equal(out.stdout.bytes,0);assert.equal(out.stdout.sha256,hash(Buffer.alloc(0)));assert.equal(out.stderr.bytes,0);assert.equal(Object.hasOwn(out,"accepted"),false);
});
test("bounded decoder snapshots are idempotent and never retain beyond their byte limit",()=>{
 const d=createCommandOutput({stdoutLimit:3,stderrLimit:3});assert.equal(d.push(Buffer.from("abcdef")),false);const out=d.finish({exitCode:0});assert.equal(out.stdout.text,"abc");assert.equal(out.stdout.bytes,6);assert.equal(out.stdout.sha256,hash(Buffer.from("abcdef")));assert.equal(out.status,"failed");assert.deepEqual(d.finish({exitCode:0}),out);assert.throws(()=>d.push(Buffer.from("later")),{code:"OUTPUT_CLOSED"});
});
