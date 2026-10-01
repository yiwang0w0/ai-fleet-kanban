import test from "node:test";
import assert from "node:assert/strict";
import {join,resolve} from "node:path";
import {buildLaunchRequest,launchFailureCode} from "../core/execution/launch-request.mjs";
import {OutputError} from "../core/execution/output.mjs";
import {processObservation} from "../core/execution/receipts.mjs";
const path=resolve("nonexistent-pure-construction-fixture"),pin={path:join(path,"program.exe"),sha256:"a".repeat(64)};
const options={python:pin,command:pin,args:["literal","中文"],cwd:path,env:{PATH:"fixture"},input:"中文\r\n",pins:[],runtime:"claude",timeoutMs:1000};

test("pure request construction uses exact UTF-8 NDJSON without filesystem or caller mutations",()=>{
 const before=structuredClone(options),first=buildLaunchRequest(options),second=buildLaunchRequest(options);
 assert.deepEqual(first,second);assert.deepEqual(options,before);
 const request=JSON.parse(first.toString("utf8"));
 assert.deepEqual(request,{command:pin.path,args:options.args,cwd:path,env:options.env,input:options.input,pins:[pin],timeout_ms:1000});
 assert.equal(first.at(-1),10);first.fill(0);assert.deepEqual(buildLaunchRequest(options),second);
});
test("serialized request bound includes environment, argv, escaping, UTF-8 and newline",()=>{
 const exact={...options,env:{PAD:""}},size=buildLaunchRequest(exact).length;
 exact.env.PAD="x".repeat(524288-size);
 assert.equal(buildLaunchRequest(exact).length,524288);
 assert.throws(()=>buildLaunchRequest({...exact,env:{PAD:exact.env.PAD+"x"}}),{code:"REQUEST_LIMIT"});
 assert.throws(()=>buildLaunchRequest({...options,input:"x"+"\u0001".repeat(100000)}),{code:"REQUEST_LIMIT"});
 assert.throws(()=>buildLaunchRequest({...options,args:["\u0001".repeat(100000)]}),{code:"REQUEST_LIMIT"});
 assert.throws(()=>buildLaunchRequest({...options,env:{PAD:"中".repeat(175000)}}),{code:"REQUEST_LIMIT"});
});
test("pure preflight rejects invalid decoder and control configuration",()=>{
 for(const [extra,code] of [
  [{heartbeatMs:0},"BAD_HEARTBEAT"],[{heartbeat:"unsafe"},"BAD_HEARTBEAT"],[{stderrLimit:0},"BAD_LIMITS"],
  [{timeoutMs:1},"BAD_TIMEOUT"],[{idleTimeoutMs:0},"BAD_IDLE_TIMEOUT"],[{idleTimeoutMs:86400001},"BAD_IDLE_TIMEOUT"],[{signal:{aborted:false}},"BAD_SIGNAL"],
  [{runtime:"other"},"BAD_RUNTIME"],[{decoder:{limits:{line:0}}},"BAD_LIMITS"],
  [{decoder:null},"BAD_BINDING"],[{cwd:undefined},"BAD_CWD"],[{pins:null},"BAD_PINS"],
  [{env:{BAD:"\0"}},"BAD_ENV"],[{args:["\0"]},"BAD_ARGS"],
  [{python:{...pin,sha256:"bad"}},"BAD_PIN"],[{input:"x".repeat(131073)},"BAD_INPUT"]
 ])assert.throws(()=>buildLaunchRequest({...options,...extra}),{code});
});
test("only typed allowlisted launch failures may be persisted as diagnostics",()=>{
 assert.equal(launchFailureCode(new OutputError("PIN_CHANGED")),"PIN_CHANGED");
 assert.equal(launchFailureCode(new OutputError("REQUEST_LIMIT")),"REQUEST_LIMIT");
 for(const e of [new Error("private path"),{code:"PIN_CHANGED"},new OutputError("PRIVATE_CUSTOM_CODE"),new OutputError("SUCCESS")])
  assert.equal(launchFailureCode(e),"SUPERVISOR_ERROR");
});
test("unknown observations accept typed failures without inventing process-stop proof",()=>{
 const value={status:"failed",evidence:"Executor supervisor did not return a complete observation.",usage:null,diagnostic:"PIN_CHANGED",
  observed:null,real_model_call_confirmed:false,process:{started:null,cleanup:"unconfirmed",containment:null}};
 const args={result:{status:value.status,evidence:value.evidence,usage:null},launch:{}};
 assert.deepEqual(processObservation(value,args),value);
 for(const diagnostic of ["SUCCESS","PRIVATE_CUSTOM_CODE","PROVIDER_FAILED"])
  assert.throws(()=>processObservation({...value,diagnostic},args));
 assert.throws(()=>processObservation({...value,process:{started:null,cleanup:"job_empty",containment:"windows-job"}},args));
});
