import {allowInheritedRead,inspectAcl} from "./helpers/windows-acl.mjs";
import {createAuthFailureGuard,listAuthFailures,AUTH_FAILURE_LIMITS} from "../core/federation/auth-failures.mjs";
import test, {after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import http from "node:http";
import {negotiateHello, CAPABILITIES, SCOPES} from "../core/federation/protocol.mjs";
import {openPeerDatabase, migratePeers, issueCredential, revokePeer, listPeers, authenticate, localIdentity} from "../core/federation/peers.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-peers-"));
const handles=[];let count=0;
const next=tag=>join(TMP,tag+"-"+count++);
after(()=>{for(const db of handles){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function fixture(){
 const data=next("node");mkdirSync(data);
 const dbPath=join(data,"board.db"),db=new DatabaseSync(dbPath);handles.push(db);
 db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");store.migrate(db);migratePeers(db);
 return {db,data,dbPath,node:localIdentity(db)};
}
function issue(f,overrides={}){
 const credentialFile=next("credential")+".json";
 const args={peerNodeId:randomUUID(),peerEpoch:randomUUID(),scopes:["peer:handshake","peer:health"],projects:["demo"],credentialFile,...overrides};
 const result=issueCredential(f.db,args),credential=JSON.parse(readFileSync(args.credentialFile,"utf8"));
 return {args,result,credential,token:credential.token};
}
const hello=c=>({node_id:c.peer_node_id,sync_epoch:c.peer_epoch,protocol:{min:1,max:2},required_capabilities:[...CAPABILITIES],extensions:{}});
async function running(f,work){
 const server=await listenPeerServer(f.db,{port:0});
 const base="http://127.0.0.1:"+server.address().port;
 try{return await work(base,server);}finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});}
}
async function api(base,path,token,{method="GET",body,headers={}}={}){
 const r=await fetch(base+path,{method,headers:{...(token?{Authorization:"Bearer "+token}:{}),...(body!==undefined?{"Content-Type":"application/json"}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:await r.json()};
}
test("credential is bound to an independent peer, secret is only in the exclusive file",()=>{
 const f=fixture(),a=issue(f),b=issue(f);
 assert.notEqual(a.token,b.token);assert.equal(a.credential.server_node_id,f.node.node_id);
 const p=authenticate(f.db,"Bearer "+a.token,"peer:handshake");assert.equal(p.peer_node_id,a.args.peerNodeId);
 assert.equal(p.projects[0],"demo");assert.equal(p.credential_version,1);
 assert.ok(!JSON.stringify(listPeers(f.db)).includes(a.token));
 assert.ok(!JSON.stringify(a.result).includes(a.token));
 const stored=f.db.prepare("SELECT * FROM federation_peers").all();
 assert.ok(!JSON.stringify(stored).includes(a.token));assert.match(stored[0].secret_hash,/^[0-9a-f]{64}$/);
 assert.equal(store.list(f.db).tasks.length,0);
});
test("self/clone identity, unknown scope, empty projects and malformed IDs refuse",()=>{
 const f=fixture();
 for(const override of [{peerNodeId:f.node.node_id},{peerNodeId:"hostname"},{peerEpoch:"100.1.2.3"},
  {scopes:["task:write"]},{scopes:[]},{projects:[]},{projects:["*"]}]){
  const path=next("bad")+".json";
  assert.throws(()=>issue(f,{...override,credentialFile:path}));assert.equal(existsSync(path),false);
 }
 assert.equal(listPeers(f.db).length,0);
});
test("grant refuses overwrite and transaction failure removes only its own credential file",()=>{
 const f=fixture(),file=next("existing");writeFileSync(file,"keep");
 assert.throws(()=>issue(f,{credentialFile:file}),/exist/i);
 assert.equal(readFileSync(file,"utf8"),"keep");assert.equal(listPeers(f.db).length,0);
 f.db.exec("CREATE TRIGGER refuse_auth_event BEFORE INSERT ON federation_auth_events BEGIN SELECT RAISE(ABORT,'injected'); END");
 const path=next("rollback")+".json";
 assert.throws(()=>issue(f,{credentialFile:path}),/injected/);
 assert.equal(existsSync(path),false);assert.equal(listPeers(f.db).length,0);
});
test("rotation/revocation use observed credential versions and invalidate old tokens",()=>{
 const f=fixture(),a=issue(f);
 for(const v of [undefined,0,2]){
  assert.throws(()=>issue(f,{...a.args,credentialFile:next("stale"),expectedVersion:v}));
 }
 const b=issue(f,{...a.args,credentialFile:next("rotated"),expectedVersion:1});
 assert.equal(b.result.credential_version,2);
 assert.throws(()=>authenticate(f.db,"Bearer "+a.token),{code:"UNAUTHENTICATED"});
 assert.equal(authenticate(f.db,"Bearer "+b.token).credential_version,2);
 assert.throws(()=>revokePeer(f.db,{peerNodeId:a.args.peerNodeId,expectedVersion:1}),{code:"CONFLICT"});
 const revoked=revokePeer(f.db,{peerNodeId:a.args.peerNodeId,expectedVersion:2});
 assert.equal(revoked.credential_version,3);
 assert.throws(()=>authenticate(f.db,"Bearer "+b.token),{code:"UNAUTHENTICATED"});
 const c=issue(f,{...a.args,credentialFile:next("reauthorized"),expectedVersion:3});
 assert.equal(authenticate(f.db,"Bearer "+c.token).credential_version,4);
 assert.deepEqual(f.db.prepare("SELECT action FROM federation_auth_events ORDER BY id").all().map(x=>x.action),["issue","replace","revoke","replace"]);
});
test("migration is idempotent and unsupported federation schema remains unchanged",()=>{
 const f=fixture(),a=issue(f);migratePeers(f.db);
 assert.equal(authenticate(f.db,"Bearer "+a.token).credential_version,1);
 f.db.exec("UPDATE federation_schema SET version=2");
 assert.throws(()=>migratePeers(f.db),{code:"SCHEMA_INCOMPATIBLE"});
 assert.equal(f.db.prepare("SELECT version FROM federation_schema").get().version,2);
});
test("missing, incomplete and quarantined databases cannot start peer participation",()=>{
 assert.throws(()=>openPeerDatabase(next("missing")),{code:"BAD_DATABASE"});
 const f=fixture();writeFileSync(join(f.data,".incomplete"),"interrupted");
 assert.throws(()=>openPeerDatabase(f.dbPath),{code:"RESTORE_HOLD"});
 const source=fixture(),a=issue(source),bundle=next("backup"),restored=next("restore");
 createBackup({dbPath:source.dbPath,evidenceDir:join(source.data,"evidence"),destination:bundle});
 restoreBackup({backupDirectory:bundle,destination:restored});
 assert.throws(()=>openPeerDatabase(join(restored,"board.db")),{code:"RESTORE_HOLD"});
 assert.equal(authenticate(source.db,"Bearer "+a.token).peer_node_id,a.args.peerNodeId);
});
test("negotiation selects common version and ignores only optional extension data",()=>{
 const f=fixture(),a=issue(f),peer=authenticate(f.db,"Bearer "+a.token);
 const body=hello(a.credential);body.extensions={future:{arbitrary:"data"}};
 const r=negotiateHello(body,peer,f.node);
 assert.equal(r.protocol_version,1);assert.deepEqual(r.extensions,{});assert.equal(r.node.node_id,f.node.node_id);
 assert.deepEqual(r.authorized.projects,["demo"]);
 assert.ok(!JSON.stringify(r).includes(a.token));
});
test("identity/epoch spoofing and incompatible/required extensions fail closed",()=>{
 const f=fixture(),a=issue(f),peer=authenticate(f.db,"Bearer "+a.token);
 for(const [change,code] of [
  [{node_id:randomUUID()},"IDENTITY_MISMATCH"],[{sync_epoch:randomUUID()},"IDENTITY_MISMATCH"],
  [{protocol:{min:2,max:4}},"PROTOCOL_INCOMPATIBLE"],
  [{required_capabilities:["arbitrary-shell"]},"REQUIRED_FEATURE_UNSUPPORTED"],
  [{required_extensions:["future"]},"REQUIRED_FEATURE_UNSUPPORTED"],
  [{owner_node_id:randomUUID()},"BAD_INPUT"],[{protocol:{min:1,max:2,must:7}},"BAD_INPUT"],
  [{extensions:{large:"x".repeat(2049)}},"BAD_INPUT"],
  [{required_capabilities:null},"BAD_INPUT"]]){
  assert.throws(()=>negotiateHello({...hello(a.credential),...change},peer,f.node),{code});
 }
});
test("all HTTP surfaces authenticate, and peer credentials never expose UI, tasks or files",async()=>{
 const f=fixture(),a=issue(f);
 await running(f,async base=>{
  let missingFailures=0;
  for(const path of ["/","/health","/api/meta","/api/tasks","/peer/v1/health","/peer/v1/hello","/board_token"]){
   assert.equal((await api(base,path,null)).status,++missingFailures<=AUTH_FAILURE_LIMITS.perKey?401:429);
   if(path!=="/peer/v1/health")assert.equal((await api(base,path,a.token)).status,404);
  }
  for(const token of ["operator-fixture","worker-fixture","review-fixture"])
   assert.equal((await api(base,"/peer/v1/health",token)).status,429);
  assert.equal((await api(base,"/peer/v1/health",a.token.slice(0,-1)+"!")).status,401);
  const health=await api(base,"/peer/v1/health",a.token);assert.equal(health.status,200);assert.equal(health.body.node_id,f.node.node_id);
  assert.equal((await api(base,"/peer/v1/health",a.token,{headers:{Origin:"https://example.test"}})).status,403);
  assert.equal((await api(base,"/peer/v1/hello",a.token,{method:"POST",body:hello(a.credential)})).status,200);
  assert.equal((await api(base,"/peer/v1/health?token="+a.token,null)).status,429);
  assert.equal((await api(base,"/peer/v1/health",null,{headers:{"X-Board-Token":a.token,"Tailscale-User-Login":"owner@example.test"}})).status,429);
 });
 assert.equal(store.list(f.db).tasks.length,0);
});
test("HTTP enforces credential scope and never grants another node's identity",async()=>{
 const a=fixture(),b=fixture(),ab=issue(a,{peerNodeId:b.node.node_id,peerEpoch:b.node.sync_epoch,scopes:["peer:handshake"]});
 const ba=issue(b,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch});
 await running(a,async base=>{
  assert.equal((await api(base,"/peer/v1/health",ab.token)).status,403);
  assert.equal((await api(base,"/peer/v1/health",ba.token)).status,401);
  const spoof={...hello(ab.credential),node_id:randomUUID()};
  assert.equal((await api(base,"/peer/v1/hello",ab.token,{method:"POST",body:spoof})).status,403);
 });
});
function raw(base,token,agent,extraHeaders={}){
 return new Promise((resolve,reject)=>{
  const req=http.get(base+"/peer/v1/health",{agent,headers:{Authorization:"Bearer "+token,...extraHeaders}},res=>{
   const port=res.socket.localPort;let out="";res.on("data",b=>out+=b);res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(out),port}));
  });req.on("error",reject);
 });
}
test("revocation applies to the next request on the same persistent connection",async()=>{
 const f=fixture(),a=issue(f),agent=new http.Agent({keepAlive:true,maxSockets:1});
 try{await running(f,async base=>{
  const first=await raw(base,a.token,agent),second=await raw(base,a.token,agent);
  assert.equal(first.port,second.port);assert.equal(second.status,200);
  revokePeer(f.db,{peerNodeId:a.args.peerNodeId,expectedVersion:1});
  const third=await raw(base,a.token,agent);
  assert.equal(third.port,second.port);assert.equal(third.status,401);
 });}finally{agent.destroy();}
});
test("revocation during an in-flight body is rechecked before hello response",async()=>{
 const f=fixture(),a=issue(f);
 await running(f,async(base,server)=>{
  const body=JSON.stringify(hello(a.credential));
  const response=new Promise((resolve,reject)=>{
   const req=http.request(base+"/peer/v1/hello",{method:"POST",headers:{Authorization:"Bearer "+a.token,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
    res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});
   req.on("error",reject);
   server.once("request",()=>{
    revokePeer(f.db,{peerNodeId:a.args.peerNodeId,expectedVersion:1});
    req.end(body.slice(1));
   });
   req.write(body.slice(0,1));
  });
  assert.equal(await response,401);
 });
});
test("HTTP limits malformed, oversized and duplicate authentication requests",async()=>{
 const f=fixture(),a=issue(f);
 await running(f,async base=>{
  assert.equal((await api(base,"/peer/v1/hello",a.token,{method:"POST",body:{large:"a".repeat(8192)}})).status,413);
  const invalid=await fetch(base+"/peer/v1/hello",{method:"POST",headers:{Authorization:"Bearer "+a.token,"Content-Type":"application/json"},body:"{"});
  assert.equal(invalid.status,400);
  const duplicate=await raw(base,a.token,false,{Authorization:["Bearer "+a.token,"Bearer "+a.token]});
  assert.equal(duplicate.status,401);
 });
});
test("non-loopback listening is refused before any socket opens",async()=>{
 const f=fixture();
 for(const host of ["0.0.0.0","100.64.0.1","::","example.test"])await assert.rejects(listenPeerServer(f.db,{host,port:0}),{code:"UNSAFE_BIND"});
});
test("local CLI requires explicit database and never prints the credential secret",()=>{
 const f=fixture(),p=next("cli-credential"),id=randomUUID(),epoch=randomUUID();
 const cli=(...args)=>spawnSync(process.execPath,[join(ROOT,"cli/peer.mjs"),...args],{encoding:"utf8",windowsHide:true});
 assert.equal(cli("list").status,1);
 const result=cli("grant","--db",f.dbPath,"--peer",id,"--epoch",epoch,"--projects","demo","--scopes","peer:handshake,peer:health","--credential-file",p);
 assert.equal(result.status,0,result.stderr);const c=JSON.parse(readFileSync(p,"utf8"));
 assert.ok(!result.stdout.includes(c.token));assert.equal(JSON.parse(result.stdout).credential_version,1);
 const list=cli("list","--db",f.dbPath);assert.equal(list.status,0,list.stderr);assert.ok(!list.stdout.includes(c.token));assert.ok(!list.stdout.includes("secret_hash"));
 assert.equal(cli("revoke","--db",f.dbPath,"--peer",id,"--version","1").status,0);
 assert.throws(()=>authenticate(f.db,"Bearer "+c.token),{code:"UNAUTHENTICATED"});
});

test("chunked oversized, invalid UTF-8 and compressed bodies are refused without data exposure",async()=>{
 const f=fixture(),a=issue(f);
 await running(f,async base=>{
  async function bodyRequest(chunks,headers={}){
   return new Promise((resolve,reject)=>{
    const req=http.request(base+"/peer/v1/hello",{method:"POST",headers:{Authorization:"Bearer "+a.token,"Content-Type":"application/json",...headers}},res=>{
     let out="";res.on("data",b=>out+=b);res.on("end",()=>resolve({status:res.statusCode,text:out}));
    });req.on("error",reject);for(const chunk of chunks)req.write(chunk);req.end();
   });
  }
  const over=await bodyRequest(["{",Buffer.alloc(8192,32),"}"]);assert.equal(over.status,413);
  assert.ok(!over.text.includes(a.token));
  assert.equal((await bodyRequest([Buffer.from([0xff])])).status,400);
  assert.equal((await bodyRequest(["{}"],{"Content-Encoding":"gzip"})).status,415);
 });
});
test("slow incomplete authenticated body has a bounded timeout",async()=>{
 const f=fixture(),a=issue(f);
 await running(f,async base=>{
  const response=await new Promise((resolve,reject)=>{
   const req=http.request(base+"/peer/v1/hello",{method:"POST",headers:{Authorization:"Bearer "+a.token,"Content-Type":"application/json","Content-Length":"100"}},res=>{
    res.resume();res.on("end",()=>{resolve(res.statusCode);req.destroy();});
   });req.on("error",reject);req.write("{");
  });
  assert.equal(response,408);
 });
});
test("an already-running gateway rejects a newly applied restore hold",async()=>{
 const f=fixture(),a=issue(f);
 await running(f,async base=>{
  assert.equal((await api(base,"/peer/v1/health",a.token)).status,200);
  f.db.exec("CREATE TABLE board_restore_hold(reason TEXT)");
  const response=await api(base,"/peer/v1/health",a.token);
  assert.equal(response.status,409);assert.equal(response.body.code,"RESTORE_HOLD");
 });
});
test("independent gateway CLI serves only its explicit database",async()=>{
 const f=fixture(),a=issue(f);
 const p=spawn(process.execPath,[join(ROOT,"cli/peer.mjs"),"serve","--db",f.dbPath,"--port","0"],
  {windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let stdout="",stderr="",timer;
 const done=new Promise(resolve=>p.once("close",resolve));
 try{
  const info=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error("gateway readiness timed out: "+stderr)),10000);
   p.stderr.on("data",b=>stderr+=b);p.on("error",reject);
   p.once("exit",code=>reject(Error("gateway exited "+code+" "+stderr)));
   p.stdout.on("data",b=>{stdout+=b;try{resolve(JSON.parse(stdout));}catch{}});
  });
  const base="http://127.0.0.1:"+info.listening.port;
  assert.equal((await api(base,"/peer/v1/health",null)).status,401);
  const r=await api(base,"/peer/v1/hello",a.token,{method:"POST",body:hello(a.credential)});
  assert.equal(r.status,200);assert.equal(r.body.node.node_id,f.node.node_id);
  assert.ok(!stdout.includes(a.token));assert.equal(existsSync(join(f.data,"board_token")),false);
  assert.equal(store.list(f.db).tasks.length,0);
 }finally{clearTimeout(timer);if(p.exitCode===null)p.kill();await done;}
});

