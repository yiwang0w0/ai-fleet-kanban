'use strict';
// Stable conflict guidance; never classify by error prose or substitute a current run ID.
const text={
 task_version:['任务版本已变化。保留草稿，刷新任务后核对差异，再明确提交；不会自动覆盖。','refresh_task_and_review_draft'],
 run_identity:['执行实例已变化。停止旧运行的心跳和回报，保留原输出供核对；不得替换为当前运行标识后重交。','retain_old_run_output_and_review'],
 request_identity:['请求编号已绑定其他内容。核对原请求及回执；重试必须保留原编号和内容，新的操作需重新确认。','inspect_original_request'],
 graph_version:['登记图版本已变化。重新读取登记状态，核对原请求回执和当前拓扑，再决定下一步。','refresh_registrar_and_review_request'],
 protocol_state:['协议状态或版本与本次操作不符。刷新任务、关系和回执后核对；原在途请求不得静默替换。','refresh_protocol_state_and_review'],
 state:['当前状态与本次操作不符。刷新并核对原操作条件，再决定下一步。','refresh_state_and_review']
};
function describeConflict(error,{scope='local'}={}){
 const code=typeof error==='string'?error:error?.code;
 let kind=null,versions=null;
 if(code==='CONFLICT'){
  if(error?.conflict_kind==='run_identity')kind='run_identity';
  else if(Number.isSafeInteger(error?.expected_version)&&error.expected_version>0&&Number.isSafeInteger(error?.current_version)&&error.current_version>0){
   kind='task_version';versions={expected_version:error.expected_version,current_version:error.current_version};
  }else kind=scope==='federation'?'protocol_state':'state';
 }else if(code==='REQUEST_CONFLICT'||code==='RESULT_CONFLICT')kind='request_identity';
 else if(code==='GRAPH_VERSION_CONFLICT')kind='graph_version';
 if(!kind)return null;
 return {format:'ai-fleet-conflict/v1',kind,message:text[kind][0],next_action:text[kind][1],automatic_retry:false,...(versions??{})};
}
module.exports={describeConflict};
