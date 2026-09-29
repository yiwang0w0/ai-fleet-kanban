import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn,spawnSync} from "node:child_process";
import http from "node:http";
import {migratePeers,issueCredential,authenticate,localIdentity,revokePeer} from "../core/federation/peers.mjs";
import {migrateSync,digest} from "../core/federation/sync-store.mjs";
import {migrateBroker} from "../core/mcp/policy.mjs";
import {enrollTask} from "../core/mcp/tools.mjs";
import {listenPeerServer} from "../core/federation/gateway.mjs";
import {migrateRelations,createRelationGraph,localRegistrarPeer,listRelationGraphs,normalizeTopology,normalizeRelation,validateCombinedGraph,publishTopology,approveRelation,withdrawRelation,relationStatus,previewTopology,MAX_GRAPH_VERTICES,MAX_GRAPH_EDGES,MAX_PENDING_RELATIONS} from "../core/federation/relations.mjs";
import {migrateDelegation,createIntent,receiveOffer,decideIncoming,incomingStatus} from "../core/federation/delegation.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-relations-")),dbs=[],servers=[];let serial=0;
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function fixture(){const dir=join(TMP,"node-"+serial++);mkdirSync(dir);const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migratePeers(db);migrateSync(db);migrateBroker(db);migrateRelations(db);return {dir,dbPath,db,node:localIdentity(db)};}
const scopes=["peer:handshake","relations:publish","relations:approve","relations:read"];
const member=f=>({node_id:f.node.node_id,node_epoch:f.node.sync_epoch});
const vertex=f=>({task_uid:f.node.node_id+"/"+randomUUID(),parent_uid:null,blocked_by:[]});
function grant(a,r,extra={}){const file=join(TMP,"peer-"+serial+++".json");issueCredential(r.db,{peerNodeId:a.node.node_id,peerEpoch:a.node.sync_epoch,scopes,projects:["demo"],credentialFile:file,...extra});const c=JSON.parse(readFileSync(file,"utf8"));return {file,auth:"Bearer "+c.token,peer:authenticate(r.db,"Bearer "+c.token)};}
function graphArgs(f,relation_id=null){return {project_id:f.g.project_id,graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,relation_id};}
function topology(f,owner,vertices,revision=1){return {schema_version:1,project_id:f.g.project_id,graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,owner_node_id:owner.node.node_id,owner_epoch:owner.node.sync_epoch,revision,vertices};}
function current(f){return f.r.db.prepare("SELECT version FROM relation_graphs WHERE graph_id=?").get(f.g.graph_id).version;}
function publish(f,who,s,extra={}){return publishTopology(f.r.db,f[who+"g"].peer,{request_id:randomUUID(),expected_version:current(f),snapshot:s,...extra});}
function pending(f,who,d,extra={}){return approveRelation(f.r.db,f[who+"g"].peer,{request_id:randomUUID(),expected_version:current(f),relation:d,...extra});}
function descriptor(f,from=f.av[0],to=f.bv[0],extra={}){return {schema_version:1,type:"delegation",relation_id:randomUUID(),delegation_id:randomUUID(),project_id:f.g.project_id,graph_id:f.g.graph_id,graph_epoch:f.g.graph_epoch,source_node_id:f.a.node.node_id,source_epoch:f.a.node.sync_epoch,source_task_uid:from.task_uid,target_node_id:f.b.node.node_id,target_epoch:f.b.node.sync_epoch,target_task_uid:to.task_uid,offer_digest:digest({fixture:"declared contract"}),source_topology_revision:1,target_topology_revision:1,...extra};}
function pair({publishNow=true}={}){const r=fixture(),a=fixture(),b=fixture(),g=createRelationGraph(r.db,{projectId:"demo",members:[member(a),member(b)]}),ag=grant(a,r),bg=grant(b,r),f={r,a,b,g,ag,bg,av:[vertex(a),vertex(a)],bv:[vertex(b),vertex(b)]};if(publishNow){publish(f,"a",topology(f,a,f.av));publish(f,"b",topology(f,b,f.bv));}return f;}
const count=(db,table)=>db.prepare("SELECT count(*) n FROM "+table).get().n;
const tableNames=["relation_graphs","relation_members","relation_topologies","relation_vertex_locations","relation_proposals","relation_approvals","relation_edges","relation_withdrawals","relation_requests","relation_events"];
const state=db=>JSON.stringify(Object.fromEntries(tableNames.map(t=>[t,db.prepare("SELECT * FROM "+t+" ORDER BY rowid").all()])));
function card(f,extra={},projectId="demo"){const id=store.add(f.db,{subject:"private title",description:"private work description",treeMode:"hierarchical",released:0,...extra}),t=store.get(f.db,id);enrollTask(f.db,{id,projectId,workKind:"implement",capabilities:["board-tools"],expectedVersion:t.aggregate_version});return store.get(f.db,id);}
async function network(f){const s=await listenPeerServer(f.db,{port:0});servers.push(s);return {server:s,url:"http://127.0.0.1:"+s.address().port};}
async function post(url,path,auth,body){const r=await fetch(url+"/peer/v1/relations/"+path,{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}

test("project graph identity and exact member epochs cannot be implicitly replaced",()=>{
 const f=pair({publishNow:false});assert.equal(f.g.version,1);assert.equal(count(f.r.db,"relation_events"),1);
 assert.throws(()=>createRelationGraph(f.r.db,{projectId:"demo",members:[member(f.a)]}),{code:"CONFLICT"});
 assert.throws(()=>createRelationGraph(f.r.db,{projectId:"other",members:[member(f.a),member(f.a)]}),{code:"BAD_INPUT"});
 assert.throws(()=>createRelationGraph(f.r.db,{projectId:"other",members:[{...member(f.r),node_epoch:randomUUID()}]}),{code:"IDENTITY_MISMATCH"});
 assert.equal(count(f.r.db,"relation_graphs"),1);
 assert.throws(()=>relationStatus(f.r.db,f.ag.peer,{...graphArgs(f),graph_epoch:randomUUID()}),{code:"GRAPH_MISMATCH"});
 assert.equal(relationStatus(f.r.db,localRegistrarPeer(f.r.db,"demo"),graphArgs(f)).vertices,0);
 assert.throws(()=>publishTopology(f.r.db,localRegistrarPeer(f.r.db,"demo"),{request_id:randomUUID(),expected_version:1,snapshot:topology(f,f.r,[])}),{code:"FORBIDDEN"});
});
test("only explicitly scoped project members may publish their own topology",()=>{
 const f=pair({publishNow:false}),c=fixture(),cg=grant(c,f.r),s=topology(f,f.a,f.av),before=state(f.r.db);
 for(const [peer,snapshot,code] of [
  [cg.peer,s,"FORBIDDEN"],[{...f.ag.peer,projects:["other"]},s,"FORBIDDEN"],
  [{...f.ag.peer,scopes:["sync:pull"]},s,"FORBIDDEN"],
  [f.ag.peer,topology(f,f.b,f.bv),"OWNER_MISMATCH"],
  [f.ag.peer,{...s,owner_epoch:randomUUID()},"OWNER_MISMATCH"]
 ])assert.throws(()=>publishTopology(f.r.db,peer,{request_id:randomUUID(),expected_version:1,snapshot}),{code});
 assert.equal(state(f.r.db),before);
 revokePeer(f.r.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
 assert.throws(()=>publish(f,"a",s),{code:"AUTHORIZATION_CHANGED"});
});
test("topology wire validation rejects missing, foreign, duplicate and private fields",()=>{
 const f=pair({publishNow:false}),s=topology(f,f.a,f.av);
 for(const [snapshot,code] of [
  [{...s,command:"shell"},"BAD_INPUT"],[{...s,revision:0},"BAD_INPUT"],
  [{...s,vertices:[f.bv[0]]},"OWNER_MISMATCH"],
  [{...s,vertices:[f.av[0],f.av[0]]},"BAD_INPUT"],
  [{...s,vertices:[{...f.av[0],description:"private"}]},"BAD_INPUT"],
  [{...s,vertices:[{...f.av[0],blocked_by:[f.av[1].task_uid]}]},"MISSING_LOCAL_REFERENCE"],
  [{...s,vertices:[{...f.av[0],blocked_by:[f.av[1].task_uid,f.av[1].task_uid]},f.av[1]]},"BAD_INPUT"]
 ])assert.throws(()=>normalizeTopology(snapshot),{code});
 const reversed={...s,vertices:[...s.vertices].reverse()};assert.deepEqual(normalizeTopology(reversed),normalizeTopology(s));
});
test("preview uses only explicitly enrolled task identities and diagnoses mixed local cycles",()=>{
 const f=pair({publishNow:false}),root=card(f.a),child=card(f.a,{parentId:root.id});
 const args={projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,revision:1};
 const before=JSON.stringify(f.a.db.prepare("SELECT * FROM tasks ORDER BY id").all()),p=previewTopology(f.a.db,args);
 assert.equal(p.frozen,false);assert.equal(p.dispatch_ready,false);assert.equal(p.snapshot.vertices.length,2);
 assert.ok(!JSON.stringify(p).includes("private"));assert.equal(JSON.stringify(f.a.db.prepare("SELECT * FROM tasks ORDER BY id").all()),before);
 f.a.db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run(JSON.stringify([root.id]),child.id);
 assert.throws(()=>previewTopology(f.a.db,args),{code:"RELATION_CYCLE"});
 f.a.db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run("[]",child.id);
 const foreign=card(f.a,{},"other");
 f.a.db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run(JSON.stringify([foreign.id]),child.id);
 assert.throws(()=>previewTopology(f.a.db,args),{code:"MISSING_LOCAL_REFERENCE"});
 assert.equal(count(f.a.db,"relation_topologies"),0);assert.equal(count(f.a.db,"task_runs"),0);
});
test("graph validation includes parent and blocked-by edges and deduplicates identical wait edges",()=>{
 const f=pair({publishNow:false}),v=f.av;
 v[1].parent_uid=v[0].task_uid;v[0].blocked_by=[v[1].task_uid];
 const s=topology(f,f.a,v);assert.equal(validateCombinedGraph([s]).edges,1);
 v[1].blocked_by=[v[0].task_uid];assert.throws(()=>validateCombinedGraph([s]),{code:"RELATION_CYCLE"});
 v[1].blocked_by=[];assert.throws(()=>validateCombinedGraph([s],[{from_uid:v[0].task_uid,to_uid:f.bv[0].task_uid}]),{code:"DANGLING_RELATION"});
 v[1].parent_uid=v[1].task_uid;assert.throws(()=>validateCombinedGraph([s]),{code:"RELATION_CYCLE"});
});
test("bounded iterative graph traversal supports ten thousand vertices and enforces edge limits",()=>{
 const n=fixture(),v=Array.from({length:MAX_GRAPH_VERTICES},()=>vertex(n));
 for(let i=1;i<v.length;i++)v[i].parent_uid=v[i-1].task_uid;
 assert.equal(validateCombinedGraph([{vertices:v}]).vertices,MAX_GRAPH_VERTICES);
 assert.throws(()=>validateCombinedGraph([{vertices:[...v,vertex(n)]}]),{code:"GRAPH_LIMIT"});
 const dense=Array.from({length:449},()=>vertex(n));for(let i=0;i<dense.length;i++)dense[i].blocked_by=dense.slice(i+1).map(x=>x.task_uid);
 assert.throws(()=>validateCombinedGraph([{vertices:dense}]),{code:"GRAPH_LIMIT"});
 assert.throws(()=>validateCombinedGraph([] ,Array(MAX_GRAPH_EDGES+1).fill({})),{code:"GRAPH_LIMIT"});
});
test("publication uses CAS, exact revisions, normalized retry receipts and immutable project ownership",()=>{
 const f=pair({publishNow:false}),s=topology(f,f.a,f.av),args={request_id:randomUUID(),expected_version:1,snapshot:s};
 const first=publishTopology(f.r.db,f.ag.peer,args);assert.equal(first.graph_version,2);
 assert.deepEqual(publishTopology(f.r.db,f.ag.peer,{...args,snapshot:{...s,vertices:[...s.vertices].reverse()}}),first);
 assert.equal(count(f.r.db,"relation_requests"),1);
 assert.throws(()=>publishTopology(f.r.db,f.ag.peer,{...args,expected_version:2}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>publish(f,"b",topology(f,f.b,f.bv),{expected_version:1}),{code:"GRAPH_VERSION_CONFLICT"});
 assert.throws(()=>publish(f,"a",s),{code:"TOPOLOGY_VERSION_CONFLICT"});
 publish(f,"a",topology(f,f.a,[],2));
 const other=createRelationGraph(f.r.db,{projectId:"other",members:[member(f.a)]});
 f.ag=grant(f.a,f.r,{projects:["demo","other"],expectedVersion:1});
 assert.throws(()=>publishTopology(f.r.db,f.ag.peer,{request_id:randomUUID(),expected_version:1,snapshot:{...s,project_id:"other",graph_id:other.graph_id,graph_epoch:other.graph_epoch}}),{code:"OWNER_MISMATCH"});
});
test("failed publication rolls back topology, ownership, version, events and receipts even inside a transaction",()=>{
 const f=pair({publishNow:false}),before=state(f.r.db);
 f.r.db.exec("CREATE TRIGGER injected BEFORE INSERT ON relation_requests BEGIN SELECT RAISE(ABORT,'injected request'); END; BEGIN IMMEDIATE");
 assert.throws(()=>publish(f,"a",topology(f,f.a,f.av)),/injected request/);f.r.db.exec("COMMIT");
 assert.equal(state(f.r.db),before);f.r.db.exec("DROP TRIGGER injected");assert.equal(publish(f,"a",topology(f,f.a,f.av)).graph_version,2);
});
test("independent source and target approvals bind the declared offer without authorizing dispatch",()=>{
 const f=pair(),d=descriptor(f),v=current(f),first=pending(f,"a",d);
 assert.equal(first.confirmed,false);assert.deepEqual(first.approved_by,[f.a.node.node_id]);assert.equal(current(f),v);assert.equal(count(f.r.db,"relation_edges"),0);
 assert.equal(pending(f,"a",d).confirmed,false);assert.equal(count(f.r.db,"relation_approvals"),1);
 const r=pending(f,"b",d);assert.equal(r.confirmed,true);assert.equal(r.dispatch_ready,false);assert.equal(r.graph_version,v+1);
 assert.equal(r.approved_by.length,2);assert.ok(r.approved_by.every(x=>x.credential_version===1));assert.deepEqual(r.relation,d);
 assert.equal(count(f.a.db,"tasks")+count(f.b.db,"tasks"),0);
 assert.equal(count(f.a.db,"task_runs")+count(f.b.db,"task_runs"),0);
 assert.deepEqual(pending(f,"a",d,{expected_version:1}),r);
 assert.throws(()=>pending(f,"a",{...d,relation_id:randomUUID()}),{code:"DELEGATION_ALREADY_REGISTERED"});
});
test("changed request bodies, foreign endpoints and stale topology approvals cannot confirm",()=>{
 const f=pair(),d=descriptor(f),id=randomUUID(),first=pending(f,"a",d,{request_id:id});
 assert.deepEqual(pending(f,"a",d,{request_id:id}),first);
 assert.throws(()=>pending(f,"a",{...d,offer_digest:digest("changed")}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>pending(f,"a",d,{request_id:id,expected_version:1}),{code:"REQUEST_CONFLICT"});
 assert.throws(()=>pending(f,"a",descriptor(f,{task_uid:f.a.node.node_id+"/"+randomUUID()})),{code:"DANGLING_RELATION"});
 assert.throws(()=>normalizeRelation({...d,target_task_uid:f.av[0].task_uid}),{code:"OWNER_MISMATCH"});
 publish(f,"a",topology(f,f.a,f.av,2));
 assert.throws(()=>pending(f,"b",d),{code:"TOPOLOGY_VERSION_CONFLICT"});assert.equal(count(f.r.db,"relation_edges"),0);
});
test("either endpoint may withdraw a stale attempt and reconfirm a new revision without erasing history",()=>{
 const f=pair(),d=descriptor(f);pending(f,"a",d);publish(f,"a",topology(f,f.a,f.av,2));
 const args={request_id:randomUUID(),...graphArgs(f,d.relation_id)};
 const w=withdrawRelation(f.r.db,f.bg.peer,args);assert.equal(w.kind,"relation_withdrawn");assert.deepEqual(withdrawRelation(f.r.db,f.bg.peer,args),w);
 assert.equal(relationStatus(f.r.db,f.ag.peer,graphArgs(f)).pending,0);
 assert.equal(relationStatus(f.r.db,f.ag.peer,graphArgs(f,d.relation_id)).kind,"relation_withdrawn");
 assert.throws(()=>pending(f,"b",d),{code:"RELATION_WITHDRAWN"});
 const retry={...d,relation_id:randomUUID(),source_topology_revision:2};pending(f,"a",retry);assert.equal(pending(f,"b",retry).confirmed,true);
 assert.equal(count(f.r.db,"relation_proposals"),2);
 assert.throws(()=>withdrawRelation(f.r.db,f.ag.peer,{request_id:randomUUID(),...graphArgs(f,retry.relation_id)}),{code:"RELATION_CONFIRMED"});
 assert.throws(()=>f.r.db.prepare("DELETE FROM relation_withdrawals").run(),/retention/);
});
test("withdrawal and confirmation each roll back atomically if receipt storage fails",()=>{
 const f=pair(),d=descriptor(f);pending(f,"a",d);const before=state(f.r.db);
 f.r.db.exec("CREATE TRIGGER injected BEFORE INSERT ON relation_requests BEGIN SELECT RAISE(ABORT,'injected request'); END");
 assert.throws(()=>pending(f,"b",d),/injected request/);assert.equal(state(f.r.db),before);
 assert.throws(()=>withdrawRelation(f.r.db,f.bg.peer,{request_id:randomUUID(),...graphArgs(f,d.relation_id)}),/injected request/);assert.equal(state(f.r.db),before);
 f.r.db.exec("DROP TRIGGER injected");assert.equal(pending(f,"b",d).confirmed,true);
});
test("credential rotation invalidates a pending approval until its owner confirms under the new grant",()=>{
 const f=pair(),d=descriptor(f);pending(f,"a",d);f.ag=grant(f.a,f.r,{expectedVersion:1});
 const p=pending(f,"b",d);assert.equal(p.confirmed,false);assert.deepEqual(p.approved_by,[f.b.node.node_id]);
 const r=pending(f,"a",d);assert.equal(r.confirmed,true);assert.equal(r.approved_by.find(x=>x.node_id===f.a.node.node_id).credential_version,2);
 assert.equal(count(f.r.db,"relation_approvals"),3);
});
test("revocation, scope removal and epoch retirement invalidate old approvals and cached peer objects",()=>{
 for(const mode of ["revoke","scope","retire"]){
  const f=pair(),d=descriptor(f);pending(f,"a",d);
  if(mode==="revoke")revokePeer(f.r.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});
  else if(mode==="scope")grant(f.a,f.r,{expectedVersion:1,scopes:["relations:read"]});
  else f.r.db.prepare("INSERT INTO federation_retired_epochs VALUES(?,?,?)").run(f.a.node.node_id,f.a.node.sync_epoch,randomUUID());
  assert.equal(pending(f,"b",d).confirmed,false);
  assert.deepEqual(relationStatus(f.r.db,f.bg.peer,graphArgs(f,d.relation_id)).approved_by,[f.b.node.node_id]);
  assert.throws(()=>pending(f,"a",d),{code:mode==="retire"?"RETIRED_EPOCH":"AUTHORIZATION_CHANGED"});
 }
});
test("cross-node cycle validation includes local parent paths while allowing independent bidirectional delegation",()=>{
 const f=pair({publishNow:false});f.av[1].parent_uid=f.av[0].task_uid;f.bv[1].parent_uid=f.bv[0].task_uid;
 publish(f,"a",topology(f,f.a,f.av));publish(f,"b",topology(f,f.b,f.bv));
 const d=descriptor(f,f.av[1],f.bv[0]);pending(f,"a",d);pending(f,"b",d);
 const back=descriptor(f,f.av[0],f.bv[1],{source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:f.bv[1].task_uid,target_node_id:f.a.node.node_id,target_epoch:f.a.node.sync_epoch,target_task_uid:f.av[0].task_uid});
 pending(f,"b",back);const before=state(f.r.db);assert.throws(()=>pending(f,"a",back),{code:"RELATION_CYCLE"});assert.equal(state(f.r.db),before);
 const independent=pair(),forward=descriptor(independent,independent.av[0],independent.bv[0]);
 pending(independent,"a",forward);pending(independent,"b",forward);
 const reverse=descriptor(independent,independent.av[1],independent.bv[1],{source_node_id:independent.b.node.node_id,source_epoch:independent.b.node.sync_epoch,source_task_uid:independent.bv[1].task_uid,target_node_id:independent.a.node.node_id,target_epoch:independent.a.node.sync_epoch,target_task_uid:independent.av[1].task_uid});
 pending(independent,"b",reverse);assert.equal(pending(independent,"a",reverse).confirmed,true);assert.equal(count(independent.r.db,"relation_edges"),2);
});
test("topology replacement cannot remove confirmed endpoints or introduce a cycle around registered edges",()=>{
 const f=pair(),d=descriptor(f);pending(f,"a",d);pending(f,"b",d);
 const back=descriptor(f,f.av[1],f.bv[1],{source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:f.bv[1].task_uid,target_node_id:f.a.node.node_id,target_epoch:f.a.node.sync_epoch,target_task_uid:f.av[1].task_uid});
 pending(f,"b",back);pending(f,"a",back);
 const bv=f.bv.map(v=>({...v}));bv[0].blocked_by=[bv[1].task_uid];publish(f,"b",topology(f,f.b,bv,2));
 const before=state(f.r.db),av=f.av.map(v=>({...v}));av[1].blocked_by=[av[0].task_uid];
 assert.throws(()=>publish(f,"a",topology(f,f.a,av,2)),{code:"RELATION_CYCLE"});assert.equal(state(f.r.db),before);
 assert.throws(()=>publish(f,"a",topology(f,f.a,[f.av[1]],2)),{code:"DANGLING_RELATION"});assert.equal(state(f.r.db),before);
});
test("the registrar may participate as one endpoint using local administration while the other approval stays remote",()=>{
 const r=fixture(),b=fixture(),g=createRelationGraph(r.db,{projectId:"demo",members:[member(r),member(b)]});
 const f={r,a:r,b,g,ag:{peer:localRegistrarPeer(r.db,"demo")},bg:grant(b,r),av:[vertex(r)],bv:[vertex(b)]};
 publish(f,"a",topology(f,r,f.av));publish(f,"b",topology(f,b,f.bv));const d=descriptor(f);
 pending(f,"a",d);const receipt=pending(f,"b",d);assert.equal(receipt.confirmed,true);assert.equal(receipt.approved_by.find(x=>x.node_id===r.node.node_id).credential_version,0);
});

test("concurrent opposite-edge confirmations serialize across independent processes",async()=>{
 const f=pair(),forward=descriptor(f),back=descriptor(f,f.av[0],f.bv[0],{source_node_id:f.b.node.node_id,source_epoch:f.b.node.sync_epoch,source_task_uid:f.bv[0].task_uid,target_node_id:f.a.node.node_id,target_epoch:f.a.node.sync_epoch,target_task_uid:f.av[0].task_uid});
 pending(f,"a",forward);pending(f,"b",back);
 const script=join(TMP,"parallel-relations.mjs");writeFileSync(script,[
  'import {DatabaseSync} from "node:sqlite";',
  'import {readFileSync} from "node:fs";',
  'import {createInterface} from "node:readline";',
  'const api=await import(process.argv[2]),auth=await import(process.argv[3]),db=new DatabaseSync(process.argv[4]);db.exec("PRAGMA busy_timeout=5000");',
  'process.stdout.write("ready\\n");',
  'for await(const line of createInterface({input:process.stdin})){',
  ' try{const c=JSON.parse(readFileSync(process.argv[5],"utf8")),input=JSON.parse(readFileSync(process.argv[6],"utf8"));',
  ' const result=api.approveRelation(db,auth.authenticate(db,"Bearer "+c.token,"relations:approve"),input);process.stdout.write(JSON.stringify({result})+"\\n");}',
  ' catch(e){process.stdout.write(JSON.stringify({error:e.code??"INTERNAL"})+"\\n");}',
  ' db.close();break;','}'
 ].join("\n"));
 const jobs=[{d:forward,grant:f.bg,who:"b"},{d:back,grant:f.ag,who:"a"}];
 const kids=jobs.map((job,i)=>{
  const input=join(TMP,"parallel-relation-"+i+".json");writeFileSync(input,JSON.stringify({request_id:randomUUID(),expected_version:current(f),relation:job.d}));
  const cp=spawn(process.execPath,[script,new URL("../core/federation/relations.mjs",import.meta.url).href,new URL("../core/federation/peers.mjs",import.meta.url).href,f.r.dbPath,job.grant.file,input],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let out="",errors="",readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
  cp.stdout.on("data",d=>{out+=d.toString();if(out.includes("ready\n"))readyResolve();});cp.stderr.on("data",d=>errors+=d.toString());cp.once("error",readyReject);
  const done=new Promise(r=>cp.once("close",code=>{if(!out.includes("ready\n"))readyReject(Error("child startup failed: "+errors));r({code,out,errors});}));return {cp,ready,done};
 });let timer,results;
 try{
  const deadline=new Promise((_,j)=>timer=setTimeout(()=>j(Error("relation race timeout")),15000));
  await Promise.race([Promise.all(kids.map(k=>k.ready)),deadline]);for(const k of kids)k.cp.stdin.end("go\n");
  const raw=await Promise.race([Promise.all(kids.map(k=>k.done)),deadline]);assert.ok(raw.every(r=>r.code===0),JSON.stringify(raw));
  results=raw.map(r=>JSON.parse(r.out.trim().split("\n").at(-1)));
 }finally{clearTimeout(timer);for(const k of kids)if(k.cp.exitCode===null)k.cp.kill();await Promise.all(kids.map(k=>k.done));}
 assert.equal(results.filter(x=>x.result?.confirmed).length,1);assert.equal(results.filter(x=>x.error==="GRAPH_VERSION_CONFLICT").length,1);
 assert.equal(count(f.r.db,"relation_edges"),1);const lost=jobs[results.findIndex(x=>x.error)];assert.throws(()=>pending(f,lost.who,lost.d),{code:"RELATION_CYCLE"});
});
test("loopback HTTP publication, bilateral approval, lost-response replay and restart retain one edge",async()=>{
 const f=pair({publishNow:false}),{url}=await network(f.r);
 for(const who of ["a","b"]){const response=await post(url,"publish",f[who+"g"].auth,{request_id:randomUUID(),expected_version:current(f),snapshot:topology(f,f[who],f[who+"v"])});assert.equal(response.status,200);assert.equal(response.body.kind,"topology_registered");}
 const d=descriptor(f),first={request_id:randomUUID(),expected_version:current(f),relation:d},second={...first,request_id:randomUUID()};
 assert.equal((await post(url,"approve",f.ag.auth,first)).body.confirmed,false);
 const r=await post(url,"approve",f.bg.auth,second);assert.equal(r.status,200);assert.equal(r.body.confirmed,true);const version=current(f);
 assert.deepEqual((await post(url,"approve",f.bg.auth,second)).body,r.body);assert.equal(current(f),version);assert.equal(count(f.r.db,"relation_edges"),1);
 const db=new DatabaseSync(f.r.dbPath);dbs.push(db);migrateRelations(db);assert.deepEqual(relationStatus(db,authenticate(db,f.ag.auth),graphArgs(f,d.relation_id)),r.body);
 assert.equal((await post(url,"status",f.ag.auth,graphArgs(f,d.relation_id))).body.dispatch_ready,false);
 const d2=descriptor(f,f.av[1],f.bv[1]);await post(url,"approve",f.ag.auth,{request_id:randomUUID(),expected_version:current(f),relation:d2});
 assert.equal((await post(url,"withdraw",f.bg.auth,{request_id:randomUUID(),...graphArgs(f,d2.relation_id)})).body.kind,"relation_withdrawn");
});
test("old sync credentials and read-only relationship credentials cannot mutate through the gateway",async()=>{
 const f=pair(),{url}=await network(f.r),d=descriptor(f);
 f.ag=grant(f.a,f.r,{expectedVersion:1,scopes:["peer:handshake","sync:pull","sync:ack"]});
 for(const [path,body] of [["publish",{request_id:randomUUID(),expected_version:current(f),snapshot:topology(f,f.a,f.av,2)}],["approve",{request_id:randomUUID(),expected_version:current(f),relation:d}],["status",graphArgs(f)]])
  assert.equal((await post(url,path,f.ag.auth,body)).status,403);
 f.ag=grant(f.a,f.r,{expectedVersion:2,scopes:["relations:read"]});assert.equal((await post(url,"status",f.ag.auth,graphArgs(f))).status,200);
 assert.equal((await post(url,"approve",f.ag.auth,{request_id:randomUUID(),expected_version:current(f),relation:d})).status,403);
 assert.equal(count(f.r.db,"relation_proposals"),0);
});
test("gateway rechecks a credential revoked while a topology body is still uploading",async()=>{
 const f=pair({publishNow:false}),{server,url}=await network(f.r),body=JSON.stringify({request_id:randomUUID(),expected_version:1,snapshot:topology(f,f.a,f.av)});
 const status=await new Promise((resolve,reject)=>{
  const req=http.request(url+"/peer/v1/relations/publish",{method:"POST",headers:{Authorization:f.ag.auth,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);
  server.once("request",()=>{revokePeer(f.r.db,{peerNodeId:f.a.node.node_id,expectedVersion:1});req.end(body.slice(1));});req.write(body.slice(0,1));
 });
 assert.equal(status,401);assert.equal(count(f.r.db,"relation_topologies"),0);assert.equal(current(f),1);
});
test("gateway accepts bounded large topology snapshots and refuses oversized bodies without writes",async()=>{
 const f=pair({publishNow:false}),{url}=await network(f.r),many=Array.from({length:100},()=>vertex(f.a)),s=topology(f,f.a,many),body={request_id:randomUUID(),expected_version:1,snapshot:s};
 assert.ok(Buffer.byteLength(JSON.stringify(body))>8192);assert.equal((await post(url,"publish",f.ag.auth,body)).status,200);
 const before=state(f.r.db),r=await post(url,"publish",f.ag.auth,{padding:"a".repeat(4*1024*1024+4096)});
 assert.equal(r.status,413);assert.equal(state(f.r.db),before);
});
test("full pending queue permits existing confirmations and withdrawals so capacity can be recovered",()=>{
 const f=pair(),descriptors=[];f.r.db.exec("BEGIN IMMEDIATE");
 try{for(let i=0;i<MAX_PENDING_RELATIONS;i++){const d=descriptor(f);descriptors.push(d);pending(f,"a",d);}f.r.db.exec("COMMIT");}catch(e){f.r.db.exec("ROLLBACK");throw e;}
 const overflow=descriptor(f);assert.throws(()=>pending(f,"a",overflow),{code:"GRAPH_LIMIT"});
 assert.equal(pending(f,"a",descriptors[0]).confirmed,false);
 withdrawRelation(f.r.db,f.bg.peer,{request_id:randomUUID(),...graphArgs(f,descriptors[0].relation_id)});
 assert.equal(pending(f,"a",overflow).confirmed,false);
 assert.equal(pending(f,"b",descriptors[1]).confirmed,true);
 assert.equal(pending(f,"a",descriptor(f)).confirmed,false);
 assert.equal(relationStatus(f.r.db,f.ag.peer,graphArgs(f)).pending,MAX_PENDING_RELATIONS);
});
test("real backup restoration and activation invalidate the registrar epoch instead of reusing old confirmations",()=>{
 const f=pair(),d=descriptor(f);pending(f,"a",d);pending(f,"b",d);
 const evidence=join(f.r.dir,"evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"synthetic relation evidence");
 const backup=createBackup({dbPath:f.r.dbPath,evidenceDir:evidence,destination:join(TMP,"backup-"+serial++)}),dir=join(TMP,"restore-"+serial++);
 restoreBackup({backupDirectory:backup.destination,destination:dir});const dbPath=join(dir,"board.db"),db=new DatabaseSync(dbPath);dbs.push(db);
 assert.throws(()=>migrateRelations(db),{code:"RESTORE_HOLD"});retireNode({dbPath:f.r.dbPath,expectedEpoch:f.r.node.sync_epoch});
 const plan=prepareRecovery({dbPath});activateRecovery({dbPath,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated registrar fixture; no physical node attestation",attested_at:new Date().toISOString()}});
 assert.equal(listRelationGraphs(db)[0].identity_current,false);assert.equal(count(db,"relation_edges"),1);
 assert.throws(()=>relationStatus(db,localRegistrarPeer(db,"demo"),graphArgs(f)),{code:"GRAPH_RECOVERY_REQUIRED"});
 assert.throws(()=>createRelationGraph(db,{projectId:"demo",members:[member(f.a),member(f.b)]}),{code:"CONFLICT"});
 assert.throws(()=>relationStatus(f.r.db,localRegistrarPeer(f.r.db,"demo"),graphArgs(f)),{code:"NODE_RETIRED"});
});
test("CLI requires an explicit existing database and exposes metadata and topology preview without running tasks",()=>{
 const r=fixture(),a=fixture(),t=card(a),file=join(TMP,"cli-members.json");writeFileSync(file,JSON.stringify([member(a)]));
 const cli=(...args)=>spawnSync(process.execPath,[join(ROOT,"cli/relations.mjs"),...args],{cwd:ROOT,encoding:"utf8",windowsHide:true});
 assert.notEqual(cli("list").status,0);const created=cli("create","--db",r.dbPath,"--project","demo","--members-file",file);assert.equal(created.status,0,created.stderr);
 const g=JSON.parse(created.stdout);assert.equal(g.version,1);
 const status=cli("status","--db",r.dbPath,"--project","demo","--graph",g.graph_id,"--graph-epoch",g.graph_epoch);assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).vertices,0);
 const p=cli("preview","--db",a.dbPath,"--project","demo","--graph",g.graph_id,"--graph-epoch",g.graph_epoch,"--revision","1");assert.equal(p.status,0,p.stderr);
 assert.equal(JSON.parse(p.stdout).snapshot.vertices[0].task_uid,t.task_uid);assert.equal(store.get(a.db,t.id).released,false);assert.equal(count(a.db,"task_runs"),0);
 const list=cli("list","--db",r.dbPath);assert.equal(list.status,0,list.stderr);assert.equal(JSON.parse(list.stdout)[0].identity_current,true);
});
test("a graph receipt alone cannot release an accepted delegation task before local topology enforcement exists",()=>{
 const f=pair({publishNow:false});migrateDelegation(f.a.db);migrateDelegation(f.b.db);
 const source=card(f.a),cg=grant(f.a,f.b,{scopes:["delegation:offer","delegation:status"]});
 const out=createIntent(f.a.db,{delegationId:randomUUID(),taskUid:source.task_uid,expectedVersion:source.aggregate_version,targetNodeId:f.b.node.node_id,targetEpoch:f.b.node.sync_epoch});
 receiveOffer(f.b.db,cg.peer,out.offer);const accepted=decideIncoming(f.b.db,{delegationId:out.delegation_id,decisionId:randomUUID(),expectedVersion:1,decision:"accept",note:"fixture"});
 const id=incomingStatus(f.b.db,out.delegation_id).target_task_id;
 const a=previewTopology(f.a.db,{projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,revision:1}),b=previewTopology(f.b.db,{projectId:"demo",graphId:f.g.graph_id,graphEpoch:f.g.graph_epoch,revision:1});
 publish(f,"a",a.snapshot);publish(f,"b",b.snapshot);
 const d=descriptor(f,{task_uid:source.task_uid},{task_uid:accepted.target_task_uid},{delegation_id:out.delegation_id,offer_digest:accepted.offer_digest});
 pending(f,"a",d);assert.equal(pending(f,"b",d).dispatch_ready,false);
 assert.throws(()=>store.setReleased(f.b.db,{id,released:true}),/DELEGATION_UNCONFIRMED/);
 assert.equal(store.claimById(f.b.db,{id,worker:"fixture"}).ok,false);assert.equal(count(f.b.db,"task_runs"),0);
});

test("a graph member outside the two endpoints cannot approve or withdraw their relationship",()=>{
 const r=fixture(),a=fixture(),b=fixture(),g=createRelationGraph(r.db,{projectId:"demo",members:[member(r),member(a),member(b)]});
 const f={r,a,b,g,ag:grant(a,r),bg:grant(b,r),av:[vertex(a)],bv:[vertex(b)]};
 publish(f,"a",topology(f,a,f.av));publish(f,"b",topology(f,b,f.bv));const d=descriptor(f),admin=localRegistrarPeer(r.db,"demo");
 assert.throws(()=>approveRelation(r.db,admin,{request_id:randomUUID(),expected_version:current(f),relation:d}),{code:"FORBIDDEN"});
 pending(f,"a",d);assert.throws(()=>withdrawRelation(r.db,admin,{request_id:randomUUID(),...graphArgs(f,d.relation_id)}),{code:"FORBIDDEN"});
 assert.equal(count(r.db,"relation_approvals"),1);assert.equal(count(r.db,"relation_withdrawals"),0);
});
test("two pending attempts for one delegation cannot produce two confirmed relationships",()=>{
 const f=pair(),d=descriptor(f),other={...d,relation_id:randomUUID()};
 pending(f,"a",d);pending(f,"a",other);assert.equal(pending(f,"b",d).confirmed,true);
 assert.throws(()=>pending(f,"b",other),{code:"DELEGATION_ALREADY_REGISTERED"});
 assert.equal(count(f.r.db,"relation_edges"),1);assert.equal(count(f.r.db,"relation_approvals"),3);
 const w=withdrawRelation(f.r.db,f.bg.peer,{request_id:randomUUID(),...graphArgs(f,other.relation_id)});
 assert.equal(w.kind,"relation_withdrawn");assert.equal(relationStatus(f.r.db,f.ag.peer,graphArgs(f)).pending,0);
});