test("unauthenticated requests cannot distinguish retired or restored node state",async()=>{
 for(const lifecycle of ["retired","restore_hold"]){
  const f=fixture(),p=issue(f);
  await running(f,async base=>{
   if(lifecycle==="retired")f.db.exec("UPDATE board_lifecycle SET state='retired' WHERE singleton=1");
   else f.db.exec("CREATE TABLE board_restore_hold(backup_id TEXT,restored_at TEXT)");
   for(const token of [undefined,"invalid",p.token.slice(0,-1)+(p.token.endsWith("A")?"B":"A")]){
    const r=await api(base,"/peer/v1/health",token);assert.equal(r.status,401);assert.equal(r.body.code,"UNAUTHENTICATED");
   }
   assert.equal((await api(base,"/peer/v1/health",p.token)).status,409);
  });
 }
});


test("failed gateway credentials back off without locking out the real holder of a forged key ID",async()=>{
 const f=fixture(),c=issue(f),bad=c.credential.key_id+"."+"x".repeat(43),secret="untrusted body must never enter auth audit";
 await running(f,async(base)=>{
  for(let i=0;i<7;i++){
   const r=await fetch(base+"/peer/v1/hello?not-a-log-field="+secret,{method:"POST",headers:{Authorization:"Bearer "+bad,"Content-Type":"application/json","X-Forwarded-For":"100.64.1.2"},body:JSON.stringify({secret})});
   assert.equal(r.status,i<5?401:429);const reply=await r.json();assert.equal(reply.code,i<5?"UNAUTHENTICATED":"AUTH_RATE_LIMITED");
   if(i>=5)assert.ok(Number(r.headers.get("retry-after"))>=1);
  }
  assert.equal((await api(base,"/peer/v1/health",c.token)).status,200);
  const missing=await api(base,"/peer/v1/health",null,{headers:{"X-Forwarded-For":"100.64.1.3"}});assert.equal(missing.status,401);
 });
 const entries=listAuthFailures(f.db).failures,entry=entries.find(e=>e.key_id===c.credential.key_id);
 assert.equal(entry.failures,7);assert.equal(entry.limited,2);assert.equal(entry.category,"claimed_key");
 const saved=JSON.stringify(entries);assert.ok(!saved.includes(bad));assert.ok(!saved.includes(c.token));assert.ok(!saved.includes(secret));assert.ok(!saved.includes("100.64"));
 const cli=spawnSync(process.execPath,["cli/peer.mjs","auth-failures","--db",f.dbPath,"--limit","2"],{cwd:ROOT,encoding:"utf8",windowsHide:true});
 assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).failures.length,2);
 assert.throws(()=>listAuthFailures(f.db,{limit:513}),e=>e.code==="BAD_INPUT");
});

