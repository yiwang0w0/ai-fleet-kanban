import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cancellationClosureState} from '../core/federation/cancellation-closure.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {migratePeers,localIdentity,authenticate} from '../core/federation/peers.mjs';
import {issueCredential} from './helpers/peer-network.mjs';
import {digest,canonical} from '../core/federation/sync-store.mjs';
import {enrollTask} from '../core/mcp/tools.mjs';
import {migrateBindings,prepareBinding,bindingMessage,receiveBindingMessage,recordBindingMessage,startBindingAttempt,acceptBindingReceipt,bindingState} from '../core/federation/bindings.mjs';
import {createIntent,receiveOffer,decideIncoming,recordReceipt} from '../core/federation/delegation.mjs';
import {migrateRelations,createRelationGraph,publishTopology,approveRelation,relationStatus,localRegistrarPeer,listRelationGraphs} from '../core/federation/relations.mjs';
import {bindTopology,prepareTopology,startTopologyAttempt,acceptTopologyReceipt} from '../core/federation/topology.mjs';
import {migrateCancellations,prepareCancellation,receiveCancellation,confirmCancellationStopped,recordCancellationReceipt} from '../core/federation/cancellation.mjs';
import {prepareGraphRecovery,recordGraphRecovery,prepareTopologyRecovery,recordTopologyRecovery} from '../core/federation/graph-recovery.mjs';
import {createBackup,restoreBackup} from '../core/backup.mjs';
import {prepareRecovery,activateRecovery,retireNode} from '../core/recovery.mjs';
const store=createRequire(import.meta.url)('../core/store.js'),ROOT=mkdtempSync(join(tmpdir(),'fleet-contract-recovery-')),dbs=[];let serial=0;
const moduleURL=new URL('../core/federation/contract-recovery.mjs',import.meta.url),api=existsSync(moduleURL)?await import(moduleURL):{};
const path=label=>join(ROOT,label+'-'+serial++),at=()=>new Date().toISOString();
after(()=>{for(const db of dbs)try{db.close();}catch{}const p=relative(resolve(tmpdir()),resolve(ROOT));assert.ok(p&&!p.startsWith('..'));rmSync(ROOT,{recursive:true,force:true});});
function node(){const dir=path('node');mkdirSync(dir);const dbPath=join(dir,'board.db'),db=new DatabaseSync(dbPath);dbs.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');store.migrate(db);migratePeers(db);migrateBindings(db);migrateCancellations(db);migrateRelations(db);return {dir,dbPath,db,n:localIdentity(db)};}
function grant(a,b,scopes){const credentialFile=path('credential')+'.json';issueCredential(b.db,{peerNodeId:a.n.node_id,peerEpoch:a.n.sync_epoch,scopes,projects:['demo'],credentialFile,expectedVersion:b.db.prepare('SELECT credential_version FROM federation_peers WHERE peer_node_id=?').get(a.n.node_id)?.credential_version});return authenticate(b.db,'Bearer '+JSON.parse(readFileSync(credentialFile,'utf8')).token);}
function card(n){const id=store.add(n.db,{subject:'preserved work',description:'contract fixture',acceptance:'independent review',treeMode:'hierarchical',route:'mcp',released:true}),t=store.get(n.db,id);enrollTask(n.db,{id,projectId:'demo',workKind:'implement',capabilities:['board-tools'],expectedVersion:t.aggregate_version});return store.get(n.db,id);}
function fixture({stopped=true,localRegistrar=false}={}){
 const a=node(),b=node(),r=localRegistrar?a:node(),source=card(a),ab=grant(a,b,['peer:handshake','delegation:offer','delegation:status','delegation:binding','delegation:control']),ar=localRegistrar?localRegistrarPeer(a.db,'demo'):grant(a,r,['peer:handshake','relations:read','relations:approve','relations:publish']),br=grant(b,r,['peer:handshake','relations:read','relations:approve','relations:publish']);
 const out=createIntent(a.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:b.n.node_id,targetEpoch:b.n.sync_epoch});receiveOffer(b.db,ab,out.offer);const accepted=decideIncoming(b.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:'accept',note:'fixture'});recordReceipt(a.db,out.delegation_id,accepted);
 const target=store.get(b.db,b.db.prepare('SELECT id FROM tasks WHERE task_uid=?').get(accepted.target_task_uid).id),members=[a,b].map(n=>({node_id:n.n.node_id,node_epoch:n.n.sync_epoch})),g=createRelationGraph(r.db,{projectId:'demo',members});
 for(const [n,peer] of [[a,ar],[b,br]]){bindTopology(n.db,{projectId:'demo',graphId:g.graph_id,graphEpoch:g.graph_epoch,registrarNodeId:r.n.node_id,registrarEpoch:r.n.sync_epoch});const op=prepareTopology(n.db,{projectId:'demo',operationId:randomUUID(),expectedRevision:0}),args=startTopologyAttempt(n.db,{operationId:op.operation_id,expectedVersion:r.db.prepare('SELECT version FROM relation_graphs').get().version});acceptTopologyReceipt(n.db,{operationId:op.operation_id,requestId:args.request_id,receipt:publishTopology(r.db,peer,args)});}
 const d={schema_version:1,type:'delegation',relation_id:randomUUID(),delegation_id:out.delegation_id,project_id:'demo',graph_id:g.graph_id,graph_epoch:g.graph_epoch,source_node_id:a.n.node_id,source_epoch:a.n.sync_epoch,source_task_uid:source.task_uid,target_node_id:b.n.node_id,target_epoch:b.n.sync_epoch,target_task_uid:target.task_uid,offer_digest:out.offer_digest,source_topology_revision:1,target_topology_revision:1};
 const approve=(n,peer)=>{const args=startBindingAttempt(n.db,{relationId:d.relation_id,expectedVersion:r.db.prepare('SELECT version FROM relation_graphs').get().version});return acceptBindingReceipt(n.db,{relationId:d.relation_id,requestId:args.request_id,receipt:approveRelation(r.db,peer,args)});};
 const send=kind=>{const body=bindingMessage(a.db,{relationId:d.relation_id,kind});recordBindingMessage(a.db,{requestId:body.request_id,receipt:receiveBindingMessage(b.db,ab,body)});};
 prepareBinding(a.db,{relation:d,expectedTaskVersion:store.get(a.db,source.id).aggregate_version});approve(a,ar);send('proposal');prepareBinding(b.db,{relation:d,expectedTaskVersion:store.get(b.db,target.id).aggregate_version});approve(b,br);acceptBindingReceipt(a.db,{relationId:d.relation_id,receipt:relationStatus(r.db,ar,{project_id:'demo',graph_id:g.graph_id,graph_epoch:g.graph_epoch,relation_id:d.relation_id})});send('source_ready');
 const c=prepareCancellation(a.db,{relationId:d.relation_id,cancelId:randomUUID(),expectedTaskVersion:store.get(a.db,source.id).aggregate_version});recordCancellationReceipt(a.db,{relationId:d.relation_id,receipt:receiveCancellation(b.db,ab,c.request)});if(stopped){const stop=confirmCancellationStopped(b.db,d.relation_id);assert.deepEqual(stop.blockers,[]);recordCancellationReceipt(a.db,{relationId:d.relation_id,receipt:stop.receipt});}
 return {a,b,r,source,target,d,members,g};
}
function restored(n){const evidenceDir=path('evidence');mkdirSync(evidenceDir);writeFileSync(join(evidenceDir,'item.txt'),'preserved synthetic evidence');const backup=createBackup({dbPath:n.dbPath,evidenceDir,destination:path('backup')}),dir=path('restored');restoreBackup({backupDirectory:backup.destination,destination:dir});retireNode({dbPath:n.dbPath,expectedEpoch:n.n.sync_epoch});const dbPath=join(dir,'board.db'),p=prepareRecovery({dbPath});activateRecovery({dbPath,plan:p,expectedPlanDigest:p.plan_digest,attestation:{format:'ai-fleet-retirement-attestation/v1',node_id:p.node_id,retired_epoch:p.retired_epoch,plan_digest:p.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:'isolated restored registrar fixture',attested_at:at()}});const db=new DatabaseSync(dbPath);dbs.push(db);return {dir,dbPath,db,n:localIdentity(db)};}
function ready(){for(const name of ['prepareEndpointRecovery','recordEndpointRecovery','prepareRegistrarRecovery','recordRegistrarRecovery','prepareRecoverySettlement','recordRecoverySettlement'])assert.equal(typeof api[name],'function',name+' must provide the explicit recovery path');}
const attestations=new Map();
function attestation(p){if(attestations.has(p.plan_digest))return attestations.get(p.plan_digest);const a={format:'ai-fleet-contract-recovery-attestation/v1',node_id:p.node_id,node_epoch:p.node_epoch,plan_digest:p.plan_digest,old_registrar_disabled:true,endpoint_records_reviewed:true,no_automatic_release:true,evidence_ref:'isolated stopped contract recovery evidence',attested_at:at()};attestations.set(p.plan_digest,a);return a;}
function apply(fn,n,p){return fn(n.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:attestation(p)});}
function endpoints(f){return [f.a,f.b].map(n=>{const p=api.prepareEndpointRecovery(n.db,{relationId:f.d.relation_id,registrarEpoch:f.r.n.sync_epoch});return apply(api.recordEndpointRecovery,n,p);});}
function recover(f){const proofs=endpoints(f),p=api.prepareRegistrarRecovery(f.r.db,{relationId:f.d.relation_id,endpointReceipts:proofs});return {proofs,plan:p,receipt:apply(api.recordRegistrarRecovery,f.r,p)};}
function graph(f){const p=prepareGraphRecovery(f.r.db,{projectId:'demo',members:f.members});assert.deepEqual(p.blockers,[]);return recordGraphRecovery(f.r.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:{format:'ai-fleet-graph-recovery-attestation/v1',node_id:p.node_id,node_epoch:p.node_epoch,plan_digest:p.plan_digest,unrecorded_confirmations_reconciled:true,evidence_ref:'isolated reconciled graph',attested_at:at(),member_confirmations:p.members.map(m=>({...m,old_graph_id:p.old_graph_id,old_graph_epoch:p.old_graph_epoch,old_work_stopped:true,pending_requests_reconciled:true,evidence_ref:'isolated stopped member',attested_at:at()}))}});}

