import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {migratePeers,issueCredential,authenticate,revokePeer,localIdentity} from "../core/federation/peers.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
import {migrateSync,shareTask,exportBatch,applyBatch,listReplicas,syncStatus,cursor,digest,canonical,acknowledge} from "../core/federation/sync-store.mjs";
import {startSnapshot,snapshotPage,beginSnapshot,receiveSnapshotPage,snapshotStage,pruneHistory,SNAPSHOT_TTL_MS,MAX_SNAPSHOT_RECORDS} from "../core/federation/snapshots.mjs";
import {syncOnce} from "../core/federation/sync-client.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-snapshot-")),handles=[];
let seq=0;const path=name=>join(TMP,name+"-"+seq++);
after(()=>{for(const db of handles){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function node(){
 const data=path("node");mkdirSync(data);const dbPath=join(data,"board.db"),db=new DatabaseSync(dbPath);handles.push(db);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);
 return {db,dbPath,identity:localIdentity(db)};
}
function pair(){
 const a=node(),b=node(),credentialFile=path("credential")+".json";
 issueCredential(a.db,{peerNodeId:b.identity.node_id,peerEpoch:b.identity.sync_epoch,scopes:["peer:handshake","sync:pull","sync:ack"],projects:["demo"],credentialFile});
 const credential=JSON.parse(readFileSync(credentialFile,"utf8")),peer=authenticate(a.db,"Bearer "+credential.token);
 return {a,b,credentialFile,credential,peer,source:{origin:a.identity.node_id,epoch:a.identity.sync_epoch,projectId:"demo"}};
}
function task(a,description=""){
 const id=store.add(a.db,{subject:"snapshot task",description});shareTask(a.db,{id,projectId:"demo",expectedVersion:1});return id;
}
function flush(f){
 let after=0,batch;
 do{batch=exportBatch(f.a.db,f.peer,{project_id:"demo",after_seq:after});after=batch.events.at(-1)?.seq??after;}
 while(after<batch.head_seq||batch.pending_count);
 return batch.head_seq;
}
const start=f=>startSnapshot(f.a.db,f.peer,{project_id:"demo"});
const page=(f,m,offset=0)=>snapshotPage(f.a.db,f.peer,{project_id:"demo",snapshot_id:m.snapshot_id,offset});
function install(f,m=start(f)){
 beginSnapshot(f.b.db,f.source,m);let result,offset=0;
 do{const p=page(f,m,offset);result=receiveSnapshotPage(f.b.db,f.source,p);offset=p.next_offset;}while(!result.installed);
 return result;
}
async function server(f,work){
 const s=await listenPeerServer(f.a.db,{port:0}),url="http://127.0.0.1:"+s.address().port;
 try{return await work(url);}finally{await new Promise(r=>{s.close(r);s.closeAllConnections();});}
}
function change(f,id,text){store.update(f.a.db,{id,description:text,expectedVersion:store.get(f.a.db,id).aggregate_version});}
const count=(db,table)=>db.prepare("SELECT count(*) AS n FROM "+table).get().n;
function sealPage(p){const {page_digest,...rest}=p;p.page_digest=digest(rest);}

test("v1 migration rebuilds published state from the latest immutable event and is idempotent",()=>{
 const f=pair(),id=task(f.a);flush(f);change(f,id,"newer");flush(f);
 f.a.db.exec("DROP TABLE federation_published; UPDATE federation_sync_schema SET version=1");
 migrateSync(f.a.db);migrateSync(f.a.db);
 assert.equal(count(f.a.db,"federation_published"),1);assert.equal(start(f).head_seq,2);
 assert.equal(f.a.db.prepare("SELECT version FROM federation_sync_schema").get().version,3);
 assert.equal(install(f).records,1);assert.equal(listReplicas(f.b.db)[0].description,"newer");
});

test("migration failure rolls back new tables and keeps the old schema version",()=>{
 const f=pair();f.a.db.exec("DROP TABLE federation_published; UPDATE federation_sync_schema SET version=1; CREATE TRIGGER reject_migration BEFORE UPDATE ON federation_sync_schema BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>migrateSync(f.a.db),/injected/);
 assert.equal(f.a.db.prepare("SELECT version FROM federation_sync_schema").get().version,1);
 assert.equal(f.a.db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_published'").get(),undefined);
});

test("a frozen snapshot plus later deltas converges while the source keeps writing",()=>{
 const f=pair(),ids=Array.from({length:61},()=>task(f.a));flush(f);
 const m=start(f);beginSnapshot(f.b.db,f.source,m);
 receiveSnapshotPage(f.b.db,f.source,page(f,m));
 assert.equal(listReplicas(f.b.db).length,0);assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,"demo"),0);
 change(f,ids[0],"changed during snapshot");
 let offset=25,result;do{const p=page(f,m,offset);result=receiveSnapshotPage(f.b.db,f.source,p);offset=p.next_offset;}while(!result.installed);
 assert.equal(result.records,61);assert.equal(listReplicas(f.b.db).find(t=>t.task_uid===store.get(f.a.db,ids[0]).task_uid).description,"");
 const delta=exportBatch(f.a.db,f.peer,{project_id:"demo",after_seq:m.head_seq});
 applyBatch(f.b.db,f.source,delta);
 assert.equal(listReplicas(f.b.db).find(t=>t.task_uid===store.get(f.a.db,ids[0]).task_uid).description,"changed during snapshot");
 assert.equal(store.claim(f.b.db,{worker:"replicas-cannot-run"}),null);
});

test("duplicate pages are idempotent and out-of-order or tampered pages preserve visible state",()=>{
 const f=pair();for(let i=0;i<30;i++)task(f.a);flush(f);const m=start(f);
 beginSnapshot(f.b.db,f.source,m);
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,page(f,m,25)),{code:"SEQUENCE_GAP"});
 const first=page(f,m);receiveSnapshotPage(f.b.db,f.source,first);
 assert.equal(receiveSnapshotPage(f.b.db,f.source,first).duplicate,true);
 const altered=structuredClone(first);altered.events[0].payload.task.subject="tampered";sealPage(altered);
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,altered),{code:"CONTENT_MISMATCH"});
 assert.equal(snapshotStage(f.b.db,f.source).next_offset,25);assert.equal(listReplicas(f.b.db).length,0);
 assert.equal(receiveSnapshotPage(f.b.db,f.source,page(f,m,25)).installed,true);
});

