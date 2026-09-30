import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createBackup,restoreBackup,inspectRestore,verifyBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode,recoveryStatus,recoveryFingerprint,writeRecoveryJSON} from "../core/recovery.mjs";
import {migratePeers,issueCredential,authenticate,localIdentity} from "../core/federation/peers.mjs";
import {migrateSync,shareTask,exportBatch,digest} from "../core/federation/sync-store.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-recovery-")),handles=[];
let sequence=0;const path=name=>join(TMP,name+"-"+sequence++);
after(()=>{for(const db of handles){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function source(){
 const dir=path("source");mkdirSync(dir);const evidence=join(dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"result.txt"),"durable evidence\n");
 const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);handles.push(db);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);
 const node=localIdentity(db),id=store.add(db,{subject:"recovery task",evidencePath:join(evidence,"result.txt")});
 shareTask(db,{id,projectId:"demo",expectedVersion:1});
 const run=store.claimById(db,{id,worker:"old-worker"}).task;
 const credentialFile=path("peer")+".json";
 issueCredential(db,{peerNodeId:randomUUID(),peerEpoch:randomUUID(),scopes:["peer:handshake","sync:pull","sync:ack"],projects:["demo"],credentialFile});
 const credential=JSON.parse(readFileSync(credentialFile,"utf8")),peer=authenticate(db,"Bearer "+credential.token);
 exportBatch(db,peer,{project_id:"demo",after_seq:0});
 return {dir,dbPath,evidence,db,node,id,run,credentialFile,credential,peer};
}
function restored(f=source()){
 const b=createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:path("backup")}),dir=path("restore");
 restoreBackup({backupDirectory:b.destination,destination:dir});
 return {f,backup:b,dir,dbPath:join(dir,"board.db")};
}
function proof(plan){
 return {format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,
 original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,
 evidence_ref:"isolated test fixture only; not a real device attestation",attested_at:new Date().toISOString()};
}
function activate(r,plan=prepareRecovery({dbPath:r.dbPath})){
 return activateRecovery({dbPath:r.dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:proof(plan)});
}
const open=r=>{const db=new DatabaseSync(r.dbPath);handles.push(db);return db;};
const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
const hashFile=p=>createHash("sha256").update(readFileSync(p)).digest("hex");

test("preparation validates restored data and evidence while leaving quarantine and task state unchanged",()=>{
 const r=restored(),before=hashFile(r.dbPath),p=prepareRecovery({dbPath:r.dbPath});
 assert.equal(p.node_id,r.f.node.node_id);assert.equal(p.backup_epoch,r.f.node.sync_epoch);assert.equal(p.counts.active_runs,1);
 assert.equal(p.evidence_files,1);assert.equal(hashFile(r.dbPath),before);assert.equal(recoveryStatus(r.dbPath).state,"restore_hold");
 assert.equal(store.get(open(r),r.f.id).run_id,r.f.run.run_id);
 assert.throws(()=>prepareRecovery({dbPath:r.f.dbPath}),/restore-receipt|ENOENT/);
});