test('stopped confirmed contract survives registrar restore and explicit bilateral recovery unblocks graph without accepting or dispatching work',()=>{
 const f=fixture(),oldEdge=canonical(f.r.db.prepare('SELECT * FROM relation_edges').all()),oldBinding=JSON.parse(f.a.db.prepare('SELECT descriptor_json FROM delegation_bindings').get().descriptor_json);f.r=restored(f.r);
 assert.ok(prepareGraphRecovery(f.r.db,{projectId:'demo',members:f.members}).blockers.some(b=>b.kind==='active_relations'));
 ready();const {receipt}=recover(f);assert.equal(receipt.authority,'operator_reviewed_endpoint_receipts');assert.equal(receipt.accepted,false);assert.equal(receipt.automatic_release,false);
 for(const n of [f.a,f.b]){const p=api.prepareRecoverySettlement(n.db,{relationId:f.d.relation_id,registrarReceipt:receipt}),result=apply(api.recordRecoverySettlement,n,p);assert.deepEqual(apply(api.recordRecoverySettlement,n,p),result);assert.equal(result.accepted,false);assert.equal(n.db.prepare('SELECT count(*) n FROM task_runs').get().n,0);assert.equal(bindingState(n.db,f.d.relation_id).state,'cancelled');assert.equal(bindingState(n.db,f.d.relation_id).cancellation_recovery.phase,'recovered_cancelled');assert.equal(cancellationClosureState(n.db,f.d.relation_id).closure_phase,'recovered_cancelled');}
 assert.equal(canonical(f.r.db.prepare('SELECT * FROM relation_edges').all()),oldEdge);assert.deepEqual(JSON.parse(f.a.db.prepare('SELECT descriptor_json FROM delegation_bindings').get().descriptor_json),oldBinding);
 const next=graph(f);for(const n of [f.a,f.b]){const p=prepareTopologyRecovery(n.db,{projectId:'demo',graphReceipt:next});assert.deepEqual(p.blockers,[]);recordTopologyRecovery(n.db,{plan:p,expectedPlanDigest:p.plan_digest});const t=store.get(n.db,n===f.a?f.source.id:f.target.id);assert.equal(t.released,false);assert.equal(t.human_gate,true);assert.equal(store.claimById(n.db,{id:t.id,worker:'must-not-run'}).ok,false);}
});

