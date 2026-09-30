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
import {negotiateHello, CAPABILITIES} from "../core/federation/protocol.mjs";
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
  for(const path of ["/","/health","/api/meta","/api/tasks","/peer/v1/health","/peer/v1/hello","/board_token"]){
   assert.equal((await api(base,path,null)).status,401);
   if(path!=="/peer/v1/health")assert.equal((await api(base,path,a.token)).status,404);
  }
  for(const token of ["operator-fixture","worker-fixture","review-fixture",a.token.slice(0,-1)+"!"])
   assert.equal((await api(base,"/peer/v1/health",token)).status,401);
  const health=await api(base,"/peer/v1/health",a.token);assert.equal(health.status,200);assert.equal(health.body.node_id,f.node.node_id);
  assert.equal((await api(base,"/peer/v1/health",a.token,{headers:{Origin:"https://example.test"}})).status,403);
  assert.equal((await api(base,"/peer/v1/hello",a.token,{method:"POST",body:hello(a.credential)})).status,200);
  assert.equal((await api(base,"/peer/v1/health?token="+a.token,null)).status,401);
  assert.equal((await api(base,"/peer/v1/health",null,{headers:{"X-Board-Token":a.token,"Tailscale-User-Login":"owner@example.test"}})).status,401);
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
