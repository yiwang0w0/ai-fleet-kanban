import {digest} from "./federation/sync-store.mjs";
import {launchReceipt,processObservation} from "./execution/receipts.mjs";

const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const at=value=>typeof value==="string"&&value.length<=40&&Number.isFinite(Date.parse(value))?value:null;
function object(text,expectedDigest=null){
 if(typeof text!=="string"||Buffer.byteLength(text)>4*1024*1024)return null;
 try{
  const value=JSON.parse(text);
  if(!value||typeof value!=="object"||Array.isArray(value)||expectedDigest!==null&&digest(value)!==expectedDigest)return null;
  return value;
 }catch{return null;}
}

/** 只读展示：领取、启动许可与进程观察各自保留含义，不授予执行或重派权限。 */
export function taskExecutionView(db,t){
 const view={run_id:null,released_at:null,claimed_at:null,launch_requested_at:null,process_started_at:null,last_activity_at:null,ended_at:null,process_state:"unverified",work_state:"unverified"};
 if(!t||!Number.isSafeInteger(t.id)||t.id<=0)return view;
 const hasEvents=exists(db,"task_events");
 if(hasEvents){
  for(const event of db.prepare("SELECT at,kind,detail FROM task_events WHERE task_id=? AND kind IN('add','release') ORDER BY id DESC").iterate(t.id)){
   const detail=object(event.detail);
   // 迁移快照、重复放行与归还在途卡，都不是新的放行记录。
   if(detail&&(event.kind==="add"&&detail.released===true||event.kind==="release"&&detail.action==="release"&&detail.from===false&&detail.to===true)&&at(event.at)){
    view.released_at=event.at;break;
   }
  }
 }
 if(typeof t.run_id!=="string"||!exists(db,"task_runs"))return view;
 const run=db.prepare("SELECT run_id,task_id,task_uid,owner_node_id,worker,runtime,agent_instance_id,imported,state,ended_at FROM task_runs WHERE run_id=? AND task_id=? AND task_uid=? AND owner_node_id=?").get(t.run_id,t.id,t.task_uid,t.owner_node_id);
 if(!run)return view;
 view.run_id=run.run_id;
 if(run.state==="ended")view.ended_at=at(run.ended_at);
 // 导入运行的建立时刻并非历史领取时刻，不能用 started_at 或工作区间补造。
 if(run.imported)return view;
 if(hasEvents){
  for(const event of db.prepare("SELECT at,actor,detail FROM task_events WHERE task_id=? AND kind='claim' ORDER BY id DESC").iterate(t.id)){
   const detail=object(event.detail);
   if(detail?.run_id===run.run_id&&detail.status==="in_progress"&&event.actor===run.worker){view.claimed_at=at(event.at);break;}
  }
 }
 if(!exists(db,"broker_dispatches"))return view;
 const dispatch=db.prepare("SELECT dispatch_id,task_id,task_uid,node_id,run_id,worker,agent_instance_id,principal_id,launch_at,result_json,result_digest FROM broker_dispatches WHERE run_id=?").get(run.run_id);
 if(!dispatch||dispatch.task_id!==t.id||dispatch.task_uid!==t.task_uid||dispatch.node_id!==t.owner_node_id||dispatch.worker!==run.worker||dispatch.agent_instance_id!==run.agent_instance_id)return view;
 // launch_at 只证明一次性启动许可已消费，不证明进程创建成功。
 view.launch_requested_at=at(dispatch.launch_at);
 if(!view.launch_requested_at||!exists(db,"broker_execution_records"))return view;
 const record=db.prepare("SELECT launch_json,launch_digest,observation_json,observation_digest FROM broker_execution_records WHERE dispatch_id=?").get(dispatch.dispatch_id);
 const launch=object(record?.launch_json,record?.launch_digest??null),observation=object(record?.observation_json,record?.observation_digest??null),receipt=object(dispatch.result_json);
 if(!launch||!observation||!receipt||!record.launch_digest||!record.observation_digest)return view;
 const result={status:receipt.status,evidence:receipt.evidence,usage:receipt.usage};
 let checked;
 try{
  if(!dispatch.result_digest||digest(result)!==dispatch.result_digest)return view;
  const binding=launchReceipt(launch);
  if(binding.run_id!==run.run_id||binding.agent_instance_id!==run.agent_instance_id||binding.principal_id!==dispatch.principal_id||binding.runtime!==run.runtime)return view;
  checked=processObservation(observation,{result,launch:binding});
 }catch{return view;}
 // 上面的捕获仅包围回执解析；SQLite 查询错误必须向调用方报告，不能伪装成无证据。
 const process=checked.process,activity=process.activity;
 if(process.started===false)view.process_state="not_started";
 if(process.started===true){
  view.process_state="observed";
  view.process_started_at=at(activity?.started_at);
  // 有效协议活动仍不等于模型已完成有用工作，更不等于任务已经验收。
  if(activity?.events>0&&checked.observed?.protocol_error===null&&checked.observed?.model===launch.model&&at(activity.last_event_at)){
   view.last_activity_at=activity.last_event_at;view.work_state="activity_observed";
  }
 }
 return view;
}