const tableCount=(db,t)=>db.prepare('SELECT count(*) n FROM '+t).get().n;
const hasSchema=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='contract_recovery_schema'").get();
const rehash=d=>{const {receipt_digest,...body}=d;return {...body,receipt_digest:digest(body)};};
function cli(command,n,options={}){return spawnSync(process.execPath,[fileURLToPath(new URL('../cli/contract-recovery.mjs',import.meta.url)),command,'--db',n.dbPath,...Object.entries(options).flatMap(([k,v])=>['--'+k,String(v)])],{encoding:'utf8',windowsHide:true});}
function jsonFile(label,value){const p=path(label)+'.json';writeFileSync(p,JSON.stringify(value));return p;}

test('read-only plans and missing stop, stale task or changed attestation cannot record recovery',()=>{
 ready();const stopped=fixture({stopped:false});stopped.r=restored(stopped.r);for(const n of [stopped.a,stopped.b])assert.throws(()=>api.prepareEndpointRecovery(n.db,{relationId:stopped.d.relation_id,registrarEpoch:stopped.r.n.sync_epoch}),{code:'STOP_UNCONFIRMED'});
 const f=fixture();assert.throws(()=>api.prepareEndpointRecovery(f.a.db,{relationId:f.d.relation_id,registrarEpoch:f.r.n.sync_epoch}),{code:'REGISTRAR_EPOCH_MISMATCH'});f.r=restored(f.r);
 const n=f.a,p=api.prepareEndpointRecovery(n.db,{relationId:f.d.relation_id,registrarEpoch:f.r.n.sync_epoch});assert.equal(hasSchema(n.db),false);
 assert.throws(()=>api.recordEndpointRecovery(n.db,{plan:p,expectedPlanDigest:p.plan_digest,attestation:{...attestation(p),old_registrar_disabled:false}}),{code:'ATTESTATION_MISMATCH'});
 store.update(n.db,{id:f.source.id,humanGate:true,expectedVersion:store.get(n.db,f.source.id).aggregate_version,actor:'human'});assert.throws(()=>apply(api.recordEndpointRecovery,n,p),{code:'PLAN_STALE'});assert.equal(hasSchema(n.db),false);
 const q=api.prepareEndpointRecovery(n.db,{relationId:f.d.relation_id,registrarEpoch:f.r.n.sync_epoch}),v=apply(api.recordEndpointRecovery,n,q);assert.deepEqual(apply(api.recordEndpointRecovery,n,q),v);assert.equal(tableCount(n.db,'contract_recovery_votes'),1);
});

