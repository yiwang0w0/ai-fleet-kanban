import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createOutputDecoder} from "../core/execution/output.mjs";
const sid="session-fixture",tid="turn-fixture",iid="input-fixture";
const init={type:"system",subtype:"init",session_id:sid,model:"model-fixture"};
const result={type:"result",subtype:"success",is_error:false,session_id:sid,result:"中文完成",usage:{input_tokens:7,output_tokens:3}};
const claude=[init,result];
const codex=[{type:"thread.started",thread_id:sid},{type:"turn.started"},{type:"item.completed",item:{id:"i1",type:"agent_message",text:"中文完成"}},{type:"turn.completed",usage:{input_tokens:9,cached_input_tokens:8,output_tokens:4}}];
const envelope=(type,seq,payload)=>({type,eventId:"event-"+seq,sessionId:sid,turnId:tid,seq,payload});
const zcode=[envelope("turn.started",1,{inputId:iid,executionKind:"agent"}),envelope("turn.completed",2,{inputId:iid,resultType:"success",response:"中文完成",usage:{unverifiedShape:55}})];
const options=runtime=>runtime==="zcode"?{expectedSessionId:sid,expectedInputId:iid}:{};
const encode=events=>Buffer.from(events.map(e=>JSON.stringify(e)).join("\n")+"\n");
function decode(runtime,events,{decoder={},exit={exitCode:0},chunks=null}={}){
 const d=createOutputDecoder(runtime,{...options(runtime),...decoder}),b=encode(events);
 for(const c of chunks??[b])d.push(c);
 return d.finish(exit);
}
test("Claude root success needs init, non-error terminal, matching session and exit0",()=>{
 const out=decode("claude",claude,{decoder:{expectedSessionId:sid,expectedModel:"model-fixture"}});
 assert.equal(out.status,"success");assert.equal(out.evidence,"中文完成");assert.deepEqual(out.usage,{input_tokens:7,output_tokens:3});
 assert.equal(out.observed.session_id,sid);assert.equal(out.real_model_call_confirmed,false);
 assert.equal(out.observed.stdout_sha256,createHash("sha256").update(encode(claude)).digest("hex"));
});
test("Codex final agent message and completed usage are required independently of process exit",()=>{
 assert.equal(decode("codex",codex).status,"success");
 assert.deepEqual(decode("codex",codex).usage,{input_tokens:9,output_tokens:4});
 for(const events of [codex.slice(0,3),[codex[0],codex[1],codex[3]],[]])assert.equal(decode("codex",events).status,"failed");
});
test("UTF8 split at every byte, CRLF and an unterminated final line decode consistently",()=>{
 for(const [runtime,events] of [["claude",claude],["codex",codex],["zcode",zcode]]){
  const b=Buffer.from(events.map(JSON.stringify).join("\r\n"));
  const out=decode(runtime,events,{chunks:[...b].map(x=>Buffer.from([x]))});
  assert.equal(out.status,"success");assert.equal(out.evidence,"中文完成");
 }
});
test("Claude success subtype with is_error true and all error subtypes refuse success",()=>{
 for(const patch of [{is_error:true},{subtype:"error_max_turns"},{subtype:"error_during_execution"},{subtype:"error_max_budget_usd"},{subtype:"unknown"}]){
  const out=decode("claude",[init,{...result,...patch}]);assert.equal(out.status,"failed");assert.notEqual(out.evidence,"中文完成");
 }
});
test("wrong or missing root session and model are rejected",()=>{
 for(const events of [[result],[init,{...result,session_id:"other"}],[{...init,model:"unexpected"},result],[{...init,session_id:undefined},result]]){
  assert.equal(decode("claude",events,{decoder:{expectedModel:"model-fixture"}}).status,"failed");
 }
 const events=[init,{type:"assistant",session_id:sid,message:{model:"fallback-model"}},result];
 assert.equal(decode("claude",events,{decoder:{expectedModel:"model-fixture"}}).diagnostic,"MODEL_MISMATCH");
 assert.equal(decode("codex",codex,{decoder:{expectedSessionId:"other"}}).diagnostic,"SESSION_MISMATCH");
});
test("subagent text does not replace the root outcome; child terminal is not root success",()=>{
 const child={type:"assistant",parent_tool_use_id:"tool-1",session_id:"child",message:{model:"child-model",content:[{type:"text",text:"child success"}]}};
 assert.equal(decode("claude",[init,child,result]).evidence,"中文完成");
 assert.equal(decode("claude",[init,{...result,parent_tool_use_id:"tool-1",session_id:"child"}]).status,"failed");
});
test("duplicate starts, terminals and post-terminal result text fail closed",()=>{
 for(const [runtime,events] of [["claude",[init,init,result]],["claude",[...claude,result]],["claude",[...claude,{type:"assistant",session_id:sid}]],["codex",[...codex,codex[3]]],["codex",[...codex,codex[2]]],["codex",[codex[0],codex[0],...codex.slice(1)]]]){
  assert.equal(decode(runtime,events).status,"failed");
 }
});
test("informational events following a terminal do not create another turn",()=>{
 assert.equal(decode("claude",[...claude,{type:"system",subtype:"status",session_id:sid}]).status,"success");
 assert.equal(decode("codex",[...codex,{type:"future.information"}]).status,"success");
});
test("Codex error and failed turn are not hidden by later success",()=>{
 for(const events of [[...codex.slice(0,2),{type:"turn.failed",error:{message:"provider detail"}}], [...codex.slice(0,2),{type:"error",message:"private provider detail"},...codex.slice(2)]]){
  const out=decode("codex",events);assert.equal(out.status,"failed");assert.ok(!out.evidence.includes("provider detail"));
 }
});
test("nonzero exit, signal and spawn failure override a complete terminal",()=>{
 for(const exit of [{exitCode:1},{exitCode:0,signal:"SIGTERM"},{exitCode:0,spawnError:true},{}]){
  assert.equal(decode("claude",claude,{exit}).status,"failed");
 }
});
test("timeout and cancellation override terminal success without inventing zero usage",()=>{
 assert.equal(decode("claude",claude,{exit:{exitCode:0,stopReason:"timeout"}}).status,"timeout");
 const out=decode("codex",[],{exit:{exitCode:1,stopReason:"cancelled"}});
 assert.equal(out.status,"cancelled");assert.equal(out.usage,null);
});
test("malformed UTF8 and JSON diagnostics never echo input fragments",()=>{
 for(const input of [Buffer.from('{"secret":"fixture-private",oops}\n'),Buffer.from([0x22,0xff,0x22,10])]){
  const d=createOutputDecoder("claude");d.push(input);const out=d.finish({exitCode:0});
  assert.equal(out.status,"failed");assert.ok(!JSON.stringify(out).includes("fixture-private"));
 }
});
test("byte, line, event and final evidence limits are enforced",()=>{
 for(const decoder of [{limits:{bytes:10}},{limits:{line:10}},{limits:{events:1}},{limits:{evidence:2}}])assert.equal(decode("claude",claude,{decoder}).status,"failed");
 assert.throws(()=>createOutputDecoder("claude",{limits:{bytes:Infinity}}),{code:"BAD_LIMITS"});
 assert.throws(()=>createOutputDecoder("claude",{limits:{unexpected:1}}),{code:"BAD_LIMITS"});
});
test("missing usage stays null; invalid supplied counters are rejected",()=>{
 assert.equal(decode("claude",[init,{...result,usage:undefined}]).usage,null);
 for(const usage of [{input_tokens:-1,output_tokens:3},{input_tokens:2},{input_tokens:1.5,output_tokens:3},{input_tokens:1,output_tokens:Number.MAX_SAFE_INTEGER+1}]){
  assert.equal(decode("claude",[init,{...result,usage}]).diagnostic,"MALFORMED_USAGE");
 }
});
test("Zcode binds the expected session, input and observed turn",()=>{
 const out=decode("zcode",zcode);assert.equal(out.status,"success");assert.equal(out.observed.turn_id,tid);assert.equal(out.usage,null);
 assert.throws(()=>createOutputDecoder("zcode"),{code:"BAD_BINDING"});
 for(const patch of [{sessionId:"other"},{turnId:"other"},{payload:{...zcode[1].payload,inputId:"other"}}]){
  assert.equal(decode("zcode",[zcode[0],{...zcode[1],...patch}]).status,"failed");
 }
});
test("Zcode turn.completed explicitly distinguishes cancellation, errors and success",()=>{
 for(const resultType of ["cancelled","error_max_turns","error_max_budget","error_during_execution","error_max_tool_calls","unknown"]){
  const out=decode("zcode",[zcode[0],{...zcode[1],payload:{...zcode[1].payload,resultType}}]);
  assert.equal(out.status,resultType==="cancelled"?"cancelled":"failed");
 }
 assert.equal(decode("zcode",[zcode[0],envelope("turn.failed",2,{inputId:iid,error:{message:"private"}})]).status,"failed");
});
test("Zcode refuses sequence gaps and conflicting replay, allowing only the exact latest event replay",()=>{
 assert.equal(decode("zcode",[zcode[0],zcode[0],zcode[1],zcode[1]]).status,"success");
 for(const events of [[zcode[0],{...zcode[1],seq:3}],[zcode[0],{...zcode[0],payload:{inputId:"other"}}],[zcode[1],zcode[0]],[...zcode,{...zcode[1],seq:3,eventId:"event-3"}]]){
  assert.equal(decode("zcode",events).status,"failed");
 }
});
test("Zcode default headless JSON and control-only turns cannot prove model completion",()=>{
 assert.equal(decode("zcode",[{sessionId:sid,response:"looks successful",projection:{status:"completed"}}]).status,"failed");
 assert.equal(decode("zcode",[{...zcode[0],payload:{inputId:iid,executionKind:"controlOnly"}},zcode[1]]).diagnostic,"CONTROL_ONLY_TURN");
});
test("finish is stable and returned receipt mutation cannot change a later observation",()=>{
 const d=createOutputDecoder("claude");d.push(encode(claude));const out=d.finish({exitCode:0});out.status="tampered";out.observed.model="tampered";
 assert.equal(d.finish({exitCode:1}).status,"success");assert.equal(d.finish().observed.model,"model-fixture");
 assert.throws(()=>d.push(Buffer.from("\n")),{code:"DECODER_CLOSED"});
});
test("non-object, missing-type and oversized session inputs cannot become terminal evidence",()=>{
 for(const event of [null,[],2,{},{type:"result",session_id:"x".repeat(201)}])assert.equal(decode("claude",[event]).status,"failed");
});

