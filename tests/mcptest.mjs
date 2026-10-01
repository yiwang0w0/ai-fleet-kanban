import {inspectAcl} from "./helpers/windows-acl.mjs";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import http from "node:http";
import {PassThrough} from "node:stream";
import {localIdentity,migratePeers} from "../core/federation/peers.mjs";
import {digest} from "../core/federation/sync-store.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,getRole,issuePrincipal,revokePrincipal,authenticatePrincipal} from "../core/mcp/policy.mjs";
import {callTool,listTools,enrollTask,TOOL_DEFINITIONS} from "../core/mcp/tools.mjs";
import {listenBroker} from "../core/mcp/gateway.mjs";
import {createBridge,serveStdio} from "../core/mcp/stdio.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-mcp-")),dbs=[],servers=[],children=[];let seq=0;
after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){const done=new Promise(r=>c.once("close",r));c.kill();await done;}for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
const path=name=>join(TMP,name+"-"+seq++);
function policy(role_id="coord",kind="coordinate",extra={}){
 const execution=["implement","review"].includes(kind);
 return {role_id,kind,projects:["demo"],capabilities:execution?["board-tools"]:[],runtime:execution?"claude":null,model:execution?"fixture-model":null,effort:execution?"fixture-effort":null,tools:kind==="review"||kind==="observe"?"read-only":"write",priority:10,enabled:true,limits:{max_task_attempts:2,max_open_tasks:100,requests_per_minute:300},...extra};
}
function fixture(){
 const dir=path("node");mkdirSync(dir);const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);
 putRole(db,policy());const f={dir,dbPath,db,node:localIdentity(db)};f.coord=grant(f,"coord");return f;
}
function grant(f,roleId,projects=["demo"],runId=null){
 const file=path("credential")+".json",principal=issuePrincipal(f.db,{roleId,projects,runId,credentialFile:file}),credential=JSON.parse(readFileSync(file,"utf8"));
 return {file,principal,credential,auth:"Bearer "+credential.token};
}
const createArgs=(extra={})=>({request_id:randomUUID(),project_id:"demo",subject:"test task",description:"",acceptance:"check fixture",work_kind:"implement",required_capabilities:["board-tools"],kind:"task",...extra});
const create=(f,extra={})=>callTool(f.db,f.coord.auth,"create_task",createArgs(extra)).task;
function worker(f,{kind="implement"}={}){
 const role=putRole(f.db,policy("engine",kind)),task=create(f,{work_kind:kind});
 f.db.prepare("UPDATE tasks SET released=1,line='engine' WHERE id=?").run(task.id);
 const id=randomUUID(),claimed=store.claimById(f.db,{id:task.id,worker:"engine",runtime:"claude",agentInstanceId:id,runContext:{role_id:"engine",broker_role_version:role.version,broker_role_digest:role.policy_digest}});
 assert.equal(claimed.ok,true,JSON.stringify(claimed));
 return {role,task:claimed.task,identity:grant(f,"engine",["demo"],claimed.task.run_id)};
}
async function network(f){
 const server=await listenBroker(f.db,{port:0});servers.push(server);
 return {server,url:"http://127.0.0.1:"+server.address().port};
}
const count=(f,table)=>f.db.prepare("SELECT count(*) n FROM "+table).get().n;

