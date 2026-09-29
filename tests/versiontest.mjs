import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import vm from "node:vm";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-version-"));
const handles=[];
after(()=>{for(const db of handles)db.close();rmSync(TMP,{recursive:true,force:true});});
function fixture(path=":memory:"){
 const db=new DatabaseSync(path);db.exec("PRAGMA busy_timeout=5000");handles.push(db);store.migrate(db);
 const id=store.add(db,{subject:"version fixture"});return {db,id};
}
test("versions start at one, survive migration and ignore heartbeat/time-only writes",()=>{
 const {db,id}=fixture();assert.equal(store.get(db,id).aggregate_version,1);store.migrate(db);
 assert.equal(store.get(db,id).aggregate_version,1);
 const t=store.claimById(db,{id,worker:"v"}).task;assert.ok(t.aggregate_version>1);
 store.heartbeat(db,{id,worker:"v",runId:t.run_id});
 assert.equal(store.get(db,id).aggregate_version,t.aggregate_version);
 db.prepare("UPDATE tasks SET updated_at='display clock only' WHERE id=?").run(id);
 assert.equal(store.get(db,id).aggregate_version,t.aggregate_version);
 store.bumpAttempt(db,{id,worker:"v",runId:t.run_id});assert.ok(store.get(db,id).aggregate_version>t.aggregate_version);
});
test("same values do not advance a version; content and evidence changes do",()=>{
 const {db,id}=fixture(),a=store.get(db,id);
 store.update(db,{id,subject:a.subject,expectedVersion:a.aggregate_version});
 assert.equal(store.get(db,id).aggregate_version,a.aggregate_version);
 store.update(db,{id,acceptance:"new criterion",expectedVersion:a.aggregate_version});
 const b=store.get(db,id);assert.ok(b.aggregate_version>a.aggregate_version);
 const t=store.claimById(db,{id,worker:"v",expectedVersion:b.aggregate_version}).task;
 store.report(db,{id,worker:"v",runId:t.run_id,outcome:"done",evidence:"proof"});
 assert.ok(store.get(db,id).aggregate_version>t.aggregate_version);
});
for(const op of ["update","resolve","setReleased","setPinned","reopen","archive","claimById","markAutoReviewed"]){
 test(op+" rejects stale versions before mutating task or history",()=>{
  const {db,id}=fixture();
  store.update(db,{id,description:"changed",expectedVersion:1});
  const before=store.get(db,id),events=store.events(db,{taskId:id});
  assert.throws(()=>store[op](db,{id,expectedVersion:1,subject:"old",worker:"v",verdict:"approve",released:false,pinned:true}),{code:"CONFLICT"});
  assert.deepEqual(store.get(db,id),before);assert.deepEqual(store.events(db,{taskId:id}),events);
 });
}
test("invalid expected versions and forged aggregate versions refuse",()=>{
 const {db,id}=fixture();
 for(const expectedVersion of [null,0,-1,1.5,"1",true,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>store.update(db,{id,description:"bad",expectedVersion}),{code:"BAD_INPUT"});
 for(const key of ["aggregate_version","aggregateVersion"]){
  assert.throws(()=>store.add(db,{subject:"bad",[key]:1}),{code:"BAD_INPUT"});
  assert.throws(()=>store.update(db,{id,[key]:2}),{code:"BAD_INPUT"});
 }
 assert.equal(store.get(db,id).aggregate_version,1);
});
test("a rejected version never executes resolution preparation side effects",()=>{
 const {db,id}=fixture();let sideEffects=0;
 const t=store.claimById(db,{id,worker:"v"}).task;
 store.report(db,{id,worker:"v",runId:t.run_id,outcome:"done",evidence:"proof"});
 assert.throws(()=>store.resolve(db,{id,verdict:"approve",expectedVersion:t.aggregate_version,
  prepareResolution:()=>{sideEffects++;return {};}}),{code:"CONFLICT"});
 assert.equal(sideEffects,0);assert.equal(store.get(db,id).status,"waiting");
 const current=store.get(db,id);
 store.resolve(db,{id,verdict:"approve",expectedVersion:current.aggregate_version,
  prepareResolution:()=>{sideEffects++;return {};}});
 assert.equal(sideEffects,1);assert.equal(store.get(db,id).status,"done");
});
test("version and business mutation roll back together when event writing fails",()=>{
 const {db,id}=fixture(),before=store.get(db,id);
 db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>store.setReleased(db,{id,released:false,expectedVersion:before.aggregate_version}),/injected/);
 assert.deepEqual(store.get(db,id),before);
});
test("two independent processes editing the same observed version have one winner",async()=>{
 const path=join(TMP,"concurrent.db"),{db,id}=fixture(path),worker=join(TMP,"writer.cjs");
 // Production databases already use WAL. This test races commands, not journal-mode conversion.
 db.exec("PRAGMA journal_mode=WAL");
 writeFileSync(worker,[
  "const store=require(process.argv[2]);const db=store.open();",
  "const id=Number(process.argv[3]),version=store.get(db,id).aggregate_version;",
  "process.on('message',()=>{try{store.update(db,{id,description:process.argv[4],expectedVersion:version});console.log('ok');}",
  "catch(e){console.log(e.code);}finally{db.close();process.disconnect();}});",
  "process.send({version});"
 ].join("\n"));
 const children=[];
 const launch=name=>{
  const p=spawn(process.execPath,[worker,join(ROOT,"core/store.js"),String(id),name],
   {env:{...process.env,BOARD_DB:path,BOARD_DATA_DIR:TMP},windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
  let out="",stderr="",readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const done=new Promise((resolve,reject)=>{
   p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>stderr+=b);
   p.on("message",readyResolve);p.on("error",e=>{readyReject(e);reject(e);});
   p.on("close",code=>{const e=Error("child exit "+code+"\n"+stderr);
    readyReject(e);code?reject(e):resolve(out.trim());});
  });
  // Attach the outcome handler immediately, including while waiting for readiness.
  const outcome=done.then(value=>({value}),error=>({error}));
  const child={p,ready,outcome};children.push(child);return child;
 };
 let timeout;
 try{
  const writers=[launch("first"),launch("second")];
  const snapshots=await Promise.race([Promise.all(writers.map(c=>c.ready)),
   new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("writer readiness timed out")),10000);})]);
  assert.deepEqual(snapshots.map(x=>x.version),[1,1]);
  for(const c of writers)c.p.send("write");
  const outcomes=await Promise.all(writers.map(c=>c.outcome));
  for(const o of outcomes)if(o.error)throw o.error;
  assert.deepEqual(outcomes.map(o=>o.value).sort(),["CONFLICT","ok"]);
  assert.equal(store.get(db,id).aggregate_version,2);
 }finally{
  clearTimeout(timeout);for(const c of children)if(c.p.exitCode===null)c.p.kill();
  await Promise.all(children.map(c=>c.outcome));
 }
});