test("Zcode cannot reuse an earlier event identity with a later sequence",()=>{
 const middle=envelope("session.updated",2,{});
 const forged={...zcode[1],seq:3,eventId:zcode[0].eventId};
 assert.equal(decode("zcode",[zcode[0],middle,forged]).diagnostic,"EVENT_ID_REUSED");
});

test("Claude controlled profile verifies the complete initialized tool list and connected server",()=>{
 const tools=["mcp__fleet__get_task","mcp__fleet__report_result"],decoder={expectedTools:tools,expectedMcpServer:"fleet"};
 const connected={...init,tools,mcp_servers:[{name:"fleet",status:"connected"}]};
 assert.equal(decode("claude",[connected,result],{decoder}).status,"success");
 for(const patch of [{tools:undefined},{tools:[...tools,"Bash"]},{tools:[tools[0]]},{tools:[tools[0],tools[0]]}]){
  assert.equal(decode("claude",[{...connected,...patch},result],{decoder}).diagnostic,"TOOL_SCOPE_MISMATCH");
 }
 for(const mcp_servers of [undefined,[],[{name:"fleet",status:"failed"}],[{name:"other",status:"connected"}],[...connected.mcp_servers,{name:"extra",status:"connected"}]]){
  assert.equal(decode("claude",[{...connected,mcp_servers},result],{decoder}).diagnostic,"MCP_NOT_CONNECTED");
 }
});
test("Claude controlled profile rejects unexpected tool calls and child execution",()=>{
 const tools=["mcp__fleet__get_task"],decoder={expectedTools:tools};
 const start={...init,tools},message={type:"assistant",session_id:sid,message:{model:"model-fixture",content:[{type:"tool_use",name:tools[0],input:{}}]}};
 assert.equal(decode("claude",[start,message,result],{decoder}).status,"success");
 const bad={...message,message:{...message.message,content:[{type:"tool_use",name:"Bash",input:{command:"private-fixture"}}]}};
 const out=decode("claude",[start,bad,result],{decoder});assert.equal(out.diagnostic,"UNAUTHORIZED_TOOL");assert.ok(!JSON.stringify(out).includes("private-fixture"));
 assert.equal(decode("claude",[start,{...message,parent_tool_use_id:"unexpected-child"},result],{decoder}).diagnostic,"UNEXPECTED_CHILD_OUTPUT");
 assert.equal(decode("claude",[start,{...message,message:{}},result],{decoder}).diagnostic,"MALFORMED_ASSISTANT");
});
test("decoder rejects unsupported or malformed tool bindings instead of silently ignoring them",()=>{
 for(const expectedTools of [{},["x","x"],[1]])assert.throws(()=>createOutputDecoder("claude",{expectedTools}),{code:"BAD_TOOL_BINDING"});
 for(const runtime of ["codex","zcode"])assert.throws(()=>createOutputDecoder(runtime,{...options(runtime),expectedTools:["get_task"]}),{code:"UNSUPPORTED_TOOL_BINDING"});
 const expectedTools=["mcp__fleet__get_task"],d=createOutputDecoder("claude",{expectedTools});
 expectedTools.push("Bash");
 d.push(encode([{...init,tools:expectedTools},result]));assert.equal(d.finish({exitCode:0}).diagnostic,"TOOL_SCOPE_MISMATCH");
});
// ZCode 0.16.9 headless stream: mapped events followed by a distinct summary.
// These successful streams are synthetic contract fixtures, not model receipts.
const prompt="核验本次任务，不执行其他任务。",traceId="trace-fixture",provider="account:bigmodel-individual-coding-plan";
const headlessOptions={expectedSessionId:null,expectedInputId:null,zcodeTransport:"headless-stream",expectedProvider:provider,expectedModel:"GLM-5.3",expectedPromptSha256:createHash("sha256").update(prompt).digest("hex")};
const headlessEvent=(type,seq,payload)=>({...envelope(type,seq,payload),traceId,timestamp:1790750000000+seq});
const headlessEvents=[headlessEvent("turn.started",3,{input:prompt,turnNumber:1}),headlessEvent("session.updated",4,{providerId:provider,modelId:"GLM-5.3",messageCount:2,toolCount:0,iteration:0}),headlessEvent("turn.completed",5,{resultType:"success",response:"中文完成"}),{type:"result",sessionId:sid,turnId:tid,traceId,response:"中文完成",eventCount:3,projection:{status:"completed",turnCount:1,totalTokenCount:14}}];
const headless=(events=headlessEvents,extra={})=>decode("zcode",events,{...extra,decoder:{...headlessOptions,...extra.decoder}});