test("a final digest mismatch and an installation crash leave old replicas and cursor intact",()=>{
 const f=pair(),id=task(f.a);flush(f);install(f);change(f,id,"replacement");flush(f);
 const m=startSnapshot(f.a.db,f.peer,{project_id:"demo",min_seq:2});
 beginSnapshot(f.b.db,f.source,{...m,content_digest:"0".repeat(64)});
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,page(f,m)),{code:"CONTENT_MISMATCH"});
 assert.equal(listReplicas(f.b.db)[0].description,"");assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,"demo"),1);
 // A new snapshot id starts a new isolated staging set.
 const fresh=startSnapshot(f.a.db,f.peer,{project_id:"demo",min_seq:2},{now:Date.now()+SNAPSHOT_TTL_MS+1});
 beginSnapshot(f.b.db,f.source,fresh);
 f.b.db.exec("CREATE TRIGGER fail_snapshot_install BEFORE INSERT ON federation_snapshot_anchors BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,page(f,fresh)),/injected/);
 assert.equal(listReplicas(f.b.db)[0].description,"");assert.equal(snapshotStage(f.b.db,f.source).next_offset,0);
 f.b.db.exec("DROP TRIGGER fail_snapshot_install");
 assert.equal(receiveSnapshotPage(f.b.db,f.source,page(f,fresh)).installed,true);
 assert.equal(listReplicas(f.b.db)[0].description,"replacement");
});

