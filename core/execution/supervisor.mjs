import {createOutputActivity} from "./activity.mjs";
import {createStderrClassifier} from "./provider-error.mjs";
import {buildLaunchRequest,commandIsolation} from "./launch-request.mjs";
export {buildLaunchRequest,commandIsolation} from "./launch-request.mjs";
import {createCommandOutput} from "./command-output.mjs";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {createOutputDecoder,OutputError} from "./output.mjs";

const HOST=fileURLToPath(new URL("./process_host.py",import.meta.url));
const fail=code=>{throw new OutputError(code);};
export function pinFile(path){
 if(typeof path!=="string"||!isAbsolute(path))fail("ABSOLUTE_PATH_REQUIRED");
 const real=realpathSync(path);
 if(!statSync(real).isFile())fail("FILE_REQUIRED");
 return {path:real,sha256:createHash("sha256").update(readFileSync(real)).digest("hex")};
}
function verifyPin(pin){
 if(!pin||typeof pin.sha256!=="string"||!/^[a-f0-9]{64}$/.test(pin.sha256))fail("BAD_PIN");
 const now=pinFile(pin.path);if(now.sha256!==pin.sha256)fail("PIN_CHANGED");return now;
}

/**
 * Trusted host primitive only: no queue, shell, resume, provider fallback or
 * permission elevation. Does not itself authorize models or isolate files.
 * The caller must commit a fresh dispatch permit before calling this function.
 */
