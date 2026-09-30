import {workspaceFileInfo,listWorkspaceFiles,readWorkspaceFile,editWorkspaceFile,deleteWorkspaceFile} from "../artifacts/workspace-session.mjs";
import {repositoryState,listRepositories} from "../artifacts/repositories.mjs";
import {migrateResults,prepareResult,rejectResult,resultState,listResults} from "../federation/results.mjs";
import {migrateCancellations,listCancellations,prepareCancellation,cancellationState} from "../federation/cancellation.mjs";
import {progressCancellation} from "../federation/cancellation-service.mjs";
import {migrateBindings,prepareBinding,bindingState,listBindings,releaseBoundTask,bindingProposalState,declineBindingProposal,PROPOSAL_DECLINE_REASONS} from "../federation/bindings.mjs";
import {prepareTopology,topologyState} from "../federation/topology.mjs";
import {createRequire} from "node:module";
import {migrateDelegation,createIntent,decideIncoming,incomingStatus,outgoingStatus} from "../federation/delegation.mjs";
import {randomUUID} from "node:crypto";
import {atomic,canonical,digest} from "../federation/sync-store.mjs";
import {localIdentity} from "../federation/peers.mjs";
import {uuid,names,version} from "../federation/protocol.mjs";
import {ROLE_TOOLS,READ_TOOLS,roleTools,isReadTool,authenticatePrincipal,getRole,fail} from "./policy.mjs";
const require=createRequire(import.meta.url),store=require("../store.js");
const text=(max=16384)=>({type:"string",maxLength:max});
const uuidSchema={type:"string",pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"};
const uid={type:"string",pattern:uuidSchema.pattern.slice(0,-1)+"/"+uuidSchema.pattern.slice(1)};
const name={type:"string",pattern:"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$"};
const positive={type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const caps={type:"array",maxItems:32,uniqueItems:true,items:name};
const object=(properties,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const taskInput={request_id:uuidSchema,project_id:name,subject:{...text(500),minLength:1},description:text(),acceptance:text(),work_kind:{enum:["implement","review"]},required_capabilities:caps};
const relationInput=object({schema_version:{enum:[1]},type:{enum:["delegation"]},relation_id:uuidSchema,delegation_id:uuidSchema,project_id:name,graph_id:uuidSchema,graph_epoch:uuidSchema,source_node_id:uuidSchema,source_epoch:uuidSchema,source_task_uid:uid,target_node_id:uuidSchema,target_epoch:uuidSchema,target_task_uid:uid,offer_digest:{type:"string",pattern:"^[0-9a-f]{64}$"},source_topology_revision:positive,target_topology_revision:positive});
const defs=[
 ["get_workspace","读取本次运行的文件会话和允许范围",object({task_uid:uid})],
 ["list_workspace_files","按会话版本分页列出任务文件",object({task_uid:uid,expected_revision:{...positive,minimum:0},after_path:text(1024),limit:{...positive,maximum:100}})],
 ["read_workspace_file","读取当前文件版本的 UTF-8 字节范围",object({task_uid:uid,path:text(1024),expected_version:positive,offset:{...positive,minimum:0},limit:{...positive,minimum:4,maximum:65536}})],
 ["edit_workspace_file","按文件版本替换 UTF-8 字节范围；修改与调用回执原子保存",object({request_id:uuidSchema,task_uid:uid,path:text(1024),expected_version:{...positive,minimum:0},offset:{...positive,minimum:0},delete_bytes:{...positive,minimum:0},content:text(65536),executable:{type:"boolean"}})],
 ["delete_workspace_file","按版本标记删除本次运行允许修改的文件",object({request_id:uuidSchema,task_uid:uid,path:text(1024),expected_version:positive})],
 ["get_repository","读取本项目已登记仓库与批准基线，不返回本机路径",object({project_id:name,repo_id:name})],
 ["list_repositories","列出本项目仓库映射与身份是否为当前代次",object({project_id:name,limit:{...positive,maximum:100}})],
 ["get_result","读取候选交付、接收回执与来源决定",object({result_id:uuidSchema})],
 ["list_results","列出授权项目候选交付",object({project_id:name,limit:{...positive,maximum:100}})],
 ["prepare_result","封存实际运行结果和当前任务版本；不等于来源验收",object({request_id:uuidSchema,relation_id:uuidSchema,expected_version:positive})],
 ["reject_result","来源要求候选交付返工；不代替取消",object({request_id:uuidSchema,result_id:uuidSchema,expected_version:positive,note:{...text(4096),minLength:1}})],
 ["get_cancellation","读取委派取消是否送达及是否已确认停止",object({relation_id:uuidSchema})],
 ["list_cancellations","列出授权项目的持久取消记录",object({project_id:name,limit:{...positive,maximum:100}})],
 ["request_cancellation","请求取消已确认的来源委派；不把未送达当成已停止",object({request_id:uuidSchema,relation_id:uuidSchema,expected_version:positive,reason_code:{enum:["operator_cancelled","deadline_exceeded"]}})],
 ["progress_cancellation","处理本机未启动分派和下游取消意向，核对实际停止证明",object({request_id:uuidSchema,relation_id:uuidSchema})],
 ["list_bindings","列出授权项目的端点绑定和待处理提案",object({project_id:name,limit:{...positive,maximum:100}})],
 ["get_binding","读取授权项目的端点确认与放行条件",object({relation_id:uuidSchema})],
 ["get_binding_proposal","读取授权项目的认证提案及其本方决定",object({relation_id:uuidSchema})],
 ["decline_binding_proposal","明确拒绝尚未准备的提案；不代替来源撤回或执行取消",object({request_id:uuidSchema,relation_id:uuidSchema,expected_descriptor_digest:{type:"string",pattern:"^[0-9a-f]{64}$"},reason_code:{enum:PROPOSAL_DECLINE_REASONS}})],
 ["prepare_binding","核对实际委派合同并准备本方端点绑定",object({request_id:uuidSchema,relation:relationInput,expected_version:positive})],
 ["release_delegation","仅放行双方已确认且当前授权有效的接收任务；不启动模型",object({request_id:uuidSchema,relation_id:uuidSchema,expected_version:positive})],
 ["prepare_topology","提交授权项目的本地结构修改；等待登记回执，不发起网络请求",object({request_id:uuidSchema,project_id:name,expected_revision:{...positive,minimum:0},edits:{type:"array",maxItems:100,items:object({task_uid:uid,expected_version:positive,parent_uid:{type:["string","null"],pattern:uid.pattern},blocked_by:{type:"array",maxItems:10000,uniqueItems:true,items:uid}})}})],
 ["get_delegation","读取授权项目中的委派合同与接收决定",object({delegation_id:uuidSchema,direction:{enum:["incoming","outgoing"]}})],
 ["create_delegation","提出跨终端委派；不自动发送、接受或启动",object({request_id:uuidSchema,task_uid:uid,expected_version:positive,target_node_id:uuidSchema,target_epoch:uuidSchema})],
 ["decide_delegation","接受或拒绝接收意向；接受仍等待关系确认",object({request_id:uuidSchema,delegation_id:uuidSchema,expected_version:positive,decision:{enum:["accept","reject"]},note:text(512)})],
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
 annotations:{readOnlyHint:isReadTool(name),destructiveHint:false,idempotentHint:true,openWorldHint:false}})));
