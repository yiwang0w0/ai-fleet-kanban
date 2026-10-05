// Opt-in Windows load experiment, kept out of the default regression loop.
// Three isolated instances on ONE host; task history is real store API history.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir,cpus,totalmem,release} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {migratePeers,localIdentity} from '../core/federation/peers.mjs';
import {migrateSync,shareTask,digest} from '../core/federation/sync-store.mjs';
import {syncOnce} from '../core/federation/sync-client.mjs';
import {readFleetView} from '../core/fleet-view.mjs';
import {issueCredential,listenPeerServer,fixtureEndpoint} from './helpers/peer-network.mjs';
assert.equal(process.platform,'win32','This acceptance experiment targets Windows.');
assert.equal(process.argv.length,3,'Usage: node tests/fleet-load.mjs <new-report.json>');
const output=resolve(process.argv[2]),ROOT=fileURLToPath(new URL('../',import.meta.url));
const store=createRequire(import.meta.url)('../core/store.js'),dir=mkdtempSync(join(tmpdir(),'fleet-load-')),handles=[],servers=[];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const rowCount=(db,table)=>db.prepare('SELECT count(*) n FROM '+table).get().n;
const report={format:'ai-fleet-single-host-load/v1',started_at:new Date().toISOString(),code_sha:execFileSync('git',['-c','safe.directory='+ROOT.replaceAll('\\','/').replace(/\/$/,''),'rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',windowsHide:true}).trim(),environment:{platform:process.platform,os_release:release(),node:process.version,logical_cpus:cpus().length,memory_bytes:totalmem()},scope:{physical_hosts:1,isolated_instances:3,tailscale:false,providers_called:false,real_72_hours:false,write_durability:'WAL synchronous=FULL',proposed_thresholds_frozen:false},sources:Object.fromEntries(['tests/fleet-load.mjs','core/fleet-view.mjs','core/store.js','core/federation/sync-client.mjs','core/federation/sync-store.mjs'].map(p=>[p,hash(join(ROOT,p))]))};
const elapsed=t=>Math.round((performance.now()-t)*1000)/1000;
let peakRss=process.memoryUsage().rss;
function samples(values){const sorted=[...values].sort((a,b)=>a-b);return {n:values.length,p50_ms:sorted[Math.ceil(sorted.length*.5)-1],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_ms:sorted.at(-1),samples_ms:values};}
function node(alias){const data=join(dir,alias);mkdirSync(data);const path=join(data,'board.db'),db=new DatabaseSync(path);handles.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');store.migrate(db);migratePeers(db);migrateSync(db);store.renameNode(db,alias);return {db,path,identity:localIdentity(db),ids:[]};}
function seed(n,size){
 const start=performance.now();n.db.exec('BEGIN IMMEDIATE');try{
  for(let i=0;i<size;i++){const id=store.add(n.db,{subject:'load card '+String(i).padStart(5,'0'),description:'fixture '+'.'.repeat(248),released:false,kind:i===0?'goal':'task',treeMode:'hierarchical',...(i?{parentId:n.ids[0]}:{})});n.ids.push(id);shareTask(n.db,{id,projectId:'load-project',expectedVersion:store.get(n.db,id).aggregate_version});}
  for(let round=0;round<9;round++)for(const id of n.ids)store.setReleased(n.db,{id,released:round%2===0,actor:'fixture',expectedVersion:store.get(n.db,id).aggregate_version});
  n.db.exec('COMMIT');
 }catch(e){if(n.db.isTransaction)n.db.exec('ROLLBACK');throw e;}
 assert.equal(rowCount(n.db,'tasks'),size);assert.equal(rowCount(n.db,'task_events'),size*10);
 console.log(JSON.stringify({phase:'seed',alias:n.identity.display_name,tasks:size,task_events:size*10,elapsed_ms:elapsed(start)}));
 return {tasks:size,task_events:size*10,elapsed_ms:elapsed(start)};
}
async function drain(receiver,args){let calls=0,result;do{assert.ok(++calls<=200,'Bounded catch-up exceeded 200 rounds');result=await syncOnce(receiver.db,{...args,maxBatches:20});assert.ok(['pending','synced'].includes(result.state),JSON.stringify(result));}while(result.has_more);return {calls,result};}
try{
 const nodes=[node('A'),node('B'),node('C')],a=nodes[0];report.seed=nodes.map((n,i)=>seed(n,i===0?3334:3333));
 const routes=[];
 for(const n of nodes.slice(1)){const credentialFile=join(dir,n.identity.display_name+'.json');issueCredential(n.db,{peerNodeId:a.identity.node_id,peerEpoch:a.identity.sync_epoch,projects:['load-project'],scopes:['peer:handshake','sync:pull','sync:ack'],credentialFile});const s=await listenPeerServer(n.db,{port:0});servers.push(s);routes.push({url:fixtureEndpoint(n.db),credentialFile,projectId:'load-project'});}
 const initial=performance.now();for(const args of routes)await drain(a,args);report.initial_replication_ms=elapsed(initial);
 const fixedNow=Date.now(),read=q=>{const start=performance.now(),v=readFleetView(a.db,{limit:100,now:fixedNow,...q});peakRss=Math.max(peakRss,process.memoryUsage().rss);return {view:v,ms:elapsed(start)};};
 const changes=a.db.prepare('SELECT total_changes() n').get().n,seen=new Set(),latencies=[];let snapshot=null;
 for(let offset=0;offset<10000;offset+=100){const {view,ms}=read({offset});assert.equal(view.total_matching,10000);assert.equal(view.returned,100);assert.equal(view.nodes.length,3);assert.equal(view.next_offset,offset===9900?null:offset+100);if(snapshot)assert.equal(view.snapshot_id,snapshot);else snapshot=view.snapshot_id;for(const t of view.tasks){assert.ok(!seen.has(t.task_uid));seen.add(t.task_uid);assert.equal(t.read_only,t.owner_node_id!==a.identity.node_id);}latencies.push(ms);}
 assert.equal(seen.size,10000);report.pagination=samples(latencies);
 report.filtered={};
 for(const [name,query,total] of [['project',{projectId:'load-project'},10000],['owner',{ownerNodeId:nodes[1].identity.node_id},3333],['search',{query:'load card 000'},300]]){const values=[];for(let i=0;i<20;i++){const {view,ms}=read(query);assert.equal(view.total_matching,total);values.push(ms);}report.filtered[name]=samples(values);}
 assert.equal(a.db.prepare('SELECT total_changes() n').get().n,changes);
 console.log(JSON.stringify({phase:'queries',pagination_p95_ms:report.pagination.p95_ms,filtered_p95_ms:Object.fromEntries(Object.entries(report.filtered).map(([k,v])=>[k,v.p95_ms]))}));
 // The receiver already has the prior cursor. Commit 1,000 changed cards while it is idle.
 const b=nodes[1],affected=b.ids.slice(0,1000);b.db.exec('BEGIN IMMEDIATE');try{for(const id of affected)store.update(b.db,{id,description:'catch-up '+'.'.repeat(248),expectedVersion:store.get(b.db,id).aggregate_version});b.db.exec('COMMIT');}catch(e){if(b.db.isTransaction)b.db.exec('ROLLBACK');throw e;}
 let bytes=0,eventCount=0,maxEventBytes=0;const fetchImpl=async(url,options)=>{const r=await fetch(url,options);if(String(url).endsWith('/pull')){const buf=await r.clone().arrayBuffer();bytes+=buf.byteLength;const batch=JSON.parse(Buffer.from(buf).toString('utf8'));eventCount+=batch.events?.length??0;for(const e of batch.events??[])maxEventBytes=Math.max(maxEventBytes,Buffer.byteLength(JSON.stringify(e)));}return r;};
 const catchup=performance.now(),sync=await drain(a,{...routes[0],fetchImpl});report.backlog={events:eventCount,response_bytes:bytes,max_event_bytes:maxEventBytes,elapsed_ms:elapsed(catchup),sync_calls:sync.calls,cursor:sync.result.cursor};
 assert.equal(eventCount,1000);assert.ok(bytes<=16*1024*1024);assert.ok(maxEventBytes<=16*1024);
 const known=b.db.prepare('SELECT t.task_uid,t.aggregate_version FROM tasks t ORDER BY id LIMIT 1000').all();
 const received=a.db.prepare('SELECT task_version,task_json FROM federation_replicas WHERE task_uid=?');
 for(const t of known){const replica=received.get(t.task_uid);assert.equal(replica.task_version,t.aggregate_version);assert.equal(JSON.parse(replica.task_json).description,'catch-up '+'.'.repeat(248));}
 assert.equal(b.db.prepare('SELECT offered_seq=acked_seq ok FROM federation_deliveries').get().ok,1);
 const before=readFleetView(a.db,{limit:100,now:fixedNow}),readPath=a.path;a.db.close();a.db=new DatabaseSync(readPath);handles.push(a.db);
 const after=readFleetView(a.db,{limit:100,now:fixedNow});assert.equal(after.snapshot_id,before.snapshot_id);assert.equal(after.total_matching,10000);assert.equal(rowCount(a.db,'tasks'),3334);assert.equal(rowCount(a.db,'task_runs'),0);
 for(const n of nodes)assert.equal(rowCount(n.db,'task_runs'),0);
 report.reopen_projection_digest=digest(after.tasks);report.database_bytes=nodes.map(n=>{let wal=0;try{wal=statSync(n.path+'-wal').size;}catch{}return {alias:n.identity.display_name,database:statSync(n.path).size,wal};});report.sampled_peak_rss_bytes=peakRss;
 report.proposed_threshold_results={all_query_p95_under_1000ms:[report.pagination,...Object.values(report.filtered)].every(x=>x.p95_ms<=1000),backlog_under_60000ms:report.backlog.elapsed_ms<=60000};report.correctness='passed';report.finished_at=new Date().toISOString();
 writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({phase:'complete',backlog:report.backlog,thresholds:report.proposed_threshold_results,correctness:report.correctness}));
 assert.ok(Object.values(report.proposed_threshold_results).every(Boolean),'Proposed local performance threshold missed; see preserved report.');
}catch(e){
 report.correctness=report.correctness??'failed';report.error={code:e.code??'ASSERTION',message:e.message};report.finished_at=new Date().toISOString();
 try{writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}catch{}throw e;
}finally{
 for(const s of servers)await new Promise(r=>{s.close(r);s.closeAllConnections();});for(const db of handles)try{db.close();}catch{}
 const part=relative(resolve(tmpdir()),resolve(dir));assert.ok(part&&!part.startsWith('..'));rmSync(dir,{recursive:true,force:true});
}
