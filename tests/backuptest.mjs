import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, symlinkSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBackup, verifyBackup, restoreBackup } from "../core/backup.mjs";
const require = createRequire(import.meta.url), store = require("../core/store.js");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "fleet-backup-")), handles = [];
let seq = 0;
const target = tag => join(TMP, tag + "-" + seq++);
function fixture() {
  const data = target("source"); mkdirSync(data);
  const evidence = join(data, "evidence"); mkdirSync(evidence);
  const dbPath = join(data, "board.db"), db = new DatabaseSync(dbPath);
  handles.push(db); db.exec("PRAGMA journal_mode=WAL"); store.migrate(db);
  const id = store.add(db, { subject:"backup fixture", evidencePath:join(evidence, "result.md") });
  writeFileSync(join(evidence, "result.md"), "verified output\n");
  writeFileSync(join(data, "board_token"), "must-not-copy-token");
  writeFileSync(join(data, "worker_settings.json"), '{"autostart":true}');
  return { data, evidence, dbPath, db, id };
}
function backup(f) { return createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:target("backup")}); }
function rewriteManifest(dir, mutate) {
  const p = join(dir,"manifest.json"), m=JSON.parse(readFileSync(p,"utf8"));
  mutate(m); const text=JSON.stringify(m);
  writeFileSync(p,text);
  writeFileSync(join(dir,"manifest.sha256"),createHash("sha256").update(text).digest("hex")+"\n");
}
after(() => {
  for (const db of handles) { try { db.close(); } catch {} }
  rmSync(TMP,{recursive:true,force:true});
});
test("live WAL snapshot retains committed tasks, events, identity and verified evidence", () => {
  const f=fixture(), node=store.localNode(f.db), b=backup(f);
  assert.ok(existsSync(f.dbPath+"-wal"));
  const checked=verifyBackup(b.destination);
  assert.equal(checked.verified,true);
  assert.equal(b.database.tasks,1); assert.equal(b.database.events,1);
  assert.equal(b.database.node_id,node.node_id);
  assert.deepEqual(b.evidence_references,[{task_id:f.id,path:"evidence/result.md",source_path_sha256:createHash("sha256").update(join(f.evidence,"result.md")).digest("hex")}]);
  assert.equal(readFileSync(join(b.destination,"evidence","result.md"),"utf8"),"verified output\n");
  assert.equal(existsSync(join(b.destination,"board_token")),false);
  assert.equal(existsSync(join(b.destination,"worker_settings.json")),false);
  assert.deepEqual(store.localNode(f.db),node);
  store.add(f.db,{subject:"after snapshot"});
  assert.equal(verifyBackup(b.destination).manifest.database.tasks,1);
});
test("restore is isolated, rebinds evidence paths, and cannot start a board or mint tokens", () => {
  const f=fixture(), b=backup(f), dest=target("restore");
  const restored=restoreBackup({backupDirectory:b.destination,destination:dest});
  assert.equal(restored.quarantined,true);
  const db=new DatabaseSync(join(dest,"board.db"),{readOnly:true});handles.push(db);
  assert.equal(db.prepare("SELECT count(*) n FROM tasks").get().n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM task_events").get().n,1);
  assert.equal(store.get(db,f.id).task_uid,store.get(f.db,f.id).task_uid);
  assert.equal(store.get(db,f.id).evidence_path,join(dest,"evidence/result.md"));
  assert.equal(db.prepare("SELECT backup_id FROM board_restore_hold").get().backup_id,b.backup_id);
  const env={...process.env,BOARD_DB:join(dest,"board.db"),BOARD_DATA_DIR:dest,
    BOARD_CONFIG:join(dest,"missing.config.json"),BOARD_PORT:"0"};
  const server=spawnSync(process.execPath,[join(ROOT,"core/server.mjs")],
    {env,encoding:"utf8",timeout:15000,windowsHide:true});
  assert.notEqual(server.status,0);
  assert.match(server.stderr,/恢复副本处于隔离状态/);
  assert.equal(existsSync(join(dest,"board_token")),false);
  const show=spawnSync(process.execPath,[join(ROOT,"cli/node.mjs"),"show"],
    {env,encoding:"utf8",timeout:10000,windowsHide:true});
  assert.equal(show.status,0,show.stderr);
  assert.equal(JSON.parse(show.stdout).node_id,b.database.node_id);
});
test("existing destinations and destinations inside source data refuse without overwrite", () => {
  const f=fixture(), dest=target("existing");mkdirSync(dest);
  writeFileSync(join(dest,"sentinel"),"keep");
  assert.throws(()=>createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:dest}),/EEXIST/);
  assert.equal(readFileSync(join(dest,"sentinel"),"utf8"),"keep");
  assert.throws(()=>createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:join(f.data,"backup")}),/源目录/);
  const b=backup(f);
  assert.throws(()=>restoreBackup({backupDirectory:b.destination,destination:dest}),/EEXIST/);
  assert.throws(()=>restoreBackup({backupDirectory:b.destination,destination:join(b.destination,"restore")}),/源目录/);
});
test("tampered files and manifests refuse; failed restore remains incomplete", () => {
  const f=fixture(), b=backup(f);
  writeFileSync(join(b.destination,"evidence","result.md"),"changed");
  assert.throws(()=>verifyBackup(b.destination),/摘要/);
  const dest=target("bad-restore");
  assert.throws(()=>restoreBackup({backupDirectory:b.destination,destination:dest}),/摘要/);
  assert.ok(existsSync(join(dest,".incomplete")));
  assert.equal(existsSync(join(dest,"restore-receipt.json")),false);
  const b2=backup(f);
  writeFileSync(join(b2.destination,"manifest.json"),"{}");
  assert.throws(()=>verifyBackup(b2.destination),/摘要/);
});
test("incomplete backup, missing evidence and out-of-scope evidence cannot pass verification", () => {
  const f=fixture(), b=backup(f);
  writeFileSync(join(b.destination,".incomplete"),"interrupted");
  assert.throws(()=>verifyBackup(b.destination),/未完成/);
  f.db.prepare("UPDATE tasks SET evidence_path=? WHERE id=?").run(join(TMP,"outside.md"),f.id);
  assert.throws(()=>backup(f),/证据不在/);
  f.db.prepare("UPDATE tasks SET evidence_path=? WHERE id=?").run(join(f.evidence,"missing.md"),f.id);
  assert.throws(()=>backup(f),/证据文件缺失/);
});
test("manifest paths cannot escape, use alternate streams, reserved names or collide by case", () => {
  for(const bad of ["../victim","evidence/../../victim","evidence/x:stream","evidence/CON.txt","/absolute","evidence/x\\y"]) {
    const f=fixture(),b=backup(f);
    rewriteManifest(b.destination,m=>{m.files[1].path=bad;});
    assert.throws(()=>verifyBackup(b.destination));
  }
  const f=fixture(),b=backup(f);
  rewriteManifest(b.destination,m=>m.files.push({...m.files[1],path:"evidence/RESULT.md"}));
  assert.throws(()=>verifyBackup(b.destination),/重复路径/);
  assert.equal(existsSync(join(TMP,"victim")),false);
});
test("symlinked evidence roots and bundle directories are rejected", t => {
  const f=fixture(), b=backup(f), outside=target("outside");mkdirSync(outside);
  writeFileSync(join(outside,"result.md"),"private");
  const link=target("link");
  try { symlinkSync(outside,link,process.platform==="win32"?"junction":"dir"); }
  catch(e) { if(e.code==="EPERM"){t.skip("symlinks not permitted by this host");return;}throw e; }
  assert.throws(()=>createBackup({dbPath:f.dbPath,evidenceDir:link,destination:target("symlink-backup")}),/链接|联接/);
  rmSync(join(b.destination,"evidence"),{recursive:true,force:true});
  symlinkSync(outside,join(b.destination,"evidence"),process.platform==="win32"?"junction":"dir");
  assert.throws(()=>verifyBackup(b.destination),/链接|联接/);
  assert.equal(readFileSync(join(outside,"result.md"),"utf8"),"private");
});
test("snapshot during another process writing never separates a task from its committed event", async () => {
  const f=fixture();
  const script=[
    'const store=require(process.argv[1]), db=store.open();',
    'let n=0; console.log("ready");',
    'const next=()=>{store.add(db,{subject:"writer "+n});if(++n===150){db.close();return;}setTimeout(next,2)};',
    'next();'
  ].join("\n");
  const child=spawn(process.execPath,["-e",script,join(ROOT,"core/store.js")],{
    env:{...process.env,BOARD_DB:f.dbPath,BOARD_DATA_DIR:f.data},windowsHide:true
  });
  let stderr="";child.stderr.on("data",b=>stderr+=b);
  const exit=new Promise((accept,reject)=>{child.on("error",reject);child.on("close",code=>code===0?accept():reject(new Error(stderr)));});
  await new Promise((accept,reject)=>{child.stdout.once("data",accept);child.once("error",reject);});
  const b=backup(f), db=new DatabaseSync(join(b.destination,"board.db"),{readOnly:true});handles.push(db);
  assert.equal(db.prepare("SELECT count(*) n FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id=t.id)").get().n,0);
  await exit;
  assert.ok(b.database.tasks < f.db.prepare("SELECT count(*) n FROM tasks").get().n,"writer must overlap snapshot");
  assert.equal(b.database.tasks,b.database.events);
});
test("CLI backup/verify/restore round trip and unsupported formats fail closed", () => {
  const f=fixture(),dir=target("cli-backup"),restore=target("cli-restore");
  const env={...process.env,BOARD_DB:f.dbPath,BOARD_DATA_DIR:f.data};
  const cli=(...args)=>spawnSync(process.execPath,[join(ROOT,"cli/backup.mjs"),...args],
    {env,encoding:"utf8",windowsHide:true,timeout:20000});
  const made=cli("create",dir);assert.equal(made.status,0,made.stderr);
  assert.equal(cli("verify",dir).status,0);
  assert.equal(cli("restore",dir,restore).status,0);
  assert.equal(cli("invalid").status,2);
  rewriteManifest(dir,m=>{m.format="ai-fleet-backup/v999";});
  assert.equal(cli("verify",dir).status,1);
});

