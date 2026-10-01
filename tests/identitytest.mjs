// Identity migration and ownership invariants use disposable databases only.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const store = require("../core/store.js");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "fleet-identity-"));
const handles = [];
let next = 0;
function database() {
  const db = new DatabaseSync(join(TMP, `db-${next++}.db`));
  handles.push(db);
  return db;
}
function migrated() { const db = database(); store.migrate(db); return db; }
after(() => {
  for (const db of handles) { try { db.close(); } catch {} }
  rmSync(TMP, { recursive: true, force: true });
});

test("names can change without changing node identity, epoch or task ownership", () => {
  const db = migrated();
  const node = store.localNode(db);
  const id = store.add(db, { subject: "identity fixture" });
  const before = store.get(db, id);
  assert.match(node.node_id, /^[0-9a-f-]{36}$/);
  assert.equal(before.owner_node_id, node.node_id);
  assert.equal(before.task_uid.slice(0, 37), node.node_id + "/");
  const renamed = store.renameNode(db, "  终端 A  ");
  assert.equal(renamed.display_name, "终端 A");
  assert.equal(renamed.node_id, node.node_id);
  assert.equal(renamed.sync_epoch, node.sync_epoch);
  store.migrate(db);
  assert.equal(store.localNode(db).display_name, "终端 A");
  assert.deepEqual(store.get(db, id), before);
});

test("two nodes with the same display name and local card number have distinct global IDs", () => {
  const a = migrated(), b = migrated();
  store.renameNode(a, "Alpha"); store.renameNode(b, "Alpha");
  const aid = store.add(a, { subject: "same title" });
  const bid = store.add(b, { subject: "same title" });
  assert.equal(aid, bid);
  assert.notEqual(store.localNode(a).node_id, store.localNode(b).node_id);
  assert.notEqual(store.get(a, aid).task_uid, store.get(b, bid).task_uid);
});

