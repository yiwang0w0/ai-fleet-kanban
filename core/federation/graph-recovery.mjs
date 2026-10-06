import {recoveredPendingRelations} from './pending-relation-recovery.mjs';
import {recoveredGraphCancellations} from './contract-recovery.mjs';
// Local administration only. A digest protects transport integrity, not the truth of operator attestations.
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PeerError,uuid,names} from './protocol.mjs';
import {localIdentity} from './peers.mjs';
import {canonical,digest,atomic} from './sync-store.mjs';
import {migrateRelations} from './relations.mjs';
import {currentRelationGraphs,relationGraphsTable} from './graph-generations.mjs';
import {migrateTopology,pendingTopologyRecoveryChoice,applyPendingTopologyRecovery} from './topology.mjs';
import {inspectStoppedRuns} from '../execution/stop-proof.mjs';
import {topologyBindingsTable,unresolvedTopologyAttemptSQL} from './topology-generations.mjs';
const store=createRequire(import.meta.url)('../store.js');
const GP='ai-fleet-graph-recovery-plan/v1',GR='ai-fleet-graph-recovery-receipt/v1',TP='ai-fleet-topology-recovery-plan/v1',TR='ai-fleet-topology-recovery-receipt/v1';
const at=()=>new Date().toISOString(),has=(db,t)=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(t);
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const project=x=>names([x],'project_id',null,1)[0];
function readonly(db,fn){const own=!db.isTransaction;if(own)db.exec('BEGIN');try{const r=fn();if(own)db.exec('COMMIT');return r;}catch(e){if(own)db.exec('ROLLBACK');throw e;}}
function independent(db,fn){if(db.isTransaction)fail('TRANSACTION_ACTIVE','恢复决定必须使用独立事务');return atomic(db,fn);}
function membersOf(value){if(!Array.isArray(value)||!value.length||value.length>32)fail('BAD_INPUT','需要 1–32 个完整成员身份');const ids=new Set();return value.map(m=>{if(!m||Object.keys(m).sort().join(',')!=='node_epoch,node_id')fail('BAD_INPUT','成员字段无效');uuid(m.node_id,'node_id');uuid(m.node_epoch,'node_epoch');if(ids.has(m.node_id))fail('BAD_INPUT','成员重复');ids.add(m.node_id);return {node_id:m.node_id,node_epoch:m.node_epoch};}).sort((a,b)=>a.node_id.localeCompare(b.node_id));}
function checkedPlan(p,expected,format){if(!p||typeof p!=='object')fail('PLAN_MISMATCH','需要已核对的计划');const {plan_digest,...body}=p;if(p.format!==format||!/^([a-f0-9]{64})$/.test(expected??'')||plan_digest!==expected||digest(body)!==expected||!Number.isFinite(Date.parse(p.prepared_at)))fail('PLAN_MISMATCH','计划摘要或格式不匹配');}
function assertSnapshot(p,s){if(Object.entries(s).some(([k,v])=>canonical(v)!==canonical(p[k])))fail('PLAN_STALE','身份、任务或登记状态已变化，请重新准备计划');}
function evidence(x){return x&&typeof x.evidence_ref==='string'&&x.evidence_ref.trim().length>=8&&x.evidence_ref.length<=2048&&!/[\x00-\x1f\x7f]/.test(x.evidence_ref)&&typeof x.attested_at==='string'&&Number.isFinite(Date.parse(x.attested_at));}
function graphSnapshot(db,projectId,inputMembers){
 project(projectId);const n=localIdentity(db),g=currentRelationGraphs(db).find(x=>x.project_id===projectId);if(!g)fail('NOT_FOUND','项目尚未登记');if(g.registrar_node_id!==n.node_id)fail('IDENTITY_MISMATCH','仅原登记节点可建立后继图');
 const oldMembers=db.prepare('SELECT node_id,node_epoch FROM relation_members WHERE graph_id=? ORDER BY node_id').all(g.graph_id),members=membersOf(inputMembers);
 if(canonical(oldMembers.map(m=>m.node_id).sort())!==canonical(members.map(m=>m.node_id).sort()))fail('MEMBER_SET_MISMATCH','恢复不能同时增删成员');
 if(members.some(m=>m.node_id===n.node_id&&m.node_epoch!==n.sync_epoch))fail('IDENTITY_MISMATCH','登记本机必须使用当前代次');
 if(g.registrar_epoch===n.sync_epoch&&canonical(membersOf(oldMembers))===canonical(members))fail('RECOVERY_NOT_NEEDED','没有登记节点或成员换代');
 const state={graph:g,members:oldMembers};
 for(const t of ['relation_topologies','relation_proposals','relation_edges','relation_withdrawals','relation_requests','relation_events','relation_completions','relation_cancellations'])state[t]=has(db,t)?db.prepare('SELECT * FROM '+t+' WHERE graph_id=? ORDER BY rowid').all(g.graph_id):[];
 for(const t of ['relation_approvals','relation_completion_proposals','relation_completion_votes','relation_cancellation_proposals','relation_cancellation_votes'])state[t]=has(db,t)?db.prepare('SELECT * FROM '+t+' WHERE relation_id IN(SELECT relation_id FROM relation_proposals WHERE graph_id=?) ORDER BY rowid').all(g.graph_id):[];
 state.contract_recovery_retirements=recoveredGraphCancellations(db,g.graph_id);
 state.pending_relation_recoveries=recoveredPendingRelations(db,g.graph_id);
 const edges=new Set(state.relation_edges.map(e=>e.relation_id)),withdrawn=new Set([...state.relation_withdrawals,...state.pending_relation_recoveries].map(e=>e.relation_id)),closed=new Set([...state.relation_completions,...state.relation_cancellations,...state.contract_recovery_retirements].map(e=>e.relation_id)),pending=state.relation_proposals.filter(p=>!edges.has(p.relation_id)&&!withdrawn.has(p.relation_id)),active=state.relation_edges.filter(e=>!closed.has(e.relation_id)),blockers=[];
 if(pending.length)blockers.push({kind:'pending_relations',relation_ids:pending.map(p=>p.relation_id)});if(active.length)blockers.push({kind:'active_relations',relation_ids:active.map(e=>e.relation_id)});
 return {node_id:n.node_id,node_epoch:n.sync_epoch,project_id:projectId,old_graph_id:g.graph_id,old_graph_epoch:g.graph_epoch,old_registrar_epoch:g.registrar_epoch,old_members:membersOf(oldMembers),members,generation:(g.generation??0)+1,state_digest:digest(state),blockers,automatic_release:false};
}
export function prepareGraphRecovery(db,{projectId,members}){return readonly(db,()=>{const body={format:GP,...graphSnapshot(db,projectId,members),new_graph_id:randomUUID(),new_graph_epoch:randomUUID(),prepared_at:at()};return {...body,plan_digest:digest(body)};});}
function checkedAttestation(p,a){
 if(!a||a.format!=='ai-fleet-graph-recovery-attestation/v1'||a.node_id!==p.node_id||a.node_epoch!==p.node_epoch||a.plan_digest!==p.plan_digest||a.unrecorded_confirmations_reconciled!==true||!evidence(a))fail('ATTESTATION_MISMATCH','需声明已核对备份后可能遗漏的确认，并提供证据');
 if(!Array.isArray(a.member_confirmations)||a.member_confirmations.length!==p.members.length)fail('MEMBER_CONFIRMATION_REQUIRED','需要所有参与终端的停工及未决请求核对声明');
 const seen=new Set();for(const c of a.member_confirmations){const m=p.members.find(m=>m.node_id===c.node_id);if(!m||seen.has(c.node_id)||m.node_epoch!==c.node_epoch||c.old_graph_id!==p.old_graph_id||c.old_graph_epoch!==p.old_graph_epoch||c.old_work_stopped!==true||c.pending_requests_reconciled!==true||!evidence(c))fail('MEMBER_CONFIRMATION_REQUIRED','成员声明不完整或代次不匹配');seen.add(c.node_id);}
}
export function recordGraphRecovery(db,{plan:p,expectedPlanDigest,attestation:a}){
 checkedPlan(p,expectedPlanDigest,GP);uuid(p.new_graph_id,'new_graph_id');uuid(p.new_graph_epoch,'new_graph_epoch');checkedAttestation(p,a);
 return independent(db,()=>{const n=localIdentity(db);if(n.node_id!==p.node_id||n.sync_epoch!==p.node_epoch)fail('IDENTITY_MISMATCH','登记身份已变化');
  const old=has(db,'relation_graph_transitions')&&db.prepare('SELECT * FROM relation_graph_transitions WHERE old_graph_id=?').get(p.old_graph_id);if(old){if(old.plan_digest!==p.plan_digest||old.attestation_digest!==digest(a))fail('REQUEST_CONFLICT','此图已有不同恢复决定');const prior=JSON.parse(old.receipt_json);if(digest(prior)!==old.receipt_digest)fail('RECEIPT_MISMATCH','持久回执摘要不匹配');return prior;}
  const s=graphSnapshot(db,p.project_id,p.members);assertSnapshot(p,s);if(s.blockers.length)fail('GRAPH_RECOVERY_BLOCKED','仍有活动关系或未决确认，不能建立空白后继图');
  migrateRelations(db);if(db.prepare('SELECT 1 FROM '+relationGraphsTable(db)+' WHERE graph_id=?').get(p.new_graph_id))fail('CONFLICT','后继图 ID 已被使用');
  const g={project_id:p.project_id,graph_id:p.new_graph_id,graph_epoch:p.new_graph_epoch,registrar_node_id:n.node_id,registrar_epoch:n.sync_epoch,version:1,created_at:at(),generation:p.generation};
  db.prepare('INSERT INTO relation_graph_generations VALUES(?,?,?,?,?,?,?,?)').run(g.project_id,g.graph_id,g.graph_epoch,g.registrar_node_id,g.registrar_epoch,g.version,g.created_at,g.generation);
  for(const m of s.members)db.prepare('INSERT INTO relation_members VALUES(?,?,?)').run(g.graph_id,m.node_id,m.node_epoch);
  const body={format:GR,old_graph_id:p.old_graph_id,old_graph_epoch:p.old_graph_epoch,old_registrar_epoch:p.old_registrar_epoch,graph:g,members:s.members,plan_digest:p.plan_digest,attestation_digest:digest(a),authority:'operator_attested_not_machine_verified',automatic_release:false,recorded_at:at()},receipt={...body,receipt_digest:digest(body)};
  db.prepare('INSERT INTO relation_graph_transitions VALUES(?,?,?,?,?,?,?,?,?)').run(p.old_graph_id,g.graph_id,p.plan_digest,canonical(p),digest(a),canonical(a),digest(receipt),canonical(receipt),receipt.recorded_at);return receipt;
 });
}
function graphReceipt(r){
 if(!r||typeof r!=='object')fail('RECEIPT_MISMATCH','需要登记节点恢复回执');const {receipt_digest,...body}=r;
 if(r.format!==GR||digest(body)!==receipt_digest||r.authority!=='operator_attested_not_machine_verified'||r.automatic_release!==false||!r.graph)fail('RECEIPT_MISMATCH','登记恢复回执摘要或格式无效');
 for(const k of ['old_graph_id','old_graph_epoch','old_registrar_epoch'])uuid(r[k],k);for(const k of ['graph_id','graph_epoch','registrar_node_id','registrar_epoch'])uuid(r.graph[k],k);project(r.graph.project_id);membersOf(r.members);
 if(r.old_graph_id===r.graph.graph_id||r.old_graph_epoch===r.graph.graph_epoch||r.graph.version!==1||!Number.isSafeInteger(r.graph.generation)||r.graph.generation<1)fail('RECEIPT_MISMATCH','后继图身份无效');return r;
}
function topologySnapshot(db,projectId,receipt,pendingChoice=null){
 project(projectId);const r=graphReceipt(receipt),n=localIdentity(db),b=db.prepare('SELECT * FROM '+topologyBindingsTable(db)+' WHERE project_id=?').get(projectId);if(!b)fail('NOT_FOUND','项目未绑定');
 if(b.owner_node_id!==n.node_id||b.project_id!==r.graph.project_id||b.graph_id!==r.old_graph_id||b.graph_epoch!==r.old_graph_epoch||b.registrar_node_id!==r.graph.registrar_node_id||b.registrar_epoch!==r.old_registrar_epoch||!r.members.some(m=>m.node_id===n.node_id&&m.node_epoch===n.sync_epoch))fail('IDENTITY_MISMATCH','旧绑定、新图或本机成员代次不匹配');
 if(b.registrar_node_id===n.node_id&&r.graph.registrar_epoch!==n.sync_epoch)fail('IDENTITY_MISMATCH','本机登记节点代次不匹配');
 const tasks=db.prepare('SELECT t.* FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id WHERE p.project_id=? ORDER BY t.id').all(projectId),runs=db.prepare('SELECT r.* FROM task_runs r JOIN broker_task_projects p ON p.task_id=r.task_id WHERE p.project_id=? ORDER BY r.run_id').all(projectId),operations=db.prepare('SELECT * FROM topology_operations WHERE project_id=? ORDER BY rowid').all(projectId),attempts=db.prepare('SELECT a.* FROM topology_attempts a JOIN topology_operations o USING(operation_id) WHERE o.project_id=? ORDER BY a.rowid').all(projectId),bindings=has(db,'delegation_bindings')?db.prepare('SELECT * FROM delegation_bindings WHERE project_id=? ORDER BY rowid').all(projectId):[],blockers=[];
 const resolution=pendingChoice===null?null:pendingTopologyRecoveryChoice(db,{projectId,choice:pendingChoice});
 const pending=operations.filter(o=>o.state==='prepared'&&o.operation_id!==resolution?.operation_id);
 const unresolved=db.prepare('SELECT a.operation_id FROM topology_attempts a JOIN topology_operations o USING(operation_id) WHERE o.project_id=? AND '+unresolvedTopologyAttemptSQL(db)).all(projectId).filter(a=>a.operation_id!==resolution?.operation_id);
 if(pending.length||unresolved.length)blockers.push({kind:'pending_topology',operation_ids:[...new Set([...pending,...unresolved].map(o=>o.operation_id))]});
 if(tasks.some(t=>t.status==='in_progress')||runs.some(r=>r.state==='running'))blockers.push({kind:'active_work'});
 const runChecks=runs.map(run=>{const dispatch=has(db,'broker_dispatches')?db.prepare('SELECT node_epoch FROM broker_dispatches WHERE run_id=?').get(run.run_id):null;return inspectStoppedRuns(db,{nodeId:n.node_id,nodeEpoch:dispatch?.node_epoch??n.sync_epoch,members:[],runs:[run],allowOperatorAttested:true});});
 for(const check of runChecks)blockers.push(...check.blockers);
 const open=bindings.filter(b=>b.state!=='cancelled'&&!b.closed);if(open.length)blockers.push({kind:'open_bindings',relation_ids:open.map(b=>b.relation_id)});
 return {node_id:n.node_id,node_epoch:n.sync_epoch,project_id:projectId,old_graph_id:b.graph_id,old_graph_epoch:b.graph_epoch,generation:(b.generation??0)+1,graph_receipt:r,state_digest:digest({binding:b,tasks,runs,operations,attempts,bindings,runChecks}),...(resolution?{pending_resolution:resolution}:{}),blockers,automatic_release:false};
}
export function prepareTopologyRecovery(db,{projectId,graphReceipt:r,pendingChoice=null}){return readonly(db,()=>{const body={format:TP,...topologySnapshot(db,projectId,r,pendingChoice),prepared_at:at()};return {...body,plan_digest:digest(body)};});}
export function recordTopologyRecovery(db,{plan:p,expectedPlanDigest,attestation=null}){
 checkedPlan(p,expectedPlanDigest,TP);
 if(p.pending_resolution){const a=attestation;if(!a||a.format!=='ai-fleet-pending-topology-recovery-attestation/v1'||a.node_id!==p.node_id||a.node_epoch!==p.node_epoch||a.plan_digest!==p.plan_digest||a.operation_id!==p.pending_resolution.operation_id||a.choice!==p.pending_resolution.choice||a.old_graph_retired!==true||a.remote_outcome_unknown!==true||a.selected_structure_reviewed!==true||!evidence(a))fail('ATTESTATION_MISMATCH','须核对旧图已退役、旧请求结果未知及明确选择的结构');}
 else if(attestation!==null)fail('BAD_INPUT','无未决拓扑时不接受额外恢复声明');
 return independent(db,()=>{const n=localIdentity(db);if(n.node_id!==p.node_id||n.sync_epoch!==p.node_epoch)fail('IDENTITY_MISMATCH','端点身份已变化');
  const old=has(db,'topology_recoveries')&&db.prepare('SELECT * FROM topology_recoveries WHERE project_id=? AND generation=?').get(p.project_id,p.generation);if(old){if(old.plan_digest!==p.plan_digest)fail('REQUEST_CONFLICT','本代次已有不同恢复决定');const prior=JSON.parse(old.receipt_json);if(p.pending_resolution&&prior.pending_attestation_digest!==digest(attestation))fail('REQUEST_CONFLICT','本代次已有不同未决拓扑声明');if(digest(prior)!==old.receipt_digest)fail('RECEIPT_MISMATCH','持久回执摘要不匹配');return prior;}
  const s=topologySnapshot(db,p.project_id,p.graph_receipt,p.pending_resolution?.choice??null);assertSnapshot(p,s);if(s.blockers.length)fail('TOPOLOGY_RECOVERY_BLOCKED','先结算本机工作、端点绑定和未决拓扑请求');migrateTopology(db);const g=s.graph_receipt.graph;
  db.prepare("INSERT INTO topology_binding_generations VALUES(?,?,?,?,?,?,?,0,'unregistered',NULL,NULL,?,?)").run(p.project_id,g.graph_id,g.graph_epoch,g.registrar_node_id,g.registrar_epoch,n.node_id,n.sync_epoch,at(),p.generation);
  const tasks=db.prepare("SELECT t.id FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id WHERE p.project_id=? AND t.archived_at IS NULL AND t.status<>'done' ORDER BY t.id").all(p.project_id);
  for(const t of tasks){store.update(db,{id:t.id,expectedVersion:store.get(db,t.id).aggregate_version,humanGate:true,actor:'human'});store.setReleased(db,{id:t.id,expectedVersion:store.get(db,t.id).aggregate_version,released:false,actor:'human'});}
  if(s.pending_resolution)applyPendingTopologyRecovery(db,{projectId:p.project_id,resolution:s.pending_resolution,planDigest:p.plan_digest});
  const receipt={format:TR,node_id:n.node_id,node_epoch:n.sync_epoch,project_id:p.project_id,generation:p.generation,old_graph_id:p.old_graph_id,new_graph_id:g.graph_id,plan_digest:p.plan_digest,graph_receipt_digest:s.graph_receipt.receipt_digest,authority:'operator_supplied_graph_receipt',phase:'unregistered',automatic_release:false,held_task_ids:tasks.map(t=>t.id),...(s.pending_resolution?{pending_resolution:s.pending_resolution,pending_attestation:attestation,pending_attestation_digest:digest(attestation)}:{}),recorded_at:at()};
  db.prepare('INSERT INTO topology_recoveries VALUES(?,?,?,?,?,?,?)').run(p.project_id,p.generation,p.plan_digest,canonical(p),digest(receipt),canonical(receipt),receipt.recorded_at);return receipt;
 });
}
