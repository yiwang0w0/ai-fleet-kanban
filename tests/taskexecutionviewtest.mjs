import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {canonical,digest} from "../core/federation/sync-store.mjs";
import {taskExecutionView} from "../core/task-execution-view.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const temporary=mkdtempSync(join(tmpdir(),"kanban-execution-view-")),handles=[];let serial=0;
after(()=>{for(const db of handles)db.close();rmSync(temporary,{recursive:true,force:true});});
function fixture({released=1}={}){
 const db=new DatabaseSync(join(temporary,`board-${serial++}.db`));handles.push(db);store.migrate(db);
 const id=store.add(db,{subject:"执行展示专项",released});
 return {db,id,get:()=>store.get(db,id),view:()=>taskExecutionView(db,store.get(db,id))};
}
const event=(f,kind,detail,time="2030-01-01T00:00:00.000Z",actor="fixture")=>f.db.prepare("INSERT INTO task_events(at,task_id,kind,actor,detail) VALUES(?,?,?,?,?)").run(time,f.id,kind,actor,JSON.stringify(detail));
const release=(f,value)=>store.setReleased(f.db,{id:f.id,released:value,expectedVersion:f.get().aggregate_version});
function claim(f){
 const result=store.claimById(f.db,{id:f.id,worker:"执行器甲",runtime:"claude",agentInstanceId:randomUUID()});
 assert.equal(result.ok,true,JSON.stringify(result));return result.task;
}
// 本专项只放置既有表的最小回执夹具；不启动监管器、CLI、服务或真实模型。
function broker(f,{observation=true}={}){
 const t=f.get(),run=store.runs(f.db,f.id).find(r=>r.run_id===t.run_id),dispatchId=randomUUID(),principalId=randomUUID();
 f.db.exec("CREATE TABLE broker_dispatches(dispatch_id TEXT PRIMARY KEY,task_id INTEGER,task_uid TEXT,node_id TEXT,run_id TEXT,worker TEXT,agent_instance_id TEXT,principal_id TEXT,launch_at TEXT,result_json TEXT,result_digest TEXT); CREATE TABLE broker_execution_records(dispatch_id TEXT PRIMARY KEY,launch_json TEXT,launch_digest TEXT,observation_json TEXT,observation_digest TEXT)");
 const launch={format:"ai-fleet-process/v1",adapter_contract:"fixture/v1",adapter_digest:"1".repeat(64),runtime:"claude",model:"fixture-model",effort:"high",run_id:t.run_id,agent_instance_id:run.agent_instance_id,principal_id:principalId,command_sha256:"2".repeat(64),python_sha256:"3".repeat(64),files_digest:"4".repeat(64),prompt_sha256:"5".repeat(64),environment_sha256:"6".repeat(64),timeout_ms:5000,heartbeat_ms:100,stderr_limit:1024,idle_timeout_ms:5000};
 const activity={format:"ai-fleet-output-activity/v1",idle_basis:"decoded_output_events",started_at:"2026-10-21T01:00:00.000Z",last_output_at:"2026-10-21T01:00:01.000Z",last_event_at:"2026-10-21T01:00:01.000Z",stdout_bytes:100,stderr_bytes:0,events:2,elapsed_ms:1000,idle_ms:0,idle_timeout_ms:5000,idle_timeout_observed_ms:null};
 const observed={status:"success",evidence:"仅夹具协议输出",usage:null,diagnostic:"SUCCESS",observed:{runtime:"claude",session_id:"fixture-session",turn_id:null,model:"fixture-model",terminal_status:"success",protocol_error:null,bytes:100,events:2,stdout_sha256:"7".repeat(64)},real_model_call_confirmed:false,process:{started:true,pid:123,containment:"windows-job",cleanup:"job_empty",host_sha256:"8".repeat(64),executable_sha256:launch.command_sha256,python_sha256:launch.python_sha256,exit_code:0,host_error:null,host_exit_code:0,stderr_bytes:0,stderr_hashed_bytes:0,stderr_sha256:"9".repeat(64),activity}};
 const save=(value=observed)=>{
  const result={status:value.status,evidence:value.evidence,usage:value.usage};
  f.db.prepare("UPDATE broker_execution_records SET launch_json=?,launch_digest=?,observation_json=?,observation_digest=? WHERE dispatch_id=?").run(canonical(launch),digest(launch),canonical(value),digest(value),dispatchId);
  f.db.prepare("UPDATE broker_dispatches SET result_json=?,result_digest=? WHERE dispatch_id=?").run(canonical({...result,accepted:false,real_model_call_confirmed:false}),digest(result),dispatchId);
 };
 f.db.prepare("INSERT INTO broker_dispatches VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(dispatchId,f.id,t.task_uid,t.owner_node_id,t.run_id,run.worker,run.agent_instance_id,principalId,"2026-10-21T00:59:59.000Z",null,null);
 f.db.prepare("INSERT INTO broker_execution_records VALUES(?,?,?,?,?)").run(dispatchId,canonical(launch),digest(launch),null,null);
 if(observation)save();
 return {dispatchId,launch,observed,save};
}

test("放行时间只来自真实创建或 false 到 true，忽略快照、重复放行和退回",()=>{
 const f=fixture({released:0});assert.equal(f.view().released_at,null);
 event(f,"snapshot",{released:true});assert.equal(f.view().released_at,null);
 release(f,true);const genuine=store.events(f.db,{taskId:f.id}).find(e=>e.kind==="release"&&e.detail.from===false).at;
 event(f,"release",{action:"release",from:true,to:true});event(f,"release",{action:"release_held",released:true});
 assert.equal(f.view().released_at,genuine);
 const g=fixture();assert.equal(g.view().released_at,store.events(g.db,{taskId:g.id})[0].at);
});

test("旧 worker 的领取、心跳与工作区间都不能成为可信开工",()=>{
 const f=fixture(),t=claim(f),claimed=store.events(f.db,{taskId:f.id}).find(e=>e.kind==="claim");
 store.heartbeat(f.db,{id:f.id,worker:t.worker,runId:t.run_id});
 const v=f.view();assert.equal(v.run_id,t.run_id);assert.equal(v.claimed_at,claimed.at);
 assert.equal(v.process_state,"unverified");assert.equal(v.work_state,"unverified");assert.equal(v.process_started_at,null);assert.equal(v.last_activity_at,null);assert.equal(v.launch_requested_at,null);
 assert.ok(f.get().work_spans.length);assert.deepEqual(Object.keys(v),["run_id","released_at","claimed_at","launch_requested_at","process_started_at","last_activity_at","ended_at","process_state","work_state"]);
});

test("重新领取只绑定本轮运行，不继承旧运行时间或旧 broker 观察",()=>{
 const f=fixture(),first=claim(f);broker(f);store.releaseHeldBy(f.db,first.worker);const next=claim(f);
 const at="2026-10-21T02:00:00.000Z";event(f,"claim",{run_id:first.run_id,status:"in_progress"},"2030-01-01T00:00:00.000Z",first.worker);event(f,"claim",{run_id:next.run_id,status:"in_progress"},at,next.worker);
 const v=f.view();assert.equal(v.run_id,next.run_id);assert.equal(v.claimed_at,at);assert.equal(v.process_state,"unverified");assert.equal(v.process_started_at,null);
 const other=fixture();claim(other);assert.equal(taskExecutionView(f.db,{...f.get(),run_id:other.get().run_id}).run_id,null);
});

test("迁移导入运行不补造领取或开工，结束仍只读原运行记录",()=>{
 const f=fixture();f.db.prepare("UPDATE tasks SET status='in_progress',worker='旧执行器' WHERE id=?").run(f.id);store.migrate(f.db);
 const imported=store.runs(f.db,f.id)[0];assert.equal(imported.imported,1);
 event(f,"claim",{run_id:imported.run_id,status:"in_progress"},"2030-01-01T00:00:00.000Z","旧执行器");
 const v=f.view();assert.equal(v.run_id,imported.run_id);assert.equal(v.claimed_at,null);assert.equal(v.process_started_at,null);
 store.releaseHeldBy(f.db,"旧执行器");assert.equal(f.view().ended_at,store.runs(f.db,f.id)[0].ended_at);
});

test("Broker 消费启动许可但无观察时仍待核实",()=>{
 const f=fixture();claim(f);broker(f,{observation:false});
 const v=f.view();assert.equal(v.launch_requested_at,"2026-10-21T00:59:59.000Z");assert.equal(v.process_state,"unverified");assert.equal(v.process_started_at,null);assert.equal(v.work_state,"unverified");
});

test("摘要和身份匹配的最终回执仅展示进程与有效协议活动",()=>{
 const f=fixture();claim(f);const b=broker(f),before=f.db.prepare("SELECT total_changes() AS n").get().n,events=store.events(f.db,{taskId:f.id});
 const v=f.view();assert.equal(v.process_state,"observed");assert.equal(v.process_started_at,b.observed.process.activity.started_at);assert.equal(v.work_state,"activity_observed");assert.equal(v.last_activity_at,b.observed.process.activity.last_event_at);
 assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n,before);assert.deepEqual(store.events(f.db,{taskId:f.id}),events);assert.equal(JSON.stringify(v).includes("仅夹具协议输出"),false);assert.equal(b.observed.real_model_call_confirmed,false);
});

