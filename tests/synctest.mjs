import {issueCredential,listenPeerServer,fixtureEndpoint} from "./helpers/peer-network.mjs";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {migratePeers,localIdentity,authenticate} from "../core/federation/peers.mjs";

import {migrateSync,shareTask,exportBatch,acknowledge,applyBatch,listReplicas,syncStatus,cursor,digest,canonical} from "../core/federation/sync-store.mjs";
import {syncOnce,endpoint} from "../core/federation/sync-client.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-sync-")),handles=[];
let counter=0;
const target=t=>join(TMP,t+"-"+counter++);
after(()=>{for(const db of handles){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function node(){
 const data=target("node");mkdirSync(data);const dbPath=join(data,"board.db"),db=new DatabaseSync(dbPath);handles.push(db);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);
 return {db,dbPath,data,identity:localIdentity(db)};
}
function pair(projectId="demo"){
 const a=node(),b=node(),credentialFile=target("credential")+".json";
 issueCredential(a.db,{peerNodeId:b.identity.node_id,peerEpoch:b.identity.sync_epoch,scopes:["peer:handshake","sync:pull","sync:ack"],projects:[projectId],credentialFile});
 const credential=JSON.parse(readFileSync(credentialFile,"utf8")),peer=authenticate(a.db,"Bearer "+credential.token);
 return {a,b,credentialFile,credential,peer,projectId,source:{origin:a.identity.node_id,epoch:a.identity.sync_epoch,projectId}};
}
function task(a,fields={},projectId="demo"){
 const id=store.add(a.db,{subject:"shared task",...fields});
 shareTask(a.db,{id,projectId,expectedVersion:store.get(a.db,id).aggregate_version});
 return id;
}
const pull=(f,after_seq=0,limit=25)=>exportBatch(f.a.db,f.peer,{project_id:f.projectId,after_seq,limit});
const accept=(f,batch)=>applyBatch(f.b.db,f.source,batch);
const count=(db,table)=>db.prepare("SELECT count(*) AS n FROM "+table).get().n;
function reseal(event){event.payload_digest=digest(event.payload);const {event_digest,...rest}=event;event.event_digest=digest(rest);}
async function server(f,work){
 const s=await listenPeerServer(f.a.db,{port:0}),url="http://127.0.0.1:"+s.address().port;
 try{return await work(url,s);}finally{await new Promise(r=>{s.close(r);s.closeAllConnections();});}
}
test("only explicitly shared tasks enter events; projection excludes private paths and commands",()=>{
 const f=pair();store.add(f.a.db,{subject:"private"});
 const id=task(f.a,{evidencePath:"C:/private/secret.txt",verify_cmd:"secret command"});
 const batch=pull(f);assert.equal(batch.events.length,1);
 const dto=batch.events[0].payload.task;assert.equal(dto.task_uid,store.get(f.a.db,id).task_uid);
 assert.ok(!JSON.stringify(batch).includes("private"));assert.ok(!Object.hasOwn(dto,"verify_cmd"));assert.ok(!Object.hasOwn(dto,"evidence_path"));
 accept(f,batch);assert.equal(listReplicas(f.b.db).length,1);assert.equal(store.list(f.b.db).tasks.length,0);
 assert.equal(store.claim(f.b.db,{worker:"cannot-claim-replica"}),null);
});
test("shared content changes and outbox markers roll back atomically",()=>{
 const f=pair(),id=task(f.a);pull(f);
 assert.equal(count(f.a.db,"federation_dirty"),0);
 f.a.db.exec("CREATE TRIGGER fail_task_history BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>store.setReleased(f.a.db,{id,released:false,expectedVersion:1}),/injected/);
 assert.equal(store.get(f.a.db,id).aggregate_version,1);assert.equal(count(f.a.db,"federation_dirty"),0);
});
test("materialization coalesces committed state and keeps published events immutable",()=>{
 const f=pair(),id=task(f.a);
 const run=store.claimById(f.a.db,{id,worker:"local"}).task;
 const batch=pull(f);assert.equal(batch.events.length,1);
 assert.equal(batch.events[0].payload.task.run_id,run.run_id);
 assert.equal(batch.events[0].payload.task.status,"in_progress");
 const text=f.a.db.prepare("SELECT event_json FROM federation_outbox").get().event_json;
 store.report(f.a.db,{id,worker:"local",runId:run.run_id,outcome:"done",evidence:"finished locally"});
 assert.equal(f.a.db.prepare("SELECT event_json FROM federation_outbox").get().event_json,text);
 const next=pull(f,1);assert.equal(next.events[0].payload.task.status,"waiting");
 assert.throws(()=>f.a.db.exec("UPDATE federation_outbox SET event_digest='bad'"),/immutable/);
 assert.throws(()=>f.a.db.exec("DELETE FROM federation_outbox"),/retention/);
});
test("duplicates and lost ACK cause no duplicate application or execution",()=>{
 const f=pair();task(f.a);const batch=pull(f);
 const first=accept(f,batch),second=accept(f,batch);assert.equal(first.applied,1);assert.equal(second.applied,0);
 assert.equal(count(f.b.db,"federation_inbox"),1);assert.equal(count(f.b.db,"federation_replicas"),1);
 assert.equal(syncStatus(f.a.db).deliveries[0].acked_seq,0);
 const ack={project_id:f.projectId,...first.checkpoint};
 assert.equal(acknowledge(f.a.db,f.peer,ack).acked_seq,1);
 assert.equal(acknowledge(f.a.db,f.peer,ack).acked_seq,1);
 assert.equal(store.list(f.b.db).tasks.length,0);
});
test("receiving crash before cursor commit rolls back replicas and inbox together",()=>{
 const f=pair();task(f.a);const batch=pull(f);
 f.b.db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON federation_cursors BEGIN SELECT RAISE(ABORT,'injected crash'); END");
 assert.throws(()=>accept(f,batch),/injected crash/);
 assert.equal(count(f.b.db,"federation_replicas"),0);assert.equal(count(f.b.db,"federation_inbox"),0);
 assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,f.projectId),0);
 f.b.db.exec("DROP TRIGGER fail_cursor");
 assert.equal(accept(f,batch).applied,1);
});
test("gaps, reordering and content conflicts quarantine without overwriting current state",()=>{
 const f=pair(),id=task(f.a),first=pull(f);
 store.update(f.a.db,{id,description:"next",expectedVersion:1});const second=pull(f,1);
 assert.throws(()=>accept(f,second),{code:"SEQUENCE_GAP"});assert.equal(count(f.b.db,"federation_inbox"),0);
 accept(f,first);accept(f,second);
 const forged=structuredClone(first);forged.events[0].payload.task.subject="tampered";reseal(forged.events[0]);forged.checkpoint.event_digest=forged.events[0].event_digest;
 for(let i=0;i<2;i++)assert.throws(()=>accept(f,forged),{code:"CONTENT_MISMATCH"});
 assert.equal(listReplicas(f.b.db)[0].description,"next");
 assert.equal(syncStatus(f.b.db).quarantined,2);
});
test("a forged owner, epoch or task version cannot replace a replica",()=>{
 const f=pair(),id=task(f.a);const first=pull(f);accept(f,first);
 store.update(f.a.db,{id,description:"new",expectedVersion:1});const second=pull(f,1);accept(f,second);
 store.update(f.a.db,{id,description:"newest",expectedVersion:2});const third=pull(f,2);
 const wrongOwner=structuredClone(third);wrongOwner.events[0].payload.task.owner_node_id=f.b.identity.node_id;reseal(wrongOwner.events[0]);
 assert.throws(()=>accept(f,wrongOwner),{code:"OWNER_MISMATCH"});
 const oldVersion=structuredClone(third);oldVersion.events[0].payload.task.aggregate_version=1;reseal(oldVersion.events[0]);
 assert.throws(()=>accept(f,oldVersion),{code:"VERSION_REGRESSION"});
 assert.throws(()=>applyBatch(f.b.db,{...f.source,epoch:randomUUID()},third),{code:"SOURCE_MISMATCH"});
 assert.equal(listReplicas(f.b.db)[0].description,"new");assert.equal(count(f.b.db,"federation_inbox"),2);
});
test("backward wall clock does not replace a newer sequence or task version",()=>{
 const f=pair(),id=task(f.a);const first=pull(f);accept(f,first);
 f.a.db.prepare("UPDATE tasks SET description='newer',updated_at='1900-01-01' WHERE id=?").run(id);
 accept(f,pull(f,1));accept(f,first);
 assert.equal(listReplicas(f.b.db)[0].description,"newer");assert.equal(listReplicas(f.b.db)[0].updated_at,"1900-01-01");
});
test("project streams are isolated and ACKs cannot skip unsent events",()=>{
 const f=pair();task(f.a,{},"other");task(f.a);
 assert.throws(()=>exportBatch(f.a.db,f.peer,{project_id:"other",after_seq:0}),{code:"FORBIDDEN"});
 assert.throws(()=>acknowledge(f.a.db,f.peer,{project_id:"demo",seq:1,event_digest:"x"}),{code:"INVALID_ACK"});
 const batch=pull(f);assert.equal(batch.events.length,1);assert.equal(batch.events[0].seq,1);
 assert.equal(batch.events[0].project_id,"demo");
 assert.throws(()=>acknowledge(f.a.db,f.peer,{project_id:"demo",seq:1,event_digest:"x"}),{code:"INVALID_ACK"});
});
test("withdrawal hides a replica; resharing and parent visibility keep stable identity",()=>{
 const f=pair(),parent=store.add(f.a.db,{subject:"private parent",kind:"goal"}),child=task(f.a,{parentId:parent});
 accept(f,pull(f));assert.equal(listReplicas(f.b.db)[0].parent_uid,null);
 shareTask(f.a.db,{id:parent,projectId:"demo",expectedVersion:store.get(f.a.db,parent).aggregate_version});
 accept(f,pull(f,1));assert.equal(listReplicas(f.b.db).find(t=>t.task_uid===store.get(f.a.db,child).task_uid).parent_uid,store.get(f.a.db,parent).task_uid);
 shareTask(f.a.db,{id:parent,projectId:"demo",expectedVersion:store.get(f.a.db,parent).aggregate_version,enabled:false});
 const seq=cursor(f.b.db,f.source.origin,f.source.epoch,f.projectId);accept(f,pull(f,seq));
 assert.equal(listReplicas(f.b.db).length,1);assert.equal(listReplicas(f.b.db)[0].parent_uid,null);
 assert.throws(()=>shareTask(f.a.db,{id:child,projectId:"other",expectedVersion:store.get(f.a.db,child).aggregate_version}),{code:"PROJECT_CONFLICT"});
});
test("oversized projections stay pending and never commit a partial event",()=>{
 const f=pair();task(f.a,{description:"a".repeat(256*1024)});
 assert.throws(()=>pull(f),{code:"PROJECTION_TOO_LARGE"});
 assert.equal(count(f.a.db,"federation_outbox"),0);assert.equal(count(f.a.db,"federation_dirty"),1);
});
test("process exit before or after task commit preserves matching outbox state",()=>{
 const f=pair(),id=task(f.a);pull(f);
 const script="const store=require(process.argv[1]);const d=store.open();if(process.argv[3]==='rollback'){d.exec('BEGIN IMMEDIATE');d.prepare('UPDATE tasks SET description=? WHERE id=?').run('uncommitted',Number(process.argv[2]));}else store.update(d,{id:Number(process.argv[2]),description:'committed',expectedVersion:1});process.exit(0);";
 const run=mode=>spawnSync(process.execPath,["-e",script,join(ROOT,"core/store.js"),String(id),mode],
  {env:{...process.env,BOARD_DB:f.a.dbPath,BOARD_DATA_DIR:f.a.data},encoding:"utf8",windowsHide:true});
 assert.equal(run("rollback").status,0);assert.equal(store.get(f.a.db,id).description,"");assert.equal(count(f.a.db,"federation_dirty"),0);
 const committed=run("commit");assert.equal(committed.status,0,committed.stderr);assert.equal(count(f.a.db,"federation_dirty"),1);
 assert.equal(pull(f,1).events[0].payload.task.description,"committed");
});
test("actual HTTP synchronization applies only after validation and ACKs after commit",async()=>{
 const f=pair();for(let i=0;i<61;i++)task(f.a,{subject:"task "+i});
 await server(f,async url=>{
  const result=await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:f.projectId});
  assert.equal(result.state,"synced");assert.equal(result.applied,61);assert.equal(result.cursor,61);assert.equal(result.has_more,false);
  assert.equal(listReplicas(f.b.db).length,61);assert.equal(store.list(f.b.db).tasks.length,0);
  assert.equal(syncStatus(f.a.db).deliveries[0].acked_seq,61);
 });
});
test("lost ACK response retries from durable cursor without applying results twice",async()=>{
 const f=pair();task(f.a);
 await server(f,async url=>{
  let lost=false;
  const fetchImpl=async(input,init)=>{if(input.endsWith("/ack")&&!lost){lost=true;throw Error("injected ACK loss");}return fetch(input,init);};
  const first=await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:f.projectId,fetchImpl});
  assert.equal(first.state,"error");assert.equal(first.applied,1);assert.equal(syncStatus(f.a.db).deliveries[0].acked_seq,0);
  const second=await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:f.projectId,now:first.retry_after+1});
  assert.equal(second.state,"synced");assert.equal(second.applied,0);assert.equal(count(f.b.db,"federation_inbox"),1);
  assert.equal(syncStatus(f.a.db).deliveries[0].acked_seq,1);
 });
});
test("local execution continues during tunnel outage, then reconnect publishes the result",async()=>{
 const f=pair(),id=task(f.a);
 const s=await listenPeerServer(f.a.db,{port:0}),port=s.address().port,url="http://127.0.0.1:"+port;
 await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:f.projectId});
 await new Promise(r=>{s.close(r);s.closeAllConnections();});
 const run=store.claimById(f.a.db,{id,worker:"offline-local"}).task;
 store.report(f.a.db,{id,worker:"offline-local",runId:run.run_id,outcome:"done",evidence:"offline result"});
 const offline=await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:f.projectId});
 assert.equal(offline.state,"error");assert.equal(store.get(f.a.db,id).status,"waiting");assert.equal(listReplicas(f.b.db)[0].status,"not_started");
 const resumed=await listenPeerServer(f.a.db,{port});
 try{
  const result=await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:f.projectId,now:offline.retry_after+1});
  assert.equal(result.state,"synced");assert.equal(listReplicas(f.b.db)[0].result,"offline result");
  assert.equal(listReplicas(f.b.db)[0].run_id,run.run_id);assert.equal(store.list(f.b.db).tasks.length,0);
 }finally{await new Promise(r=>{resumed.close(r);resumed.closeAllConnections();});}
});
test("endpoint policy and credential binding reject before leaking credentials",async()=>{
 for(const url of ["http://100.64.0.1","https://example.com","http://user:pass@127.0.0.1","http://127.0.0.1/path","http://127.0.0.1?token=x"])
  assert.throws(()=>endpoint(url),{code:"BAD_ENDPOINT"});
 const f=pair();let called=false;
 await assert.rejects(syncOnce(f.a.db,{url:"http://127.0.0.1",credentialFile:f.credentialFile,projectId:"demo",fetchImpl:async()=>{called=true;}}),{code:"IDENTITY_MISMATCH"});
 assert.equal(called,false);
});
test("network retries are persisted, bounded and honor backoff across attempts",async()=>{
 const f=pair();let calls=0,now=Date.now(),result;
 for(let i=0;i<8;i++){
  result=await syncOnce(f.b.db,{url:fixtureEndpoint(f.a.db),credentialFile:f.credentialFile,projectId:"demo",now,fetchImpl:async()=>{calls++;throw Error("offline");}});
  assert.equal(result.state,"error");assert.ok(result.retry_after-now<=30500);now=result.retry_after+1;
 }
 const before=calls;
 const backed=await syncOnce(f.b.db,{url:fixtureEndpoint(f.a.db),credentialFile:f.credentialFile,projectId:"demo",now:result.retry_after-1,fetchImpl:async()=>{calls++;}});
 assert.equal(backed.state,"backoff");assert.equal(calls,before);
});
test("the sync CLI performs an actual pull and never copies tasks into the execution queue",async()=>{
 const f=pair();task(f.a);
 await server(f,async url=>{
  const p=spawn(process.execPath,[join(ROOT,"cli/sync.mjs"),"pull","--db",f.b.dbPath,"--url",url,"--credential-file",f.credentialFile,"--project","demo"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="",err="";p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>err+=b);
  const code=await new Promise((resolve,reject)=>{p.on("error",reject);p.on("close",resolve);});
  assert.equal(code,0,err);assert.equal(JSON.parse(out).state,"synced");assert.ok(!out.includes(f.credential.token));
  assert.equal(listReplicas(f.b.db).length,1);assert.equal(store.list(f.b.db).tasks.length,0);
 });
});

test("out-of-order batches and changed epochs never reset a durable cursor",()=>{
 const f=pair(),id=task(f.a),first=pull(f);
 store.update(f.a.db,{id,description:"second",expectedVersion:1});const second=pull(f,1);
 const reordered={...second,after_seq:0,events:[second.events[0],first.events[0]]};
 assert.throws(()=>accept(f,reordered),{code:"SEQUENCE_GAP"});assert.equal(count(f.b.db,"federation_inbox"),0);
 accept(f,first);
 const changed=structuredClone(second),epoch=randomUUID();changed.origin_epoch=epoch;changed.events[0].origin_epoch=epoch;reseal(changed.events[0]);changed.checkpoint.event_digest=changed.events[0].event_digest;
 assert.throws(()=>applyBatch(f.b.db,{...f.source,epoch},changed),{code:"EPOCH_CHANGED"});
 assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,f.projectId),1);
});
test("HTTP project and message scope reject unauthorized export and invented events",async()=>{
 const f=pair();task(f.a,{},"other");
 await server(f,async url=>{
  const post=async(path,body)=>fetch(url+path,{method:"POST",headers:{Authorization:"Bearer "+f.credential.token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await post("/peer/v1/pull",{project_id:"other",after_seq:0})).status,403);
  assert.equal((await post("/peer/v1/pull",{project_id:"demo",after_seq:0,events:[{kind:"task.snapshot"}]})).status,400);
  assert.equal((await post("/peer/v1/ack",{project_id:"demo",seq:1,event_digest:"x"})).status,409);
  assert.equal(count(f.a.db,"federation_outbox"),0);
 });
});
test("watch CLI observes subsequent source changes and exits when stopped",async()=>{
 const f=pair(),id=task(f.a);
 await server(f,async url=>{
  const p=spawn(process.execPath,[join(ROOT,"cli/sync.mjs"),"watch","--db",f.b.dbPath,"--url",url,"--credential-file",f.credentialFile,"--project","demo"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="",err="",changed=false,timer;
  const done=new Promise(resolve=>p.once("close",resolve));
  try{
   await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error("watch timed out: "+err+" "+out)),12000);
    p.stderr.on("data",b=>err+=b);p.on("error",reject);p.once("exit",code=>reject(Error("watch exit "+code+" "+err)));
    p.stdout.on("data",b=>{out+=b;
     for(const line of out.trim().split(/\r?\n/)){let r;try{r=JSON.parse(line);}catch{continue;}
      if(r.state==="synced"&&r.cursor===1&&!changed){changed=true;store.update(f.a.db,{id,description:"watched change",expectedVersion:1});}
      if(r.state==="synced"&&r.cursor===2)resolve();
     }
    });
   });
   assert.equal(listReplicas(f.b.db)[0].description,"watched change");assert.ok(!out.includes(f.credential.token));
  }finally{clearTimeout(timer);if(p.exitCode===null)p.kill();await done;}
 });
});