test("strict role policies are versioned and changing them invalidates existing principals",()=>{
 const f=fixture();
 assert.throws(()=>putRole(f.db,{...policy("bad"),command:"arbitrary shell"}),{code:"BAD_INPUT"});
 assert.throws(()=>putRole(f.db,policy("review","review",{tools:"write"})),{code:"BAD_INPUT"});
 assert.throws(()=>putRole(f.db,policy(),99),{code:"CONFLICT"});
 putRole(f.db,policy("coord","coordinate",{enabled:false}),1);
 assert.throws(()=>listTools(f.db,f.coord.auth),{code:"POLICY_CHANGED"});
 assert.equal(count(f,"tasks"),0);
});
test("credentials are scoped, exclusive, hashed and revocable without returning their token",()=>{
 const f=fixture(),before=readFileSync(f.coord.file,"utf8");
 assert.ok(!JSON.stringify(f.coord.principal).includes(f.coord.credential.token));
 assert.ok(!f.db.prepare("SELECT secret_hash FROM broker_principals").get().secret_hash.includes(f.coord.credential.token));
 assert.throws(()=>issuePrincipal(f.db,{roleId:"coord",projects:["other"],credentialFile:path("forbidden")+".json"}),{code:"FORBIDDEN"});
 assert.throws(()=>issuePrincipal(f.db,{roleId:"coord",projects:["demo"],credentialFile:f.coord.file}));
 assert.equal(readFileSync(f.coord.file,"utf8"),before);assert.equal(count(f,"broker_principals"),1);
 revokePrincipal(f.db,{principalId:f.coord.principal.principal_id,expectedVersion:1});
 assert.throws(()=>callTool(f.db,f.coord.auth,"list_nodes",{}),{code:"UNAUTHENTICATED"});
 assert.throws(()=>revokePrincipal(f.db,{principalId:f.coord.principal.principal_id,expectedVersion:1}),{code:"CONFLICT"});
});
test("coordinate tools create private unreleased cards and reject authority or command injection",()=>{
 const f=fixture(),t=create(f);
 assert.equal(t.released,false);assert.equal(t.owner_node_id,f.node.node_id);assert.equal(count(f,"federation_shares"),0);
 assert.equal(f.db.prepare("SELECT route FROM tasks WHERE id=?").get(t.id).route,"mcp");
 for(const forbidden of ["owner_node_id","worker","run_id","verify_cmd","released","evidencePath","force"])
  assert.throws(()=>callTool(f.db,f.coord.auth,"create_task",createArgs({[forbidden]:"forged"})),{code:"BAD_INPUT"});
 assert.throws(()=>callTool(f.db,f.coord.auth,"execute_shell",{command:"anything"}),{code:"UNKNOWN_TOOL"});
 assert.equal(count(f,"tasks"),1);
});
test("creation retries survive principal reconnect and never duplicate a task or accept changed content",()=>{
 const f=fixture(),args=createArgs(),first=callTool(f.db,f.coord.auth,"create_task",args);
 assert.deepEqual(callTool(f.db,f.coord.auth,"create_task",{...args}),first);
 const second=new DatabaseSync(f.dbPath);dbs.push(second);
 assert.deepEqual(callTool(second,f.coord.auth,"create_task",args),first);
 assert.equal(count(f,"tasks"),1);
 assert.throws(()=>callTool(second,f.coord.auth,"create_task",{...args,subject:"different"}),{code:"REQUEST_CONFLICT"});
});
test("task, event, project admission and replay receipt roll back together",()=>{
 const f=fixture(),args=createArgs();
 f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'injected receipt'); END");
 assert.throws(()=>callTool(f.db,f.coord.auth,"create_task",args),/injected receipt/);
 for(const table of ["tasks","task_events","broker_task_projects","broker_requests"])assert.equal(count(f,table),0,table);
 assert.equal(count(f,"broker_audit"),1);
 f.db.exec("DROP TRIGGER fail_receipt");assert.ok(callTool(f.db,f.coord.auth,"create_task",args).task.task_uid);
});
test("a nested store failure rolls back its savepoint even when the outer caller catches it",()=>{
 const f=fixture();
 f.db.exec("CREATE TRIGGER fail_task_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'nested failure'); END; BEGIN IMMEDIATE");
 assert.throws(()=>store.add(f.db,{subject:"must roll back"}),/nested failure/);
 assert.equal(f.db.isTransaction,true);f.db.exec("COMMIT");assert.equal(count(f,"tasks"),0);
});
test("project boundaries deny cross-project reads, splits and enrollment under an unrelated parent",()=>{
 const f=fixture(),a=create(f);
 putRole(f.db,policy("other","coordinate",{projects:["other"]}));const other=grant(f,"other",["other"]);
 assert.throws(()=>callTool(f.db,other.auth,"get_task",{task_uid:a.task_uid}),{code:"NOT_FOUND"});
 assert.throws(()=>callTool(f.db,other.auth,"create_task",createArgs()),{code:"FORBIDDEN"});
 const child=store.add(f.db,{subject:"unrelated",parentId:a.id});
 assert.throws(()=>enrollTask(f.db,{id:child,projectId:"other",workKind:"implement",capabilities:[],expectedVersion:1}),{code:"PROJECT_CONFLICT"});
 assert.equal(count(f,"broker_task_projects"),1);
});
test("deterministic routing requires all capabilities, uses explicit priority and never substitutes a runtime",()=>{
 const f=fixture(),t=create(f),request=()=>({request_id:randomUUID(),task_uid:t.task_uid,expected_version:t.aggregate_version});
 const waiting=callTool(f.db,f.coord.auth,"request_assignment",request());assert.equal(waiting.state,"waiting_policy");assert.equal(waiting.dispatch_started,false);
 putRole(f.db,policy("z","implement",{runtime:"zcode",priority:20}));
 putRole(f.db,policy("b","implement",{runtime:"codex",priority:10}));
 putRole(f.db,policy("a","implement",{runtime:"claude",priority:10}));
 const assigned=callTool(f.db,f.coord.auth,"request_assignment",request());
 assert.equal(assigned.role_id,"a");assert.equal(assigned.state,"waiting_release");
 const stored=f.db.prepare("SELECT * FROM broker_assignments WHERE assignment_id=?").get(assigned.assignment_id);
 assert.equal(JSON.parse(stored.policy_json).runtime,"claude");
 assert.equal(callTool(f.db,f.coord.auth,"request_assignment",request()).assignment_id,assigned.assignment_id);
 assert.equal(count(f,"task_runs"),0);
});
test("stale assignment requests cannot override an edited task and role changes leave prior plans auditable",()=>{
 const f=fixture();putRole(f.db,policy("engine","implement"));const t=create(f);
 const args={request_id:randomUUID(),task_uid:t.task_uid,expected_version:t.aggregate_version};
 const old=callTool(f.db,f.coord.auth,"request_assignment",args);
 putRole(f.db,policy("engine","implement",{enabled:false}),1);
 const missing=callTool(f.db,f.coord.auth,"request_assignment",{...args,request_id:randomUUID()});assert.equal(missing.state,"waiting_policy");
 assert.equal(f.db.prepare("SELECT state FROM broker_assignments WHERE assignment_id=?").get(old.assignment_id).state,"cancelled");
 f.db.prepare("UPDATE tasks SET description='changed' WHERE id=?").run(t.id);
 assert.throws(()=>callTool(f.db,f.coord.auth,"request_assignment",{...args,request_id:randomUUID()}),{code:"CONFLICT"});
});
test("workers report only their bound run, cannot self-accept, and replay a lost report receipt safely",()=>{
 const f=fixture(),w=worker(f),other=create(f);
 assert.throws(()=>callTool(f.db,w.identity.auth,"create_task",createArgs()),{code:"FORBIDDEN"});
 assert.throws(()=>callTool(f.db,w.identity.auth,"get_task",{task_uid:other.task_uid}),{code:"NOT_FOUND"});
 const args={request_id:randomUUID(),task_uid:w.task.task_uid,run_id:w.task.run_id,outcome:"done",evidence:"fixture result"};
 const result=callTool(f.db,w.identity.auth,"report_result",args);
 assert.equal(result.task.status,"waiting");assert.equal(result.task.waiting_for,"review");assert.equal(result.accepted,false);
 assert.deepEqual(callTool(f.db,w.identity.auth,"report_result",args),result);
 assert.equal(store.events(f.db,{taskId:w.task.id}).filter(x=>x.kind==="report").length,1);
 assert.throws(()=>callTool(f.db,w.identity.auth,"resolve",{task_uid:w.task.task_uid}),{code:"UNKNOWN_TOOL"});
});
test("old worker credentials cannot replay or overwrite a replacement run of the same worker",()=>{
 const f=fixture(),w=worker(f);
 const args={request_id:randomUUID(),task_uid:w.task.task_uid,run_id:w.task.run_id,outcome:"done",evidence:"old result"};
 callTool(f.db,w.identity.auth,"report_result",args);
 f.db.prepare("UPDATE tasks SET status='not_started',waiting_for=NULL,description='new operator input',released=1 WHERE id=?").run(w.task.id);
 const next=store.claimById(f.db,{id:w.task.id,worker:"engine",runtime:"claude",agentInstanceId:randomUUID(),runContext:{role_id:"engine",broker_role_version:w.role.version,broker_role_digest:w.role.policy_digest}});
 assert.equal(next.ok,true);assert.notEqual(next.task.run_id,w.task.run_id);
 assert.throws(()=>callTool(f.db,w.identity.auth,"report_result",args),{code:"RUN_EXPIRED"});
 assert.equal(store.get(f.db,w.task.id).run_id,next.task.run_id);
});
test("worker grants require the dispatcher policy snapshot and cannot attach an arbitrary claimed run",()=>{
 const f=fixture();putRole(f.db,policy("engine","implement"));const t=create(f);
 f.db.prepare("UPDATE tasks SET released=1 WHERE id=?").run(t.id);
 const run=store.claimById(f.db,{id:t.id,worker:"engine",runtime:"claude",agentInstanceId:randomUUID()}).task;
 assert.throws(()=>grant(f,"engine",["demo"],run.run_id),{code:"POLICY_CHANGED"});
 assert.equal(count(f,"broker_principals"),1);
});
test("role quotas and persistent call rates refuse excess work without starting an executor",()=>{
 const f=fixture();putRole(f.db,policy("small","coordinate",{limits:{max_task_attempts:1,max_open_tasks:1,requests_per_minute:3}}));const c=grant(f,"small");
 const task=callTool(f.db,c.auth,"create_task",createArgs()).task;assert.equal(task.max_attempts,1);
 assert.throws(()=>callTool(f.db,c.auth,"create_task",createArgs()),{code:"BUDGET_EXHAUSTED"});
 callTool(f.db,c.auth,"get_task",{task_uid:task.task_uid});
 assert.throws(()=>listTools(f.db,c.auth),{code:"RATE_LIMITED"});assert.equal(count(f,"tasks"),1);assert.equal(count(f,"task_runs"),0);
});
test("read tools omit private command, path and credential fields",()=>{
 const f=fixture(),t=create(f);
 f.db.prepare("UPDATE tasks SET verify_cmd='cmd /c secret',evidence_path='C:/private/evidence' WHERE id=?").run(t.id);
 const out=JSON.stringify(callTool(f.db,f.coord.auth,"get_task",{task_uid:t.task_uid}));
 assert.ok(!out.includes("cmd /c secret"));assert.ok(!out.includes("C:/private"));assert.ok(!out.includes(f.coord.credential.token));
 putRole(f.db,policy("watch","observe"));const read=grant(f,"watch");
 assert.ok(listTools(f.db,read.auth).tools.every(x=>x.annotations.readOnlyHint));
 assert.throws(()=>callTool(f.db,read.auth,"create_task",createArgs()),{code:"FORBIDDEN"});
});
test("HTTP gateway requires credentials, disallows browser origins and exposes no administration surface",async()=>{
 const f=fixture(),n=await network(f);
 let r=await fetch(n.url+"/local/v1/tools/list",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});assert.equal(r.status,401);
 r=await fetch(n.url+"/local/v1/tools/list",{method:"POST",headers:{Authorization:f.coord.auth,"Content-Type":"application/json",Origin:"http://localhost"},body:"{}"});assert.equal(r.status,403);
 r=await fetch(n.url+"/local/v1/admin/grant",{method:"POST",headers:{Authorization:f.coord.auth,"Content-Type":"application/json"},body:"{}"});assert.equal(r.status,404);
 await assert.rejects(listenBroker(f.db,{host:"0.0.0.0",port:0}),{code:"UNSAFE_BIND"});
});
test("a credential revoked while a request body is uploading cannot commit a task",async()=>{
 const f=fixture(),n=await network(f),body=JSON.stringify({name:"create_task",arguments:createArgs()});
 const ready=new Promise(r=>n.server.once("request",r));
 const response=new Promise((resolve,reject)=>{
  const req=http.request(n.url+"/local/v1/tools/call",{method:"POST",headers:{Authorization:f.coord.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{let text="";res.on("data",x=>text+=x);res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on("error",reject);
  req.write(body.slice(0,10));
  ready.then(()=>{revokePrincipal(f.db,{principalId:f.coord.principal.principal_id,expectedVersion:1});req.end(body.slice(10));}).catch(reject);
 });
 const r=await response;assert.equal(r.status,401);assert.equal(count(f,"tasks"),0);
});
test("MCP lifecycle, capabilities and error types are distinct from tool execution results",async()=>{
 const f=fixture(),n=await network(f),bridge=createBridge({url:n.url,credentialFile:f.coord.file});
 assert.equal((await bridge({jsonrpc:"2.0",id:1,method:"tools/list"})).error.code,-32002);
 const initialized=await bridge({jsonrpc:"2.0",id:2,method:"initialize",params:{protocolVersion:"unsupported",capabilities:{},clientInfo:{name:"fixture",version:"1"}}});
 assert.equal(initialized.result.protocolVersion,"2025-11-25");assert.deepEqual(Object.keys(initialized.result.capabilities),["tools"]);
 await bridge({jsonrpc:"2.0",method:"notifications/initialized"});
 assert.ok((await bridge({jsonrpc:"2.0",id:3,method:"tools/list",params:{_meta:{"fixture/progress":"ignored"}}})).result.tools.length);
 assert.equal((await bridge({jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"no_such_tool",arguments:{}}})).error.code,-32602);
 const invalid=await bridge({jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"create_task",arguments:{}}});
 assert.equal(invalid.result.isError,true);assert.equal(invalid.result.structuredContent.code,"BAD_INPUT");
 assert.equal(await bridge({jsonrpc:"2.0",method:"tools/call",params:{name:"create_task",arguments:createArgs()}}),null);
 assert.equal(count(f,"tasks"),0);
 assert.equal((await bridge({jsonrpc:"2.0",id:3,method:"tools/list"})).error.code,-32600);
});
test("stdio framing handles split Unicode, rejects malformed messages and keeps stdout JSON-only",async()=>{
 const f=fixture(),n=await network(f),input=new PassThrough(),output=new PassThrough();let out="";
 output.on("data",b=>out+=b.toString());const serving=serveStdio({url:n.url,credentialFile:f.coord.file},{input,output});
 const messages=[{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"测试",version:"1"}}},{jsonrpc:"2.0",method:"notifications/initialized"},{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create_task",arguments:createArgs({subject:"中文任务"})}}];
 const bytes=Buffer.from(messages.map(x=>JSON.stringify(x)).join("\n")+"\n{invalid}\n");
 for(let i=0;i<bytes.length;i+=7)input.write(bytes.subarray(i,i+7));input.end();await serving;
 const replies=out.trim().split("\n").map(x=>JSON.parse(x));assert.equal(replies.length,3);
 assert.equal(replies[0].result.protocolVersion,"2025-06-18");assert.equal(replies[1].result.structuredContent.task.subject,"中文任务");assert.equal(replies[2].error.code,-32700);
 assert.ok(!out.includes(f.coord.credential.token));
 const large=new PassThrough(),sink=new PassThrough();sink.resume();const refused=serveStdio({url:n.url,credentialFile:f.coord.file},{input:large,output:sink});large.end(Buffer.alloc(128*1024+1,65));await assert.rejects(refused,/128KiB/);
});
test("an independent MCP stdio process creates and reads a scoped task through the live local broker",async()=>{
 const f=fixture(),n=await network(f);
 const child=spawn(process.execPath,[join(ROOT,"cli/mcp.mjs"),"--url",n.url,"--credential-file",f.coord.file],{windowsHide:true,stdio:["pipe","pipe","pipe"]});children.push(child);
 let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
 const done=new Promise(r=>child.once("close",r));
 child.stdin.end([
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"fixture",version:"1"}}},
  {jsonrpc:"2.0",method:"notifications/initialized"},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create_task",arguments:createArgs()}}
 ].map(x=>JSON.stringify(x)).join("\n")+"\n");
 let timer;try{const exit=await Promise.race([done,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("stdio timeout")),15000))]);assert.equal(exit,0,stderr);}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();await done;}
 const replies=stdout.trim().split("\n").map(x=>JSON.parse(x));assert.equal(replies.length,2);assert.equal(replies[1].result.isError,false);
 assert.equal(count(f,"tasks"),1);assert.ok(!stdout.includes(f.coord.credential.token));assert.ok(!stderr.includes(f.coord.credential.token));
});
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";

