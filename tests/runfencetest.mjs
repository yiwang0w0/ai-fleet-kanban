import { fixtureVersion } from "./http-version-fixture.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
const require=createRequire(import.meta.url), store=require("../core/store.js");
const handles=[], TMP=mkdtempSync(join(tmpdir(),"fleet-run-"));
const ROOT=fileURLToPath(new URL("../",import.meta.url));
function fixture() {
  const db=new DatabaseSync(":memory:"); handles.push(db); store.migrate(db);
  const id=store.add(db,{subject:"run fixture"});
  return {db,id};
}
function claim(db,id,opts={}) {
  const r=store.claimById(db,{id,worker:"worker-a",...opts});
  assert.equal(r.ok,true,JSON.stringify(r)); return r.task;
}
function callback(db,id,runId,op="report") {
  return store[op](db,{id,worker:"worker-a",runId,outcome:"done",evidence:"accepted"});
}
after(()=>{for(const db of handles)db.close();rmSync(TMP,{recursive:true,force:true});});

test("same-name reclaim receives a new ID; old report changes no row or history",()=>{
  const {db,id}=fixture(), first=claim(db,id);
  store.releaseHeldBy(db,"worker-a"); const second=claim(db,id);
  assert.notEqual(first.run_id,second.run_id);
  const before=store.get(db,id), events=store.events(db,{taskId:id});
  assert.throws(()=>callback(db,id,first.run_id),{code:"CONFLICT"});
  assert.deepEqual(store.get(db,id),before); assert.deepEqual(store.events(db,{taskId:id}),events);
  callback(db,id,second.run_id); assert.equal(store.get(db,id).status,"waiting");
});
for(const op of ["report","heartbeat","bumpAttempt"]) {
  test(op+" rejects missing/malformed IDs and stale runs",()=>{
    const {db,id}=fixture(), a=claim(db,id);
    for(const token of [undefined,null,"",42,"invalid"]) assert.throws(()=>callback(db,id,token,op),{code:"BAD_INPUT"});
    store.releaseHeldBy(db,"worker-a"); const b=claim(db,id), before=store.get(db,id);
    assert.throws(()=>callback(db,id,a.run_id,op),{code:"CONFLICT"});
    assert.deepEqual(store.get(db,id),before);
    callback(db,id,b.run_id,op);
  });
}
for (const op of ["report","heartbeat","bumpAttempt"]) {
  test(op+" fences a same-worker reclaim between pre-read and SQL write",()=>{
    const {db,id}=fixture(), first=claim(db,id); let switched=false, second;
    const switchRun=()=>{if(switched)return; switched=true;store.releaseHeldBy(db,"worker-a");second=claim(db,id);};
    // Deterministic interleaving of another writer before the first mutation.
    // report starts a transaction; heartbeat and retry are single gated UPDATEs.
    const proxy=new Proxy(db,{get(target,key){
      if(key==="exec")return sql=>{if(op==="report" && sql==="BEGIN IMMEDIATE")switchRun();return target.exec(sql);};
      if(key==="prepare")return sql=>{
        if(op!=="report" && /^UPDATE tasks SET (heartbeat_at|attempts=attempts)/.test(sql))switchRun();
        return target.prepare(sql);
      };
      const v=target[key];return typeof v==="function"?v.bind(target):v;
    }});
    assert.throws(()=>callback(proxy,id,first.run_id,op),{code:"CONFLICT"});
    assert.equal(switched,true);assert.equal(store.get(db,id).run_id,second.run_id);
    assert.equal(store.get(db,id).status,"in_progress");assert.equal(store.get(db,id).attempts,2);
    assert.equal(store.runs(db,id)[1].state,"running");
    callback(db,id,second.run_id);
  });
}
test("cross-task run IDs cannot authorize reports",()=>{
  const {db,id}=fixture(); const a=claim(db,id);
  const other=store.add(db,{subject:"other"}); claim(db,other);
  assert.throws(()=>callback(db,other,a.run_id),{code:"CONFLICT"});
});
test("retry stays within the claim and updates the ledger's last attempt",()=>{
  const {db,id}=fixture(), a=claim(db,id); callback(db,id,a.run_id,"bumpAttempt");
  const [run]=store.runs(db,id);
  assert.equal(run.first_attempt,1);assert.equal(run.last_attempt,2);assert.equal(run.run_id,a.run_id);
  callback(db,id,a.run_id);
  assert.equal(store.runs(db,id)[0].state,"ended");assert.ok(store.runs(db,id)[0].ended_at);
});
test("policy is hashed and immutable; next dispatch gets a fresh snapshot",()=>{
  const {db,id}=fixture(), agent=randomUUID();
  const a=claim(db,id,{runtime:"codex",agentInstanceId:agent,runContext:{role_id:"reviewer",tools:"read-only"}});
  const r=store.runs(db,id)[0];
  assert.equal(r.agent_instance_id,agent);assert.equal(r.task_uid,a.task_uid);
  assert.equal(r.policy_sha256,createHash("sha256").update(r.policy_json).digest("hex"));
  assert.throws(()=>db.exec("UPDATE task_runs SET policy_json='{}'"),/immutable/);
  assert.throws(()=>db.exec("DELETE FROM task_runs"),/append-only/);
  store.releaseHeldBy(db,"worker-a");claim(db,id,{runContext:{role_id:"implementer",tools:"write"}});
  assert.equal(store.runs(db,id)[0].policy.context.tools,"read-only");
  assert.equal(store.runs(db,id)[1].policy.context.tools,"write");
});
test("bad dispatch identity rolls back task, history and run creation",()=>{
  const {db,id}=fixture(), before=store.get(db,id), ev=store.events(db,{taskId:id});
  assert.throws(()=>claim(db,id,{agentInstanceId:"no"}),{code:"BAD_INPUT"});
  assert.deepEqual(store.get(db,id),before); assert.deepEqual(store.events(db,{taskId:id}),ev);
  assert.equal(store.runs(db,id).length,0);
});
test("child creation checks the original parent run within the add transaction",()=>{
  const {db,id}=fixture(), a=claim(db,id);
  store.releaseHeldBy(db,"worker-a"); const b=claim(db,id);
  const args={subject:"child",parentId:id,parentWorker:"worker-a"};
  assert.throws(()=>store.add(db,{...args,parentRunId:a.run_id}),{code:"CONFLICT"});
  assert.throws(()=>store.add(db,{...args,parentRunId:null}),{code:"BAD_INPUT"});
  const child=store.add(db,{...args,parentRunId:b.run_id});
  assert.equal(store.get(db,child).parent_id,id);
});
test("reaper ends old run; reclaimed run rejects delayed callbacks",()=>{
  const {db,id}=fixture(), a=claim(db,id);
  db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(id);store.reapExpired(db);
  assert.equal(store.runs(db,id)[0].state,"ended");
  const b=claim(db,id);assert.notEqual(a.run_id,b.run_id);
  assert.throws(()=>callback(db,id,a.run_id),{code:"CONFLICT"});
});
test("migration imports legacy in-flight dispatch exactly once",()=>{
  const {db,id}=fixture();
  db.prepare("UPDATE tasks SET status='in_progress',worker='legacy',attempts=3 WHERE id=?").run(id);
  store.migrate(db);const a=store.get(db,id);store.migrate(db);
  assert.equal(store.get(db,id).run_id,a.run_id);assert.equal(store.runs(db,id).length,1);
  const r=store.runs(db,id)[0];assert.equal(r.imported,1);assert.equal(r.agent_instance_id,null);
  assert.equal(r.first_attempt,3);
});
test("mismatched persisted run pointer refuses restart",()=>{
  const {db,id}=fixture();claim(db,id);
  db.prepare("UPDATE tasks SET run_id=? WHERE id=?").run(randomUUID(),id);
  assert.throws(()=>store.migrate(db),{code:"CONFLICT"});
});
test("public task edits cannot forge run IDs",()=>{
  const {db,id}=fixture();
  for(const k of ["run_id","runId"]) {
    assert.throws(()=>store.add(db,{subject:"forged",[k]:randomUUID()}),{code:"BAD_INPUT"});
    assert.throws(()=>store.update(db,{id,[k]:randomUUID()}),{code:"BAD_INPUT"});
  }
});