test("坏摘要、坏 JSON、错误运行或进程合同都降级为待核实",()=>{
 for(const mode of ["digest","json","run","contract","result","model"]){
  const f=fixture();claim(f);const b=broker(f);
  if(mode==="digest")f.db.exec("UPDATE broker_execution_records SET observation_digest='bad'");
  if(mode==="json")f.db.exec("UPDATE broker_execution_records SET observation_json='not-json'");
  if(mode==="run"){b.launch.run_id=randomUUID();b.save();}
  if(mode==="contract"){b.observed.process.executable_sha256="0".repeat(64);b.save();}
  if(mode==="result")f.db.exec("UPDATE broker_dispatches SET result_digest='bad'");
  if(mode==="model"){b.observed.observed.model="other-model";b.save();}
  const v=f.view();assert.equal(v.process_state,"unverified",mode);assert.equal(v.work_state,"unverified",mode);assert.equal(v.process_started_at,null,mode);
 }
});

test("已知未启动与不确定结果不同，原始 stderr 不构成工作活动",()=>{
 const f=fixture();claim(f);const b=broker(f);
 const notStarted={status:"failed",evidence:"启动失败夹具",usage:null,diagnostic:"SPAWN_FAILED",observed:{...b.observed.observed,model:null,terminal_status:null,events:0,bytes:0},real_model_call_confirmed:false,process:{started:false,cleanup:"not_started",containment:null}};
 b.save(notStarted);assert.equal(f.view().process_state,"not_started");assert.equal(f.view().work_state,"unverified");
 b.observed.process.activity.events=0;b.observed.process.activity.last_event_at=null;b.observed.observed.events=0;b.save();
 assert.equal(f.view().process_state,"observed");assert.equal(f.view().last_activity_at,null);assert.equal(f.view().work_state,"unverified");
});

test("缺少可选表正常降级，SQLite 非兼容或关闭错误不被吞掉",()=>{
 const f=fixture();claim(f);assert.equal(f.view().process_state,"unverified");
 f.db.exec("CREATE TABLE broker_dispatches(unrelated TEXT)");assert.throws(()=>f.view(),/no such column/);
 const db=new DatabaseSync(":memory:");assert.deepEqual(taskExecutionView(db,{id:1,run_id:null}),{run_id:null,released_at:null,claimed_at:null,launch_requested_at:null,process_started_at:null,last_activity_at:null,ended_at:null,process_state:"unverified",work_state:"unverified"});db.close();
 assert.throws(()=>taskExecutionView(db,{id:1}),/not open|closed/i);
});