test("activation rotates epoch, revokes copied credentials, fences runs and retains ownership and audit",()=>{
 const r=restored(),p=prepareRecovery({dbPath:r.dbPath}),receipt=activate(r,p),db=open(r);
 assert.notEqual(receipt.new_epoch,p.backup_epoch);assert.equal(receipt.node_id,p.node_id);assert.equal(receipt.tasks_released,0);
 assert.equal(receipt.retirement_evidence,"operator_attested_not_machine_verified");assert.equal(receipt.services_started,false);
 assert.equal(has(db,"board_restore_hold"),false);assert.equal(localIdentity(db).sync_epoch,receipt.new_epoch);
 const t=store.get(db,r.f.id);assert.equal(t.task_uid,r.f.run.task_uid);assert.equal(t.owner_node_id,p.node_id);
 assert.equal(t.status,"waiting");assert.equal(t.waiting_for,"decision");assert.equal(t.released,false);assert.equal(t.run_id,null);
 assert.equal(store.runs(db,r.f.id)[0].state,"ended");
 assert.throws(()=>store.report(db,{id:r.f.id,worker:"old-worker",runId:r.f.run.run_id,outcome:"done",evidence:"stale result"}),{code:"CONFLICT"});
 assert.throws(()=>authenticate(db,"Bearer "+r.f.credential.token),{code:"UNAUTHENTICATED"});
 assert.equal(db.prepare("SELECT count(*) n FROM federation_outbox").get().n,0);assert.equal(db.prepare("SELECT count(*) n FROM federation_dirty").get().n,1);
 assert.ok(db.prepare("SELECT count(*) n FROM board_recovery_archive WHERE table_name='federation_outbox'").get().n>0);
 assert.equal(store.claim(db,{worker:"must-not-run"}),null);
 assert.throws(()=>db.prepare("UPDATE board_node SET sync_epoch=?").run(randomUUID()),/immutable/);
 assert.equal(readFileSync(join(r.dir,"evidence","result.txt"),"utf8"),"durable evidence\n");
 db.prepare("UPDATE tasks SET status='not_started',waiting_for=NULL,released=1,description='operator reviewed recovery and supplied fresh input' WHERE id=?").run(r.f.id);
 const claimed=store.claimById(db,{id:r.f.id,worker:"old-worker"});assert.equal(claimed.ok,true,JSON.stringify(claimed));const fresh=claimed.task;
 assert.notEqual(fresh.run_id,r.f.run.run_id);
 assert.throws(()=>store.report(db,{id:r.f.id,worker:"old-worker",runId:r.f.run.run_id,outcome:"done",evidence:"stale"}),{code:"CONFLICT"});
 assert.equal(store.get(db,r.f.id).run_id,fresh.run_id);
 store.report(db,{id:r.f.id,worker:"old-worker",runId:fresh.run_id,outcome:"done",evidence:"new run result"});
 assert.equal(store.get(db,r.f.id).result,"new run result");
});

test("newly authorized peers receive fresh event identities in the new epoch",()=>{
 const r=restored(),old=JSON.parse(r.f.db.prepare("SELECT event_json FROM federation_outbox").get().event_json),receipt=activate(r),db=open(r),file=path("new-peer")+".json";
 issueCredential(db,{peerNodeId:r.f.peer.peer_node_id,peerEpoch:r.f.peer.peer_epoch,scopes:r.f.peer.scopes,projects:r.f.peer.projects,expectedVersion:2,credentialFile:file});
 const peer=authenticate(db,"Bearer "+JSON.parse(readFileSync(file,"utf8")).token),batch=exportBatch(db,peer,{project_id:"demo",after_seq:0});
 assert.equal(batch.events[0].seq,1);assert.equal(batch.origin_epoch,receipt.new_epoch);
 assert.notEqual(batch.events[0].event_id,old.event_id);assert.equal(batch.events[0].aggregate_uid,old.aggregate_uid);
 assert.equal(batch.events[0].payload.task.released,false);
});

test("missing or mismatched retirement statements never activate the backup",()=>{
 const r=restored(),p=prepareRecovery({dbPath:r.dbPath});
 for(const mutate of [x=>x.original_agents_stopped=false,x=>x.node_id=randomUUID(),x=>x.retired_epoch=randomUUID(),x=>x.plan_digest="0".repeat(64),x=>x.evidence_ref=""]){
  const a=proof(p);mutate(a);
  assert.throws(()=>activateRecovery({dbPath:r.dbPath,plan:p,expectedPlanDigest:p.plan_digest,attestation:a}),/声明|退役|确认|证据/);
  assert.equal(recoveryStatus(r.dbPath).state,"restore_hold");assert.equal(recoveryStatus(r.dbPath).sync_epoch,p.backup_epoch);
 }
});

test("edited plans and plans for another directory are rejected before activation",()=>{
 const r=restored(),p=prepareRecovery({dbPath:r.dbPath});
 const edited={...p,counts:{...p.counts,tasks:99}};
 assert.throws(()=>activateRecovery({dbPath:r.dbPath,plan:edited,expectedPlanDigest:p.plan_digest,attestation:proof(p)}),{code:"PLAN_CHANGED"});
 assert.throws(()=>activateRecovery({dbPath:r.dbPath,plan:p,expectedPlanDigest:"0".repeat(64),attestation:proof(p)}),{code:"PLAN_CHANGED"});
 const {plan_digest,...body}=edited;const signed={...body,plan_digest:digest(body)};
 assert.throws(()=>activateRecovery({dbPath:r.dbPath,plan:signed,expectedPlanDigest:signed.plan_digest,attestation:proof(signed)}),{code:"PLAN_CHANGED"});
 const other=restored(r.f);
 assert.throws(()=>activateRecovery({dbPath:other.dbPath,plan:p,expectedPlanDigest:p.plan_digest,attestation:proof(p)}),{code:"PLAN_CHANGED"});
});

