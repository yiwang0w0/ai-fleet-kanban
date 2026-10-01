import {isAbsolute} from "node:path";
import {createOutputDecoder,OutputError} from "./output.mjs";
import {createCommandOutput} from "./command-output.mjs";

const fail=code=>{throw new OutputError(code);};
const record=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const FAILURE_CODES=new Set([
 "ABSOLUTE_PATH_REQUIRED","FILE_REQUIRED","BAD_PIN","PIN_CHANGED","WINDOWS_REQUIRED",
 "PROVIDER_ISOLATION_UNSUPPORTED","BAD_ISOLATION","BAD_ARGS","BAD_CWD","BAD_ENV","BAD_INPUT",
 "BAD_TIMEOUT","BAD_HEARTBEAT","BAD_LIMITS","BAD_PINS","BAD_SIGNAL","REQUEST_LIMIT",
 "BAD_RUNTIME","BAD_BINDING","BAD_TRANSPORT","UNSUPPORTED_BINDING","BAD_TOOL_BINDING",
 "UNSUPPORTED_TOOL_BINDING"
]);
/** Only these local, typed prelaunch diagnostics may survive an uncertain catch. */
export const isLaunchFailureCode=code=>typeof code==="string"&&FAILURE_CODES.has(code);
export const launchFailureCode=error=>error instanceof OutputError&&isLaunchFailureCode(error.code)?error.code:"SUPERVISOR_ERROR";

export function commandIsolation(value){
 if(value===null)return null;
 if(!record(value)||Object.keys(value).sort().join(",")!=="kind,memory_limit_bytes,network,process_limit"||value.kind!=="windows-appcontainer"||value.network!=="none"||!Number.isSafeInteger(value.memory_limit_bytes)||value.memory_limit_bytes<67108864||value.memory_limit_bytes>2147483648||!Number.isInteger(value.process_limit)||value.process_limit<1||value.process_limit>64)fail("BAD_ISOLATION");
 return {...value};
}
function pinShape(pin){
 if(!record(pin)||typeof pin.path!=="string"||!isAbsolute(pin.path)||typeof pin.sha256!=="string"||!/^[a-f0-9]{64}$/.test(pin.sha256))fail("BAD_PIN");
 return {path:pin.path,sha256:pin.sha256};
}

/**
 * Pure, bounded construction of the actual host input. No files, DB, process,
 * clock, quota or permit are touched. This is a preflight, never launch authority.
 * The supervisor repeats it after independently rechecking all filesystem pins.
 */
export function buildLaunchRequest({python,command,args,cwd,env,input,pins,runtime,decoder={},commandOutput=false,stdoutLimit=65536,
 timeoutMs=60000,isolation=null,signal=null,heartbeat=null,heartbeatMs=10000,stderrLimit=1048576}){
 isolation=commandIsolation(isolation);if(isolation&&!commandOutput)fail("PROVIDER_ISOLATION_UNSUPPORTED");
 pinShape(python);const exe=pinShape(command);
 if(!Array.isArray(args)||args.length>200||args.some(x=>typeof x!=="string"||x.includes("\0")))fail("BAD_ARGS");
 if(typeof cwd!=="string"||!isAbsolute(cwd)||cwd.includes("\0"))fail("BAD_CWD");
 if(!record(env)||Object.entries(env).some(([k,v])=>!k||/[=\0]/.test(k)||typeof v!=="string"||v.includes("\0")))fail("BAD_ENV");
 if(typeof input!=="string"||Buffer.byteLength(input)>131072)fail("BAD_INPUT");
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>86400000)fail("BAD_TIMEOUT");
 if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<50||heartbeatMs>60000||heartbeat!==null&&typeof heartbeat!=="function")fail("BAD_HEARTBEAT");
 if(!Number.isSafeInteger(stderrLimit)||stderrLimit<1||stderrLimit>1048576)fail("BAD_LIMITS");
 if(signal!==null&&!(signal instanceof AbortSignal))fail("BAD_SIGNAL");
 if(!Array.isArray(pins)||pins.length>15)fail("BAD_PINS");
 const checkedPins=[exe,...pins.map(pinShape)];
 if(commandOutput)createCommandOutput({stdoutLimit,stderrLimit});
 else{if(!record(decoder))fail("BAD_BINDING");createOutputDecoder(runtime,decoder);}
 const request={command:exe.path,args,cwd,env,input,pins:checkedPins,timeout_ms:timeoutMs,...(isolation?{isolation}:{})};
 const bytes=Buffer.from(JSON.stringify(request)+"\n");
 if(bytes.length>524288)fail("REQUEST_LIMIT");
 return bytes;
}
