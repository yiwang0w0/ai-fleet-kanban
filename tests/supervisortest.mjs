import {createHash} from "node:crypto";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawn,execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {pinFile,superviseProcess} from "../core/execution/supervisor.mjs";
const TMP=mkdtempSync(join(tmpdir(),"fleet process 中文 "));
const pythonPath=execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys; print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim();
const python=pinFile(pythonPath),command=pinFile(process.execPath),env=Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp","path","home"].includes(k.toLowerCase())));
const script=join(TMP,"fixture worker.mjs");
writeFileSync(script,[
 'import {spawn} from "node:child_process";',
 'import {writeFileSync} from "node:fs";',
 'const mode=process.argv[2],file=process.argv[3];',
 'const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");',
 'let input="";for await(const b of process.stdin)input+=b.toString("utf8");',
 'if(mode==="hang"||mode==="tree"||mode==="background"){',
 ' if(mode!=="hang"){const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(file,String(c.pid));if(mode==="background")c.unref();}',
 ' if(mode!=="background")setInterval(()=>{},1000);',
 '}else if(mode==="noise"){setInterval(()=>process.stdout.write("x".repeat(65536)),1);',
 '}else if(mode==="stderr"){process.stderr.write("s".repeat(65536));setInterval(()=>{},1000);',
 '}else if(mode==="bad"){process.stdout.write("invalid fixture-private output\\n");setInterval(()=>{},1000);',
 '}else if(mode==="exit"){process.exit(7);}',
 'if(["success","background","nonzero","secret","echo"].includes(mode)){',
 ' emit({type:"system",subtype:"init",session_id:"fixture-session",model:"fixture-model"});',
 ' emit({type:"result",subtype:"success",is_error:false,session_id:"fixture-session",result:mode==="secret"?String(process.env.FLEET_TEST_PRIVATE??"absent"):mode==="echo"?input:"中文 fixture",usage:{input_tokens:0,output_tokens:0}});',
 ' if(mode==="nonzero")process.exitCode=3;',
 '}'
].join("\n"));
const defaults={python,command,args:[script,"success"],cwd:TMP,env,input:"fixture",pins:[pinFile(script)],runtime:"claude",timeoutMs:5000};
after(()=>rmSync(TMP,{recursive:true,force:true}));
const run=extra=>superviseProcess({...defaults,...extra});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFile(file){
 for(let i=0;i<100;i++){if(existsSync(file))return Number(readFileSync(file,"utf8"));await delay(20);}
 throw Error("fixture child did not start");
}
function alive(pid){try{process.kill(pid,0);if(process.platform==="linux"&&readFileSync("/proc/"+pid+"/stat","utf8").split(") ")[1]?.startsWith("Z"))return false;return true;}catch{return false;}}
async function stopped(pid){for(let i=0;i<100;i++){if(!alive(pid))return true;await delay(20);}return false;}