test("Zcode headless binds prompt digest and observes its model, terminal and summary",()=>{
 const out=headless();assert.equal(out.status,"success");assert.equal(out.evidence,"中文完成");assert.equal(out.observed.model,"GLM-5.3");assert.equal(out.observed.session_id,sid);assert.equal(out.observed.turn_id,tid);assert.equal(out.usage,null);assert.equal(out.real_model_call_confirmed,false);
 const bytes=encode(headlessEvents),chunks=Array.from(bytes,b=>Buffer.from([b]));assert.equal(headless(headlessEvents,{chunks}).status,"success");
 assert.ok(!JSON.stringify(out).includes(prompt));
});

test("Zcode headless transport requires explicit digest, provider and model, without RPC input binding",()=>{
 for(const patch of [{expectedPromptSha256:null},{expectedPromptSha256:"not-sha256"},{expectedProvider:null},{expectedModel:null},{expectedSessionId:sid},{expectedInputId:iid}]){
  assert.throws(()=>createOutputDecoder("zcode",{...headlessOptions,...patch}),{code:"BAD_BINDING"});
 }
 assert.throws(()=>createOutputDecoder("claude",{zcodeTransport:"headless-stream"}),{code:"UNSUPPORTED_BINDING"});
 assert.throws(()=>createOutputDecoder("zcode",{...options("zcode"),expectedPromptSha256:headlessOptions.expectedPromptSha256}),{code:"UNSUPPORTED_BINDING"});
 assert.throws(()=>createOutputDecoder("zcode",{...headlessOptions,zcodeTransport:"json"}),{code:"BAD_TRANSPORT"});
 assert.throws(()=>createOutputDecoder("zcode",{...headlessOptions,expectedTools:["get_task"]}),{code:"UNSUPPORTED_TOOL_BINDING"});
});