test("coordinator and bound worker split only their current parent without depth uplift",()=>{
 const f=fixture(),root=create(f,{kind:"goal"});
 const args=parent=>{const {kind,...a}=createArgs();return {...a,parent_uid:parent.task_uid,expected_version:parent.aggregate_version};};
 const child=callTool(f.db,f.coord.auth,"split_task",args(root)).task;
 assert.equal(child.parent_uid,root.task_uid);assert.equal(child.released,false);
 assert.throws(()=>callTool(f.db,f.coord.auth,"split_task",{...args(root),subject:"t e s t t a s k"}),{code:"CONFLICT"});
 const follow=callTool(f.db,f.coord.auth,"split_task",args(child)).task;
 const deeper=callTool(f.db,f.coord.auth,"split_task",args(follow)).task;
 assert.equal(deeper.parent_uid,follow.task_uid);assert.equal(deeper.tree_mode,"hierarchical");
 assert.equal(store.chainDepth(f.db,deeper.id).depth,3);
 f.db.prepare("UPDATE tasks SET description='edited' WHERE id=?").run(root.id);
 assert.throws(()=>callTool(f.db,f.coord.auth,"split_task",args(root)),{code:"CONFLICT"});
 const w=worker(f),own=callTool(f.db,w.identity.auth,"split_task",args(w.task)).task;
 assert.equal(own.parent_uid,w.task.task_uid);assert.equal(own.released,false);
 assert.throws(()=>callTool(f.db,w.identity.auth,"split_task",args(child)),{code:"NOT_FOUND"});
});

