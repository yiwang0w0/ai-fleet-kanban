import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {atomic,canonical,digest} from "../federation/sync-store.mjs";
import {localIdentity} from "../federation/peers.mjs";
import {uuid,names,version} from "../federation/protocol.mjs";
import {ROLE_TOOLS,READ_TOOLS,authenticatePrincipal,getRole,fail} from "./policy.mjs";
const require=createRequire(import.meta.url),store=require("../store.js");
const text=(max=16384)=>({type:"string",maxLength:max});
const uuidSchema={type:"string",pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"};
const uid={type:"string",pattern:uuidSchema.pattern.slice(0,-1)+"/"+uuidSchema.pattern.slice(1)};
const name={type:"string",pattern:"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$"};
const positive={type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const caps={type:"array",maxItems:32,uniqueItems:true,items:name};
const object=(properties,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const taskInput={request_id:uuidSchema,project_id:name,subject:{...text(500),minLength:1},description:text(),acceptance:text(),work_kind:{enum:["implement","review"]},required_capabilities:caps};
const defs=[
 ["list_nodes","列出授权项目中的终端身份与最后观察时间",object({})],
 ["list_roles","列出授权项目的角色能力和声明运行时",object({})],
 ["get_task","读取授权任务；执行身份只能读取自己的运行实例",object({task_uid:uid})],
 ["get_sync_status","读取授权项目的同步、恢复与分派状态",object({})],
 ["create_task","创建未放行的本机任务，不启动执行器",object({...taskInput,kind:{enum:["goal","task"]}})],
 ["split_task","在获准的父任务下创建未放行子任务",object({...taskInput,parent_uid:uid,expected_version:positive})],
 ["request_assignment","按角色声明生成确定性的本机分派请求，不代表已启动",object({request_id:uuidSchema,task_uid:uid,expected_version:positive})],
 ["heartbeat","续租凭据绑定的运行实例",object({request_id:uuidSchema,task_uid:uid,run_id:uuidSchema})],
 ["report_result","交付本运行实例的结果，仍需验收",object({request_id:uuidSchema,task_uid:uid,run_id:uuidSchema,outcome:{enum:["done","wait"]},evidence:text(65536)})]
];
export const TOOL_DEFINITIONS=Object.freeze(defs.map(([name,description,inputSchema])=>({name,description,inputSchema,
 annotations:{readOnlyHint:READ_TOOLS.includes(name),destructiveHint:false,idempotentHint:true,openWorldHint:false}})));
export function validate(value,schema,path="arguments"){
 if(schema.enum&&!schema.enum.includes(value))fail("BAD_INPUT",path+" 不在允许值中",400);
 if(schema.type==="object"){
  if(!value||typeof value!=="object"||Array.isArray(value))fail("BAD_INPUT",path+" 必须为对象",400);
  if(Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(value,k)))fail("BAD_INPUT",path+" 含未知或缺失字段",400);
  for(const [k,v] of Object.entries(value))validate(v,schema.properties[k],path+"."+k);
 }else if(schema.type==="string"){
  if(typeof value!=="string"||schema.minLength&&value.length<schema.minLength||schema.maxLength&&value.length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern).test(value))fail("BAD_INPUT",path+" 文本无效",400);
 }else if(schema.type==="integer"){
  if(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum)fail("BAD_INPUT",path+" 数字无效",400);
 }else if(schema.type==="array"){
  if(!Array.isArray(value)||value.length>schema.maxItems||schema.uniqueItems&&new Set(value).size!==value.length)fail("BAD_INPUT",path+" 数组无效",400);
  for(const item of value)validate(item,schema.items,path+"[]");
 }
}
function tickRate(db,p){
 const now=Date.now(),row=db.prepare("SELECT * FROM broker_rate WHERE principal_id=?").get(p.principal_id);
 const reset=!row||now-row.window_start>=60000||now<row.window_start;
 if(!reset&&row.count>=p.role.policy.limits.requests_per_minute)fail("RATE_LIMITED","本身份本分钟调用数已达上限",429);
 db.prepare("INSERT INTO broker_rate VALUES(?,?,?) ON CONFLICT(principal_id) DO UPDATE SET window_start=excluded.window_start,count=excluded.count").run(p.principal_id,reset?now:row.window_start,reset?1:row.count+1);
}
function permitted(p,tool){if(!ROLE_TOOLS[p.role.policy.kind].includes(tool))fail("FORBIDDEN","角色无权使用该工具",403);}
function scoped(p,project){if(!p.projects.includes(project))fail("FORBIDDEN","项目未授权",403);}
const marks=p=>p.projects.map(()=>"?").join(",");
function localTask(db,p,taskUid){
 const t=db.prepare("SELECT t.*,p.project_id,p.work_kind,p.capabilities_json FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE t.task_uid=?").get(taskUid);
 if(!t||!p.projects.includes(t.project_id))fail("NOT_FOUND","授权范围内未找到该任务",404);
 if(p.run&&t.run_id!==p.run_id||p.run&&t.task_uid!==p.run.task_uid)fail("FORBIDDEN","执行身份只能操作自己的运行实例",403);
 return t;
}
const TASK_FIELDS=["id","task_uid","owner_node_id","subject","description","acceptance","status","waiting_for","kind","run_id","attempts","max_attempts","aggregate_version","result","created_at","updated_at"];
function taskOut(db,t,project){
 const out=Object.fromEntries(TASK_FIELDS.map(k=>[k,t[k]??null]));
 const parent=t.parent_id==null?null:db.prepare("SELECT task_uid FROM broker_task_projects WHERE task_id=? AND project_id=?").get(t.parent_id,project)?.task_uid??null;
 return {...out,project_id:project,parent_uid:parent,released:Boolean(t.released),read_only:false};
}
function newTask(db,p,args,split){
 scoped(p,args.project_id);
 let parent=null;
 if(split){
  parent=localTask(db,p,args.parent_uid);
  if(parent.project_id!==args.project_id)fail("FORBIDDEN","父子任务必须属于同一授权项目",403);
  if(parent.aggregate_version!==args.expected_version)fail("CONFLICT","父任务已变化");
  if(p.run&&parent.status!=="in_progress")fail("RUN_EXPIRED","运行实例已结束",403);
 }
 const open=db.prepare("SELECT count(*) n FROM broker_task_projects p JOIN tasks t ON t.id=p.task_id WHERE p.project_id=? AND t.status<>'done' AND t.archived_at IS NULL").get(args.project_id).n;
 if(open>=p.role.policy.limits.max_open_tasks)fail("BUDGET_EXHAUSTED","项目未完成任务数已达到该角色上限");
 if(split&&store.placeInChain(db,{kind:"task",parentId:parent.id,released:0,description:args.description}).uplifted)fail("CHAIN_LIMIT","当前任务树规则不允许该深度；没有悄悄改挂任务");
 if(parent&&db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND lower(replace(replace(subject, ' ', ''), '　', ''))=lower(replace(replace(?, ' ', ''), '　', '')) AND archived_at IS NULL").get(parent.id,args.subject.trim()))fail("CONFLICT","该父任务下已经存在同名子任务");
 const id=store.add(db,{subject:args.subject,description:args.description,acceptance:args.acceptance,
  kind:split?"task":args.kind,parentId:parent?.id??null,released:0,route:"mcp",maxAttempts:p.role.policy.limits.max_task_attempts,
  actor:"mcp:"+p.principal_id,...(p.run?{parentRunId:p.run_id,parentWorker:p.run.worker}:{})});
 const row=db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
 if(row.parent_id!==(parent?.id??null))fail("CHAIN_LIMIT","当前任务树规则不允许该深度；没有悄悄改挂任务");
 db.prepare("INSERT INTO broker_task_projects VALUES(?,?,?,?,?)").run(id,row.task_uid,args.project_id,args.work_kind,JSON.stringify([...args.required_capabilities].sort()));
 return {task:taskOut(db,row,args.project_id),dispatch_started:false};
}
/** Local operator enrollment only; no remote tool exposes this. */
export function enrollTask(db,{id,projectId,workKind,capabilities,expectedVersion}){
 names([projectId],"project",null,1);capabilities=names(capabilities,"capabilities");version(expectedVersion);
 if(!["implement","review"].includes(workKind))fail("BAD_INPUT","work_kind 无效",400);
 return atomic(db,()=>{
  localIdentity(db);const t=db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  if(!t||t.aggregate_version!==expectedVersion)fail("CONFLICT","任务或版本不匹配");
  if(t.parent_id!==null&&db.prepare("SELECT project_id FROM broker_task_projects WHERE task_id=?").get(t.parent_id)?.project_id!==projectId)fail("PROJECT_CONFLICT","先登记同项目的父任务");
  const existing=db.prepare("SELECT * FROM broker_task_projects WHERE task_id=?").get(id);
  if(existing)fail("CONFLICT","任务已经登记，不能静默替换项目或能力合同");
  db.prepare("INSERT INTO broker_task_projects VALUES(?,?,?,?,?)").run(id,t.task_uid,projectId,workKind,JSON.stringify(capabilities));
  return {task_uid:t.task_uid,project_id:projectId};
 });
}
export function chooseRole(db,t){
 const required=JSON.parse(t.capabilities_json);
 return db.prepare("SELECT role_id FROM broker_roles ORDER BY role_id").all().map(x=>getRole(db,x.role_id)).filter(r=>r.policy.enabled&&r.policy.kind===t.work_kind&&r.policy.projects.includes(t.project_id)&&required.every(c=>r.policy.capabilities.includes(c)))
  .sort((a,b)=>a.policy.priority-b.policy.priority||(a.role_id<b.role_id?-1:a.role_id>b.role_id?1:0))[0]??null;
}
function assign(db,p,args){
 const t=localTask(db,p,args.task_uid);
 if(t.aggregate_version!==args.expected_version)fail("CONFLICT","任务版本已变化");
 if(t.kind!=="task"||t.archived_at||t.status!=="not_started")fail("CONFLICT","只能请求分派未开始的执行任务");
 const role=chooseRole(db,t),old=db.prepare("SELECT * FROM broker_assignments WHERE task_uid=? AND state NOT IN('ended','cancelled')").get(t.task_uid);
 const state=!role?"waiting_policy":!t.released?"waiting_release":"waiting_executor",reason=!role?"没有满足项目、身份类别与全部能力要求的启用角色":!t.released?"任务未放行":"等待受控执行器领取";
 if(old){
  if(old.state==="claimed")fail("CONFLICT","任务已被执行器领取");
  if(old.task_version===t.aggregate_version&&old.role_id===(role?.role_id??null)&&old.role_version===(role?.version??null)&&old.state===state)return {assignment_id:old.assignment_id,state:old.state,reason:old.reason,task_uid:t.task_uid,role_id:old.role_id,dispatch_started:false};
  db.prepare("UPDATE broker_assignments SET state='cancelled',reason='superseded by reviewed current task/policy' WHERE assignment_id=?").run(old.assignment_id);
 }
 const id=randomUUID();
 db.prepare("INSERT INTO broker_assignments VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,t.task_uid,t.aggregate_version,t.project_id,role?.role_id??null,role?.version??null,role?.policy_digest??null,role?canonical(role.policy):null,state,reason,p.principal_id,new Date().toISOString());
 return {assignment_id:id,state,reason,task_uid:t.task_uid,role_id:role?.role_id??null,dispatch_started:false};
}
function execute(db,p,name,args){
 switch(name){
 case "list_roles":return {roles:db.prepare("SELECT role_id FROM broker_roles ORDER BY role_id").all().map(x=>getRole(db,x.role_id)).filter(r=>r.policy.projects.some(x=>p.projects.includes(x))).map(r=>({...r,policy:{...r.policy,projects:r.policy.projects.filter(x=>p.projects.includes(x))},enforcement:"board_tool_scope_only"}))};
 case "list_nodes":{
  const local=localIdentity(db),sources=db.prepare("SELECT DISTINCT s.* FROM federation_sources s JOIN federation_cursors c ON s.origin_node_id=c.origin_node_id WHERE c.project_id IN("+marks(p)+") ORDER BY s.origin_node_id").all(...p.projects);
  return {local:{node_id:local.node_id,display_name:local.display_name,sync_epoch:local.sync_epoch},sources};
 }
 case "get_sync_status":return {
  dispatches:db.prepare("SELECT 1 FROM sqlite_master WHERE name='broker_dispatches'").get()?db.prepare("SELECT d.dispatch_id,d.task_uid,d.run_id,d.role_id,d.execution_mode,d.phase,d.reason,d.launch_at,d.finished_at FROM broker_dispatches d JOIN broker_assignments a ON d.assignment_id=a.assignment_id WHERE a.project_id IN("+marks(p)+") ORDER BY d.rowid DESC LIMIT 100").all(...p.projects):[],
  cursors:db.prepare("SELECT * FROM federation_cursors WHERE project_id IN("+marks(p)+")").all(...p.projects),
  recovery:db.prepare("SELECT * FROM federation_epoch_projects WHERE project_id IN("+marks(p)+")").all(...p.projects),
  assignments:db.prepare("SELECT assignment_id,task_uid,project_id,role_id,role_version,state,reason FROM broker_assignments WHERE project_id IN("+marks(p)+") ORDER BY rowid DESC LIMIT 100").all(...p.projects)};
 case "get_task":{
  const local=db.prepare("SELECT t.*,p.project_id FROM tasks t JOIN broker_task_projects p ON t.id=p.task_id WHERE t.task_uid=?").get(args.task_uid);
  if(local)return {task:taskOut(db,localTask(db,p,args.task_uid),local.project_id)};
  if(p.run)fail("NOT_FOUND","授权范围内未找到该任务",404);
  const replica=db.prepare("SELECT * FROM federation_replicas WHERE task_uid=? AND withdrawn=0").get(args.task_uid);
  const missing=!replica?db.prepare("SELECT * FROM federation_recovery_missing WHERE task_uid=? AND resolved_at IS NULL").get(args.task_uid):null;
  const r=replica??(missing?JSON.parse(missing.replica_json):null);
  if(!r||!p.projects.includes(r.project_id))fail("NOT_FOUND","授权范围内未找到该任务",404);
  const pending=db.prepare("SELECT state FROM federation_epoch_projects WHERE origin_node_id=? AND project_id=?").get(r.owner_node_id,r.project_id);
  return {task:{...JSON.parse(r.task_json),project_id:r.project_id,source_epoch:r.origin_epoch,read_only:true,recovery_state:missing?"missing_review":pending?.state==="pending"?"pending_snapshot":null}};
 }
 case "create_task":return newTask(db,p,args,false);
 case "split_task":return newTask(db,p,args,true);
 case "request_assignment":return assign(db,p,args);
 case "heartbeat":
 case "report_result":{
  const t=localTask(db,p,args.task_uid);
  if(!p.run||args.run_id!==p.run_id)fail("FORBIDDEN","工具只能使用凭据绑定的 run",403);
  if(name==="heartbeat")store.heartbeat(db,{id:t.id,worker:p.run.worker,runId:p.run_id,leaseMin:5});
  else store.report(db,{id:t.id,worker:p.run.worker,runId:p.run_id,outcome:args.outcome,evidence:args.evidence});
  return {task:taskOut(db,db.prepare("SELECT * FROM tasks WHERE id=?").get(t.id),t.project_id),accepted:false};
 }
 default:fail("UNKNOWN_TOOL","工具不存在",404);
 }
}
function responseLimit(result){if(Buffer.byteLength(canonical(result))>512*1024)fail("RESPONSE_TOO_LARGE","结果超过响应限额",413);return result;}
export function listTools(db,authorization){
 return atomic(db,()=>{const p=authenticatePrincipal(db,authorization);tickRate(db,p);return {tools:TOOL_DEFINITIONS.filter(t=>ROLE_TOOLS[p.role.policy.kind].includes(t.name))};});
}
export function callTool(db,authorization,name,args){
 let principal;
 // The rate receipt commits even if the business operation later rolls back.
 atomic(db,()=>{principal=authenticatePrincipal(db,authorization);tickRate(db,principal);});
 const argDigest=digest(args??null),requestId=typeof args?.request_id==="string"?args.request_id:null;
 try{return atomic(db,()=>{
  const p=authenticatePrincipal(db,authorization),definition=TOOL_DEFINITIONS.find(t=>t.name===name);
  if(!definition)fail("UNKNOWN_TOOL","工具不存在",404);permitted(p,name);validate(args,definition.inputSchema);
  const mutation=!READ_TOOLS.includes(name),prior=mutation?db.prepare("SELECT * FROM broker_requests WHERE principal_id=? AND request_id=?").get(p.principal_id,args.request_id):null;
  if(prior){
   if(prior.tool_name!==name||prior.args_digest!==argDigest)fail("REQUEST_CONFLICT","同一请求号不能对应不同操作或内容");
   db.prepare("INSERT INTO broker_audit(principal_id,tool_name,request_id,args_digest,outcome,at) VALUES(?,?,?,?,?,?)").run(p.principal_id,name,args.request_id,argDigest,"replayed",new Date().toISOString());
   return JSON.parse(prior.result_json);
  }
  const result=responseLimit(execute(db,p,name,args)),now=new Date().toISOString();
  if(mutation)db.prepare("INSERT INTO broker_requests VALUES(?,?,?,?,?,?)").run(p.principal_id,args.request_id,name,argDigest,canonical(result),now);
  db.prepare("INSERT INTO broker_audit(principal_id,tool_name,request_id,args_digest,outcome,at) VALUES(?,?,?,?,?,?)").run(p.principal_id,name,requestId,argDigest,"succeeded",now);
  return result;
 });}catch(e){
  db.prepare("INSERT INTO broker_audit(principal_id,tool_name,request_id,args_digest,outcome,at) VALUES(?,?,?,?,?,?)").run(principal.principal_id,String(name).slice(0,80),requestId,argDigest,e.code??"INTERNAL",new Date().toISOString());
  throw e;
 }
}
