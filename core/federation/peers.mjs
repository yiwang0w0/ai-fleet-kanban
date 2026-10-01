import {writePrivateJSON} from "../private-json.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PeerError, SCOPES, uuid, names, version } from "./protocol.mjs";

const hash = token => createHash("sha256").update(token).digest();
const at = () => new Date().toISOString();
export function localIdentity(db) {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_lifecycle'").get() && db.prepare("SELECT state FROM board_lifecycle WHERE singleton=1").get()?.state==="retired")
    throw new PeerError("NODE_RETIRED","节点已退役，不能参与通信或写入",409);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_restore_hold'").get())
    throw new PeerError("RESTORE_HOLD", "恢复副本尚未激活，不能参与节点通信", 409);
  const local = db.prepare("SELECT node_id,display_name,sync_epoch,protocol_version FROM board_node WHERE singleton=1").get();
  if (!local) throw new PeerError("IDENTITY_MISSING", "请先初始化本地看板身份", 409);
  uuid(local.node_id, "local node_id"); uuid(local.sync_epoch, "local sync_epoch");
  if (local.protocol_version !== 1) throw new PeerError("SCHEMA_INCOMPATIBLE", "本地身份格式不兼容", 409);
  return local;
}
export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}
/** A consistent deferred snapshot; unlike transaction(), it does not reserve the WAL writer. */
export function readTransaction(db,work){
  if(db.isTransaction)return work();
  db.exec("BEGIN");
  try{const result=work();db.exec("COMMIT");return result;}
  catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
}
export function migratePeers(db) {
  transaction(db, () => {
    localIdentity(db);
    db.exec([
      "CREATE TABLE IF NOT EXISTS federation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);",
      "INSERT OR IGNORE INTO federation_schema VALUES(1,1);",
    ].join("\n"));
    if (db.prepare("SELECT version FROM federation_schema WHERE singleton=1").get().version !== 1)
      throw new PeerError("SCHEMA_INCOMPATIBLE", "联邦存储格式不兼容，拒绝迁移", 409);
    db.exec([
      "CREATE TABLE IF NOT EXISTS federation_peers(",
      "peer_node_id TEXT PRIMARY KEY, peer_epoch TEXT NOT NULL, key_id TEXT NOT NULL UNIQUE,",
      "credential_version INTEGER NOT NULL CHECK(credential_version BETWEEN 1 AND 9007199254740991),",
      "secret_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),",
      "scopes_json TEXT NOT NULL, projects_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS federation_auth_events(",
      "id INTEGER PRIMARY KEY AUTOINCREMENT, peer_node_id TEXT NOT NULL,",
      "credential_version INTEGER NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);"
    ].join("\n"));
  });
}
export function openPeerDatabase(dbPath) {
  if (!isAbsolute(dbPath) || !existsSync(dbPath) || !lstatSync(dbPath).isFile())
    throw new PeerError("BAD_DATABASE", "必须指定已初始化看板数据库的绝对路径", 400);
  if (existsSync(join(dirname(dbPath), ".incomplete")) ||
      existsSync(join(dirname(realpathSync(dbPath)), ".incomplete")))
    throw new PeerError("RESTORE_HOLD", "备份或恢复尚未完成", 409);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    localIdentity(db); migratePeers(db);
    return db;
  } catch (e) { db.close(); throw e; }
}
function rejectRetiredPeer(db,node,epoch) {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'federation_retired_epochs\'").get() && db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(node,epoch))
    throw new PeerError("RETIRED_EPOCH","对端代次已退役，不能重新授权或访问节点",403);
}
function publicPeer(p) {
  return {peer_node_id:p.peer_node_id,peer_epoch:p.peer_epoch,key_id:p.key_id,
    credential_version:p.credential_version,status:p.status,
    scopes: names(JSON.parse(p.scopes_json), "stored scopes", SCOPES, 1),
    projects: names(JSON.parse(p.projects_json), "stored projects", null, 1),
    created_at:p.created_at,updated_at:p.updated_at};
}
export function listPeers(db) {
  localIdentity(db);
  return db.prepare("SELECT * FROM federation_peers ORDER BY peer_node_id").all().map(publicPeer);
}
function checkRevision(previous, expectedVersion) {
  if (!previous) {
    if (expectedVersion !== undefined) throw new PeerError("CONFLICT", "对端尚未登记，不能替换旧版本", 409);
  } else {
    version(expectedVersion);
    if (expectedVersion !== previous.credential_version)
      throw new PeerError("CONFLICT", "凭据版本已变化，请重新核对", 409);
    if (previous.credential_version === Number.MAX_SAFE_INTEGER) throw new PeerError("CONFLICT", "凭据版本已达上限", 409);
  }
}
/** Local administration only. Secret leaves this function only through the exclusive file. */
export function issueCredential(db, {peerNodeId, peerEpoch, scopes, projects, expectedVersion, credentialFile}) {
  uuid(peerNodeId, "peer_node_id"); uuid(peerEpoch, "peer_epoch");
  scopes = names(scopes, "scopes", SCOPES, 1); projects = names(projects, "projects", null, 1);
  if (typeof credentialFile !== "string" || !isAbsolute(credentialFile))
    throw new PeerError("BAD_INPUT", "凭据文件需要新文件的绝对路径", 400);
  let created = false;
  try {
    return transaction(db, () => {
      const local = localIdentity(db);
      rejectRetiredPeer(db,peerNodeId,peerEpoch);
      if (peerNodeId === local.node_id) throw new PeerError("IDENTITY_CONFLICT", "不能登记本机为对端；检查克隆身份", 409);
      const previous = db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(peerNodeId);
      checkRevision(previous, expectedVersion);
      const credentialVersion = (previous?.credential_version ?? 0) + 1;
      const keyId = randomUUID(), token = keyId + "." + randomBytes(32).toString("base64url"), ts = at();
      const credential = {format:1,server_node_id:local.node_id,server_epoch:local.sync_epoch,
        peer_node_id:peerNodeId,peer_epoch:peerEpoch,key_id:keyId,credential_version:credentialVersion,
        scopes,projects,token};
      writePrivateJSON(credentialFile,credential); created = true;
      db.prepare("INSERT INTO federation_peers VALUES(?,?,?,?,?,'active',?,?,?,?) " +
        "ON CONFLICT(peer_node_id) DO UPDATE SET peer_epoch=excluded.peer_epoch,key_id=excluded.key_id," +
        "credential_version=excluded.credential_version,secret_hash=excluded.secret_hash,status='active'," +
        "scopes_json=excluded.scopes_json,projects_json=excluded.projects_json,updated_at=excluded.updated_at")
        .run(peerNodeId,peerEpoch,keyId,credentialVersion,hash(token).toString("hex"),JSON.stringify(scopes),JSON.stringify(projects),ts,ts);
      db.prepare("INSERT INTO federation_auth_events(peer_node_id,credential_version,action,at) VALUES(?,?,?,?)")
        .run(peerNodeId,credentialVersion,previous ? "replace" : "issue",ts);
      return {peer_node_id:peerNodeId,credential_version:credentialVersion,key_id:keyId,scopes,projects,credential_file:resolve(credentialFile)};
    });
  } catch (e) {
    // Only the file created exclusively by this call may be removed on rollback.
    if (created) { try { unlinkSync(credentialFile); } catch {} }
    throw e;
  }
}
export function revokePeer(db, {peerNodeId, expectedVersion}) {
  uuid(peerNodeId,"peer_node_id");
  return transaction(db, () => {
    localIdentity(db);
    const p = db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(peerNodeId);
    if (!p) throw new PeerError("NOT_FOUND","对端未登记",404);
    checkRevision(p,expectedVersion);
    const next = p.credential_version + 1, ts = at();
    db.prepare("UPDATE federation_peers SET credential_version=?,status='revoked',secret_hash='',updated_at=? WHERE peer_node_id=?").run(next,ts,peerNodeId);
    db.prepare("INSERT INTO federation_auth_events(peer_node_id,credential_version,action,at) VALUES(?,?,'revoke',?)").run(peerNodeId,next,ts);
    return {peer_node_id:peerNodeId,credential_version:next,status:"revoked"};
  });
}
export function authenticate(db, authorization, scope) {
  const m = typeof authorization === "string" && authorization.match(/^Bearer ([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})$/);
  const token = m ? m[1] : "", keyId = token.split(".")[0];
  const p = db.prepare("SELECT * FROM federation_peers WHERE key_id=?").get(keyId);
  const expected = p?.status === "active" && /^[0-9a-f]{64}$/.test(p.secret_hash) ? Buffer.from(p.secret_hash,"hex") : Buffer.alloc(32);
  const equal = timingSafeEqual(hash(token),expected);
  if (!m || !p || p.status !== "active" || !equal) throw new PeerError("UNAUTHENTICATED","需要有效的独立对端凭据",401);
  localIdentity(db); // Lifecycle state is disclosed only after credential verification.
  rejectRetiredPeer(db,p.peer_node_id,p.peer_epoch);
  const peer = publicPeer(p);
  if (scope && !peer.scopes.includes(scope)) throw new PeerError("FORBIDDEN","对端凭据不包含所需权限",403);
  return peer;
}
