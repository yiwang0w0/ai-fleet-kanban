// Explicit local review of a recovered source; no peer can approve its own receiver transition.
import {randomUUID} from "node:crypto";
import {realpathSync} from "node:fs";
import {PeerError,keys,uuid} from "./protocol.mjs";
import {localIdentity} from "./peers.mjs";
import {canonical,digest,atomic,migrateSync} from "./sync-store.mjs";
import {endpoint,loadCredential,request} from "./sync-client.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const hash=x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
const exact=(value,fields,label)=>{keys(value,fields,label);if(Object.keys(value).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失");};
function databasePath(db){
 const file=db.prepare("PRAGMA database_list").all().find(x=>x.name==="main")?.file;
 if(!file)fail("BAD_DATABASE","恢复接纳需要持久数据库");
 return realpathSync(file);
}
function originState(db,origin){
 const source=db.prepare("SELECT origin_node_id,origin_epoch,display_name FROM federation_sources WHERE origin_node_id=?").get(origin)??null;
 const rows={};
 for(const [table,owner,order] of [
  ["federation_peers","peer_node_id","peer_node_id"],["federation_cursors","origin_node_id","project_id"],["federation_replicas","owner_node_id","task_uid"],
  ["federation_snapshot_anchors","origin_node_id","project_id"],["federation_snapshot_staging","origin_node_id","project_id"],
  ["federation_epoch_projects","origin_node_id","project_id"],["federation_recovery_missing","owner_node_id","task_uid"],
  ["federation_replica_locations","owner_node_id","task_uid"],["federation_retired_epochs","origin_node_id","origin_epoch"]
 ])rows[table]=db.prepare("SELECT * FROM "+table+" WHERE "+owner+"=? ORDER BY "+order).all(origin);
 const observed=source?.origin_epoch??[...new Set([...rows.federation_cursors,...rows.federation_replicas].map(x=>x.origin_epoch))];
 const epoch=typeof observed==="string"?observed:observed.length===1?observed[0]:null;
 return {source,rows,epoch,digest:digest({source,rows})};
}
function validateMarker(marker,c,expectedEpoch){
 exact(marker,["format","node_id","recovery_id","retired_epoch","backup_epoch","new_epoch","activated_at","receipt_digest"],"source recovery");
 for(const k of ["node_id","recovery_id","retired_epoch","backup_epoch","new_epoch"])uuid(marker[k],k);
 if(marker.format!=="ai-fleet-source-recovery/v1"||marker.node_id!==c.server_node_id||marker.new_epoch!==c.server_epoch||
  marker.retired_epoch!==expectedEpoch||marker.new_epoch===expectedEpoch||!hash(marker.receipt_digest)||!Number.isFinite(Date.parse(marker.activated_at)))
  fail("RECOVERY_MISMATCH","源端恢复标记未连接所见旧代次与新凭据");
}
async function observe(db,{url,credentialFile,expectedEpoch,fetchImpl=fetch,signal}){
 uuid(expectedEpoch,"expected_epoch");
 const base=endpoint(url),local=localIdentity(db);
 // Credential scope is still checked by loadCredential before sending any secret.
 const c=loadCredential(credentialFile,local);
 const known=originState(db,c.server_node_id);
 if(known.epoch!==expectedEpoch)fail("EPOCH_CHANGED","已知来源代次与所见旧代次不一致");
 if(known.rows.federation_retired_epochs.some(x=>x.origin_epoch===c.server_epoch))fail("RETIRED_EPOCH","不能重新接纳已退役代次");
 if(c.server_epoch===expectedEpoch)fail("RECOVERY_MISMATCH","新凭据仍指向旧代次");
 const required=["task-projection-sync-v1","task-snapshot-v1","source-epoch-recovery-v1"];
 const hello=await request(base,"/peer/v1/hello",c,{node_id:local.node_id,sync_epoch:local.sync_epoch,protocol:{min:1,max:1},required_capabilities:required,required_extensions:[],extensions:{}},fetchImpl,signal);
 if(hello.protocol_version!==1||hello.node?.node_id!==c.server_node_id||hello.node?.sync_epoch!==c.server_epoch||
  hello.authorized?.peer_node_id!==local.node_id||hello.authorized?.credential_version!==c.credential_version||
  !Array.isArray(hello.capabilities)||required.some(x=>!hello.capabilities.includes(x))||
  canonical(hello.authorized?.projects)!==canonical(c.projects)||canonical(hello.authorized?.scopes)!==canonical(c.scopes))
  fail("SOURCE_MISMATCH","恢复握手与已固定凭据不一致");
 if(typeof hello.node.display_name!=="string"||!hello.node.display_name.trim()||hello.node.display_name.length>80||/[\u0000-\u001f\u007f]/.test(hello.node.display_name))fail("BAD_INPUT","来源显示名无效");
 const marker=hello.extensions?.source_recovery;validateMarker(marker,c,expectedEpoch);
 return {local,c,marker,hello,base,credentialPath:realpathSync(credentialFile)};
}
function reviewFields(db,observation,expectedEpoch){
 const {local,c,marker,base,credentialPath}=observation,nowLocal=localIdentity(db);
 if(nowLocal.node_id!==local.node_id||nowLocal.sync_epoch!==local.sync_epoch)fail("PLAN_CHANGED","握手期间本机身份已变化");
 const state=originState(db,c.server_node_id);
 if(state.epoch!==expectedEpoch)fail("EPOCH_CHANGED","已知来源代次与所见旧代次不一致");
 if(state.rows.federation_retired_epochs.some(x=>x.origin_epoch===c.server_epoch))fail("RETIRED_EPOCH","不能重新接纳已退役的来源代次");
 const projects=[...new Set([...c.projects,...Object.values(state.rows).flatMap(rows=>rows.map(x=>x.project_id).filter(Boolean))])].sort();
 if(projects.length>1000)fail("BAD_INPUT","来源项目清单超过1000项");
 const peer=state.rows.federation_peers[0];
 const localCredential=peer?{peer_epoch:peer.peer_epoch,key_id:peer.key_id,credential_version:peer.credential_version,status:peer.status,revocation_required:peer.status==="active"&&peer.peer_epoch!==c.server_epoch}:null;
 return {local_credential:localCredential,database_path:databasePath(db),receiver:{node_id:local.node_id,sync_epoch:local.sync_epoch},
  binding:{origin_node_id:c.server_node_id,previous_epoch:expectedEpoch,new_epoch:c.server_epoch,url:base,credential_file:credentialPath,key_id:c.key_id,credential_version:c.credential_version},
  marker,authorized_projects:c.projects,projects:projects.map(project_id=>({
   project_id,visible_epoch:state.rows.federation_cursors.find(x=>x.project_id===project_id)?.origin_epoch??null,
   visible_seq:state.rows.federation_cursors.find(x=>x.project_id===project_id)?.seq??0,
   replicas:state.rows.federation_replicas.filter(x=>x.project_id===project_id).length,
   unresolved_missing:state.rows.federation_recovery_missing.filter(x=>x.project_id===project_id&&x.resolved_at===null).length,
   previous_pending:state.rows.federation_epoch_projects.some(x=>x.project_id===project_id&&x.state==="pending")
  })),state_digest:state.digest};
}
export async function prepareSourceRecovery(db,options){
 migrateSync(db);
 const observation=await observe(db,options);
 return atomic(db,()=>{
  const fields=reviewFields(db,observation,options.expectedEpoch);
  const plan={format:"ai-fleet-source-acceptance-plan/v1",plan_id:randomUUID(),...fields,created_at:new Date().toISOString()};
  return {...plan,plan_digest:digest(plan)};
 });
}
export async function acceptSourceRecovery(db,{plan,expectedPlanDigest,fetchImpl=fetch,signal}){
 // Detach caller-owned objects before the network await.
 plan=JSON.parse(canonical(plan));
 exact(plan,["format","plan_id","local_credential","database_path","receiver","binding","marker","authorized_projects","projects","state_digest","created_at","plan_digest"],"acceptance plan");
 uuid(plan.plan_id,"plan_id");
 const {plan_digest,...unsigned}=plan;
 if(plan.format!=="ai-fleet-source-acceptance-plan/v1"||!hash(plan_digest)||plan_digest!==expectedPlanDigest||digest(unsigned)!==plan_digest||
  !Number.isFinite(Date.parse(plan.created_at))||plan.database_path!==databasePath(db))fail("PLAN_CHANGED","接纳计划、摘要或数据库路径不匹配");
 const observation=await observe(db,{url:plan.binding.url,credentialFile:plan.binding.credential_file,expectedEpoch:plan.binding.previous_epoch,fetchImpl,signal});
 return atomic(db,()=>{
  const fields=reviewFields(db,observation,plan.binding.previous_epoch);
  for(const [key,value] of Object.entries(fields))if(canonical(plan[key])!==canonical(value))fail("PLAN_CHANGED","来源、凭据或副本状态已变化，请重新核对计划");
  const id=randomUUID(),now=new Date().toISOString(),origin=plan.binding.origin_node_id;
  let revoked=0;
  if(plan.local_credential?.revocation_required){
   const previous=plan.local_credential.credential_version;if(previous>=Number.MAX_SAFE_INTEGER)fail("VERSION_EXHAUSTED","对端凭据版本已达上限");
   db.prepare("UPDATE federation_peers SET status=\'revoked\',secret_hash=\'\',credential_version=?,updated_at=? WHERE peer_node_id=?").run(previous+1,now,origin);
   db.prepare("INSERT INTO federation_auth_events(peer_node_id,credential_version,action,at) VALUES(?,?,\'source_epoch_revoke\',?)").run(origin,previous+1,now);revoked=1;
  }
  const receipt={format:"ai-fleet-source-acceptance/v1",acceptance_id:id,origin_node_id:origin,previous_epoch:plan.binding.previous_epoch,new_epoch:plan.binding.new_epoch,
   plan_digest:plan_digest,local_credentials_revoked:revoked,marker:plan.marker,projects:plan.projects.map(p=>p.project_id),accepted_at:now,snapshot_required:true,physical_retirement:"operator_attested_at_source_not_verified_here"};
  db.prepare("INSERT INTO federation_epoch_acceptances VALUES(?,?,?,?,?,?,?)").run(id,origin,receipt.previous_epoch,receipt.new_epoch,plan_digest,canonical(receipt),now);
  db.prepare("INSERT INTO federation_retired_epochs VALUES(?,?,?)").run(origin,receipt.previous_epoch,id);
  db.prepare("INSERT INTO federation_sources VALUES(?,?,?,?) ON CONFLICT(origin_node_id) DO UPDATE SET origin_epoch=excluded.origin_epoch,display_name=excluded.display_name,last_seen_at=excluded.last_seen_at")
   .run(origin,receipt.new_epoch,observation.hello.node.display_name,now);
  for(const p of plan.projects){
   const old=db.prepare("SELECT * FROM federation_epoch_projects WHERE origin_node_id=? AND project_id=?").get(origin,p.project_id);
   if(old)db.prepare("INSERT INTO federation_epoch_archive VALUES(?,?,?,?)").run(id,"federation_epoch_projects",p.project_id,canonical(old));
   db.prepare("INSERT INTO federation_epoch_projects VALUES(?,?,?,?,'pending',?) ON CONFLICT(origin_node_id,project_id) DO UPDATE SET target_epoch=excluded.target_epoch,acceptance_id=excluded.acceptance_id,state='pending',updated_at=excluded.updated_at")
    .run(origin,p.project_id,receipt.new_epoch,id,now);
  }
  db.prepare("DELETE FROM federation_snapshot_received WHERE snapshot_id IN (SELECT snapshot_id FROM federation_snapshot_staging WHERE origin_node_id=?)").run(origin);
  db.prepare("DELETE FROM federation_snapshot_staging WHERE origin_node_id=?").run(origin);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_sync_attempts'").get())
   db.prepare("UPDATE federation_sync_attempts SET retry_after=0,error_code=NULL,failure_count=0,has_more=1 WHERE origin_node_id=?").run(origin);
  return receipt;
 });
}
export function sourceRecoveryHistory(db,origin){
 uuid(origin,"origin");
 return {acceptances:db.prepare("SELECT receipt_json FROM federation_epoch_acceptances WHERE origin_node_id=? ORDER BY rowid").all(origin).map(x=>JSON.parse(x.receipt_json)),
  projects:db.prepare("SELECT * FROM federation_epoch_projects WHERE origin_node_id=? ORDER BY project_id").all(origin),
  missing:db.prepare("SELECT * FROM federation_recovery_missing WHERE owner_node_id=? ORDER BY task_uid").all(origin).map(x=>({...x,replica:JSON.parse(x.replica_json),replica_json:undefined})),
  archive:db.prepare("SELECT a.* FROM federation_epoch_archive a JOIN federation_epoch_acceptances e USING(acceptance_id) WHERE e.origin_node_id=? ORDER BY a.rowid").all(origin).map(x=>({...x,row:JSON.parse(x.row_json),row_json:undefined}))};
}
