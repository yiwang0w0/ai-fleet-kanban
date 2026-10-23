import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join,resolve,relative,isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";

const ROOT=fileURLToPath(new URL("../",import.meta.url));
const traceKeys=["run_id","released_at","claimed_at","launch_requested_at","process_started_at","last_activity_at","ended_at","process_state","work_state"];
const privateKeys=new Set(["launch_json","observation_json","source_json","policy_json","journal_key","command","args","env","input","credentialFile","credential_file","authHome","auth_home"]);
function noPrivateFields(value){
 if(!value||typeof value!=="object")return;
 for(const [key,item] of Object.entries(value)){assert.equal(privateKeys.has(key),false,`接口不能暴露启动私密字段 ${key}`);noPrivateFields(item);}
}

test("真实 HTTP 的列表与详情共用执行投影，领取不冒充开工且认证边界不变",{timeout:40000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kanban-execution-http-")),config=join(directory,"fixture.json");
 // 服务端不接受空 lines；仅声明夹具执行线，绝不调用启动入口。
 writeFileSync(config,JSON.stringify({lines:[{id:"fixture",label:"专项夹具"}],roles:[],routes:["default"],repo:directory}));
 const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("BOARD_")));
 const child=spawn(process.execPath,[join(ROOT,"core/server.mjs")],{cwd:directory,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...environment,
  BOARD_HOST:"127.0.0.1",BOARD_PORT:String(port),BOARD_CONFIG:config,BOARD_DATA_DIR:directory,BOARD_DB:join(directory,"board.db"),BOARD_REPO:directory,
  BOARD_NODE_NAME:"执行投影专项",BOARD_ALLOW_UNPINNED:"1",BOARD_NO_RESTORE:"1",BOARD_SPAWN_ECHO:"1",BOARD_RESTART_MODE:"exit",BOARD_TEST_SHUTDOWN_MS:"30000"}});
 let logs="";const append=value=>{logs=(logs+String(value)).slice(-32768);};child.stdout.on("data",append);child.stderr.on("data",append);child.on("error",append);
 const closed=new Promise(r=>child.once("close",r)),base=`http://127.0.0.1:${port}`;
 const api=async(method,path,token=null,body=undefined,extraHeaders={})=>{
  const response=await fetch(base+path,{method,headers:{...(token?{"X-Board-Token":token}:{}),...(body===undefined?{}:{"Content-Type":"application/json"}),...extraHeaders},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
 };
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await api("GET","/health")).status===200){ready=true;break;}}catch{}if(child.exitCode!==null||child.signalCode!==null)break;await delay(100);}
  assert.ok(ready,logs);
  const operator=readFileSync(join(directory,"board_token"),"utf8").trim(),worker=readFileSync(join(directory,"worker_token"),"utf8").trim();
  const stopped=async()=>{
   const workers=await api("GET","/api/workers",operator);assert.equal(workers.status,200);assert.ok(workers.body.workers.length>0);
   for(const item of workers.body.workers){assert.equal(item.running,false);assert.equal(item.desired_running,false);assert.equal(item.pid,null);}
  };
  await stopped();
  const created=await api("POST","/api/tasks",operator,{subject:"原生领取投影夹具",line:"fixture"});assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.task.id,path=`/api/tasks/${id}`;
  const checkReads=async()=>{
   const listing=await api("GET","/api/tasks",operator),detail=await api("GET",path,operator);assert.equal(listing.status,200);assert.equal(detail.status,200);
   const card=listing.body.tasks.find(task=>task.id===id);assert.ok(card);assert.deepEqual(card.execution_trace,detail.body.task.execution_trace);assert.deepEqual(Object.keys(card.execution_trace),traceKeys);
   for(const body of [listing.body,detail.body]){noPrivateFields(body);const json=JSON.stringify(body);for(const secret of [operator,worker,directory])assert.equal(json.includes(secret),false);}
   return detail.body.task;
  };
  const before=await checkReads();assert.equal(before.execution_trace.run_id,null);assert.equal(before.execution_trace.claimed_at,null);assert.equal(before.execution_trace.process_state,"unverified");
  for(const readPath of ["/api/tasks",path]){
   assert.equal((await api("GET",readPath)).status,401);assert.equal((await api("GET",readPath,"invalid")).status,401);
   assert.equal((await api("GET",readPath,operator,undefined,{Origin:"https://foreign.invalid"})).status,403);
   assert.equal((await api("GET",readPath,worker)).status,200,"原生 worker 的已授权读能力不扩大也不收窄");
  }
  assert.equal((await api("GET","/api/auth",worker)).status,403);
  assert.equal((await api("GET","/api/fleet",worker)).status,403);
  assert.equal((await api("POST","/api/tasks",worker,{subject:"不得由 worker 创建的根任务"})).status,403);
  const claimed=await api("POST","/api/claim",worker,{worker:"fixture-agent",line:"fixture",worker_protocol_version:2,agent_instance_id:randomUUID()});
  assert.equal(claimed.status,200,JSON.stringify(claimed.body));assert.equal(claimed.body.task.id,id);
  const current=await checkReads(),trace=current.execution_trace;assert.equal(trace.run_id,claimed.body.task.run_id);assert.ok(Number.isFinite(Date.parse(trace.claimed_at)));
  const events=await api("GET",`/api/task-events?task_id=${id}`,operator);assert.equal(events.status,200);
  assert.equal(trace.claimed_at,events.body.events.find(item=>item.kind==="claim"&&item.detail.run_id===trace.run_id).at);
  assert.equal(trace.released_at,before.execution_trace.released_at);assert.equal(trace.launch_requested_at,null);assert.equal(trace.process_started_at,null);assert.equal(trace.last_activity_at,null);assert.equal(trace.process_state,"unverified");assert.equal(trace.work_state,"unverified");
  await stopped();assert.equal((await api("GET","/api/tasks",operator)).body.tasks.length,1,"被拒绝的 worker 根任务没有落盘");
 }finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;
  const target=resolve(directory),inside=relative(resolve(tmpdir()),target);assert.ok(inside&&!inside.startsWith("..")&&!isAbsolute(inside));rmSync(target,{recursive:true,force:true});
 }
});
