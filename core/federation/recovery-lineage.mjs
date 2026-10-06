// Minimal authenticated provenance, not proof of physical retirement.
import {PeerError,keys,uuid} from "./protocol.mjs";
import {canonical,digest} from "./sync-store.mjs";
export const MAX_RECOVERY_HOPS=64;
const fail=(code,message)=>{throw new PeerError(code,message,409);};
const exact=(value,fields,label)=>{keys(value,fields,label);if(Object.keys(value).length!==fields.length)fail("BAD_INPUT",label+" 字段缺失");};
const hash=x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
export function checkRecoveryMarker(marker){
 exact(marker,["format","node_id","recovery_id","retired_epoch","backup_epoch","new_epoch","activated_at","receipt_digest"],"source recovery");
 for(const k of ["node_id","recovery_id","retired_epoch","backup_epoch","new_epoch"])uuid(marker[k],k);
 if(marker.format!=="ai-fleet-source-recovery/v1"||marker.new_epoch===marker.retired_epoch||marker.new_epoch===marker.backup_epoch||
  !hash(marker.receipt_digest)||typeof marker.activated_at!=="string"||marker.activated_at.length>64||!Number.isFinite(Date.parse(marker.activated_at)))fail("RECOVERY_MISMATCH","恢复标记身份、摘要或时间无效");
 return marker;
}
export function checkRecoveryLineage(lineage,{nodeId,fromEpoch,toEpoch,tip}){
 exact(lineage,["format","node_id","from_epoch","to_epoch","transitions","chain_digest"],"recovery lineage");
 const {chain_digest,...payload}=lineage;
 if(lineage.format!=="ai-fleet-source-recovery-chain/v1"||lineage.node_id!==nodeId||lineage.from_epoch!==fromEpoch||lineage.to_epoch!==toEpoch||fromEpoch===toEpoch||
  !Array.isArray(lineage.transitions)||!lineage.transitions.length||lineage.transitions.length>MAX_RECOVERY_HOPS||!hash(chain_digest)||digest(payload)!==chain_digest)fail("RECOVERY_MISMATCH","恢复链身份、长度或摘要不匹配");
 let current=fromEpoch;const epochs=new Set([current]),ids=new Set();
 for(const marker of lineage.transitions){
  checkRecoveryMarker(marker);
  if(marker.node_id!==nodeId||marker.retired_epoch!==current||epochs.has(marker.new_epoch)||ids.has(marker.recovery_id))fail("RECOVERY_MISMATCH","恢复链不连续、重复或循环");
  current=marker.new_epoch;epochs.add(current);ids.add(marker.recovery_id);
 }
 if(current!==toEpoch||canonical(lineage.transitions.at(-1))!==canonical(tip))fail("RECOVERY_MISMATCH","恢复链末端与认证握手标记不同");
 return lineage;
}
