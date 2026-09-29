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
export function createOutputDecoder(runtime,{expectedSessionId=null,expectedInputId=null,expectedModel=null,limits={}}={}){
 if(!["claude","codex","zcode"].includes(runtime))fail("BAD_RUNTIME");
 if([expectedSessionId,expectedInputId,expectedModel].some(x=>x!==null&&!id(x)))fail("BAD_BINDING");
 if(runtime==="zcode"&&(!expectedSessionId||!expectedInputId))fail("BAD_BINDING");
 const seenEvents=new Set();
 const bound=limitsFor(limits),hash=createHash("sha256"),utf8=new TextDecoder("utf-8",{fatal:true});
 let chunks=[],pending=0,bytes=0,events=0,closed=false,failure=null,cached=null;
 let session=null,turn=null,model=null,started=false,terminal=null,lastText="",lastSeq=null,lastEvent=null,lastEventHash=null;
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
   if(event.type==="result")fail("UNEXPECTED_CHILD_TERMINAL");
   return;
  }
  if(event.session_id!==undefined)bindSession(event.session_id);
  if(event.type==="system"&&event.subtype==="init"){
   if(started)fail("DUPLICATE_START");bindSession(event.session_id);observeModel(event.model);started=true;
  }else if(event.type==="assistant"){
   if(terminal)fail("OUTPUT_AFTER_TERMINAL");
   if(event.message?.model!==undefined)observeModel(event.message.model);
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
 function zcode(event){
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
  else if(!code){status=terminal.status;code=status==="success"?"SUCCESS":"PROVIDER_"+status.toUpperCase();}
  evidence=code==="SUCCESS"?terminal.evidence:"Executor did not complete successfully ("+code+").";
  cached={status,evidence,usage,diagnostic:code,observed:{runtime,session_id:session,turn_id:turn,model,terminal_status:terminal?.status??null,protocol_error:failure,bytes,events,stdout_sha256:hash.digest("hex")},real_model_call_confirmed:false};
  return structuredClone(cached);
 }
 return Object.freeze({push,finish,get failure(){return failure;}});
}
