import {digest} from "../federation/sync-store.mjs";
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t);
/** Reads durable observations; ended task rows alone are never proof of process quiescence. */
export function inspectStoppedRuns(db,{nodeId,nodeEpoch,members,runs}){
 const blockers=[],proofs=[];let fixtureRuns=0;
 for(const t of members){const actual=db.prepare("SELECT status FROM tasks WHERE id=? AND task_uid=?").get(t.task_id,t.task_uid);if(!actual||actual.status==="in_progress"&&!runs.some(r=>r.task_id===t.task_id&&r.state==="running"))blockers.push({kind:"task_state_unconfirmed",task_uid:t.task_uid});}
 for(const r of runs){
  const d=exists(db,"broker_dispatches")?db.prepare("SELECT * FROM broker_dispatches WHERE run_id=?").get(r.run_id):null;
  if(!d){blockers.push({kind:"unmanaged_run",run_id:r.run_id});continue;}
  if(d.node_id!==nodeId||d.node_epoch!==nodeEpoch){blockers.push({kind:"old_epoch_run",run_id:r.run_id});continue;}
  if(r.state!=="ended"){blockers.push({kind:"run_active",run_id:r.run_id});continue;}
  if(!d.launch_at){if(d.phase!=="abandoned"){blockers.push({kind:"unsettled_preparation",run_id:r.run_id});continue;}proofs.push({run_id:r.run_id,kind:"never_launched"});continue;}
  if(d.phase!=="settled"||!d.result_digest){blockers.push({kind:"outcome_missing",run_id:r.run_id});continue;}
  if(d.execution_mode==="fixture"){proofs.push({run_id:r.run_id,kind:"fixture_terminal",result_digest:d.result_digest});fixtureRuns++;continue;}
  const e=db.prepare("SELECT * FROM broker_execution_records WHERE dispatch_id=?").get(d.dispatch_id);
  if(!e?.observation_json){blockers.push({kind:"observation_missing",run_id:r.run_id});continue;}
  const o=JSON.parse(e.observation_json),p=o.process;
  if(digest(o)!==e.observation_digest||!p||!(p.started===false&&p.cleanup==="not_started"||p.containment==="windows-job"&&p.cleanup==="job_empty")){blockers.push({kind:"process_stop_unconfirmed",run_id:r.run_id});continue;}
  proofs.push({run_id:r.run_id,kind:p.started===false?"not_started":"windows_job_empty",observation_digest:e.observation_digest,launch_digest:e.launch_digest});
 }

 return {blockers,proofs,fixtureRuns};
}
