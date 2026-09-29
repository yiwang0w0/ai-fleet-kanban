// Local operator recovery. No network access, service startup, model calls or automatic task release.
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {lstatSync,realpathSync,existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from "node:fs";
import {dirname,isAbsolute,join} from "node:path";
import {createRequire} from "node:module";
import {inspectRestore} from "./backup.mjs";
import {PeerError,uuid,keys} from "./federation/protocol.mjs";
import {canonical,digest,atomic} from "./federation/sync-store.mjs";
const store=createRequire(import.meta.url)("./store.js");
const PLAN="ai-fleet-recovery-plan/v1",ATTESTATION="ai-fleet-retirement-attestation/v1";
const at=()=>new Date().toISOString();
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const count=(db,name)=>has(db,name)?db.prepare("SELECT count(*) n FROM "+quoted(name)).get().n:0;
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
function rawIdentity(db){
 const row=db.prepare("SELECT * FROM board_node WHERE singleton=1").get();
 if(!row)fail("IDENTITY_MISSING","缺少节点身份");
 uuid(row.node_id,"node_id");uuid(row.sync_epoch,"sync_epoch");return row;
}
function databasePath(file){
 if(!isAbsolute(file)||!existsSync(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())fail("BAD_DATABASE","需要绝对路径的普通数据库文件");
 const full=realpathSync(file);
 if(existsSync(join(dirname(full),".incomplete")))fail("RESTORE_HOLD","数据库目录尚未完成");
 return full;
}
function openDatabase(path,readOnly=false){
 const db=new DatabaseSync(databasePath(path),{readOnly});
 db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
 return db;
}
export function readRecoveryJSON(file){
 if(!isAbsolute(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||lstatSync(file).size>1024*1024)fail("BAD_INPUT","恢复输入需为 1 MiB 内的普通文件绝对路径");
 return JSON.parse(readFileSync(file,"utf8"));
}
export function writeRecoveryJSON(file,value){
 if(!isAbsolute(file))fail("BAD_INPUT","输出文件必须使用绝对路径");
 const fd=openSync(file,"wx",0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+"\n");fsyncSync(fd);}finally{closeSync(fd);}
}
/** Includes live WAL-visible rows and schema, not only the main DB file bytes. */
export function recoveryFingerprint(db){
 const h=createHash("sha256"),schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 h.update(canonical(schema));
 for(const table of schema.filter(s=>s.type==="table")){
  const info=db.prepare("PRAGMA table_info("+quoted(table.name)+")").all(),pk=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk);
  const order=pk.length?pk.map(c=>quoted(c.name)).join(","):"rowid";
  h.update(table.name+"\n");
  for(const row of db.prepare("SELECT * FROM "+quoted(table.name)+" ORDER BY "+order).iterate())h.update(canonical(row)+"\n");
 }
 return h.digest("hex");
}
function inspect(db){
 const node=rawIdentity(db),life=has(db,"board_lifecycle")?db.prepare("SELECT * FROM board_lifecycle").get():null;
 return {node_id:node.node_id,display_name:node.display_name,sync_epoch:node.sync_epoch,
  state:has(db,"board_restore_hold")?"restore_hold":life?.state??"active",
  tasks:count(db,"tasks"),events:count(db,"task_events"),
  active_runs:has(db,"task_runs")?db.prepare("SELECT count(*) n FROM task_runs WHERE state='running'").get().n:0,
  shared_tasks:count(db,"federation_shares"),registered_peers:count(db,"federation_peers"),
  retirements:has(db,"board_retirements")?db.prepare("SELECT receipt_json FROM board_retirements ORDER BY rowid").all().map(r=>JSON.parse(r.receipt_json)):[],
  recoveries:has(db,"board_recoveries")?db.prepare("SELECT receipt_json FROM board_recoveries ORDER BY rowid").all().map(r=>JSON.parse(r.receipt_json)):[]};
}
export function recoveryStatus(dbPath){
 const db=openDatabase(dbPath,true);try{return inspect(db);}finally{db.close();}
}
export function prepareRecovery({dbPath,retiredEpoch}){
 dbPath=databasePath(dbPath);
 if(dbPath!==join(dirname(dbPath),"board.db"))fail("BAD_DATABASE","恢复数据库必须使用恢复目录中的 board.db");
 const restored=inspectRestore(dirname(dbPath)),db=openDatabase(dbPath,true);
 try{
  db.exec("BEGIN"); // one consistent read view, including WAL
  const status=inspect(db),node=rawIdentity(db);
  if(status.state!=="restore_hold")fail("RESTORE_HOLD","只对已隔离恢复副本生成计划");
  if(!has(db,"task_runs")||!db.prepare("PRAGMA table_info(tasks)").all().some(c=>c.name==="aggregate_version"))fail("SCHEMA_INCOMPATIBLE","备份尚未具有执行实例与版本字段，需要先迁移备份");
  retiredEpoch??=node.sync_epoch;uuid(retiredEpoch,"retired_epoch");
  const plan={format:PLAN,plan_id:randomUUID(),node_id:node.node_id,backup_epoch:node.sync_epoch,retired_epoch:retiredEpoch,
   backup_id:restored.receipt.backup_id,database_path:dbPath,state_digest:recoveryFingerprint(db),
   restored_database_sha256:restored.receipt.restored_database_sha256,restore_receipt_digest:restored.receipt_sha256,
   evidence_files:restored.receipt.evidence_files,counts:{tasks:status.tasks,events:status.events,active_runs:status.active_runs,shared_tasks:status.shared_tasks,registered_peers:status.registered_peers},created_at:at()};
  return {...plan,plan_digest:digest(plan)};
 }finally{if(db.isTransaction)db.exec("ROLLBACK");db.close();}
}
function validatePlan(plan,expectedDigest,dbPath){
 keys(plan,["format","plan_id","node_id","backup_epoch","retired_epoch","backup_id","database_path","state_digest","restored_database_sha256","restore_receipt_digest","evidence_files","counts","created_at","plan_digest"],"recovery plan");
 if(Object.keys(plan).length!==14||!Number.isFinite(Date.parse(plan.created_at)))fail("PLAN_CHANGED","恢复计划字段不完整");
 keys(plan.counts,["tasks","events","active_runs","shared_tasks","registered_peers"],"plan counts");
 if(Object.keys(plan.counts).length!==5||Object.values(plan.counts).some(n=>!Number.isSafeInteger(n)||n<0))fail("PLAN_CHANGED","恢复计划计数无效");
 const {plan_digest,...body}=plan;
 if(plan.format!==PLAN||typeof expectedDigest!=="string"||plan_digest!==expectedDigest||plan_digest!==digest(body)||plan.database_path!==dbPath)fail("PLAN_CHANGED","恢复计划与已核对摘要或数据库不一致");
 for(const k of ["plan_id","node_id","backup_epoch","retired_epoch","backup_id"])uuid(plan[k],k);
}
function validateAttestation(proof,plan){
 keys(proof,["format","node_id","retired_epoch","plan_digest","original_board_stopped","original_agents_stopped","original_identity_disabled","other_restored_writers_stopped","evidence_ref","attested_at"],"retirement attestation");
 if(proof.format!==ATTESTATION||proof.node_id!==plan.node_id||proof.retired_epoch!==plan.retired_epoch||proof.plan_digest!==plan.plan_digest)
  fail("ATTESTATION_MISMATCH","退役声明未绑定此节点、旧 epoch 和已核对恢复计划");
 for(const key of ["original_board_stopped","original_agents_stopped","original_identity_disabled","other_restored_writers_stopped"])
  if(proof[key]!==true)fail("RETIREMENT_REQUIRED","必须先确认原服务、原执行器及其他副本停止，并停用旧身份");
 if(typeof proof.evidence_ref!=="string"||proof.evidence_ref.trim().length<8||proof.evidence_ref.length>2048||!Number.isFinite(Date.parse(proof.attested_at)))
  fail("RETIREMENT_REQUIRED","需要可核对的停机证据引用与声明时间");
}
function recoveryTables(db){
 db.exec("CREATE TABLE IF NOT EXISTS board_retirements(retirement_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL);"+
  "CREATE TABLE IF NOT EXISTS board_recoveries(recovery_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL);"+
  "CREATE TABLE IF NOT EXISTS board_recovery_archive(recovery_id TEXT NOT NULL,table_name TEXT NOT NULL,ordinal INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(recovery_id,table_name,ordinal))");
}
function archive(db,id,table){
 if(!has(db,table))return 0;
 const put=db.prepare("INSERT INTO board_recovery_archive VALUES(?,?,?,?)");let n=0;
 for(const row of db.prepare("SELECT * FROM "+quoted(table)+" ORDER BY rowid").iterate())put.run(id,table,n++,canonical(row));
 return n;
}
function stopTaskWrites(db,reason,id){
 const tasks=db.prepare("SELECT id,status,run_id FROM tasks").all(),now=at();
 if(has(db,"result_recovery_permits")&&db.prepare("SELECT 1 FROM result_recovery_permits LIMIT 1").get())fail("RECOVERY_PERMIT_EXISTS","交付恢复许可必须为空");
 if(db.prepare("SELECT 1 FROM tasks WHERE aggregate_version>=9007199254740989 LIMIT 1").get()||
   has(db,"federation_shares")&&db.prepare("SELECT 1 FROM federation_shares WHERE revision>=9007199254740989 LIMIT 1").get())fail("VERSION_EXHAUSTED","任务或发布版本已达安全上限");
 const update=db.prepare("UPDATE tasks SET released=0,run_id=NULL,worker=CASE WHEN status='in_progress' THEN NULL ELSE worker END,lease_until=NULL,heartbeat_at=NULL,status=CASE WHEN status='in_progress' THEN 'waiting' ELSE status END,waiting_for=CASE WHEN status='in_progress' THEN 'decision' ELSE waiting_for END,updated_at=? WHERE id=?");
 const event=db.prepare("INSERT INTO task_events(at,task_id,kind,actor,detail) VALUES(?,?,'node_recovery','operator',?)");
 for(const t of tasks){
  // Private, transaction-scoped exception for quarantining sealed result tasks.
  // It cannot release work, manufacture a result decision or outlive rollback.
  const sealed=has(db,"result_recovery_permits");
  if(sealed)db.prepare("INSERT INTO result_recovery_permits VALUES(?)").run(t.id);
  update.run(now,t.id);event.run(now,t.id,canonical({operation:reason,receipt_id:id,previous_run_id:t.run_id,previous_status:t.status,release_required:true}));
  if(sealed)db.prepare("DELETE FROM result_recovery_permits WHERE task_id=?").run(t.id);
 }
 return tasks.filter(t=>t.status==="in_progress").length;
}
function revokeAll(db,reason){
 if(!has(db,"federation_peers"))return 0;
 const peers=db.prepare("SELECT * FROM federation_peers WHERE status='active'").all();
 for(const p of peers){
  if(p.credential_version>=Number.MAX_SAFE_INTEGER)fail("VERSION_EXHAUSTED","对端凭据版本已达安全上限");
  const version=p.credential_version+1,now=at();
  db.prepare("UPDATE federation_peers SET status='revoked',secret_hash='',credential_version=?,updated_at=? WHERE peer_node_id=?").run(version,now,p.peer_node_id);
  db.prepare("INSERT INTO federation_auth_events(peer_node_id,credential_version,action,at) VALUES(?,?,?,?)").run(p.peer_node_id,version,reason,now);
 }
 return peers.length;
}
export function retireNode({dbPath,expectedEpoch}){
 uuid(expectedEpoch,"expected_epoch");const db=openDatabase(dbPath);
 try{return atomic(db,()=>{
  const node=rawIdentity(db);
  if(has(db,"board_restore_hold"))fail("RESTORE_HOLD","恢复副本不能充当原节点退役回执");
  if(node.sync_epoch!==expectedEpoch)fail("EPOCH_CHANGED","节点 epoch 已改变，拒绝退役旧观察值");
  if(has(db,"board_lifecycle")&&db.prepare("SELECT state FROM board_lifecycle").get().state==="retired")fail("NODE_RETIRED","节点已退役，可查询现有回执");
  store.migrateLifecycle(db);recoveryTables(db);
  const id=randomUUID(),before=recoveryFingerprint(db);archive(db,id,"tasks");
  const stopped=stopTaskWrites(db,"retire",id),revoked=revokeAll(db,"retire_revoke");
  const receipt={format:"ai-fleet-retirement/v1",retirement_id:id,node_id:node.node_id,retired_epoch:node.sync_epoch,
   retired_at:at(),previous_state_digest:before,task_writes_disabled:true,runs_ended:stopped,credentials_revoked:revoked,
   process_termination:"not_verified",physical_single_writer:"not_verified"};
  db.prepare("INSERT INTO board_retirements VALUES(?,?)").run(id,canonical(receipt));
  db.prepare("UPDATE board_lifecycle SET state='retired',updated_at=? WHERE singleton=1").run(at());
  return receipt;
 });}finally{db.close();}
}
export function activateRecovery({dbPath,plan,expectedPlanDigest,attestation}){
 dbPath=databasePath(dbPath);validatePlan(plan,expectedPlanDigest,dbPath);validateAttestation(attestation,plan);
 // Verify external evidence again immediately before taking the final database transaction.
 const restored=inspectRestore(dirname(dbPath));
 if(restored.receipt_sha256!==plan.restore_receipt_digest||restored.receipt.restored_database_sha256!==plan.restored_database_sha256)fail("PLAN_CHANGED","恢复回执已变化");
 const db=openDatabase(dbPath);
 try{return atomic(db,()=>{
  const node=rawIdentity(db),hold=db.prepare("SELECT backup_id FROM board_restore_hold").all();
  if(hold.length!==1||hold[0].backup_id!==plan.backup_id||node.node_id!==plan.node_id||node.sync_epoch!==plan.backup_epoch||recoveryFingerprint(db)!==plan.state_digest)
   fail("PLAN_CHANGED","数据库、隔离标记或计划状态已变化");
  const actual=inspect(db);
  if(Object.entries(plan.counts).some(([key,value])=>actual[key]!==value))fail("PLAN_CHANGED","计划列出的影响范围与当前恢复副本不一致");
  const guard=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='node_identity_immutable'").get()?.sql;
  if(!guard)fail("IDENTITY_GUARD_MISSING","节点身份保护缺失，拒绝激活");
  store.migrateLifecycle(db);recoveryTables(db);
  // Still quarantined until the last statement of this transaction.
  db.prepare("UPDATE board_lifecycle SET state='active',updated_at=? WHERE singleton=1").run(at());
  const recoveryId=randomUUID(),newEpoch=randomUUID(),archives={};
  archives.tasks=archive(db,recoveryId,"tasks");
  const stopped=stopTaskWrites(db,"activate",recoveryId),revoked=revokeAll(db,"recovery_revoke");
  const outgoing=["federation_outbox","federation_streams","federation_published","federation_retention","federation_deliveries","federation_snapshots","federation_snapshot_items","federation_snapshot_offers","federation_dirty"];
  const deleteGuard=db.prepare("SELECT sql FROM sqlite_master WHERE name='federation_outbox_no_delete'").get()?.sql;
  if(has(db,"federation_outbox")&&!deleteGuard)fail("IDENTITY_GUARD_MISSING","事件删除保护缺失");
  if(deleteGuard)db.exec("DROP TRIGGER federation_outbox_no_delete");
  for(const table of outgoing)if(has(db,table)){archives[table]=archive(db,recoveryId,table);db.exec("DELETE FROM "+quoted(table));}
  if(deleteGuard)db.exec(deleteGuard);
  if(has(db,"federation_shares")){
   db.exec("UPDATE federation_shares SET revision=revision+1");
   db.exec("INSERT OR IGNORE INTO federation_dirty SELECT task_id FROM federation_shares");
  }
  db.exec("DROP TRIGGER node_identity_immutable");
  db.prepare("UPDATE board_node SET sync_epoch=?,updated_at=? WHERE singleton=1").run(newEpoch,at());
  db.exec(guard);
  const receipt={format:"ai-fleet-recovery/v1",recovery_id:recoveryId,node_id:node.node_id,backup_epoch:node.sync_epoch,
   retired_epoch:plan.retired_epoch,new_epoch:newEpoch,backup_id:plan.backup_id,plan_digest:plan.plan_digest,
   retirement_attestation_digest:digest(attestation),retirement_evidence:"operator_attested_not_machine_verified",
   activated_at:at(),runs_ended:stopped,credentials_revoked:revoked,archive_counts:archives,tasks_released:0,
   peer_reauthorization_required:true,peer_epoch_acceptance_required:true,services_started:false};
  db.prepare("INSERT INTO board_recoveries VALUES(?,?)").run(recoveryId,canonical(receipt));
  db.exec("DROP TABLE board_restore_hold");
  return receipt;
 });}finally{db.close();}
}
