// Consistent SQLite snapshots plus verified evidence, never a raw copy of a live WAL DB.
// Restore produces a quarantined NEW directory; activating a node is a separate operation.
import {
  lstatSync, realpathSync, readdirSync, mkdirSync, openSync, closeSync,
  readSync, writeSync, fstatSync, fsyncSync, unlinkSync
} from "node:fs";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

const FORMAT = "ai-fleet-backup/v1";
const MAX_FILES = 100000;
const MAX_MANIFEST = 16 * 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(message); };
const present = p => { try { lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
const inside = (root, p) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
    r !== ".." && !isAbsolute(r));
};
const noLink = p => {
  const st = lstatSync(p, { bigint: true });
  if (st.isSymbolicLink()) fail("不接受符号链接或目录联接: " + p);
  return st;
};
function portablePath(p) {
  if (typeof p !== "string" || !p || p.length > 1024 || p.includes("\\") ||
      p.split("/").some(s => !s || s === "." || s === ".." || /[<>:"|?*\u0000-\u001f]/u.test(s) ||
        /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
    fail("备份中的路径不安全或不具备跨平台兼容性");
  return p;
}
function canonicalDirectory(p) {
  const full = resolve(p);
  if (!noLink(full).isDirectory()) fail("不是目录: " + full);
  return realpathSync(full);
}
function newDirectory(p, forbiddenRoots = []) {
  const target = join(canonicalDirectory(dirname(resolve(p))), basename(resolve(p)));
  if (forbiddenRoots.some(root => inside(root, target))) fail("目标不能位于源目录之内");
  // mkdir, rather than exists+overwrite, is the exclusive reservation.
  mkdirSync(target, { mode: 0o700 });
  writeNew(join(target, ".incomplete"), "incomplete\n");
  return target;
}
function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}
function writeNew(p, data) {
  const fd = openSync(p, "wx", 0o600);
  try { writeAll(fd, Buffer.from(data)); fsyncSync(fd); } finally { closeSync(fd); }
}
function stableFile(p, destination = null, { limit = Infinity, contents = false } = {}) {
  const before = noLink(p);
  if (!before.isFile()) fail("只接受普通文件: " + p);
  if (Number.isFinite(limit) && before.size > BigInt(limit)) fail("文件超过大小上限");
  // A stable handle and inode comparison detect replacement between stat and open.
  const fd = openSync(p, "r");
  let out;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      fail("读取前文件被替换: " + p);
    if (destination) out = openSync(destination, "wx", 0o600);
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536), parts = [];
    let bytes = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, count);
      if (bytes + count > limit) fail("读取期间文件超过大小上限");
      if (contents) parts.push(Buffer.from(chunk));
      hash.update(chunk);
      if (out !== undefined) writeAll(out, chunk);
      bytes += count;
    }
    const after = fstatSync(fd, { bigint: true }), pathAfter = noLink(p);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs ||
        pathAfter.ctimeNs !== before.ctimeNs)
      fail("读取期间文件发生变化: " + p);
    if (out !== undefined) fsyncSync(out);
    return { bytes, sha256: hash.digest("hex"), ...(contents ? {data:Buffer.concat(parts)} : {}) };
  } finally { if (out !== undefined) closeSync(out); closeSync(fd); }
}
function evidenceFiles(root) {
  if (!root || !present(root)) return [];
  const paths = [];
  const walk = (dir, prefix) => {
    if (!noLink(dir).isDirectory()) fail("证据路径不是目录");
    if (!inside(root, realpathSync(dir))) fail("证据路径越界");
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = portablePath(prefix ? prefix + "/" + item.name : item.name);
      const full = join(dir, item.name), stat = noLink(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) {
        paths.push(rel);
        if (paths.length > MAX_FILES) fail("证据文件数量超出上限");
      } else fail("证据目录包含非普通文件");
    }
  };
  walk(root, "");
  const folded = paths.map(p => p.normalize("NFC").toLowerCase());
  if (new Set(folded).size !== paths.length) fail("证据文件名在不同平台上会发生冲突");
  return paths.sort();
}
function openReadOnly(p) {
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
  return db;
}
function databaseSummary(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("SQLite 完整性校验失败");
  for (const name of ["tasks", "task_events"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name))
      fail("数据库缺少看板表: " + name);
  }
  const hasNode = db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_node' AND type='table'").get();
  const node = hasNode ? db.prepare("SELECT node_id, sync_epoch FROM board_node WHERE singleton=1").get() : null;
  return {
    tasks: db.prepare("SELECT count(*) n FROM tasks").get().n,
    events: db.prepare("SELECT count(*) n FROM task_events").get().n,
    node_id: node?.node_id ?? null, sync_epoch: node?.sync_epoch ?? null
  };
}
function evidenceReferences(db, sourceRoot, names) {
  const columns = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!columns.includes("evidence_path")) return [];
  const known = new Set(names);
  return db.prepare("SELECT id,evidence_path FROM tasks WHERE evidence_path IS NOT NULL AND evidence_path<>''").all()
    .map(row => {
      if (!sourceRoot) fail("任务声明了证据文件，但没有证据目录");
      const p = resolve(sourceRoot, row.evidence_path);
      if (!inside(sourceRoot, p)) fail("任务 #" + row.id + " 的证据不在声明的证据目录内");
      const rel = relative(sourceRoot, p).replaceAll("\\", "/");
      if (!known.has(rel)) fail("任务 #" + row.id + " 的证据文件缺失");
      return { task_id: row.id, path: "evidence/" + rel, source_path_sha256: digest(String(row.evidence_path)) };
    });
}
function finishDirectory(root) {
  unlinkSync(join(root, ".incomplete"));
  // POSIX directory fsync publishes the complete marker durably. Windows disallows
  // opening directories this way; every file was already flushed before publication.
  if (process.platform !== "win32") {
    const fd = openSync(root, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
function makeParent(root, p) { mkdirSync(dirname(join(root, p)), { recursive: true, mode: 0o700 }); }

export function createBackup({ dbPath, evidenceDir, destination }) {
  const source = realpathSync(resolve(dbPath));
  if (!noLink(resolve(dbPath)).isFile()) fail("源数据库不是普通文件");
  const evidenceRoot = evidenceDir ? (present(evidenceDir) ? canonicalDirectory(evidenceDir) : resolve(evidenceDir)) : null;
  const dest = newDirectory(destination, [dirname(source), ...(evidenceRoot ? [evidenceRoot] : [])]);
  const names = evidenceFiles(evidenceRoot), files = [], backupId = randomUUID();
  // Capture files before DB snapshot, then verify the set and all hashes afterwards.
  for (const rel of names) {
    const p = "evidence/" + rel;
    makeParent(dest, p);
    files.push({ path: p, ...stableFile(join(evidenceRoot, rel), join(dest, p)) });
  }
  const sourceDB = openReadOnly(source);
  try {
    sourceDB.exec("PRAGMA synchronous=FULL");
    // INTO is a consistent SQLite snapshot, including committed WAL content.
    sourceDB.prepare("VACUUM INTO ?").run(join(dest, "board.db"));
  } finally { sourceDB.close(); }
  const guard = new DatabaseSync(join(dest, "board.db"));
  try {
    guard.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    guard.exec("CREATE TABLE IF NOT EXISTS board_restore_hold (backup_id TEXT NOT NULL, restored_at TEXT NOT NULL)");
    guard.exec("DELETE FROM board_restore_hold");
    guard.prepare("INSERT INTO board_restore_hold VALUES (?,?)").run(backupId, new Date().toISOString());
    guard.exec("COMMIT");
  } finally { guard.close(); }
  const snapshot = openReadOnly(join(dest, "board.db"));
  let summary, references;
  try {
    summary = databaseSummary(snapshot);
    references = evidenceReferences(snapshot, evidenceRoot, names);
  } finally { snapshot.close(); }
  if (JSON.stringify(evidenceFiles(evidenceRoot)) !== JSON.stringify(names))
    fail("快照期间证据文件集合改变；保留 incomplete 目录，稍后重试");
  for (let i = 0; i < names.length; i++) {
    const current = stableFile(join(evidenceRoot, names[i]));
    if (current.sha256 !== files[i].sha256 || current.bytes !== files[i].bytes)
      fail("快照期间证据文件改变；保留 incomplete 目录，稍后重试");
  }
  files.unshift({ path: "board.db", ...stableFile(join(dest, "board.db")) });
  const manifest = {
    format: FORMAT, backup_id: backupId, created_at: new Date().toISOString(),
    database: summary, evidence_references: references, files
  };
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_MANIFEST) fail("备份清单超过大小上限");
  writeNew(join(dest, "manifest.json"), bytes);
  writeNew(join(dest, "manifest.sha256"), digest(bytes) + "\n");
  finishDirectory(dest);
  return { destination: dest, ...manifest };
}

function readManifest(root) {
  if (present(join(root, ".incomplete"))) fail("备份尚未完成，不能校验为成功或恢复");
  const m = join(root, "manifest.json"), h = join(root, "manifest.sha256");
  const raw = stableFile(m, null, {limit:MAX_MANIFEST,contents:true});
  const expected = stableFile(h, null, {limit:128,contents:true}).data.toString("utf8").trim();
  const text = raw.data.toString("utf8");
  if (raw.sha256 !== expected) fail("备份清单摘要不匹配");
  let manifest;
  try { manifest = JSON.parse(text); } catch { fail("备份清单不是有效 JSON"); }
  if (!manifest || manifest.format !== FORMAT || !/^[0-9a-f-]{36}$/.test(manifest.backup_id) || !Array.isArray(manifest.files) ||
      manifest.files.length < 1 || manifest.files.length > MAX_FILES + 1 ||
      !Array.isArray(manifest.evidence_references)) fail("不支持的备份格式或清单结构");
  const paths = new Set(), folded = new Set();
  for (const f of manifest.files) {
    portablePath(f.path);
    if (f.path !== "board.db" && !f.path.startsWith("evidence/")) fail("清单包含不允许恢复的文件");
    const fold = f.path.normalize("NFC").toLowerCase();
    if (folded.has(fold) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !/^[0-9a-f]{64}$/.test(f.sha256))
      fail("清单包含重复路径或无效文件属性");
    paths.add(f.path); folded.add(fold);
  }
  if (!paths.has("board.db")) fail("清单缺少数据库");
  const taskIds = new Set();
  for (const ref of manifest.evidence_references) {
    if (!Number.isSafeInteger(ref.task_id) || ref.task_id < 1 || taskIds.has(ref.task_id) ||
        typeof ref.path !== "string" || !ref.path.startsWith("evidence/") || !paths.has(ref.path) ||
        !/^[0-9a-f]{64}$/.test(ref.source_path_sha256))
      fail("证据索引无效");
    taskIds.add(ref.task_id);
  }
  return manifest;
}
function validateBundle(root, manifest, destination = null) {
  for (const f of manifest.files) {
    const src = join(root, f.path);
    // Recheck each parent instead of accepting a path inside a symlinked evidence dir.
    let parent = dirname(src);
    while (parent !== root) {
      if (!inside(root, parent) || !noLink(parent).isDirectory()) fail("备份路径越界");
      parent = dirname(parent);
    }
    if (destination) makeParent(destination, f.path);
    const got = stableFile(src, destination ? join(destination, f.path) : null);
    if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) fail("备份文件摘要不匹配: " + f.path);
  }
  const target = destination || root;
  const db = openReadOnly(join(target, "board.db"));
  try {
    if (JSON.stringify(databaseSummary(db)) !== JSON.stringify(manifest.database))
      fail("数据库内容与清单摘要不一致");
    const hasPath = db.prepare("PRAGMA table_info(tasks)").all().some(c => c.name === "evidence_path");
    const refs = hasPath ? db.prepare("SELECT id,evidence_path FROM tasks WHERE evidence_path IS NOT NULL AND evidence_path<>''").all() : [];
    if (refs.length !== manifest.evidence_references.length) fail("证据索引未覆盖数据库中的全部文件引用");
    const byId = new Map(refs.map(r => [r.id, r]));
    for (const ref of manifest.evidence_references) {
      const row = byId.get(ref.task_id);
      if (!row || digest(String(row.evidence_path)) !== ref.source_path_sha256) fail("证据索引与任务引用不符");
    }
  } finally { db.close(); }
}
export function verifyBackup(directory) {
  const root = canonicalDirectory(directory), manifest = readManifest(root);
  validateBundle(root, manifest);
  return { verified: true, manifest };
}
export function restoreBackup({ backupDirectory, destination }) {
  const root = canonicalDirectory(backupDirectory), manifest = readManifest(root);
  const dest = newDirectory(destination, [root]);
  // Copy and hash from the SAME handle; a verify-then-copy would introduce TOCTOU.
  validateBundle(root, manifest, dest);
  const db = new DatabaseSync(join(dest, "board.db"));
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS board_restore_hold (backup_id TEXT NOT NULL, restored_at TEXT NOT NULL)");
    db.exec("DELETE FROM board_restore_hold");
    db.prepare("INSERT INTO board_restore_hold VALUES (?,?)").run(manifest.backup_id, new Date().toISOString());
    const wasRetired=db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_lifecycle'").get() && db.prepare("SELECT state FROM board_lifecycle").get()?.state==="retired";
    if(wasRetired)db.exec("UPDATE board_lifecycle SET state='active' WHERE singleton=1");
    for (const ref of manifest.evidence_references)
      db.prepare("UPDATE tasks SET evidence_path=? WHERE id=?").run(join(dest, ref.path), ref.task_id);
    if(wasRetired)db.exec("UPDATE board_lifecycle SET state='retired' WHERE singleton=1");
    db.exec("COMMIT");
    databaseSummary(db);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  } finally { db.close(); }
  const receipt = {
    backup_id: manifest.backup_id, restored_at: new Date().toISOString(),
    quarantined: true, database: manifest.database,
    restored_database_sha256: stableFile(join(dest, "board.db")).sha256,
    evidence_files: manifest.files.length - 1,
    evidence_manifest: manifest.files.filter(f=>f.path!=="board.db").map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256}))
  };
  writeNew(join(dest, "restore-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  finishDirectory(dest);
  return { destination: dest, ...receipt };
}

/** Read-only validation of an untouched restored directory before recovery preparation. */
export function inspectRestore(directory) {
  const root=canonicalDirectory(directory);
  if(present(join(root,".incomplete")))fail("恢复目录尚未完成");
  const file=stableFile(join(root,"restore-receipt.json"),null,{limit:MAX_MANIFEST,contents:true});
  const receipt=JSON.parse(file.data.toString("utf8"));
  if(receipt.quarantined!==true || !Array.isArray(receipt.evidence_manifest) || receipt.evidence_manifest.length!==receipt.evidence_files || receipt.evidence_files>MAX_FILES)
    fail("恢复回执缺少证据清单；请从已校验备份重新恢复");
  const dbPath=join(root,"board.db"),database=stableFile(dbPath);
  if(database.sha256!==receipt.restored_database_sha256)fail("恢复数据库与原回执不一致");
  const seen=new Set();
  for(const item of receipt.evidence_manifest){
    portablePath(item.path);
    if(!item.path.startsWith("evidence/") || seen.has(item.path.toLowerCase()))fail("恢复证据路径冲突");
    seen.add(item.path.toLowerCase());
    let current=root;for(const part of item.path.split("/")){current=join(current,part);noLink(current);}
    const actual=stableFile(current);
    if(actual.sha256!==item.sha256 || actual.bytes!==item.bytes)fail("恢复证据摘要不匹配");
  }
  const db=openReadOnly(dbPath);
  try {
    const summary=databaseSummary(db),hold=db.prepare("SELECT backup_id FROM board_restore_hold").all();
    if(hold.length!==1 || hold[0].backup_id!==receipt.backup_id || summary.node_id!==receipt.database?.node_id || summary.sync_epoch!==receipt.database?.sync_epoch)
      fail("恢复隔离与节点身份不匹配");
    return {root,dbPath,receipt,receipt_sha256:file.sha256,summary};
  } finally {db.close();}
}