test('registrar and endpoint reject incomplete, mismatched or substituted bilateral proof',()=>{
 ready();const f=fixture();f.r=restored(f.r);const proofs=endpoints(f);
 for(const bad of [[proofs[0]],[proofs[0],proofs[0]],[proofs[0],rehash({...proofs[1],observed_registrar_epoch:randomUUID()})],[proofs[0],rehash({...proofs[1],confirmation_digest:'a'.repeat(64)})]])assert.throws(()=>api.prepareRegistrarRecovery(f.r.db,{relationId:f.d.relation_id,endpointReceipts:bad}));
 assert.equal(hasSchema(f.r.db),false);const p=api.prepareRegistrarRecovery(f.r.db,{relationId:f.d.relation_id,endpointReceipts:proofs}),receipt=apply(api.recordRegistrarRecovery,f.r,p);assert.deepEqual(apply(api.recordRegistrarRecovery,f.r,p),receipt);
 const forged=rehash({...receipt,endpoint_receipts:[proofs[0],rehash({...proofs[1],side:'source'})]});assert.throws(()=>api.prepareRecoverySettlement(f.a.db,{relationId:f.d.relation_id,registrarReceipt:forged}),{code:'ENDPOINT_CONFIRMATION_REQUIRED'});
 assert.equal(f.a.db.prepare('SELECT closed FROM delegation_bindings').get().closed,0);assert.equal(tableCount(f.a.db,'binding_cancellations'),0);
});