test("authenticated terminal rename updates replica ownership labels without changing IDs",async()=>{
 const f=pair();task(f.a);
 await server(f,async url=>{
  const options={url,credentialFile:f.credentialFile,projectId:"demo"};
  await syncOnce(f.b.db,options);const first=listReplicas(f.b.db)[0];
  store.renameNode(f.a.db,"renamed terminal");
  const result=await syncOnce(f.b.db,options),second=listReplicas(f.b.db)[0];
  assert.equal(result.applied,0);assert.equal(second.task_uid,first.task_uid);
  assert.equal(second.owner_name,"renamed terminal");assert.equal(second.owner_node_id,f.a.identity.node_id);
  assert.ok(second.last_sync_at);assert.equal(syncStatus(f.b.db).attempts[0].failure_count,0);
 });
});

test("bounded pulls persist a pending state until every batch has been received",async()=>{
 const f=pair();for(let i=0;i<30;i++)task(f.a,{subject:"task "+i});
 await server(f,async url=>{
  const options={url,credentialFile:f.credentialFile,projectId:"demo",maxBatches:1};
  const first=await syncOnce(f.b.db,options);
  assert.equal(first.state,"pending");assert.equal(first.applied,25);assert.equal(first.has_more,true);
  assert.equal(syncStatus(f.b.db).attempts[0].has_more,1);
  const second=await syncOnce(f.b.db,options);
  assert.equal(second.state,"synced");assert.equal(second.applied,5);assert.equal(second.has_more,false);
  assert.equal(syncStatus(f.b.db).attempts[0].has_more,0);
 });
});
test("remote stream rollback cannot report a completed synchronization",()=>{
 const f=pair();task(f.a);accept(f,pull(f));const batch=pull(f,1);batch.head_seq=0;
 assert.throws(()=>accept(f,batch),{code:"CURSOR_AHEAD"});
 assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,f.projectId),1);
});
test("an unsupported SQLite runtime fails before installing synchronization tables",()=>{
 assert.throws(()=>migrateSync({}),{code:"RUNTIME_INCOMPATIBLE"});
});