test("legacy migration preserves IDs, dependencies, states and preexisting event records", () => {
  const db = database();
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'not_started', worker TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
    result TEXT, verdict_note TEXT, blocked_by TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, parent_id INTEGER
  );
  INSERT INTO tasks(id,subject,status,blocked_by,created_at,updated_at,parent_id)
    VALUES (7,'parent','done','[]','old-created','old-updated',NULL),
           (12,'child','waiting','[7]','child-created','child-updated',7);
  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task_id INTEGER NOT NULL,
    kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO task_events VALUES (40,'original',7,'add','operator','{"fixture":true}');`);
  store.migrate(db);
  const first = store.get(db, 12);
  assert.equal(first.parent_id, 7);
  assert.equal(first.tree_mode,"legacy");
  assert.equal(store.get(db,7).tree_mode,"legacy");
  assert.deepEqual(first.blocked_by, [7]);
  assert.equal(first.status, "waiting");
  assert.equal(first.created_at, "child-created");
  assert.equal(first.updated_at, "child-updated");
  assert.equal(store.get(db, 7).status, "done");
  assert.equal(db.prepare("SELECT detail FROM task_events WHERE id=40").get().detail, '{"fixture":true}');
  const eventCount = db.prepare("SELECT count(*) n FROM task_events").get().n;
  store.migrate(db);
  assert.equal(store.get(db, 12).task_uid, first.task_uid);
  assert.equal(db.prepare("SELECT count(*) n FROM task_events").get().n, eventCount);
  assert.ok(store.add(db, { subject: "next local card" }) > 12);
});

test("ownership and UID cannot be forged through add/update or direct SQL mutation", () => {
  const db = migrated();
  for (const field of ["task_uid", "taskUid", "owner_node_id", "ownerNodeId"]) {
    assert.throws(() => store.add(db, { subject: "forged", [field]: "other" }), { code: "BAD_INPUT" });
  }
  const id = store.add(db, { subject: "local card" });
  for (const field of ["task_uid", "taskUid", "owner_node_id", "ownerNodeId"]) {
    assert.throws(() => store.update(db, { id, [field]: "other" }), { code: "BAD_INPUT" });
  }
  assert.throws(() => db.prepare("UPDATE tasks SET owner_node_id='other' WHERE id=?").run(id), /identity/);
  assert.throws(() => db.prepare("UPDATE tasks SET task_uid=NULL WHERE id=?").run(id), /identity/);
  assert.throws(() => db.exec("UPDATE board_node SET node_id='other'"), /identity/);
  assert.throws(() => db.exec("DELETE FROM board_node"), /identity/);
  assert.throws(() => db.exec("INSERT INTO tasks(subject,created_at,updated_at) VALUES ('raw','','')"), /identity/);
  assert.equal(db.prepare("SELECT count(*) n FROM tasks").get().n, 1);
});

test("an invalid first node name rolls back the entire migration", () => {
  const db = database(), original = process.env.BOARD_NODE_NAME;
  try {
    process.env.BOARD_NODE_NAME = "bad\nname";
    assert.throws(() => store.migrate(db), { code: "BAD_INPUT" });
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n, 0);
    process.env.BOARD_NODE_NAME = "bootstrap";
    store.migrate(db);
    assert.equal(store.localNode(db).display_name, "bootstrap");
    process.env.BOARD_NODE_NAME = "must not rename on restart";
    store.migrate(db);
    assert.equal(store.localNode(db).display_name, "bootstrap");
  } finally {
    if (original === undefined) delete process.env.BOARD_NODE_NAME;
    else process.env.BOARD_NODE_NAME = original;
  }
});

test("invalid rename does not mutate existing metadata", () => {
  const db = migrated(), before = store.localNode(db);
  for (const name of ["", " ", "x\n", "x\u0000y", "x".repeat(81), null, 123]) {
    assert.throws(() => store.renameNode(db, name), { code: "BAD_INPUT" });
    assert.deepEqual(store.localNode(db), before);
  }
});

test("partial or foreign identity data refuses migration and preserves original rows", () => {
  const db = migrated();
  const id = store.add(db, { subject: "corruption fixture" });
  db.exec("DROP TRIGGER task_identity_immutable");
  db.prepare("UPDATE tasks SET owner_node_id='foreign' WHERE id=?").run(id);
  assert.throws(() => store.migrate(db), { code: "CONFLICT" });
  assert.equal(db.prepare("SELECT owner_node_id FROM tasks WHERE id=?").get(id).owner_node_id, "foreign");
});

test("multiple processes opening one empty database agree on one node and distinct task IDs", async () => {
  const dbPath = join(TMP, "concurrent.db");
  const script = `
    const store = require(process.argv[1]);
    const db = store.open();
    const id = store.add(db, {subject: "concurrent " + process.pid});
    console.log(JSON.stringify({node:store.localNode(db),task:store.get(db,id)}));
    db.close();
  `;
  const children = Array.from({ length: 6 }, () => new Promise((accept, reject) => {
    const cp = spawn(process.execPath, ["-e", script, join(ROOT, "core/store.js")], {
      env: {...process.env, BOARD_DB:dbPath, BOARD_DATA_DIR:TMP}, windowsHide:true
    });
    let stdout = "", stderr = "";
    cp.stdout.on("data", b => stdout += b);
    cp.stderr.on("data", b => stderr += b);
    cp.on("error", reject);
    cp.on("close", code => {
      if (code !== 0) return reject(new Error(stderr));
      try { accept(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  }));
  const results = await Promise.all(children);
  assert.equal(new Set(results.map(r => r.node.node_id)).size, 1);
  assert.equal(new Set(results.map(r => r.node.sync_epoch)).size, 1);
  assert.equal(new Set(results.map(r => r.task.task_uid)).size, 6);
});

test("read-only open preserves persisted identity, and CLI rename uses the same identity", () => {
  const dbPath = join(TMP, "cli.db");
  const env = {...process.env, BOARD_DB:dbPath, BOARD_DATA_DIR:TMP};
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "cli/node.mjs"), ...args],
    {env,encoding:"utf8",windowsHide:true,timeout:10000});
  const created = cli("init");
  assert.equal(created.status, 0, created.stderr);
  const first = JSON.parse(created.stdout);
  const renamed = cli("rename", "工作站 B");
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(JSON.parse(renamed.stdout).node_id, first.node_id);
  const shown = cli("show");
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).display_name, "工作站 B");
  assert.equal(cli("rename", "").status, 1);
  assert.equal(cli("unexpected").status, 2);
});


test("three simulated nodes backfill 10,000 cards each without UID collisions", () => {
  const allUIDs = new Set(), nodes = new Set();
  for (let n = 0; n < 3; n++) {
    const db = database();
    db.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_started', worker TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, result TEXT,
      verdict_note TEXT, blocked_by TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<10000)
    INSERT INTO tasks(id,subject,created_at,updated_at) SELECT n,'legacy '||n,'before','before' FROM ids;`);
    store.migrate(db);
    nodes.add(store.localNode(db).node_id);
    const rows = db.prepare("SELECT id,task_uid FROM tasks ORDER BY id").all();
    assert.equal(rows.length, 10000);
    assert.equal(store.get(db, 10000).subject, "legacy 10000");
    for (const row of rows) {
      assert.ok(!allUIDs.has(row.task_uid), "UID collision");
      allUIDs.add(row.task_uid);
    }
    store.migrate(db);
    assert.deepEqual(db.prepare("SELECT id,task_uid FROM tasks ORDER BY id").all(), rows);
  }
  assert.equal(nodes.size, 3);
  assert.equal(allUIDs.size, 30000);
});
test("a competing DELETE-mode reader delays WAL bootstrap, then opening succeeds after release", async () => {
  const dbPath=join(TMP,"wal-reader.db"),reader=new DatabaseSync(dbPath);handles.push(reader);
  reader.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserved'); BEGIN");
  reader.prepare("SELECT * FROM sentinel").get(); // Hold a real shared lock against WAL conversion.
  const script = [
    'const {DatabaseSync}=require("node:sqlite");',
    'const store=require(process.argv[1]);const prepare=DatabaseSync.prototype.prepare;let sent=false;',
    'DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql!=="PRAGMA journal_mode=WAL")return stmt;',
    'return {get(){try{return stmt.get();}catch(e){if(!sent){sent=true;process.send({busy:e.errcode});}throw e;}}};};',
    'try{const db=store.open();process.send({opened:true,mode:prepare.call(db,"PRAGMA journal_mode").get().journal_mode,value:prepare.call(db,"SELECT value FROM sentinel").get().value});db.close();process.disconnect();}',
    'catch(e){console.error(e);process.exit(1);}'
  ].join("\n");
  const cp=spawn(process.execPath,["-e",script,join(ROOT,"core/store.js")],{
    env:{...process.env,BOARD_DB:dbPath,BOARD_DATA_DIR:TMP},windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]
  });
  let stderr="",timer,busy=false,opened;
  cp.stderr.on("data",b=>stderr+=b);
  const closed=new Promise(resolve=>cp.once("close",resolve));
  try{
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error("WAL opener timeout: "+stderr)),15000);
      cp.on("error",reject);
      cp.on("message",m=>{
        try{
          if(m.busy!==undefined){assert.equal(m.busy&255,5);busy=true;reader.exec("ROLLBACK");}
          if(m.opened)opened=m;
        }catch(e){reject(e);}
      });
      cp.once("close",code=>code===0?resolve():reject(Error("child exit "+code+": "+stderr)));
    });
    assert.equal(busy,true);assert.equal(opened.mode,"wal");assert.equal(opened.value,"preserved");
  }finally{
    clearTimeout(timer);if(cp.exitCode===null)cp.kill();await closed;
    if(reader.isTransaction)reader.exec("ROLLBACK");
  }
});

