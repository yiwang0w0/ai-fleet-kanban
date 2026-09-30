import {createHash} from "node:crypto";

export class OutputError extends Error {
 constructor(code){super(code);this.name="OutputError";this.code=code;}
}
const fail=code=>{throw new OutputError(code);};
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const id=x=>typeof x==="string"&&x.length>0&&x.length<=200&&!/[\u0000-\u001f\u007f]/.test(x);
const count=x=>Number.isSafeInteger(x)&&x>=0;
const DEFAULT_LIMITS=Object.freeze({bytes:32*1024*1024,line:1024*1024,events:100000,evidence:65536});
function limitsFor(overrides){
 if(!object(overrides)||Object.keys(overrides).some(k=>!(k in DEFAULT_LIMITS)))fail("BAD_LIMITS");
 const limits={...DEFAULT_LIMITS,...overrides};
 for(const [k,n] of Object.entries(limits))if(!Number.isSafeInteger(n)||n<1||n>DEFAULT_LIMITS[k])fail("BAD_LIMITS");
 return limits;
}
function usageFrom(value){
 if(value===undefined||value===null)return null;
 if(!object(value)||!count(value.input_tokens)||!count(value.output_tokens))fail("MALFORMED_USAGE");
 return {input_tokens:value.input_tokens,output_tokens:value.output_tokens};
}

/**
 * One process / one top-level turn. Receives UTF-8 NDJSON, or individual ZCode
 * session event envelopes after a protocol transport validates its RPC framing.
 * Provider text is data; parser diagnostics never include rejected input.
 */