test("two local HTTP nodes converge to the authorized projection hashes in both directions",async()=>{
 const f=pair(),aId=task(f.a,{subject:"owned by A"}),bId=task(f.b,{subject:"owned by B"});
 const reverseFile=target("reverse-credential")+".json";
 issueCredential(f.b.db,{peerNodeId:f.a.identity.node_id,peerEpoch:f.a.identity.sync_epoch,scopes:["peer:handshake","sync:pull","sync:ack"],projects:["demo"],credentialFile:reverseFile});
 await server(f,async aUrl=>server({a:f.b},async bUrl=>{
  const exchange=async()=>{
   assert.equal((await syncOnce(f.b.db,{url:aUrl,credentialFile:f.credentialFile,projectId:"demo"})).state,"synced");
   assert.equal((await syncOnce(f.a.db,{url:bUrl,credentialFile:reverseFile,projectId:"demo"})).state,"synced");
  };
  await exchange();
  store.update(f.a.db,{id:aId,description:"A changed offline",expectedVersion:1});
  store.update(f.b.db,{id:bId,description:"B changed offline",expectedVersion:1});
  await exchange();
  for(const [source,receiver] of [[f.a,f.b],[f.b,f.a]]){
   const event=JSON.parse(source.db.prepare("SELECT event_json FROM federation_outbox ORDER BY seq DESC LIMIT 1").get().event_json);
   const replica=listReplicas(receiver.db)[0],projected={};
   for(const key of Object.keys(event.payload.task))projected[key]=replica[key];
   assert.equal(digest(projected),digest(event.payload.task));
   assert.equal(replica.owner_node_id,source.identity.node_id);
   assert.equal(store.list(receiver.db).tasks.length,1);
   assert.equal(count(receiver.db,"federation_inbox"),2);
  }
 }));
});