test("Zcode headless cannot substitute a different prompt or control/background turn",()=>{
 for(const patch of [{input:"other-private-task"},{input:prompt+" "},{input:null},{input:{text:prompt}},{executionKind:"controlOnly"},{inputVisibility:"model-only"},{workflowLaunch:{}},{backgroundSource:"worker"},{automationId:"another-job"},{offPeakTaskId:"background"},{attachments:[{path:"private"}]}]){
  const out=headless([{...headlessEvents[0],payload:{...headlessEvents[0].payload,...patch}},...headlessEvents.slice(1)]);assert.equal(out.status,"failed");assert.ok(!JSON.stringify(out).includes("other-private-task"));
 }
});

test("Zcode headless checks session, turn and trace on intermediate events and summary",()=>{
 for(const index of [1,2,3])for(const patch of [{sessionId:"other"},{turnId:"other"},{traceId:"other"}]){
  assert.equal(headless(headlessEvents.map((event,i)=>i===index?{...event,...patch}:event)).status,"failed");
 }
 const stream=headlessEvent("model.streaming",5,{kind:"text_delta",delta:"untrusted"});
 assert.equal(headless([...headlessEvents.slice(0,2),{...stream,turnId:"child"}]).diagnostic,"TURN_MISMATCH");
});

test("Zcode headless verifies requested provider and model and does not infer a model call from success text",()=>{
 for(const patch of [{providerId:"account:zai-coding-plan"},{modelId:"fallback-model"},{modelId:null}]){
  assert.equal(headless(headlessEvents.map((event,i)=>i===1?{...event,payload:{...event.payload,...patch}}:event)).status,"failed");
 }
 for(const payload of [{},{modelSelection:{providerId:provider,modelId:"GLM-5.3"}},{providerId:provider,modelId:"GLM-5.3",messageCount:2,toolCount:0}]){
  assert.equal(headless(headlessEvents.map((event,i)=>i===1?{...event,payload}:event)).diagnostic,"MODEL_NOT_OBSERVED");
 }
});

