import {PeerError,keys,uuid} from "../federation/protocol.mjs";
import {localIdentity,transaction} from "../federation/peers.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {migrateResults,resultState} from "../federation/results.mjs";
import {bindingState} from "../federation/bindings.mjs";
import {migrateRepositories,repositoryState,workspaceRepositorySource} from "./repositories.mjs";
import {repositoryReader} from "./git-reader.mjs";
import {captureWorkspacePackage} from "./workspace-commit.mjs";
import {validateDeliveryManifest,verifyGitPackage,base64Bytes,contentHash,MAX_PACKAGE_BYTES} from "./git-package.mjs";
export const CHUNK_BYTES=64*1024,MAX_ARTIFACT_STORAGE=256*1024*1024,MAX_ARTIFACT_HEADER=272*1024;
const at=()=>new Date().toISOString(),hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
function exact(v,fields){keys(v,fields,"artifact");if(Object.keys(v).length!==fields.length)fail("BAD_ARTIFACT","产物字段缺失",400);}
function unit(db,work){if(!db.isTransaction)return transaction(db,work);db.exec("SAVEPOINT artifact_unit");try{const r=work();db.exec("RELEASE artifact_unit");return r;}catch(e){db.exec("ROLLBACK TO artifact_unit; RELEASE artifact_unit");throw e;}}
export function migrateArtifacts(db){return unit(db,()=>{
 migrateResults(db);migrateRepositories(db);
 db.exec("CREATE TABLE IF NOT EXISTS artifact_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO artifact_schema VALUES(1,1)");
 if(db.prepare("SELECT version FROM artifact_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","产物存储版本不兼容");
 db.exec([
  "CREATE TABLE IF NOT EXISTS artifact_targets(result_id TEXT PRIMARY KEY,mapping_id TEXT NOT NULL,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,base_commit TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS artifact_transfers(transfer_id TEXT PRIMARY KEY,result_id TEXT NOT NULL UNIQUE,side TEXT NOT NULL CHECK(side IN('source','target')),node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,header_json TEXT NOT NULL,header_digest TEXT NOT NULL,payload_bytes INTEGER NOT NULL CHECK(payload_bytes>0 AND payload_bytes<=50331648),payload BLOB,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS artifact_chunks(transfer_id TEXT NOT NULL,chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),content BLOB NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(transfer_id,chunk_index));",
  "CREATE TABLE IF NOT EXISTS artifact_receipts(transfer_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('artifact_received','artifact_content_verified')),receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(transfer_id,kind));",
  "CREATE TABLE IF NOT EXISTS artifact_events(id INTEGER PRIMARY KEY,transfer_id TEXT,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);"
 ].join("\n"));
 for(const t of ["artifact_targets","artifact_transfers","artifact_chunks","artifact_receipts","artifact_events"]){db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'artifact history is immutable'); END");db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'artifact history must be retained'); END");}
});}
function event(db,id,kind,detail){db.prepare("INSERT INTO artifact_events(transfer_id,kind,detail_json,created_at) VALUES(?,?,?,?)").run(id,kind,canonical(detail),at());}
function pending(db,resultId,side){
 const r=resultState(db,resultId);if(side&&r.side!==side)fail("FORBIDDEN","产物端点方向不匹配",403);
 if(r.review_state!=="pending_evidence")fail("RESULT_NOT_PENDING","交付已取消、退回或执行未成功");
 const b=bindingState(db,r.relation_id);if(b.state!=="confirmed"||b.side!==r.side||canonical(b.relation)!==canonical(r.body.relation))fail("CONTRACT_MISMATCH","交付合同不再有效");return r;
}
function peerGrant(db,r,peer){
 const d=r.body.relation,p=db.prepare("SELECT * FROM federation_peers WHERE peer_node_id=?").get(d.target_node_id);
 if(r.side!=="source"||!p||p.status!=="active"||p.peer_epoch!==d.target_epoch||!JSON.parse(p.projects_json).includes(d.project_id)||!["delegation:result","artifact:write"].every(s=>JSON.parse(p.scopes_json).includes(s)))fail("FORBIDDEN","产物发送端没有当前项目授权",403);
 if(peer&&(peer.peer_node_id!==p.peer_node_id||peer.peer_epoch!==p.peer_epoch||peer.credential_version!==p.credential_version||!peer.projects.includes(d.project_id)||!["delegation:result","artifact:write"].every(s=>peer.scopes.includes(s))))fail("FORBIDDEN","产物凭据已变更",403);
 if(db.prepare("SELECT 1 FROM federation_retired_epochs WHERE origin_node_id=? AND origin_epoch=?").get(p.peer_node_id,p.peer_epoch))fail("RETIRED_EPOCH","产物来源代次已退役",403);
}
function target(db,resultId){
 const n=localIdentity(db),t=db.prepare("SELECT * FROM artifact_targets WHERE result_id=?").get(resultId);
 if(!t)fail("ARTIFACT_TARGET_REQUIRED","先在本机指定该交付的接收仓库、原始基线及完整基线读取权限");
 if(t.node_id!==n.node_id||t.node_epoch!==n.sync_epoch)fail("ARTIFACT_RECOVERY_REQUIRED","旧代次接收许可不可继续");
 return {...t,repository:repositoryState(db,{mappingId:t.mapping_id})};
}
/** Local administration only. Each candidate is bound to a locally selected repo and base. */
export function registerArtifactTarget(db,{resultId,mappingId,baseCommit,allowFullBaselineRead,authorize=()=>{}}){
 if(allowFullBaselineRead!==true)fail("BASELINE_READ_GRANT_REQUIRED","须明确允许读取完整批准基线以核对未修改文件");
 migrateArtifacts(db);const r=pending(db,resultId,"source"),mapping=repositoryState(db,{mappingId});
 if(mapping.project_id!==r.project_id)fail("PROJECT_BOUNDARY","接收仓库不属于交付项目");workspaceRepositorySource(db,{mappingId,baseCommit});
 return unit(db,()=>{authorize();pending(db,resultId,"source");repositoryState(db,{mappingId});const n=localIdentity(db),old=db.prepare("SELECT * FROM artifact_targets WHERE result_id=?").get(resultId);
  if(old){target(db,resultId);if(old.mapping_id!==mappingId||old.base_commit!==baseCommit)fail("REQUEST_CONFLICT","候选接收许可已固定");}
  else{db.prepare("INSERT INTO artifact_targets VALUES(?,?,?,?,?,?)").run(resultId,mappingId,n.node_id,n.sync_epoch,baseCommit,at());event(db,null,"target_registered",{result_id:resultId,mapping_id:mappingId,base_commit:baseCommit,allow_full_baseline_read:true});}
  return {result_id:resultId,mapping_id:mappingId,base_commit:baseCommit,allow_full_baseline_read:true,accepted:false};
 });
}
function header(h,r){
 exact(h,["schema_version","kind","transfer_id","result_id","result_body_digest","manifest","manifest_digest","payload_sha256","payload_bytes","chunk_size"]);uuid(h.transfer_id,"transfer_id");uuid(h.result_id,"result_id");validateDeliveryManifest(h.manifest);
 if(h.schema_version!==1||h.kind!=="workspace_artifact_offer"||h.result_id!==r.result_id||h.result_body_digest!==r.body_digest||digest(h.manifest)!==h.manifest_digest||!hash(h.payload_sha256)||!Number.isSafeInteger(h.payload_bytes)||h.payload_bytes<1||h.payload_bytes>MAX_PACKAGE_BYTES||h.chunk_size!==CHUNK_BYTES||Buffer.byteLength(canonical(h))>MAX_ARTIFACT_HEADER)fail("ARTIFACT_MISMATCH","传输清单、长度或候选摘要不匹配");
 const m=h.manifest,e=r.body.execution,d=r.body.relation;
 if(m.node_id!==d.target_node_id||m.node_epoch!==d.target_epoch||m.project_id!==r.project_id||m.task_uid!==d.target_task_uid||m.run_id!==e.run_id||m.dispatch_id!==e.dispatch_id||m.agent_instance_id!==e.agent_instance_id||m.process_result_digest!==e.result_digest)fail("ARTIFACT_RUN_MISMATCH","实际文件与交付运行不同");
 const proof=m.stop_proofs[0];if(e.execution_mode==="provider"?(m.fixture_runs!==0||m.launch_digest!==e.launch_digest||proof.observation_digest!==e.observation_digest||proof.kind!==e.quiescence):(m.fixture_runs!==1||proof.kind!=="fixture_terminal"))fail("ARTIFACT_RUN_MISMATCH","文件停止证明与候选执行不同");
}
function row(db,id){uuid(id,"transfer_id");const t=db.prepare("SELECT transfer_id,result_id,side,node_id,node_epoch,header_json,header_digest,payload_bytes,created_at FROM artifact_transfers WHERE transfer_id=?").get(id),n=localIdentity(db);if(!t)fail("NOT_FOUND","未找到文件传输",404);if(t.node_id!==n.node_id||t.node_epoch!==n.sync_epoch)fail("ARTIFACT_RECOVERY_REQUIRED","旧代次文件传输不可继续");if(digest(JSON.parse(t.header_json))!==t.header_digest)fail("ARTIFACT_CORRUPT","固定传输清单摘要变化");return t;}
function reserve(db,h,side,payload=null){
 if(db.prepare("SELECT 1 FROM artifact_transfers WHERE result_id=?").get(h.result_id))fail("ARTIFACT_EXISTS","该候选已有固定文件传输");
 if(db.prepare("SELECT coalesce(sum(payload_bytes+length(CAST(header_json AS BLOB))),0) bytes FROM artifact_transfers").get().bytes+h.payload_bytes+Buffer.byteLength(canonical(h))>MAX_ARTIFACT_STORAGE)fail("ARTIFACT_STORAGE_LIMIT","保留产物已达本机 256 MiB 容量上限");
 const n=localIdentity(db);db.prepare("INSERT INTO artifact_transfers VALUES(?,?,?,?,?,?,?,?,?,?)").run(h.transfer_id,h.result_id,side,n.node_id,n.sync_epoch,canonical(h),digest(h),h.payload_bytes,payload,at());event(db,h.transfer_id,side==="target"?"prepared":"offered",{header_digest:digest(h)});
}
export function prepareArtifact(db,{resultId,transferId,authorize=()=>{}}){
 uuid(transferId,"transfer_id");migrateArtifacts(db);const r=pending(db,resultId,"target"),old=db.prepare("SELECT result_id FROM artifact_transfers WHERE transfer_id=?").get(transferId);
 if(old){if(old.result_id!==resultId)fail("REQUEST_CONFLICT","传输号已绑定其他交付");return artifactState(db,transferId);}
 if(db.isTransaction)fail("TRANSACTION_CONTEXT","文件捕获需独立于调用事务");
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_workspaces'").get())fail("WORKSPACE_REQUIRED","候选运行没有实际任务工作区");
 const w=db.prepare("SELECT workspace_id FROM task_workspaces WHERE run_id=? AND dispatch_id=?").get(r.body.execution.run_id,r.body.execution.dispatch_id);if(!w)fail("WORKSPACE_REQUIRED","候选运行没有实际任务工作区");
 const p=captureWorkspacePackage(db,{workspaceId:w.workspace_id}),h={schema_version:1,kind:"workspace_artifact_offer",transfer_id:transferId,result_id:resultId,result_body_digest:r.body_digest,manifest:p.manifest,manifest_digest:p.manifest_digest,payload_sha256:contentHash(p.bytes),payload_bytes:p.bytes.length,chunk_size:CHUNK_BYTES};header(h,r);
 return unit(db,()=>{authorize();header(h,pending(db,resultId,"target"));const old=db.prepare("SELECT header_digest FROM artifact_transfers WHERE transfer_id=?").get(transferId);if(old){if(old.header_digest!==digest(h))fail("REQUEST_CONFLICT","并发传输内容不一致");}else reserve(db,h,"target",p.bytes);return artifactState(db,transferId);});
}
function counts(db,t){return db.prepare("SELECT count(*) next_chunk,coalesce(sum(length(content)),0) received_bytes FROM artifact_chunks WHERE transfer_id=?").get(t.transfer_id);}
function receipts(db,id){const rows=db.prepare("SELECT kind,receipt_json FROM artifact_receipts WHERE transfer_id=?").all(id);return {receipt:JSON.parse(rows.find(r=>r.kind==="artifact_received")?.receipt_json??"null"),verification:JSON.parse(rows.find(r=>r.kind==="artifact_content_verified")?.receipt_json??"null")};}
export function artifactState(db,id){
 const t=row(db,id),h=JSON.parse(t.header_json),r=resultState(db,t.result_id),a=receipts(db,id),count=t.side==="source"?counts(db,t):{next_chunk:null,received_bytes:null};
 return {transfer_id:id,result_id:t.result_id,side:t.side,header:h,header_digest:t.header_digest,state:r.review_state!=="pending_evidence"?r.review_state:a.verification?"content_verified":a.receipt?"received":t.side==="source"?"receiving":"prepared",...count,...a,accepted:false};
}
function progress(db,id){const {header,side,...rest}=artifactState(db,id);return rest;}
function incoming(db,peer,id,write=true){const t=row(db,id),r=write?pending(db,t.result_id,"source"):resultState(db,t.result_id);if(t.side!=="source")fail("FORBIDDEN","不能向发送端写入",403);peerGrant(db,r,peer);return t;}
export function receiveArtifactOffer(db,peer,h){return unit(db,()=>{
 const r=pending(db,h?.result_id,"source");peerGrant(db,r,peer);header(h,r);const a=target(db,r.result_id),m=h.manifest;
 if(a.repository.repo_id!==m.repo_id||a.base_commit!==m.base_commit)fail("BASE_MISMATCH","远端仓库或原始基线与本机接收许可不同");
 if(m.files.some(f=>!a.repository.allowed_paths.some(p=>p.endsWith("/")?f.path.startsWith(p):f.path===p)))fail("PATH_NOT_ALLOWED","变化文件超出本机允许范围");
 const prior=db.prepare("SELECT header_digest FROM artifact_transfers WHERE transfer_id=?").get(h.transfer_id);if(prior){incoming(db,peer,h.transfer_id);if(prior.header_digest!==digest(h))fail("REQUEST_CONFLICT","重放传输号内容不同");}else reserve(db,h,"source");return progress(db,h.transfer_id);
});}
export function receiveArtifactChunk(db,peer,body){return unit(db,()=>{
 exact(body,["transfer_id","header_digest","chunk_index","sha256","content"]);const t=incoming(db,peer,body.transfer_id),h=JSON.parse(t.header_json);
 if(body.header_digest!==t.header_digest||!Number.isSafeInteger(body.chunk_index)||body.chunk_index<0||body.chunk_index>=Math.ceil(t.payload_bytes/CHUNK_BYTES))fail("ARTIFACT_MISMATCH","分块身份或位置无效");
 const bytes=base64Bytes(body.content,CHUNK_BYTES),expected=Math.min(CHUNK_BYTES,t.payload_bytes-body.chunk_index*CHUNK_BYTES);
 if(bytes.length!==expected||contentHash(bytes)!==body.sha256)fail("ARTIFACT_MISMATCH","分块实际长度或摘要不同");
 const old=db.prepare("SELECT content,sha256 FROM artifact_chunks WHERE transfer_id=? AND chunk_index=?").get(t.transfer_id,body.chunk_index);
 if(old){if(old.sha256!==body.sha256||!Buffer.from(old.content).equals(bytes))fail("REQUEST_CONFLICT","同一分块不可替换");return progress(db,t.transfer_id);}
 if(receipts(db,t.transfer_id).receipt)fail("ARTIFACT_SEALED","传输已封存");const c=counts(db,t);if(body.chunk_index!==c.next_chunk||c.received_bytes!==body.chunk_index*CHUNK_BYTES)fail("CHUNK_ORDER","仅接受下一个连续分块");
 db.prepare("INSERT INTO artifact_chunks VALUES(?,?,?,?)").run(t.transfer_id,body.chunk_index,bytes,body.sha256);event(db,t.transfer_id,"chunk_received",{chunk_index:body.chunk_index,sha256:body.sha256,bytes:bytes.length});return progress(db,t.transfer_id);
});}
function payload(db,t){
 const bytes=t.side==="target"?Buffer.from(db.prepare("SELECT payload FROM artifact_transfers WHERE transfer_id=?").get(t.transfer_id).payload):Buffer.concat(db.prepare("SELECT content FROM artifact_chunks WHERE transfer_id=? ORDER BY chunk_index").all(t.transfer_id).map(r=>Buffer.from(r.content)));
 if(bytes.length!==t.payload_bytes||contentHash(bytes)!==JSON.parse(t.header_json).payload_sha256)fail("ARTIFACT_INCOMPLETE","实际产物尚不完整或内容摘要不同");return bytes;
}
function receiptFor(db,t,kind,mappingId){const h=JSON.parse(t.header_json),r=resultState(db,t.result_id),d=r.body.relation;
 const value={schema_version:1,kind,transfer_id:t.transfer_id,result_id:t.result_id,header_digest:t.header_digest,payload_sha256:h.payload_sha256,payload_bytes:t.payload_bytes,source_node_id:d.source_node_id,source_epoch:d.source_epoch,target_node_id:d.target_node_id,target_epoch:d.target_epoch};
 return kind==="artifact_content_verified"?{...value,mapping_id:mappingId,base_commit:h.manifest.base_commit,commit:h.manifest.commit,tree:h.manifest.tree,content_snapshot_digest:h.manifest.content_snapshot_digest}:value;
}
function saveReceipt(db,t,receipt){const old=db.prepare("SELECT receipt_json FROM artifact_receipts WHERE transfer_id=? AND kind=?").get(t.transfer_id,receipt.kind);if(old){if(old.receipt_json!==canonical(receipt))fail("RECEIPT_MISMATCH","产物回执不可替换");return;}
 db.prepare("INSERT INTO artifact_receipts VALUES(?,?,?,?)").run(t.transfer_id,receipt.kind,canonical(receipt),at());event(db,t.transfer_id,receipt.kind,{receipt_digest:digest(receipt)});
}
export function sealArtifact(db,peer,body){return unit(db,()=>{
 exact(body,["transfer_id","header_digest"]);const t=incoming(db,peer,body.transfer_id);if(body.header_digest!==t.header_digest)fail("ARTIFACT_MISMATCH","传输清单不匹配");payload(db,t);saveReceipt(db,t,receiptFor(db,t,"artifact_received"));return progress(db,t.transfer_id);
});}
export function peerArtifactStatus(db,peer,body){exact(body,["transfer_id","header_digest"]);const t=incoming(db,peer,body.transfer_id,false);if(t.header_digest!==body.header_digest)fail("ARTIFACT_MISMATCH","传输清单不匹配");return progress(db,t.transfer_id);}
/** Local, potentially expensive Git reads run outside the HTTP handler and write transaction. */
export function verifyArtifact(db,{transferId,authorize=()=>{}}){
 if(db.isTransaction)fail("TRANSACTION_CONTEXT","完整基线核验需独立于写事务");const t=incoming(db,null,transferId),h=JSON.parse(t.header_json),a=target(db,t.result_id);if(!receipts(db,transferId).receipt)fail("ARTIFACT_INCOMPLETE","先收齐并封存产物");
 const source=workspaceRepositorySource(db,{mappingId:a.mapping_id,baseCommit:a.base_commit}),g=repositoryReader({root:source.root,git:source.git}),baseline=g.snapshot({commit:a.base_commit,consume(){}});g.verify();
 if(baseline.tree!==source.base_tree||h.manifest.repo_id!==a.repository.repo_id)fail("BASE_MISMATCH","接收端批准基线已变化");
 verifyGitPackage(payload(db,t),{manifest:h.manifest,manifestDigest:h.manifest_digest,baseline,allowedPaths:a.repository.allowed_paths});
 return unit(db,()=>{authorize();incoming(db,null,transferId);target(db,t.result_id);saveReceipt(db,t,receiptFor(db,t,"artifact_content_verified",a.mapping_id));return artifactState(db,transferId);});
}
/** Current local receiving authority, without rereading payload bytes on every heartbeat. */
export function verifiedArtifactContext(db,{transferId}){const t=incoming(db,null,transferId),a=receipts(db,transferId),dest=target(db,t.result_id);if(!a.verification)fail("ARTIFACT_UNVERIFIED","实际内容尚未经本机核验");if(a.verification.mapping_id!==dest.mapping_id)fail("ARTIFACT_MISMATCH","验证记录的本机仓库不同");return {header:JSON.parse(t.header_json),header_digest:t.header_digest,mapping_id:dest.mapping_id,accepted:false};}
export function captureVerifiedArtifact(db,{transferId}){const context=verifiedArtifactContext(db,{transferId}),t=row(db,transferId);return {...context,bytes:payload(db,t)};}
export function artifactChunk(db,{transferId,index}){
 const t=row(db,transferId);pending(db,t.result_id,"target");if(t.side!=="target"||!Number.isSafeInteger(index)||index<0||index>=Math.ceil(t.payload_bytes/CHUNK_BYTES))fail("BAD_INPUT","发送分块位置无效",400);
 const bytes=Buffer.from(db.prepare("SELECT substr(payload,?,?) content FROM artifact_transfers WHERE transfer_id=?").get(index*CHUNK_BYTES+1,CHUNK_BYTES,transferId).content);if(bytes.length!==Math.min(CHUNK_BYTES,t.payload_bytes-index*CHUNK_BYTES))fail("ARTIFACT_CORRUPT","发送端分块存储不完整");return {transfer_id:transferId,header_digest:t.header_digest,chunk_index:index,sha256:contentHash(bytes),content:bytes.toString("base64")};
}
export function recordArtifactProgress(db,{transferId,response,authorize=()=>{}}){return unit(db,()=>{
 authorize();
 const t=row(db,transferId);pending(db,t.result_id,"target");if(t.side!=="target")fail("FORBIDDEN","仅发送端记录远端回执",403);
 exact(response,["transfer_id","result_id","header_digest","state","next_chunk","received_bytes","receipt","verification","accepted"]);
 if(response.transfer_id!==transferId||response.result_id!==t.result_id||response.header_digest!==t.header_digest||response.accepted!==false||!["receiving","received","content_verified","cancel_pending","rejected"].includes(response.state)||!Number.isSafeInteger(response.next_chunk)||response.next_chunk<0||!Number.isSafeInteger(response.received_bytes)||response.received_bytes!==Math.min(response.next_chunk*CHUNK_BYTES,t.payload_bytes)||response.next_chunk>Math.ceil(t.payload_bytes/CHUNK_BYTES))fail("RECEIPT_MISMATCH","远端分块进度不匹配");
 if(["cancel_pending","rejected"].includes(response.state))fail("RESULT_NOT_PENDING","来源已取消或退回候选");
 const prior=receipts(db,transferId);if(prior.receipt&&!response.receipt||prior.verification&&!response.verification)fail("RECEIPT_MISMATCH","远端不能遗失已确认回执");
 if(response.receipt!==null){if(response.received_bytes!==t.payload_bytes||canonical(response.receipt)!==canonical(receiptFor(db,t,"artifact_received")))fail("RECEIPT_MISMATCH","远端接收回执不匹配");saveReceipt(db,t,response.receipt);}
 if(response.verification!==null){uuid(response.verification.mapping_id,"mapping_id");if(!response.receipt||canonical(response.verification)!==canonical(receiptFor(db,t,"artifact_content_verified",response.verification.mapping_id)))fail("RECEIPT_MISMATCH","远端内容核验回执不匹配");saveReceipt(db,t,response.verification);}
 const expected=response.verification?"content_verified":response.receipt?"received":"receiving";if(response.state!==expected)fail("RECEIPT_MISMATCH","远端状态缺少相应回执");return {next_chunk:response.next_chunk,...artifactState(db,transferId),remote_next_chunk:response.next_chunk};
});}