test("failure accounting bounds hostile key cardinality, global rate, persisted rows and age",()=>{
 const f=fixture();let time=1000000;const guard=createAuthFailureGuard(f.db,{now:()=>time});
 try{
  let limited=0;
  for(let i=0;i<300;i++){const r=guard.failure("Bearer "+randomUUID()+"."+"y".repeat(43));if(r.status===429)limited++;}
  assert.ok(limited>=200);guard.flush();
  const initial=listAuthFailures(f.db,{limit:512,now:time}).failures;
  assert.equal(initial.length,AUTH_FAILURE_LIMITS.keys+1);assert.equal(initial.reduce((n,x)=>n+x.failures,0),300);assert.ok(initial.some(x=>x.category==="overflow"&&x.key_id===null));
  for(let i=0;i<550;i++){time+=AUTH_FAILURE_LIMITS.windowMs+1;assert.equal(guard.failure("invalid").status,401);guard.flush();}
  assert.equal(f.db.prepare("SELECT count(*) n FROM federation_auth_failures").get().n,AUTH_FAILURE_LIMITS.rows);
  time+=AUTH_FAILURE_LIMITS.retentionMs+1;assert.equal(listAuthFailures(f.db,{now:time}).failures.length,0);
  guard.failure("invalid");guard.flush();assert.equal(f.db.prepare("SELECT count(*) n FROM federation_auth_failures").get().n,1);
 }finally{guard.close();}
 const reopened=createAuthFailureGuard(f.db,{now:()=>time});try{assert.equal(listAuthFailures(f.db,{now:time}).failures.length,1);}finally{reopened.close();}
});