test("Zcode headless requires both terminal and final summary, and forbids conflicting or extra summaries",()=>{
 assert.equal(headless(headlessEvents.slice(0,3)).diagnostic,"MISSING_SUMMARY");
 assert.equal(headless([headlessEvents[3]]).diagnostic,"SUMMARY_WITHOUT_TERMINAL");
 for(const patch of [{response:"different"},{turnResponses:["another result"]},{eventCount:-1},{projection:{}},{projection:null}]){
  assert.equal(headless(headlessEvents.map((event,i)=>i===3?{...event,...patch}:event)).status,"failed");
 }
 assert.equal(headless([...headlessEvents,headlessEvents[3]]).diagnostic,"OUTPUT_AFTER_SUMMARY");
 assert.equal(headless([...headlessEvents,headlessEvent("session.updated",6,{})]).diagnostic,"OUTPUT_AFTER_SUMMARY");
});

test("Zcode headless terminal cancellation and errors are never upgraded by summary status",()=>{
 for(const resultType of ["cancelled","error_max_turns","error_max_budget","error_during_execution","error_max_tool_calls"]){
  const events=headlessEvents.map((event,i)=>i===2?{...event,payload:{resultType,response:""}}:i===3?{...event,response:""}:event);
  assert.equal(headless(events).status,resultType==="cancelled"?"cancelled":"failed");
 }
 assert.equal(headless(headlessEvents.map((event,i)=>i===2?{...event,payload:{resultType:"future",response:"中文完成"}}:event)).diagnostic,"MALFORMED_TERMINAL");
});

