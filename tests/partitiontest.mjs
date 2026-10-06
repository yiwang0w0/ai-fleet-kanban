// Three isolated Windows databases and real authenticated loopback endpoints.
// This is a network-partition experiment, not physical two-PC acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {migratePeers,localIdentity} from '../core/federation/peers.mjs';
import {migrateSync,shareTask,applyBatch,listReplicas,digest,cursor} from '../core/federation/sync-store.mjs';
import {syncOnce} from '../core/federation/sync-client.mjs';
import {readFleetView} from '../core/fleet-view.mjs';
import {issueCredential,listenPeerServer,fixtureEndpoint} from './helpers/peer-network.mjs';
const store=createRequire(import.meta.url)('../core/store.js');
const project='partition-fixture',count=(db,table)=>db.prepare('SELECT count(*) n FROM '+table).get().n;

test('three authenticated sources converge after staggered partitions, a lost committed ACK and database reopen',{timeout:60000},async t=>{
 assert.equal(process.platform,'win32');
 const root=mkdtempSync(join(tmpdir(),'fleet-partition-')),nodes=[],routes=[],began=performance.now();
 async function stop(n){if(!n.server)return;const server=n.server;n.server=null;await new Promise(r=>{server.close(r);server.closeAllConnections();});}
 async function start(n){assert.equal(n.server,null);n.server=await listenPeerServer(n.db);}
 function reopen(n){assert.equal(n.server,null);n.db.close();n.db=new DatabaseSync(n.path);n.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');assert.deepEqual(localIdentity(n.db),n.identity);}
 function node(alias){
  const dir=join(root,alias);mkdirSync(dir);const path=join(dir,'board.db'),db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');store.migrate(db);migratePeers(db);migrateSync(db);store.renameNode(db,alias);
  const n={alias,dir,path,db,identity:localIdentity(db),server:null,ids:[]};nodes.push(n);
  for(let i=0;i<8;i++){const id=store.add(db,{subject:alias+' shared '+i,description:'initial',released:false});n.ids.push(id);shareTask(db,{id,projectId:project,expectedVersion:store.get(db,id).aggregate_version});}
  store.add(db,{subject:'PRIVATE-'+alias,released:false});const hidden=store.add(db,{subject:'OTHER-PROJECT-'+alias,released:false});shareTask(db,{id:hidden,projectId:'not-authorized',expectedVersion:store.get(db,hidden).aggregate_version});
  return n;
 }
 function update(n,round){for(const id of n.ids)store.update(n.db,{id,description:n.alias+' round '+round,expectedVersion:store.get(n.db,id).aggregate_version});}
 const route=(source,receiver)=>routes.find(r=>r.source===source&&r.receiver===receiver);
 async function pull(r,fetchImpl=fetch){return syncOnce(r.receiver.db,{url:fixtureEndpoint(r.source.db),credentialFile:r.credentialFile,projectId:project,maxBatches:2,fetchImpl});}
 async function drain(r){
  for(let i=0;i<20;i++){
   const result=await pull(r);
   if(result.state==='backoff'){await delay(Math.max(1,result.retry_after-Date.now()+10));continue;}
   assert.ok(['synced','pending'].includes(result.state),JSON.stringify({source:r.source.alias,receiver:r.receiver.alias,...result}));
   if(!result.has_more)return result;
  }
  assert.fail('bounded synchronization did not converge');
 }
 const replicaDigest=n=>digest(n.db.prepare('SELECT * FROM federation_replicas ORDER BY task_uid').all());
 const current=n=>n.db.prepare('SELECT event_json FROM federation_published WHERE project_id=? ORDER BY task_uid').all(project).map(r=>JSON.parse(r.event_json));
 function verify(source,receiver){
  const published=current(source),expected=published.filter(e=>e.kind==='task.snapshot').map(e=>e.payload.task);
  const actual=receiver.db.prepare('SELECT task_json FROM federation_replicas WHERE owner_node_id=? AND project_id=? AND withdrawn=0 ORDER BY task_uid').all(source.identity.node_id,project).map(r=>JSON.parse(r.task_json));
  assert.equal(digest(actual),digest(expected),'authorized projection '+source.alias+' -> '+receiver.alias);
  assert.ok(actual.every(r=>r.owner_node_id===source.identity.node_id));assert.ok(!JSON.stringify(actual).includes('PRIVATE-'));assert.ok(!JSON.stringify(actual).includes('OTHER-PROJECT-'));
  assert.equal(count(receiver.db,'tasks'),10);assert.equal(count(receiver.db,'task_runs'),0);
  const delivery=source.db.prepare('SELECT offered_seq,acked_seq FROM federation_deliveries WHERE peer_node_id=? AND project_id=?').get(receiver.identity.node_id,project);assert.equal(delivery.acked_seq,delivery.offered_seq);
  return {source:source.alias,receiver:receiver.alias,tasks:actual.length,projection_sha256:digest(actual),acked_seq:delivery.acked_seq};
 }
 try{
  const a=node('A'),b=node('B'),c=node('C');
  for(const source of nodes)for(const receiver of nodes){if(source===receiver)continue;const credentialFile=join(receiver.dir,'from-'+source.alias+'.json');issueCredential(source.db,{peerNodeId:receiver.identity.node_id,peerEpoch:receiver.identity.sync_epoch,scopes:['peer:handshake','sync:pull','sync:ack'],projects:[project],credentialFile});routes.push({source,receiver,credentialFile});}
  for(const n of nodes)await start(n);for(const r of routes)await drain(r);for(const r of routes)verify(r.source,r.receiver);
  const cacheB=digest(listReplicas(b.db,{projectId:project})),cacheC=digest(listReplicas(c.db,{projectId:project}));
  await stop(c);await stop(b);
  for(const n of nodes)update(n,1);
  shareTask(a.db,{id:a.ids[1],projectId:project,expectedVersion:store.get(a.db,a.ids[1]).aggregate_version,enabled:false});
  const unavailable=[];
  for(const source of [b,c]){const result=await pull(route(source,a));assert.equal(result.state,'error');assert.equal(result.error_code,'NETWORK_ERROR');unavailable.push(source.alias);}
  assert.equal(digest(listReplicas(b.db,{projectId:project})),cacheB);assert.equal(digest(listReplicas(c.db,{projectId:project})),cacheC);
  // B returns first; both peers converge without using C as a relay or authority.
  reopen(b);await start(b);await drain(route(b,a));await drain(route(a,b));verify(a,b);verify(b,a);
  update(a,2);update(b,2);await drain(route(a,b));await drain(route(b,a));verify(a,b);verify(b,a);
  assert.equal(c.server,null);assert.equal(digest(listReplicas(c.db,{projectId:project})),cacheC);
  // C returns later. Let its ACK commit, then withhold only the response from the client.
  reopen(c);await start(c);const ca=route(c,a);let withheld=false,captured=null,committedAck=null;
  const failAfterAck=async(url,options)=>{
   const response=await fetch(url,options);
   if(String(url).endsWith('/pull')){const batch=await response.clone().json();if(batch.events?.length)captured=batch;}
   if(String(url).endsWith('/ack')&&!withheld){assert.equal(response.status,200);committedAck=await response.json();withheld=true;throw Error('fixture ACK response withheld after server commit');}
   return response;
  };
  const previous=a.db.prepare('SELECT retry_after FROM federation_sync_attempts WHERE origin_node_id=? AND project_id=?').get(c.identity.node_id,project);
  if(previous?.retry_after>Date.now())await delay(previous.retry_after-Date.now()+10);
  const lost=await pull(ca,failAfterAck);assert.equal(lost.state,'error');assert.equal(withheld,true);assert.ok(captured?.events.length);assert.ok(committedAck.acked_seq>8);
  assert.equal(cursor(a.db,c.identity.node_id,c.identity.sync_epoch,project),committedAck.acked_seq);
  const committed=c.db.prepare('SELECT acked_seq FROM federation_deliveries WHERE peer_node_id=? AND project_id=?').get(a.identity.node_id,project);assert.equal(committed.acked_seq,committedAck.acked_seq);
  const inbox=count(a.db,'federation_inbox'),replicas=replicaDigest(a);
  // Reopen the receiver before retrying the already-committed response loss.
  await stop(a);reopen(a);await start(a);const retried=await drain(ca);assert.equal(retried.applied,0);assert.equal(count(a.db,'federation_inbox'),inbox);assert.equal(replicaDigest(a),replicas);
  const source={origin:c.identity.node_id,epoch:c.identity.sync_epoch,projectId:project};assert.equal(applyBatch(a.db,source,captured).applied,0);assert.equal(applyBatch(a.db,source,captured).applied,0);assert.equal(count(a.db,'federation_inbox'),inbox);
  for(const r of routes)await drain(r);
  const final=routes.map(r=>verify(r.source,r.receiver));
  for(const n of nodes){assert.equal(readFleetView(n.db,{projectId:project}).total_matching,n===a?24:23);assert.equal(count(n.db,'tasks'),10);assert.equal(count(n.db,'task_runs'),0);assert.equal(n.db.prepare('SELECT count(*) n FROM federation_sync_attempts WHERE error_code IS NOT NULL').get().n,0);}
  t.diagnostic(JSON.stringify({format:'ai-fleet-three-node-partition/v1',physical_hosts:1,isolated_nodes:3,tailscale:false,providers_called:false,epoch_changed:false,restoration_order:['B','C','A receiver reopen'],unavailable_sources:unavailable,ack_committed_before_response_loss:true,duplicate_replay_applied:0,global_shared_tasks:23,visible_tasks_by_node:{A:24,B:23,C:23},withdrawn_task_retained_by_owner:true,local_authoritative_tasks_per_node:10,task_runs:0,projection_checks:final,elapsed_ms:Math.round(performance.now()-began)}));
 }finally{
  for(const n of nodes)await stop(n);for(const n of nodes)try{n.db.close();}catch{}
  const relativeRoot=relative(resolve(tmpdir()),resolve(root));assert.ok(relativeRoot&&!relativeRoot.startsWith('..'));rmSync(root,{recursive:true,force:true});
 }
});
