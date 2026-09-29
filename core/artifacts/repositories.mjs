import {PeerError,names,uuid} from "../federation/protocol.mjs";
import {localIdentity,transaction} from "../federation/peers.mjs";
import {canonical,digest} from "../federation/sync-store.mjs";
import {allowedPaths,objectId,repositoryReader} from "./git-reader.mjs";
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const at=()=>new Date().toISOString();
function unit(db,work){if(!db.isTransaction)return transaction(db,work);db.exec("SAVEPOINT repository_unit");try{const r=work();db.exec("RELEASE repository_unit");return r;}catch(e){db.exec("ROLLBACK TO repository_unit; RELEASE repository_unit");throw e;}}
function ids(projectId,repoId){names([projectId],"project_id",null,1);names([repoId],"repo_id",null,1);}
const has=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='repository_mappings'").get();
function readable(db){if(has(db)&&db.prepare("SELECT version FROM repository_schema").get()?.version!==1)fail("SCHEMA_INCOMPATIBLE","仓库登记版本不兼容");}
export function migrateRepositories(db){return unit(db,()=>{
 localIdentity(db);
 db.exec("CREATE TABLE IF NOT EXISTS repository_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO repository_schema VALUES(1,1)");
 if(db.prepare("SELECT version FROM repository_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","仓库登记版本不兼容");
 db.exec([
  "CREATE TABLE IF NOT EXISTS repository_mappings(mapping_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,project_id TEXT NOT NULL,repo_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,descriptor_digest TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(node_epoch,project_id,repo_id));",
  "CREATE TABLE IF NOT EXISTS repository_bases(mapping_id TEXT NOT NULL,commit_oid TEXT NOT NULL,tree_oid TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(mapping_id,commit_oid));",
  "CREATE TABLE IF NOT EXISTS repository_events(id INTEGER PRIMARY KEY,mapping_id TEXT NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);"
 ].join("\n"));
 for(const t of ["repository_mappings","repository_bases","repository_events"]){db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_immutable BEFORE UPDATE ON "+t+" BEGIN SELECT RAISE(ABORT,'repository history is immutable'); END");db.exec("CREATE TRIGGER IF NOT EXISTS "+t+"_retained BEFORE DELETE ON "+t+" BEGIN SELECT RAISE(ABORT,'repository history must be retained'); END");}
});}
function event(db,id,kind,detail){db.prepare("INSERT INTO repository_events(mapping_id,kind,detail_json,created_at) VALUES(?,?,?,?)").run(id,kind,canonical(detail),at());}
function row(db,{mappingId,projectId,repoId}){
 readable(db);const n=localIdentity(db);let r;
 if(mappingId){uuid(mappingId,"mapping_id");r=has(db)?db.prepare("SELECT * FROM repository_mappings WHERE mapping_id=?").get(mappingId):null;}
 else{ids(projectId,repoId);r=has(db)?db.prepare("SELECT * FROM repository_mappings WHERE node_epoch=? AND project_id=? AND repo_id=?").get(n.sync_epoch,projectId,repoId):null;}
 if(!r)fail("REPOSITORY_NOT_REGISTERED","当前节点没有该仓库映射");
 if(r.node_id!==n.node_id||r.node_epoch!==n.sync_epoch)fail("REPOSITORY_RECOVERY_REQUIRED","旧节点代次的仓库映射需要重新核验登记");return r;
}
function publicRow(db,r){const d=JSON.parse(r.descriptor_json);return {mapping_id:r.mapping_id,node_id:r.node_id,node_epoch:r.node_epoch,project_id:r.project_id,repo_id:r.repo_id,object_format:d.object_format,allowed_paths:d.allowed_paths,approved_bases:db.prepare("SELECT commit_oid,tree_oid FROM repository_bases WHERE mapping_id=? ORDER BY commit_oid").all(r.mapping_id)};}
export function repositoryState(db,args){return publicRow(db,row(db,args));}
export function listRepositories(db,{projectId,limit=100}){
 names([projectId],"project_id",null,1);if(!Number.isInteger(limit)||limit<1||limit>100)fail("BAD_INPUT","列表上限无效");const n=localIdentity(db);
 readable(db);if(!has(db))return {repositories:[]};
 return {repositories:db.prepare("SELECT mapping_id,project_id,repo_id,node_id=? AND node_epoch=? identity_current FROM repository_mappings WHERE project_id=? ORDER BY rowid DESC LIMIT ?").all(n.node_id,n.sync_epoch,projectId,limit)};
}
function reader(r){const d=JSON.parse(r.descriptor_json),g=repositoryReader({root:d.root,git:d.git});if(canonical(g.info)!==canonical({root:d.root,common_dir:d.common_dir,object_format:d.object_format,git:d.git}))fail("REPOSITORY_CHANGED","仓库位置、对象目录或 Git 登记已改变");return {g,d};}
/** Trusted local administration only: no peer or agent may supply this path/configuration. */
export function registerRepository(db,{mappingId,projectId,repoId,root,git,baseCommit,paths}){
 uuid(mappingId,"mapping_id");ids(projectId,repoId);objectId(baseCommit);const policy=allowedPaths(paths),g=repositoryReader({root,git}),base=g.commit(baseCommit);g.verify();
 const descriptor={...g.info,initial_base:baseCommit,allowed_paths:policy};
 return unit(db,()=>{
  migrateRepositories(db);const n=localIdentity(db),old=db.prepare("SELECT * FROM repository_mappings WHERE mapping_id=?").get(mappingId);
  if(old){row(db,{mappingId});if(old.project_id!==projectId||old.repo_id!==repoId||old.descriptor_json!==canonical(descriptor))fail("REQUEST_CONFLICT","仓库登记 ID 已绑定其他配置");return publicRow(db,old);}
  if(db.prepare("SELECT 1 FROM repository_mappings WHERE node_epoch=? AND project_id=? AND repo_id=?").get(n.sync_epoch,projectId,repoId))fail("MAPPING_EXISTS","当前代次已有该仓库映射，不能静默替换路径");
  if(db.prepare("SELECT count(*) n FROM repository_mappings WHERE node_epoch=? AND project_id=?").get(n.sync_epoch,projectId).n>=100)fail("REPOSITORY_LIMIT","当前项目仓库映射超过上限");
  db.prepare("INSERT INTO repository_mappings VALUES(?,?,?,?,?,?,?,?)").run(mappingId,n.node_id,n.sync_epoch,projectId,repoId,canonical(descriptor),digest(descriptor),at());
  db.prepare("INSERT INTO repository_bases VALUES(?,?,?,?)").run(mappingId,base.commit,base.tree,at());event(db,mappingId,"registered",{descriptor_digest:digest(descriptor),base_commit:base.commit,base_tree:base.tree});return publicRow(db,row(db,{mappingId}));
 });
}
export function approveRepositoryBase(db,{mappingId,baseCommit}){
 objectId(baseCommit);const r=row(db,{mappingId}),{g}=reader(r),base=g.commit(baseCommit);g.verify();
 return unit(db,()=>{
  row(db,{mappingId});const old=db.prepare("SELECT tree_oid FROM repository_bases WHERE mapping_id=? AND commit_oid=?").get(mappingId,baseCommit);
  if(old){if(old.tree_oid!==base.tree)fail("OBJECT_CORRUPT","基础提交的目录对象已改变");return publicRow(db,r);}
  if(db.prepare("SELECT count(*) n FROM repository_bases WHERE mapping_id=?").get(mappingId).n>=1000)fail("BASE_LIMIT","仓库批准基线上限已达 1000");
  db.prepare("INSERT INTO repository_bases VALUES(?,?,?,?)").run(mappingId,base.commit,base.tree,at());event(db,mappingId,"base_approved",{base_commit:base.commit,base_tree:base.tree});return publicRow(db,r);
 });
}
/** Captures committed bytes only. Caller must persist/bind them before sending or accepting. */
export function captureRepositoryFiles(db,{projectId,repoId,baseCommit,commit,paths}){
 objectId(baseCommit);objectId(commit);const r=row(db,{projectId,repoId});
 const approved=db.prepare("SELECT tree_oid FROM repository_bases WHERE mapping_id=? AND commit_oid=?").get(r.mapping_id,baseCommit);if(!approved)fail("BASE_NOT_APPROVED","基础提交未获本机明确批准");
 const {g,d}=reader(r),captured=g.capture({baseCommit,commit,paths,allowed:d.allowed_paths});g.verify();row(db,{mappingId:r.mapping_id});
 if(approved.tree_oid!==captured.base_tree)fail("OBJECT_CORRUPT","基线目录与批准记录不同");
 const manifest={schema_version:1,kind:"repository_content_snapshot",project_id:projectId,repo_id:repoId,object_format:captured.object_format,base_commit:captured.base_commit,base_tree:captured.base_tree,commit:captured.commit,tree:captured.tree,total_bytes:captured.total_bytes,files:captured.files.map(({bytes,...metadata})=>metadata)};
 return {mapping_id:r.mapping_id,manifest,manifest_digest:digest(manifest),files:captured.files.map(f=>({path:f.path,bytes:f.bytes})),accepted:false};
}
