// Explicit local administration. Imported receipts are operator-reviewed documents, not signatures.
import {createRequire} from 'node:module';
import {PeerError,uuid} from './protocol.mjs';
import {localIdentity} from './peers.mjs';
import {atomic,canonical,digest} from './sync-store.mjs';
import {normalizeCancellationClosure} from './cancellation-contract.mjs';
import {relationGraphsTable,assertGraphCurrent} from './graph-generations.mjs';
import {inspectStoppedRuns} from '../execution/stop-proof.mjs';
const store=createRequire(import.meta.url)('../store.js');
const EP='ai-fleet-contract-endpoint-plan/v1',ER='ai-fleet-contract-endpoint-receipt/v1',RP='ai-fleet-contract-registrar-plan/v1',RR='ai-fleet-recovered-cancellation-receipt/v1',SP='ai-fleet-contract-settlement-plan/v1',SR='ai-fleet-contract-settlement-receipt/v1';
const at=()=>new Date().toISOString(),has=(db,t)=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(t),fail=(code,message)=>{throw new PeerError(code,message,409);};
function readonly(db,fn){const own=!db.isTransaction;if(own)db.exec('BEGIN');try{const r=fn();if(own)db.exec('COMMIT');return r;}catch(e){if(own)db.exec('ROLLBACK');throw e;}}
function independent(db,fn){if(db.isTransaction)fail('TRANSACTION_ACTIVE','恢复决定必须使用独立事务');return atomic(db,fn);}
function schema(db){if(!has(db,'contract_recovery_schema'))return false;if(db.prepare('SELECT version FROM contract_recovery_schema WHERE singleton=1').get()?.version!==1)fail('SCHEMA_INCOMPATIBLE','合同恢复存储不兼容');return true;}
export function migrateContractRecovery(db){if(!db.isTransaction)return atomic(db,()=>migrateContractRecovery(db));if(schema(db))return;db.exec('CREATE TABLE contract_recovery_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT INTO contract_recovery_schema VALUES(1,1)');
 for(const [table,key] of [['contract_recovery_votes','relation_id TEXT NOT NULL,registrar_epoch TEXT NOT NULL,'],['contract_recovery_retirements','relation_id TEXT NOT NULL,graph_id TEXT NOT NULL,'],['contract_recovery_settlements','relation_id TEXT NOT NULL,']]){
  db.exec('CREATE TABLE '+table+'('+key+'plan_digest TEXT NOT NULL,plan_json TEXT NOT NULL,attestation_digest TEXT NOT NULL,attestation_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(relation_id'+(table==='contract_recovery_votes'?',registrar_epoch':'')+'))');
  db.exec('CREATE TRIGGER '+table+"_immutable BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'contract recovery is immutable'); END; CREATE TRIGGER "+table+"_retained BEFORE DELETE ON "+table+" BEGIN SELECT RAISE(ABORT,'contract recovery history is retained'); END");
 }
}
function document(row){if(!row)return null;let r;try{r=JSON.parse(row.receipt_json);}catch{fail('RECEIPT_MISMATCH','恢复回执格式损坏');}if(digest(r)!==row.receipt_digest)fail('RECEIPT_MISMATCH','恢复回执摘要不匹配');return r;}
function stored(db,table,id,epoch){if(!schema(db))return null;return document(db.prepare('SELECT * FROM '+table+' WHERE relation_id=?'+(epoch?' AND registrar_epoch=?':'')).get(...(epoch?[id,epoch]:[id])));}
function checkedDocument(r,format){if(!r||typeof r!=='object')fail('RECEIPT_MISMATCH','需要恢复回执');const {receipt_digest,...body}=r;if(r.format!==format||digest(body)!==receipt_digest||r.automatic_release!==false||r.accepted!==false)fail('RECEIPT_MISMATCH','恢复回执格式或摘要不同');return r;}
function plan(format,body){const p={format,...body,prepared_at:at()};return {...p,plan_digest:digest(p)};}
function checkedPlan(p,expected,format){if(!p||typeof p!=='object')fail('PLAN_MISMATCH','需要明确核对的恢复计划');const {plan_digest,...body}=p;if(p.format!==format||!/^([a-f0-9]{64})$/.test(expected??'')||plan_digest!==expected||digest(body)!==expected||!Number.isFinite(Date.parse(p.prepared_at)))fail('PLAN_MISMATCH','计划摘要或格式不匹配');}
function same(p,s){if(Object.entries(s).some(([k,v])=>canonical(v)!==canonical(p[k])))fail('PLAN_STALE','身份、合同或停止证明已变化');}
function checkedAttestation(p,a){if(!a||a.format!=='ai-fleet-contract-recovery-attestation/v1'||a.node_id!==p.node_id||a.node_epoch!==p.node_epoch||a.plan_digest!==p.plan_digest||a.old_registrar_disabled!==true||a.endpoint_records_reviewed!==true||a.no_automatic_release!==true||typeof a.evidence_ref!=='string'||a.evidence_ref.trim().length<8||a.evidence_ref.length>2048||/[\x00-\x1f\x7f]/.test(a.evidence_ref)||typeof a.attested_at!=='string'||!Number.isFinite(Date.parse(a.attested_at)))fail('ATTESTATION_MISMATCH','需要已停用旧登记节点、核对双方记录且不自动放行的实际声明');}
function identity(db,p){const n=localIdentity(db);if(n.node_id!==p.node_id||n.sync_epoch!==p.node_epoch)fail('IDENTITY_MISMATCH','本机身份或代次已变化');return n;}
function repeat(db,table,p,a,epoch){const old=stored(db,table,p.relation_id,epoch);if(old){if(old.plan_digest!==p.plan_digest||old.attestation_digest!==digest(a))fail('REQUEST_CONFLICT','此合同已有不同恢复决定');return old;}return null;}
function receipt(format,body){const r={format,...body,automatic_release:false,accepted:false,recorded_at:at()};return {...r,receipt_digest:digest(r)};}
function insert(db,table,leading,p,a,r){const values=[...leading,p.plan_digest,canonical(p),digest(a),canonical(a),digest(r),canonical(r),r.recorded_at];db.prepare('INSERT INTO '+table+' VALUES('+values.map(()=>'?').join(',')+')').run(...values);}
function endpointSnapshot(db,relationId,registrarEpoch){
 uuid(relationId,'relation_id');uuid(registrarEpoch,'registrar_epoch');const n=localIdentity(db),b=db.prepare('SELECT * FROM delegation_bindings WHERE relation_id=?').get(relationId);
 if(!b||b.node_id!==n.node_id)fail('NOT_FOUND','本机未找到该端点绑定');if(b.state!=='confirmed'||b.closed)fail('RECOVERY_NOT_AVAILABLE','只协调仍活动的已确认合同');
 if(b.registrar_epoch===registrarEpoch||b.registrar_node_id===n.node_id&&registrarEpoch!==n.sync_epoch)fail('REGISTRAR_EPOCH_MISMATCH','需核对同一登记节点实际换代');
 const c=has(db,'delegation_cancellations')&&db.prepare('SELECT * FROM delegation_cancellations WHERE relation_id=?').get(relationId);if(!c||c.state!=='stopped'||c.side!==b.side||c.node_id!==b.node_id||c.node_epoch!==b.node_epoch)fail('STOP_UNCONFIRMED','双方先保存同一取消及执行端停止回执');
 const cancellation=normalizeCancellationClosure({schema_version:1,kind:'delegation_cancellation',request:JSON.parse(c.request_json),stopped:JSON.parse(c.stopped_json)}),d=cancellation.request.relation;
 if(canonical(d)!==b.descriptor_json||digest(d)!==b.descriptor_digest)fail('CONTRACT_MISMATCH','取消与本机绑定合同不同');
 const t=db.prepare('SELECT * FROM tasks WHERE id=? AND task_uid=?').get(b.task_id,b.task_uid);if(!t||t.owner_node_id!==n.node_id||t.status==='done'||t.archived_at)fail('CONFLICT','本机任务身份或终态改变');
 if(has(db,'completion_plans')&&db.prepare('SELECT 1 FROM completion_plans WHERE relation_id=?').get(relationId))fail('COMPLETION_COMMITTED','完成意图必须按完成恢复规程处理');
 if(has(db,'delegation_results')&&db.prepare('SELECT 1 FROM delegation_results r WHERE relation_id=? AND NOT EXISTS(SELECT 1 FROM result_decisions d WHERE d.result_id=r.result_id)').get(relationId))fail('RESULT_PENDING','先由任务所有者裁定已封存结果，不能用恢复丢弃结果');
 const members=b.side==='target'?db.prepare('SELECT task_id,task_uid FROM cancellation_members WHERE cancel_id=? ORDER BY task_uid').all(c.cancel_id):[{task_id:b.task_id,task_uid:b.task_uid}],runs=[];
 for(const m of members)runs.push(...db.prepare('SELECT * FROM task_runs WHERE task_id=? AND task_uid=? ORDER BY run_id').all(m.task_id,m.task_uid));
 runs.sort((a,b)=>a.run_id.localeCompare(b.run_id));
 if(members.length>10000||runs.length>100000)fail('SCOPE_LIMIT','合同恢复范围超过上限');
 const stop=inspectStoppedRuns(db,{nodeId:b.node_id,nodeEpoch:b.node_epoch,members,runs,allowOperatorAttested:true});if(t.status==='in_progress'||stop.blockers.length)fail('STOP_UNCONFIRMED','本机仍有活动或未经证明停止的运行');
 const proof=b.side==='target'?db.prepare('SELECT * FROM cancellation_proofs WHERE cancel_id=?').get(c.cancel_id):null;
 if(b.side==='target'&&(!proof||digest(JSON.parse(proof.proof_json))!==proof.proof_digest||proof.proof_digest!==cancellation.stopped.proof_digest))fail('STOP_UNCONFIRMED','本机停止证明原文不匹配');
 if(proof){const body=JSON.parse(proof.proof_json);if(canonical(body.member_uids)!==canonical(members.map(m=>m.task_uid))||canonical(body.runs)!==canonical(stop.proofs))fail('STOP_UNCONFIRMED','停止证明未覆盖当前完整任务和运行集合');}
 const downstream=b.side==='target'?db.prepare("SELECT relation_id FROM delegation_bindings WHERE side='source' AND state IN('prepared','confirmed') AND closed=0 AND task_id IN(SELECT task_id FROM cancellation_members WHERE cancel_id=?) ORDER BY relation_id").all(c.cancel_id):[];
 if(downstream.length)fail('DOWNSTREAM_PENDING','先协调停止范围内的下游合同');
 const attempts=db.prepare('SELECT * FROM binding_attempts WHERE relation_id=? ORDER BY rowid').all(relationId),retireAttempts=has(db,'cancellation_registrar_attempts')?db.prepare('SELECT * FROM cancellation_registrar_attempts WHERE relation_id=? ORDER BY rowid').all(relationId):[];
 return {node_id:n.node_id,node_epoch:n.sync_epoch,binding_epoch:b.node_epoch,side:b.side,relation_id:relationId,project_id:b.project_id,registrar_node_id:b.registrar_node_id,retired_registrar_epoch:b.registrar_epoch,observed_registrar_epoch:registrarEpoch,cancellation,confirmation_digest:digest(JSON.parse(b.confirmation_json)),state_digest:digest({binding:b,task:t,cancellation:c,members,runs,stop,proof,attempts,retireAttempts}),automatic_release:false,accepted:false};
}
export function prepareEndpointRecovery(db,{relationId,registrarEpoch}){return readonly(db,()=>plan(EP,endpointSnapshot(db,relationId,registrarEpoch)));}
export function recordEndpointRecovery(db,{plan:p,expectedPlanDigest,attestation:a}){
 checkedPlan(p,expectedPlanDigest,EP);checkedAttestation(p,a);return independent(db,()=>{identity(db,p);const old=repeat(db,'contract_recovery_votes',p,a,p.observed_registrar_epoch);if(old)return old;const s=endpointSnapshot(db,p.relation_id,p.observed_registrar_epoch);same(p,s);migrateContractRecovery(db);
 const r=receipt(ER,{...s,authority:'local_stopped_cancellation_and_operator_attestation',plan_digest:p.plan_digest,attestation_digest:digest(a)});insert(db,'contract_recovery_votes',[p.relation_id,p.observed_registrar_epoch],p,a,r);return r;});
}
function registrarSnapshot(db,relationId,input){
 uuid(relationId,'relation_id');if(!Array.isArray(input)||input.length!==2)fail('ENDPOINT_CONFIRMATION_REQUIRED','需要两个不同端点的实际恢复回执');const endpoints=input.map(r=>checkedDocument(r,ER)).sort((a,b)=>a.side.localeCompare(b.side)),n=localIdentity(db);
 if(endpoints[0].side!=='source'||endpoints[1].side!=='target')fail('ENDPOINT_CONFIRMATION_REQUIRED','来源和执行端回执必须分别提供');
 const c=normalizeCancellationClosure(endpoints[0].cancellation),d=c.request.relation;if(d.relation_id!==relationId)fail('CONTRACT_MISMATCH','回执关系与请求不同');
 for(const e of endpoints){uuid(e.node_epoch,'node_epoch');if(e.authority!=='local_stopped_cancellation_and_operator_attestation'||e.node_id!==d[e.side+'_node_id']||e.binding_epoch!==d[e.side+'_epoch']||e.relation_id!==relationId||e.project_id!==d.project_id||e.registrar_node_id!==n.node_id||e.observed_registrar_epoch!==n.sync_epoch||canonical(e.cancellation)!==canonical(c))fail('ENDPOINT_CONFIRMATION_REQUIRED','端点合同、当前代次或停止回执不同');if(e.node_id===n.node_id&&canonical(stored(db,'contract_recovery_votes',relationId,n.sync_epoch))!==canonical(e))fail('ENDPOINT_CONFIRMATION_REQUIRED','本机端点必须引用本机持久回执');}
 const g=db.prepare('SELECT * FROM '+relationGraphsTable(db)+' WHERE graph_id=? AND project_id=?').get(d.graph_id,d.project_id);if(!g||g.graph_epoch!==d.graph_epoch||g.registrar_node_id!==n.node_id||g.registrar_epoch===n.sync_epoch||endpoints.some(e=>e.retired_registrar_epoch!==g.registrar_epoch))fail('REGISTRAR_EPOCH_MISMATCH','仅原登记节点换代后协调旧图');assertGraphCurrent(db,g);
 const edge=db.prepare('SELECT * FROM relation_edges WHERE relation_id=? AND graph_id=?').get(relationId,g.graph_id);if(!edge||canonical(JSON.parse(edge.receipt_json).relation)!==canonical(d)||endpoints.some(e=>e.confirmation_digest!==digest(JSON.parse(edge.receipt_json))))fail('CONTRACT_MISMATCH','双方确认与登记节点旧关系不一致');
 const state={graph:g,edge};for(const table of ['relation_completion_proposals','relation_completions','relation_cancellation_proposals','relation_cancellations'])state[table]=db.prepare('SELECT * FROM '+table+' WHERE relation_id=?').all(relationId);
 if(state.relation_completion_proposals.length||state.relation_completions.length)fail('COMPLETION_COMMITTED','已有完成意图或完成回执，不能改成恢复取消');if(state.relation_cancellations.length)fail('ALREADY_RETIRED','旧图已有正常取消回执，应核对原回执');if(state.relation_cancellation_proposals.some(p=>p.cancellation_digest!==digest(c)))fail('CONTRACT_MISMATCH','原取消停止证明不同');
 return {node_id:n.node_id,node_epoch:n.sync_epoch,relation_id:relationId,project_id:d.project_id,graph_id:g.graph_id,graph_epoch:g.graph_epoch,retired_registrar_epoch:g.registrar_epoch,cancellation:c,endpoint_receipts:endpoints,state_digest:digest(state),automatic_release:false,accepted:false};
}
export function prepareRegistrarRecovery(db,{relationId,endpointReceipts}){return readonly(db,()=>plan(RP,registrarSnapshot(db,relationId,endpointReceipts)));}
export function recordRegistrarRecovery(db,{plan:p,expectedPlanDigest,attestation:a}){
 checkedPlan(p,expectedPlanDigest,RP);checkedAttestation(p,a);return independent(db,()=>{identity(db,p);const old=repeat(db,'contract_recovery_retirements',p,a);if(old)return old;const s=registrarSnapshot(db,p.relation_id,p.endpoint_receipts);same(p,s);migrateContractRecovery(db);
 const r=receipt(RR,{...s,authority:'operator_reviewed_endpoint_receipts',plan_digest:p.plan_digest,attestation_digest:digest(a)});insert(db,'contract_recovery_retirements',[p.relation_id,p.graph_id],p,a,r);return r;});
}
export function recoveredGraphCancellations(db,graphId){if(!schema(db))return [];return db.prepare('SELECT * FROM contract_recovery_retirements WHERE graph_id=? ORDER BY relation_id').all(graphId).map(row=>{const r=checkedDocument(document(row),RR);if(r.relation_id!==row.relation_id||r.graph_id!==graphId||r.authority!=='operator_reviewed_endpoint_receipts')fail('RECEIPT_MISMATCH','登记恢复回执不属于旧图');return r;});}
function settlementSnapshot(db,relationId,r){
 checkedDocument(r,RR);if(r.authority!=='operator_reviewed_endpoint_receipts'||r.relation_id!==relationId)fail('RECEIPT_MISMATCH','需要同一合同的登记恢复回执');const s=endpointSnapshot(db,relationId,r.node_epoch);
 if(r.node_id!==s.registrar_node_id||r.retired_registrar_epoch!==s.retired_registrar_epoch||r.graph_id!==s.cancellation.request.relation.graph_id||r.graph_epoch!==s.cancellation.request.relation.graph_epoch||canonical(r.cancellation)!==canonical(s.cancellation))fail('CONTRACT_MISMATCH','登记恢复回执与本机合同不同');
 if(!Array.isArray(r.endpoint_receipts)||r.endpoint_receipts.length!==2||new Set(r.endpoint_receipts.map(e=>e.side)).size!==2)fail('ENDPOINT_CONFIRMATION_REQUIRED','登记恢复必须包含两个不同端点');
 for(const e of r.endpoint_receipts){checkedDocument(e,ER);const d=s.cancellation.request.relation;if(!['source','target'].includes(e.side)||e.node_id!==d[e.side+'_node_id']||e.binding_epoch!==d[e.side+'_epoch']||e.registrar_node_id!==r.node_id||e.retired_registrar_epoch!==r.retired_registrar_epoch||e.observed_registrar_epoch!==r.node_epoch||e.relation_id!==relationId||e.project_id!==s.project_id||e.confirmation_digest!==s.confirmation_digest||e.authority!=='local_stopped_cancellation_and_operator_attestation'||canonical(e.cancellation)!==canonical(s.cancellation))fail('ENDPOINT_CONFIRMATION_REQUIRED','另一端确认未绑定同一停止合同');uuid(e.node_epoch,'node_epoch');}
 const vote=stored(db,'contract_recovery_votes',relationId,r.node_epoch);if(!vote||vote.node_epoch!==s.node_epoch||!Array.isArray(r.endpoint_receipts)||r.endpoint_receipts.length!==2||!r.endpoint_receipts.some(e=>canonical(e)===canonical(vote)))fail('ENDPOINT_CONFIRMATION_REQUIRED','登记回执必须包含当前本机持久确认');
 return {...s,registrar_receipt:r};
}
export function prepareRecoverySettlement(db,{relationId,registrarReceipt}){return readonly(db,()=>plan(SP,settlementSnapshot(db,relationId,registrarReceipt)));}
export function recordRecoverySettlement(db,{plan:p,expectedPlanDigest,attestation:a}){
 checkedPlan(p,expectedPlanDigest,SP);checkedAttestation(p,a);return independent(db,()=>{identity(db,p);const old=repeat(db,'contract_recovery_settlements',p,a);if(old)return old;const s=settlementSnapshot(db,p.relation_id,p.registrar_receipt);same(p,s);migrateContractRecovery(db);
 const b=db.prepare('SELECT * FROM delegation_bindings WHERE relation_id=?').get(p.relation_id);if(store.get(db,b.task_id).released)store.setReleased(db,{id:b.task_id,released:false,expectedVersion:store.get(db,b.task_id).aggregate_version,actor:'human'});if(!store.get(db,b.task_id).human_gate)store.update(db,{id:b.task_id,humanGate:true,expectedVersion:store.get(db,b.task_id).aggregate_version,actor:'human'});
 const r=receipt(SR,{node_id:p.node_id,node_epoch:p.node_epoch,relation_id:p.relation_id,side:p.side,task_uid:b.task_uid,plan_digest:p.plan_digest,attestation_digest:digest(a),registrar_receipt_digest:s.registrar_receipt.receipt_digest,authority:'operator_reviewed_recovery_settlement',task_disposition:'held_for_human',stopped_proof_digest:s.cancellation.stopped.proof_digest});
 // Existing close guards require a retained cancellation receipt. Original identity/confirmation are unchanged.
 db.prepare('INSERT INTO binding_cancellations VALUES(?,?,?,?,?)').run(p.relation_id,s.cancellation.request.cancel_id,canonical(s.registrar_receipt),digest(s.registrar_receipt),r.recorded_at);
 db.prepare("UPDATE delegation_bindings SET state='cancelled',closed=1 WHERE relation_id=?").run(p.relation_id);
 for(const table of ['binding_attempts','cancellation_registrar_attempts'])if(has(db,table))db.prepare("UPDATE "+table+" SET state='rejected',error_code='LOCAL_RECOVERY_SETTLED' WHERE relation_id=? AND state='pending'").run(p.relation_id);
 insert(db,'contract_recovery_settlements',[p.relation_id],p,a,r);db.prepare("INSERT INTO binding_events(relation_id,kind,detail_json,created_at) VALUES(?,'recovery_settled',?,?)").run(p.relation_id,canonical({receipt_digest:r.receipt_digest,accepted:false,automatic_release:false}),r.recorded_at);return r;});
}
export function contractRecoveryState(db,relationId){uuid(relationId,'relation_id');const r=stored(db,'contract_recovery_settlements',relationId);if(!r)return null;checkedDocument(r,SR);return {phase:'recovered_cancelled',authority:r.authority,receipt_digest:r.receipt_digest,registrar_receipt_digest:r.registrar_receipt_digest,accepted:false,automatic_release:false};}