test("Zcode headless startup failure observed from isolated installed runtime remains failed and sanitized",()=>{
 // Actual no-account probe emitted a turn.failed before turn.started and exited 1.
 const event=headlessEvent("turn.failed",1,{error:{type:"unknown_error",code:"CONFIGURATION_ERROR",message:"private-failure-detail",stack:"private-stack"},turnPhase:"model_creation"});
 const out=headless([event],{exit:{exitCode:1}});assert.equal(out.status,"failed");assert.equal(out.observed.protocol_error,"PROVIDER_STARTUP_FAILED");assert.equal(out.observed.terminal_status,null);assert.ok(!JSON.stringify(out).includes("private-"));assert.equal(out.real_model_call_confirmed,false);
 const failed=headless([...headlessEvents.slice(0,2),headlessEvent("turn.failed",5,{error:{message:"private-failure-detail"}})],{exit:{exitCode:1}});assert.equal(failed.status,"failed");assert.equal(failed.observed.terminal_status,"failed");assert.ok(!JSON.stringify(failed).includes("private-failure-detail"));
});

test("Zcode headless sequence gaps, duplicate event IDs and replay are rejected",()=>{
 for(const patch of [{seq:6},{seq:3},{eventId:headlessEvents[0].eventId},{seq:-1},{eventId:null},{timestamp:"bad"}]){
  assert.equal(headless(headlessEvents.map((event,i)=>i===1?{...event,...patch}:event)).status,"failed");
 }
 assert.equal(headless([headlessEvents[0],...headlessEvents]).diagnostic,"EVENT_SEQUENCE_GAP");
});

test("Zcode headless refuses second turns, resumed streams and unsupported workflow events",()=>{
 for(const type of ["turn.started","session.resumed","turn.steerQueued","turn.steerDrained","rewind.triggered","workflow.progress"]){
  assert.equal(headless([...headlessEvents.slice(0,3),headlessEvent(type,6,{input:prompt})]).status,"failed");
 }
 for(const type of ["model.streaming","tool.updated","permission.requested","message.upserted"]){
  assert.equal(headless([...headlessEvents.slice(0,3),headlessEvent(type,6,{})]).diagnostic,"OUTPUT_OUTSIDE_TURN");
 }
});

test("Zcode headless success cannot override nonzero exit, cancellation, timeout or resource limits",()=>{
 for(const exit of [{exitCode:1},{exitCode:0,signal:"SIGTERM"},{exitCode:0,spawnError:true},{exitCode:0,stopReason:"cancelled"},{exitCode:0,stopReason:"timeout"}])assert.notEqual(headless(headlessEvents,{exit}).status,"success");
 for(const limits of [{bytes:10},{line:10},{events:2},{evidence:2}])assert.equal(headless(headlessEvents,{decoder:{limits}}).status,"failed");
});

test("Zcode headless summary event counts and untyped usage are not reinterpreted as billing or proof",()=>{
 const events=headlessEvents.map((event,i)=>i===3?{...event,eventCount:1,usage:{futureMetric:99},projection:{...event.projection,status:"idle"}}:event);
 const out=headless(events);assert.equal(out.status,"success");assert.equal(out.usage,null);assert.equal(out.real_model_call_confirmed,false);
});
