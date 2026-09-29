import {join} from "node:path";
import {PeerError,uuid} from "../federation/protocol.mjs";
import {localIdentity,transaction} from "../federation/peers.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {repositoryState,workspaceRepositorySource} from "./repositories.mjs";
import {allowedPaths,objectId} from "./git-reader.mjs";
import {directoryIdentity,verifyDirectory,overlaps,provisionGitWorkspace,verifyInitialWorkspace} from "./git-workspace.mjs";
import {inspectStoppedRuns} from "../execution/stop-proof.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const at=()=>new Date().toISOString();
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t);
function unit(db,work){if(!db.isTransaction)return transaction(db,work);db.exec("SAVEPOINT workspace_unit");try{const r=work();db.exec("RELEASE workspace_unit");return r;}catch(e){db.exec("ROLLBACK TO workspace_unit; RELEASE workspace_unit");throw e;}}
function schema(db){if(exists(db,"workspace_schema")&&db.prepare("SELECT version FROM workspace_schema").get()?.version!==1)fail("SCHEMA_INCOMPATIBLE","工作区存储版本不兼容");}
export function migrateWorkspaces(db){return unit(db,()=>{
 localIdentity(db);schema(db);
 if(!exists(db,"broker_dispatches"))fail("DISPATCH_SCHEMA_REQUIRED","请先初始化受管执行调度");
 db.exec([
  "CREATE TABLE IF NOT EXISTS workspace_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO workspace_schema VALUES(1,1);",
  "CREATE TABLE IF NOT EXISTS workspace_pools(pool_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,mapping_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(node_epoch,mapping_id));",
  "CREATE TABLE IF NOT EXISTS task_workspaces(workspace_id TEXT PRIMARY KEY,pool_id TEXT NOT NULL,dispatch_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL UNIQUE,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,binding_json TEXT NOT NULL,binding_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('provisioning','ready','failed','retained')),receipt_json TEXT,receipt_digest TEXT,failure_code TEXT,stop_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS workspace_events(id INTEGER PRIMARY KEY,workspace_id TEXT,pool_id TEXT NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TRIGGER IF NOT EXISTS workspace_binding_immutable BEFORE UPDATE OF workspace_id,pool_id,dispatch_id,run_id,node_id,node_epoch,binding_json,binding_digest,created_at ON task_workspaces BEGIN SELECT RAISE(ABORT,'workspace binding is immutable'); END;",
  "CREATE TRIGGER IF NOT EXISTS workspace_receipt_once BEFORE UPDATE OF receipt_json,receipt_digest ON task_workspaces WHEN OLD.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'workspace baseline receipt is immutable'); END;",
  "CREATE TRIGGER IF NOT EXISTS workspace_state_transitions BEFORE UPDATE OF state ON task_workspaces WHEN NOT(OLD.state='provisioning' AND NEW.state IN('ready','failed') OR OLD.state IN('ready','failed') AND NEW.state='retained') BEGIN SELECT RAISE(ABORT,'workspace state transition refused'); END;",
  "CREATE TRIGGER IF NOT EXISTS workspace_retained_immutable BEFORE UPDATE ON task_workspaces WHEN OLD.state='retained' BEGIN SELECT RAISE(ABORT,'retained workspace is immutable'); END;",
  // Existing adapters are board-only and cannot certify use of a task checkout.
  "CREATE TRIGGER IF NOT EXISTS workspace_unbound_launch BEFORE UPDATE OF launch_at ON broker_dispatches WHEN OLD.launch_at IS NULL AND NEW.launch_at IS NOT NULL AND EXISTS(SELECT 1 FROM task_workspaces WHERE dispatch_id=NEW.dispatch_id) BEGIN SELECT RAISE(ABORT,'WORKSPACE_ADAPTER_REQUIRED: board-only launch cannot consume task workspace'); END;"
 ].join("\n"));
 for(const t of ["workspace_pools","task_workspaces","workspace_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'workspace history must be retained'); END");
 for(const t of ["workspace_pools","workspace_events"])db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'workspace history is immutable'); END");
});}
function event(db,poolId,workspaceId,kind,detail){db.prepare("INSERT INTO workspace_events(pool_id,workspace_id,kind,detail_json,created_at) VALUES(?,?,?,?,?)").run(poolId,workspaceId,kind,canonical(detail),at());}
function current(db,r){const n=localIdentity(db);if(!r)fail("WORKSPACE_NOT_FOUND","本机登记不存在");if(r.node_id!==n.node_id||r.node_epoch!==n.sync_epoch)fail("WORKSPACE_RECOVERY_REQUIRED","旧代次工作区不可续用");return r;}
function pool(db,id){schema(db);uuid(id,"pool_id");return current(db,exists(db,"workspace_pools")?db.prepare("SELECT * FROM workspace_pools WHERE pool_id=?").get(id):null);}
function row(db,id){schema(db);uuid(id,"workspace_id");return current(db,exists(db,"task_workspaces")?db.prepare("SELECT * FROM task_workspaces WHERE workspace_id=?").get(id):null);}
function dispatch(db,id,{prepared=false}={}){
 uuid(id,"dispatch_id");const d=current(db,db.prepare("SELECT * FROM broker_dispatches WHERE dispatch_id=?").get(id));
 if(prepared){const t=db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(d.task_uid);
  if(d.phase!=="prepared"||d.launch_at||!t||t.run_id!==d.run_id||t.status!=="in_progress"||t.archived_at||t.aggregate_version!==d.claimed_version)fail("WORKSPACE_RUN_CHANGED","仅可为尚未启动且未变化的实际运行准备工作区");
 }
 return d;
}
const within=(path,policy)=>policy.some(p=>p.endsWith("/")?path.startsWith(p):path===p);
function pathOverlap(a,b){const x=a.toUpperCase(),y=b.toUpperCase();return x===y||y.startsWith(x.endsWith("/")?x:x+"/")||x.startsWith(y.endsWith("/")?y:y+"/");}
function publicRow(r){const b=JSON.parse(r.binding_json),receipt=r.receipt_json?JSON.parse(r.receipt_json):null;return {workspace_id:r.workspace_id,pool_id:r.pool_id,dispatch_id:r.dispatch_id,run_id:r.run_id,node_id:r.node_id,node_epoch:r.node_epoch,state:r.state,binding:b,binding_digest:r.binding_digest,baseline:receipt?{commit:receipt.manifest.commit,tree:receipt.manifest.tree,file_count:receipt.manifest.files.length,total_bytes:receipt.manifest.total_bytes,manifest_digest:digest(receipt.manifest)}:null,failure_code:r.failure_code,stop_proof:r.stop_json?JSON.parse(r.stop_json):null,filesystem_sandbox:false,executor_bound:false,accepted:false};}
/** Separate local authority for a complete history copy, not implied by artifact allowlists. */
export function registerWorkspacePool(db,{poolId,mappingId,root,allowFullHistoryCopy}){
 uuid(poolId,"pool_id");uuid(mappingId,"mapping_id");if(allowFullHistoryCopy!==true)fail("FULL_HISTORY_PERMISSION_REQUIRED","独立仓库副本需显式允许复制全部本机 Git 历史");
 const mapping=repositoryState(db,{mappingId}),source=workspaceRepositorySource(db,{mappingId,baseCommit:mapping.approved_bases[0].commit_oid}),identity=directoryIdentity(root);
 if(overlaps(source.root,identity.root)||overlaps(identity.root,source.root)||overlaps(source.common_dir,identity.root)||overlaps(identity.root,source.common_dir))fail("WORKSPACE_POOL_OVERLAP","工作区池与源仓库目录不能互相包含");
 const descriptor={identity,allow_full_history_copy:true};
 return unit(db,()=>{
  migrateWorkspaces(db);repositoryState(db,{mappingId});verifyDirectory(identity);const node=localIdentity(db),old=db.prepare("SELECT * FROM workspace_pools WHERE pool_id=?").get(poolId);
  if(old){current(db,old);if(old.mapping_id!==mappingId||old.descriptor_json!==canonical(descriptor))fail("REQUEST_CONFLICT","工作区池 ID 已绑定其他配置");return {pool_id:poolId,mapping_id:mappingId,full_history_copy_authorized:true};}
  if(db.prepare("SELECT 1 FROM workspace_pools WHERE node_epoch=? AND mapping_id=?").get(node.sync_epoch,mappingId))fail("WORKSPACE_POOL_EXISTS","该仓库已有工作区池");
  for(const p of db.prepare("SELECT descriptor_json FROM workspace_pools").all()){const other=JSON.parse(p.descriptor_json).identity.root;if(overlaps(other,identity.root)||overlaps(identity.root,other))fail("WORKSPACE_POOL_OVERLAP","工作区池不能与历史登记池重叠");}
  db.prepare("INSERT INTO workspace_pools VALUES(?,?,?,?,?,?)").run(poolId,node.node_id,node.sync_epoch,mappingId,canonical(descriptor),at());event(db,poolId,null,"pool_registered",{mapping_id:mappingId,full_history_copy_authorized:true});return {pool_id:poolId,mapping_id:mappingId,full_history_copy_authorized:true};
 });
}
export function workspaceState(db,{workspaceId}){return publicRow(row(db,workspaceId));}
export function workspaceConflicts(db,{workspaceId}){
 const r=row(db,workspaceId),binding=JSON.parse(r.binding_json),conflicts=[];
 for(const other of db.prepare("SELECT * FROM task_workspaces WHERE pool_id=? AND workspace_id<>? AND state IN('provisioning','ready') ORDER BY created_at,workspace_id").all(r.pool_id,workspaceId)){
  const b=JSON.parse(other.binding_json),paths=binding.write_paths.filter(a=>b.write_paths.some(p=>pathOverlap(a,p)));
  if(paths.length)conflicts.push({workspace_id:other.workspace_id,task_uid:b.task_uid,run_id:other.run_id,state:other.state,overlapping_paths:paths});
 }
 return {workspace_id:workspaceId,conflicts,kind:"declared_write_overlap",filesystem_isolated:true,merge_safe:false};
}
/** Local runner administration. Filesystem work happens only after the reservation commits. */
export function createTaskWorkspace(db,{workspaceId,poolId,dispatchId,baseCommit,writePaths}){
 if(db.isTransaction)fail("TRANSACTION_CONTEXT","工作区预留必须独立提交");
 uuid(workspaceId,"workspace_id");objectId(baseCommit);const writes=allowedPaths(writePaths),p=pool(db,poolId),mapping=repositoryState(db,{mappingId:p.mapping_id});
 if(writes.some(w=>!within(w,mapping.allowed_paths)))fail("PATH_NOT_ALLOWED","写入声明超出本机允许的产物范围");
 const request={pool_id:poolId,dispatch_id:dispatchId,base_commit:baseCommit,write_paths:writes};
 const old=exists(db,"task_workspaces")?db.prepare("SELECT * FROM task_workspaces WHERE workspace_id=?").get(workspaceId):null;
 if(old){current(db,old);const b=JSON.parse(old.binding_json);if(canonical(request)!==canonical({pool_id:old.pool_id,dispatch_id:old.dispatch_id,base_commit:b.base_commit,write_paths:b.write_paths}))fail("REQUEST_CONFLICT","工作区 ID 不能复用不同配置");return publicRow(old);}
 const source=workspaceRepositorySource(db,{mappingId:p.mapping_id,baseCommit}),identity=JSON.parse(p.descriptor_json).identity,container=join(identity.root,workspaceId);
 verifyDirectory(identity);
 transaction(db,()=>{
  pool(db,poolId);const d=dispatch(db,dispatchId,{prepared:true}),assignment=db.prepare("SELECT project_id FROM broker_assignments WHERE assignment_id=?").get(d.assignment_id);
  if(assignment.project_id!==mapping.project_id)fail("WORKSPACE_PROJECT_MISMATCH","任务与仓库不属于同一项目");
  if(overlaps(JSON.parse(d.source_json).code_root,identity.root)||overlaps(identity.root,JSON.parse(d.source_json).code_root))fail("WORKSPACE_POOL_OVERLAP","任务工作区与治理仓不能互相包含");
  if(db.prepare("SELECT 1 FROM task_workspaces WHERE dispatch_id=? OR workspace_id=?").get(dispatchId,workspaceId))fail("WORKSPACE_ALREADY_BOUND","同一运行已经预留工作区");
  if(db.prepare("SELECT count(*) n FROM task_workspaces WHERE pool_id=? AND state<>'retained'").get(poolId).n>=100)fail("WORKSPACE_CAPACITY","工作区池已有 100 个未保留工作区");
  const binding={schema_version:1,mapping_id:p.mapping_id,project_id:mapping.project_id,repo_id:mapping.repo_id,task_uid:d.task_uid,task_version:d.claimed_version,run_id:d.run_id,agent_instance_id:d.agent_instance_id,base_commit:baseCommit,base_tree:source.base_tree,write_paths:writes,full_history_copy_authorized:true};
  db.prepare("INSERT INTO task_workspaces(workspace_id,pool_id,dispatch_id,run_id,node_id,node_epoch,binding_json,binding_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'provisioning',?,?)").run(workspaceId,poolId,dispatchId,d.run_id,d.node_id,d.node_epoch,canonical(binding),digest(binding),at(),at());event(db,poolId,workspaceId,"reserved",{binding_digest:digest(binding)});
 });
 try{
  verifyDirectory(identity);const receipt=provisionGitWorkspace({source,baseCommit,container});verifyDirectory(identity);verifyInitialWorkspace(receipt);
  transaction(db,()=>{
   row(db,workspaceId);pool(db,poolId);dispatch(db,dispatchId,{prepared:true});workspaceRepositorySource(db,{mappingId:p.mapping_id,baseCommit});
   db.prepare("UPDATE task_workspaces SET state='ready',receipt_json=?,receipt_digest=?,updated_at=? WHERE workspace_id=? AND state='provisioning'").run(canonical(receipt),digest(receipt),at(),workspaceId);event(db,poolId,workspaceId,"ready",{manifest_digest:digest(receipt.manifest),filesystem_sandbox:false,executor_bound:false});
  });
 }catch(e){
  // Keep the directory, including a partial copy. Never infer that it is safe to delete or retry.
  try{transaction(db,()=>{const r=row(db,workspaceId);if(r.state!=="provisioning")return;const code=typeof e.code==="string"&&/^[A-Z_0-9]{1,80}$/.test(e.code)?e.code:"PROVISION_FAILED";db.prepare("UPDATE task_workspaces SET state='failed',failure_code=?,updated_at=? WHERE workspace_id=?").run(code,at(),workspaceId);event(db,poolId,workspaceId,"failed_preserved",{code});});}catch{}
  throw e;
 }
 return workspaceState(db,{workspaceId});
}
/** Local inspection only; paths are never exposed as peer/MCP arguments. */
export function taskWorkspaceDirectory(db,{workspaceId}){
 const r=row(db,workspaceId),p=pool(db,r.pool_id),identity=JSON.parse(p.descriptor_json).identity;verifyDirectory(identity);
 if(!r.receipt_json)fail("WORKSPACE_NOT_READY","工作区尚无完整准备回执");const receipt=JSON.parse(r.receipt_json);
 if(digest(receipt)!==r.receipt_digest)fail("WORKSPACE_RECEIPT_CORRUPT","工作区回执摘要不一致");for(const i of Object.values(receipt.identities))verifyDirectory(i);
 return receipt.identities.repo.root;
}
export function retainTaskWorkspace(db,{workspaceId,reason}){
 if(typeof reason!=="string"||!reason.trim()||reason.length>1000)fail("BAD_INPUT","需要保留原因");
 return unit(db,()=>{
  const r=row(db,workspaceId);if(r.state==="retained")return publicRow(r);if(!["ready","failed"].includes(r.state))fail("WORKSPACE_PROVISIONING","准备尚未结束，不能声明保留完成");
  const run=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(r.run_id);if(!run)fail("WORKSPACE_RUN_MISSING","运行记录缺失");
  const stopped=inspectStoppedRuns(db,{nodeId:r.node_id,nodeEpoch:r.node_epoch,members:[],runs:[run]});
  if(stopped.blockers.length)fail("WORKSPACE_RUN_NOT_STOPPED","运行尚无已核验的停止证明");
  const receipt={reason,proofs:stopped.proofs,fixture_runs:stopped.fixtureRuns,physical_files_deleted:false};
  db.prepare("UPDATE task_workspaces SET state='retained',stop_json=?,updated_at=? WHERE workspace_id=?").run(canonical(receipt),at(),workspaceId);event(db,r.pool_id,workspaceId,"retained",receipt);return publicRow(row(db,workspaceId));
 });
}
export function assertWorkspaceLaunchSupported(db,dispatchId){schema(db);if(exists(db,"task_workspaces")&&db.prepare("SELECT 1 FROM task_workspaces WHERE dispatch_id=?").get(dispatchId))fail("WORKSPACE_ADAPTER_REQUIRED","任务工作区执行合同尚未接通；board-only 配置不能消费本次启动许可");}