test('an audit write failure rolls back endpoint task controls and binding closure, then the same plan retries once',()=>{
 ready();const f=fixture();f.r=restored(f.r);const proofs=endpoints(f),rp=api.prepareRegistrarRecovery(f.r.db,{relationId:f.d.relation_id,endpointReceipts:proofs});api.migrateContractRecovery(f.r.db);
 f.r.db.exec("CREATE TRIGGER fixture_registrar_failure BEFORE INSERT ON contract_recovery_retirements BEGIN SELECT RAISE(ABORT,'fixture registrar commit failure'); END");assert.throws(()=>apply(api.recordRegistrarRecovery,f.r,rp),/fixture registrar commit failure/);assert.equal(tableCount(f.r.db,'contract_recovery_retirements'),0);assert.ok(prepareGraphRecovery(f.r.db,{projectId:'demo',members:f.members}).blockers.some(b=>b.kind==='active_relations'));f.r.db.exec('DROP TRIGGER fixture_registrar_failure');const receipt=apply(api.recordRegistrarRecovery,f.r,rp),n=f.a,p=api.prepareRecoverySettlement(n.db,{relationId:f.d.relation_id,registrarReceipt:receipt}),before=canonical(store.get(n.db,f.source.id));
 n.db.exec("CREATE TRIGGER fixture_recovery_failure BEFORE INSERT ON binding_events WHEN NEW.kind='recovery_settled' BEGIN SELECT RAISE(ABORT,'fixture recovery commit failure'); END");
 assert.throws(()=>apply(api.recordRecoverySettlement,n,p),/fixture recovery commit failure/);assert.equal(canonical(store.get(n.db,f.source.id)),before);assert.equal(n.db.prepare('SELECT closed FROM delegation_bindings').get().closed,0);assert.equal(tableCount(n.db,'binding_cancellations'),0);assert.equal(tableCount(n.db,'contract_recovery_settlements'),0);
 n.db.exec('DROP TRIGGER fixture_recovery_failure');const done=apply(api.recordRecoverySettlement,n,p);assert.deepEqual(apply(api.recordRecoverySettlement,n,p),done);assert.equal(tableCount(n.db,'binding_cancellations'),1);assert.equal(tableCount(n.db,'contract_recovery_settlements'),1);assert.equal(store.get(n.db,f.source.id).released,false);assert.equal(store.get(n.db,f.source.id).human_gate,true);
 for(const table of ['contract_recovery_votes','contract_recovery_settlements']){assert.throws(()=>n.db.prepare('UPDATE '+table+" SET receipt_json='{}'").run(),/immutable/);assert.throws(()=>n.db.prepare('DELETE FROM '+table).run(),/retained/);}assert.throws(()=>f.r.db.prepare('DELETE FROM contract_recovery_retirements').run(),/retained/);
});