test("panel sends original draft/edit version and never retries a 409 with a newer one",async()=>{
 const source=readFileSync(join(ROOT,"core/panel.html"),"utf8");
 const a=source.indexOf("async function post(url, body){"),b=source.indexOf("// ⭐ v0.19",a);
 assert.ok(a>=0&&b>a);
 const sent=[],byId=new Map([[1,{aggregate_version:9}]]),draftVersions=new Map([[1,3]]);
 const context={WH:{},byId,draftVersions,fetch:async(url,opts)=>{
  sent.push(JSON.parse(opts.body));return {ok:false,status:409,json:async()=>({error:"changed",current_version:9})};
 }};
 vm.createContext(context);vm.runInContext(source.slice(a,b),context);
 await assert.rejects(context.post("/api/tasks/1/resolve",{verdict:"approve"}),/changed/);
 assert.equal(sent.length,1);assert.equal(sent[0].expected_version,3);assert.equal(draftVersions.get(1),3);
 await assert.rejects(context.post("/api/tasks/1/update",{line:"alpha",expected_version:4}),/changed/);
 assert.equal(sent[1].expected_version,4);
});
test("reopening a decision does not relabel an old draft with the current version",()=>{
 const source=readFileSync(join(ROOT,"core/panel.html"),"utf8");
 const a=source.indexOf("function openDecisionModal(t){"),b=source.indexOf('document.addEventListener("dblclick"',a);
 const box={innerHTML:"",querySelector:()=>null},draftVersions=new Map([[1,3]]);
 const context={draftVersions,decisionSnapshot:null,structuredClone,document:{getElementById:()=>box},
  decisionPanel:()=>"",verdictDraft:new Map(),receiptDraft:new Map(),syncHandoff(){},
  decisionModal:{querySelector:()=>null,classList:{add(){}}}};
 vm.createContext(context);vm.runInContext(source.slice(a,b),context);
 context.openDecisionModal({id:1,aggregate_version:9,subject:"new"});
 assert.equal(draftVersions.get(1),3);assert.match(box.innerHTML,/role="alert"/);
});
test("line picker shows failed writes and refreshes without retry",async()=>{
 const source=readFileSync(join(ROOT,"core/panel.html"),"utf8");
 const a=source.indexOf('  const as = e.target.closest("button[data-assign]");'),b=source.indexOf("\n  const cx",a);
 assert.ok(a>=0&&b>a);const notices=[];let calls=0,refreshed=0;
 const context={e:{target:{closest:()=>({dataset:{assign:"1",line:"alpha"}})}},pick:{dataset:{version:"2"},classList:{remove(){}}},
  post:async(url,body)=>{calls++;assert.equal(body.expected_version,2);throw Error("version conflict");},
  refresh:async()=>{refreshed++;},alert:text=>notices.push(text)};
 vm.createContext(context);await vm.runInContext("(async()=>{"+source.slice(a,b)+"})()",context);
 assert.equal(calls,1);assert.equal(refreshed,1);assert.match(notices[0],/version conflict/);
});
test("HTTP requires versions, rejects stale controls and returns current version",async()=>{
 const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const config=join(TMP,"fleet.config.json");writeFileSync(config,JSON.stringify({lines:[{id:"alpha"}]}));
 const p=spawn(process.execPath,[join(ROOT,"core/server.mjs")],{
  env:{...process.env,BOARD_PORT:String(port),BOARD_DATA_DIR:TMP,BOARD_DB:join(TMP,"http.db"),BOARD_CONFIG:config,BOARD_ALLOW_UNPINNED:"1"},
  windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let out="";p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>out+=b);
 const base="http://127.0.0.1:"+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+"/health")).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,out);const token=readFileSync(join(TMP,"board_token"),"utf8").trim();
  // Synchronous CLI probes can outlive the server idle timeout while this
  // client event loop is blocked. Do not reuse that idle socket for writes.
  async function api(method,path,body){
   const r=await fetch(base+path,{method,headers:{"Connection":"close","Content-Type":"application/json","X-Board-Token":token},body:method==="GET"?undefined:JSON.stringify(body||{})});
   return {status:r.status,body:await r.json()};
  }
  const made=await api("POST","/api/tasks",{subject:"HTTP version",line:"alpha"}),id=made.body.task.id;
  assert.equal(made.body.task.aggregate_version,1);
  const path="/api/tasks/"+id;
  for(const action of ["claim","resolve","autoreview","update","pin","release","reopen","archive"])
   assert.equal((await api("POST",path+"/"+action,{})).status,400,action+" missing version");
  const newer=await api("POST",path+"/update",{expected_version:1,description:"new"});assert.equal(newer.status,200);
  for(const action of ["claim","resolve","autoreview","update","pin","release","reopen","archive"]){
   const r=await api("POST",path+"/"+action,{expected_version:1,worker:"v",verdict:"approve",subject:"obsolete"});
   assert.equal(r.status,409,action+" "+JSON.stringify(r));assert.equal(r.body.current_version,2);
  }
  assert.equal((await api("GET",path)).body.task.description,"new");
  const payload=join(TMP,"cli-edit.json");writeFileSync(payload,JSON.stringify({acceptance:"CLI verified"}));
  const cli=(...args)=>spawnSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",
   [join(ROOT,"cli/board.py"),"edit",String(id),"--file",payload,...args],
   {env:{...process.env,BOARD_URL:base,BOARD_DATA_DIR:TMP,PYTHONUTF8:"1"},windowsHide:true,encoding:"utf8"});
  const missing=cli();assert.equal(missing.status,1,missing.stderr);assert.match(missing.stderr,/--version/);
  const stale=cli("--version","1");assert.equal(stale.status,1,stale.stderr);assert.match(stale.stderr,/409/);
  assert.equal((await api("GET",path)).body.task.aggregate_version,2);
  const fresh=cli("--version","2");assert.equal(fresh.status,0,fresh.stderr);
  const cliTask=(await api("GET",path)).body.task;
  assert.equal(cliTask.aggregate_version,3);assert.equal(cliTask.acceptance,"CLI verified");
  const claim=await api("POST",path+"/claim",{worker:"v",expected_version:3});assert.equal(claim.status,200);
  const report=await api("POST",path+"/report",{worker:"v",run_id:claim.body.task.run_id,outcome:"done",evidence:"proof"});
  assert.equal(report.status,200);
  const waiting=(await api("GET",path)).body.task;
  assert.equal((await api("POST",path+"/resolve",{verdict:"approve",expected_version:waiting.aggregate_version})).status,200);
 }finally{if(p.exitCode===null){p.kill();await new Promise(r=>p.once("exit",r));}}
});