test("staging survives a real child process exit after the first page commits",()=>{
 const f=pair();for(let i=0;i<30;i++)task(f.a);flush(f);const m=start(f);beginSnapshot(f.b.db,f.source,m);
 const input=path("page")+".json";writeFileSync(input,JSON.stringify({source:f.source,page:page(f,m)}));
 const moduleUrl=new URL("../core/federation/snapshots.mjs",import.meta.url).href;
 const code='import {DatabaseSync} from "node:sqlite";import {readFileSync} from "node:fs";import {receiveSnapshotPage} from '+JSON.stringify(moduleUrl)+';const d=new DatabaseSync(process.argv[1]);const x=JSON.parse(readFileSync(process.argv[2],"utf8"));receiveSnapshotPage(d,x.source,x.page);process.exit(0);';
 const child=spawnSync(process.execPath,["--input-type=module","-e",code,f.b.dbPath,input],{windowsHide:true,encoding:"utf8"});
 assert.equal(child.status,0,child.stderr);assert.equal(snapshotStage(f.b.db,f.source).next_offset,25);assert.equal(listReplicas(f.b.db).length,0);
 assert.equal(receiveSnapshotPage(f.b.db,f.source,page(f,m,25)).records,30);
});

test("snapshot pages obey byte limits and include withdrawal revisions",()=>{
 const f=pair(),ids=Array.from({length:6},()=>task(f.a,"界".repeat(70000)));flush(f);
 shareTask(f.a.db,{id:ids[0],projectId:"demo",expectedVersion:1,enabled:false});flush(f);
 const m=start(f),first=page(f,m);
 assert.ok(Buffer.byteLength(JSON.stringify(first))<=1024*1024);assert.ok(first.events.length<6);
 install(f,m);assert.equal(listReplicas(f.b.db).length,5);
 const hidden=f.b.db.prepare("SELECT * FROM federation_replicas WHERE task_uid=?").get(store.get(f.a.db,ids[0]).task_uid);
 assert.equal(hidden.withdrawn,1);assert.equal(hidden.projection_version,2);
});

test("snapshot record caps fail before publishing a usable manifest",()=>{
 const f=pair();task(f.a);flush(f);
 const row=f.a.db.prepare("SELECT * FROM federation_published").get(),put=f.a.db.prepare("INSERT INTO federation_published VALUES(?,?,?,?)");
 f.a.db.exec("BEGIN IMMEDIATE");
 for(let i=1;i<=MAX_SNAPSHOT_RECORDS;i++)put.run("demo","extra-"+i,1,row.event_json);
 f.a.db.exec("COMMIT");
 assert.throws(()=>start(f),{code:"SNAPSHOT_TOO_LARGE"});assert.equal(count(f.a.db,"federation_snapshots"),0);
});

test("snapshot ownership, project, epoch and cursor rollback are rejected",()=>{
 const f=pair();task(f.a);flush(f);const m=start(f);install(f,m);
 assert.throws(()=>beginSnapshot(f.b.db,f.source,{...m,project_id:"other"}),{code:"SOURCE_MISMATCH"});
 assert.throws(()=>beginSnapshot(f.b.db,{...f.source,epoch:randomUUID()},m),{code:"SOURCE_MISMATCH"});
 const epoch=randomUUID();
 assert.throws(()=>beginSnapshot(f.b.db,{...f.source,epoch},{...m,origin_epoch:epoch}),{code:"EPOCH_CHANGED"});
 assert.throws(()=>beginSnapshot(f.b.db,f.source,{...m,head_seq:0,checkpoint:null,record_count:0}),{code:"VERSION_REGRESSION"});
 assert.throws(()=>startSnapshot(f.a.db,f.peer,{project_id:"other"}),{code:"FORBIDDEN"});
 assert.throws(()=>snapshotPage(f.a.db,{...f.peer,peer_node_id:randomUUID()},{project_id:"demo",snapshot_id:m.snapshot_id,offset:0}),{code:"SNAPSHOT_EXPIRED"});
});