test("auth audit rollback retains bounded pending counts and returns 503 until persistence recovers",()=>{
 const f=fixture();let time=500000;const guard=createAuthFailureGuard(f.db,{now:()=>time});
 try{
  guard.failure("invalid");f.db.exec("CREATE TRIGGER fail_auth_audit BEFORE INSERT ON federation_auth_failures BEGIN SELECT RAISE(ABORT,'audit fixture failure'); END");
  assert.throws(()=>guard.flush(),/audit fixture failure/);assert.equal(f.db.isTransaction,false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM federation_auth_failures").get().n,0);
  assert.equal(guard.failure("invalid").status,503);
  f.db.exec("DROP TRIGGER fail_auth_audit");guard.flush();
  assert.equal(listAuthFailures(f.db,{now:time}).failures[0].failures,2);
  assert.equal(guard.failure("invalid").status,401);
 }finally{guard.close();}
 assert.equal(listAuthFailures(f.db,{now:time}).failures.reduce((n,r)=>n+r.failures,0),3);
});

test("auth audit rejects unknown schema without partially creating its event table",()=>{
 const f=fixture();f.db.exec("CREATE TABLE federation_auth_failure_schema(singleton INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO federation_auth_failure_schema VALUES(1,2)");
 assert.throws(()=>createAuthFailureGuard(f.db),e=>e.code==="SCHEMA_INCOMPATIBLE");assert.equal(f.db.isTransaction,false);
 assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='federation_auth_failures'").get().n,0);
});


test("global failed-auth threshold cannot be bypassed across tracked key IDs below each key limit",()=>{
 const f=fixture();let time=2000000;const guard=createAuthFailureGuard(f.db,{now:()=>time}),keys=Array.from({length:64},()=>randomUUID());
 try{
  for(let i=0;i<128;i++){
   const result=guard.failure("Bearer "+keys[i%keys.length]+"."+"z".repeat(43));
   assert.equal(result.status,i<AUTH_FAILURE_LIMITS.global?401:429);
   if(i>=AUTH_FAILURE_LIMITS.global)assert.equal(result.retry_after,10);
  }
  guard.flush();const rows=listAuthFailures(f.db,{now:time}).failures;
  assert.equal(rows.length,64);assert.ok(rows.every(r=>r.category==="claimed_key"&&r.failures===2));assert.equal(rows.reduce((n,r)=>n+r.limited,0),28);
  time+=10001;assert.equal(guard.failure("Bearer "+keys[0]+"."+"z".repeat(43)).status,401);
 }finally{guard.close();}
});


test("peer credentials have a protected owner-only Windows ACL even below a broadly readable directory",()=>{
 const f=fixture(),dir=next("凭据 [literal] & directory");mkdirSync(dir);allowInheritedRead(dir);
 assert.ok(inspectAcl(dir).rules.some(r=>r.sid==="S-1-1-0"));
 const a=issue(f,{credentialFile:join(dir,"peer credential.json")}),acl=inspectAcl(a.args.credentialFile);
 assert.equal(acl.protected,true);assert.equal(acl.owner,acl.current);
 assert.deepEqual(acl.rules,[{sid:acl.current,inherited:false,rights:2032127,type:"Allow"}]);
 assert.equal(authenticate(f.db,"Bearer "+a.token).peer_node_id,a.args.peerNodeId);
});

test("private credential helper failures expose only a safe reason and retain a bounded startup budget",()=>{
 // Each mocked helper runs in its own Node process so no other test's process
 // creation or real ACL checks can be affected by the injected failures.
 for(const [kind,reason] of [["timeout","helper_timeout"],["spawn","helper_unavailable"],["exit","helper_failed"],["output","unverified_response"]]){
  const code=`import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
   const kind=${JSON.stringify(kind)};let options;
   cp.spawnSync=(_file,_args,o)=>{options=o;return {status:kind==='output'?0:kind==='exit'?1:null,stdout:'private-fixture-marker',stderr:'private-fixture-marker',error:kind==='timeout'?{code:'ETIMEDOUT'}:kind==='spawn'?{code:'ENOENT'}:undefined};};syncBuiltinESMExports();
   const {writePrivateJSON}=await import(${JSON.stringify(new URL('../core/private-json.mjs',import.meta.url).href)});
   try{writePrivateJSON('C:/private-fixture-marker/credential.json',{token:'private-fixture-marker'});process.exitCode=2;}
   catch(e){console.log(JSON.stringify({code:e.code,reason:e.reason,message:e.message,budget:options?.timeout}));}`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
  assert.equal(out.code,'PRIVATE_FILE_FAILED');assert.equal(out.reason,reason);assert.ok(out.budget>=15000&&out.budget<=30000,'cold Windows helper startup must have a bounded 15-30 second allowance');assert.ok(!r.stdout.includes('private-fixture-marker'));
 }
});

test("failed Windows credential protection rolls back the grant without creating a usable token",()=>{
 const f=fixture(),file=next("unavailable-protection")+".json",previous=process.env.SystemRoot;
 try{process.env.SystemRoot=next("missing-windows");assert.throws(()=>issue(f,{credentialFile:file}),{code:"PRIVATE_FILE_FAILED"});}finally{process.env.SystemRoot=previous;}
 assert.equal(existsSync(file),false);assert.equal(listPeers(f.db).length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM federation_auth_events").get().n,0);
});

test("H8 one authenticated peer cannot overlap uploads while another peer remains admitted",async()=>{
 const f=fixture(),a=issue(f),b=issue(f);
 await running(f,async base=>{
  const bytes=Buffer.from(JSON.stringify(hello(a.credential))),u=new URL(base);
  let first;const done=new Promise((resolve,reject)=>{first=http.request({hostname:u.hostname,port:u.port,path:"/peer/v1/hello",method:"POST",headers:{authorization:"Bearer "+a.token,"content-type":"application/json","content-length":bytes.length}},r=>{r.resume();r.on("end",()=>resolve(r.statusCode));});first.on("error",reject);first.write(bytes.subarray(0,1));});
  try{
   await new Promise(r=>setTimeout(r,40));
   const blocked=await api(base,"/peer/v1/health",a.token);assert.equal(blocked.status,429);assert.equal(blocked.body.code,"PEER_BUSY");
   assert.equal((await api(base,"/peer/v1/health",b.token)).status,200);
  }finally{first.end(bytes.subarray(1));await done;}
  assert.equal((await api(base,"/peer/v1/health",a.token)).status,200);
 });
});

test("H8 authenticated read routes do not compete for a WAL writer lock",async()=>{
 const f=fixture(),a=issue(f,{scopes:[...SCOPES]});
 await running(f,async base=>{
  const writer=new DatabaseSync(f.dbPath);f.db.exec("PRAGMA busy_timeout=20");writer.exec("BEGIN IMMEDIATE");
  try{
   assert.equal((await api(base,"/peer/v1/health",a.token)).status,200);
   assert.equal((await api(base,"/peer/v1/hello",a.token,{method:"POST",body:hello(a.credential)})).status,200);
   for(const [route,body] of [
    ["delegation/status",{delegation_id:randomUUID(),project_id:"demo"}],
    ["delegation/result-status",{result_id:randomUUID(),project_id:"demo"}],
    ["delegation/cancel-status",{relation_id:randomUUID(),cancel_id:randomUUID(),project_id:"demo"}],
    ["artifact/status",{transfer_id:randomUUID(),header_digest:"0".repeat(64)}],
    ["relations/status",{graph_id:randomUUID(),graph_epoch:randomUUID(),relation_id:null,project_id:"demo"}],
    ["recovery/lineage",{node_id:f.node.node_id,from_epoch:randomUUID(),to_epoch:f.node.sync_epoch}]
   ]){
    const r=await api(base,"/peer/v1/"+route,a.token,{method:"POST",body});
    assert.ok([403,404,409].includes(r.status),route+": "+JSON.stringify(r));
   }
  }finally{writer.exec("ROLLBACK");writer.close();}
 });
});