test("WAL bootstrap stops after its budget and closes the failed connection", () => {
  const dbPath=join(TMP,"wal-deadline.db"),reader=new DatabaseSync(dbPath);handles.push(reader);
  reader.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserved'); BEGIN");
  reader.prepare("SELECT * FROM sentinel").get();
  const script=[
    'const assert=require("node:assert/strict"),{DatabaseSync}=require("node:sqlite");const store=require(process.argv[1]);',
    'const close=DatabaseSync.prototype.close;let closed=0;DatabaseSync.prototype.close=function(){closed++;return close.call(this);};',
    'const started=performance.now();assert.throws(()=>store.open(),e=>e.code==="ERR_SQLITE_ERROR"&&(e.errcode&255)===5);',
    'assert.equal(closed,1);console.log(JSON.stringify({elapsed:performance.now()-started}));'
  ].join("\n");
  const child=spawnSync(process.execPath,["-e",script,join(ROOT,"core/store.js")],{
    env:{...process.env,BOARD_DB:dbPath,BOARD_DATA_DIR:TMP},windowsHide:true,encoding:"utf8",timeout:15000
  });
  reader.exec("ROLLBACK");
  assert.equal(child.status,0,child.stderr);
  const {elapsed}=JSON.parse(child.stdout);
  assert.ok(elapsed>=4900 && elapsed<12000,"bounded startup elapsed "+elapsed);
  const retry=spawnSync(process.execPath,["-e",'const store=require(process.argv[1]);const db=store.open();db.close();',join(ROOT,"core/store.js")],{
    env:{...process.env,BOARD_DB:dbPath,BOARD_DATA_DIR:TMP},windowsHide:true,encoding:"utf8",timeout:10000
  });
  assert.equal(retry.status,0,retry.stderr);
});