test("changed restored evidence and old receipts without file manifests refuse preparation",()=>{
 const a=restored();writeFileSync(join(a.dir,"evidence","result.txt"),"modified");
 assert.throws(()=>prepareRecovery({dbPath:a.dbPath}),/证据摘要/);
 const b=restored(),file=join(b.dir,"restore-receipt.json"),receipt=JSON.parse(readFileSync(file,"utf8"));delete receipt.evidence_manifest;writeFileSync(file,JSON.stringify(receipt));
 assert.throws(()=>prepareRecovery({dbPath:b.dbPath}),/证据清单/);
});

test("logical WAL changes after preparation cannot hide behind the unchanged main file",()=>{
 const r=restored(),db=open(r);db.exec("PRAGMA journal_mode=WAL");db.close();
 // Journal-mode change is an explicit fixture setup before issuing a matching restore receipt.
 const file=join(r.dir,"restore-receipt.json"),receipt=JSON.parse(readFileSync(file,"utf8"));receipt.restored_database_sha256=hashFile(r.dbPath);writeFileSync(file,JSON.stringify(receipt));
 const plan=prepareRecovery({dbPath:r.dbPath}),writer=open(r),main=hashFile(r.dbPath);
 writer.prepare("UPDATE tasks SET description='changed in WAL' WHERE id=?").run(r.f.id);
 assert.equal(hashFile(r.dbPath),main);
 assert.throws(()=>activate(r,plan),{code:"PLAN_CHANGED"});assert.equal(has(writer,"board_restore_hold"),true);
});

test("failure at the final quarantine removal rolls back all activation effects and can be retried",()=>{
 const r=restored(),p=prepareRecovery({dbPath:r.dbPath}),db=open(r),before=recoveryFingerprint(db),original=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.exec=function(sql){if(sql==="DROP TABLE board_restore_hold")throw Error("injected final failure");return original.call(this,sql);};
 try{assert.throws(()=>activate(r,p),/injected final failure/);}finally{DatabaseSync.prototype.exec=original;}
 assert.equal(recoveryFingerprint(db),before);assert.equal(has(db,"board_restore_hold"),true);
 assert.equal(store.get(db,r.f.id).run_id,r.f.run.run_id);
 assert.equal(activate(r,p).credentials_revoked,1);
});

test("retirement blocks existing database handles, old credentials and reopened worker stores",()=>{
 const f=source(),receipt=retireNode({dbPath:f.dbPath,expectedEpoch:f.node.sync_epoch});
 assert.equal(receipt.task_writes_disabled,true);assert.equal(receipt.process_termination,"not_verified");
 assert.equal(recoveryStatus(f.dbPath).state,"retired");assert.equal(store.get(f.db,f.id).run_id,null);
 assert.throws(()=>store.add(f.db,{subject:"stale open handle"}),/NODE_RETIRED/);
 assert.throws(()=>f.db.prepare("UPDATE tasks SET description='late' WHERE id=?").run(f.id),/NODE_RETIRED/);
 assert.throws(()=>authenticate(f.db,"Bearer "+f.credential.token),{code:"UNAUTHENTICATED"});
 const code='const store=require('+JSON.stringify(join(ROOT,"core/store.js"))+');store.open();';
 const child=spawnSync(process.execPath,["-e",code],{windowsHide:true,encoding:"utf8",env:{...process.env,BOARD_DB:f.dbPath,BOARD_DATA_DIR:f.dir}});
 assert.notEqual(child.status,0);assert.match(child.stderr,/已退役/);
 assert.equal(recoveryStatus(f.dbPath).retirements[0].retirement_id,receipt.retirement_id);
});

test("retirement refuses stale epochs or restores and its own failure leaves the original active",()=>{
 const f=source(),before=recoveryFingerprint(f.db);
 assert.throws(()=>retireNode({dbPath:f.dbPath,expectedEpoch:randomUUID()}),{code:"EPOCH_CHANGED"});
 assert.equal(recoveryFingerprint(f.db),before);
 const r=restored(f);assert.throws(()=>retireNode({dbPath:r.dbPath,expectedEpoch:f.node.sync_epoch}),{code:"RESTORE_HOLD"});
 f.db.exec("CREATE TRIGGER fail_retirement BEFORE UPDATE ON board_lifecycle WHEN NEW.state='retired' BEGIN SELECT RAISE(ABORT,'injected retirement'); END");
 assert.throws(()=>retireNode({dbPath:f.dbPath,expectedEpoch:f.node.sync_epoch}),/injected retirement/);
 assert.equal(localIdentity(f.db).sync_epoch,f.node.sync_epoch);assert.equal(store.get(f.db,f.id).run_id,f.run.run_id);
 assert.equal(authenticate(f.db,"Bearer "+f.credential.token).status,"active");
});

