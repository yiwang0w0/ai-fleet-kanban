import {PeerError,keys,uuid,version} from "./protocol.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {normalizeRelation} from "./relations.mjs";
const fail=()=>{throw new PeerError("BAD_COMPLETION","完成合同或回执无效",409);};
function exact(x,fields){keys(x,fields,"completion");if(Object.keys(x).length!==fields.length)fail();}
const hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x),oid=x=>typeof x==="string"&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(x);
export function normalizeCompletionPlan(p){
 exact(p,["schema_version","kind","completion_id","relation","result_id","body_digest","source_task_version","target_task_version","verification_receipt_digest","integration_receipt_digest","artifact_manifest_digest","source_merge_commit","source_tree","scope_digest","fixture_runs","decision"]);
 if(p.schema_version!==1||p.kind!=="source_acceptance"||Buffer.byteLength(canonical(p))>24576)fail();uuid(p.completion_id,"completion_id");uuid(p.result_id,"result_id");normalizeRelation(p.relation);version(p.source_task_version);version(p.target_task_version);
 for(const k of ["body_digest","verification_receipt_digest","integration_receipt_digest","artifact_manifest_digest","scope_digest"])if(!hash(p[k]))fail();
 if(!oid(p.source_merge_commit)||!oid(p.source_tree)||p.source_merge_commit.length!==p.source_tree.length||!Number.isSafeInteger(p.fixture_runs)||p.fixture_runs<0||p.fixture_runs>100000)fail();
 exact(p.decision,["kind","note","allow_fixture"]);if(p.decision.kind!=="operator"||typeof p.decision.note!=="string"||!p.decision.note.trim()||Buffer.byteLength(p.decision.note)>4096||typeof p.decision.allow_fixture!=="boolean"||p.fixture_runs>0&&!p.decision.allow_fixture)fail();return p;
}
export function completionReady(p){normalizeCompletionPlan(p);return {schema_version:1,kind:"completion_ready",completion_id:p.completion_id,plan_digest:digest(p),result_id:p.result_id,target_node_id:p.relation.target_node_id,target_epoch:p.relation.target_epoch,target_task_version:p.target_task_version,scope_digest:p.scope_digest};}
export function completionContract(p,ready){normalizeCompletionPlan(p);if(canonical(ready)!==canonical(completionReady(p)))fail();return {schema_version:1,kind:"delegation_completion",plan:p,ready};}
export function normalizeCompletion(c){exact(c,["schema_version","kind","plan","ready"]);if(canonical(c)!==canonical(completionContract(c.plan,c.ready)))fail();return c;}
export function checkCompletionReceipt(receipt,completion,{registrarNodeId,registrarEpoch}){
 normalizeCompletion(completion);const d=completion.plan.relation;
 exact(receipt,["schema_version","kind","project_id","graph_id","graph_epoch","graph_version","registrar_node_id","registrar_epoch","relation_id","descriptor_digest","completion","completion_digest","approved_by","vertices","edges","graph_digest","completed","dispatch_ready"]);
 if(receipt.schema_version!==1||receipt.kind!=="relation_completed"||receipt.completed!==true||receipt.dispatch_ready!==false||receipt.registrar_node_id!==registrarNodeId||receipt.registrar_epoch!==registrarEpoch||["project_id","graph_id","graph_epoch","relation_id"].some(k=>receipt[k]!==d[k])||receipt.descriptor_digest!==digest(d)||receipt.completion_digest!==digest(completion)||canonical(receipt.completion)!==canonical(completion)||!hash(receipt.graph_digest)||![receipt.vertices,receipt.edges].every(x=>Number.isSafeInteger(x)&&x>=0)||!Array.isArray(receipt.approved_by)||receipt.approved_by.length!==2)fail();version(receipt.graph_version);
 const seen=new Set();for(const a of receipt.approved_by){exact(a,["node_id","node_epoch","credential_version"]);const side=a.node_id===d.source_node_id?"source":a.node_id===d.target_node_id?"target":null;if(!side||seen.has(side)||a.node_epoch!==d[side+"_epoch"]||!Number.isSafeInteger(a.credential_version)||a.credential_version<(a.node_id===registrarNodeId?0:1)||a.node_id===registrarNodeId&&a.credential_version!==0)fail();seen.add(side);}return receipt;
}
