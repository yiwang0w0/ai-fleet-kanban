// Local operator evidence stays separate from authenticated supervisor observations.
import {digest} from '../federation/sync-store.mjs';
import {fail} from '../mcp/policy.mjs';
export function migrateExecutionResolutions(db){
 db.exec("CREATE TABLE IF NOT EXISTS broker_execution_resolution_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO broker_execution_resolution_schema VALUES(1,1)");
 if(db.prepare('SELECT version FROM broker_execution_resolution_schema').get().version!==1)fail('SCHEMA_INCOMPATIBLE','运行人工恢复记录版本不兼容');
 db.exec("CREATE TABLE IF NOT EXISTS broker_execution_resolutions(dispatch_id TEXT PRIMARY KEY REFERENCES broker_dispatches(dispatch_id),plan_digest TEXT NOT NULL,plan_json TEXT NOT NULL,attestation_digest TEXT NOT NULL,attestation_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS broker_execution_resolution_immutable BEFORE UPDATE ON broker_execution_resolutions BEGIN SELECT RAISE(ABORT,'execution resolution is immutable'); END; CREATE TRIGGER IF NOT EXISTS broker_execution_resolution_retained BEFORE DELETE ON broker_execution_resolutions BEGIN SELECT RAISE(ABORT,'execution resolution is retained'); END;");
}
export function executionResolution(db,dispatchId){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='broker_execution_resolutions'").get())return null;
 const r=db.prepare('SELECT * FROM broker_execution_resolutions WHERE dispatch_id=?').get(dispatchId);if(!r)return null;
 if(db.prepare('SELECT version FROM broker_execution_resolution_schema WHERE singleton=1').get()?.version!==1)fail('SCHEMA_INCOMPATIBLE','运行人工恢复记录版本不兼容');
 const receipt=JSON.parse(r.receipt_json),plan=JSON.parse(r.plan_json),attestation=JSON.parse(r.attestation_json),{plan_digest,...payload}=plan;
 if(digest(payload)!==r.plan_digest||plan_digest!==r.plan_digest||digest(attestation)!==r.attestation_digest||digest(receipt)!==r.receipt_digest||receipt.dispatch_id!==dispatchId||receipt.plan_digest!==r.plan_digest||receipt.attestation_digest!==r.attestation_digest)fail('RESOLUTION_CORRUPT','人工恢复记录摘要不匹配');
 return receipt;
}