test("a retired original can still be backed up and restored without making either copy executable",()=>{
 const f=source();retireNode({dbPath:f.dbPath,expectedEpoch:f.node.sync_epoch});
 const r=restored(f);assert.equal(inspectRestore(r.dir).receipt.evidence_files,1);
 assert.equal(recoveryStatus(r.dbPath).state,"restore_hold");
 const p=prepareRecovery({dbPath:r.dbPath});assert.equal(activate(r,p).runs_ended,0);
 assert.equal(recoveryStatus(f.dbPath).state,"retired");
});

test("CLI prepare writes an exclusive reviewable plan, and activation requires its observed digest",()=>{
 const r=restored(),planFile=path("plan")+".json",attestation=path("attestation")+".json";
 const invoke=args=>spawnSync(process.execPath,[join(ROOT,"cli/recovery.mjs"),...args],{windowsHide:true,encoding:"utf8"});
 let result=invoke(["prepare","--db",r.dbPath,"--plan-file",planFile]);assert.equal(result.status,0,result.stderr);
 const p=JSON.parse(readFileSync(planFile,"utf8"));writeRecoveryJSON(attestation,proof(p));
 assert.notEqual(invoke(["prepare","--db",r.dbPath,"--plan-file",planFile]).status,0);
 assert.notEqual(invoke(["activate","--db",r.dbPath,"--plan-file",planFile,"--attestation-file",attestation]).status,0);
 result=invoke(["activate","--db",r.dbPath,"--plan-file",planFile,"--plan-digest",p.plan_digest,"--attestation-file",attestation]);
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).services_started,false);
 assert.equal(recoveryStatus(r.dbPath).recoveries.length,1);
});

test("an abrupt process exit before activation commit preserves isolation",()=>{
 const r=restored(),p=prepareRecovery({dbPath:r.dbPath}),input=path("activation")+".json";
 writeRecoveryJSON(input,{dbPath:r.dbPath,plan:p,expectedPlanDigest:p.plan_digest,attestation:proof(p)});
 const url=new URL("../core/recovery.mjs",import.meta.url).href;
 const code='import {DatabaseSync} from "node:sqlite";import {readFileSync} from "node:fs";import {activateRecovery} from '+JSON.stringify(url)+';const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const r=original.call(this,sql);if(sql==="DROP TABLE board_restore_hold")process.exit(71);return r;};activateRecovery(JSON.parse(readFileSync(process.argv[1],"utf8")));';
 const child=spawnSync(process.execPath,["--input-type=module","-e",code,input],{windowsHide:true,encoding:"utf8"});
 assert.equal(child.status,71,child.stderr);
 const db=open(r);assert.equal(has(db,"board_restore_hold"),true);assert.equal(store.get(db,r.f.id).run_id,r.f.run.run_id);
 assert.equal(db.prepare("SELECT sync_epoch FROM board_node").get().sync_epoch,p.backup_epoch);
 assert.equal(activate(r,p).node_id,p.node_id);
});

test("a prepared update held by another process is rejected after retirement commits",async()=>{
 const f=source();
 const code='const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA busy_timeout=5000");const statement=db.prepare("UPDATE tasks SET description=? WHERE id=?");process.send({ready:true});process.once("message",()=>{try{statement.run("late cross-process write",Number(process.argv[2]));process.send({unexpected:true});}catch(e){process.send({rejected:e.message});}finally{db.close();process.disconnect();}});';
 const child=spawn(process.execPath,["-e",code,f.dbPath,String(f.id)],{windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]});
 let errorText="",timer;child.stderr.on("data",x=>errorText+=x);
 const done=new Promise(resolve=>child.once("close",resolve));
 try{
  const result=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error("child timeout: "+errorText)),15000);
   child.on("error",reject);child.once("exit",code=>{if(code)reject(Error("child exit "+code+": "+errorText));});
   child.on("message",m=>{
    if(m.ready){try{retireNode({dbPath:f.dbPath,expectedEpoch:f.node.sync_epoch});child.send({tryWrite:true});}catch(e){reject(e);}}
    else resolve(m);
   });
  });
  assert.match(result.rejected,/NODE_RETIRED/);assert.notEqual(store.get(f.db,f.id).description,"late cross-process write");
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();await done;}
});

