// Read-only history projection. Stored receipts never grant current execution authority.
import {createHash} from "node:crypto";
import {PeerError} from "./federation/protocol.mjs";
import {digest} from "./federation/sync-store.mjs";
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const schema=(db,t,v)=>!exists(db,t)?"not_configured":db.prepare("SELECT version FROM "+t+" WHERE singleton=1").get()?.version===v?"available":"upgrade_required";
const pick=(o,keys)=>Object.fromEntries(keys.map(k=>{const v=o?.[k];return [k,typeof v==="string"?v.length<=512?v:null:typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v)?v:null];}));
function json(text,hash=null,raw=false){
 if(typeof text!=="string"||Buffer.byteLength(text)>4*1024*1024)return null;
 try{const v=JSON.parse(text);if(!v||typeof v!=="object"||Array.isArray(v))return null;
  if(hash&&(raw?createHash("sha256").update(text).digest("hex"):digest(v))!==hash)return null;return v;
 }catch{return null;}
}
const page=(items,limit=100)=>({items:items.slice(0,limit),total:items.length,truncated:items.length>limit});
const text=(v,max=160)=>typeof v==="string"&&v.length<=max?v:null;
const id=v=>typeof v==="string"&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)?v:null;
const hash=v=>typeof v==="string"&&/^[0-9a-f]{40,64}$/i.test(v)?v:null;
function endpoint(tasks,uid,project,inView){
 const t=tasks.get(uid);if(!t||t.project_id!==project)return null;
 return {...pick(t,["task_uid","owner_node_id","owner_name","subject","project_id","last_sync_at"]),read_only:!!t.read_only,in_view:inView.has(uid)};
}
export function fleetRelations(db,allTasks,local,{matching=null,included=null,limit=500}={}){
 let unverified=0;
 const tasks=new Map(allTasks.map(t=>[t.task_uid,t])),match=matching??new Set(tasks.keys()),visible=included??match,edges=new Map();
 const modules={delegation:schema(db,"federation_delegation_schema",1),binding:schema(db,"binding_schema",3),registration:schema(db,"relation_schema",2),cancellation:schema(db,"cancellation_schema",1)};
 const admitted=(p,a,b)=>[a,b].some(uid=>match.has(uid)&&tasks.get(uid)?.project_id===p);
 const endpoints=(p,a,b)=>({source:endpoint(tasks,a,p,visible),target:endpoint(tasks,b,p,visible)});
 function offer(r,side){
  const o=json(r.offer_json,r.offer_digest);if(!o||o.project_id!==r.project_id||o.delegation_id!==r.delegation_id){if(admitted(r.project_id,r.source_task_uid,r.target_task_uid))unverified++;return;}
  const receipt=side==="source"?json(r.receipt_json):null;
  const target=side==="target"?r.target_task_uid:receipt?.offer_digest===r.offer_digest&&receipt?.delegation_id===r.delegation_id?receipt.target_task_uid:null;
  if(!admitted(r.project_id,o.source_task_uid,target))return;
  edges.set("offer:"+r.delegation_id,{delegation_id:r.delegation_id,relation_id:null,project_id:r.project_id,...endpoints(r.project_id,o.source_task_uid,target),
   offer_state:r.state,binding_state:null,registration_state:null,cancellation_state:null,closed:false,
   identity_current:local.node_id===(side==="source"?o.source_node_id:o.target_node_id)&&local.sync_epoch===(side==="source"?o.source_epoch:o.target_epoch),
   recorded_at:r.updated_at,integrity:"digest_checked",current_authorization_checked:false});
 }
 if(modules.delegation==="available"){
  for(const r of db.prepare("SELECT * FROM delegation_outgoing ORDER BY delegation_id").iterate())offer(r,"source");
  for(const r of db.prepare("SELECT * FROM delegation_incoming ORDER BY delegation_id").iterate())offer(r,"target");
 }
 function relation(r,d,extra){
  if(!d||d.relation_id!==r.relation_id||!id(d.delegation_id)||!admitted(d.project_id,d.source_task_uid,d.target_task_uid))return;
  const prior=edges.get("offer:"+d.delegation_id),key="relation:"+r.relation_id;
  edges.delete("offer:"+d.delegation_id);
  edges.set(key,{...prior,...edges.get(key),delegation_id:d.delegation_id,relation_id:r.relation_id,project_id:d.project_id,
   ...endpoints(d.project_id,d.source_task_uid,d.target_task_uid),offer_state:prior?.offer_state??null,
   binding_state:null,registration_state:null,cancellation_state:null,closed:false,identity_current:null,recorded_at:r.created_at??null,
   integrity:"digest_checked",current_authorization_checked:false,...edges.get(key),...extra});
 }
 if(modules.binding==="available")for(const r of db.prepare("SELECT relation_id,delegation_id,project_id,task_uid,node_id,node_epoch,descriptor_json,descriptor_digest,state,closed,created_at FROM delegation_bindings ORDER BY created_at,relation_id").iterate()){
  const d=json(r.descriptor_json,r.descriptor_digest);if(d?.project_id!==r.project_id||d?.delegation_id!==r.delegation_id){if(admitted(r.project_id,r.task_uid,null))unverified++;continue;}
  relation(r,d,{binding_state:r.state,closed:!!r.closed,identity_current:r.node_id===local.node_id&&r.node_epoch===local.sync_epoch});
 }
 if(modules.registration==="available")for(const r of db.prepare("SELECT p.relation_id,p.descriptor_json,p.descriptor_digest,p.created_at,g.project_id,e.relation_id AS confirmed,w.relation_id AS withdrawn,c.relation_id AS completed FROM relation_proposals p JOIN relation_graphs g ON g.graph_id=p.graph_id LEFT JOIN relation_edges e ON e.relation_id=p.relation_id LEFT JOIN relation_withdrawals w ON w.relation_id=p.relation_id LEFT JOIN relation_completions c ON c.relation_id=p.relation_id ORDER BY p.created_at,p.relation_id").iterate()){
  const d=json(r.descriptor_json,r.descriptor_digest);if(d?.project_id!==r.project_id)continue;
  relation(r,d,{registration_state:r.completed?"completed":r.withdrawn?"withdrawn":r.confirmed?"confirmed":"proposed"});
 }
 if(modules.cancellation==="available")for(const r of db.prepare("SELECT relation_id,project_id,state,request_json,request_digest FROM delegation_cancellations").iterate()){
  const e=edges.get("relation:"+r.relation_id);if(!e||e.project_id!==r.project_id)continue;
  const v=json(r.request_json,r.request_digest);
  e.cancellation_state=v?.relation?.relation_id===r.relation_id?r.state:"unverified";
 }
 const items=[...edges.values()].sort((a,b)=>(b.recorded_at??"").localeCompare(a.recorded_at??"")||(a.relation_id??a.delegation_id).localeCompare(b.relation_id??b.delegation_id));
 return {format:"ai-fleet-relations/v1",modules,unverified_records:unverified,coverage:"locally_recorded_history",...page(items,limit)};
}
const evidenceSections=["children","relations","runs","results","artifacts","verifications","integrations","completions"];
const badPage=()=>{throw new PeerError("BAD_INPUT","历史翻页参数无效",400);};
function pageQuery(query){
 if(!query||typeof query!=="object"||Array.isArray(query)||Object.keys(query).some(k=>!["section","limit","cursor"].includes(k)))badPage();
 const {section,limit=100,cursor=null}=query;
 if(!evidenceSections.includes(section)||!Number.isInteger(limit)||limit<1||limit>100)badPage();
 let decoded=null;
 if(cursor!==null){
  if(typeof cursor!=="string"||cursor.length>1024||!cursor.length||!/^[A-Za-z0-9_-]+$/.test(cursor))badPage();
  try{const raw=Buffer.from(cursor,"base64url");if(raw.toString("base64url")!==cursor)badPage();decoded=JSON.parse(raw.toString("utf8"));}catch{badPage();}
  if(!decoded||Array.isArray(decoded)||Object.keys(decoded).sort().join(",")!=="limit,offset,section,snapshot_id,task_uid,v"||decoded.v!==1||decoded.section!==section||decoded.limit!==limit||!Number.isSafeInteger(decoded.offset)||decoded.offset<0||typeof decoded.task_uid!=="string"||typeof decoded.snapshot_id!=="string"||!/^[a-f0-9]{64}$/.test(decoded.snapshot_id))badPage();
 }
 return {section,limit,decoded};
}
export function fleetTaskEvidence(db,allTasks,local,uid,query=null){
 const q=query===null?null:pageQuery(query),catalog=uid===null,cap=catalog?10000:100,scopeCap=catalog?10000:1000;
 const tasks=new Map(allTasks.map(t=>[t.task_uid,t])),focus=tasks.get(uid),children=new Map();
 for(const t of allTasks)if(t.parent_uid&&tasks.get(t.parent_uid)?.project_id===t.project_id&&tasks.get(t.parent_uid)?.owner_node_id===t.owner_node_id){
  if(!children.has(t.parent_uid))children.set(t.parent_uid,[]);children.get(t.parent_uid).push(t.task_uid);
 }
 const scope=new Set(),queue=catalog?[...tasks.keys()]:[uid];for(let i=0;i<queue.length&&scope.size<scopeCap;i++){const u=queue[i];if(scope.has(u))continue;scope.add(u);if(!catalog)queue.push(...(children.get(u)??[]));}
 const relations=fleetRelations(db,allTasks,local,{matching:scope,limit:Number.MAX_SAFE_INTEGER}),relationById=new Map(relations.items.filter(r=>r.relation_id).map(r=>[r.relation_id,r])),relationIds=new Set(relationById.keys());
 const state={runs:exists(db,"task_runs")?"available":"not_configured",dispatch:schema(db,"broker_dispatch_schema",3),results:schema(db,"result_schema",1),artifacts:schema(db,"artifact_schema",1),verification:schema(db,"verification_schema",1),integration:schema(db,"integration_schema",1),completion:schema(db,"completion_schema",1)};
 const runs=[],results=[],artifacts=[],verifications=[],integrations=[],completions=[],unverified={results:0,artifacts:0};
 const dispatches=state.dispatch==="available"?new Map(db.prepare("SELECT run_id,dispatch_id,phase,execution_mode,created_at,launch_at,finished_at,result_digest FROM broker_dispatches").all().map(r=>[r.run_id,r])):new Map();
 if(state.runs==="available")for(const r of db.prepare("SELECT run_id,task_uid,executor_node_id,role_id,runtime,agent_instance_id,state,started_at,ended_at,terminal_task_status,policy_json,policy_sha256 FROM task_runs ORDER BY started_at DESC,run_id").iterate())if(scope.has(r.task_uid)){
  const policy=json(r.policy_json,r.policy_sha256,true),dispatch=dispatches.get(r.run_id);
  runs.push({...pick(r,["run_id","task_uid","executor_node_id","role_id","runtime","agent_instance_id","state","started_at","ended_at","terminal_task_status"]),model:text(policy?.context?.model),effort:text(policy?.context?.effort),policy_integrity:policy?"digest_checked":"unverified",dispatch:dispatch?pick(dispatch,["dispatch_id","phase","execution_mode","launch_at","finished_at","result_digest"]):null});
 }
 if(state.results==="available")for(const r of db.prepare("SELECT result_id,relation_id,project_id,task_uid,run_id,body_json,body_digest,created_at FROM delegation_results ORDER BY created_at DESC,result_id").iterate()){
  if(!relationIds.has(r.relation_id)||r.project_id!==relationById.get(r.relation_id)?.project_id)continue;
  const b=json(r.body_json,r.body_digest);
  if(!b||b.result_id!==r.result_id||b.relation?.relation_id!==r.relation_id||b.execution?.run_id!==r.run_id||b.relation?.project_id!==r.project_id){unverified.results++;continue;}
  const task=endpoint(tasks,r.task_uid,r.project_id,scope);
  results.push({result_id:r.result_id,relation_id:r.relation_id,task,created_at:r.created_at,run_id:task?r.run_id:null,
   process_status:text(b.process_result?.status),execution:task?pick(b.execution,["dispatch_id","runtime","role_id","model","effort","execution_mode","quiescence","real_model_call_confirmed"]):null,
   integrity:"digest_checked",accepted:false});
 }
 const resultIds=new Set(results.map(r=>r.result_id));
 if(state.artifacts==="available")for(const r of db.prepare("SELECT transfer_id,result_id,header_json,header_digest,payload_bytes,created_at FROM artifact_transfers ORDER BY created_at DESC,transfer_id").iterate()){
  if(!resultIds.has(r.result_id))continue;const h=json(r.header_json,r.header_digest);
  if(!h||h.result_id!==r.result_id||h.transfer_id!==r.transfer_id){unverified.artifacts++;continue;}
  const m=h.manifest,valid=m&&digest(m)===h.manifest_digest;
  artifacts.push({transfer_id:r.transfer_id,result_id:r.result_id,created_at:r.created_at,bytes:r.payload_bytes,manifest_integrity:valid?"digest_checked":"unverified",
   base_commit:valid?hash(m.base_commit):null,commit:valid?hash(m.commit):null,tree:valid?hash(m.tree):null,file_count:valid&&Array.isArray(m.files)?m.files.length:null,
   received_receipt_recorded:!!db.prepare("SELECT 1 FROM artifact_receipts WHERE transfer_id=? AND kind='artifact_received'").get(r.transfer_id),
   content_check_receipt_recorded:!!db.prepare("SELECT 1 FROM artifact_receipts WHERE transfer_id=? AND kind='artifact_content_verified'").get(r.transfer_id)});
 }
 const transferIds=new Set(artifacts.map(r=>r.transfer_id));
 if(state.verification==="available")for(const r of db.prepare("SELECT a.verification_id,a.transfer_id,a.binding_json,a.binding_digest,a.created_at,s.receipt_json,s.receipt_digest FROM verification_attempts a LEFT JOIN verification_receipts s USING(verification_id) ORDER BY a.created_at DESC,a.verification_id").iterate()){
  if(!transferIds.has(r.transfer_id))continue;const b=json(r.binding_json,r.binding_digest),v=json(r.receipt_json,r.receipt_digest);
  const valid=!!v&&v.verification_id===r.verification_id&&v.binding_digest===r.binding_digest&&!!b;
  verifications.push({verification_id:r.verification_id,transfer_id:r.transfer_id,created_at:r.created_at,receipt_state:r.receipt_json?valid?"digest_checked":"unverified":"not_recorded",checks_passed:valid&&typeof v.checks_passed==="boolean"?v.checks_passed:null,accepted:false});
 }
 if(state.integration==="available")for(const r of db.prepare("SELECT a.integration_id,a.result_id,a.verification_id,a.binding_json,a.binding_digest,a.created_at,s.receipt_json,s.receipt_digest FROM integration_attempts a LEFT JOIN integration_receipts s USING(integration_id) ORDER BY a.created_at DESC,a.integration_id").iterate()){
  if(!resultIds.has(r.result_id))continue;const b=json(r.binding_json,r.binding_digest),v=json(r.receipt_json,r.receipt_digest),valid=!!v&&v.integration_id===r.integration_id&&v.binding_digest===r.binding_digest&&!!b;
  integrations.push({integration_id:r.integration_id,result_id:r.result_id,verification_id:r.verification_id,created_at:r.created_at,receipt_state:r.receipt_json?valid?"digest_checked":"unverified":"not_recorded",source_applied:valid&&typeof v.source_applied==="boolean"?v.source_applied:null,merge_commit:valid?hash(v.merge_commit):null,accepted:false});
 }
 if(state.completion==="available")for(const r of db.prepare("SELECT a.completion_id,a.relation_id,a.result_id,a.side,a.plan_json,a.plan_digest,a.created_at,s.receipt_json,s.receipt_digest FROM completion_plans a LEFT JOIN completion_settlements s USING(completion_id) ORDER BY a.created_at DESC,a.completion_id").iterate()){
  if(!relationIds.has(r.relation_id)||!resultIds.has(r.result_id))continue;const p=json(r.plan_json,r.plan_digest),v=json(r.receipt_json,r.receipt_digest);
  const valid=!!p&&p.schema_version===1&&p.kind==="source_acceptance"&&p.completion_id===r.completion_id&&p.result_id===r.result_id&&p.relation?.relation_id===r.relation_id&&p.relation?.project_id===relationById.get(r.relation_id)?.project_id&&!!v&&v.schema_version===1&&v.kind==="completion_settled"&&v.completion_id===r.completion_id&&v.plan_digest===r.plan_digest&&v.side===r.side&&v.task_uid===p.relation[r.side+"_task_uid"]&&scope.has(v.task_uid)&&Number.isSafeInteger(v.task_version)&&v.task_version>0&&Number.isSafeInteger(v.fixture_runs)&&v.fixture_runs>=0&&v.fixture_runs===p.fixture_runs;
  completions.push({completion_id:r.completion_id,relation_id:r.relation_id,result_id:r.result_id,created_at:r.created_at,receipt_state:r.receipt_json?valid?"digest_checked":"unverified":"not_recorded",
   historical_accepted:valid&&v.accepted===true,task_uid:valid?v.task_uid:null,accepted_task_version:valid?v.task_version:null,settled_at:valid?v.settled_at:null,fixture_runs:valid?v.fixture_runs:null});
 }
 const metadata={generated_at:new Date().toISOString(),coverage:"locally_recorded_history",modules:state,unverified_records:unverified,scope_tasks:scope.size,scope_truncated:queue.some(u=>!scope.has(u)),current_authorization_checked:false};
 const family=(children.get(uid)??[]).map(u=>endpoint(tasks,u,focus.project_id,scope));
 const sections={children:family,relations:relations.items,runs,results,artifacts,verifications,integrations,completions};
 // All relation IDs participate in joins. Display limits must never filter downstream evidence.
 if(catalog)return {format:"ai-fleet-evidence-catalog/v1",...metadata,parent:null,...Object.fromEntries(Object.entries(sections).map(([key,items])=>[key,{...(key==="relations"?relations:{}),...page(items,cap)}]))};
 const snapshot_id=digest({task_uid:uid,node_id:local.node_id,sync_epoch:local.sync_epoch,
  scope:[...scope].sort().map(u=>[u,tasks.get(u)?.project_id??null,tasks.get(u)?.aggregate_version??null]),
  sections,modules:state,relation_modules:relations.modules,unverified,relation_unverified:relations.unverified_records,scope_truncated:metadata.scope_truncated});
 function select(section,limit=100,offset=0){
  const items=sections[section],encode=at=>Buffer.from(JSON.stringify({v:1,task_uid:uid,section,snapshot_id,offset:at,limit})).toString("base64url");
  const selected=items.slice(offset,offset+limit),more=offset+selected.length<items.length;
  return {...(section==="relations"?relations:{}),items:selected,total:items.length,truncated:more,offset,limit,snapshot_id,cursor:encode(offset),next_cursor:more?encode(offset+selected.length):null};
 }
 if(q){
  const c=q.decoded;if(c&&c.task_uid!==uid)badPage();
  if(c&&c.snapshot_id!==snapshot_id)throw new PeerError("EVIDENCE_CHANGED","记录或可见范围已变化，请返回最新记录重新读取",409);
  if(c&&c.offset>=Math.max(1,sections[q.section].length))badPage();
  return {format:"ai-fleet-evidence-page/v1",task_uid:uid,section:q.section,...metadata,page:select(q.section,q.limit,c?.offset??0)};
 }
 return {format:"ai-fleet-task-evidence/v1",task_uid:uid,...metadata,
  parent:focus?.parent_uid?endpoint(tasks,focus.parent_uid,focus.project_id,scope):null,...Object.fromEntries(evidenceSections.map(key=>[key,select(key)]))};
}