test("an advancing incremental cursor prevents installing an older downloaded snapshot",()=>{
 const f=pair(),id=task(f.a);flush(f);const m=start(f);beginSnapshot(f.b.db,f.source,m);
 change(f,id,"new");flush(f);const batch=exportBatch(f.a.db,f.peer,{project_id:"demo",after_seq:0});applyBatch(f.b.db,f.source,batch);
 assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,page(f,m)),{code:"VERSION_REGRESSION"});
 assert.equal(listReplicas(f.b.db)[0].description,"new");assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,"demo"),2);
});

test("retention is explicit, versioned, guarded by ACKs and backed by a reusable snapshot",()=>{
 const f=pair(),id=task(f.a);flush(f);for(let i=0;i<5;i++){change(f,id,"revision "+i);flush(f);}
 assert.throws(()=>f.a.db.exec("DELETE FROM federation_outbox"),/retention/);
 assert.throws(()=>pruneHistory(f.a.db,{projectId:"demo",throughSeq:4,expectedHead:5}),{code:"CONFLICT"});
 assert.throws(()=>pruneHistory(f.a.db,{projectId:"demo",throughSeq:4,expectedHead:6}),{code:"UNACKNOWLEDGED"});
 const result=pruneHistory(f.a.db,{projectId:"demo",throughSeq:4,expectedHead:6,allowLagging:true});
 assert.equal(result.deleted_count,3);assert.equal(count(f.a.db,"federation_outbox"),3);
 assert.throws(()=>exportBatch(f.a.db,f.peer,{project_id:"demo",after_seq:0}),{code:"SNAPSHOT_REQUIRED"});
 const m=start(f);assert.ok(m.head_seq>=4);install(f,m);
 acknowledge(f.a.db,f.peer,{project_id:"demo",...m.checkpoint});
 const empty=exportBatch(f.a.db,f.peer,{project_id:"demo",after_seq:m.head_seq});
 assert.equal(applyBatch(f.b.db,f.source,empty).cursor,6);
 assert.equal(listReplicas(f.b.db)[0].description,"revision 4");assert.equal(store.list(f.b.db).tasks.length,0);
 assert.throws(()=>f.a.db.exec("DELETE FROM federation_outbox"),/retention/);
});

test("retention failure rolls back deletion, floor, snapshot and the deletion guard",()=>{
 const f=pair(),id=task(f.a);flush(f);change(f,id,"next");flush(f);
 f.a.db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON federation_retention_events BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>pruneHistory(f.a.db,{projectId:"demo",throughSeq:2,expectedHead:2,allowLagging:true}),/injected/);
 assert.equal(count(f.a.db,"federation_outbox"),2);assert.equal(count(f.a.db,"federation_retention"),0);
 assert.equal(count(f.a.db,"federation_snapshots"),0);assert.throws(()=>f.a.db.exec("DELETE FROM federation_outbox"),/retention/);
});

test("HTTP clients join by snapshot and resume a persisted partial download without exposing half a board",async()=>{
 const f=pair();for(let i=0;i<61;i++)task(f.a);flush(f);
 await server(f,async url=>{
  const options={url,credentialFile:f.credentialFile,projectId:"demo",maxBatches:1};
  const first=await syncOnce(f.b.db,options);assert.equal(first.state,"pending");assert.equal(first.snapshot_pages,1);assert.equal(listReplicas(f.b.db).length,0);
  const second=await syncOnce(f.b.db,options);assert.equal(second.state,"pending");assert.equal(snapshotStage(f.b.db,f.source).next_offset,50);
  const third=await syncOnce(f.b.db,options);assert.equal(third.state,"synced");assert.equal(third.rebuilt,61);assert.equal(listReplicas(f.b.db).length,61);
  assert.equal(third.applied,0);assert.equal(store.list(f.b.db).tasks.length,0);
 });
});

