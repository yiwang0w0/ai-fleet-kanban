// Local administration of MCP role policies and per-agent capabilities.
import {randomUUID,randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {readFileSync,statSync,unlinkSync} from "node:fs";
import {isAbsolute} from "node:path";
import {localIdentity} from "../federation/peers.mjs";
import {atomic,canonical,digest} from "../federation/sync-store.mjs";
import {PeerError,keys,names,uuid,version} from "../federation/protocol.mjs";
import {writeRecoveryJSON} from "../recovery.mjs";
export const ROLE_KINDS=["coordinate","implement","review","observe"];
export const READ_TOOLS=["list_nodes","list_roles","get_task","get_sync_status","get_delegation"];
export const ROLE_TOOLS=Object.freeze({
 coordinate:[...READ_TOOLS,"create_task","split_task","request_assignment","create_delegation","decide_delegation","prepare_topology"],
 implement:["get_task","list_roles","report_result","heartbeat","split_task"],
 review:["get_task","list_roles","report_result","heartbeat"],
 observe:READ_TOOLS
});
export const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
export function exact(x,fields,label){keys(x,fields,label);if(Object.keys(x).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失",400);}
function integer(x,label,min,max){if(!Number.isSafeInteger(x)||x<min||x>max)fail("BAD_INPUT",label+" 超出范围",400);return x;}
export function rolePolicy(input){
 exact(input,["role_id","kind","projects","capabilities","runtime","model","effort","tools","priority","enabled","limits"],"role");
 const role_id=names([input.role_id],"role_id",null,1)[0],projects=names(input.projects,"projects",null,1),capabilities=names(input.capabilities,"capabilities");
 if(!ROLE_KINDS.includes(input.kind)||typeof input.enabled!=="boolean"||!["read-only","write"].includes(input.tools))fail("BAD_INPUT","角色种类或工具权限无效",400);
 const execution=["implement","review"].includes(input.kind);
 if(execution){
  if(!["claude","codex","zcode"].includes(input.runtime))fail("BAD_INPUT","执行角色必须声明受支持的运行时",400);
  for(const k of ["model","effort"])if(typeof input[k]!=="string"||!input[k]||input[k].length>120||/[\u0000-\u001f\u007f]/.test(input[k]))fail("BAD_INPUT","模型或推理档位无效",400);
 }else if(input.runtime!==null||input.model!==null||input.effort!==null)fail("BAD_INPUT","非执行角色不能声明模型",400);
 if(["review","observe"].includes(input.kind)&&input.tools!=="read-only")fail("BAD_INPUT","审阅与观察角色必须只读",400);
 integer(input.priority,"priority",0,1000);
 exact(input.limits,["max_task_attempts","max_open_tasks","requests_per_minute"],"limits");
 integer(input.limits.max_task_attempts,"max_task_attempts",1,10);integer(input.limits.max_open_tasks,"max_open_tasks",1,1000);integer(input.limits.requests_per_minute,"requests_per_minute",1,300);
 return {...input,role_id,projects,capabilities,limits:{...input.limits}};
}
export function migrateBroker(db){
 return atomic(db,()=>{
  localIdentity(db);
  db.exec([
   "CREATE TABLE IF NOT EXISTS broker_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);",
   "INSERT OR IGNORE INTO broker_schema VALUES(1,1);",
   "CREATE TABLE IF NOT EXISTS broker_roles(role_id TEXT PRIMARY KEY,version INTEGER NOT NULL,policy_json TEXT NOT NULL,policy_digest TEXT NOT NULL,updated_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS broker_principals(principal_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,role_id TEXT NOT NULL,role_version INTEGER NOT NULL,projects_json TEXT NOT NULL,agent_instance_id TEXT NOT NULL,run_id TEXT,secret_hash TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('active','revoked')),created_at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS broker_auth_events(id INTEGER PRIMARY KEY,principal_id TEXT,role_id TEXT,action TEXT NOT NULL,version INTEGER NOT NULL,at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS broker_task_projects(task_id INTEGER PRIMARY KEY,task_uid TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,work_kind TEXT NOT NULL,capabilities_json TEXT NOT NULL);",
   "CREATE TRIGGER IF NOT EXISTS broker_task_project_immutable BEFORE UPDATE ON broker_task_projects BEGIN SELECT RAISE(ABORT,'broker project admission is immutable'); END;",
   "CREATE TABLE IF NOT EXISTS broker_requests(principal_id TEXT NOT NULL,request_id TEXT NOT NULL,tool_name TEXT NOT NULL,args_digest TEXT NOT NULL,result_json TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(principal_id,request_id));",
   "CREATE TABLE IF NOT EXISTS broker_audit(id INTEGER PRIMARY KEY,principal_id TEXT NOT NULL,tool_name TEXT NOT NULL,request_id TEXT,args_digest TEXT NOT NULL,outcome TEXT NOT NULL,at TEXT NOT NULL);",
   "CREATE TABLE IF NOT EXISTS broker_rate(principal_id TEXT PRIMARY KEY,window_start INTEGER NOT NULL,count INTEGER NOT NULL);",
   "CREATE TABLE IF NOT EXISTS broker_assignments(assignment_id TEXT PRIMARY KEY,task_uid TEXT NOT NULL,task_version INTEGER NOT NULL,project_id TEXT NOT NULL,role_id TEXT,role_version INTEGER,policy_digest TEXT,policy_json TEXT,state TEXT NOT NULL CHECK(state IN('waiting_policy','waiting_release','waiting_executor','claimed','ended','cancelled')),reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL);",
   "CREATE UNIQUE INDEX IF NOT EXISTS broker_assignment_active ON broker_assignments(task_uid) WHERE state NOT IN('ended','cancelled');"
  ].join("\n"));
  if(db.prepare("SELECT version FROM broker_schema").get().version!==1)fail("SCHEMA_INCOMPATIBLE","MCP代理存储版本不兼容");
 });
}
export function getRole(db,id){
 const row=db.prepare("SELECT * FROM broker_roles WHERE role_id=?").get(id);
 return row?{role_id:row.role_id,version:row.version,policy:JSON.parse(row.policy_json),policy_digest:row.policy_digest}:null;
}
export function putRole(db,policy,expectedVersion){
 policy=rolePolicy(policy);return atomic(db,()=>{
  localIdentity(db);const old=getRole(db,policy.role_id);
  if(old){version(expectedVersion);if(old.version!==expectedVersion)fail("CONFLICT","角色版本已变化");if(old.version>=Number.MAX_SAFE_INTEGER)fail("VERSION_EXHAUSTED","角色版本已达上限");}
  else if(expectedVersion!==undefined)fail("CONFLICT","角色尚未登记");
  const next=(old?.version??0)+1,now=new Date().toISOString();
  db.prepare("INSERT INTO broker_roles VALUES(?,?,?,?,?) ON CONFLICT(role_id) DO UPDATE SET version=excluded.version,policy_json=excluded.policy_json,policy_digest=excluded.policy_digest,updated_at=excluded.updated_at").run(policy.role_id,next,canonical(policy),digest(policy),now);
  db.prepare("INSERT INTO broker_auth_events(principal_id,role_id,action,version,at) VALUES(NULL,?,'role_update',?,?)").run(policy.role_id,next,now);
  return getRole(db,policy.role_id);
 });
}
function boundRun(db,principal,role,{requireLaunch=true}={}){
 if(!principal.run_id)return null;
 const r=db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(principal.run_id);
 if(!r||r.agent_instance_id!==principal.agent_instance_id||r.role_id!==role.role_id||r.runtime!==role.policy.runtime)fail("RUN_MISMATCH","凭据未绑定该执行实例",403);
 const t=db.prepare("SELECT * FROM tasks WHERE id=?").get(r.task_id);
 if(!t||t.run_id!==r.run_id||t.archived_at)fail("RUN_EXPIRED","执行实例已失效",403);
 const project=db.prepare("SELECT project_id FROM broker_task_projects WHERE task_id=?").get(r.task_id)?.project_id;
 if(!principal.projects.includes(project))fail("FORBIDDEN","执行实例不属于授权项目",403);
 const context=JSON.parse(r.policy_json).context;
 if(context.broker_role_version!==role.version||context.broker_role_digest!==role.policy_digest)fail("POLICY_CHANGED","执行实例策略不是当前代理角色策略",403);
 if(requireLaunch&&context.dispatch_id){
  const table=db.prepare("SELECT 1 FROM sqlite_master WHERE name='broker_dispatches'").get();
  const dispatch=table?db.prepare("SELECT run_id,agent_instance_id,launch_at,phase FROM broker_dispatches WHERE dispatch_id=?").get(context.dispatch_id):null;
  if(!dispatch||dispatch.run_id!==r.run_id||dispatch.agent_instance_id!==principal.agent_instance_id||!dispatch.launch_at||dispatch.phase==="abandoned")fail("LAUNCH_NOT_AVAILABLE","运行尚未获得已提交的启动许可",403);
 }
 return {...r,task:t,project_id:project};
}
export function issuePrincipal(db,{roleId,projects,runId=null,credentialFile}){
 projects=names(projects,"projects",null,1);
 if(typeof credentialFile!=="string"||!isAbsolute(credentialFile))fail("BAD_INPUT","凭据需要新文件的绝对路径",400);
 let created=false;
 try{return atomic(db,()=>{
  const node=localIdentity(db),role=getRole(db,roleId);
  if(!role?.policy.enabled)fail("ROLE_UNAVAILABLE","角色未登记或未启用");
  if(projects.some(p=>!role.policy.projects.includes(p)))fail("FORBIDDEN","项目超过角色授权范围",403);
  const execution=["implement","review"].includes(role.policy.kind);
  if(execution)uuid(runId,"run_id");else if(runId!==null)fail("BAD_INPUT","非执行身份不能绑定 run",400);
  const run=runId?db.prepare("SELECT * FROM task_runs WHERE run_id=? AND state='running'").get(runId):null;
  if(execution&&!run)fail("RUN_EXPIRED","没有有效运行实例");
  const principal_id=randomUUID(),agent_instance_id=run?.agent_instance_id??randomUUID();
  uuid(agent_instance_id,"agent_instance_id");
  const principal={principal_id,agent_instance_id,run_id:runId,projects};
  if(execution)boundRun(db,principal,role,{requireLaunch:false});
  const token=principal_id+"."+randomBytes(32).toString("base64url"),now=new Date().toISOString();
  db.prepare("INSERT INTO broker_principals VALUES(?,?,?,?,?,?,?,?,?,1,'active',?)").run(principal_id,node.node_id,node.sync_epoch,roleId,role.version,JSON.stringify(projects),agent_instance_id,runId,createHash("sha256").update(token).digest("hex"),now);
  db.prepare("INSERT INTO broker_auth_events(principal_id,role_id,action,version,at) VALUES(?,?,'issue',1,?)").run(principal_id,roleId,now);
  writeRecoveryJSON(credentialFile,{format:"ai-fleet-mcp-credential/v1",node_id:node.node_id,node_epoch:node.sync_epoch,principal_id,credential_version:1,token});created=true;
  return {...principal,role_id:roleId,role_version:role.version,credential_version:1,node_id:node.node_id,node_epoch:node.sync_epoch};
 });}catch(e){if(created){try{unlinkSync(credentialFile);}catch{}}throw e;}
}
export function revokePrincipal(db,{principalId,expectedVersion}){
 uuid(principalId,"principal_id");version(expectedVersion);
 return atomic(db,()=>{
  localIdentity(db);const p=db.prepare("SELECT * FROM broker_principals WHERE principal_id=?").get(principalId);
  if(!p||p.version!==expectedVersion)fail("CONFLICT","凭据版本已变化或不存在");
  if(p.version>=Number.MAX_SAFE_INTEGER)fail("VERSION_EXHAUSTED","凭据版本已达上限");
  db.prepare("UPDATE broker_principals SET status='revoked',secret_hash='',version=version+1 WHERE principal_id=?").run(principalId);
  db.prepare("INSERT INTO broker_auth_events(principal_id,role_id,action,version,at) VALUES(?,?,'revoke',?,?)").run(principalId,p.role_id,p.version+1,new Date().toISOString());
  return {principal_id:principalId,status:"revoked",credential_version:p.version+1};
 });
}
export function authenticatePrincipal(db,authorization){
 const node=localIdentity(db),m=typeof authorization==="string"&&authorization.match(/^Bearer ([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})$/);
 const token=m?m[1]:"",p=db.prepare("SELECT * FROM broker_principals WHERE principal_id=?").get(token.split(".")[0]);
 const valid=p?.status==="active"&&/^[0-9a-f]{64}$/.test(p.secret_hash),expected=valid?Buffer.from(p.secret_hash,"hex"):Buffer.alloc(32);
 const equal=timingSafeEqual(createHash("sha256").update(token).digest(),expected);
 if(!valid||!equal||p.node_id!==node.node_id||p.node_epoch!==node.sync_epoch)fail("UNAUTHENTICATED","需要本节点当前代次的有效 MCP 凭据",401);
 const role=getRole(db,p.role_id);
 if(!role?.policy.enabled||role.version!==p.role_version)fail("POLICY_CHANGED","角色策略已更新，需重新授权",403);
 const principal={principal_id:p.principal_id,version:p.version,role,projects:JSON.parse(p.projects_json),agent_instance_id:p.agent_instance_id,run_id:p.run_id};
 if(principal.projects.some(x=>!role.policy.projects.includes(x)))fail("FORBIDDEN","凭据项目不再获准",403);
 principal.run=boundRun(db,principal,role);
 return principal;
}
export function loadPrincipalCredential(file){
 if(statSync(file).size>16384)fail("BAD_CREDENTIAL","MCP凭据文件超限",400);
 let c;try{c=JSON.parse(readFileSync(file,"utf8"));}catch{fail("BAD_CREDENTIAL","MCP凭据不是有效 JSON",400);}exact(c,["format","node_id","node_epoch","principal_id","credential_version","token"],"credential");
 for(const k of ["node_id","node_epoch","principal_id"])uuid(c[k],k);version(c.credential_version);
 if(c.format!=="ai-fleet-mcp-credential/v1"||typeof c.token!=="string"||!new RegExp("^"+c.principal_id+"\\.[A-Za-z0-9_-]{43}$").test(c.token))fail("BAD_CREDENTIAL","MCP凭据格式无效",400);
 return c;
}
