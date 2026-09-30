import {readFileSync,statSync,realpathSync} from "node:fs";
import {isAbsolute} from "node:path";
import {PeerError,uuid,names} from "./federation/protocol.mjs";
import {localIdentity} from "./federation/peers.mjs";
import {atomic,canonical,digest} from "./federation/sync-store.mjs";
import {endpoint} from "./federation/sync-client.mjs";
import {loadPrincipalCredential,authenticatePrincipal,exact} from "./mcp/policy.mjs";
import {callTool,TOOL_DEFINITIONS,validate} from "./mcp/tools.mjs";
import {migrateDelegation,listDelegations,outgoingStatus,incomingStatus} from "./federation/delegation.mjs";
import {deliverIntent} from "./federation/delegation-client.mjs";
import {migrateCancellations,listCancellations,cancellationState} from "./federation/cancellation.mjs";
import {deliverCancellation} from "./federation/cancellation-client.mjs";
import {migrateResults,listResults,resultState} from "./federation/results.mjs";
import {deliverResult} from "./federation/result-client.mjs";
import {listBindings,bindingState} from "./federation/bindings.mjs";
const LOCAL=new Set(["create_delegation","decide_delegation","request_cancellation","progress_cancellation","prepare_result","reject_result","release_delegation"]);
const NETWORK={resend_delegation:["delegation","offer"],poll_delegation:["delegation","status"],resend_cancellation:["cancellation","send"],poll_cancellation:["cancellation","poll"],resend_result:["result","send"],poll_result:["result","poll"]};
const fail=(code,message,status=409)=>{throw new PeerError(code,message,status);};
const errorCode=e=>e instanceof PeerError&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)?e.code:"ACTION_FAILED";
const MAX_ACTIONS=10000;
function unit(db,fn){if(!db.isTransaction)return atomic(db,fn);db.exec("SAVEPOINT fleet_action_unit");try{const value=fn();db.exec("RELEASE fleet_action_unit");return value;}catch(e){db.exec("ROLLBACK TO fleet_action_unit; RELEASE fleet_action_unit");throw e;}}
function file(path){if(typeof path!=="string"||!isAbsolute(path))fail("BAD_INPUT","本机配置路径必须是绝对路径",400);return realpathSync(path);}
export function loadFleetActionsConfig(path){path=file(path);if(statSync(path).size>65536)fail("BAD_INPUT","操作配置超过 64 KiB",400);try{return JSON.parse(readFileSync(path,"utf8"));}catch{fail("BAD_INPUT","操作配置须为 JSON",400);}}
function normalizeConfig(c){
 exact(c,["format","node_id","node_epoch","principal_file","peers"],"fleet_actions_config");
 if(c.format!=="ai-fleet-actions/v1")fail("BAD_INPUT","操作配置版本无效",400);
 uuid(c.node_id,"node_id");uuid(c.node_epoch,"node_epoch");
 if(!Array.isArray(c.peers)||c.peers.length>64)fail("BAD_INPUT","最多配置 64 个对端",400);
 const seen=new Set(),peers=c.peers.map(p=>{
  exact(p,["node_id","node_epoch","projects","url","credential_file"],"fleet_peer");
  uuid(p.node_id,"node_id");uuid(p.node_epoch,"node_epoch");if(p.node_id===c.node_id||seen.has(p.node_id))fail("BAD_INPUT","对端身份重复或为本机",400);seen.add(p.node_id);
  return {...p,projects:names(p.projects,"projects",null,1),url:endpoint(p.url),credential_file:file(p.credential_file)};
 });
 return {...c,principal_file:file(c.principal_file),peers};
}
function summary(state){
 const receipt=state.receipt??null;
 return {state:state.state??receipt?.state??(receipt?.kind==="cancel_stopped"?"stopped":receipt?.kind==="cancel_received"?"received":state.decision?"decision_recorded":"prepared"),
  delegation_id:state.delegation_id??state.offer?.delegation_id??null,relation_id:state.relation_id??state.body?.relation?.relation_id??receipt?.relation_id??null,
  result_id:state.result_id??state.body?.result_id??null,target_task_uid:receipt?.target_task_uid??null,
  stopped:state.stopped===true||receipt?.kind==="cancel_stopped",blocker_count:state.blocker_count??state.blockers?.length??0,dispatch_started:false};
}
export function openFleetActions(db,{config,fetchImpl=fetch,now=Date.now}){
 const c=normalizeConfig(config),controller=new AbortController();let closed=false,running=null;
 function principal(){
  if(closed)fail("ACTIONS_CLOSED","操作服务已停止");
  const n=localIdentity(db);if(n.node_id!==c.node_id||n.sync_epoch!==c.node_epoch)fail("EPOCH_CHANGED","操作配置不匹配当前终端代次");
  const credential=loadPrincipalCredential(c.principal_file),auth="Bearer "+credential.token,p=authenticatePrincipal(db,auth);
  if(credential.node_id!==c.node_id||credential.node_epoch!==c.node_epoch||credential.principal_id!==p.principal_id||credential.credential_version!==p.version)fail("AUTHORIZATION_CHANGED","协调凭据声明与当前节点或授权版本不同",403);
  if(p.role.policy.kind!=="coordinate"||p.run_id)fail("FORBIDDEN","面板操作需要独立协调身份",403);
  return {p,auth,credential};
 }
 const initial=principal();
 migrateDelegation(db);migrateCancellations(db);migrateResults(db);
 atomic(db,()=>{
  db.exec("CREATE TABLE IF NOT EXISTS fleet_operator_actions(action_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,node_epoch TEXT NOT NULL,principal_id TEXT NOT NULL,credential_version INTEGER NOT NULL,role_version INTEGER NOT NULL,project_id TEXT NOT NULL,command TEXT NOT NULL,input_digest TEXT NOT NULL,transport_json TEXT,summary_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','applied','acknowledged','retry_pending','blocked')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,last_error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
  db.exec("CREATE TRIGGER IF NOT EXISTS fleet_operator_action_intent_immutable BEFORE UPDATE OF action_id,node_id,node_epoch,principal_id,credential_version,role_version,project_id,command,input_digest,transport_json,created_at ON fleet_operator_actions BEGIN SELECT RAISE(ABORT,'operator action intent is immutable'); END");
  db.exec("CREATE INDEX IF NOT EXISTS fleet_operator_action_queue ON fleet_operator_actions(principal_id,state,next_attempt_at,created_at,action_id)");
 });
 function authorized(row,context=principal()){
  if(row.node_id!==c.node_id||row.node_epoch!==c.node_epoch||row.principal_id!==context.p.principal_id||row.credential_version!==context.credential.credential_version||row.role_version!==context.p.role.version||!context.p.projects.includes(row.project_id))fail("AUTHORIZATION_CHANGED","此操作的协调身份、权限或终端代次已变化",403);
  return context;
 }
 function route(nodeId,epoch,project){
  const p=c.peers.find(p=>p.node_id===nodeId&&p.node_epoch===epoch&&p.projects.includes(project));
  if(!p)fail("PEER_NOT_CONFIGURED","未配置该项目的固定对端连接");return p;
 }
 function publicRow(r){return {action_id:r.action_id,project_id:r.project_id,command:r.command,state:r.state,attempts:r.attempts,next_attempt_at:r.next_attempt_at,last_error_code:r.last_error_code,created_at:r.created_at,updated_at:r.updated_at,result:JSON.parse(r.summary_json)};}
 function transport(kind,id,project,context){
  let v,nodeId,epoch;
  if(kind==="delegation"){v=callTool(db,context.auth,"get_delegation",{delegation_id:id,direction:"outgoing"});if(v.offer.project_id!==project)fail("NOT_FOUND","当前项目未找到委派",404);nodeId=v.offer.target_node_id;epoch=v.offer.target_epoch;}
  else if(kind==="cancellation"){v=callTool(db,context.auth,"get_cancellation",{relation_id:id});if(v.project_id!==project||v.side!=="source")fail("NOT_FOUND","当前项目未找到来源取消",404);nodeId=v.request.relation.target_node_id;epoch=v.request.relation.target_epoch;}
  else{v=callTool(db,context.auth,"get_result",{result_id:id});if(v.body.relation.project_id!==project||v.side!=="target")fail("NOT_FOUND","当前项目未找到待回传交付",404);nodeId=v.body.relation.source_node_id;epoch=v.body.relation.source_epoch;}
  route(nodeId,epoch,project);return {v,binding:{kind,id,node_id:nodeId,node_epoch:epoch}};
 }
 function enqueue(input){return unit(db,()=>{
  exact(input,["action_id","project_id","command","arguments"],"fleet_action");uuid(input.action_id,"action_id");names([input.project_id],"project_id",null,1);
  const context=principal(),{p,credential}=context;
  if(!p.projects.includes(input.project_id))fail("FORBIDDEN","协调身份未获准操作该项目",403);
  if(!LOCAL.has(input.command)&&!Object.hasOwn(NETWORK,input.command))fail("BAD_INPUT","面板操作不在允许列表",400);
  const requestHash=digest({project_id:input.project_id,command:input.command,arguments:input.arguments}),old=db.prepare("SELECT * FROM fleet_operator_actions WHERE action_id=?").get(input.action_id);
  if(old){authorized(old,context);if(old.input_digest!==requestHash)fail("REQUEST_CONFLICT","同一操作 ID 的内容不能改变");return publicRow(old);}
  // Repeated create from another tab keeps the same delegation, even with a new click ID.
  if(input.command==="create_delegation"){
   const prior=db.prepare("SELECT * FROM fleet_operator_actions WHERE principal_id=? AND node_id=? AND node_epoch=? AND command='create_delegation' AND input_digest=?").get(p.principal_id,c.node_id,c.node_epoch,requestHash);
   if(prior){authorized(prior,context);return publicRow(prior);}
  }
  if(db.prepare("SELECT count(*) n FROM fleet_operator_actions").get().n>=MAX_ACTIONS)fail("QUEUE_LIMIT","操作历史达到上限，需按保留规程处理");
  let v,binding=null,mode=null;
  if(LOCAL.has(input.command)){
   const def=TOOL_DEFINITIONS.find(t=>t.name===input.command),args={...input.arguments,request_id:input.action_id};
   if(input.arguments===null||typeof input.arguments!=="object"||Array.isArray(input.arguments)||Object.hasOwn(input.arguments,"request_id"))fail("BAD_INPUT","操作参数不得自行指定请求身份",400);
   validate(args,def.inputSchema);
   // Verify declared project before invoking any local mutation.
   let scoped;
   if(input.command==="create_delegation")scoped=callTool(db,context.auth,"get_task",{task_uid:args.task_uid}).task.project_id;
   else if(input.command==="decide_delegation")scoped=callTool(db,context.auth,"get_delegation",{delegation_id:args.delegation_id,direction:"incoming"}).offer.project_id;
   else if(input.command==="reject_result")scoped=callTool(db,context.auth,"get_result",{result_id:args.result_id}).body.relation.project_id;
   else if(input.command==="progress_cancellation")scoped=callTool(db,context.auth,"get_cancellation",{relation_id:args.relation_id}).project_id;
   else scoped=callTool(db,context.auth,"get_binding",{relation_id:args.relation_id}).relation.project_id;
   if(scoped!==input.project_id)fail("NOT_FOUND","当前项目未找到操作对象",404);
   if(input.command==="create_delegation")route(args.target_node_id,args.target_epoch,input.project_id);
   v=callTool(db,context.auth,input.command,args);
   if(input.command==="create_delegation"){({binding}=transport("delegation",input.action_id,input.project_id,context));mode="offer";}
   if(input.command==="request_cancellation"){({binding}=transport("cancellation",args.relation_id,input.project_id,context));mode="send";}
   if(input.command==="prepare_result"){({binding}=transport("result",input.action_id,input.project_id,context));mode="send";}
  }else{
   exact(input.arguments,["id"],"transport_action");uuid(input.arguments.id,"id");
   const [kind,m]=NETWORK[input.command];({v,binding}=transport(kind,input.arguments.id,input.project_id,context));mode=m;
  }
  const at=new Date(now()).toISOString();
  db.prepare("INSERT INTO fleet_operator_actions(action_id,node_id,node_epoch,principal_id,credential_version,role_version,project_id,command,input_digest,transport_json,summary_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.action_id,c.node_id,c.node_epoch,p.principal_id,credential.credential_version,p.role.version,input.project_id,input.command,requestHash,binding?canonical({...binding,mode}):null,canonical(summary(v)),binding?"pending":"applied",at,at);
  return publicRow(db.prepare("SELECT * FROM fleet_operator_actions WHERE action_id=?").get(input.action_id));
 });}
 async function deliver(row){
  let binding,context;
  try{context=authorized(row);binding=JSON.parse(row.transport_json);const peer=route(binding.node_id,binding.node_epoch,row.project_id);
   const guardedFetch=(...args)=>{authorized(row);return fetchImpl(...args);};
   const options={url:peer.url,credentialFile:peer.credential_file,fetchImpl:guardedFetch,signal:controller.signal,mode:binding.mode};
   const v=await (binding.kind==="delegation"?deliverIntent(db,{...options,delegationId:binding.id}):binding.kind==="cancellation"?deliverCancellation(db,{...options,relationId:binding.id}):deliverResult(db,{...options,resultId:binding.id}));
   const state=v.delivery_state==="acknowledged"?"acknowledged":v.delivery_state==="retry_pending"?"retry_pending":"blocked";
   const code=v.error_code??v.last_error_code??null;
   if(code!==null&&!/^[A-Z][A-Z0-9_]{0,63}$/.test(code))fail("BAD_RESPONSE","对端错误标识无效");
   atomic(db,()=>db.prepare("UPDATE fleet_operator_actions SET state=?,summary_json=?,last_error_code=?,next_attempt_at=?,updated_at=? WHERE action_id=?").run(state,canonical(summary(v)),state==="acknowledged"?null:code,now()+Math.min(30000,1000*2**Math.min(row.attempts,5)),new Date(now()).toISOString(),row.action_id));
  }catch(e){
   const code=errorCode(e);atomic(db,()=>db.prepare("UPDATE fleet_operator_actions SET state='blocked',last_error_code=?,updated_at=? WHERE action_id=?").run(code,new Date(now()).toISOString(),row.action_id));
  }
 }
 async function tickWork(){
  if(db.isTransaction)fail("TRANSACTION_ACTIVE","操作提交后才能发送");
  const context=principal(),rows=db.prepare("SELECT * FROM fleet_operator_actions WHERE principal_id=? AND node_id=? AND node_epoch=? AND state IN('pending','retry_pending') AND next_attempt_at<=? ORDER BY created_at,action_id LIMIT 16").all(context.p.principal_id,c.node_id,c.node_epoch,now());
  for(const row of rows){
   if(closed)break;
   const claimed=atomic(db,()=>db.prepare("UPDATE fleet_operator_actions SET attempts=attempts+1,next_attempt_at=?,updated_at=? WHERE action_id=? AND attempts=? AND state IN('pending','retry_pending') AND next_attempt_at<=? AND attempts<1000000").run(now()+30000,new Date(now()).toISOString(),row.action_id,row.attempts,now()).changes);
   if(claimed)await deliver({...row,attempts:row.attempts+1});
  }
  return {processed:rows.length};
 }
 function tick(){if(running)return running;running=tickWork().finally(()=>{running=null;});return running;}
 function catalog(projectId){
  const context=principal(),projects=context.p.projects;
  if(projectId!==null&&projectId!==undefined&&!projects.includes(projectId))fail("FORBIDDEN","协调身份未获准查看该项目",403);
  const selected=projectId?[projectId]:projects;
  const groups={actions:[],incoming:[],outgoing:[],bindings:[],cancellations:[],results:[]};let truncated=false;
  const collect=(name,rows)=>{const remaining=100-groups[name].length;if(rows.length>remaining)truncated=true;groups[name].push(...rows.slice(0,remaining));};
  for(const project of selected){
   for(const direction of ["incoming","outgoing"]){
    const items=listDelegations(db,{direction,projectId:project,limit:100}),remaining=100-groups[direction].length;
    if(items.length>remaining)truncated=true;
    collect(direction,items.slice(0,remaining).map(r=>{
     const v=direction==="incoming"?incomingStatus(db,r.delegation_id):outgoingStatus(db,r.delegation_id);
     return {project_id:project,direction,delegation_id:r.delegation_id,state:r.state,identity_current:v.identity_current,source_node_id:v.offer.source_node_id,target_node_id:v.offer.target_node_id,source_task_uid:v.offer.source_task_uid,target_task_uid:v.receipt?.target_task_uid??null,version:v.receipt?.version??null,subject:v.offer.task.subject,description:v.offer.task.description,acceptance:v.offer.task.acceptance};
    }));
   }
   collect("bindings",listBindings(db,{projectId:project,limit:100}).bindings.map(r=>{
    const t=db.prepare("SELECT aggregate_version,status,released,subject FROM tasks WHERE task_uid=?").get(r.task_uid);
    const b=r.identity_current?bindingState(db,r.relation_id):null;
    return {...r,project_id:project,task_version:t?.aggregate_version??null,task_status:t?.status??null,released:!!t?.released,subject:t?.subject??"",execution_authorized:b?.execution_authorized===true,cancellation_state:b?.cancellation?.state??null};
   }));
   collect("cancellations",listCancellations(db,{projectId:project,limit:100}).cancellations.map(r=>({...r,project_id:project})));
   collect("results",listResults(db,{projectId:project,limit:100}).results.map(r=>{
    const v=r.identity_current?resultState(db,r.result_id):null;
    const t=v?db.prepare("SELECT aggregate_version FROM tasks WHERE task_uid=?").get(v.body.relation.source_task_uid):null;
    return {...r,project_id:project,source_task_version:r.side==="source"?t?.aggregate_version??null:null,review_state:v?.review_state??"recovery_required"};
   }));
  }
  for(const [name,table]of Object.entries({incoming:"delegation_incoming",outgoing:"delegation_outgoing",bindings:"delegation_bindings",cancellations:"delegation_cancellations",results:"delegation_results"})){
   if(groups[name].length===100&&db.prepare("SELECT count(*) n FROM "+table+" WHERE project_id IN("+selected.map(()=>"?").join(",")+")").get(...selected).n>100)truncated=true;
  }
  // Global ordering and cap, rather than 100 per project.
  const rows=db.prepare("SELECT * FROM fleet_operator_actions WHERE principal_id=? AND node_id=? AND node_epoch=? AND project_id IN("+selected.map(()=>"?").join(",")+") ORDER BY created_at DESC,action_id LIMIT 101").all(context.p.principal_id,c.node_id,c.node_epoch,...selected);
  collect("actions",rows.map(publicRow));
  return {enabled:true,node_id:c.node_id,node_epoch:c.node_epoch,projects,peers:c.peers.filter(p=>p.projects.some(x=>selected.includes(x))).map(p=>({node_id:p.node_id,node_epoch:p.node_epoch,projects:p.projects.filter(x=>selected.includes(x))})),...groups,truncated,limit:100};
 }
 return {enqueue,tick,catalog,async close(){closed=true;controller.abort();await running?.catch(()=>{});},principal_id:initial.p.principal_id};
}
