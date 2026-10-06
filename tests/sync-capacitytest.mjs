// Real SQLITE_FULL in isolated files; never fills a host volume or weakens retention rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {migratePeers,localIdentity,authenticate} from '../core/federation/peers.mjs';
import {migrateSync,shareTask,exportBatch,applyBatch,cursor} from '../core/federation/sync-store.mjs';
import {syncOnce} from '../core/federation/sync-client.mjs';
import {issueCredential,listenPeerServer,fixtureEndpoint} from './helpers/peer-network.mjs';
const store=createRequire(import.meta.url)('../core/store.js');
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'fleet-sync-capacity-')),handles=[];
 t.after(()=>{for(const db of handles)try{db.close();}catch{}const part=relative(resolve(tmpdir()),resolve(dir));assert.ok(part&&!part.startsWith('..'));rmSync(dir,{recursive:true,force:true});});
 function node(name){const data=join(dir,name);mkdirSync(data);const path=join(data,'board.db'),db=new DatabaseSync(path);handles.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');store.migrate(db);migratePeers(db);migrateSync(db);return {db,path,node:localIdentity(db)};}
 const a=node('A'),b=node('B'),credentialFile=join(dir,'peer.json'),projectId='capacity-test';
 issueCredential(a.db,{peerNodeId:b.node.node_id,peerEpoch:b.node.sync_epoch,projects:[projectId],scopes:['peer:handshake','sync:pull','sync:ack'],credentialFile});
 const credential=JSON.parse(readFileSync(credentialFile,'utf8')),peer=authenticate(a.db,'Bearer '+credential.token),source={origin:a.node.node_id,epoch:a.node.sync_epoch,projectId};
 const reopen=n=>{n.db.close();n.db=new DatabaseSync(n.path);handles.push(n.db);n.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');};
 return {a,b,peer,source,projectId,credentialFile,reopen};
}
const count=(db,table)=>db.prepare('SELECT count(*) n FROM '+table).get().n;
function cap(db){const max=db.prepare('PRAGMA max_page_count').get().max_page_count,pages=db.prepare('PRAGMA page_count').get().page_count;assert.equal(db.prepare('PRAGMA max_page_count='+pages).get().max_page_count,pages);return max;}
function shared(f){const id=store.add(f.a.db,{subject:'capacity fixture',description:'x'.repeat(96*1024),released:false});shareTask(f.a.db,{id,projectId:f.projectId,expectedVersion:store.get(f.a.db,id).aggregate_version});return id;}

test('source SQLITE_FULL preserves unpublished state across reopen and can resend once capacity returns',t=>{
 const f=fixture(t),id=shared(f),version=store.get(f.a.db,id).aggregate_version;cap(f.a.db);
 assert.throws(()=>exportBatch(f.a.db,f.peer,{project_id:f.projectId,after_seq:0}),e=>e.errcode===13);
 assert.equal(f.a.db.isTransaction,false);assert.equal(count(f.a.db,'federation_outbox'),0);assert.equal(count(f.a.db,'federation_dirty'),1);assert.equal(count(f.a.db,'federation_deliveries'),0);
 assert.equal(store.get(f.a.db,id).aggregate_version,version);f.reopen(f.a);f.a.db.exec('PRAGMA max_page_count=1073741823');
 const batch=exportBatch(f.a.db,f.peer,{project_id:f.projectId,after_seq:0});assert.equal(batch.events.length,1);assert.equal(batch.events[0].seq,1);assert.equal(count(f.a.db,'federation_dirty'),0);
 assert.equal(applyBatch(f.b.db,f.source,batch).applied,1);assert.equal(applyBatch(f.b.db,f.source,batch).applied,0);assert.equal(count(f.b.db,'federation_inbox'),1);
});

test('receiver SQLITE_FULL never acknowledges a lost batch; real HTTP retry after reopen converges once', {timeout:60000},async t=>{
 const f=fixture(t),server=await listenPeerServer(f.a.db,{port:0});
 t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});});
 const url=fixtureEndpoint(f.a.db),args={url,credentialFile:f.credentialFile,projectId:f.projectId,maxBatches:1};
 assert.equal((await syncOnce(f.b.db,args)).state,'synced');shared(f);cap(f.b.db);
 const offered=exportBatch(f.a.db,f.peer,{project_id:f.projectId,after_seq:0});
 assert.throws(()=>applyBatch(f.b.db,f.source,offered),e=>e.errcode===13,'The receiver must encounter real SQLITE_FULL before the HTTP retry.');
 let acknowledgements=0;const fetchImpl=(url,options)=>{if(String(url).endsWith('/ack'))acknowledgements++;return fetch(url,options);};
 const failed=await syncOnce(f.b.db,{...args,fetchImpl});assert.equal(failed.state,'error');assert.equal(failed.error_code,'ERR_SQLITE_ERROR');assert.equal(acknowledgements,0);
 assert.equal(cursor(f.b.db,f.source.origin,f.source.epoch,f.projectId),0);assert.equal(count(f.b.db,'federation_inbox'),0);assert.equal(count(f.b.db,'federation_replicas'),0);
 assert.equal(f.a.db.prepare('SELECT acked_seq FROM federation_deliveries').get().acked_seq,0);
 f.reopen(f.b);f.b.db.exec('PRAGMA max_page_count=1073741823');
 const done=await syncOnce(f.b.db,{...args,now:failed.retry_after+1});assert.equal(done.state,'synced');assert.equal(done.applied,1);assert.equal(done.cursor,1);
 const retry=await syncOnce(f.b.db,{...args,now:failed.retry_after+2});assert.equal(retry.state,'synced');assert.equal(retry.applied,0);
 assert.equal(count(f.b.db,'federation_inbox'),1);assert.equal(count(f.b.db,'federation_replicas'),1);assert.equal(f.a.db.prepare('SELECT acked_seq FROM federation_deliveries').get().acked_seq,1);
 assert.equal(count(f.b.db,'tasks'),0);assert.equal(count(f.b.db,'task_runs'),0);
});

