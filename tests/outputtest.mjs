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