export function validate(value,schema,path="arguments"){
 if(Array.isArray(schema.type)){if(value===null&&schema.type.includes("null"))return;return validate(value,{...schema,type:schema.type.find(t=>t!=="null")},path);}
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
function permitted(p,tool){if(!roleTools(p.role.policy).includes(tool))fail("FORBIDDEN","角色无权使用该工具",403);}
function scoped(p,project){if(!p.projects.includes(project))fail("FORBIDDEN","项目未授权",403);}
const marks=p=>p.projects.map(()=>"?").join(",");
function localTask(db,p,taskUid){
 const t=db.prepare("SELECT t.*,p.project_id,p.work_kind,p.capabilities_json FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id AND p.task_uid=t.task_uid WHERE t.task_uid=?").get(taskUid);
 if(!t||!p.projects.includes(t.project_id))fail("NOT_FOUND","授权范围内未找到该任务",404);
 if(p.run&&t.run_id!==p.run_id||p.run&&t.task_uid!==p.run.task_uid)fail("FORBIDDEN","执行身份只能操作自己的运行实例",403);
 return t;
}
const TASK_FIELDS=["id","task_uid","owner_node_id","subject","description","acceptance","status","waiting_for","kind","tree_mode","run_id","attempts","max_attempts","aggregate_version","result","created_at","updated_at"];
function taskOut(db,t,project){
 const out=Object.fromEntries(TASK_FIELDS.map(k=>[k,t[k]??null]));
 const parent=t.parent_id==null?null:db.prepare("SELECT task_uid FROM broker_task_projects WHERE task_id=? AND project_id=?").get(t.parent_id,project)?.task_uid??null;
 let topology=null;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'topology_bindings\'").get()){
  const b=db.prepare("SELECT b.phase,b.revision,b.owner_epoch=(SELECT sync_epoch FROM board_node WHERE singleton=1) identity_current,EXISTS(SELECT 1 FROM topology_vertices v WHERE v.task_id=? AND v.task_uid=?) registered FROM topology_bindings b WHERE b.project_id=?").get(t.id,t.task_uid,project);
  if(b){const pending=db.prepare("SELECT o.operation_id,json_extract(v.value,\'$.parent_uid\') desired_parent_uid FROM topology_operations o,json_each(o.desired_json,\'$.vertices\') v WHERE o.project_id=? AND o.state=\'prepared\' AND json_extract(v.value,\'$.task_uid\')=?").get(project,t.task_uid);topology={...b,identity_current:!!b.identity_current,registered:!!b.registered,pending:pending?{...pending}:null};}
 }
 return {...out,project_id:project,parent_uid:parent,released:Boolean(t.released),read_only:false,...(topology?{topology}:{})};
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
 const managed=split&&db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'topology_bindings\'").get()&&db.prepare("SELECT 1 FROM topology_bindings WHERE project_id=?").get(args.project_id);
 const id=store.add(db,{subject:args.subject,description:args.description,acceptance:args.acceptance,
  kind:split?"task":args.kind,parentId:managed?null:parent?.id??null,treeMode:managed?parent.tree_mode:split?undefined:"hierarchical",released:0,route:"mcp",maxAttempts:p.role.policy.limits.max_task_attempts,
  actor:"mcp:"+p.principal_id,...(p.run&&!managed?{parentRunId:p.run_id,parentWorker:p.run.worker}:{})});
 const row=db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
 if(row.parent_id!==(managed?null:parent?.id??null))fail("CHAIN_LIMIT","当前任务树规则不允许该深度；没有悄悄改挂任务");
 db.prepare("INSERT INTO broker_task_projects VALUES(?,?,?,?,?)").run(id,row.task_uid,args.project_id,args.work_kind,JSON.stringify([...args.required_capabilities].sort()));
 let placement=null;
 if(managed){const b=topologyState(db,args.project_id),op=prepareTopology(db,{projectId:args.project_id,operationId:args.request_id,expectedRevision:b.revision,edits:[{task_uid:row.task_uid,expected_version:row.aggregate_version,parent_uid:parent.task_uid,blocked_by:[]}]});placement={operation_id:op.operation_id,target_parent_uid:parent.task_uid,revision:op.desired.revision};}
 return {task:taskOut(db,row,args.project_id),dispatch_started:false,...(placement?{placement_pending:placement}:{})};
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
 case "get_workspace":return workspaceFileInfo(db,p,args);
 case "list_workspace_files":return listWorkspaceFiles(db,p,args);
 case "read_workspace_file":return readWorkspaceFile(db,p,args);
 case "edit_workspace_file":return editWorkspaceFile(db,p,args);
 case "delete_workspace_file":return deleteWorkspaceFile(db,p,args);
 case "get_repository":scoped(p,args.project_id);return repositoryState(db,{projectId:args.project_id,repoId:args.repo_id});
 case "list_repositories":scoped(p,args.project_id);return listRepositories(db,{projectId:args.project_id,limit:args.limit});
 case "list_results":scoped(p,args.project_id);return db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_results'").get()?listResults(db,{projectId:args.project_id,limit:args.limit}):{results:[]};
 case "get_result":
 case "prepare_result":
 case "reject_result":{
  const table=name==="prepare_result"?"delegation_bindings":"delegation_results",key=name==="prepare_result"?"relation_id":"result_id";
  const r=db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)?db.prepare("SELECT project_id FROM "+table+" WHERE "+key+"=?").get(args[key]):null;
  if(!r||!p.projects.includes(r.project_id))fail("NOT_FOUND","授权范围内未找到交付或绑定",404);
  if(name==="get_result")return resultState(db,args.result_id);migrateResults(db);
  return name==="prepare_result"?prepareResult(db,{resultId:args.request_id,relationId:args.relation_id,expectedTaskVersion:args.expected_version}):rejectResult(db,{resultId:args.result_id,decisionId:args.request_id,expectedSourceVersion:args.expected_version,note:args.note});
 }
 case "list_cancellations":scoped(p,args.project_id);return db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_cancellations'").get()?listCancellations(db,{projectId:args.project_id,limit:args.limit}):{cancellations:[]};
 case "get_cancellation":
 case "request_cancellation":
 case "progress_cancellation":{
  const b=db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'delegation_bindings\'").get()?db.prepare("SELECT project_id FROM delegation_bindings WHERE relation_id=?").get(args.relation_id):null;
  if(!b||!p.projects.includes(b.project_id))fail("NOT_FOUND","授权范围内未找到委派绑定",404);
  if(name==="get_cancellation"){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'delegation_cancellations\'").get())fail("NOT_FOUND","未找到取消记录",404);return cancellationState(db,args.relation_id);}
  migrateCancellations(db);
  return name==="request_cancellation"?prepareCancellation(db,{relationId:args.relation_id,cancelId:args.request_id,expectedTaskVersion:args.expected_version,reasonCode:args.reason_code}):progressCancellation(db,args.relation_id);
 }
 case "list_bindings":scoped(p,args.project_id);return db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_bindings'").get()?listBindings(db,{projectId:args.project_id,limit:args.limit}):{bindings:[],proposals:[],pending_proposals:[],pending_count:0};
 case "get_binding_proposal":
 case "decline_binding_proposal":{
  const q=db.prepare("SELECT 1 FROM sqlite_master WHERE name='binding_proposals'").get()?db.prepare("SELECT project_id FROM binding_proposals WHERE relation_id=?").get(args.relation_id):null;
  if(!q||!p.projects.includes(q.project_id))fail("NOT_FOUND","授权范围内未找到绑定提案",404);
  if(name==="get_binding_proposal")return bindingProposalState(db,args.relation_id);
  migrateBindings(db);return declineBindingProposal(db,{relationId:args.relation_id,expectedDescriptorDigest:args.expected_descriptor_digest,reasonCode:args.reason_code});
 }
 case "get_binding":
 case "release_delegation":{
  const b=db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_bindings'").get()?db.prepare("SELECT project_id FROM delegation_bindings WHERE relation_id=?").get(args.relation_id):null;
  if(!b||!p.projects.includes(b.project_id))fail("NOT_FOUND","授权范围内未找到端点绑定",404);
  return name==="get_binding"?bindingState(db,args.relation_id):releaseBoundTask(db,{relationId:args.relation_id,expectedTaskVersion:args.expected_version});
 }
 case "prepare_binding":{scoped(p,args.relation.project_id);migrateBindings(db);const b=prepareBinding(db,{relation:args.relation,expectedTaskVersion:args.expected_version});return {relation_id:b.relation_id,side:b.side,state:b.state,execution_authorized:b.execution_authorized,dispatch_started:false};}
 case "list_roles":return {roles:db.prepare("SELECT role_id FROM broker_roles ORDER BY role_id").all().map(x=>getRole(db,x.role_id)).filter(r=>r.policy.projects.some(x=>p.projects.includes(x))).map(r=>({...r,policy:{...r.policy,projects:r.policy.projects.filter(x=>p.projects.includes(x))},enforcement:r.policy.capabilities.includes("workspace-files")?"mcp_workspace_files_only":"board_tool_scope_only"}))};
 case "list_nodes":{
  const local=localIdentity(db),sources=db.prepare("SELECT DISTINCT s.* FROM federation_sources s JOIN federation_cursors c ON s.origin_node_id=c.origin_node_id WHERE c.project_id IN("+marks(p)+") ORDER BY s.origin_node_id").all(...p.projects);
  return {local:{node_id:local.node_id,display_name:local.display_name,sync_epoch:local.sync_epoch},sources};
 }
 case "get_sync_status":return {
  bindings:db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_bindings'").get()?db.prepare("SELECT relation_id,delegation_id,project_id,side,state,task_uid FROM delegation_bindings WHERE project_id IN("+marks(p)+") ORDER BY rowid DESC LIMIT 100").all(...p.projects).map(b=>({...b,state:db.prepare("SELECT 1 FROM sqlite_master WHERE name='binding_completions'").get()&&db.prepare("SELECT 1 FROM binding_completions WHERE relation_id=?").get(b.relation_id)?"completed":b.state})):[],
  topologies:db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'topology_bindings\'").get()?db.prepare("SELECT b.project_id,b.graph_id,b.graph_epoch,b.registrar_node_id,b.registrar_epoch,b.revision,b.phase,b.owner_epoch=(SELECT sync_epoch FROM board_node WHERE singleton=1) identity_current,o.operation_id FROM topology_bindings b LEFT JOIN topology_operations o ON o.project_id=b.project_id AND o.state=\'prepared\' WHERE b.project_id IN("+marks(p)+") ORDER BY b.project_id").all(...p.projects):[],
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
 case "prepare_topology":{
  scoped(p,args.project_id);if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=\'topology_bindings\'").get())fail("NOT_FOUND","项目尚未绑定关系登记节点",404);
  for(const e of args.edits)for(const uid of [e.task_uid,...(e.parent_uid?[e.parent_uid]:[]),...e.blocked_by])if(localTask(db,p,uid).project_id!==args.project_id)fail("FORBIDDEN","结构端点须属于同一授权项目",403);
  const op=prepareTopology(db,{projectId:args.project_id,operationId:args.request_id,expectedRevision:args.expected_revision,edits:args.edits});return {operation_id:op.operation_id,project_id:op.project_id,state:op.state,desired_revision:op.desired.revision,dispatch_started:false};
 }
 case "get_delegation":
 case "decide_delegation":{
  const direction=name==="decide_delegation"?"incoming":args.direction;
  if(name==="decide_delegation")migrateDelegation(db);
  else if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get("delegation_"+direction))fail("NOT_FOUND","授权范围内未找到委派",404);
  const row=db.prepare("SELECT project_id,state FROM delegation_"+direction+" WHERE delegation_id=?").get(args.delegation_id);
  if(!row||!p.projects.includes(row.project_id))fail("NOT_FOUND","授权范围内未找到委派",404);
  if(name==="get_delegation")return direction==="incoming"?incomingStatus(db,args.delegation_id):outgoingStatus(db,args.delegation_id);
  if(args.decision==="accept"&&row.state==="received"){
   const n=db.prepare("SELECT count(*) n FROM broker_task_projects p JOIN tasks t ON t.id=p.task_id WHERE p.project_id=? AND t.status<>'done' AND t.archived_at IS NULL").get(row.project_id).n;
   if(n>=p.role.policy.limits.max_open_tasks)fail("BUDGET_EXHAUSTED","接收任务超过该角色的项目上限");
  }
  return decideIncoming(db,{delegationId:args.delegation_id,decisionId:args.request_id,expectedVersion:args.expected_version,decision:args.decision,note:args.note});
 }
 case "create_delegation":{
  localTask(db,p,args.task_uid);migrateDelegation(db);
  return createIntent(db,{delegationId:args.request_id,taskUid:args.task_uid,expectedVersion:args.expected_version,targetNodeId:args.target_node_id,targetEpoch:args.target_epoch});
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
 return atomic(db,()=>{const p=authenticatePrincipal(db,authorization);tickRate(db,p);return {tools:TOOL_DEFINITIONS.filter(t=>roleTools(p.role.policy).includes(t.name))};});
}
export function callTool(db,authorization,name,args){
 let principal;
 // The rate receipt commits even if the business operation later rolls back.
 atomic(db,()=>{principal=authenticatePrincipal(db,authorization);tickRate(db,principal);});
 const argDigest=digest(args??null),requestId=typeof args?.request_id==="string"?args.request_id:null;
 try{return atomic(db,()=>{
  const p=authenticatePrincipal(db,authorization),definition=TOOL_DEFINITIONS.find(t=>t.name===name);
  if(!definition)fail("UNKNOWN_TOOL","工具不存在",404);permitted(p,name);validate(args,definition.inputSchema);
  const mutation=!isReadTool(name),prior=mutation?db.prepare("SELECT * FROM broker_requests WHERE principal_id=? AND request_id=?").get(p.principal_id,args.request_id):null;
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
