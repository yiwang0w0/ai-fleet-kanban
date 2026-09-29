// Receiver epoch state. Authorization is node-wide; snapshot installation is per project.
import {createHash} from "node:crypto";
import {PeerError,uuid} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
export function migrateEpochState(db){
 db.exec([
  "CREATE TABLE IF NOT EXISTS federation_epoch_acceptances(acceptance_id TEXT PRIMARY KEY,origin_node_id TEXT NOT NULL,previous_epoch TEXT NOT NULL,new_epoch TEXT NOT NULL,plan_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(origin_node_id,new_epoch));",
  "CREATE TABLE IF NOT EXISTS federation_retired_epochs(origin_node_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,acceptance_id TEXT NOT NULL,PRIMARY KEY(origin_node_id,origin_epoch));",
  "CREATE TABLE IF NOT EXISTS federation_epoch_projects(origin_node_id TEXT NOT NULL,project_id TEXT NOT NULL,target_epoch TEXT NOT NULL,acceptance_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','installed')),updated_at TEXT NOT NULL,PRIMARY KEY(origin_node_id,project_id));",
  "CREATE TABLE IF NOT EXISTS federation_epoch_archive(acceptance_id TEXT NOT NULL,table_name TEXT NOT NULL,item_key TEXT NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(acceptance_id,table_name,item_key));",
  "CREATE TABLE IF NOT EXISTS federation_recovery_missing(task_uid TEXT PRIMARY KEY,owner_node_id TEXT NOT NULL,origin_epoch TEXT NOT NULL,project_id TEXT NOT NULL,replica_json TEXT NOT NULL,acceptance_id TEXT NOT NULL,resolved_at TEXT);",
  "CREATE TABLE IF NOT EXISTS federation_replica_locations(task_uid TEXT PRIMARY KEY,owner_node_id TEXT NOT NULL,project_id TEXT NOT NULL);",
  "INSERT OR IGNORE INTO federation_replica_locations SELECT task_uid,owner_node_id,project_id FROM federation_replicas;"
 ].join("\n"));
 if(db.prepare("SELECT 1 FROM federation_replicas r JOIN federation_replica_locations l USING(task_uid) WHERE r.owner_node_id<>l.owner_node_id OR r.project_id<>l.project_id LIMIT 1").get())fail("OWNER_MISMATCH","副本所有者或项目登记不一致");
}
export function assertSourceEpoch(db,origin,epoch){
 uuid(origin,"origin");uuid(epoch,"epoch");
 if(origin===localIdentity(db).node_id)fail("OWNER_MISMATCH","远端来源不能是本机");
 if(db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(origin,epoch))fail("RETIRED_EPOCH","该来源代次已经退役");
 const source=db.prepare("SELECT origin_epoch FROM federation_sources WHERE origin_node_id=?").get(origin);
 if(source){if(source.origin_epoch!==epoch)fail("EPOCH_CHANGED","来源代次变化，需要明确接纳恢复");return;}
 const prior=db.prepare("SELECT origin_epoch FROM federation_cursors WHERE origin_node_id=? UNION SELECT origin_epoch FROM federation_replicas WHERE owner_node_id=?").all(origin,origin);
 if(prior.some(p=>p.origin_epoch!==epoch))fail("EPOCH_CHANGED","已有副本代次不同，不能隐式重新接入");
}
export function pendingRecovery(db,{origin,epoch,projectId}){
 const row=db.prepare("SELECT * FROM federation_epoch_projects WHERE origin_node_id=? AND project_id=? AND state='pending'").get(origin,projectId);
 return row?.target_epoch===epoch?row:null;
}
/** Only approved pending snapshots use zero; persisted old cursors stay visible. */
export function replicationCursor(db,origin,epoch,projectId){
 assertSourceEpoch(db,origin,epoch);
 if(pendingRecovery(db,{origin,epoch,projectId}))return 0;
 const c=db.prepare("SELECT * FROM federation_cursors WHERE origin_node_id=? AND project_id=?").get(origin,projectId);
 if(c&&c.origin_epoch!==epoch)fail("EPOCH_CHANGED","项目尚未接纳该来源代次");
 return c?.seq??0;
}
export function bindReplicaLocation(db,uid,origin,projectId){
 const p=db.prepare("SELECT * FROM federation_replica_locations WHERE task_uid=?").get(uid);
 if(p&&(p.owner_node_id!==origin||p.project_id!==projectId))fail("OWNER_MISMATCH","任务不能在恢复时改换所有者或共享项目");
 db.prepare("INSERT OR IGNORE INTO federation_replica_locations VALUES(?,?,?)").run(uid,origin,projectId);
}
export function resolveRecoveryMissing(db,uid){
 db.prepare("UPDATE federation_recovery_missing SET resolved_at=? WHERE task_uid=? AND resolved_at IS NULL").run(new Date().toISOString(),uid);
}
/** Called only inside the verified final snapshot transaction. */
export function archiveRecoveryProject(db,source,events){
 const pending=pendingRecovery(db,source);if(!pending)return null;
 assertSourceEpoch(db,source.origin,source.epoch);
 const now=new Date().toISOString(),uids=new Set(events.map(e=>e.aggregate_uid));
 const put=db.prepare("INSERT INTO federation_epoch_archive VALUES(?,?,?,?)");
 for(const [table,owner,key] of [["federation_replicas","owner_node_id","task_uid"],["federation_cursors","origin_node_id","project_id"],["federation_snapshot_anchors","origin_node_id","project_id"]]){
  for(const row of db.prepare("SELECT * FROM "+table+" WHERE "+owner+"=? AND project_id=?").all(source.origin,source.projectId)){
   put.run(pending.acceptance_id,table,row[key],JSON.stringify(row));
   if(table==="federation_replicas"&&!uids.has(row.task_uid)&&!row.withdrawn)
    db.prepare("INSERT INTO federation_recovery_missing VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(task_uid) DO UPDATE SET origin_epoch=excluded.origin_epoch,replica_json=excluded.replica_json,acceptance_id=excluded.acceptance_id,resolved_at=NULL")
     .run(row.task_uid,row.owner_node_id,row.origin_epoch,row.project_id,JSON.stringify(row),pending.acceptance_id);
  }
 }
 db.prepare("DELETE FROM federation_replicas WHERE owner_node_id=? AND project_id=?").run(source.origin,source.projectId);
 db.prepare("UPDATE federation_epoch_projects SET state='installed',updated_at=? WHERE origin_node_id=? AND project_id=? AND acceptance_id=?").run(now,source.origin,source.projectId,pending.acceptance_id);
 return pending;
}
export function sourceRecoveryMarker(db){
 const local=localIdentity(db);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='board_recoveries'").get())return null;
 const row=db.prepare("SELECT receipt_json FROM board_recoveries WHERE json_extract(receipt_json,'$.new_epoch')=? ORDER BY rowid DESC LIMIT 1").get(local.sync_epoch);
 if(!row)return null;
 const r=JSON.parse(row.receipt_json);
 if(r.node_id!==local.node_id||r.format!=="ai-fleet-recovery/v1")fail("RECOVERY_INCONSISTENT","本机恢复回执与身份不匹配");
 return {format:"ai-fleet-source-recovery/v1",node_id:r.node_id,recovery_id:r.recovery_id,retired_epoch:r.retired_epoch,backup_epoch:r.backup_epoch,new_epoch:r.new_epoch,activated_at:r.activated_at,receipt_digest:createHash("sha256").update(row.receipt_json).digest("hex")};
}