test('local CLI carries explicit plans and independent receipts without treating files as signed remote proof',()=>{
 ready();const f=fixture();f.r=restored(f.r);const proofs=[];
 for(const n of [f.a,f.b]){const output=cli('prepare-endpoint',n,{relation:f.d.relation_id,'registrar-epoch':f.r.n.sync_epoch});assert.equal(output.status,0,output.stderr);const p=JSON.parse(output.stdout);assert.equal(hasSchema(n.db),false);const result=cli('record-endpoint',n,{'plan-file':jsonFile('endpoint-plan',p),digest:p.plan_digest,'attestation-file':jsonFile('endpoint-attestation',attestation(p))});assert.equal(result.status,0,result.stderr);proofs.push(JSON.parse(result.stdout));}
 const prepared=cli('prepare-registrar',f.r,{relation:f.d.relation_id,'receipts-file':jsonFile('endpoints',proofs)});assert.equal(prepared.status,0,prepared.stderr);const p=JSON.parse(prepared.stdout),recorded=cli('record-registrar',f.r,{'plan-file':jsonFile('registrar-plan',p),digest:p.plan_digest,'attestation-file':jsonFile('registrar-attestation',attestation(p))});assert.equal(recorded.status,0,recorded.stderr);const receipt=JSON.parse(recorded.stdout);
 for(const n of [f.a,f.b]){const prepared=cli('prepare-settlement',n,{relation:f.d.relation_id,'receipt-file':jsonFile('registrar-receipt',receipt)});assert.equal(prepared.status,0,prepared.stderr);const p=JSON.parse(prepared.stdout),result=cli('record-settlement',n,{'plan-file':jsonFile('settlement-plan',p),digest:p.plan_digest,'attestation-file':jsonFile('settlement-attestation',attestation(p))});assert.equal(result.status,0,result.stderr);const status=cli('status',n,{relation:f.d.relation_id});assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).phase,'recovered_cancelled');}
 const bad=cli('prepare-endpoint',f.a,{relation:f.d.relation_id,'registrar-epoch':f.r.n.sync_epoch,'private-unexpected-option':'PRIVATE_SENTINEL'});assert.equal(bad.status,1);assert.ok(!bad.stderr.includes('PRIVATE_SENTINEL'));assert.ok(!bad.stderr.includes(f.a.dbPath));
});

test('two-node deployment with source also registrar recovers old-epoch bindings and only explicit source release enables new work',()=>{
 ready();const f=fixture({localRegistrar:true});f.a=restored(f.a);f.r=f.a;f.members=[f.a,f.b].map(n=>({node_id:n.n.node_id,node_epoch:n.n.sync_epoch}));const {receipt}=recover(f);
 for(const n of [f.a,f.b]){const p=api.prepareRecoverySettlement(n.db,{relationId:f.d.relation_id,registrarReceipt:receipt});apply(api.recordRecoverySettlement,n,p);assert.equal(api.contractRecoveryState(n.db,f.d.relation_id).phase,'recovered_cancelled');assert.equal(n.db.prepare('SELECT closed FROM delegation_bindings').get().closed,1);assert.equal(tableCount(n.db,'task_runs'),0);}
 const next=graph(f);for(const n of [f.a,f.b]){const p=prepareTopologyRecovery(n.db,{projectId:'demo',graphReceipt:next});recordTopologyRecovery(n.db,{plan:p,expectedPlanDigest:p.plan_digest});const op=prepareTopology(n.db,{projectId:'demo',operationId:randomUUID(),expectedRevision:0}),peer=n===f.r?localRegistrarPeer(n.db,'demo'):grant(n,f.r,['peer:handshake','relations:read','relations:approve','relations:publish']),args=startTopologyAttempt(n.db,{operationId:op.operation_id,expectedVersion:listRelationGraphs(f.r.db)[0].version});acceptTopologyReceipt(n.db,{operationId:op.operation_id,requestId:args.request_id,receipt:publishTopology(f.r.db,peer,args)});}
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:'not-released'}).ok,false);assert.equal(store.claimById(f.b.db,{id:f.target.id,worker:'cancelled-target'}).ok,false);
 store.update(f.a.db,{id:f.source.id,humanGate:false,expectedVersion:store.get(f.a.db,f.source.id).aggregate_version,actor:'human'});store.setReleased(f.a.db,{id:f.source.id,released:true,expectedVersion:store.get(f.a.db,f.source.id).aggregate_version,actor:'human'});assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:'explicit-local-owner'}).ok,true);assert.equal(tableCount(f.b.db,'task_runs'),0);
});