test("three nodes isolate event UUIDs by source and preserve same-source conflict checks",()=>{
 const f=pair(),c=node(),id=task(f.a);task(c);
 const credentialFile=target("third-source")+".json";
 issueCredential(c.db,{peerNodeId:f.b.identity.node_id,peerEpoch:f.b.identity.sync_epoch,scopes:["peer:handshake","sync:pull","sync:ack"],projects:["demo"],credentialFile});
 const peer=authenticate(c.db,"Bearer "+JSON.parse(readFileSync(credentialFile,"utf8")).token);
 const g={a:c,b:f.b,peer,projectId:"demo",source:{origin:c.identity.node_id,epoch:c.identity.sync_epoch,projectId:"demo"}};
 const one=pull(f),other=pull(g);one.events[0].event_id=other.events[0].event_id;reseal(one.events[0]);one.checkpoint.event_digest=one.events[0].event_digest;
 assert.equal(accept(f,one).applied,1);assert.equal(accept(g,other).applied,1);
 assert.equal(accept(f,one).applied,0);assert.equal(accept(g,other).applied,0);
 assert.equal(listReplicas(f.b.db).length,2);assert.equal(count(f.b.db,"federation_inbox"),2);
 store.update(f.a.db,{id,description:"changed",expectedVersion:1});
 const changed=pull(f,1);changed.events[0].event_id=one.events[0].event_id;reseal(changed.events[0]);changed.checkpoint.event_digest=changed.events[0].event_digest;
 assert.throws(()=>accept(f,changed),{code:"CONTENT_MISMATCH"});
 assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,"demo"),1);
});

