import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync,spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {migratePeers} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,issuePrincipal,revokePrincipal,authenticatePrincipal} from "../core/mcp/policy.mjs";
import {callTool} from "../core/mcp/tools.mjs";
import {pinFile,superviseProcess} from "../core/execution/supervisor.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateDispatch,putQuota,quotaStatus,prepareDispatch,authorizeLaunch,finishDispatch,abandonPrepared,dispatchStatus} from "../core/execution/dispatch.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-dispatch-")),dbs=[],children=[];let seq=0;
after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const done=new Promise(r=>c.once("close",r));c.kill();await done;}for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
const path=name=>join(TMP,name+"-"+seq++);
const git=(dir,args)=>execFileSync("git",["-C",dir,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
function source(){
 const dir=path("source");mkdirSync(dir);writeFileSync(join(dir,"code.txt"),"governance fixture\n");
 git(dir,["init","--quiet"]);git(dir,["config","core.autocrlf","false"]);git(dir,["add","code.txt"]);git(dir,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","fixture"]);
 const approvalFile=path("accepted");writeFileSync(approvalFile,git(dir,["rev-parse","HEAD:"]));
 return {codeRoot:dir,approvalFile,gate:createSourceGate({codeRoot:dir,approvalFile})};
}
const SOURCE=source();
function policy(id,kind,extra={}){
 return {role_id:id,kind,projects:["demo"],capabilities:kind==="implement"?["code"]:[],runtime:kind==="implement"?"claude":null,model:kind==="implement"?"fixture-model":null,effort:kind==="implement"?"fixture-effort":null,tools:"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300},...extra};
}
function fixture({limit=5,sourceInfo=SOURCE}={}){
 const dbPath=path("board")+".db",db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);migrateDispatch(db);
 putRole(db,policy("coord","coordinate"));putRole(db,policy("engine","implement"));
 const file=path("coordinator")+".json",p=issuePrincipal(db,{roleId:"coord",projects:["demo"],credentialFile:file});
 const coord={...p,auth:"Bearer "+JSON.parse(readFileSync(file,"utf8")).token};
 const quota=putQuota(db,{quota_id:randomUUID(),runtime:"claude",execution_mode:"fixture",projects:["demo"],limit_total:limit,enabled:true});
 return {db,dbPath,coord,quota,source:sourceInfo};
}
const count=(f,name)=>f.db.prepare("SELECT count(*) n FROM "+name).get().n;
function card(f,{kind="task",parent=null,release=true}={}){
 const args={request_id:randomUUID(),project_id:"demo",subject:randomUUID(),description:"fixture task",acceptance:"observed receipt",work_kind:"implement",required_capabilities:["code"]};
 const created=parent?callTool(f.db,f.coord.auth,"split_task",{...args,parent_uid:parent.task_uid,expected_version:parent.aggregate_version}):callTool(f.db,f.coord.auth,"create_task",{...args,kind});
 if(release)store.setReleased(f.db,{id:created.task.id,expectedVersion:created.task.aggregate_version,released:true});
 return store.get(f.db,created.task.id);
}
function assign(f,t){const current=store.get(f.db,t.id);return callTool(f.db,f.coord.auth,"request_assignment",{request_id:randomUUID(),task_uid:current.task_uid,expected_version:current.aggregate_version});}
function prepare(f,a,extra={}){
 const credentialFile=path("worker")+".json";
 const receipt=prepareDispatch(f.db,{assignmentId:a.assignment_id,quotaId:f.quota.quota_id,executionMode:"fixture",credentialFile,sourceGate:f.source.gate,...extra});
 return {receipt,credentialFile,auth:"Bearer "+JSON.parse(readFileSync(credentialFile,"utf8")).token};
}
const launch=(f,w)=>authorizeLaunch(f.db,{dispatchId:w.receipt.dispatch_id,sourceGate:f.source.gate});
const finish=(f,w,result={status:"success",evidence:"fixture output",usage:null})=>finishDispatch(f.db,{dispatchId:w.receipt.dispatch_id,result});

test("preparation binds the native claim, role snapshot and limited MCP credential in one commit",()=>{
 const f=fixture(),t=card(f),a=assign(f,t),w=prepare(f,a);
 assert.throws(()=>authenticatePrincipal(f.db,w.auth),{code:"LAUNCH_NOT_AVAILABLE"});
 const principal=f.db.prepare("SELECT * FROM broker_principals WHERE principal_id=?").get(w.receipt.principal_id);
 const p={...principal,role:{role_id:principal.role_id}};
 assert.equal(w.receipt.phase,"prepared");assert.equal(w.receipt.launch_permit,false);assert.equal(w.receipt.real_model_call_confirmed,false);
 assert.equal(p.run_id,w.receipt.run_id);assert.equal(p.agent_instance_id,w.receipt.agent_instance_id);assert.equal(p.role.role_id,"engine");
 assert.equal(store.get(f.db,t.id).status,"in_progress");assert.equal(store.get(f.db,t.id).attempts,1);
 assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);assert.equal(quotaStatus(f.db,f.quota.quota_id).reserved,1);
 assert.throws(()=>callTool(f.db,w.auth,"get_task",{task_uid:t.task_uid}),{code:"LAUNCH_NOT_AVAILABLE"});
 launch(f,w);
 assert.equal(callTool(f.db,w.auth,"get_task",{task_uid:t.task_uid}).task.run_id,w.receipt.run_id);
 assert.equal(f.db.prepare("SELECT state FROM broker_assignments WHERE assignment_id=?").get(a.assignment_id).state,"claimed");
});
test("native human, dependency, ancestor, child and lock gates still refuse before spending budget",()=>{
 for(const reason of ["human","dependency","ancestor","children","lock"]){
  const f=fixture();let t;
  if(reason==="ancestor"){const parent=card(f,{kind:"goal",release:false});t=card(f,{parent});}
  else t=card(f);
  if(reason==="human")f.db.prepare("UPDATE tasks SET human_gate=1 WHERE id=?").run(t.id);
  if(reason==="dependency"){const dep=card(f);f.db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run(JSON.stringify([dep.id]),t.id);}
  if(reason==="children")card(f,{parent:store.get(f.db,t.id)});
  if(reason==="lock"){const other=card(f);f.db.prepare("UPDATE tasks SET lock_key='shared' WHERE id IN(?,?)").run(t.id,other.id);assert.equal(store.claimById(f.db,{id:other.id,worker:"other"}).ok,true);}
  const a=assign(f,t);assert.throws(()=>prepare(f,a),{code:"CONFLICT"},reason);
  assert.equal(store.get(f.db,t.id).attempts,0,reason);assert.equal(count(f,"broker_dispatches"),0);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);
 }
});
test("stale task, changed role or revoked coordinator cannot be converted into a run",()=>{
 for(const mode of ["task","role","coordinator"]){
  const f=fixture(),t=card(f),a=assign(f,t);
  if(mode==="task")f.db.prepare("UPDATE tasks SET description='changed' WHERE id=?").run(t.id);
  if(mode==="role")putRole(f.db,policy("engine","implement",{model:"changed-model"}),1);
  if(mode==="coordinator")revokePrincipal(f.db,{principalId:f.coord.principal_id,expectedVersion:1});
  assert.throws(()=>prepare(f,a));assert.equal(count(f,"task_runs"),0);assert.equal(count(f,"broker_dispatches"),0);
 }
});
test("source gate refuses unapproved, dirty and stale loaded trees without an environment escape",()=>{
 const s=source();assert.ok(s.gate.check().tree);
 writeFileSync(s.approvalFile,"0".repeat(40));assert.throws(()=>s.gate.check(),{code:"SOURCE_UNAPPROVED"});
 writeFileSync(s.approvalFile,git(s.codeRoot,["rev-parse","HEAD:"]));writeFileSync(join(s.codeRoot,"untracked.txt"),"changed");
 assert.throws(()=>s.gate.check(),{code:"SOURCE_DIRTY"});
 git(s.codeRoot,["add","."]);git(s.codeRoot,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--quiet","-m","changed"]);
 writeFileSync(s.approvalFile,git(s.codeRoot,["rev-parse","HEAD:"]));assert.throws(()=>s.gate.check(),{code:"SOURCE_STALE"});
 const f=fixture({sourceInfo:s}),t=card(f);assert.throws(()=>prepare(f,assign(f,t)),{code:"SOURCE_STALE"});assert.equal(count(f,"task_runs"),0);
});
test("reserved quota blocks another task; abandonment releases the reservation without refunding any launch",()=>{
 const f=fixture({limit:1}),a=assign(f,card(f)),b=assign(f,card(f)),w=prepare(f,a);
 assert.throws(()=>prepare(f,b),{code:"BUDGET_EXHAUSTED"});
 const ended=abandonPrepared(f.db,{dispatchId:w.receipt.dispatch_id,reason:"fixture not launched"});
 assert.equal(ended.phase,"abandoned");assert.equal(quotaStatus(f.db,f.quota.quota_id).reserved,0);
 assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);assert.throws(()=>authenticatePrincipal(f.db,w.auth),{code:"UNAUTHENTICATED"});
 const next=prepare(f,b);launch(f,next);assert.throws(()=>abandonPrepared(f.db,{dispatchId:next.receipt.dispatch_id,reason:"must not refund"}),{code:"CONFLICT"});
 assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
});
test("post-credential failure rolls back claim, run, assignment, budget and new credential file",()=>{
 const f=fixture(),t=card(f),a=assign(f,t),file=path("rollback")+".json",before=JSON.stringify(store.get(f.db,t.id)),events=count(f,"task_events");
 f.db.exec("CREATE TRIGGER fail_prepare_event BEFORE INSERT ON broker_dispatch_events BEGIN SELECT RAISE(ABORT,'injected prepare failure'); END");
 assert.throws(()=>prepare(f,a,{credentialFile:file}),/injected prepare failure/);
 assert.equal(existsSync(file),false);assert.equal(JSON.stringify(store.get(f.db,t.id)),before);assert.equal(count(f,"task_runs"),0);
 assert.equal(count(f,"task_events"),events);assert.equal(count(f,"broker_principals"),1);assert.equal(count(f,"broker_dispatches"),0);
 assert.equal(f.db.prepare("SELECT state FROM broker_assignments").get().state,"waiting_executor");
});
test("existing credential and governance-repository credential paths are refused without overwriting",()=>{
 const f=fixture(),t=card(f),a=assign(f,t),file=path("exists")+".json";writeFileSync(file,"do not overwrite");
 assert.throws(()=>prepare(f,a,{credentialFile:file}));assert.equal(readFileSync(file,"utf8"),"do not overwrite");
 assert.throws(()=>prepare(f,a,{credentialFile:join(SOURCE.codeRoot,"secret.json")}),{code:"UNSAFE_CREDENTIAL_PATH"});
 assert.equal(count(f,"task_runs"),0);assert.equal(existsSync(join(SOURCE.codeRoot,"secret.json")),false);
});
test("a launch permit is single-use across database reconnects and consumes exactly one durable call",()=>{
 const f=fixture({limit:1}),w=prepare(f,assign(f,card(f))),p=launch(f,w);
 assert.equal(p.launch_permit,true);assert.equal(p.phase,"launch_committed");assert.equal(p.real_model_call_confirmed,false);
 const db=new DatabaseSync(f.dbPath);dbs.push(db);
 assert.throws(()=>authorizeLaunch(db,{dispatchId:w.receipt.dispatch_id,sourceGate:f.source.gate}),{code:"LAUNCH_NOT_AVAILABLE"});
 assert.equal(quotaStatus(db,f.quota.quota_id).used,1);assert.equal(quotaStatus(db,f.quota.quota_id).reserved,0);
});
test("changed role, coordinator, budget or expired lease blocks a prepared launch",()=>{
 for(const mode of ["role","coordinator","quota","lease"]){
  const f=fixture(),w=prepare(f,assign(f,card(f)));
  if(mode==="role")putRole(f.db,policy("engine","implement",{enabled:false}),1);
  if(mode==="coordinator")revokePrincipal(f.db,{principalId:f.coord.principal_id,expectedVersion:1});
  if(mode==="quota")putQuota(f.db,{quota_id:f.quota.quota_id,runtime:"claude",execution_mode:"fixture",projects:["demo"],limit_total:5,enabled:false},1);
  if(mode==="lease")f.db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(w.receipt.task_id);
  assert.throws(()=>launch(f,w));assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0,mode);
 }
});
test("parent context and child changes after preparation are checked before launch",()=>{
 for(const mode of ["parent","child"]){
  const f=fixture(),parent=card(f,{kind:"goal"}),t=card(f,{parent}),w=prepare(f,assign(f,t));
  if(mode==="parent")f.db.prepare("UPDATE tasks SET description='new parent instruction' WHERE id=?").run(parent.id);
  else card(f,{parent:store.get(f.db,t.id)});
  assert.throws(()=>launch(f,w));assert.equal(quotaStatus(f.db,f.quota.quota_id).used,0);
 }
});
test("success waits for acceptance, records unknown usage as null and replays the same outcome only",()=>{
 const f=fixture(),w=prepare(f,assign(f,card(f)));launch(f,w);const r=finish(f,w);
 assert.equal(r.phase,"settled");assert.equal(r.result.accepted,false);assert.equal(r.result.usage,null);assert.equal(r.result.delivery,"reported");
 const t=store.get(f.db,w.receipt.task_id);assert.equal(t.waiting_for,"review");assert.match(t.result,/fixture; no real model call/);
 assert.deepEqual(finish(f,w),r);assert.throws(()=>finish(f,w,{status:"success",evidence:"different",usage:null}),{code:"RESULT_CONFLICT"});
 assert.equal(store.events(f.db,{taskId:t.id}).filter(x=>x.kind==="report").length,1);
});
test("outcome receipt failure rolls back task report and can be retried without another launch",()=>{
 const f=fixture(),w=prepare(f,assign(f,card(f)));launch(f,w);const before=JSON.stringify(store.get(f.db,w.receipt.task_id));
 f.db.exec("CREATE TRIGGER fail_settle BEFORE INSERT ON broker_dispatch_events WHEN NEW.kind='settled' BEGIN SELECT RAISE(ABORT,'injected settle'); END");
 assert.throws(()=>finish(f,w),/injected settle/);
 assert.equal(JSON.stringify(store.get(f.db,w.receipt.task_id)),before);assert.equal(dispatchStatus(f.db,w.receipt.dispatch_id).phase,"launch_committed");
 f.db.exec("DROP TRIGGER fail_settle");assert.equal(finish(f,w).phase,"settled");assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
});
test("late results remain historical and cannot overwrite a replacement run",()=>{
 const f=fixture(),w=prepare(f,assign(f,card(f)));launch(f,w);
 f.db.prepare("UPDATE tasks SET status='not_started',waiting_for=NULL,description='fresh operator input' WHERE id=?").run(w.receipt.task_id);
 const replacement=store.claimById(f.db,{id:w.receipt.task_id,worker:"replacement"});assert.equal(replacement.ok,true);
 const before=JSON.stringify(store.get(f.db,w.receipt.task_id)),r=finish(f,w);
 assert.equal(r.result.delivery,"stale_run_retained");assert.equal(JSON.stringify(store.get(f.db,w.receipt.task_id)),before);
});
test("an earlier MCP delivery is preserved when the process outcome arrives",()=>{
 const f=fixture(),w=prepare(f,assign(f,card(f)));launch(f,w);
 callTool(f.db,w.auth,"report_result",{request_id:randomUUID(),task_uid:w.receipt.task_uid,run_id:w.receipt.run_id,outcome:"wait",evidence:"needs operator input"});
 const r=finish(f,w);assert.equal(r.result.delivery,"existing_mcp_report_preserved");
 const t=store.get(f.db,w.receipt.task_id);assert.equal(t.result,"needs operator input");assert.equal(t.waiting_for,"decision");
});
test("transaction ownership and dispatch identities cannot be bypassed by an outer transaction",()=>{
 const f=fixture(),a=assign(f,card(f));
 f.db.exec("BEGIN IMMEDIATE");assert.throws(()=>prepare(f,a),{code:"TRANSACTION_CONTEXT"});f.db.exec("ROLLBACK");
 const w=prepare(f,a);f.db.exec("BEGIN IMMEDIATE");assert.throws(()=>launch(f,w),{code:"TRANSACTION_CONTEXT"});f.db.exec("ROLLBACK");
 assert.throws(()=>f.db.prepare("UPDATE broker_dispatches SET run_id=?").run(randomUUID()),/immutable/);
 assert.throws(()=>f.db.prepare("UPDATE broker_assignments SET role_id='forged'").run(),/immutable/);
 assert.throws(()=>f.db.prepare("DELETE FROM broker_dispatches").run(),/append-only/);
});
test("native nested claim rolls back its savepoint when the outer caller catches the error",()=>{
 const f=fixture(),t=card(f),before=JSON.stringify(store.get(f.db,t.id));
 f.db.exec("CREATE TRIGGER fail_claim_event BEFORE INSERT ON task_events WHEN NEW.kind='claim' BEGIN SELECT RAISE(ABORT,'nested claim failure'); END; BEGIN IMMEDIATE");
 assert.throws(()=>store.claimById(f.db,{id:t.id,worker:"fixture"}),/nested claim failure/);
 assert.equal(f.db.isTransaction,true);f.db.exec("COMMIT");assert.equal(JSON.stringify(store.get(f.db,t.id)),before);assert.equal(count(f,"task_runs"),0);
});
test("fixture budgets cannot authorize provider launches and stricter role attempts override legacy multiplier",()=>{
 const f=fixture(),t=card(f),a=assign(f,t);
 assert.throws(()=>prepare(f,a,{executionMode:"provider"}),{code:"FORBIDDEN"});
 f.db.prepare("UPDATE tasks SET attempts=2 WHERE id=?").run(t.id);
 const b=assign(f,t);assert.throws(()=>prepare(f,b),{code:"BUDGET_EXHAUSTED"});assert.equal(count(f,"broker_dispatches"),0);
});
test("two independent coordinators racing one assignment create one run and one reservation",async()=>{
 const f=fixture(),a=assign(f,card(f)),replies=[],pending=[];
 const script=[
  'const {DatabaseSync}=require("node:sqlite"),{pathToFileURL}=require("node:url");',
  '(async()=>{const {prepareDispatch}=await import(pathToFileURL(process.argv[1]));const {createSourceGate}=await import(pathToFileURL(process.argv[2]));const db=new DatabaseSync(process.argv[3]);db.exec("PRAGMA busy_timeout=5000");',
  'process.on("message",m=>{try{const sourceGate=createSourceGate(m.source),r=prepareDispatch(db,{...m.options,sourceGate});process.send({ok:true,run_id:r.run_id});}catch(e){process.send({ok:false,code:e.code});}finally{db.close();process.disconnect();}});process.send({ready:true});})();'
 ].join("\n");
 for(let i=0;i<2;i++){
  const cp=spawn(process.execPath,["-e",script,join(ROOT,"core/execution/dispatch.mjs"),join(ROOT,"core/execution/source-gate.mjs"),f.dbPath],{windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]});children.push(cp);
  let stderr="";cp.stderr.on("data",b=>stderr+=b);
  const ready=new Promise((resolve,reject)=>{cp.on("error",reject);cp.on("message",m=>{if(m.ready)resolve();else replies.push(m);});});
  const done=new Promise((resolve,reject)=>cp.once("close",c=>c===0?resolve():reject(Error(stderr))));done.catch(()=>{});pending.push({cp,ready,done});
 }
 let timer;
 try{
  await Promise.race([(async()=>{await Promise.all(pending.map(x=>x.ready));for(const p of pending)p.cp.send({source:{codeRoot:f.source.codeRoot,approvalFile:f.source.approvalFile},options:{assignmentId:a.assignment_id,quotaId:f.quota.quota_id,executionMode:"fixture",credentialFile:path("racing")+".json"}});await Promise.all(pending.map(x=>x.done));})(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("dispatch race timeout")),20000))]);
  assert.equal(replies.filter(x=>x.ok).length,1);assert.equal(replies.filter(x=>!x.ok&&x.code==="NOT_READY").length,1);
  assert.equal(count(f,"task_runs"),1);assert.equal(quotaStatus(f.db,f.quota.quota_id).reserved,1);
 }finally{clearTimeout(timer);for(const p of pending)if(p.cp.exitCode===null&&p.cp.signalCode===null)p.cp.kill();await Promise.allSettled(pending.map(x=>x.done));}
});

