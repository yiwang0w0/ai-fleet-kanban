import {join,isAbsolute} from "node:path";
import {existsSync,realpathSync} from "node:fs";
import {PeerError,keys,uuid} from "../federation/protocol.mjs";
import {localIdentity,transaction} from "../federation/peers.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {resultState} from "../federation/results.mjs";
import {migrateArtifacts,verifiedArtifactContext,captureVerifiedArtifact} from "../artifacts/transfers.mjs";
import {repositoryState,workspaceRepositorySource} from "../artifacts/repositories.mjs";
import {directoryIdentity,verifyDirectory,overlaps} from "../artifacts/git-workspace.mjs";
import {materializeVerificationInput,assertVerificationInput} from "./workspace.mjs";
import {createHash} from "node:crypto";
import {pinFile,superviseCommand,commandIsolation,sandboxObservation} from "../execution/supervisor.mjs";
import {writeRecoveryJSON,readRecoveryJSON} from "../recovery.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);},at=()=>new Date().toISOString();
const hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
function exact(x,fields){keys(x,fields,"verification");if(Object.keys(x).length!==fields.length)fail("BAD_VERIFICATION","本机验证配置字段缺失");}
function separate(a,b){if(overlaps(a,b)||overlaps(b,a))fail("VERIFICATION_PATH_OVERLAP","验证目录不能与源仓库、治理目录或数据库重叠");}
function outsideTransaction(db){if(db.isTransaction)fail("TRANSACTION_CONTEXT","验证文件准备和命令执行必须在独立事务外");}
function sameIdentity(db,r){const n=localIdentity(db);if(r.node_id!==n.node_id||r.node_epoch!==n.sync_epoch)fail("VERIFICATION_RECOVERY_REQUIRED","旧节点代次的验证不能继续");}
function checkedPin(p){exact(p,["path","sha256"]);if(!hash(p.sha256)||canonical(pinFile(p.path))!==canonical(p))fail("PIN_CHANGED","固定程序或测试文件变化");return p;}
function sourceCheck(gate){const s=gate?.check?.();if(!s||!isAbsolute(s.code_root)||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(s.tree))fail("SOURCE_UNVERIFIED","需要本机已批准的治理代码");return {code_root:realpathSync(s.code_root),tree:s.tree};}
function definition(d){
 exact(d,["command","python","pins","args","env","timeout_ms","heartbeat_ms","stdout_limit","stderr_limit",...(Object.hasOwn(d,"isolation")?["isolation"]:[])]);
 if(Object.hasOwn(d,"isolation")){if(d.isolation===null)fail("BAD_VERIFICATION","显式隔离配置不能为 null");commandIsolation(d.isolation);}
 for(const p of [d.command,d.python]){checkedPin(p);if(!p.path.toLowerCase().endsWith(".exe"))fail("NATIVE_EXECUTABLE_REQUIRED","验证只能使用固定 Windows 原生程序");}
 if(!Array.isArray(d.pins)||d.pins.length>15)fail("BAD_VERIFICATION","最多固定 15 个辅助文件");d.pins.forEach(checkedPin);
 if(!Array.isArray(d.args)||d.args.length>200||d.args.some(x=>typeof x!=="string"||x.includes("\0"))||Buffer.byteLength(canonical(d.args))>65536)fail("BAD_VERIFICATION","测试参数无效");
 if(!d.env||typeof d.env!=="object"||Array.isArray(d.env)||Object.entries(d.env).some(([k,v])=>!["systemroot","windir","temp","tmp","path","pythonutf8","no_color","ci","lang","lc_all"].includes(k.toLowerCase())||typeof v!=="string"||v.includes("\0")||v.length>8192)||new Set(Object.keys(d.env).map(k=>k.toLowerCase())).size!==Object.keys(d.env).length)fail("BAD_VERIFICATION","环境只接受显式基础变量，不继承模型凭据或启动注入选项");
 if(!Number.isSafeInteger(d.timeout_ms)||d.timeout_ms<50||d.timeout_ms>3600000||!Number.isSafeInteger(d.heartbeat_ms)||d.heartbeat_ms<100||d.heartbeat_ms>10000||[d.stdout_limit,d.stderr_limit].some(n=>!Number.isSafeInteger(n)||n<1||n>65536))fail("BAD_VERIFICATION","验证时间或输出限额无效");
 return d;
}
export function migrateVerification(db){return transaction(db,()=>{
 migrateArtifacts(db);
 db.exec("CREATE TABLE IF NOT EXISTS verification_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO verification_schema VALUES(1,1)");
 if(db.prepare("SELECT version FROM verification_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","验证存储版本不兼容");
 db.exec([
  "CREATE TABLE IF NOT EXISTS verification_profiles(profile_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,mapping_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,descriptor_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS verification_revocations(profile_id TEXT PRIMARY KEY,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS verification_attempts(verification_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,profile_id TEXT NOT NULL,transfer_id TEXT NOT NULL,binding_json TEXT NOT NULL,binding_digest TEXT NOT NULL,container TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS verification_inputs(verification_id TEXT PRIMARY KEY,input_json TEXT NOT NULL,input_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS verification_launches(verification_id TEXT PRIMARY KEY,launch_json TEXT NOT NULL,launch_digest TEXT NOT NULL,created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS verification_receipts(verification_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,created_at TEXT NOT NULL);"
 ].join("\n"));
 for(const t of ["verification_profiles","verification_revocations","verification_attempts","verification_inputs","verification_launches","verification_receipts"]){
  db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'verification history is immutable'); END");
  db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'verification history must be retained'); END");
 }
});}
function profile(db,id,{active=true}={}){
 uuid(id,"profile_id");const r=db.prepare("SELECT * FROM verification_profiles WHERE profile_id=?").get(id);if(!r)fail("NOT_FOUND","本机验证配置不存在");sameIdentity(db,r);
 if(active&&db.prepare("SELECT 1 FROM verification_revocations WHERE profile_id=?").get(id))fail("VERIFICATION_REVOKED","验证配置已撤销");
 const d=JSON.parse(r.descriptor_json);if(digest(d)!==r.descriptor_digest)fail("VERIFICATION_CORRUPT","验证配置摘要变化");return {...r,descriptor:d};
}
/** Local administration only. Never registered by a peer, MCP worker or artifact payload. */
export function registerVerificationProfile(db,{profileId,mappingId,poolRoot,allowFullHistoryCopy,definition:config,sourceGate}){
 outsideTransaction(db);if(process.platform!=="win32")fail("WINDOWS_REQUIRED","仅支持 Windows 验证");uuid(profileId,"profile_id");uuid(mappingId,"mapping_id");
 if(allowFullHistoryCopy!==true)fail("FULL_HISTORY_PERMISSION_REQUIRED","验证副本需要本机完整历史复制许可");
 const source=sourceCheck(sourceGate),pool=directoryIdentity(poolRoot);definition(config);separate(pool.root,source.code_root);
 const mapping=repositoryState(db,{mappingId}),repo=workspaceRepositorySource(db,{mappingId,baseCommit:mapping.approved_bases[0]?.commit_oid});separate(pool.root,repo.root);separate(pool.root,repo.common_dir);
 for(const path of [db.prepare("PRAGMA database_list").all().find(x=>x.name==="main")?.file,...[config.command,config.python,...config.pins].map(x=>x.path)])if(path)separate(pool.root,path);
 const descriptor={mapping_id:mappingId,pool,definition:config,source,allow_full_history_copy:true};migrateVerification(db);
 return transaction(db,()=>{const n=localIdentity(db),old=db.prepare("SELECT * FROM verification_profiles WHERE profile_id=?").get(profileId);
  if(old){profile(db,profileId);if(old.descriptor_json!==canonical(descriptor))fail("REQUEST_CONFLICT","验证配置 ID 已固定");}
  else{if(db.prepare("SELECT count(*) n FROM verification_profiles").get().n>=1000)fail("VERIFICATION_LIMIT","验证配置历史已达上限");db.prepare("INSERT INTO verification_profiles VALUES(?,?,?,?,?,?,?)").run(profileId,n.node_id,n.sync_epoch,mappingId,canonical(descriptor),digest(descriptor),at());}
  return {profile_id:profileId,profile_digest:digest(descriptor),mapping_id:mappingId,accepted:false};
 });
}
export function revokeVerificationProfile(db,{profileId}){return transaction(db,()=>{profile(db,profileId,{active:false});db.prepare("INSERT OR IGNORE INTO verification_revocations VALUES(?,?)").run(profileId,at());return {profile_id:profileId,revoked:true};});}
function row(db,id){uuid(id,"verification_id");const r=db.prepare("SELECT * FROM verification_attempts WHERE verification_id=?").get(id);if(!r)fail("NOT_FOUND","验证运行不存在");sameIdentity(db,r);if(digest(JSON.parse(r.binding_json))!==r.binding_digest)fail("VERIFICATION_CORRUPT","验证绑定摘要变化");return r;}
function binding(db,p,transferId,sourceGate){
 const a=verifiedArtifactContext(db,{transferId}),r=resultState(db,a.header.result_id),task=db.prepare("SELECT * FROM tasks WHERE task_uid=?").get(r.body.relation.source_task_uid),source=sourceCheck(sourceGate);
 if(a.mapping_id!==p.mapping_id)fail("VERIFICATION_MAPPING_MISMATCH","测试配置与产物接收仓库不同");if(!task||task.archived_at)fail("SOURCE_TASK_CHANGED","来源任务不可用");if(canonical(source)!==canonical(p.descriptor.source))fail("SOURCE_CHANGED","批准验证配置的治理代码已变化");
 return {profile_id:p.profile_id,profile_digest:p.descriptor_digest,transfer_id:transferId,header_digest:a.header_digest,artifact_manifest_digest:a.header.manifest_digest,payload_sha256:a.header.payload_sha256,result_id:r.result_id,result_body_digest:r.body_digest,source_task_uid:task.task_uid,source_task_version:task.aggregate_version,source_task_digest:digest({...task}),source,base_commit:a.header.manifest.base_commit,commit:a.header.manifest.commit};
}
function current(db,r,sourceGate){const p=profile(db,r.profile_id);if(canonical(binding(db,p,r.transfer_id,sourceGate))!==r.binding_json)fail("VERIFICATION_STALE","产物、来源任务或验证配置已变化");return p;}
function input(db,id){const r=db.prepare("SELECT * FROM verification_inputs WHERE verification_id=?").get(id);if(!r)fail("VERIFICATION_NOT_READY","验证副本尚未准备完成；不自动覆盖部分目录");const v=JSON.parse(r.input_json);if(digest(v)!==r.input_digest)fail("VERIFICATION_CORRUPT","验证副本回执摘要变化");return v;}
export function verificationState(db,id){const r=row(db,id),i=db.prepare("SELECT input_digest FROM verification_inputs WHERE verification_id=?").get(id),l=db.prepare("SELECT launch_digest FROM verification_launches WHERE verification_id=?").get(id),s=db.prepare("SELECT * FROM verification_receipts WHERE verification_id=?").get(id);if(s&&digest(JSON.parse(s.receipt_json))!==s.receipt_digest)fail("VERIFICATION_CORRUPT","验证终态摘要变化");return {verification_id:id,profile_id:r.profile_id,transfer_id:r.transfer_id,phase:s?"settled":l?"launch_committed":i?"ready":"preparing",binding:JSON.parse(r.binding_json),binding_digest:r.binding_digest,input_digest:i?.input_digest??null,launch_digest:l?.launch_digest??null,receipt:s?JSON.parse(s.receipt_json):null,receipt_digest:s?.receipt_digest??null,accepted:false};}
export function prepareVerification(db,{verificationId,profileId,transferId,sourceGate}){
 outsideTransaction(db);uuid(verificationId,"verification_id");uuid(transferId,"transfer_id");migrateVerification(db);const p=profile(db,profileId),b=binding(db,p,transferId,sourceGate),container=join(p.descriptor.pool.root,verificationId);
 verifyDirectory(p.descriptor.pool);definition(p.descriptor.definition);
 const prior=db.prepare("SELECT verification_id FROM verification_attempts WHERE verification_id=?").get(verificationId);
 if(prior){const r=row(db,verificationId);if(r.binding_json!==canonical(b))fail("REQUEST_CONFLICT","验证编号已绑定其他上下文");return verificationState(db,verificationId);}
 const captured=captureVerifiedArtifact(db,{transferId}),source=workspaceRepositorySource(db,{mappingId:p.mapping_id,baseCommit:b.base_commit});
 transaction(db,()=>{profile(db,profileId);if(canonical(binding(db,p,transferId,sourceGate))!==canonical(b))fail("VERIFICATION_STALE","准备期间上下文变化");const n=localIdentity(db);if(db.prepare("SELECT count(*) n FROM verification_attempts").get().n>=1000)fail("VERIFICATION_LIMIT","保留验证运行已达上限");db.prepare("INSERT INTO verification_attempts VALUES(?,?,?,?,?,?,?,?,?)").run(verificationId,n.node_id,n.sync_epoch,profileId,transferId,canonical(b),digest(b),container,at());});
 const materialized=materializeVerificationInput({source,container,packageBytes:captured.bytes,manifest:captured.header.manifest,manifestDigest:captured.header.manifest_digest,allowFullHistoryCopy:true});
 return transaction(db,()=>{current(db,row(db,verificationId),sourceGate);verifyDirectory(p.descriptor.pool);db.prepare("INSERT INTO verification_inputs VALUES(?,?,?,?)").run(verificationId,canonical(materialized),digest(materialized),at());return verificationState(db,verificationId);});
}
function journalPath(r){return join(r.container,"verification-observation.json");}
function stopped(o){return o?.format==="ai-fleet-command-observation/v1"&&o.process?.started===true&&o.process.containment==="windows-job"&&o.process.cleanup==="job_empty"&&o.process.host_error===null&&o.process.host_exit_code===0;}
function successObservation(o,config){return (!config.isolation||sandboxObservation(o?.process?.sandbox,config.isolation))&&stopped(o)&&o.status==="success"&&o.diagnostic==="SUCCESS"&&o.process.exit_code===0&&o.process.executable_sha256===config.command.sha256&&o.process.python_sha256===config.python.sha256&&["stdout","stderr"].every(k=>{const s=o[k];return s&&typeof s.text==="string"&&s.utf8_valid===true&&s.truncated===false&&s.bytes===s.retained_bytes&&s.bytes===Buffer.byteLength(s.text)&&s.bytes<=config[k+"_limit"]&&createHash("sha256").update(s.text).digest("hex")===s.sha256;});}
function finish(db,r,receipt,sourceGate){return transaction(db,()=>{row(db,r.verification_id);if(receipt.checks_passed){try{current(db,r,sourceGate);}catch(e){receipt={...receipt,checks_passed:false,settlement_error:e.code??"VERIFICATION_STALE"};}}const old=db.prepare("SELECT receipt_json FROM verification_receipts WHERE verification_id=?").get(r.verification_id);if(old){if(old.receipt_json!==canonical(receipt))fail("REQUEST_CONFLICT","验证终态不可替换");}else db.prepare("INSERT INTO verification_receipts VALUES(?,?,?,?)").run(r.verification_id,canonical(receipt),digest(receipt),at());return verificationState(db,r.verification_id);});}
function checkAfter(db,r,i,sourceGate){try{const p=current(db,r,sourceGate);definition(p.descriptor.definition);verifyDirectory(p.descriptor.pool);return {input:assertVerificationInput(i,{allowGenerated:true}),error:null};}catch(e){return {input:null,error:typeof e.code==="string"?e.code:"VERIFICATION_CHECK_FAILED"};}}
/** Consumes one durable local launch. Repeating run never starts another command. */
export async function executeVerification(db,{verificationId,sourceGate,signal=null}){
 outsideTransaction(db);const r=row(db,verificationId),p=current(db,r,sourceGate),i=input(db,verificationId),config=p.descriptor.definition;
 if(verificationState(db,verificationId).phase!=="ready")fail("VERIFICATION_ALREADY_LAUNCHED","启动许可已消费；只能核对已有终态");
 if(signal!==null&&!(signal instanceof AbortSignal))fail("BAD_VERIFICATION","取消信号无效");if(signal?.aborted)fail("EXECUTION_CANCELLED","启动前已取消");
 definition(config);verifyDirectory(p.descriptor.pool);assertVerificationInput(i);if(existsSync(journalPath(r)))fail("JOURNAL_EXISTS","验证观察文件已存在");
 const launch={format:"ai-fleet-verification-launch/v1",verification_id:verificationId,binding_digest:r.binding_digest,input_digest:digest(i),profile_digest:p.descriptor_digest,command_sha256:config.command.sha256,python_sha256:config.python.sha256};
 transaction(db,()=>{current(db,r,sourceGate);if(db.prepare("SELECT 1 FROM verification_launches WHERE verification_id=?").get(verificationId))fail("VERIFICATION_ALREADY_LAUNCHED","启动许可已消费");db.prepare("INSERT INTO verification_launches VALUES(?,?,?,?)").run(verificationId,canonical(launch),digest(launch),at());});
 let observation;
 try{observation=await superviseCommand({isolation:config.isolation??null,python:config.python,command:config.command,args:config.args,pins:config.pins,cwd:i.identities.repo.root,env:config.env,timeoutMs:config.timeout_ms,heartbeatMs:config.heartbeat_ms,stdoutLimit:config.stdout_limit,stderrLimit:config.stderr_limit,signal,heartbeat:()=>{current(db,r,sourceGate);return true;}});}
 catch(e){observation={format:"ai-fleet-command-launch-error/v1",diagnostic:typeof e.code==="string"?e.code:"COMMAND_LAUNCH_FAILED",process:{started:false,cleanup:"unconfirmed"}};}
 const after=checkAfter(db,r,i,sourceGate),passed=successObservation(observation,config)&&after.error===null;
 const receipt={format:"ai-fleet-verification-receipt/v1",verification_id:verificationId,binding_digest:r.binding_digest,launch_digest:digest(launch),input_digest:digest(i),observation,after,checks_passed:passed,accepted:false,filesystem_sandbox:!!config.isolation&&sandboxObservation(observation?.process?.sandbox,config.isolation,{finished:false}),recorded_at:at()};
 verifyDirectory(i.identities.container);writeRecoveryJSON(journalPath(r),receipt);return finish(db,r,receipt,sourceGate);
}
/** Trusted local recovery of observed bytes only. Never recreates or repeats a lost launch. */
export function reconcileVerification(db,{verificationId,sourceGate}){
 outsideTransaction(db);const r=row(db,verificationId),state=verificationState(db,verificationId);if(state.phase==="settled")return state;if(state.phase!=="launch_committed")fail("VERIFICATION_NOT_LAUNCHED","没有待恢复启动");
 const i=input(db,verificationId);verifyDirectory(i.identities.container);if(!existsSync(journalPath(r)))fail("VERIFICATION_OBSERVATION_MISSING","缺少停止观察；保留启动占用，不自动重跑");
 const config=profile(db,r.profile_id,{active:false}).descriptor.definition;
 const receipt=readRecoveryJSON(journalPath(r));exact(receipt,["format","verification_id","binding_digest","launch_digest","input_digest","observation","after","checks_passed","accepted","filesystem_sandbox","recorded_at"]);
 if(receipt.format!=="ai-fleet-verification-receipt/v1"||receipt.verification_id!==verificationId||receipt.binding_digest!==r.binding_digest||receipt.launch_digest!==state.launch_digest||receipt.input_digest!==digest(i)||receipt.accepted!==false||receipt.filesystem_sandbox!==(!!config.isolation&&sandboxObservation(receipt.observation?.process?.sandbox,config.isolation,{finished:false}))||typeof receipt.checks_passed!=="boolean")fail("VERIFICATION_RECEIPT_MISMATCH","本机观察与已占用启动不符");
 if(receipt.checks_passed&&(!successObservation(receipt.observation,config)||receipt.after?.error!==null||receipt.after?.input?.inputs_unchanged!==true))fail("VERIFICATION_RECEIPT_MISMATCH","通过声明缺少完整观察");
 // A once-passing receipt becomes unusable if context changed before durable settlement.
 const after=checkAfter(db,r,i,sourceGate);if(after.error!==null)return finish(db,r,{...receipt,checks_passed:false,recovery_error:after.error},sourceGate);
 return finish(db,r,receipt,sourceGate);
}