export function createOutputDecoder(runtime,{expectedSessionId=null,expectedInputId=null,expectedModel=null,expectedTools=null,expectedMcpServer=null,zcodeTransport="session-events",expectedPromptSha256=null,expectedProvider=null,limits={}}={}){
 if(!["claude","codex","zcode"].includes(runtime))fail("BAD_RUNTIME");
 if([expectedSessionId,expectedInputId,expectedModel].some(x=>x!==null&&!id(x)))fail("BAD_BINDING");
 if(!["session-events","headless-stream"].includes(zcodeTransport))fail("BAD_TRANSPORT");
 const headless=runtime==="zcode"&&zcodeTransport==="headless-stream";
 if(headless){
  if(expectedSessionId!==null||expectedInputId!==null||!expectedModel||!id(expectedProvider)||typeof expectedPromptSha256!=="string"||!/^[a-f0-9]{64}$/.test(expectedPromptSha256))fail("BAD_BINDING");
 }else{
  if(zcodeTransport!=="session-events"||expectedPromptSha256!==null||expectedProvider!==null)fail("UNSUPPORTED_BINDING");
  if(runtime==="zcode"&&(!expectedSessionId||!expectedInputId))fail("BAD_BINDING");
 }
 if(expectedTools!==null&&(!Array.isArray(expectedTools)||expectedTools.some(t=>!id(t))||new Set(expectedTools).size!==expectedTools.length))fail("BAD_TOOL_BINDING");
 if(expectedMcpServer!==null&&!id(expectedMcpServer))fail("BAD_TOOL_BINDING");
 if(expectedMcpServer!==null&&runtime!=="claude"||expectedTools!==null&&runtime!=="claude"&&!headless)fail("UNSUPPORTED_TOOL_BINDING");
 if(headless&&expectedTools!==null&&(expectedTools.length>128||expectedTools.some(t=>!/^mcp__fleet__[a-z_][a-z0-9_]*$/.test(t))))fail("BAD_TOOL_BINDING");
 const allowedTools=expectedTools===null?null:new Set(expectedTools);
 const seenEvents=new Set();
 const bound=limitsFor(limits),hash=createHash("sha256"),utf8=new TextDecoder("utf-8",{fatal:true});
 let chunks=[],pending=0,bytes=0,events=0,closed=false,failure=null,cached=null;
 let session=null,turn=null,model=null,started=false,terminal=null,lastText="",lastSeq=null,lastEvent=null,lastEventHash=null;
 let trace=null,summarySeen=false,modelRequestSeen=false,terminalResponse=null,openingTurn=null,openingTrace=null;
 const toolCalls=new Map();
 const reject=code=>{failure??=code;return false;};
 function text(value){
  if(typeof value!=="string"||!value.trim())fail("EMPTY_RESULT");
  if(value.length>bound.evidence)fail("RESULT_TOO_LARGE");
  return value;
 }
 function bindSession(value){
  if(!id(value))fail("MALFORMED_SESSION");
  if(expectedSessionId&&value!==expectedSessionId||session&&value!==session)fail("SESSION_MISMATCH");
  session=value;
 }
 function observeModel(value){
  if(!id(value))fail("MALFORMED_MODEL");
  if(expectedModel&&value!==expectedModel)fail("MODEL_MISMATCH");
  model=value;
 }
 function finishTurn(status,evidence,usage=null){
  if(terminal)fail("DUPLICATE_TERMINAL");
  if(!started)fail("TERMINAL_WITHOUT_START");
  terminal={status,evidence,usage};
 }
 function claude(event){
  // Child messages cannot impersonate the root turn or its terminal outcome.
  if(event.parent_tool_use_id!==undefined&&event.parent_tool_use_id!==null){
   if(allowedTools)fail("UNEXPECTED_CHILD_OUTPUT");
   if(event.type==="result")fail("UNEXPECTED_CHILD_TERMINAL");
   return;
  }
  if(event.session_id!==undefined)bindSession(event.session_id);
  if(event.type==="system"&&event.subtype==="init"){
   if(started)fail("DUPLICATE_START");bindSession(event.session_id);observeModel(event.model);
   if(allowedTools&&(!Array.isArray(event.tools)||event.tools.length!==allowedTools.size||new Set(event.tools).size!==allowedTools.size||event.tools.some(t=>!allowedTools.has(t))))fail("TOOL_SCOPE_MISMATCH");
   if(expectedMcpServer&&(!Array.isArray(event.mcp_servers)||event.mcp_servers.length!==1||event.mcp_servers[0]?.name!==expectedMcpServer||event.mcp_servers[0]?.status!=="connected"))fail("MCP_NOT_CONNECTED");
   started=true;
  }else if(event.type==="assistant"){
   if(terminal)fail("OUTPUT_AFTER_TERMINAL");
   if(event.message?.model!==undefined)observeModel(event.message.model);
   if(allowedTools){
    if(!started||!Array.isArray(event.message?.content))fail("MALFORMED_ASSISTANT");
    for(const part of event.message.content)if(part?.type==="tool_use"&&!allowedTools.has(part.name))fail("UNAUTHORIZED_TOOL");
   }
  }else if(event.type==="result"){
   bindSession(event.session_id);
   if(typeof event.is_error!=="boolean"||typeof event.subtype!=="string")fail("MALFORMED_TERMINAL");
   const usage=usageFrom(event.usage),ok=event.subtype==="success"&&!event.is_error;
   finishTurn(ok?"success":"failed",ok?text(event.result):"Claude reported an unsuccessful turn.",usage);
  }
 }
 function codex(event){
  if(event.type==="thread.started"){
   if(session)fail("DUPLICATE_START");bindSession(event.thread_id);
  }else if(event.type==="turn.started"){
   if(!session||started||terminal)fail("DUPLICATE_START");started=true;
  }else if(event.type==="item.completed"&&event.item?.type==="agent_message"){
   if(!started||terminal)fail("OUTPUT_OUTSIDE_TURN");lastText=text(event.item.text);
  }else if(event.type==="turn.completed"){
   finishTurn("success",text(lastText),usageFrom(event.usage));
  }else if(event.type==="turn.failed"){
   finishTurn("failed","Codex reported a failed turn.");
  }else if(event.type==="error"){
   fail("PROVIDER_ERROR");
  }
 }
 function zcodeHeadless(event){
  if(summarySeen)fail("OUTPUT_AFTER_SUMMARY");
  bindSession(event.sessionId);
  if(event.type==="result"){
   if(!terminal||!started)fail("SUMMARY_WITHOUT_TERMINAL");
   if(event.turnId!==turn)fail("TURN_MISMATCH");
   if(event.traceId!==trace)fail("TRACE_MISMATCH");
   if(event.response!==terminalResponse||event.turnResponses!==undefined)fail("SUMMARY_MISMATCH");
   if(!count(event.eventCount)||!object(event.projection)||!id(event.projection.status)||!count(event.projection.turnCount)||!count(event.projection.totalTokenCount))fail("MALFORMED_SUMMARY");
   // eventCount is the returned turn's event count, not all observer callbacks.
   // Projection status and untyped usage do not override resultType.
   summarySeen=true;return;
  }
  if(!id(event.eventId)||!count(event.seq)||!id(event.traceId)||!count(event.timestamp)||!object(event.payload))fail("MALFORMED_EVENT");
  if(lastSeq!==null&&event.seq!==lastSeq+1)fail("EVENT_SEQUENCE_GAP");
  if(seenEvents.has(event.eventId))fail("EVENT_ID_REUSED");seenEvents.add(event.eventId);lastSeq=event.seq;
  if(!["session.created","session.updated","session.titleUpdated","session.closed","turn.started","turn.completed","turn.failed","message.upserted","model.streaming","tool.updated","permission.requested","permission.resolved","checkpoint.created","streamRecovery.updated"].includes(event.type))fail("UNSUPPORTED_SESSION_EVENT");
  const p=event.payload;
  // The installed CLI emits a local title update for this turn before its start.
  // It may bind identity, but can never substitute for the prompt or a model call.
  if(!started&&event.type==="session.titleUpdated"){
   if(event.turnId!==undefined){
    if(!id(event.turnId)||openingTurn&&event.turnId!==openingTurn)fail("TURN_MISMATCH");
    if(openingTrace&&event.traceId!==openingTrace)fail("TRACE_MISMATCH");
    openingTurn=event.turnId;openingTrace=event.traceId;
   }
   return;
  }
  if(event.type==="turn.started"){
   if(openingTurn&&event.turnId!==openingTurn)fail("TURN_MISMATCH");
   if(openingTrace&&event.traceId!==openingTrace)fail("TRACE_MISMATCH");
   if(started||terminal||!id(event.turnId))fail("DUPLICATE_START");
   if(p.executionKind!==undefined&&p.executionKind!=="agent")fail("CONTROL_ONLY_TURN");
   if(p.inputVisibility==="model-only"||p.backgroundSource!==undefined||p.workflowLaunch!==undefined||p.automationId!==undefined||p.offPeakTaskId!==undefined||p.attachments?.length)fail("UNEXPECTED_CHILD_OUTPUT");
   if(typeof p.input!=="string"||createHash("sha256").update(p.input).digest("hex")!==expectedPromptSha256)fail("INPUT_MISMATCH");
   turn=event.turnId;trace=event.traceId;started=true;return;
  }
  if(event.type==="turn.failed"&&!started)fail("PROVIDER_STARTUP_FAILED");
  if(event.turnId!==undefined&&(!started||event.turnId!==turn))fail("TURN_MISMATCH");
  if(event.turnId!==undefined&&event.traceId!==trace)fail("TRACE_MISMATCH");
  const request=event.type==="session.updated"&&(p.providerId!==undefined||p.modelId!==undefined);
  if(request){
   if(!started||terminal||event.turnId!==turn)fail("OUTPUT_OUTSIDE_TURN");
   if(p.providerId!==expectedProvider)fail("PROVIDER_MISMATCH");
   observeModel(p.modelId);
   if(count(p.messageCount)&&count(p.toolCount)&&count(p.iteration)){
    if(allowedTools&&p.toolCount!==allowedTools.size)fail("TOOL_SCOPE_MISMATCH");
    modelRequestSeen=true;
   }
  }
  if(["model.streaming","tool.updated","permission.requested","permission.resolved","message.upserted"].includes(event.type)&&(!started||terminal||event.turnId!==turn))fail("OUTPUT_OUTSIDE_TURN");
  if(allowedTools&&event.type==="tool.updated"){
   if(!["scheduled","started","progress","result","error","batch"].includes(p.kind))fail("MALFORMED_TOOL_EVENT");
   if(p.kind==="scheduled"){
    if(!id(p.toolCallId)||toolCalls.has(p.toolCallId))fail("MALFORMED_TOOL_EVENT");
    if(!allowedTools.has(p.toolName))fail("UNAUTHORIZED_TOOL");
    toolCalls.set(p.toolCallId,p.toolName);
   }else if(p.kind==="batch"){
    if(!Array.isArray(p.toolCallIds)||p.toolCallIds.some(t=>!toolCalls.has(t)))fail("MALFORMED_TOOL_EVENT");
   }else if(!toolCalls.has(p.toolCallId)||p.toolName!==undefined&&p.toolName!==toolCalls.get(p.toolCallId))fail("UNAUTHORIZED_TOOL");
  }
  if(["turn.completed","turn.failed"].includes(event.type)){
   if(!started||event.turnId!==turn)fail("TURN_MISMATCH");
   if(event.type==="turn.failed"){finishTurn("failed","Zcode reported a failed turn.");return;}
   if(!["success","cancelled","error_max_turns","error_max_budget","error_during_execution","error_max_tool_calls"].includes(p.resultType)||typeof p.response!=="string")fail("MALFORMED_TERMINAL");
   if(p.resultType==="success"&&!modelRequestSeen)fail("MODEL_NOT_OBSERVED");
   terminalResponse=p.response;
   const status=p.resultType==="success"?"success":p.resultType==="cancelled"?"cancelled":"failed";
   finishTurn(status,status==="success"?text(p.response):"Zcode reported "+p.resultType+".");
  }
 }
 function zcode(event){
  if(headless)return zcodeHeadless(event);
  bindSession(event.sessionId);
  if(!id(event.eventId)||!count(event.seq))fail("MALFORMED_EVENT");
  const eventHash=createHash("sha256").update(JSON.stringify(event)).digest("hex");
  if(lastSeq!==null&&event.seq===lastSeq&&event.eventId===lastEvent&&eventHash===lastEventHash)return;
  if(lastSeq!==null&&event.seq!==lastSeq+1)fail("EVENT_SEQUENCE_GAP");
  if(seenEvents.has(event.eventId))fail("EVENT_ID_REUSED");seenEvents.add(event.eventId);
  lastSeq=event.seq;lastEvent=event.eventId;lastEventHash=eventHash;
  if(event.type==="turn.started"){
   if(started||terminal||!id(event.turnId))fail("DUPLICATE_START");
   if(event.payload?.inputId!==expectedInputId)fail("INPUT_MISMATCH");
   if(event.payload?.executionKind==="controlOnly")fail("CONTROL_ONLY_TURN");
   turn=event.turnId;started=true;
  }else if(["turn.completed","turn.failed"].includes(event.type)){
   if(!started||event.turnId!==turn)fail("TURN_MISMATCH");
   if(event.payload?.inputId!==expectedInputId)fail("INPUT_MISMATCH");
   if(event.type==="turn.failed"){finishTurn("failed","Zcode reported a failed turn.");return;}
   const p=event.payload;
   if(!object(p)||!["success","cancelled","error_max_turns","error_max_budget","error_during_execution","error_max_tool_calls"].includes(p.resultType))fail("MALFORMED_TERMINAL");
   // The installed protocol declares usage as unknown; do not invent a mapping.
   const status=p.resultType==="success"?"success":p.resultType==="cancelled"?"cancelled":"failed";
   finishTurn(status,status==="success"?text(p.response):"Zcode reported "+p.resultType+".");
  }
 }
 function accept(event){
  if(failure)return false;
  try{
   if(!object(event)||!id(event.type))fail("MALFORMED_EVENT");
   if(++events>bound.events)fail("EVENT_LIMIT");
   ({claude,codex,zcode})[runtime](event);return true;
  }catch(e){return reject(e instanceof OutputError?e.code:"MALFORMED_EVENT");}
 }
 function line(buffer){
  if(failure)return;
  try{
   const value=utf8.decode(buffer);
   if(!value.trim())return;
   let event;try{event=JSON.parse(value);}catch{fail("INVALID_JSON");}
   accept(event);
  }catch(e){reject(e instanceof OutputError?e.code:"INVALID_UTF8");}
 }
 function push(buffer){
  if(closed)fail("DECODER_CLOSED");
  if(!Buffer.isBuffer(buffer)&&!(buffer instanceof Uint8Array))fail("BAD_CHUNK");
  if(bytes+buffer.byteLength>bound.bytes){reject("OUTPUT_LIMIT");return false;}
  const b=Buffer.from(buffer);
  bytes+=b.length;hash.update(b);
  if(failure)return false;
  let offset=0;
  while(offset<b.length){
   const end=b.indexOf(10,offset),part=b.subarray(offset,end<0?b.length:end);
   if(pending+part.length>bound.line){reject("LINE_LIMIT");break;}
   chunks.push(part);pending+=part.length;
   if(end<0)break;
   line(Buffer.concat(chunks,pending));chunks=[];pending=0;offset=end+1;
   if(failure)break;
  }
  return !failure;
 }
 function finish({exitCode=null,signal=null,stopReason=null,spawnError=false}={}){
  if(cached)return structuredClone(cached);
  if(stopReason!==null&&!["timeout","cancelled","output_limit","invalid_output","heartbeat_failed","transport_error"].includes(stopReason))fail("BAD_STOP_REASON");
  if(exitCode!==null&&(!Number.isSafeInteger(exitCode)||exitCode<0)||signal!==null&&typeof signal!=="string"||typeof spawnError!=="boolean")fail("BAD_EXIT");
  closed=true;if(pending&&!failure)line(Buffer.concat(chunks,pending));chunks=[];pending=0;
  let code=failure,status="failed",evidence,usage=terminal?.usage??null;
  if(stopReason==="timeout"||stopReason==="cancelled"){status=stopReason;code=stopReason.toUpperCase();}
  else if(stopReason)code=stopReason.toUpperCase();
  else if(spawnError)code="SPAWN_FAILED";
  else if(signal||exitCode!==0)code="PROCESS_FAILED";
  else if(!code&&!terminal)code="MISSING_TERMINAL";
  else if(!code&&headless&&terminal.status==="success"&&!summarySeen)code="MISSING_SUMMARY";
  else if(!code){status=terminal.status;code=status==="success"?"SUCCESS":"PROVIDER_"+status.toUpperCase();}
  evidence=code==="SUCCESS"?terminal.evidence:"Executor did not complete successfully ("+code+").";
  cached={status,evidence,usage,diagnostic:code,observed:{runtime,session_id:session,turn_id:turn,model,terminal_status:terminal?.status??null,protocol_error:failure,bytes,events,stdout_sha256:hash.digest("hex")},real_model_call_confirmed:false};
  return structuredClone(cached);
 }
 return Object.freeze({push,finish,get failure(){return failure;}});
}
