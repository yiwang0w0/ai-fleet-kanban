import {PeerError,keys,uuid,version} from "./protocol.mjs";
import {canonical,digest} from "./sync-store.mjs";
import {normalizeRelation} from "./relations.mjs";
const fail=()=>{throw new PeerError("BAD_CANCELLATION_CLOSURE","取消退役合同或回执无效",409);};
const hash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
function exact(x,fields){keys(x,fields,"cancellation closure");if(Object.keys(x).length!==fields.length)fail();}
export function normalizeCancellationClosure(c){
 exact(c,["schema_version","kind","request","stopped"]);
 if(c.schema_version!==1||c.kind!=="delegation_cancellation"||Buffer.byteLength(canonical(c))>16384)fail();
 const q=c.request,r=c.stopped;exact(q,["schema_version","kind","cancel_id","relation","reason_code"]);uuid(q.cancel_id,"cancel_id");const d=normalizeRelation(q.relation);
 if(q.schema_version!==1||q.kind!=="cancel_delegation"||!["operator_cancelled","upstream_cancelled","deadline_exceeded"].includes(q.reason_code))fail();
 exact(r,["schema_version","kind","cancel_id","relation_id","request_digest","source_node_id","source_epoch","target_node_id","target_epoch","stopped","scope_digest","member_count","run_count","downstream_count","proof_digest","fixture_runs"]);
 if(r.schema_version!==1||r.kind!=="cancel_stopped"||r.cancel_id!==q.cancel_id||r.relation_id!==d.relation_id||r.request_digest!==digest(q)||r.stopped!==true||["source_node_id","source_epoch","target_node_id","target_epoch"].some(k=>r[k]!==d[k])||!hash(r.scope_digest)||!hash(r.proof_digest))fail();
 for(const k of ["member_count","run_count","downstream_count","fixture_runs"])if(!Number.isSafeInteger(r[k])||r[k]<(k==="member_count"?1:0)||r[k]>100000)fail();if(r.fixture_runs>r.run_count)fail();return c;
}
export function checkCancellationRetirement(r,c,{registrarNodeId,registrarEpoch}){
 normalizeCancellationClosure(c);const d=c.request.relation;
 exact(r,["schema_version","kind","project_id","graph_id","graph_epoch","graph_version","registrar_node_id","registrar_epoch","relation_id","descriptor_digest","cancellation","cancellation_digest","approved_by","vertices","edges","graph_digest","cancelled","dispatch_ready"]);
 if(r.schema_version!==1||r.kind!=="relation_cancelled"||r.cancelled!==true||r.dispatch_ready!==false||r.registrar_node_id!==registrarNodeId||r.registrar_epoch!==registrarEpoch||["project_id","graph_id","graph_epoch","relation_id"].some(k=>r[k]!==d[k])||r.descriptor_digest!==digest(d)||r.cancellation_digest!==digest(c)||canonical(r.cancellation)!==canonical(c)||!hash(r.graph_digest)||![r.vertices,r.edges].every(x=>Number.isSafeInteger(x)&&x>=0)||!Array.isArray(r.approved_by)||r.approved_by.length!==2)fail();version(r.graph_version);
 const seen=new Set();for(const a of r.approved_by){exact(a,["node_id","node_epoch","credential_version"]);const side=a.node_id===d.source_node_id?"source":a.node_id===d.target_node_id?"target":null;if(!side||seen.has(side)||a.node_epoch!==d[side+"_epoch"]||!Number.isSafeInteger(a.credential_version)||a.credential_version<(a.node_id===registrarNodeId?0:1)||a.node_id===registrarNodeId&&a.credential_version!==0)fail();seen.add(side);}return r;
}
