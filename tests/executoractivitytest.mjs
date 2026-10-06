import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createOutputActivity,isOutputActivity} from "../core/execution/activity.mjs";
import {createStderrClassifier,isStderrDiagnostic} from "../core/execution/provider-error.mjs";
const sha=x=>createHash("sha256").update(x).digest("hex");
const classify=(chunks,options)=>{const s=createStderrClassifier(options);for(const x of chunks)s.push(Buffer.from(x));return s.finish();};

test("idle clock is monotonic while wall timestamps can move backwards",()=>{
 let mono=0,wall="2026-10-01T12:00:00.000Z";
 const a=createOutputActivity({idleTimeoutMs:200,monotonic:()=>mono,wall:()=>wall});a.start();
 mono=150;a.output("stdout",20,1);assert.equal(a.expired(),false);
 mono=340;wall="2026-09-01T00:00:00.000Z";a.output("stderr",5);
 assert.equal(a.expired(),false);assert.equal(a.snapshot().idle_ms,190);
 mono=350;assert.equal(a.expired(),true);a.markIdle();
 const s=a.snapshot();assert.equal(s.idle_timeout_observed_ms,200);assert.equal(s.last_output_at,wall);assert.ok(isOutputActivity(s));
 mono=351;a.output("stdout",10,2);assert.equal(a.snapshot().idle_ms,0);assert.equal(a.snapshot().idle_timeout_observed_ms,200);
 assert.ok(isOutputActivity(a.snapshot()));
});
test("activity reports no start until the host proves one and rejects malformed persisted metrics",()=>{
 const a=createOutputActivity(),s=a.snapshot();assert.equal(s.started_at,null);assert.equal(s.idle_timeout_ms,null);assert.equal(a.expired(),false);assert.ok(isOutputActivity(s));
 for(const patch of [{raw:"private"},{events:-1},{idle_ms:1},{last_output_at:"bad"},{idle_timeout_ms:0},{idle_timeout_observed_ms:1}])
  assert.equal(isOutputActivity({...s,...patch}),false);
});
test("bounded stderr classifier survives chunk and UTF-8 boundaries without retaining prose",()=>{
 const message="私有 fixture-secret",line=JSON.stringify({error:{type:"authentication_error",message}})+"\n",bytes=Buffer.from(line);
 const s=createStderrClassifier();for(const byte of bytes)s.push(Buffer.from([byte]));
 const out=s.finish();assert.deepEqual(s.finish(),out);assert.ok(isStderrDiagnostic(out));
 assert.equal(out.provider_error.category,"authentication");assert.equal(out.provider_error.message_sha256,sha(message));
 assert.equal(out.provider_error.message_bytes,Buffer.byteLength(message));assert.equal(out.scanned_bytes,bytes.length);
 assert.equal(JSON.stringify(out).includes("fixture-secret"),false);
});
test("known plain wording and JSON error codes are advisory categories only",()=>{
 for(const [input,category] of [
  ["Your authentication token has expired. Please try signing in again.","authentication"],
  [JSON.stringify({code:"insufficient_quota",message:"fixture-private",status:429}),"quota"],
  [JSON.stringify({error:{code:"rate_limit_exceeded",message:"fixture-private"}}),"rate_limit"],
  [JSON.stringify({error:{type:"server_error"}}),"provider_internal"],
  [JSON.stringify({error:{code:"unknown-private-code",message:"fixture-private"}}),"unclassified"],
  ["arbitrary fixture-private file path","unclassified"],
  ['{"error":null}',"unclassified"]
 ]){
  const out=classify([input]);assert.equal(out.provider_error.category,category);assert.ok(isStderrDiagnostic(out));
  assert.equal(JSON.stringify(out).includes("fixture-private"),false);
 }
});
test("oversized and truncated stderr lines cannot impersonate a complete known error",()=>{
 const known=JSON.stringify({code:"invalid_api_key",message:"fixture-private"});
 let out=classify(["x".repeat(4097),known,"\n"]);assert.equal(out.provider_error.category,"unclassified");assert.equal(out.discarded_lines,1);assert.equal(out.truncated,true);
 out=classify(["x".repeat(4097),"\n",known,"\n"]);assert.equal(out.provider_error.category,"authentication");assert.ok(isStderrDiagnostic(out));
 out=classify([known+"suffix".repeat(100)],{limit:Buffer.byteLength(known)});assert.equal(out.provider_error.category,"unclassified");assert.equal(out.truncated,true);
 out=classify([Buffer.from([0xff,10]),known,"\n"]);assert.equal(out.provider_error.category,"authentication");assert.equal(out.discarded_lines,1);
 out=classify(["x".repeat(65536),"\n",known]);assert.equal(out.provider_error.category,"unclassified");assert.equal(out.scanned_bytes,65536);
 for(const patch of [{provider_error:{...out.provider_error,message:"secret"}},{scan_limit_bytes:65537},{truncated:false},{scanned_bytes:65537}])
  assert.equal(isStderrDiagnostic({...out,...patch}),false);
});
