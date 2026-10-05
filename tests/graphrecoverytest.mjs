import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {migratePeers,localIdentity,authenticate} from '../core/federation/peers.mjs';
import {issueCredential,listenPeerServer} from './helpers/peer-network.mjs';
import {migrateSync,digest,canonical} from '../core/federation/sync-store.mjs';
import {migrateBroker} from '../core/mcp/policy.mjs';
import {enrollTask} from '../core/mcp/tools.mjs';
import {migrateRelations,createRelationGraph,publishTopology,relationStatus,approveRelation,listRelationGraphs} from '../core/federation/relations.mjs';
import {migrateTopology,bindTopology,topologyState,prepareTopology,startTopologyAttempt,acceptTopologyReceipt} from '../core/federation/topology.mjs';
import {federationStuck} from '../core/inspection.mjs';
import {sendTopology} from '../core/federation/topology-client.mjs';
import {createBackup,restoreBackup} from '../core/backup.mjs';
import {prepareRecovery,activateRecovery,retireNode} from '../core/recovery.mjs';
const store=createRequire(import.meta.url)('../core/store.js'),TMP=mkdtempSync(join(tmpdir(),'fleet-graph-recovery-')),dbs=[],servers=[];let seq=0;
const moduleURL=new URL('../core/federation/graph-recovery.mjs',import.meta.url),api=existsSync(moduleURL)?await import(moduleURL):{};
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs)try{db.close();}catch{}const r=relative(resolve(tmpdir()),resolve(TMP));assert.ok(r&&!r.startsWith('..'));rmSync(TMP,{recursive:true,force:true});});
const path=n=>join(TMP,n+'-'+seq++);
function node(){const dir=path('node');mkdirSync(dir);const dbPath=join(dir,'board.db'),db=new DatabaseSync(dbPath);dbs.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);migrateRelations(db);migrateTopology(db);return {dir,dbPath,db,n:localIdentity(db)};}
function task(n,extra={}){const id=store.add(n.db,{subject:'fixture '+seq++,released:true,...extra}),t=store.get(n.db,id);enrollTask(n.db,{id,projectId:'demo',workKind:'implement',capabilities:['board-tools'],expectedVersion:t.aggregate_version});return store.get(n.db,id);}
function grant(a,r){const file=path('credential')+'.json',prior=r.db.prepare('SELECT credential_version FROM federation_peers WHERE peer_node_id=?').get(a.n.node_id);issueCredential(r.db,{peerNodeId:a.n.node_id,peerEpoch:a.n.sync_epoch,scopes:['peer:handshake','relations:read','relations:publish','relations:approve'],projects:['demo'],credentialFile:file,expectedVersion:prior?.credential_version});return {file,peer:authenticate(r.db,'Bearer '+JSON.parse(readFileSync(file,'utf8')).token)};}
function prepare(a){return prepareTopology(a.db,{projectId:'demo',operationId:randomUUID(),expectedRevision:topologyState(a.db,'demo').revision,edits:[]});}
function publish(a,r,g){const op=prepare(a),v=listRelationGraphs(r.db).find(x=>x.project_id==='demo').version,args=startTopologyAttempt(a.db,{operationId:op.operation_id,expectedVersion:v});return acceptTopologyReceipt(a.db,{operationId:op.operation_id,requestId:args.request_id,receipt:publishTopology(r.db,g.peer,args)});}
function setup(taskOptions={}){const a=node(),b=node(),r=node(),ta=task(a,taskOptions),tb=task(b),members=[a,b].map(n=>({node_id:n.n.node_id,node_epoch:n.n.sync_epoch})),g=createRelationGraph(r.db,{projectId:'demo',members}),ga=grant(a,r),gb=grant(b,r);for(const [n,c] of [[a,ga],[b,gb]]){bindTopology(n.db,{projectId:'demo',graphId:g.graph_id,graphEpoch:g.graph_epoch,registrarNodeId:r.n.node_id,registrarEpoch:r.n.sync_epoch});publish(n,r,c);}return {a,b,r,g,ga,gb,ta,tb,members};}
function restored(n){const evidence=path('evidence');mkdirSync(evidence);writeFileSync(join(evidence,'fixture.txt'),'only synthetic data');const backup=createBackup({dbPath:n.dbPath,evidenceDir:evidence,destination:path('backup')}),dir=path('restored');restoreBackup({backupDirectory:backup.destination,destination:dir});retireNode({dbPath:n.dbPath,expectedEpoch:n.n.sync_epoch});const dbPath=join(dir,'board.db'),p=prepareRecovery({dbPath});activateRecovery({dbPath,plan:p,expectedPlanDigest:p.plan_digest,attestation:{format:'ai-fleet-retirement-attestation/v1',node_id:p.node_id,retired_epoch:p.retired_epoch,plan_digest:p.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:'isolated graph recovery fixture',attested_at:new Date().toISOString()}});const db=new DatabaseSync(dbPath);dbs.push(db);return {dir,dbPath,db,n:localIdentity(db)};}
function apiReady(){for(const f of ['prepareGraphRecovery','recordGraphRecovery','prepareTopologyRecovery','recordTopologyRecovery'])assert.equal(typeof api[f],'function','graph recovery must provide '+f);}
const graphPlan=f=>api.prepareGraphRecovery(f.r.db,{projectId:'demo',members:f.members});
function attest(p){return {format:'ai-fleet-graph-recovery-attestation/v1',node_id:p.node_id,node_epoch:p.node_epoch,plan_digest:p.plan_digest,member_confirmations:p.members.map(m=>({...m,old_graph_id:p.old_graph_id,old_graph_epoch:p.old_graph_epoch,old_work_stopped:true,pending_requests_reconciled:true,evidence_ref:'fixture member confirmation',attested_at:new Date().toISOString()})),unrecorded_confirmations_reconciled:true,evidence_ref:'fixture registry reconciliation',attested_at:new Date().toISOString()};}
const recover=(f,p=graphPlan(f))=>api.recordGraphRecovery(f.r.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:attest(p)});
function adopt(a,receipt){const p=api.prepareTopologyRecovery(a.db,{projectId:'demo',graphReceipt:receipt});return api.recordTopologyRecovery(a.db,{plan:p,expectedPlanDigest:p.plan_digest});}
const history=(r,id)=>canonical(Object.fromEntries(['relation_graphs','relation_members','relation_topologies','relation_requests','relation_events'].map(t=>[t,r.db.prepare('SELECT * FROM '+t+' WHERE graph_id=? ORDER BY rowid').all(id)])));