test("a lost report transaction preserves task, run, span and event state until a successful retry",()=>{
 const f=fixture(),w=worker(f),args={request_id:randomUUID(),task_uid:w.task.task_uid,run_id:w.task.run_id,outcome:"done",evidence:"receipt rollback fixture"};
 const snapshot=()=>JSON.stringify({task:store.get(f.db,w.task.id),runs:store.runs(f.db,w.task.id),events:store.events(f.db,{taskId:w.task.id}),spans:f.db.prepare("SELECT work_spans FROM tasks WHERE id=?").get(w.task.id)});
 const before=snapshot();
 f.db.exec("CREATE TRIGGER fail_report_receipt BEFORE INSERT ON broker_requests BEGIN SELECT RAISE(ABORT,'injected report receipt'); END");
 assert.throws(()=>callTool(f.db,w.identity.auth,"report_result",args),/injected report receipt/);
 assert.equal(snapshot(),before);
 f.db.exec("DROP TRIGGER fail_report_receipt");
 assert.equal(callTool(f.db,w.identity.auth,"report_result",args).task.waiting_for,"review");
 assert.equal(store.events(f.db,{taskId:w.task.id}).filter(x=>x.kind==="report").length,1);
});

test("independent simultaneous retries commit one task and share the durable response",async()=>{
 const f=fixture(),args=createArgs(),replies=[],pending=[];
 const script=[
  'const {DatabaseSync}=require("node:sqlite"),{pathToFileURL}=require("node:url"),{readFileSync}=require("node:fs");',
  '(async()=>{const {callTool}=await import(pathToFileURL(process.argv[1]));const db=new DatabaseSync(process.argv[2]);db.exec("PRAGMA busy_timeout=5000");',
  'const c=JSON.parse(readFileSync(process.argv[3],"utf8"));process.on("message",m=>{try{const r=callTool(db,"Bearer "+c.token,"create_task",m);process.send({result:r});db.close();process.disconnect();}catch(e){console.error(e.code);process.exit(1);}});process.send({ready:true});})();'
 ].join("\n");
 for(let i=0;i<2;i++){
  const cp=spawn(process.execPath,["-e",script,join(ROOT,"core/mcp/tools.mjs"),f.dbPath,f.coord.file],{windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]});children.push(cp);
  let stderr="";cp.stderr.on("data",b=>stderr+=b);
  const ready=new Promise((resolve,reject)=>{cp.on("error",reject);cp.on("message",m=>{if(m.ready)resolve();if(m.result)replies.push(m.result);});});
  const done=new Promise((resolve,reject)=>cp.once("close",code=>code===0?resolve():reject(Error("child exit "+code+": "+stderr))));
  pending.push({cp,ready,done});done.catch(()=>{});
 }
 let timer;
 try{
  await Promise.race([(async()=>{await Promise.all(pending.map(x=>x.ready));for(const x of pending)x.cp.send(args);await Promise.all(pending.map(x=>x.done));})(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("concurrent MCP timeout")),15000))]);
  assert.equal(replies.length,2);assert.deepEqual(replies[0],replies[1]);assert.equal(count(f,"tasks"),1);assert.equal(count(f,"broker_requests"),1);
 }finally{clearTimeout(timer);for(const x of pending)if(x.cp.exitCode===null)x.cp.kill();await Promise.allSettled(pending.map(x=>x.done));}
});