test("HTTP clients rebuild after history compaction and recover an ACK lost after snapshot installation",async()=>{
 const f=pair(),id=task(f.a);flush(f);
 await server(f,async url=>{
  const opts={url,credentialFile:f.credentialFile,projectId:"demo"};
  await syncOnce(f.b.db,opts);
  for(let i=0;i<5;i++){change(f,id,"after compaction "+i);flush(f);}
  pruneHistory(f.a.db,{projectId:"demo",throughSeq:5,expectedHead:6,allowLagging:true});
  let dropped=false;
  const result=await syncOnce(f.b.db,{...opts,fetchImpl:async(...args)=>{
   const r=await fetch(...args);if(args[0].endsWith("/ack")&&!dropped){dropped=true;await r.arrayBuffer();throw Error("ACK response lost");}return r;
  }});
  assert.equal(result.state,"error");assert.equal(result.rebuilt,1);assert.equal(listReplicas(f.b.db)[0].description,"after compaction 4");
  const retry=await syncOnce(f.b.db,{...opts,now:result.retry_after+1});
  assert.equal(retry.state,"synced");assert.equal(retry.rebuilt,0);assert.equal(retry.applied,0);
  assert.equal(syncStatus(f.a.db).deliveries[0].acked_seq,6);
 });
});

test("expired snapshots are refused and old peers without the capability continue using increments",async()=>{
 const f=pair();task(f.a);flush(f);const m=start(f);
 assert.throws(()=>snapshotPage(f.a.db,f.peer,{project_id:"demo",snapshot_id:m.snapshot_id,offset:0},{now:Date.now()+SNAPSHOT_TTL_MS+1}),{code:"SNAPSHOT_EXPIRED"});
 await server(f,async url=>{
  let snapshotCalls=0;
  const result=await syncOnce(f.b.db,{url,credentialFile:f.credentialFile,projectId:"demo",fetchImpl:async(...args)=>{
   if(args[0].includes("/snapshot/"))snapshotCalls++;
   const r=await fetch(...args);if(args[0].endsWith("/hello")){const hello=await r.json();hello.capabilities=hello.capabilities.filter(x=>x!=="task-snapshot-v1");return new Response(JSON.stringify(hello));}return r;
  }});
  assert.equal(result.state,"synced");assert.equal(result.applied,1);assert.equal(snapshotCalls,0);
 });
});

test("HTTP snapshot pages recheck credentials and project scope before exposing data",async()=>{
 const f=pair();task(f.a);flush(f);
 await server(f,async url=>{
  const post=(path,body)=>fetch(url+path,{method:"POST",headers:{Authorization:"Bearer "+f.credential.token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await post("/peer/v1/snapshot/start",{project_id:"other"})).status,403);
  const m=await (await post("/peer/v1/snapshot/start",{project_id:"demo"})).json();
  assert.equal((await post("/peer/v1/snapshot/page",{project_id:"other",snapshot_id:m.snapshot_id,offset:0})).status,403);
  revokePeer(f.a.db,{peerNodeId:f.b.identity.node_id,expectedVersion:1});
  assert.equal((await post("/peer/v1/snapshot/page",{project_id:"demo",snapshot_id:m.snapshot_id,offset:0})).status,401);
  assert.equal(listReplicas(f.b.db).length,0);
 });
});

test("an expired partial HTTP download restarts without discarding the prior visible board",async()=>{
 const f=pair();for(let i=0;i<30;i++)task(f.a);flush(f);
 await server(f,async url=>{
  const opts={url,credentialFile:f.credentialFile,projectId:"demo",maxBatches:1};
  assert.equal((await syncOnce(f.b.db,opts)).state,"pending");
  const previousId=snapshotStage(f.b.db,f.source).manifest.snapshot_id;
  f.a.db.prepare("UPDATE federation_snapshots SET expires_at=0 WHERE snapshot_id=?").run(previousId);
  const failed=await syncOnce(f.b.db,opts);
  assert.equal(failed.error_code,"SNAPSHOT_EXPIRED");assert.equal(snapshotStage(f.b.db,f.source),null);
  assert.equal(listReplicas(f.b.db).length,0);assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,"demo"),0);
  const resumed=await syncOnce(f.b.db,{...opts,maxBatches:10,now:failed.retry_after+1});
  assert.equal(resumed.state,"synced");assert.equal(resumed.rebuilt,30);
 });
});