test("48 MiB BLOB recovery fingerprints stay bounded and include the final byte",()=>{
 const script=path("blob-fingerprint")+".mjs";
 writeFileSync(script,`import {DatabaseSync} from "node:sqlite";
import {recoveryFingerprint} from ${JSON.stringify(new URL("../core/recovery.mjs",import.meta.url).href)};
const db=new DatabaseSync(":memory:"),bytes=Buffer.alloc(48*1024*1024,120);
db.exec("CREATE TABLE payloads(id INTEGER PRIMARY KEY,content BLOB)");db.prepare("INSERT INTO payloads VALUES(1,?)").run(bytes);
const first=recoveryFingerprint(db);if(first!==recoveryFingerprint(db))throw Error("unchanged BLOB fingerprint drifted");
bytes[bytes.length-1]^=1;db.prepare("UPDATE payloads SET content=?").run(bytes);if(first===recoveryFingerprint(db))throw Error("final byte excluded");
console.log(JSON.stringify({bytes:bytes.length,stable:true,last_byte_bound:true}));db.close();
`);
 const r=spawnSync(process.execPath,["--max-old-space-size=192",script],{encoding:"utf8",windowsHide:true,timeout:20000,maxBuffer:1024*1024});
 assert.equal(r.status,0,r.error?.message??r.stderr);assert.deepEqual(JSON.parse(r.stdout),{bytes:48*1024*1024,stable:true,last_byte_bound:true});
});