test("local administration CLI grants limited credentials and serves only the authenticated loopback API",async()=>{
 const f=fixture(),file=path("role")+".json",credential=path("admin-credential")+".json";
 writeFileSync(file,JSON.stringify(policy("cli-role","observe")));
 const admin=(...args)=>{const r=spawnSync(process.execPath,[join(ROOT,"cli/mcp-admin.mjs"),...args,"--db",f.dbPath],{windowsHide:true,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 assert.equal(admin("role","--policy-file",file).role_id,"cli-role");
 const p=admin("grant","--role","cli-role","--projects","demo","--credential-file",credential);
 assert.ok(!Object.hasOwn(p,"token"));
 const id=store.add(f.db,{subject:"operator admission"});
 assert.equal(admin("enroll","--task",String(id),"--project","demo","--work-kind","review","--version","1").project_id,"demo");
 const cp=spawn(process.execPath,[join(ROOT,"cli/mcp-admin.mjs"),"serve","--db",f.dbPath,"--port","0"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});children.push(cp);
 let stdout="",stderr="",timer;cp.stderr.on("data",b=>stderr+=b);const closed=new Promise(r=>cp.once("close",r));
 try{
  const info=await Promise.race([new Promise((resolve,reject)=>{cp.on("error",reject);cp.once("close",c=>reject(Error("broker exited "+c+": "+stderr)));cp.stdout.on("data",b=>{stdout+=b;if(stdout.includes("\n")){try{resolve(JSON.parse(stdout.trim()));}catch(e){reject(e);}}});}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("broker startup timeout")),10000))]);
  const c=JSON.parse(readFileSync(credential,"utf8")),headers={Authorization:"Bearer "+c.token,"Content-Type":"application/json"};
  const r=await fetch(info.listening+"/local/v1/tools/list",{method:"POST",headers,body:"{}"});assert.equal(r.status,200);assert.ok((await r.json()).result.tools.every(x=>x.annotations.readOnlyHint));
  admin("revoke","--principal",p.principal_id,"--version","1");
  assert.equal((await fetch(info.listening+"/local/v1/tools/list",{method:"POST",headers,body:"{}"})).status,401);
  assert.ok(!stdout.includes(c.token));assert.ok(!stderr.includes(c.token));
 }finally{clearTimeout(timer);if(cp.exitCode===null)cp.kill();await closed;}
});

test("quarantined and activated backup copies cannot reuse MCP credentials from the prior node epoch",()=>{
 const f=fixture();create(f);const evidence=join(f.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"result.txt"),"fixture");
 const backup=createBackup({dbPath:f.dbPath,evidenceDir:evidence,destination:path("backup")}),dir=path("restored");
 restoreBackup({backupDirectory:backup.destination,destination:dir});const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);
 assert.throws(()=>listTools(db,f.coord.auth),{code:"RESTORE_HOLD"});
 retireNode({dbPath:f.dbPath,expectedEpoch:f.node.sync_epoch});
 assert.throws(()=>listTools(f.db,f.coord.auth),{code:"NODE_RETIRED"});
 const plan=prepareRecovery({dbPath});
 const attestation={format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated MCP fixture; no physical devices",attested_at:new Date().toISOString()};
 activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation});
 assert.throws(()=>listTools(db,f.coord.auth),{code:"UNAUTHENTICATED"});
 const fresh=grant({...f,db},"coord");assert.ok(listTools(db,fresh.auth).tools.length);assert.notEqual(fresh.principal.node_epoch,f.node.sync_epoch);
});

test("gateway rejects malformed, oversized and unknown input fields without creating tasks",async()=>{
 const f=fixture(),n=await network(f),headers={Authorization:f.coord.auth,"Content-Type":"application/json"};
 const send=body=>fetch(n.url+"/local/v1/tools/call",{method:"POST",headers,body});
 assert.equal((await send("{invalid}")).status,400);
 assert.equal((await send(JSON.stringify({name:"create_task",arguments:createArgs(),principal:"forged"}))).status,400);
 assert.equal((await send(" ".repeat(128*1024+1))).status,413);
 assert.equal((await send(Buffer.from([0xff]))).status,400);
 assert.equal(count(f,"tasks"),0);
});

test("malformed credential files never echo secret fragments through stdio startup diagnostics",()=>{
 const f=fixture(),bad=path("broken-credential")+".json";
 writeFileSync(bad,f.coord.credential.token);
 const r=spawnSync(process.execPath,[join(ROOT,"cli/mcp.mjs"),"--url","http://127.0.0.1:1","--credential-file",bad],{windowsHide:true,encoding:"utf8",timeout:10000});
 assert.equal(r.status,1);assert.equal(r.stdout,"");assert.match(r.stderr,/BAD_CREDENTIAL/);
 assert.ok(!r.stderr.includes(f.coord.credential.token.slice(0,16)));
});