test('first snapshot SQLITE_FULL retains an empty staging checkpoint and resumes after reopen without early ACK', {timeout:60000},async t=>{
 const f=fixture(t);shared(f);assert.equal(exportBatch(f.a.db,f.peer,{project_id:f.projectId,after_seq:0}).events.length,1);const url=fixtureEndpoint(f.a.db),args={url,credentialFile:f.credentialFile,projectId:f.projectId,maxBatches:1};
 // Initialize client bookkeeping while the source is actually offline; no snapshot exists yet.
 const offline=await syncOnce(f.b.db,args);assert.equal(offline.state,'error');
 const server=await listenPeerServer(f.a.db,{port:0});t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});});cap(f.b.db);
 let pages=0,acks=0;const fetchImpl=async(url,options)=>{if(String(url).endsWith('/ack'))acks++;const response=await fetch(url,options);if(String(url).endsWith('/snapshot/page')&&response.ok)pages++;return response;};
 const failed=await syncOnce(f.b.db,{...args,now:offline.retry_after+1,fetchImpl});assert.equal(failed.state,'error');assert.equal(failed.error_code,'ERR_SQLITE_ERROR');assert.equal(pages,1);assert.equal(acks,0);
 assert.equal(count(f.b.db,'federation_replicas'),0);assert.equal(count(f.b.db,'federation_snapshot_anchors'),0);assert.equal(count(f.b.db,'federation_snapshot_received'),0);assert.equal(f.b.db.prepare('SELECT next_offset FROM federation_snapshot_staging').get().next_offset,0);
 f.reopen(f.b);f.b.db.exec('PRAGMA max_page_count=1073741823');
 const done=await syncOnce(f.b.db,{...args,now:failed.retry_after+1});assert.equal(done.state,'synced');assert.equal(done.rebuilt,1);assert.equal(done.cursor,1);assert.equal(count(f.b.db,'federation_snapshot_staging'),0);
 const again=await syncOnce(f.b.db,{...args,now:failed.retry_after+2});assert.equal(again.state,'synced');assert.equal(again.applied,0);assert.equal(again.rebuilt,0);
 assert.equal(count(f.b.db,'federation_replicas'),1);assert.equal(count(f.b.db,'tasks'),0);assert.equal(count(f.b.db,'task_runs'),0);
 assert.equal(f.a.db.prepare('SELECT offered_seq=acked_seq ok FROM federation_deliveries').get().ok,1);
});
