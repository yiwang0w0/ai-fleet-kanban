import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join,resolve,relative} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import {setTimeout as sleep} from "node:timers/promises";
import {migrateSync,recordSource,shareTask} from "../core/federation/sync-store.mjs";
import {readFleetView,readFleetTask} from "../core/fleet-view.mjs";
const store=createRequire(import.meta.url)("../core/store.js"),handles=[];
const NOW=Date.parse("2026-09-30T12:00:00Z"),recent=new Date(NOW-1000).toISOString();
function node(sync=true,path=":memory:"){const db=new DatabaseSync(path);handles.push(db);store.migrate(db);store.renameNode(db,"kanata");if(sync)migrateSync(db);return db;}
after(()=>{for(const db of handles)try{db.close();}catch{}});
function source(db,{name="kanata",project="demo",received=false}={}){
 const id=randomUUID(),epoch=randomUUID();recordSource(db,{node_id:id,display_name:name,sync_epoch:epoch});
 if(received)db.prepare("INSERT INTO federation_cursors VALUES(?,?,?,?,?)").run(id,project,epoch,0,recent);
 return {id,epoch,project};
}
function replica(db,s,{subject="远端任务",parent=null,archived=null,withdrawn=0,...extra}={}){
 const uid=s.id+":"+randomUUID(),payload={task_uid:uid,owner_node_id:s.id,subject,parent_uid:parent,description:"说明",acceptance:"验收",status:"not_started",kind:"task",aggregate_version:1,updated_at:recent,archived_at:archived,...extra};
 db.prepare("INSERT INTO federation_replicas VALUES(?,?,?,?,?,?,?,?,?,?)").run(uid,s.id,s.epoch,s.project,1,1,withdrawn,JSON.stringify(payload),1,recent);return uid;
}
function attempt(db,s,{success=recent,error=null,more=0,project=s.project}={}){
 db.exec("CREATE TABLE IF NOT EXISTS federation_sync_attempts(origin_node_id TEXT,project_id TEXT,last_attempt_at TEXT,last_success_at TEXT,error_code TEXT,failure_count INTEGER,retry_after INTEGER,has_more INTEGER,PRIMARY KEY(origin_node_id,project_id))");
 db.prepare("INSERT OR REPLACE INTO federation_sync_attempts VALUES(?,?,?,?,?,0,0,?)").run(s.id,project,recent,success,error,more);
}
const view=db=>readFleetView(db,{now:NOW});
test("ordinary local board can be read without creating sync tables or writing",()=>{
 const db=node(false),id=store.add(db,{subject:"本机"}),before=db.prepare("SELECT total_changes() n").get().n;
 const v=view(db);assert.equal(v.sync_state,"not_configured");assert.equal(v.tasks[0].local_id,id);assert.equal(v.nodes[0].counts.total,1);assert.equal(v.nodes[0].connection_state,"local");
 assert.equal(db.prepare("SELECT total_changes() n").get().n,before);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='federation_sync_schema'").get().n,0);
});
test("three same-name roots keep distinct ownership after rename",()=>{
 const db=node(),a=source(db,{received:true}),b=source(db,{received:true}),local=store.add(db,{subject:"本机根",kind:"goal"});
 const parent=replica(db,a,{subject:"远端根"}),child=replica(db,a,{subject:"子任务",parent});replica(db,b);
 const v=view(db);assert.equal(v.nodes.length,3);assert.equal(new Set(v.nodes.map(n=>n.node_id)).size,3);assert.ok(v.nodes.every(n=>n.display_name==="kanata"));assert.equal(v.tasks.find(t=>t.task_uid===child).parent_in_view,true);
 recordSource(db,{node_id:a.id,display_name:"kanata-office",sync_epoch:a.epoch});assert.equal(view(db).tasks.find(t=>t.task_uid===child).owner_name,"kanata-office");assert.equal(store.get(db,local).owner_node_id,v.local_node_id);assert.equal(store.list(db).tasks.length,1);
});
test("unsynchronized node has unknown count; received empty list has zero",()=>{
 const db=node(),unknown=source(db),empty=source(db,{received:true});const v=view(db);
 assert.equal(v.nodes.find(n=>n.node_id===unknown.id).counts,null);assert.equal(v.nodes.find(n=>n.node_id===empty.id).counts.total,0);
 assert.equal(v.nodes.find(n=>n.node_id===unknown.id).connection_state,"unknown");
});
test("failed and incomplete synchronization keep cached tasks and prior success time",()=>{
 const db=node(),s=source(db,{received:true});replica(db,s);attempt(db,s,{error:"NETWORK_ERROR"});let n=view(db).nodes.find(n=>n.node_id===s.id);
 assert.equal(n.connection_state,"failed");assert.equal(n.counts.total,1);assert.equal(n.projects[0].last_sync_at,recent);
 attempt(db,s,{more:1});assert.equal(view(db).nodes.find(n=>n.node_id===s.id).connection_state,"syncing");
});
test("freshness distinguishes stale, invalid/future time and never received",()=>{
 const db=node(),s=source(db,{received:true});
 for(const[success,state]of [[new Date(NOW-61000).toISOString(),"stale"],["invalid","clock_unknown"],[new Date(NOW+61000).toISOString(),"clock_unknown"],[null,"unknown"],[recent,"recent"]]){attempt(db,s,{success});assert.equal(view(db).nodes.find(n=>n.node_id===s.id).connection_state,state);}
});
test("one fresh project cannot hide an unknown project",()=>{
 const db=node(),s=source(db,{received:true});attempt(db,s,{success:null,project:"not-yet-received"});assert.equal(view(db).nodes.find(n=>n.node_id===s.id).connection_state,"unknown");
 assert.equal(readFleetView(db,{projectId:"demo",now:NOW}).nodes.find(n=>n.node_id===s.id).connection_state,"recent");
});
test("pending recovery and unresolved missing task are visible as recovery",()=>{
 const db=node(),s=source(db,{received:true}),uid=replica(db,s);const row=db.prepare("SELECT * FROM federation_replicas WHERE task_uid=?").get(uid);
 db.prepare("INSERT INTO federation_recovery_missing VALUES(?,?,?,?,?,?,NULL)").run(uid,s.id,s.epoch,s.project,JSON.stringify(row),randomUUID());db.prepare("DELETE FROM federation_replicas WHERE task_uid=?").run(uid);
 let v=view(db);assert.equal(v.tasks[0].recovery_state,"missing_review");assert.equal(v.nodes.find(n=>n.node_id===s.id).connection_state,"recovery");
 db.prepare("INSERT INTO federation_epoch_projects VALUES(?,?,?,?,?,?)").run(s.id,s.project,randomUUID(),randomUUID(),"pending",recent);assert.equal(view(db).nodes.find(n=>n.node_id===s.id).connection_state,"recovery");
});
test("archived and withdrawn tasks stay out of list and detail",()=>{
 const db=node(),s=source(db),a=replica(db,s,{archived:recent}),w=replica(db,s,{withdrawn:1}),local=store.add(db,{subject:"archived"});db.prepare("UPDATE tasks SET archived_at=? WHERE id=?").run(recent,local);
 assert.equal(view(db).tasks.length,0);for(const uid of [a,w,store.get(db,local).task_uid])assert.throws(()=>readFleetTask(db,uid),e=>e.status===404);
});
test("filters and limit keep exact matching counts and disclose missing parents",()=>{
 const db=node(),s=source(db,{received:true}),parent=replica(db,s,{subject:"parent"}),child=replica(db,s,{subject:"Child",parent});replica(db,s,{subject:"child two",parent});
 const v=readFleetView(db,{ownerNodeId:s.id,projectId:"demo",query:"CHILD",limit:1,now:NOW});assert.equal(v.total_matching,2);assert.equal(v.returned,1);assert.equal(v.truncated,true);assert.equal(v.nodes[0].counts.total,2);assert.ok(v.tasks[0].subject.toLowerCase().includes("child"));assert.equal(v.tasks[0].parent_uid,parent);assert.equal(v.tasks[0].parent_in_view,false);
});
test("detail only returns public view fields, preserving hostile text literally",()=>{
 const db=node(),s=source(db),subject='<img src=x onerror="alert(1)">',uid=replica(db,s,{subject,description:"<script>fixture</script>",verify_cmd:"PRIVATE-COMMAND",evidence_path:"PRIVATE-PATH",token:"PRIVATE-TOKEN"});
 const detail=readFleetTask(db,uid),encoded=JSON.stringify([view(db),detail]);assert.equal(detail.subject,subject);assert.equal(detail.read_only,true);assert.equal(detail.local_id,null);assert.ok(!encoded.includes("PRIVATE-"));
});
test("caller transaction is retained and old sync schema is not migrated by reads",()=>{
 const db=node();db.exec("BEGIN");store.add(db,{subject:"uncommitted"});assert.equal(view(db).tasks.length,1);assert.equal(db.isTransaction,true);db.exec("ROLLBACK");assert.equal(view(db).tasks.length,0);
 db.exec("UPDATE federation_sync_schema SET version=3");assert.equal(view(db).sync_state,"upgrade_required");assert.equal(db.prepare("SELECT version FROM federation_sync_schema").get().version,3);
});
test("invalid filters are rejected before database work",()=>{
 const db=node();for(const bad of [{limit:0},{limit:10001},{limit:1.5},{query:"x".repeat(161)},{ownerNodeId:"kanata"},{projectId:""},{now:NaN}])assert.throws(()=>readFleetView(db,bad),e=>e.status===400);
 assert.throws(()=>readFleetTask(db,null),e=>e.status===400);
});
test("local project and publication backlog are represented without publishing",()=>{
 const db=node(),id=store.add(db,{subject:"shared locally"});shareTask(db,{id,projectId:"demo",expectedVersion:store.get(db,id).aggregate_version});const v=view(db);assert.equal(v.tasks[0].project_id,"demo");assert.equal(v.pending_publications,1);assert.equal(db.prepare("SELECT count(*) n FROM federation_outbox").get().n,0);
});
test("real HTTP endpoints require operator token, reject foreign origin and remain read-only",{timeout:40000},async()=>{
 const root=fileURLToPath(new URL("../",import.meta.url)),dir=mkdtempSync(join(tmpdir(),"fleet-view-http-")),dbPath=join(dir,"board.db"),db=node(true,dbPath),id=store.add(db,{subject:"HTTP fixture"}),uid=store.get(db,id).task_uid;
 const config=join(dir,"config.json");writeFileSync(config,JSON.stringify({lines:[{id:"fixture",label:"fixture"}],roles:[],routes:["default"],repo:dir}));db.close();
 const probe=createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 let output="",exit=null;const proc=spawn(process.execPath,[join(root,"core/server.mjs")],{cwd:dir,windowsHide:true,env:{...process.env,BOARD_HOST:"127.0.0.1",BOARD_PORT:String(port),BOARD_CONFIG:config,BOARD_DATA_DIR:dir,BOARD_DB:dbPath,BOARD_REPO:dir,BOARD_POOL_TEST_MODE:"1",BOARD_POOL_TEST_PROBE:"ok"},stdio:["ignore","pipe","pipe"]});proc.stdout.on("data",b=>output+=b);proc.stderr.on("data",b=>output+=b);proc.on("error",e=>output+=e.message);proc.on("exit",code=>exit=code);
 const base=`http://127.0.0.1:${port}`,get=(path,headers={})=>fetch(base+path,{headers,signal:AbortSignal.timeout(5000)});
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await get("/health")).ok){ready=true;break;}}catch{}if(exit!==null)break;await sleep(200);}assert.ok(ready,output);
  const operator=readFileSync(join(dir,"board_token"),"utf8").trim();
  for(const path of ["/api/fleet","/api/fleet/task?uid="+encodeURIComponent(uid),"/api/fleet/evidence?section=runs&uid="+encodeURIComponent(uid)]){
   assert.equal((await get(path)).status,401);assert.equal((await get(path,{"X-Board-Token":"invalid"})).status,401);
   for(const role of ["worker","review"])assert.equal((await get(path,{"X-Board-Token":readFileSync(join(dir,role+"_token"),"utf8").trim()})).status,403);
   assert.equal((await get(path,{"X-Board-Token":operator,Origin:"https://foreign.invalid"})).status,403);
   const r=await get(path,{"X-Board-Token":operator});assert.equal(r.status,200);assert.match(r.headers.get("cache-control"),/no-store/);assert.ok(!JSON.stringify(await r.json()).includes(operator));
  }
  for(const path of ["/api/fleet?limit=0","/api/fleet?owner=kanata","/api/fleet/task","/api/fleet/evidence?uid="+encodeURIComponent(uid),"/api/fleet/evidence?section=runs&cursor=bad&uid="+encodeURIComponent(uid)])assert.equal((await get(path,{"X-Board-Token":operator})).status,400);
  assert.equal((await get("/api/fleet/task?uid=missing",{"X-Board-Token":operator})).status,404);assert.equal((await get("/fleet")).status,404);
 }finally{
  if(proc.exitCode===null){const closed=new Promise(r=>proc.once("exit",r));proc.kill();await closed;}
  const target=resolve(dir),baseTmp=resolve(tmpdir());assert.ok(relative(baseTmp,target)&&!relative(baseTmp,target).startsWith(".."));rmSync(target,{recursive:true,force:true});
 }
});