test("MCP splitting reaches depth 32, replays once and refuses the next level atomically",()=>{
 const f=fixture();let parent=create(f,{kind:"goal"});
 const split=p=>{const a=createArgs();delete a.kind;return {...a,parent_uid:p.task_uid,expected_version:p.aggregate_version};};
 for(let depth=1;depth<=32;depth++){
  const args=split(parent),result=callTool(f.db,f.coord.auth,"split_task",args);
  assert.equal(result.task.parent_uid,parent.task_uid);assert.deepEqual(callTool(f.db,f.coord.auth,"split_task",args),result);
  parent=result.task;
 }
 const before={tasks:count(f,"tasks"),requests:count(f,"broker_requests"),events:count(f,"task_events"),projects:count(f,"broker_task_projects")};
 assert.throws(()=>callTool(f.db,f.coord.auth,"split_task",split(parent)),{code:"BAD_INPUT"});
 assert.deepEqual({tasks:count(f,"tasks"),requests:count(f,"broker_requests"),events:count(f,"task_events"),projects:count(f,"broker_task_projects")},before);
 assert.equal(store.chainDepth(f.db,parent.id).depth,32);assert.equal(count(f,"task_runs"),0);
});
test("MCP enrollment keeps a legacy tree and refuses legacy uplift instead of changing its parent",()=>{
 const f=fixture();let parent;
 for(let depth=0;depth<=2;depth++){
  const id=store.add(f.db,{subject:"legacy "+depth,parentId:parent?.id??null,kind:depth?"task":"goal"});
  parent=store.get(f.db,id);enrollTask(f.db,{id,projectId:"demo",workKind:"implement",capabilities:["board-tools"],expectedVersion:parent.aggregate_version});
 }
 const args=createArgs();delete args.kind;const before=count(f,"tasks");
 assert.throws(()=>callTool(f.db,f.coord.auth,"split_task",{...args,parent_uid:parent.task_uid,expected_version:parent.aggregate_version}),{code:"CHAIN_LIMIT"});
 assert.equal(count(f,"tasks"),before);assert.equal(store.get(f.db,parent.id).tree_mode,"legacy");
});

test("deep JSON tool arguments return BAD_INPUT over HTTP without writing a task",async()=>{
 const f=fixture(),n=await network(f);let nested="end";for(let i=0;i<1000;i++)nested={child:nested};
 const r=await fetch(n.url+"/local/v1/tools/call",{method:"POST",headers:{Authorization:f.coord.auth,"Content-Type":"application/json"},body:JSON.stringify({name:"create_task",arguments:createArgs({description:nested})})});
 assert.equal(r.status,400);assert.equal((await r.json()).code,"BAD_INPUT");assert.equal(count(f,"tasks"),0);assert.equal(count(f,"broker_requests"),0);
});


test("role registration rejects unknown and incompatible execution capability profiles before writing",()=>{
 const f=fixture(),roles=count(f,"broker_roles"),events=count(f,"broker_auth_events");
 for(const kind of ["implement","review"])for(const capabilities of [[],["code"],["shell-anything"],["board-tools","workspace-files"],["board-tools","board-tools"]])
  assert.throws(()=>putRole(f.db,policy("bad",kind,{capabilities})),{code:"BAD_INPUT"});
 assert.throws(()=>putRole(f.db,policy("bad","coordinate",{capabilities:["shell-anything"]})),{code:"BAD_INPUT"});
 assert.equal(count(f,"broker_roles"),roles);assert.equal(count(f,"broker_auth_events"),events);
 for(const runtime of ["claude","codex","zcode"])for(const capability of ["board-tools","workspace-files"]){
  const r=putRole(f.db,policy(runtime+"-"+capability,"implement",{runtime,capabilities:[capability]}));
  assert.deepEqual(r.policy.capabilities,[capability]);
 }
});

test("legacy unsupported roles cannot authenticate, mint credentials or route work and need explicit versioned repair",()=>{
 const f=fixture(),w=worker(f),old={...w.role.policy,capabilities:["code"]};
 f.db.prepare("UPDATE broker_roles SET policy_json=?,policy_digest=? WHERE role_id='engine'").run(JSON.stringify(old),digest(old));
 const rows=count(f,"broker_principals"),events=count(f,"broker_auth_events"),file=path("legacy-grant")+".json";
 assert.throws(()=>getRole(f.db,"engine"),{code:"POLICY_INVALID"});
 assert.throws(()=>authenticatePrincipal(f.db,w.identity.auth),{code:"POLICY_INVALID"});
 assert.throws(()=>issuePrincipal(f.db,{roleId:"engine",projects:["demo"],runId:w.task.run_id,credentialFile:file}),{code:"POLICY_INVALID"});
 assert.equal(existsSync(file),false);assert.equal(count(f,"broker_principals"),rows);assert.equal(count(f,"broker_auth_events"),events);
 assert.deepEqual(callTool(f.db,f.coord.auth,"list_roles",{}).roles.map(r=>r.role_id),["coord"]);
 const t=create(f),args=()=>({request_id:randomUUID(),task_uid:t.task_uid,expected_version:t.aggregate_version});
 assert.equal(callTool(f.db,f.coord.auth,"request_assignment",args()).state,"waiting_policy");assert.equal(store.get(f.db,t.id).attempts,0);
 const child=spawnSync(process.execPath,[join(ROOT,"cli/mcp-admin.mjs"),"roles","--db",f.dbPath],{encoding:"utf8",windowsHide:true});
 assert.equal(child.status,0,child.stderr);const bad=JSON.parse(child.stdout).roles.find(r=>r.role_id==="engine");
 assert.equal(bad.valid,false);assert.equal(bad.version,1);assert.equal(bad.error.code,"POLICY_INVALID");assert.equal(bad.policy,undefined);
 putRole(f.db,policy("fallback","implement",{priority:20}));assert.equal(callTool(f.db,f.coord.auth,"request_assignment",args()).role_id,"fallback");
 assert.throws(()=>putRole(f.db,policy("engine","implement"),2),{code:"CONFLICT"});
 const repaired=putRole(f.db,policy("engine","implement"),1);assert.equal(repaired.version,2);
 assert.throws(()=>authenticatePrincipal(f.db,w.identity.auth),{code:"POLICY_CHANGED"});
 assert.equal(callTool(f.db,f.coord.auth,"request_assignment",args()).role_id,"engine");
});

