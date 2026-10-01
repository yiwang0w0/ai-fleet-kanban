// Gateway-only failure accounting. Claimed key IDs are untrusted labels, not actors.
// Authenticate valid credentials before consulting these counters: a forged public
// key ID must never lock out its legitimate holder behind the same tailnet proxy.
import {PeerError,UUID} from "./protocol.mjs";
export const AUTH_FAILURE_LIMITS=Object.freeze({windowMs:10000,perKey:5,global:100,keys:64,rows:512,retentionMs:86400000,flushMs:5000});
const table="federation_auth_failures";
function transaction(db,work){
 if(db.isTransaction)throw new PeerError("TRANSACTION_CONTEXT","鉴权失败审计必须在请求事务之外提交",409);
 db.exec("BEGIN IMMEDIATE");try{const r=work();db.exec("COMMIT");return r;}catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
}
function prune(db,now){
 db.prepare("DELETE FROM federation_auth_failures WHERE last_at<?").run(now-AUTH_FAILURE_LIMITS.retentionMs);
 db.exec("DELETE FROM federation_auth_failures WHERE id NOT IN(SELECT id FROM federation_auth_failures ORDER BY id DESC LIMIT 512)");
}
function initialize(db,now){
 transaction(db,()=>{
  db.exec("CREATE TABLE IF NOT EXISTS federation_auth_failure_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO federation_auth_failure_schema VALUES(1,1)");
  if(db.prepare("SELECT version FROM federation_auth_failure_schema WHERE singleton=1").get().version!==1)throw new PeerError("SCHEMA_INCOMPATIBLE","鉴权失败审计格式不兼容",409);
  db.exec("CREATE TABLE IF NOT EXISTS federation_auth_failures(id INTEGER PRIMARY KEY,key_id TEXT,category TEXT NOT NULL CHECK(category IN('claimed_key','missing_or_malformed','overflow')),failures INTEGER NOT NULL,limited INTEGER NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL)");
  prune(db,now);
 });
}
function claimedKey(authorization){
 if(typeof authorization!=="string")return null;
 const m=/^Bearer ([0-9a-f-]{36})\./.exec(authorization);return m&&UUID.test(m[1])?m[1]:null;
}
/** A trusted gateway supplies time; no HTTP or CLI option can change the limits. */
export function createAuthFailureGuard(db,{now=Date.now}={}){
 initialize(db,now());
 const buckets=new Map();let overflow=null,globalStart=now(),globalCount=0,unhealthy=false,closed=false;
 const fresh=(key,category,t)=>({key_id:key,category,windowStart:t,windowCount:0,failures:0,limited:0,first_at:t,last_at:t});
 function flush(){
  const t=now(),pending=[...buckets.values(),overflow].filter(b=>b&&b.failures);
  if(!pending.length&&!unhealthy)return;
  try{transaction(db,()=>{
   const insert=db.prepare("INSERT INTO "+table+"(key_id,category,failures,limited,first_at,last_at) VALUES(?,?,?,?,?,?)");
   for(const b of pending)insert.run(b.key_id,b.category,b.failures,b.limited,b.first_at,b.last_at);
   prune(db,t);
  });}catch(e){unhealthy=true;throw e;}
  for(const b of pending){b.failures=0;b.limited=0;b.first_at=b.last_at;}
  unhealthy=false;
 }
 const timer=setInterval(()=>{try{flush();}catch{unhealthy=true;}},AUTH_FAILURE_LIMITS.flushMs);timer.unref();
 function failure(authorization){
  if(closed)throw new PeerError("INTERNAL","鉴权失败保护已关闭",503);
  const t=now(),key=claimedKey(authorization),label=key??"missing";
  // Evict only flushed, expired buckets; unflushed counters remain bounded and
  // are represented by the overflow bucket instead of silently disappearing.
  for(const [k,b]of buckets)if(!b.failures&&t-b.last_at>=AUTH_FAILURE_LIMITS.windowMs)buckets.delete(k);
  let b=buckets.get(label);
  if(!b&&buckets.size<AUTH_FAILURE_LIMITS.keys){b=fresh(key,key?"claimed_key":"missing_or_malformed",t);buckets.set(label,b);}
  if(!b){overflow??=fresh(null,"overflow",t);b=overflow;}
  if(t-globalStart>=AUTH_FAILURE_LIMITS.windowMs){globalStart=t;globalCount=0;}
  if(t-b.windowStart>=AUTH_FAILURE_LIMITS.windowMs){b.windowStart=t;b.windowCount=0;}
  globalCount=Math.min(globalCount+1,Number.MAX_SAFE_INTEGER);b.windowCount=Math.min(b.windowCount+1,Number.MAX_SAFE_INTEGER);
  const limited=b.windowCount>AUTH_FAILURE_LIMITS.perKey||globalCount>AUTH_FAILURE_LIMITS.global;
  if(!b.failures)b.first_at=t;b.last_at=t;b.failures=Math.min(b.failures+1,Number.MAX_SAFE_INTEGER);if(limited)b.limited=Math.min(b.limited+1,Number.MAX_SAFE_INTEGER);
  if(unhealthy)return {status:503,code:"AUTH_AUDIT_UNAVAILABLE",retry_after:5};
  const remaining=limited?Math.max(b.windowCount>AUTH_FAILURE_LIMITS.perKey?b.windowStart+AUTH_FAILURE_LIMITS.windowMs-t:0,globalCount>AUTH_FAILURE_LIMITS.global?globalStart+AUTH_FAILURE_LIMITS.windowMs-t:0):0;
  return {status:limited?429:401,code:limited?"AUTH_RATE_LIMITED":"UNAUTHENTICATED",retry_after:limited?Math.max(1,Math.ceil(remaining/1000)):null};
 }
 function close(){if(closed)return;closed=true;clearInterval(timer);flush();}
 return {failure,flush,close};
}
export function listAuthFailures(db,{limit=100,now=Date.now()}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>AUTH_FAILURE_LIMITS.rows)throw new PeerError("BAD_INPUT","鉴权失败查询 limit 必须为 1–512",400);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))return {failures:[],retention:AUTH_FAILURE_LIMITS};
 if(db.prepare("SELECT version FROM federation_auth_failure_schema WHERE singleton=1").get()?.version!==1)throw new PeerError("SCHEMA_INCOMPATIBLE","鉴权失败审计格式不兼容",409);
 return {failures:db.prepare("SELECT key_id,category,failures,limited,first_at,last_at FROM federation_auth_failures WHERE last_at>=? ORDER BY id DESC LIMIT ?").all(now-AUTH_FAILURE_LIMITS.retentionMs,limit),retention:AUTH_FAILURE_LIMITS};
}