test("HTTP protocol rejects old workers and stale child/report/retry/heartbeat writes",async()=>{
  const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const config=join(TMP,"fleet.config.json");
  writeFileSync(config,JSON.stringify({lines:[{id:"alpha",role:{kind:"implement",tools:"write"}}]}));
  const proc=spawn(process.execPath,[join(ROOT,"core/server.mjs")],{
    env:{...process.env,BOARD_PORT:String(port),BOARD_DATA_DIR:TMP,BOARD_DB:join(TMP,"http.db"),
      BOARD_CONFIG:config,BOARD_ALLOW_UNPINNED:"1",BOARD_RESTART_MODE:"off"},
    windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="";proc.stdout.on("data",b=>out+=b);proc.stderr.on("data",b=>out+=b);
  const base="http://127.0.0.1:"+port;
  try {
    let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(base+"/health")).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(ready,true,out);
    const op=readFileSync(join(TMP,"board_token"),"utf8").trim(), wk=readFileSync(join(TMP,"worker_token"),"utf8").trim();
    async function api(method,path,body,token=op) {
      body=await fixtureVersion(base,token,method,path,body);
      const r=await fetch(base+path,{method,headers:{"Content-Type":"application/json","X-Board-Token":token},
        body:method==="GET"?undefined:JSON.stringify(body||{})});
      return {status:r.status,body:await r.json().catch(()=>null)};
    }
    const meta=await api("GET","/api/meta");assert.equal(meta.body.worker_protocol_version,2);
    const created=await api("POST","/api/tasks",{subject:"HTTP fixture",line:"alpha"});
    assert.equal(created.status,201,JSON.stringify(created));
    const id=created.body.task.id, common={worker:"worker-a",line:"alpha"};
    assert.equal((await api("POST","/api/claim",common,wk)).status,400);
    assert.equal((await api("GET","/api/tasks/"+id)).body.task.status,"not_started");
    const identity={worker_protocol_version:2,agent_instance_id:randomUUID()};
    const claimed=await api("POST","/api/claim",{...common,...identity,runContext:{tools:"unrestricted"}},wk);
    assert.equal(claimed.status,200,JSON.stringify(claimed));
    const a=claimed.body.task, path="/api/tasks/"+id;
    for(const endpoint of ["report","heartbeat","attempt"]) {
      const body={worker:"worker-a",outcome:"done",evidence:"x"};
      assert.equal((await api("POST",path+"/"+endpoint,body,wk)).status,400);
      assert.equal((await api("POST",path+"/"+endpoint,{...body,run_id:randomUUID()},wk)).status,409);
    }
    assert.equal((await api("POST","/api/tasks",{subject:"bad",parentId:id,worker:"worker-a"},wk)).status,400);
    assert.equal((await api("POST","/api/tasks",{subject:"old",parentId:id,parent_run_id:randomUUID(),worker:"worker-a"},wk)).status,409);
    const child=await api("POST","/api/tasks",{subject:"valid child",parent_id:id,parent_run_id:a.run_id,worker:"worker-a"},wk);
    assert.equal(child.status,201,JSON.stringify(child)); assert.equal(child.body.task.parent_id,id);
    const childPath="/api/tasks/"+child.body.task.id;
    const cc=await api("POST",childPath+"/claim",{worker:"worker-a"});
    assert.equal(cc.status,200,JSON.stringify(cc));
    await api("POST",childPath+"/report",{worker:"worker-a",run_id:cc.body.task.run_id,outcome:"done",evidence:"child completed"});
    assert.equal((await api("POST",childPath+"/resolve",{verdict:"approve"})).status,200);
    const delivered=await api("POST",path+"/report",{worker:"worker-a",run_id:a.run_id,outcome:"done",evidence:"old round"},wk);
    assert.equal(delivered.status,200);
    const rejected=await api("POST",path+"/resolve",{verdict:"reject",note:"new input"});
    assert.equal(rejected.status,200,JSON.stringify(rejected));
    const next=await api("POST",path+"/claim",{worker:"worker-a",force:true});
    assert.equal(next.status,200,JSON.stringify(next));assert.notEqual(next.body.task.run_id,a.run_id);
    for(const endpoint of ["report","heartbeat","attempt"]) {
      assert.equal((await api("POST",path+"/"+endpoint,{worker:"worker-a",run_id:a.run_id,outcome:"done",evidence:"obsolete"},wk)).status,409);
    }
    assert.equal((await api("POST","/api/tasks",{subject:"late child",parentId:id,parent_run_id:a.run_id,worker:"worker-a"},wk)).status,409);
    const history=await api("GET",path+"/runs"); assert.equal(history.body.runs.length,2);
    assert.equal(history.body.runs[0].agent_instance_id,identity.agent_instance_id);
    assert.equal(history.body.runs[0].state,"ended");assert.equal(history.body.runs[1].state,"running");
    assert.equal(history.body.runs[0].policy.context.enforcement,"unattested");
    assert.equal(history.body.runs[0].policy.context.tools,"write");
    const unassigned=await api("POST","/api/tasks",{subject:"unassigned"});
    const picked=await api("POST","/api/claim",{...identity,worker:"alpha-2",line:"alpha"},wk);
    assert.equal(picked.status,200);assert.equal(picked.body.task.id,unassigned.body.task.id);
    const unassignedRuns=await api("GET","/api/tasks/"+picked.body.task.id+"/runs");
    assert.equal(unassignedRuns.body.runs[0].role_id,"alpha");
    assert.equal(unassignedRuns.body.runs[0].worker,"alpha-2");
  } finally {
    if(proc.exitCode===null){proc.kill();await new Promise(r=>proc.once("exit",r));}
  }
});


test("HTTP claim identity enforces canonical v4 UUIDs and uses the loaded charter snapshot",()=>{
  const source=readFileSync(join(ROOT,"core/server.mjs"),"utf8"),charter=join(TMP,"claim-charter.md");
  writeFileSync(charter,"original charter");let reads=0;
  const role={kind:"implement",tools:"write",charter:"claim-charter.md",seat:null};
  const context=vm.createContext({CFG:{lines:[{id:"dev",role}]},ROLES:[],CODE_ROOT:TMP,store,resolve,createHash,
    normalizeRole:value=>value??null,readFileSync:path=>{reads++;return readFileSync(path);}});
  vm.runInContext(source.slice(source.indexOf("let LINES, SUPERVISED,"),source.indexOf("try { rebuildLines(); }"))+
    source.slice(source.indexOf("const WORKER_PROTOCOL_VERSION = 2;"),source.indexOf("const server = http.createServer")),context);
  vm.runInContext("rebuildLines()",context);assert.equal(reads,1);
  const good="550e8400-e29b-41d4-a716-446655440000";
  for(const bad of [good.toUpperCase(),good.replace("41d4","11d4"),good.replace("a716","0716"),"bad",null])
    assert.throws(()=>context.claimIdentity({worker_protocol_version:2,agent_instance_id:bad},"worker"),{code:"BAD_INPUT"});
  assert.throws(()=>context.claimIdentity({worker_protocol_version:1,agent_instance_id:good},"worker"),{code:"BAD_INPUT"});
  writeFileSync(charter,"changed on disk");
  const run=context.claimIdentity({worker_protocol_version:2,agent_instance_id:good,line:"dev"},"worker").runContextForTask({line:"dev"});
  assert.equal(run.charter_sha256,createHash("sha256").update("original charter").digest("hex"));assert.equal(reads,1);
  vm.runInContext("rebuildLines()",context);assert.equal(reads,2);
  assert.equal(context.claimIdentity({line:"dev"},"operator").runContextForTask({line:"dev"}).charter_sha256,
    createHash("sha256").update("changed on disk").digest("hex"));
  rmSync(charter);
  assert.throws(()=>vm.runInContext("rebuildLines()",context),{code:"ENOENT"});
  const prior=context.claimIdentity({line:"dev"},"operator").runContextForTask({line:"dev"});
  assert.equal(prior.charter_sha256,createHash("sha256").update("changed on disk").digest("hex"));assert.equal(reads,3);
  assert.equal(context.claimIdentity({line:"plain"},"operator").runContextForTask({line:"plain"}).charter_sha256,null);
});