/** Consumers must revalidate a historical receipt; get/state alone never grants current acceptance. */
export function captureVerificationReceipt(db,{verificationId,sourceGate}){
 outsideTransaction(db);const r=row(db,verificationId),p=current(db,r,sourceGate),state=verificationState(db,verificationId),i=input(db,verificationId);definition(p.descriptor.definition);verifyDirectory(p.descriptor.pool);
 if(state.phase!=="settled"||state.receipt.checks_passed!==true||!successObservation(state.receipt.observation,p.descriptor.definition))fail("VERIFICATION_NOT_PASSED","缺少完整独立检查通过记录");
 assertVerificationInput(i,{allowGenerated:true});current(db,r,sourceGate);return {verification_id:verificationId,binding:state.binding,receipt:state.receipt,receipt_digest:state.receipt_digest,currently_valid:true,accepted:false};
}

/** Fast mutable-authority guard for callers already holding the local write transaction.
 * Full input/file validation still uses captureVerificationReceipt outside that transaction. */
export function assertVerificationReceiptCurrent(db,{verificationId,receiptDigest,sourceGate}){
 const r=row(db,verificationId),p=current(db,r,sourceGate),state=verificationState(db,verificationId);
 if(state.phase!=="settled"||state.receipt_digest!==receiptDigest||state.receipt.checks_passed!==true||!successObservation(state.receipt.observation,p.descriptor.definition))fail("VERIFICATION_NOT_PASSED","固定验证回执不再可用");
 return {verification_id:verificationId,binding:state.binding,receipt_digest:receiptDigest};
}
