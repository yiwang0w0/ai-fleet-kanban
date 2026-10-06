import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import http from 'node:http';
import {migratePeers,issueCredential,localIdentity} from '../core/federation/peers.mjs';
import {listenPeerServer} from '../core/federation/gateway.mjs';
import {migrateSync} from '../core/federation/sync-store.mjs';
import {syncOnce,loadCredential,request} from '../core/federation/sync-client.mjs';
const store=createRequire(import.meta.url)('../core/store.js'),ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-peer-endpoint-')),dbs=[],servers=[];let seq=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
function node({sync=true}={}){const dir=join(TMP,'node-'+seq++);mkdirSync(dir);const path=join(dir,'board.db'),db=new DatabaseSync(path);dbs.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');store.migrate(db);migratePeers(db);if(sync)migrateSync(db);return {dir,path,db,n:localIdentity(db)};}
async function serve(a){const server=await listenPeerServer(a.db,{port:0});servers.push(server);return {server,url:'http://127.0.0.1:'+server.address().port};}
function grant(a,b,url,expectedVersion){const file=join(TMP,'credential-'+seq+++'.json');issueCredential(a.db,{peerNodeId:b.n.node_id,peerEpoch:b.n.sync_epoch,scopes:['peer:handshake','sync:pull','sync:ack'],projects:['demo'],credentialFile:file,serverEndpoint:url,expectedVersion});return {file,c:JSON.parse(readFileSync(file,'utf8'))};}
async function sink(handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);return {server:s,url:'http://127.0.0.1:'+s.address().port};}

test('peer grant requires an explicit endpoint before writing a credential and CLI emits format two',()=>{
 const a=node(),b=node(),file=join(TMP,'missing-endpoint.json'),args={peerNodeId:b.n.node_id,peerEpoch:b.n.sync_epoch,scopes:['peer:handshake'],projects:['demo'],credentialFile:file};assert.throws(()=>issueCredential(a.db,args),{code:'BAD_ENDPOINT'});assert.equal(existsSync(file),false);assert.equal(a.db.prepare('SELECT count(*) n FROM federation_peers').get().n,0);
 const r=spawnSync(process.execPath,[join(ROOT,'cli/peer.mjs'),'grant','--db',a.path,'--peer',b.n.node_id,'--epoch',b.n.sync_epoch,'--scopes','peer:handshake','--projects','demo','--credential-file',file,'--endpoint','https://office-node.example.ts.net:443/'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);const c=JSON.parse(readFileSync(file,'utf8'));assert.equal(c.format,2);assert.equal(c.server_endpoint,'https://office-node.example.ts.net');assert.ok(!r.stdout.includes(c.token));assert.equal(JSON.parse(r.stdout).server_endpoint,c.server_endpoint);
});
test('wrong machine receives zero requests and an unbound legacy credential cannot leave the client',async()=>{
 const a=node(),b=node(),right=await serve(a),g=grant(a,b,right.url);let leaked=0;const wrong=await sink((req,res)=>{leaked++;req.resume();res.writeHead(401,{'Content-Type':'application/json'});res.end('{}');});
 await assert.rejects(syncOnce(b.db,{url:wrong.url,credentialFile:g.file,projectId:'demo'}),{code:'ENDPOINT_MISMATCH'});assert.equal(leaked,0);
 assert.equal((await syncOnce(b.db,{url:right.url+'/',credentialFile:g.file,projectId:'demo'})).state,'synced');
 const legacy=join(TMP,'legacy.json'),old={...g.c,format:1};delete old.server_endpoint;writeFileSync(legacy,JSON.stringify(old));assert.throws(()=>loadCredential(legacy,b.n,'demo',undefined,right.url),{code:'CREDENTIAL_REISSUE_REQUIRED'});await assert.rejects(syncOnce(b.db,{url:wrong.url,credentialFile:legacy,projectId:'demo'}),{code:'CREDENTIAL_REISSUE_REQUIRED'});assert.equal(leaked,0);
});
test('shared request checks credential endpoint before fetch and never follows a redirect carrying authority',async()=>{
 const a=node(),b=node();let hits=0,redirects=0;const wrong=await sink((req,res)=>{hits++;req.resume();res.end('{}');}),redirect=await sink((req,res)=>{redirects++;req.resume();res.writeHead(302,{Location:wrong.url+'/peer/v1/hello'});res.end();}),g=grant(a,b,redirect.url);let fetched=0;
 await assert.rejects(request(wrong.url,'/peer/v1/hello',g.c,{},async()=>{fetched++;}),{code:'ENDPOINT_MISMATCH'});assert.equal(fetched,0);await assert.rejects(request(redirect.url,'/peer/v1/hello',g.c,{},fetch));assert.equal(redirects,1);assert.equal(hits,0);
});
test('successful sync permanently binds the source endpoint and rejects a new address before network access',async()=>{
 const a=node(),b=node(),first=await serve(a),g=grant(a,b,first.url);assert.equal((await syncOnce(b.db,{url:first.url,credentialFile:g.file,projectId:'demo'})).state,'synced');const persisted=b.db.prepare('SELECT * FROM federation_sources WHERE origin_node_id=?').get(a.n.node_id);assert.equal(persisted.server_endpoint,first.url);
 const second=await serve(a),rotated=grant(a,b,second.url,1);let calls=0;second.server.on('request',()=>calls++);await assert.rejects(syncOnce(b.db,{url:second.url,credentialFile:rotated.file,projectId:'demo'}),{code:'SOURCE_ENDPOINT_CHANGED'});assert.equal(calls,0);assert.equal(b.db.prepare('SELECT server_endpoint FROM federation_sources WHERE origin_node_id=?').get(a.n.node_id).server_endpoint,first.url);assert.throws(()=>b.db.prepare('UPDATE federation_sources SET server_endpoint=? WHERE origin_node_id=?').run(second.url,a.n.node_id),/immutable/);
 b.db.close();b.db=new DatabaseSync(b.path);dbs.push(b.db);await assert.rejects(syncOnce(b.db,{url:second.url,credentialFile:rotated.file,projectId:'demo'}),{code:'SOURCE_ENDPOINT_CHANGED'});assert.equal(calls,0);
});
test('sync migration preserves an existing source while adding an initially unbound endpoint column',()=>{
 const f=node({sync:false}),id=randomUUID(),epoch=randomUUID();f.db.exec("CREATE TABLE federation_sync_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO federation_sync_schema VALUES(1,4); CREATE TABLE federation_sources(origin_node_id TEXT PRIMARY KEY,origin_epoch TEXT NOT NULL,display_name TEXT NOT NULL,last_seen_at TEXT NOT NULL)");f.db.prepare('INSERT INTO federation_sources VALUES(?,?,?,?)').run(id,epoch,'alpha','2026-01-01T00:00:00.000Z');migrateSync(f.db);migrateSync(f.db);const row=f.db.prepare('SELECT * FROM federation_sources').get();assert.equal(row.origin_node_id,id);assert.equal(row.origin_epoch,epoch);assert.equal(row.server_endpoint,null);assert.equal(f.db.prepare('SELECT version FROM federation_sync_schema').get().version,5);
});