test("inbox v3 upgrade preserves receipts and rolls back atomically on failure",()=>{
 const f=pair();task(f.a);accept(f,pull(f));const db=f.b.db;
 db.exec("ALTER TABLE federation_inbox RENAME TO fixture_inbox; CREATE TABLE federation_inbox(event_id TEXT PRIMARY KEY,origin_node_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,project_id TEXT NOT NULL,seq INTEGER NOT NULL,event_digest TEXT NOT NULL,UNIQUE(origin_node_id,origin_epoch,project_id,seq)); INSERT INTO federation_inbox SELECT * FROM fixture_inbox; DROP TABLE fixture_inbox; UPDATE federation_sync_schema SET version=3");
 const before=db.prepare("SELECT * FROM federation_inbox").all();
 db.exec("CREATE TRIGGER fail_inbox_migration BEFORE UPDATE ON federation_sync_schema BEGIN SELECT RAISE(ABORT,'inbox upgrade failure'); END");
 assert.throws(()=>migrateSync(db),/inbox upgrade failure/);
 assert.equal(db.prepare("SELECT version FROM federation_sync_schema").get().version,3);
 assert.equal(db.prepare("PRAGMA table_info(federation_inbox)").all().find(c=>c.name==="origin_node_id").pk,0);
 assert.deepEqual(db.prepare("SELECT * FROM federation_inbox").all(),before);
 db.exec("DROP TRIGGER fail_inbox_migration");migrateSync(db);migrateSync(db);
 assert.equal(db.prepare("SELECT version FROM federation_sync_schema").get().version,5);
 assert.deepEqual(db.prepare("SELECT * FROM federation_inbox").all(),before);
 assert.equal(accept(f,pull(f)).applied,0);
});

test("canonical JSON bounds nesting while preserving the existing byte contract",()=>{
 assert.equal(canonical({z:[1,{b:true,a:null}],a:"plain"}),'{"a":"plain","z":[1,{"a":null,"b":true}]}');
 let nested="end";for(let i=0;i<64;i++)nested={child:nested};assert.ok(canonical(nested));
 nested={child:nested};assert.throws(()=>canonical(nested),{code:"BAD_INPUT",status:400});
 const f=pair();task(f.a);const batch=pull(f);batch.events[0].payload=nested;
 assert.throws(()=>accept(f,batch),{code:"BAD_INPUT",status:400});assert.equal(count(f.b.db,"federation_inbox"),0);
});