test("quota policy updates preserve consumed calls and cannot reduce below outstanding reservations",()=>{
 const f=fixture({limit:2}),w=prepare(f,assign(f,card(f)));
 const policy={quota_id:f.quota.quota_id,runtime:"claude",execution_mode:"fixture",projects:["demo"],limit_total:0,enabled:true};
 assert.throws(()=>putQuota(f.db,policy,1),{code:"BUDGET_RESERVED"});
 assert.throws(()=>putQuota(f.db,{...policy,limit_total:2},99),{code:"CONFLICT"});
 launch(f,w);finish(f,w,{status:"failed",evidence:"observed fixture failure",usage:null});
 const updated=putQuota(f.db,{...policy,limit_total:3},1);assert.equal(updated.used,1);assert.equal(updated.version,2);
 assert.throws(()=>putQuota(f.db,{...policy,runtime:"codex",limit_total:3},2),{code:"CONFLICT"});
});
test("failure, timeout and cancellation require a decision and never masquerade as accepted completion",()=>{
 for(const status of ["failed","timeout","cancelled"]){
  const f=fixture(),w=prepare(f,assign(f,card(f)));launch(f,w);
  const r=finish(f,w,{status,evidence:"observed "+status,usage:{input_tokens:3,output_tokens:0}});
  assert.equal(r.result.status,status);assert.equal(r.result.accepted,false);assert.equal(store.get(f.db,w.receipt.task_id).waiting_for,"decision");
  assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
 }
});
test("MCP synchronization status shows scoped dispatch phase without disclosing credential or source paths",()=>{
 const f=fixture(),w=prepare(f,assign(f,card(f))),out=callTool(f.db,f.coord.auth,"get_sync_status",{});
 assert.equal(out.dispatches.length,1);assert.equal(out.dispatches[0].phase,"prepared");
 const text=JSON.stringify(out);assert.ok(!text.includes(w.credentialFile));assert.ok(!text.includes(SOURCE.codeRoot));assert.ok(!text.includes(w.auth));
 putRole(f.db,policy("other","coordinate",{projects:["other"]}));const file=path("other")+".json";
 issuePrincipal(f.db,{roleId:"other",projects:["other"],credentialFile:file});
 const auth="Bearer "+JSON.parse(readFileSync(file,"utf8")).token;
 assert.deepEqual(callTool(f.db,auth,"get_sync_status",{}).dispatches,[]);
});
test("local administration CLI records quotas and observes or abandons a prepared dispatch",()=>{
 const f=fixture(),file=path("quota-policy")+".json",id=randomUUID();
 writeFileSync(file,JSON.stringify({quota_id:id,runtime:"zcode",execution_mode:"fixture",projects:["demo"],limit_total:1,enabled:true}));
 const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli/dispatch.mjs"),...args,"--db",f.dbPath],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}));
 assert.equal(cli("quota","--policy-file",file).limit_total,1);
 assert.equal(cli("quota-status","--quota",id).used,0);
 const w=prepare(f,assign(f,card(f)));
 assert.equal(cli("status","--dispatch",w.receipt.dispatch_id).phase,"prepared");
 assert.equal(cli("abandon","--dispatch",w.receipt.dispatch_id,"--reason","operator fixture cancellation").phase,"abandoned");
 assert.equal(quotaStatus(f.db,f.quota.quota_id).reserved,0);
});
import {listenBroker} from "../core/mcp/gateway.mjs";