test("stored role JSON, identity and digest corruption fail closed but remain replaceable",()=>{
 for(const mode of ["json","identity","digest"]){
  const f=fixture(),r=putRole(f.db,policy("engine","implement"));
  const bad=mode==="json"?"{":JSON.stringify({...r.policy,...(mode==="identity"?{role_id:"other"}:{})});
  f.db.prepare("UPDATE broker_roles SET policy_json=?,policy_digest=? WHERE role_id='engine'").run(bad,mode==="digest"?"0".repeat(64):r.policy_digest);
  assert.throws(()=>getRole(f.db,"engine"),{code:"POLICY_INVALID"});
  assert.equal(putRole(f.db,policy("engine","implement"),1).version,2);
 }
});


test("run credentials get identical HTTP absence for another task and an unknown UID",async()=>{
 const f=fixture(),w=worker(f),other=create(f),n=await network(f),missing=f.node.node_id+"/"+randomUUID();
 for(const name of ["get_task","heartbeat","split_task"]){
  const args=uid=>name==="get_task"?{task_uid:uid}:name==="heartbeat"?{request_id:randomUUID(),task_uid:uid,run_id:w.task.run_id}:{...createArgs(),kind:undefined,parent_uid:uid,expected_version:1};
  const replies=[];
  for(const uid of [other.task_uid,missing]){
   const r=await fetch(n.url+"/local/v1/tools/call",{method:"POST",headers:{Authorization:w.identity.auth,"Content-Type":"application/json"},body:JSON.stringify({name,arguments:args(uid)})});
   assert.equal(r.status,404);replies.push(await r.json());
  }
  assert.deepEqual(replies[0],replies[1]);assert.equal(replies[0].code,"NOT_FOUND");
 }
 assert.equal(callTool(f.db,w.identity.auth,"get_task",{task_uid:w.task.task_uid}).task.task_uid,w.task.task_uid);
 assert.equal(count(f,"tasks"),2);
});

test("independent stdio bypasses environment proxies and an ambient fetch override",async()=>{
 const f=fixture(),n=await network(f);let intercepted=0;
 const proxy=http.createServer((req,res)=>{intercepted++;res.writeHead(502);res.end();});servers.push(proxy);
 await new Promise(r=>proxy.listen(0,"127.0.0.1",r));const proxyUrl="http://127.0.0.1:"+proxy.address().port;
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/[a-z]*_proxy$|^node_options$|^node_use_env_proxy$/i.test(k)));
 Object.assign(env,{HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,ALL_PROXY:proxyUrl,NO_PROXY:"",NODE_USE_ENV_PROXY:"1"});
 const preload="data:text/javascript,"+encodeURIComponent('globalThis.fetch=()=>{throw Error("ambient fetch must not receive credentials")};');
 const child=spawn(process.execPath,["--import",preload,join(ROOT,"cli/mcp.mjs"),"--url",n.url,"--credential-file",f.coord.file],{env,windowsHide:true,stdio:["pipe","pipe","pipe"]});children.push(child);
 let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);const done=new Promise(r=>child.once("close",r));
 child.stdin.end([
  {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"proxy-fixture",version:"1"}}},
  {jsonrpc:"2.0",method:"notifications/initialized"},
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create_task",arguments:createArgs()}}
 ].map(x=>JSON.stringify(x)).join("\n")+"\n");
 let timer;try{const code=await Promise.race([done,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("proxy stdio timeout")),15000))]);assert.equal(code,0,stderr);}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();await done;}
 const replies=stdout.trim().split("\n").map(x=>JSON.parse(x));assert.equal(replies[0].result.serverInfo.name,"ai-fleet-board");assert.equal(replies[1].result.isError,false);
 assert.equal(count(f,"tasks"),1);assert.equal(intercepted,0);assert.ok(!stdout.includes(f.coord.credential.token));assert.ok(!stderr.includes(f.coord.credential.token));
});

test("direct broker transport rejects redirects, oversized bodies, bad UTF-8 and identity changes",async()=>{
 const f=fixture();let mode="redirect",followed=0;
 const server=http.createServer((req,res)=>{
  req.resume();if(req.url==="/stolen"){followed++;res.end("{}");return;}
  if(mode==="redirect"){res.writeHead(307,{Location:"/stolen"});res.end();}
  else if(mode==="large"){res.end(Buffer.alloc(1024*1024+1,65));}
  else if(mode==="utf8"){res.end(Buffer.from([0xff]));}
  else res.end(JSON.stringify({node_id:randomUUID(),node_epoch:f.node.sync_epoch,result:{tools:[]}}));
 });servers.push(server);await new Promise(r=>server.listen(0,"127.0.0.1",r));
 for(mode of ["redirect","large","utf8","identity"]){
  const bridge=createBridge({url:"http://127.0.0.1:"+server.address().port,credentialFile:f.coord.file});
  const reply=await bridge({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"fixture",version:"1"}}});
  assert.equal(reply.error.code,-32000);assert.ok(!JSON.stringify(reply).includes(f.coord.credential.token));
 }
 assert.equal(followed,0);
});


test("direct broker transport supports IPv6 and aborts an incomplete response at its deadline",async()=>{
 const f=fixture(),server=await listenBroker(f.db,{host:"::1",port:0});servers.push(server);
 const initialize={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"ipv6-fixture",version:"1"}}};
 const bridge=createBridge({url:"http://[::1]:"+server.address().port,credentialFile:f.coord.file});
 assert.equal((await bridge(initialize)).result.serverInfo.name,"ai-fleet-board");
 let closed;const socketClosed=new Promise(r=>closed=r);
 const stalled=http.createServer((req,res)=>{req.resume();res.writeHead(200);res.write('{"partial":');res.once("close",closed);});servers.push(stalled);
 await new Promise(r=>stalled.listen(0,"127.0.0.1",r));const waiting=createBridge({url:"http://127.0.0.1:"+stalled.address().port,credentialFile:f.coord.file});
 const started=performance.now(),reply=await waiting(initialize);assert.equal(reply.error.code,-32000);assert.ok(performance.now()-started<14000);
 let timer;try{await Promise.race([socketClosed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("deadline did not close connection")),1000))]);}finally{clearTimeout(timer);}
});