function legacySource(withIdentity=false){
 const dir=path("legacy-source");mkdirSync(dir);const evidence=join(dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"result.txt"),"legacy evidence");
 const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);handles.push(db);
 db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,subject TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',acceptance TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'not_started',worker TEXT,attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,result TEXT,verdict_note TEXT,blocked_by TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,parent_id INTEGER,evidence_path TEXT);
 INSERT INTO tasks(id,subject,status,worker,attempts,blocked_by,created_at,updated_at,parent_id) VALUES(7,'old parent','done',NULL,0,'[]','before','before',NULL),(12,'old running child','in_progress','legacy-worker',2,'[7]','before','before',7);
 CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,task_id INTEGER NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '{}');
 INSERT INTO task_events VALUES(40,'before',12,'add','operator','{"legacy":true}');`);
 db.prepare("UPDATE tasks SET evidence_path=? WHERE id=12").run(join(evidence,"result.txt"));
 let node=null;
 if(withIdentity){
  node={node_id:randomUUID(),sync_epoch:randomUUID()};
  db.exec("CREATE TABLE board_node(singleton INTEGER PRIMARY KEY,node_id TEXT,display_name TEXT,sync_epoch TEXT,protocol_version INTEGER,created_at TEXT,updated_at TEXT); ALTER TABLE tasks ADD COLUMN task_uid TEXT; ALTER TABLE tasks ADD COLUMN owner_node_id TEXT");
  db.prepare("INSERT INTO board_node VALUES(1,?,'legacy-node',?,1,'before','before')").run(node.node_id,node.sync_epoch);
  for(const id of [7,12])db.prepare("UPDATE tasks SET task_uid=?,owner_node_id=? WHERE id=?").run(node.node_id+"/"+randomUUID(),node.node_id,id);
 }
 return {dir,dbPath,evidence,db,node};
}
for(const withIdentity of [false,true])test("explicit restore upgrade reaches reviewed activation from "+(withIdentity?"pre-run identity schema":"pre-federation schema"),()=>{
 const f=legacySource(withIdentity),b=createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:path("legacy-backup")});
 const backupHash=hashFile(join(b.destination,"board.db")),sourceHash=hashFile(f.dbPath),dir=path("upgraded-restore");
 const receipt=restoreBackup({backupDirectory:b.destination,destination:dir,upgradeSchema:true}),dbPath=join(dir,"board.db"),db=open({dbPath});
 assert.equal(receipt.schema_upgrade.identity,withIdentity?"preserved":"initialized");assert.deepEqual(receipt.source_database,b.database);
 assert.equal(has(db,"board_restore_hold"),true);assert.equal(has(db,"task_runs"),true);assert.equal(receipt.quarantined,true);
 assert.equal(inspectRestore(dir).summary.node_id,receipt.database.node_id);
 if(withIdentity){assert.equal(receipt.database.node_id,f.node.node_id);assert.equal(receipt.database.sync_epoch,f.node.sync_epoch);assert.equal(store.get(db,12).task_uid,f.db.prepare("SELECT task_uid FROM tasks WHERE id=12").get().task_uid);}
 const before=store.get(db,12);assert.deepEqual(before.blocked_by,[7]);assert.equal(before.parent_id,7);assert.equal(before.status,"in_progress");assert.equal(before.worker,"legacy-worker");assert.equal(before.attempts,2);assert.equal(before.evidence_path,join(dir,"evidence/result.txt"));
 assert.equal(store.runs(db,12)[0].imported,1);assert.equal(db.prepare("SELECT detail FROM task_events WHERE id=40").get().detail,'{"legacy":true}');
 const guardCode='require('+JSON.stringify(join(ROOT,"core/store.js"))+').open()';
 const blocked=spawnSync(process.execPath,["-e",guardCode],{env:{...process.env,BOARD_DB:dbPath,BOARD_DATA_DIR:dir},encoding:"utf8",windowsHide:true});assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/隔离/);
 const frozen=hashFile(dbPath),plan=prepareRecovery({dbPath});assert.equal(hashFile(dbPath),frozen);assert.equal(plan.counts.active_runs,1);
 const activated=activate({dbPath},plan);assert.equal(activated.services_started,false);assert.equal(activated.tasks_released,0);assert.equal(activated.node_id,receipt.database.node_id);assert.notEqual(activated.new_epoch,receipt.database.sync_epoch);
 const after=store.get(db,12);assert.equal(after.task_uid,before.task_uid);assert.equal(after.owner_node_id,before.owner_node_id);assert.equal(after.status,"waiting");assert.equal(after.waiting_for,"decision");assert.equal(after.released,false);assert.equal(after.run_id,null);
 assert.equal(store.runs(db,12)[0].state,"ended");assert.equal(hashFile(f.dbPath),sourceHash);assert.equal(hashFile(join(b.destination,"board.db")),backupHash);assert.equal(verifyBackup(b.destination).verified,true);
});

test("failed legacy schema upgrade leaves an incomplete quarantined copy and unchanged backup",()=>{
 const f=legacySource(),b=createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:path("failed-upgrade-backup")}),before=hashFile(join(b.destination,"board.db")),dir=path("failed-upgrade"),oldName=process.env.BOARD_NODE_NAME;
 try{process.env.BOARD_NODE_NAME="invalid\nnode";assert.throws(()=>restoreBackup({backupDirectory:b.destination,destination:dir,upgradeSchema:true}),/终端名/);}finally{if(oldName===undefined)delete process.env.BOARD_NODE_NAME;else process.env.BOARD_NODE_NAME=oldName;}
 assert.equal(existsSync(join(dir,".incomplete")),true);assert.equal(existsSync(join(dir,"restore-receipt.json")),false);
 const db=open({dbPath:join(dir,"board.db")});assert.equal(has(db,"board_node"),false);assert.equal(has(db,"task_runs"),false);assert.equal(has(db,"board_restore_hold"),true);
 assert.equal(db.prepare("PRAGMA table_info(tasks)").all().some(c=>c.name==="aggregate_version"),false);
 assert.equal(db.prepare("SELECT evidence_path FROM tasks WHERE id=12").get().evidence_path,join(f.evidence,"result.txt"));
 assert.equal(hashFile(join(b.destination,"board.db")),before);assert.equal(verifyBackup(b.destination).verified,true);
 assert.throws(()=>prepareRecovery({dbPath:join(dir,"board.db")}),/尚未完成/);
});

test("legacy restore is opt-in and CLI upgrade produces a preparation-ready held copy",()=>{
 const f=legacySource(),b=createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:path("legacy-cli-backup")}),raw=path("raw-restore");
 restoreBackup({backupDirectory:b.destination,destination:raw});
 assert.throws(()=>prepareRecovery({dbPath:join(raw,"board.db")}),{code:"SCHEMA_UPGRADE_REQUIRED"});
 const dir=path("cli-upgrade"),cli=spawnSync(process.execPath,[join(ROOT,"cli/backup.mjs"),"restore",b.destination,dir,"--upgrade-schema"],{encoding:"utf8",windowsHide:true});
 assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).schema_upgrade.identity,"initialized");
 assert.equal(prepareRecovery({dbPath:join(dir,"board.db")}).counts.active_runs,1);assert.equal(recoveryStatus(join(dir,"board.db")).state,"restore_hold");
});