test("non-busy WAL failures are reported once without retrying or leaking a connection", () => {
  const dbPath=join(TMP,"wal-nonbusy.db");
  const script=[
    'const assert=require("node:assert/strict"),{DatabaseSync}=require("node:sqlite");const store=require(process.argv[1]);',
    'const prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close;let attempts=0,closed=0;',
    'DatabaseSync.prototype.prepare=function(sql){if(sql!=="PRAGMA journal_mode=WAL")return prepare.call(this,sql);return {get(){attempts++;throw Object.assign(Error("injected IO failure"),{code:"ERR_SQLITE_ERROR",errcode:10});}};};',
    'DatabaseSync.prototype.close=function(){closed++;return close.call(this);};',
    'assert.throws(()=>store.open(),e=>e.errcode===10);assert.equal(attempts,1);assert.equal(closed,1);'
  ].join("\n");
  const child=spawnSync(process.execPath,["-e",script,join(ROOT,"core/store.js")],{
    env:{...process.env,BOARD_DB:dbPath,BOARD_DATA_DIR:TMP},windowsHide:true,encoding:"utf8",timeout:10000
  });
  assert.equal(child.status,0,child.stderr);
});

test("migration inside an outer restore transaction does not commit that transaction",()=>{
 const db=database();db.exec("BEGIN IMMEDIATE; CREATE TABLE outer_marker(value TEXT); INSERT INTO outer_marker VALUES('keep until rollback')");
 store.migrate(db);assert.equal(db.isTransaction,true);assert.ok(store.localNode(db).node_id);
 db.exec("ROLLBACK");assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='tasks'").get(),undefined);assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='outer_marker'").get(),undefined);
});

test("failed nested migration rolls back its own schema and leaves the caller transaction intact",()=>{
 const db=database(),previous=process.env.BOARD_NODE_NAME;
 db.exec("BEGIN IMMEDIATE; CREATE TABLE outer_marker(value TEXT); INSERT INTO outer_marker VALUES('preserved')");
 try{process.env.BOARD_NODE_NAME="bad\nname";assert.throws(()=>store.migrate(db),/终端名/);}finally{if(previous===undefined)delete process.env.BOARD_NODE_NAME;else process.env.BOARD_NODE_NAME=previous;}
 assert.equal(db.isTransaction,true);assert.equal(db.prepare("SELECT value FROM outer_marker").get().value,"preserved");assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='tasks'").get(),undefined);
 db.exec("COMMIT");assert.equal(db.prepare("SELECT value FROM outer_marker").get().value,"preserved");
});