test("MCP credentials are owner-only and failed protection rolls back principal and audit",()=>{
 const f=fixture(),acl=inspectAcl(f.coord.file);
 assert.equal(acl.protected,true);assert.deepEqual(acl.rules,[{sid:acl.current,inherited:false,rights:2032127,type:"Allow"}]);
 const before=count(f,"broker_auth_events"),file=path("no-protection")+".json",previous=process.env.SystemRoot;
 try{process.env.SystemRoot=path("missing-windows");assert.throws(()=>issuePrincipal(f.db,{roleId:"coord",projects:["demo"],credentialFile:file}),{code:"PRIVATE_FILE_FAILED"});}finally{process.env.SystemRoot=previous;}
 assert.equal(existsSync(file),false);assert.equal(count(f,"broker_principals"),1);assert.equal(count(f,"broker_auth_events"),before);
 assert.equal(listTools(f.db,f.coord.auth).tools.length>0,true);
});

for(const kind of ["implement","review"])test(kind+" run cannot discover or call desktop evidence pagination",()=>{
 const f=fixture(),w=worker(f,{kind});
 assert.ok(!listTools(f.db,w.identity.auth).tools.some(t=>t.name==="get_task_evidence"));
 assert.throws(()=>callTool(f.db,w.identity.auth,"get_task_evidence",{task_uid:w.task.task_uid,section:"runs"}),{code:"FORBIDDEN",status:403});
});


test("H7a missing credential paths remain private in CLI diagnostics",()=>{
 const file=path("private-account-missing")+".json";
 const r=spawnSync(process.execPath,[join(ROOT,"cli/mcp.mjs"),"--url","http://127.0.0.1:1","--credential-file",file],{windowsHide:true,encoding:"utf8",timeout:10000});
 assert.equal(r.status,1);assert.match(r.stderr,/BAD_CREDENTIAL/);
 assert.equal(r.stdout,"");assert.ok(!r.stderr.includes(file));assert.ok(!r.stderr.includes("private-account"));assert.ok(!r.stderr.includes("ENOENT"));
});

test("H7b ended workers lose tools while exact lost report receipts remain retrievable over HTTP",async()=>{
 const f=fixture(),w=worker(f),n=await network(f);
 const send=async(name,args)=>{const r=await fetch(n.url+"/local/v1/tools/call",{method:"POST",headers:{authorization:w.identity.auth,"content-type":"application/json"},body:JSON.stringify({name,arguments:args})});return {status:r.status,body:await r.json()};};
 assert.equal((await send("get_task",{task_uid:w.task.task_uid})).status,200);
 const args={request_id:randomUUID(),task_uid:w.task.task_uid,run_id:w.task.run_id,outcome:"done",evidence:"H7 fixture result"};
 const report=await send("report_result",args);assert.equal(report.status,200);
 assert.equal((await send("get_task",{task_uid:w.task.task_uid})).body.code,"RUN_EXPIRED");
 assert.throws(()=>listTools(f.db,w.identity.auth),{code:"RUN_EXPIRED"});
 assert.throws(()=>authenticatePrincipal(f.db,w.identity.auth),{code:"RUN_EXPIRED"});
 for(const [name,a] of [["heartbeat",{...args}],["report_result",{...args,request_id:randomUUID()}],["report_result",{...args,evidence:"changed"}]])assert.notEqual((await send(name,a)).status,200);
 assert.deepEqual(await send("report_result",args),report);
 const bridge=createBridge({url:n.url,credentialFile:w.identity.file});
 const initialized=await bridge({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"receipt-reconnect",version:"1"}}});
 assert.equal(initialized.error,undefined,JSON.stringify(initialized));
 await bridge({jsonrpc:"2.0",method:"notifications/initialized"});
 const replay=await bridge({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"report_result",arguments:args}});
 assert.equal(replay.result.isError,false);assert.deepEqual(replay.result.structuredContent,report.body.result);
 const denied=await bridge({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"get_task",arguments:{task_uid:w.task.task_uid}}});
 assert.equal(denied.result.structuredContent.code,"RUN_EXPIRED");
 assert.equal(store.events(f.db,{taskId:w.task.id}).filter(x=>x.kind==="report").length,1);
 revokePrincipal(f.db,{principalId:w.identity.principal.principal_id,expectedVersion:1});
 assert.equal((await send("report_result",args)).body.code,"UNAUTHENTICATED");
});

test("H7c credential revocation removes only registered matching files after commit and can resume cleanup",async()=>{
 const f=fixture(),c=f.coord;
 f.db.exec("BEGIN IMMEDIATE");revokePrincipal(f.db,{principalId:c.principal.principal_id,expectedVersion:1});assert.equal(existsSync(c.file),true);f.db.exec("ROLLBACK");
 assert.doesNotThrow(()=>authenticatePrincipal(f.db,c.auth));assert.equal(existsSync(c.file),true);
 revokePrincipal(f.db,{principalId:c.principal.principal_id,expectedVersion:1});assert.equal(existsSync(c.file),false);
 const d=grant(f,"coord"),original=readFileSync(d.file,"utf8");writeFileSync(d.file,"replacement owned by caller");
 revokePrincipal(f.db,{principalId:d.principal.principal_id,expectedVersion:1});assert.equal(readFileSync(d.file,"utf8"),"replacement owned by caller");
 const run=()=>spawnSync(process.execPath,[join(ROOT,"cli/mcp-admin.mjs"),"cleanup-credentials","--db",f.dbPath],{windowsHide:true,encoding:"utf8",timeout:30000});
 const refused=run();assert.equal(refused.status,0,refused.stderr);assert.ok(JSON.parse(refused.stdout).items.some(x=>x.principal_id===d.principal.principal_id&&x.status==="changed"));
 writeFileSync(d.file,original);const cleaned=run();assert.equal(cleaned.status,0,cleaned.stderr);assert.equal(existsSync(d.file),false);
 const output=cleaned.stdout+refused.stdout;assert.ok(!output.includes(d.file));assert.ok(!output.includes(d.credential.token));
 const {cleanupPrincipalCredentials}=await import("../core/mcp/policy.mjs");assert.equal(cleanupPrincipalCredentials(f.db).items.length,0);
 const active=grant(f,"coord");assert.equal(cleanupPrincipalCredentials(f.db).items.length,0);assert.equal(existsSync(active.file),true);
});