test("backup snapshots and incomplete copies cannot be opened for execution", () => {
  const f=fixture(),b=backup(f);
  const open=(dir)=>spawnSync(process.execPath,["-e","require(process.argv[1]).open()",join(ROOT,"core/store.js")],{
    env:{...process.env,BOARD_DB:join(dir,"board.db"),BOARD_DATA_DIR:dir},encoding:"utf8",windowsHide:true,timeout:10000
  });
  assert.match(open(b.destination).stderr,/恢复副本处于隔离状态/);
  const incomplete=target("interrupted");mkdirSync(incomplete);
  writeFileSync(join(incomplete,".incomplete"),"unfinished");
  assert.match(open(incomplete).stderr,/尚未完成/);
  assert.equal(existsSync(join(incomplete,"board.db")),false);
});
test("an evidence change during the snapshot rejects completion", () => {
  const f=fixture(),dest=target("changed");
  const original=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql) {
    const statement=original.call(this,sql);
    if(sql==="VACUUM INTO ?") return {run(...args){
      const result=statement.run(...args);
      writeFileSync(join(f.evidence,"result.md"),"replaced after DB snapshot");
      return result;
    }};
    return statement;
  };
  try {
    assert.throws(()=>createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:dest}),/证据文件改变/);
    assert.ok(existsSync(join(dest,".incomplete")));
    assert.equal(existsSync(join(dest,"manifest.json")),false);
  } finally { DatabaseSync.prototype.prepare=original; }
});
test("a newly-created evidence directory during the snapshot is detected", () => {
  const f=fixture(),dest=target("new-evidence");
  f.db.prepare("UPDATE tasks SET evidence_path=NULL").run();
  rmSync(f.evidence,{recursive:true,force:true});
  const original=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql) {
    const statement=original.call(this,sql);
    if(sql==="VACUUM INTO ?") return {run(...args){
      const result=statement.run(...args);
      mkdirSync(f.evidence);writeFileSync(join(f.evidence,"new.md"),"new");
      return result;
    }};
    return statement;
  };
  try {
    assert.throws(()=>createBackup({dbPath:f.dbPath,evidenceDir:f.evidence,destination:dest}),/文件集合改变/);
    assert.ok(existsSync(join(dest,".incomplete")));
  } finally { DatabaseSync.prototype.prepare=original; }
});
test("evidence references cannot be omitted or detached from the database", () => {
  const f=fixture(),b=backup(f);
  rewriteManifest(b.destination,m=>{m.evidence_references=[];});
  assert.throws(()=>verifyBackup(b.destination),/未覆盖/);
  const b2=backup(f);
  rewriteManifest(b2.destination,m=>{m.evidence_references[0].source_path_sha256="0".repeat(64);});
  assert.throws(()=>verifyBackup(b2.destination),/引用不符/);
});
test("oversized manifest and digest files are refused before parsing", () => {
  const f=fixture(),b=backup(f);
  writeFileSync(join(b.destination,"manifest.json"),Buffer.alloc(16*1024*1024+1,32));
  assert.throws(()=>verifyBackup(b.destination),/大小上限/);
  const b2=backup(f);writeFileSync(join(b2.destination,"manifest.sha256"),"0".repeat(129));
  assert.throws(()=>verifyBackup(b2.destination),/大小上限/);
});