test('restored registrar creates a reviewed successor and an endpoint republishes over HTTP without rewriting old graph history',async()=>{
 const f=setup();f.r=restored(f.r);f.ga=grant(f.a,f.r);assert.throws(()=>relationStatus(f.r.db,f.ga.peer,{project_id:'demo',graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:null}),{code:'GRAPH_RECOVERY_REQUIRED'});apiReady();const before=history(f.r,f.g.graph_id),ro=new DatabaseSync(f.r.dbPath,{readOnly:true});let p;try{p=api.prepareGraphRecovery(ro,{projectId:'demo',members:f.members});}finally{ro.close();}assert.deepEqual(p.blockers,[]);const receipt=recover(f,p);assert.equal(history(f.r,f.g.graph_id),before);assert.notEqual(receipt.graph.graph_id,f.g.graph_id);assert.equal(receipt.graph.registrar_epoch,f.r.n.sync_epoch);assert.equal(listRelationGraphs(f.r.db).length,1);assert.throws(()=>relationStatus(f.r.db,f.ga.peer,{project_id:'demo',graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id:null}),{code:'GRAPH_RETIRED'});
 const old=canonical(f.a.db.prepare('SELECT * FROM topology_bindings').get());adopt(f.a,receipt);assert.equal(canonical(f.a.db.prepare('SELECT * FROM topology_bindings').get()),old);assert.equal(topologyState(f.a.db,'demo').phase,'unregistered');assert.equal(store.get(f.a.db,f.ta.id).released,false);assert.equal(store.claimById(f.a.db,{id:f.ta.id,worker:'fixture'}).ok,false);
 const server=await listenPeerServer(f.r.db,{port:0});servers.push(server);const op=prepare(f.a),sent=await sendTopology(f.a.db,{operationId:op.operation_id,url:'http://127.0.0.1:'+server.address().port,credentialFile:f.ga.file});assert.equal(sent.state,'applied');assert.equal(topologyState(f.a.db,'demo').phase,'ready');assert.equal(store.claimById(f.a.db,{id:f.ta.id,worker:'fixture'}).ok,false);assert.equal(history(f.r,f.g.graph_id),before);assert.equal(f.a.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});

test('pending relations, incomplete member confirmations and changed registry state refuse graph recovery',()=>{
 apiReady();const f=setup(),d={schema_version:1,type:'delegation',relation_id:randomUUID(),delegation_id:randomUUID(),project_id:'demo',graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,source_node_id:f.a.n.node_id,source_epoch:f.a.n.sync_epoch,source_task_uid:f.ta.task_uid,target_node_id:f.b.n.node_id,target_epoch:f.b.n.sync_epoch,target_task_uid:f.tb.task_uid,offer_digest:'0'.repeat(64),source_topology_revision:1,target_topology_revision:1};approveRelation(f.r.db,f.ga.peer,{request_id:randomUUID(),expected_version:listRelationGraphs(f.r.db)[0].version,relation:d});f.r=restored(f.r);const p=graphPlan(f);assert.ok(p.blockers.some(b=>b.kind==='pending_relations'));assert.throws(()=>recover(f,p),{code:'GRAPH_RECOVERY_BLOCKED'});
 const clean=setup();clean.r=restored(clean.r);const plan=graphPlan(clean),a=attest(plan);a.member_confirmations.pop();assert.throws(()=>api.recordGraphRecovery(clean.r.db,{plan,expectedPlanDigest:plan.plan_digest,attestation:a}),{code:'MEMBER_CONFIRMATION_REQUIRED'});clean.r.db.prepare('UPDATE relation_graphs SET version=version+1').run();assert.throws(()=>recover(clean,plan),{code:'PLAN_STALE'});assert.equal(listRelationGraphs(clean.r.db)[0].graph_id,clean.g.graph_id);
});

test('restored owner adopts a new member epoch only after local pending operations are resolved and tasks stay held',()=>{
 apiReady();const f=setup();f.a=restored(f.a);f.members=f.members.map(m=>m.node_id===f.a.n.node_id?{...m,node_epoch:f.a.n.sync_epoch}:m);f.ga=grant(f.a,f.r);assert.throws(()=>topologyState(f.a.db,'demo'),{code:'TOPOLOGY_RECOVERY_REQUIRED'});const receipt=recover(f);const old=canonical(f.a.db.prepare('SELECT * FROM topology_bindings').get());adopt(f.a,receipt);assert.equal(canonical(f.a.db.prepare('SELECT * FROM topology_bindings').get()),old);assert.equal(topologyState(f.a.db,'demo').owner_epoch,f.a.n.sync_epoch);publish(f.a,f.r,f.ga);assert.equal(topologyState(f.a.db,'demo').phase,'ready');assert.equal(store.get(f.a.db,f.ta.id).human_gate,true);assert.throws(()=>f.a.db.prepare('UPDATE topology_binding_generations SET owner_epoch=?').run(randomUUID()),/immutable/);
 const busy=setup(),pending=prepare(busy.a);startTopologyAttempt(busy.a.db,{operationId:pending.operation_id,expectedVersion:listRelationGraphs(busy.r.db)[0].version});busy.r=restored(busy.r);const next=recover(busy),p=api.prepareTopologyRecovery(busy.a.db,{projectId:'demo',graphReceipt:next});assert.ok(p.blockers.some(b=>b.kind==='pending_topology'));assert.throws(()=>api.recordTopologyRecovery(busy.a.db,{plan:p,expectedPlanDigest:p.plan_digest}),{code:'TOPOLOGY_RECOVERY_BLOCKED'});assert.equal(topologyState(busy.a.db,'demo').phase,'pending');
});

test('ended unmanaged runs do not prove that endpoint executors stopped',()=>{
 apiReady();const f=setup();assert.equal(store.claimById(f.a.db,{id:f.ta.id,worker:'unmanaged-fixture'}).ok,true);f.a.db.prepare("UPDATE tasks SET status='waiting' WHERE id=?").run(f.ta.id);f.r=restored(f.r);const receipt=recover(f),p=api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:receipt});assert.ok(p.blockers.some(b=>b.kind==='unmanaged_run'));assert.throws(()=>api.recordTopologyRecovery(f.a.db,{plan:p,expectedPlanDigest:p.plan_digest}),{code:'TOPOLOGY_RECOVERY_BLOCKED'});
});
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cliPath=fileURLToPath(new URL('../cli/graph-recovery.mjs',import.meta.url));
function cli(command,dbPath,options){const r=spawnSync(process.execPath,[cliPath,command,'--db',dbPath,...Object.entries(options).flatMap(([k,v])=>['--'+k,v])],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function jsonFile(name,value){const file=path(name)+'.json';writeFileSync(file,JSON.stringify(value));return file;}
test('independent CLI commits idempotent generations, refuses forged receipts and rolls back failed endpoint persistence',()=>{
 apiReady();const f=setup();f.r=restored(f.r);const plan=cli('prepare-registrar',f.r.dbPath,{project:'demo','members-file':jsonFile('members',f.members)}),args={'plan-file':jsonFile('plan',plan),digest:plan.plan_digest,'attestation-file':jsonFile('attestation',attest(plan))},receipt=cli('apply-registrar',f.r.dbPath,args);assert.deepEqual(cli('apply-registrar',f.r.dbPath,args),receipt);assert.equal(f.r.db.prepare('SELECT count(*) n FROM relation_graph_transitions').get().n,1);
 const altered=structuredClone(receipt);altered.graph.registrar_epoch=randomUUID();assert.throws(()=>api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:altered}),{code:'RECEIPT_MISMATCH'});
 const p=cli('prepare-topology',f.a.dbPath,{project:'demo','receipt-file':jsonFile('receipt',receipt)}),before=canonical(store.get(f.a.db,f.ta.id));f.a.db.exec("CREATE TRIGGER fixture_fail_recovery BEFORE INSERT ON topology_recoveries BEGIN SELECT RAISE(ABORT,'fixture ledger failure'); END");assert.throws(()=>api.recordTopologyRecovery(f.a.db,{plan:p,expectedPlanDigest:p.plan_digest}),/fixture ledger failure/);assert.equal(canonical(store.get(f.a.db,f.ta.id)),before);assert.equal(f.a.db.prepare('SELECT count(*) n FROM topology_binding_generations').get().n,0);f.a.db.exec('DROP TRIGGER fixture_fail_recovery');const options={'plan-file':jsonFile('topology-plan',p),digest:p.plan_digest},result=cli('apply-topology',f.a.dbPath,options);assert.deepEqual(cli('apply-topology',f.a.dbPath,options),result);
 f.ga=grant(f.a,f.r);publish(f.a,f.r,f.ga);const t=store.get(f.a.db,f.ta.id);store.update(f.a.db,{id:t.id,expectedVersion:t.aggregate_version,humanGate:false,actor:'human'});store.setReleased(f.a.db,{id:t.id,expectedVersion:store.get(f.a.db,t.id).aggregate_version,released:true,actor:'human'});assert.equal(store.claimById(f.a.db,{id:t.id,worker:'explicitly-released-fixture'}).ok,true);
});
function pendingFixture({restoreOwner=false,hierarchy=false}={}) {
 const options=hierarchy?{treeMode:'hierarchical'}:{},f=setup(options),other=task(f.a,options);
 const edit=(t,deps)=>({task_uid:t.task_uid,expected_version:store.get(f.a.db,t.id).aggregate_version,parent_uid:hierarchy?(deps[0]?.task_uid??null):null,blocked_by:hierarchy?[]:deps.map(x=>x.task_uid)});
 const initial=prepareTopology(f.a.db,{projectId:'demo',operationId:randomUUID(),expectedRevision:1,edits:[edit(f.ta,[other])]});
 let args=startTopologyAttempt(f.a.db,{operationId:initial.operation_id,expectedVersion:listRelationGraphs(f.r.db)[0].version});
 acceptTopologyReceipt(f.a.db,{operationId:initial.operation_id,requestId:args.request_id,receipt:publishTopology(f.r.db,f.ga.peer,args)});
 const op=prepareTopology(f.a.db,{projectId:'demo',operationId:randomUUID(),expectedRevision:2,edits:[edit(f.ta,[]),edit(other,[f.ta])]});
 args=startTopologyAttempt(f.a.db,{operationId:op.operation_id,expectedVersion:listRelationGraphs(f.r.db)[0].version});
 const lostReceipt=publishTopology(f.r.db,f.ga.peer,args); // Registrar committed; owner never received this reply.
 if(restoreOwner){f.a=restored(f.a);f.members=f.members.map(m=>m.node_id===f.a.n.node_id?{...m,node_epoch:f.a.n.sync_epoch}:m);}
 f.r=restored(f.r);const receipt=recover(f);return {...f,other,op,args,lostReceipt,receipt};
}
function pendingAttestation(p){return {format:'ai-fleet-pending-topology-recovery-attestation/v1',node_id:p.node_id,node_epoch:p.node_epoch,plan_digest:p.plan_digest,operation_id:p.pending_resolution.operation_id,choice:p.pending_resolution.choice,old_graph_retired:true,remote_outcome_unknown:true,selected_structure_reviewed:true,evidence_ref:'isolated successor graph and structure review',attested_at:new Date().toISOString()};}
test('lost topology acknowledgement is explicitly superseded after registrar restore and republished without inventing a remote rejection',()=>{
 for(const choice of ['before','desired','intersection']) {
  const f=pendingFixture(),attemptBefore=canonical(f.a.db.prepare('SELECT * FROM topology_attempts WHERE request_id=?').get(f.args.request_id));
  const p=api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:f.receipt,pendingChoice:choice});
  assert.deepEqual(p.blockers,[],'explicit successor recovery must resolve the pending topology blocker');
  assert.equal(p.pending_resolution.choice,choice);
  const r=api.recordTopologyRecovery(f.a.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:pendingAttestation(p)});
  assert.equal(r.pending_resolution.remote_outcome,'unknown');assert.equal(r.automatic_release,false);
  assert.equal(federationStuck(f.a.db).items.filter(i=>i.category==='topology_attempt').length,0);
  assert.equal(canonical(f.a.db.prepare('SELECT * FROM topology_attempts WHERE request_id=?').get(f.args.request_id)),attemptBefore);
  assert.equal(f.a.db.prepare('SELECT state FROM topology_operations WHERE operation_id=?').get(f.op.operation_id).state,'cancelled');
  assert.deepEqual(store.get(f.a.db,f.ta.id).blocked_by,choice==='before'?[f.other.id]:[]);
  assert.deepEqual(store.get(f.a.db,f.other.id).blocked_by,choice==='desired'?[f.ta.id]:[]);
  assert.equal(topologyState(f.a.db,'demo').phase,'unregistered');assert.equal(store.claimById(f.a.db,{id:f.ta.id,worker:'fixture'}).ok,false);
  assert.throws(()=>acceptTopologyReceipt(f.a.db,{operationId:f.op.operation_id,requestId:f.args.request_id,receipt:f.lostReceipt}),{code:'RECEIPT_MISMATCH'});
  f.ga=grant(f.a,f.r);publish(f.a,f.r,f.ga);assert.equal(topologyState(f.a.db,'demo').phase,'ready');
  for(const t of [f.ta,f.other]){assert.equal(store.get(f.a.db,t.id).released,false);assert.equal(store.get(f.a.db,t.id).human_gate,true);}
  assert.equal(f.a.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
 }
});