test("a claimed identity can deliver through an independent MCP stdio process and preserve its receipt",async()=>{
 const f=fixture(),w=prepare(f,assign(f,card(f))),server=await listenBroker(f.db,{port:0});launch(f,w);
 const cp=spawn(process.execPath,[join(ROOT,"cli/mcp.mjs"),"--url","http://127.0.0.1:"+server.address().port,"--credential-file",w.credentialFile],{windowsHide:true,stdio:["pipe","pipe","pipe"]});children.push(cp);
 let stdout="",stderr="",timer;cp.stdout.on("data",b=>stdout+=b);cp.stderr.on("data",b=>stderr+=b);const done=new Promise(r=>cp.once("close",r));
 try{
  cp.stdin.end([
   {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"executor-fixture",version:"1"}}},
   {jsonrpc:"2.0",method:"notifications/initialized"},
   {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"report_result",arguments:{request_id:randomUUID(),task_uid:w.receipt.task_uid,run_id:w.receipt.run_id,outcome:"done",evidence:"independent MCP executor fixture"}}}
  ].map(x=>JSON.stringify(x)).join("\n")+"\n");
  const rc=await Promise.race([done,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("MCP executor timeout")),15000))]);assert.equal(rc,0,stderr);
  const replies=stdout.trim().split("\n").map(x=>JSON.parse(x));assert.equal(replies[1].result.isError,false);assert.equal(replies[1].result.structuredContent.accepted,false);
  const settled=finish(f,w);assert.equal(settled.result.delivery,"existing_mcp_report_preserved");
  assert.equal(store.get(f.db,w.receipt.task_id).result,"independent MCP executor fixture");
  assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);assert.equal(settled.real_model_call_confirmed,false);
 }finally{clearTimeout(timer);if(cp.exitCode===null&&cp.signalCode===null)cp.kill();await done;server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test("expired run cleanup releases only an unlaunched reservation and never reissues a spent launch",()=>{
 for(const started of [false,true]){
  const f=fixture({limit:1}),w=prepare(f,assign(f,card(f)));if(started)launch(f,w);
  f.db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(w.receipt.task_id);store.reapExpired(f.db);
  assert.equal(dispatchStatus(f.db,w.receipt.dispatch_id).phase,"interrupted");
  assert.equal(quotaStatus(f.db,f.quota.quota_id).reserved,0);assert.equal(quotaStatus(f.db,f.quota.quota_id).used,started?1:0);
  assert.throws(()=>launch(f,w),{code:"LAUNCH_NOT_AVAILABLE"});
 }
});

test("native root WIP limit cannot be bypassed by requesting a specific broker assignment",()=>{
 const f=fixture({limit:Math.max(5,store.WIP_PER_ROOT+1)}),root=card(f,{kind:"goal"});
 for(let i=0;i<store.WIP_PER_ROOT;i++)prepare(f,assign(f,card(f,{parent:root})));
 const waiting=card(f,{parent:root});assert.throws(()=>prepare(f,assign(f,waiting)),e=>e.code==="CONFLICT"&&e.message.includes("WIP"));
 assert.equal(store.get(f.db,waiting.id).attempts,0);
 assert.equal(quotaStatus(f.db,f.quota.quota_id).reserved,store.WIP_PER_ROOT);
});
test("the no-progress gate holds identical redispatch but a changed parent supplies new input",()=>{
 const f=fixture(),root=card(f,{kind:"goal"}),t=card(f,{parent:root}),w=prepare(f,assign(f,t));launch(f,w);finish(f,w);
 f.db.prepare("UPDATE tasks SET status='not_started',waiting_for=NULL WHERE id=?").run(t.id);
 const a=assign(f,t);assert.throws(()=>prepare(f,a),e=>e.code==="CONFLICT"&&e.message.includes("没有变化"));
 assert.equal(store.get(f.db,t.id).attempts,1);
 f.db.prepare("UPDATE tasks SET description='new parent instruction from operator' WHERE id=?").run(root.id);
 const next=prepare(f,a);assert.notEqual(next.receipt.run_id,w.receipt.run_id);assert.equal(store.get(f.db,t.id).attempts,2);
});

test("a committed dispatch permit feeds a supervised fixture and settles its observed terminal exactly once",async()=>{
 const pythonPath=execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c","import sys; print(sys.executable)"],{encoding:"utf8",windowsHide:true}).trim();
 const f=fixture({limit:1}),t=card(f),w=prepare(f,assign(f,t)),file=path("supervised-fixture")+".mjs";
 writeFileSync(file,'setTimeout(()=>{process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"supervised",model:"fixture-model"})+"\\n");process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"supervised",result:"observed fixture terminal"})+"\\n");},300);');
 const permit=launch(f,w);assert.equal(permit.launch_permit,true);let beats=0;
 const result=await superviseProcess({python:pinFile(pythonPath),command:pinFile(process.execPath),args:[file],cwd:TMP,
  env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),
  input:"fixture only",pins:[pinFile(file)],runtime:"claude",timeoutMs:5000,heartbeatMs:50,
  heartbeat:()=>{beats++;return store.heartbeat(f.db,{id:t.id,worker:w.receipt.worker,runId:w.receipt.run_id}).task.status==="in_progress";}});
 assert.equal(result.status,"success",JSON.stringify(result));assert.ok(beats>0);
 const receipt=finish(f,w,{status:result.status,evidence:result.evidence,usage:result.usage});
 assert.equal(receipt.phase,"settled");assert.equal(receipt.result.accepted,false);assert.equal(receipt.result.real_model_call_confirmed,false);
 assert.equal(store.get(f.db,t.id).waiting_for,"review");assert.equal(quotaStatus(f.db,f.quota.quota_id).used,1);
 assert.throws(()=>launch(f,w),{code:"LAUNCH_NOT_AVAILABLE"});
});