test("duplicate event identities and a forged final checkpoint cannot pass full snapshot validation",()=>{
 for(const mode of ["duplicate-id","duplicate-seq","boundary"]){
  const f=pair();task(f.a);task(f.a);flush(f);const m=start(f),p=page(f,m);
  if(mode==="boundary")m.checkpoint.event_digest="0".repeat(64);
  else{
   const e=p.events[1];e[mode==="duplicate-id"?"event_id":"seq"]=p.events[0][mode==="duplicate-id"?"event_id":"seq"];
   const {event_digest,...unsigned}=e;e.event_digest=digest(unsigned);m.content_digest=digest(p.events);sealPage(p);
  }
  beginSnapshot(f.b.db,f.source,m);
  assert.throws(()=>receiveSnapshotPage(f.b.db,f.source,p),{code:"CONTENT_MISMATCH"});
  assert.equal(listReplicas(f.b.db).length,0);assert.equal(count(f.b.db,"federation_quarantine"),1);
 }
});

test("the local prune CLI requires explicit boundaries and leaves an auditable recovery snapshot",()=>{
 const f=pair(),id=task(f.a);flush(f);change(f,id,"second");flush(f);
 assert.equal(syncStatus(f.a.db).streams[0].head_seq,2);
 const args=[join(ROOT,"cli/sync.mjs"),"prune","--db",f.a.dbPath,"--project","demo","--through-seq","2","--expected-head","2"];
 const denied=spawnSync(process.execPath,args,{windowsHide:true,encoding:"utf8"});
 assert.equal(denied.status,1);assert.match(denied.stderr,/UNACKNOWLEDGED/);
 const ok=spawnSync(process.execPath,[...args,"--allow-lagging","true"],{windowsHide:true,encoding:"utf8"});
 assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).deleted_count,1);
 assert.equal(count(f.a.db,"federation_retention_events"),1);assert.equal(install(f).records,1);
});

test("a second writer advancing the receive cursor during download discards the obsolete staging set",async()=>{
 const f=pair(),ids=Array.from({length:30},()=>task(f.a));flush(f);
 await server(f,async url=>{
  const opts={url,credentialFile:f.credentialFile,projectId:"demo",maxBatches:1};
  assert.equal((await syncOnce(f.b.db,opts)).state,"pending");
  let advanced=false;
  const result=await syncOnce(f.b.db,{...opts,fetchImpl:async(...args)=>{
   const r=await fetch(...args);
   if(args[0].endsWith("/snapshot/page")&&!advanced){
    advanced=true;change(f,ids[0],"already received newer");flush(f);
    let after=0;while(after<31){
     const b=exportBatch(f.a.db,f.peer,{project_id:"demo",after_seq:after});
     after=applyBatch(f.b.db,f.source,b).cursor;
    }
   }
   return r;
  }});
  assert.equal(result.state,"synced");assert.equal(result.rebuilt,0);assert.equal(result.cursor,31);
  assert.equal(snapshotStage(f.b.db,f.source),null);assert.equal(listReplicas(f.b.db).length,30);
  assert.equal(listReplicas(f.b.db).find(t=>t.task_uid===store.get(f.a.db,ids[0]).task_uid).description,"already received newer");
 });
});