const pendingState=db=>canonical(Object.fromEntries(['tasks','task_events','topology_operations','topology_attempts','topology_events','topology_holds','topology_bindings','topology_binding_generations','topology_recoveries','topology_write_permits'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()])));
test('pending topology recovery rejects absent or mismatched human choices and stale plans and rolls back every write on audit failure',()=>{
 const f=pendingFixture(),plan=()=>api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:f.receipt,pendingChoice:'desired'}),record=(p,a=pendingAttestation(p))=>api.recordTopologyRecovery(f.a.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:a});
 assert.throws(()=>api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:f.receipt,pendingChoice:'auto'}),{code:'BAD_INPUT'});
 let p=plan(),before=pendingState(f.a.db);assert.throws(()=>record(p,null),{code:'ATTESTATION_MISMATCH'});assert.throws(()=>record(p,{...pendingAttestation(p),choice:'before'}),{code:'ATTESTATION_MISMATCH'});assert.equal(pendingState(f.a.db),before);
 store.update(f.a.db,{id:f.ta.id,description:'review context changed'});before=pendingState(f.a.db);assert.throws(()=>record(p),{code:'PLAN_STALE'});assert.equal(pendingState(f.a.db),before);
 p=plan();const a=pendingAttestation(p);f.a.db.exec("CREATE TRIGGER fixture_pending_audit BEFORE INSERT ON topology_recoveries BEGIN SELECT RAISE(ABORT,'fixture pending recovery audit failure'); END");
 assert.throws(()=>record(p,a),/fixture pending recovery audit failure/);assert.equal(pendingState(f.a.db),before);assert.equal(federationStuck(f.a.db).items.filter(i=>i.category==='topology_attempt').length,1);
 f.a.db.exec('DROP TRIGGER fixture_pending_audit');const receipt=record(p,a);assert.deepEqual(record(p,a),receipt);assert.throws(()=>record(p,{...a,evidence_ref:'different reviewed evidence'}),{code:'REQUEST_CONFLICT'});
 assert.throws(()=>f.a.db.prepare('UPDATE topology_recoveries SET receipt_json=?').run('{}'),/immutable/);assert.throws(()=>f.a.db.prepare('DELETE FROM topology_recoveries').run(),/retained/);
 assert.throws(()=>f.a.db.prepare('UPDATE topology_operations SET desired_json=? WHERE operation_id=?').run('{}',f.op.operation_id),/terminal|immutable/);
 assert.equal(f.a.db.prepare('SELECT count(*) n FROM topology_write_permits').get().n,0);
});
test('pending parent reversal survives owner and registrar restore and retained unknown attempts do not block a later recovery',()=>{
 const f=pendingFixture({restoreOwner:true,hierarchy:true}),p=api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:f.receipt,pendingChoice:'desired'});
 assert.deepEqual(p.blockers,[]);api.recordTopologyRecovery(f.a.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:pendingAttestation(p)});
 assert.equal(topologyState(f.a.db,'demo').owner_epoch,f.a.n.sync_epoch);assert.equal(store.get(f.a.db,f.ta.id).parent_id,null);assert.equal(store.get(f.a.db,f.other.id).parent_id,f.ta.id);
 f.ga=grant(f.a,f.r);publish(f.a,f.r,f.ga);
 f.r=restored(f.r);const successor=recover(f),next=api.prepareTopologyRecovery(f.a.db,{projectId:'demo',graphReceipt:successor});assert.deepEqual(next.blockers,[]);api.recordTopologyRecovery(f.a.db,{plan:next,expectedPlanDigest:next.plan_digest});f.ga=grant(f.a,f.r);publish(f.a,f.r,f.ga);
 assert.equal(topologyState(f.a.db,'demo').generation,2);assert.equal(f.a.db.prepare('SELECT state FROM topology_attempts WHERE request_id=?').get(f.args.request_id).state,'pending');
 assert.equal(federationStuck(f.a.db).items.filter(i=>i.category==='topology_attempt').length,0);assert.equal(f.a.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);
});
test('pending topology CLI requires a separate human attestation and preserves read-only preparation',()=>{
 const f=pendingFixture(),before=pendingState(f.a.db),p=cli('prepare-topology',f.a.dbPath,{project:'demo','receipt-file':jsonFile('pending-graph-receipt',f.receipt),'pending-choice':'before'});assert.equal(pendingState(f.a.db),before);
 const file=jsonFile('pending-plan',p),r=spawnSync(process.execPath,[cliPath,'apply-topology','--db',f.a.dbPath,'--plan-file',file,'--digest',p.plan_digest],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr.trim()).code,'ATTESTATION_MISMATCH');assert.ok(!r.stderr.includes(f.a.dbPath));assert.equal(pendingState(f.a.db),before);
 const a=pendingAttestation(p),args={'plan-file':file,digest:p.plan_digest,'attestation-file':jsonFile('pending-attestation',a)},result=cli('apply-topology',f.a.dbPath,args);assert.equal(result.pending_resolution.choice,'before');assert.deepEqual(cli('apply-topology',f.a.dbPath,args),result);assert.equal(store.get(f.a.db,f.ta.id).released,false);
});