test("supervisor runs a pinned native command and validates provider output",async()=>{
 const out=await run();assert.equal(out.status,"success",JSON.stringify(out));assert.equal(out.evidence,"中文 fixture");
 assert.equal(out.process.started,true);assert.equal(out.process.cleanup,process.platform==="win32"?"job_empty":"group_signalled");
 assert.equal(out.real_model_call_confirmed,false);
});
test("stdin retains Unicode and quoting; explicit environment excludes unrelated secrets",async()=>{
 const input='中文 "quotes" \n $(not a shell) & literal';
 assert.equal((await run({args:[script,"echo"],input})).evidence,input);
 process.env.FLEET_TEST_PRIVATE="fixture-private";
 try{assert.equal((await run({args:[script,"secret"]})).evidence,"absent");}finally{delete process.env.FLEET_TEST_PRIVATE;}
});
test("pin mismatch is refused before a process starts",async()=>{
 await assert.rejects(run({command:{...command,sha256:"0".repeat(64)}}),{code:"PIN_CHANGED"});
 await assert.rejects(run({pins:[{...pinFile(script),sha256:"0".repeat(64)}]}),{code:"PIN_CHANGED"});
});
test("a success terminal with nonzero exit remains failed",async()=>{
 const out=await run({args:[script,"nonzero"]});assert.equal(out.status,"failed");assert.equal(out.process.exit_code,3);
});
test("missing terminal, malformed provider output and stderr flood remain failed",async()=>{
 for(const mode of ["exit","bad","stderr"]){
  const out=await run({args:[script,mode],stderrLimit:1024});assert.equal(out.status,"failed");assert.equal(out.process.cleanup,process.platform==="win32"?"job_empty":"group_signalled");
  assert.ok(!JSON.stringify(out).includes("fixture-private"));if(mode==="bad")assert.equal(out.diagnostic,"INVALID_OUTPUT");
 }
});
test("stdout flood is bounded and terminates the process",async()=>{
 const out=await run({args:[script,"noise"],decoder:{limits:{line:1024}}});
 assert.equal(out.status,"failed");assert.equal(out.observed.bytes<=32*1024*1024,true);
});
test("timeout kills the running fixture",async()=>{
 const out=await run({args:[script,"hang"],timeoutMs:300});
 assert.equal(out.status,"timeout");assert.equal(await stopped(out.process.pid),true);
});
test("cancellation kills the root and its ordinary descendant",async()=>{
 const file=join(TMP,"cancel-child.pid"),controller=new AbortController();
 const pending=run({args:[script,"tree",file],signal:controller.signal}),pid=await waitFile(file);
 controller.abort();const out=await pending;
 assert.equal(out.status,"cancelled");assert.equal(await stopped(pid),true);assert.equal(await stopped(out.process.pid),true);
});
test("ordinary descendants are cleaned after a successful root exits",async()=>{
 const file=join(TMP,"background-child.pid");
 const out=await run({args:[script,"background",file]}),pid=await waitFile(file);
 assert.equal(out.status,"success");assert.equal(await stopped(pid),true);
});
test("local heartbeats run during execution and heartbeat failure stops it",async()=>{
 let beats=0;const out=await run({args:[script,"hang"],heartbeatMs:50,heartbeat:()=>++beats<3});
 assert.equal(beats,3);assert.equal(out.status,"failed");assert.equal(out.diagnostic,"HEARTBEAT_FAILED");assert.equal(await stopped(out.process.pid),true);
});
test("already cancelled work does not start a provider process",async()=>{
 const controller=new AbortController();controller.abort();
 const out=await run({signal:controller.signal});assert.equal(out.process.started,false);assert.equal(out.status,"cancelled");
});
test("host stdin disconnect cleans up its process group or job",async()=>{
 const hostPath=fileURLToPath(new URL("../core/execution/process_host.py",import.meta.url));
 const child=spawn(python.path,["-I","-S","-B",hostPath],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
 const closed=new Promise(r=>child.once("close",r));let data="";
 child.stdout.on("data",b=>{data+=b.toString();});child.stderr.resume();
 child.stdin.write(JSON.stringify({command:command.path,args:[script,"hang"],cwd:TMP,env,input:"",pins:[command,pinFile(script)],timeout_ms:3000})+"\n");
 let pid=null;
 for(let i=0;i<100&&!pid;i++){
  for(const line of data.split("\n").filter(Boolean)){try{const event=JSON.parse(line);if(event.kind==="started")pid=event.pid;}catch{}}
  if(!pid)await delay(20);
 }
 assert.ok(pid);child.stdin.end();await closed;assert.equal(await stopped(pid),true);
});

test("Windows closes the job and terminates descendants when the host itself crashes",{skip:process.platform!=="win32"},async()=>{
 const hostPath=fileURLToPath(new URL("../core/execution/process_host.py",import.meta.url)),file=join(TMP,"host-crash-child.pid");
 const child=spawn(python.path,["-I","-S","-B",hostPath],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
 const closed=new Promise(r=>child.once("close",r));child.stdout.resume();child.stderr.resume();
 child.stdin.write(JSON.stringify({command:command.path,args:[script,"tree",file],cwd:TMP,env,input:"",pins:[command,pinFile(script)],timeout_ms:3000})+"\n");
 const pid=await waitFile(file);child.kill();await closed;assert.equal(await stopped(pid),true);
});
test("the process host rechecks command pins independently before native creation",async()=>{
 const hostPath=fileURLToPath(new URL("../core/execution/process_host.py",import.meta.url));
 const child=spawn(python.path,["-I","-S","-B",hostPath],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let out="";child.stdout.on("data",b=>out+=b);child.stderr.resume();const closed=new Promise(r=>child.once("close",r));
 child.stdin.end(JSON.stringify({command:command.path,args:[script,"success"],cwd:TMP,env,input:"",pins:[{...command,sha256:"0".repeat(64)}],timeout_ms:3000})+"\n");
 await closed;assert.equal(out.includes('"kind":"started"'),false);assert.equal(JSON.parse(out).kind,"host_error");
});

// Real Windows jobs with synthetic Zcode streams; no provider is invoked.
const zcodeScript=join(TMP,"zcode stream fixture.mjs");
writeFileSync(zcodeScript,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
let input='';for await(const b of process.stdin)input+=b.toString('utf8');
if(process.argv[2]==='hang'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[3],String(child.pid));setInterval(()=>{},1000);}
process.stdout.write(input);`);
const zPrompt="本次合成任务",zProvider="account:bigmodel-individual-coding-plan",zModel="GLM-5.3";
const zDecoder={zcodeTransport:"headless-stream",expectedProvider:zProvider,expectedModel:zModel,expectedPromptSha256:createHash("sha256").update(zPrompt).digest("hex")};
const zEvent=(type,seq,payload)=>({type,seq,eventId:"event-"+seq,sessionId:"session",turnId:"turn",traceId:"trace",timestamp:seq,payload});
const zEvents=[zEvent("turn.started",1,{input:zPrompt}),zEvent("session.updated",2,{providerId:zProvider,modelId:zModel,messageCount:1,toolCount:0,iteration:0}),zEvent("turn.completed",3,{resultType:"success",response:"合成任务完成"}),{type:"result",sessionId:"session",turnId:"turn",traceId:"trace",response:"合成任务完成",eventCount:3,projection:{status:"completed",turnCount:1,totalTokenCount:0}}];
const zRun=(events,extra={})=>run({runtime:"zcode",decoder:zDecoder,args:[zcodeScript],pins:[pinFile(zcodeScript)],input:events.map(e=>JSON.stringify(e)).join("\n")+"\n",...extra});

test("Windows supervisor accepts a complete Zcode headless fixture without certifying a model call",{skip:process.platform!=="win32"},async()=>{
 const out=await zRun(zEvents);assert.equal(out.status,"success",JSON.stringify(out));assert.equal(out.evidence,"合成任务完成");assert.equal(out.process.cleanup,"job_empty");assert.equal(out.observed.model,zModel);assert.equal(out.usage,null);assert.equal(out.real_model_call_confirmed,false);
});

test("Windows Zcode stream identity failure stops its root and child and never echoes the prompt",{skip:process.platform!=="win32"},async()=>{
 const file=join(TMP,"zcode-wrong-prompt-child.pid");
 const out=await zRun([{...zEvents[0],payload:{input:"private-wrong-task"}},...zEvents.slice(1)],{args:[zcodeScript,"hang",file]});
 assert.equal(out.status,"failed");assert.equal(out.observed.protocol_error,"INPUT_MISMATCH");assert.equal(out.process.cleanup,"job_empty");assert.equal(await stopped(await waitFile(file)),true);assert.ok(!JSON.stringify(out).includes("private-wrong-task"));
});

test("Windows Zcode fixture with terminal but missing summary is not settled as successful",{skip:process.platform!=="win32"},async()=>{
 const out=await zRun(zEvents.slice(0,3));assert.equal(out.status,"failed");assert.equal(out.diagnostic,"MISSING_SUMMARY");assert.equal(out.process.exit_code,0);assert.equal(out.process.cleanup,"job_empty");
});