export async function superviseProcess(options){
 if(options.isolation!=null)fail("PROVIDER_ISOLATION_UNSUPPORTED");
 if(process.platform!=="win32")fail("WINDOWS_REQUIRED");
 return supervise({...options,commandOutput:false});
}
/** Trusted local verification primitive: ordinary commands, never a provider dispatch. */
export async function superviseCommand(options){
 if(process.platform!=="win32")fail("WINDOWS_REQUIRED");
 return supervise({input:"",pins:[],stderrLimit:65536,...options,commandOutput:true});
}
export function sandboxObservation(value,isolation,{finished=true}={}){
 return !!value&&value.kind==="windows-appcontainer"&&value.network==="none"&&value.capability_count===0&&value.token_verified===true&&typeof value.profile_name==="string"&&/^ai-fleet-check-[0-9a-f-]{36}$/.test(value.profile_name)&&value.memory_limit_bytes===isolation?.memory_limit_bytes&&value.process_limit===isolation?.process_limit&&(!finished||value.profile_removed===true&&value.staging_removed===true);
}
async function supervise({python,command,args,cwd,env,input,pins,runtime,decoder={},commandOutput=false,stdoutLimit=65536,timeoutMs=60000,idleTimeoutMs=null,isolation=null,
 signal=null,heartbeat=null,heartbeatMs=10000,stderrLimit=1024*1024}){
 isolation=commandIsolation(isolation);if(isolation&&!commandOutput)fail("PROVIDER_ISOLATION_UNSUPPORTED");
 const options={python,command,args,cwd,env,input,pins,runtime,decoder,commandOutput,stdoutLimit,timeoutMs,idleTimeoutMs,isolation,signal,heartbeat,heartbeatMs,stderrLimit};
 buildLaunchRequest(options);
 const py=verifyPin(python),exe=verifyPin(command);
 if(!statSync(cwd).isDirectory())fail("BAD_CWD");
 const checkedPins=pins.map(verifyPin),hostPin=pinFile(HOST);
 const requestBytes=buildLaunchRequest({...options,python:py,command:exe,cwd:realpathSync(cwd),pins:checkedPins});
 const output=commandOutput?createCommandOutput({stdoutLimit,stderrLimit}):createOutputDecoder(runtime,decoder);
 const activity=commandOutput?null:createOutputActivity({idleTimeoutMs}),stderrClassifier=commandOutput?null:createStderrClassifier({limit:Math.min(stderrLimit,65536)});
 if(signal?.aborted)return {...output.finish({stopReason:"cancelled"}),process:{started:false,cleanup:"not_started",containment:null}};
 // No shell is used for either the host or the provider process.
 const host=spawn(py.path,["-I","-S","-B",HOST],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp",...(isolation?["userprofile","localappdata","appdata","homedrive","homepath"]:[])].includes(k.toLowerCase())))});
 let started=false,ended=false,settled=false,done=null,fatal=null,stopReason=null,buffer=Buffer.alloc(0),stderrBytes=0,stderrHashedBytes=0,stderrHash=createHash("sha256"),hostErrors=0,beating=false,stopTimer=null;
 const processInfo={started:false,pid:null,containment:null,cleanup:"unconfirmed",host_sha256:hostPin.sha256,executable_sha256:exe.sha256,python_sha256:py.sha256};
 const stop=reason=>{
  if(done||settled)return;
  stopReason??=reason;
  stopTimer??=setTimeout(()=>{fatal??="HOST_UNRESPONSIVE";host.kill();},10000);
  if(!host.stdin.destroyed)host.stdin.write('{"op":"cancel"}\n',()=>{});
 };
 const abort=()=>stop("cancelled");
 signal?.addEventListener("abort",abort,{once:true});
 host.stdin.on("error",()=>{if(!done){fatal??="HOST_INPUT_FAILED";stopReason??="transport_error";}});
 host.on("error",()=>{fatal??="HOST_START_FAILED";});
 host.stderr.on("data",b=>{hostErrors+=b.length;if(hostErrors>65536){fatal??="HOST_DIAGNOSTIC_LIMIT";stop("transport_error");}});
 function event(e){
  if(!e||typeof e!=="object"||Array.isArray(e))throw Error();
  if(ended)throw Error();
  if(e.kind==="started"){
   if(started||!Number.isSafeInteger(e.pid)||e.pid<1||!["windows-job","posix-process-group"].includes(e.containment))throw Error();
   if(isolation&&!sandboxObservation(e.sandbox,isolation,{finished:false})||!isolation&&e.sandbox)throw Error();
   if(isolation)processInfo.sandbox=e.sandbox;
   started=true;activity?.start();Object.assign(processInfo,{started:true,pid:e.pid,containment:e.containment});
  }else if(e.kind==="stdout"||e.kind==="stderr"){
   if(!started||typeof e.data!=="string"||e.data.length>21848||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data))throw Error();
   const b=Buffer.from(e.data,"base64");
   if(e.kind==="stdout"){
    const accepted=output.push(b);activity?.output("stdout",b.length,output.activity?.events??0,accepted);
    if(!accepted)stop(["OUTPUT_LIMIT","LINE_LIMIT","EVENT_LIMIT","RESULT_TOO_LARGE"].includes(output.failure)?"output_limit":"invalid_output");
   }
   else{
    stderrBytes+=b.length;activity?.output("stderr",b.length);stderrClassifier?.push(b);
    const keep=Math.min(b.length,Math.max(0,stderrLimit-stderrHashedBytes));
    if(keep){stderrHash.update(b.subarray(0,keep));stderrHashedBytes+=keep;}
    if(stderrBytes>stderrLimit)stop("output_limit");
    if(commandOutput&&!output.pushError(b))stop("output_limit");
   }
  }else if(e.kind==="done"){
   if(!started||e.exit_code!==null&&(!Number.isSafeInteger(e.exit_code)||e.exit_code< -128)||
    ![null,"cancelled","timeout","parent_disconnected"].includes(e.stop_reason)||!["job_empty","group_signalled","unconfirmed"].includes(e.cleanup))throw Error();
   if(isolation&&!sandboxObservation(e.sandbox,isolation,{finished:false})||!isolation&&e.sandbox)throw Error();
   if(isolation){processInfo.sandbox=e.sandbox;if(!sandboxObservation(e.sandbox,isolation))stopReason??="transport_error";}
   done=e;ended=true;processInfo.cleanup=e.cleanup;
   if(!stopReason&&e.stop_reason)stopReason=e.stop_reason==="parent_disconnected"?"transport_error":e.stop_reason;
   host.stdin.end();
  }else if(e.kind==="host_error"){
   fatal??="PROCESS_HOST_FAILED";stop("transport_error");
  }else throw Error();
 }
 host.stdout.on("data",b=>{
  if(fatal)return;
  // Host frames contain at most one 16 KiB provider chunk, encoded as base64.
  buffer=Buffer.concat([buffer,b]);
  while(true){
   const i=buffer.indexOf(10);
   if(i<0){if(buffer.length>32768){fatal="HOST_FRAME_LIMIT";stop("transport_error");}break;}
   if(i>32768){fatal="HOST_FRAME_LIMIT";stop("transport_error");break;}
   try{event(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,i))));}
   catch{fatal="HOST_PROTOCOL_FAILED";stop("transport_error");break;}
   buffer=buffer.subarray(i+1);
  }
 });
 const checkIdle=()=>{
  if(done||fatal||stopReason||!activity?.expired())return false;
  activity.markIdle();stop("idle_timeout");return true;
 };
 const idleClock=idleTimeoutMs===null?null:setInterval(checkIdle,Math.min(1000,idleTimeoutMs));
 const clock=setTimeout(()=>stop("timeout"),timeoutMs);
 const hardStop=setTimeout(()=>{fatal??="HOST_UNRESPONSIVE";stopReason??="transport_error";host.kill();},timeoutMs+10000);
 const beat=heartbeat===null?null:setInterval(async()=>{
  if(beating||done||fatal||stopReason||checkIdle())return;
  beating=true;
  try{if(await heartbeat(activity?.snapshot())===false)stop("heartbeat_failed");}
  catch{stop("heartbeat_failed");}
  finally{beating=false;}
 },heartbeatMs);
 const closed=new Promise(resolve=>host.once("close",(code,signal)=>resolve({code,signal})));
 host.stdin.write(requestBytes,()=>{});
 const exit=await closed;settled=true;
 clearTimeout(clock);clearTimeout(hardStop);if(idleClock)clearInterval(idleClock);if(beat)clearInterval(beat);if(stopTimer)clearTimeout(stopTimer);signal?.removeEventListener("abort",abort);
 if(fatal||!done||buffer.length||exit.code!==0||exit.signal||done?.cleanup==="unconfirmed")stopReason??="transport_error";
 const providerCode=done?.exit_code??null;
 const result=output.finish({exitCode:providerCode!==null&&providerCode<0?null:providerCode,signal:providerCode!==null&&providerCode<0?"POSIX_SIGNAL":null,stopReason,spawnError:!started});
 return {...result,process:{...processInfo,exit_code:providerCode,host_error:fatal,host_exit_code:exit.code,stderr_bytes:stderrBytes,stderr_hashed_bytes:stderrHashedBytes,stderr_sha256:stderrHash.digest("hex"),...(activity?{activity:activity.snapshot()}:{}),...(!commandOutput&&result.status!=="success"&&stderrBytes>0?{stderr_diagnostic:stderrClassifier.finish()}: {})}};
}
