import {randomUUID} from "node:crypto";
import {atomic} from "./sync-store.mjs";
import {cancellationWork,prepareCancellation,confirmCancellationStopped} from "./cancellation.mjs";
import {cancelUnsentBinding} from "./bindings.mjs";
import {abandonPrepared} from "../execution/dispatch.mjs";
/** Advances local durable work only. Network delivery is a separate explicit step. */
export function progressCancellation(db,relationId){return atomic(db,()=>{
 const work=cancellationWork(db,relationId);
 if(work.c.state==="stopped")return confirmCancellationStopped(db,relationId);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='broker_dispatches'").get()){
  for(const r of work.runs){const d=db.prepare("SELECT dispatch_id,phase,launch_at FROM broker_dispatches WHERE run_id=?").get(r.run_id);
   if(d&&!d.launch_at&&["prepared","interrupted"].includes(d.phase))abandonPrepared(db,{dispatchId:d.dispatch_id,reason:"delegation cancellation "+work.c.cancel_id});
  }
 }
 for(const b of work.downstream){
  if(b.state==="prepared"){try{cancelUnsentBinding(db,b.relation_id);}catch(e){if(e.code!=="UNKNOWN_REMOTE_OUTCOME")throw e;}continue;}
  if(!db.prepare("SELECT 1 FROM delegation_cancellations WHERE relation_id=?").get(b.relation_id)){const t=db.prepare("SELECT aggregate_version FROM tasks WHERE id=?").get(b.task_id);prepareCancellation(db,{relationId:b.relation_id,cancelId:randomUUID(),expectedTaskVersion:t.aggregate_version,reasonCode:"upstream_cancelled"});}
 }
 return confirmCancellationStopped(db,relationId);
});}
