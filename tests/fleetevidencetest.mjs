import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID,createHash} from "node:crypto";
import {evidenceFixture,addEvidenceHistory} from "./helpers/fleet-evidence-fixture.mjs";
import {readFleetView,readFleetTask,readFleetEvidencePage} from "../core/fleet-view.mjs";
import {taskContext,taskList,boardOverview} from "../core/mcp/context.mjs";
import {canonical,digest,recordSource} from "../core/federation/sync-store.mjs";
const store=createRequire(import.meta.url)("../core/store.js");
function fixture(t,options={}){const f=evidenceFixture(":memory:",options);t.after(()=>f.db.close());return f;}
test("ordinary board trace does not initialize federation or mutate state",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());store.migrate(db);const taskId=store.add(db,{subject:"普通任务"}),before=db.prepare("SELECT total_changes() n").get().n,tables=db.prepare("SELECT name FROM sqlite_master").all();
 const trace=readFleetTask(db,store.get(db,taskId).task_uid).evidence;
 assert.equal(trace.relations.modules.binding,"not_configured");assert.equal(trace.runs.total,0);assert.equal(trace.current_authorization_checked,false);
 assert.equal(db.prepare("SELECT total_changes() n").get().n,before);assert.deepEqual(db.prepare("SELECT name FROM sqlite_master").all(),tables);
});
test("same-name endpoints remain distinct, filters preserve links to visible tasks outside current page",t=>{
 const f=fixture(t),v=readFleetView(f.db,{query:"跨端",limit:1}),e=v.relations.items[0];
 assert.equal(v.tasks.length,1);assert.equal(e.source.task_uid,f.source.task_uid);assert.equal(e.target.task_uid,f.target);assert.notEqual(e.source.owner_node_id,e.target.owner_node_id);assert.equal(e.source.owner_name,e.target.owner_name);
 assert.equal(e.source.in_view,true);assert.equal(e.target.in_view,false);assert.equal(e.current_authorization_checked,false);
 recordSource(f.db,{node_id:f.remote,display_name:"kanata-office",sync_epoch:f.remoteEpoch});const renamed=readFleetView(f.db).relations.items[0];assert.equal(renamed.target.owner_name,"kanata-office");assert.equal(renamed.target.task_uid,f.target);
 assert.equal(readFleetTask(f.db,f.target).subject,e.target.subject);
});
test("relation snapshot is stable across pages and changes on a cancellation receipt",t=>{
 const f=fixture(t),a=readFleetView(f.db,{limit:1}),b=readFleetView(f.db,{limit:1,offset:1});assert.equal(a.snapshot_id,b.snapshot_id);
 const request={schema_version:1,kind:"cancel_delegation",cancel_id:randomUUID(),relation:f.descriptor,reason_code:"operator_cancelled"};
 f.db.prepare("INSERT INTO delegation_cancellations(relation_id,cancel_id,project_id,side,node_id,node_epoch,request_json,request_digest,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(f.relationId,request.cancel_id,"demo","source",f.local.node_id,f.local.sync_epoch,canonical(request),digest(request),"pending",f.now);
 const c=readFleetView(f.db,{limit:1});assert.notEqual(a.snapshot_id,c.snapshot_id);assert.equal(c.relations.items[0].cancellation_state,"pending");
 const p={projects:["demo"],role:{policy:{kind:"observe"}}};
 assert.throws(()=>taskList(f.db,p,{expected_snapshot:a.snapshot_id}),{code:"SNAPSHOT_CHANGED"});
});
test("scoped readers redact withdrawn and cross-project endpoints and raw contract bodies",t=>{
 const f=fixture(t);f.db.prepare("UPDATE federation_replicas SET withdrawn=1 WHERE task_uid=?").run(f.target);
 const p={projects:["demo"],role:{policy:{kind:"observe"}}},v=taskList(f.db,p),e=v.relations.items[0];assert.equal(e.target,null);assert.equal(e.source.task_uid,f.source.task_uid);
 const out=JSON.stringify(v);for(const secret of [f.target,"PRIVATE-CONTRACT","PRIVATE-NOTE","PRIVATE-OFFER-BODY"])assert.ok(!out.includes(secret),secret);
 assert.throws(()=>taskContext(f.db,p,{task_uid:f.target}),{code:"NOT_FOUND"});
 f.db.prepare("UPDATE federation_replicas SET withdrawn=0,project_id='private' WHERE task_uid=?").run(f.target);
 assert.equal(readFleetView(f.db).relations.items[0].target,null);
 assert.equal(readFleetView(f.db,{},["private"]).relations.total,0);
});
test("pending offers do not invent remote tasks or conflate proposal with execution authorization",t=>{
 const f=fixture(t,{withBinding:false});
 f.db.prepare("UPDATE delegation_outgoing SET receipt_json=NULL,state='pending'").run();
 const e=readFleetView(f.db).relations.items[0];assert.equal(e.target,null);assert.equal(e.binding_state,null);assert.equal(e.offer_state,"pending");assert.equal(e.current_authorization_checked,false);
});
test("parent evidence follows only same-project local descendants and is read-only in caller transaction",t=>{
 const f=fixture(t);f.db.exec("BEGIN");const before=f.db.prepare("SELECT total_changes() n").get().n,trace=readFleetTask(f.db,f.root.task_uid,["demo"]).evidence;
 assert.equal(trace.children.items[0].task_uid,f.source.task_uid);assert.equal(trace.relations.items[0].relation_id,f.relationId);assert.equal(trace.scope_tasks,2);assert.equal(f.db.isTransaction,true);assert.equal(f.db.prepare("SELECT total_changes() n").get().n,before);f.db.exec("ROLLBACK");
});
test("unsupported schema is disclosed without migration or interpreting future records",t=>{
 const f=fixture(t);f.db.prepare("UPDATE binding_schema SET version=99").run();
 const v=readFleetView(f.db);assert.equal(v.relations.modules.binding,"upgrade_required");assert.equal(v.relations.items[0].binding_state,null);assert.equal(f.db.prepare("SELECT version FROM binding_schema").get().version,99);
});
test("corrupt descriptor never projects hidden payload fields or a confirmed binding",t=>{
 const f=fixture(t);f.db.exec("DROP TRIGGER IF EXISTS binding_identity");
 const triggers=f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='delegation_bindings'").all();
 for(const r of triggers)f.db.exec('DROP TRIGGER "'+r.name.replaceAll('"','""')+'"');
 f.db.prepare("UPDATE delegation_bindings SET descriptor_json=?,state='confirmed'").run('{"secret":"PRIVATE-CORRUPT"}');
 const v=readFleetView(f.db);assert.equal(v.relations.items[0].binding_state,null);assert.ok(!JSON.stringify(v).includes("PRIVATE-CORRUPT"));
});
test("task run metadata never publishes policy commands, paths, or arbitrary nested model data",t=>{
 const f=fixture(t),run=randomUUID(),policy=JSON.stringify({context:{model:"fixture",effort:"low",command:"PRIVATE-COMMAND",path:"PRIVATE-PATH",token:"PRIVATE-TOKEN"}}),policyHash=createHash("sha256").update(policy).digest("hex");
 f.db.prepare("INSERT INTO task_runs(run_id,task_id,task_uid,owner_node_id,executor_node_id,worker,role_id,runtime,agent_instance_id,policy_json,policy_sha256,started_at,first_attempt,last_attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(run,f.source.id,f.source.task_uid,f.local.node_id,f.local.node_id,"fixture","implementer","zcode",randomUUID(),policy,policyHash,f.now,1,1);
 const p={projects:["demo"],role:{policy:{kind:"observe"}}},out=taskContext(f.db,p,{task_uid:f.root.task_uid}),r=out.task.evidence.runs.items[0];
 assert.equal(r.run_id,run);assert.equal(r.runtime,"zcode");assert.equal(r.model,"fixture");assert.equal(r.policy_integrity,"digest_checked");
 for(const value of ["PRIVATE-COMMAND","PRIVATE-PATH","PRIVATE-TOKEN"])assert.ok(!JSON.stringify(out).includes(value));
 assert.ok(!("items" in boardOverview(f.db,p).relations));
});
test("relationship result limits are explicit and cannot silently imply an empty history",t=>{
 const f=fixture(t),v=readFleetView(f.db,{query:"no-match"});assert.equal(v.relations.total,0);assert.equal(v.relations.coverage,"locally_recorded_history");
 const trace=readFleetTask(f.db,f.target).evidence;assert.equal(trace.coverage,"locally_recorded_history");assert.equal(trace.runs.total,0);assert.equal(trace.completions.total,0);
});

test("large relationship histories disclose truncation at board and detail limits",t=>{
 const f=fixture(t,{withBinding:false}),stmt=f.db.prepare("INSERT INTO delegation_outgoing(delegation_id,project_id,source_task_uid,target_node_id,target_epoch,request_digest,offer_digest,offer_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
 f.db.exec("BEGIN");for(let i=0;i<501;i++){const o={...f.offer,delegation_id:randomUUID()},h=digest(o);stmt.run(o.delegation_id,"demo",f.source.task_uid,f.remote,f.remoteEpoch,h,h,canonical(o),"pending",f.now,f.now);}f.db.exec("COMMIT");
 const view=readFleetView(f.db);assert.equal(view.relations.total,502);assert.equal(view.relations.items.length,500);assert.equal(view.relations.truncated,true);
 const trace=readFleetTask(f.db,f.root.task_uid).evidence;assert.equal(trace.relations.total,502);assert.equal(trace.relations.items.length,100);assert.equal(trace.relations.truncated,true);
});
test("corrupt scoped offer is counted without exposing its content",t=>{
 const f=fixture(t,{withBinding:false});f.db.exec("DROP TRIGGER delegation_outgoing_identity");f.db.prepare("UPDATE delegation_outgoing SET offer_json=?").run('{"private":"PRIVATE-BAD-OFFER"}');
 const v=readFleetView(f.db);assert.equal(v.relations.total,0);assert.equal(v.relations.unverified_records,1);assert.ok(!JSON.stringify(v).includes("PRIVATE-BAD-OFFER"));
});

test("results beyond the first relationship page remain in the evidence history",t=>{
 const f=fixture(t);addEvidenceHistory(f);const e=readFleetTask(f.db,f.root.task_uid).evidence;
 assert.equal(e.relations.total,206);assert.equal(e.results.total,205);assert.equal(e.results.items.length,100);
});

test("evidence pages traverse tied timestamps without loss, duplication, writes or schema changes",t=>{
 const f=fixture(t);addEvidenceHistory(f);const before=f.db.prepare("SELECT total_changes() n").get().n;
 for(const [section,key,total] of [["relations","relation_id",206],["results","result_id",205],["runs","run_id",205]]){
  const first=readFleetTask(f.db,f.root.task_uid,["demo"]).evidence[section],all=[...first.items];let p=first;
  while(p.next_cursor){p=readFleetEvidencePage(f.db,f.root.task_uid,{section,cursor:p.next_cursor},["demo"]).page;assert.equal(p.snapshot_id,first.snapshot_id);all.push(...p.items);}
  assert.equal(all.length,total);assert.equal(new Set(all.map(r=>r[key])).size,total);assert.equal(p.truncated,false);assert.equal(p.offset,200);
  assert.deepEqual(readFleetEvidencePage(f.db,f.root.task_uid,{section,cursor:first.cursor},["demo"]).page,first);
 }
 assert.equal(f.db.prepare("SELECT total_changes() n").get().n,before);
});
test("changed history and task version invalidate old evidence cursors",t=>{
 const f=fixture(t);addEvidenceHistory(f,2);const query={section:"runs",limit:1};
 let a=readFleetEvidencePage(f.db,f.root.task_uid,query).page;
 addEvidenceHistory(f,1);assert.throws(()=>readFleetEvidencePage(f.db,f.root.task_uid,{...query,cursor:a.next_cursor}),{code:"EVIDENCE_CHANGED",status:409});
 a=readFleetEvidencePage(f.db,f.root.task_uid,query).page;
 f.db.prepare("UPDATE tasks SET description='changed root' WHERE id=?").run(f.root.id);
 assert.throws(()=>readFleetEvidencePage(f.db,f.root.task_uid,{...query,cursor:a.cursor}),{code:"EVIDENCE_CHANGED"});

});
test("cursor is bound to task, section and page size and cannot restore revoked visibility",t=>{
 const f=fixture(t);addEvidenceHistory(f,2);const a=readFleetEvidencePage(f.db,f.root.task_uid,{section:"runs",limit:1},["demo"]).page;
 for(const [uid,q,scope,code] of [
  [f.source.task_uid,{section:"runs",limit:1,cursor:a.next_cursor},["demo"],"BAD_INPUT"],
  [f.root.task_uid,{section:"results",limit:1,cursor:a.next_cursor},["demo"],"BAD_INPUT"],
  [f.root.task_uid,{section:"runs",cursor:a.next_cursor},["demo"],"BAD_INPUT"],
  [f.root.task_uid,{section:"runs",limit:1,cursor:a.next_cursor},["private"],"NOT_FOUND"]])assert.throws(()=>readFleetEvidencePage(f.db,uid,q,scope),{code});
 f.db.prepare("UPDATE federation_replicas SET withdrawn=1 WHERE task_uid=?").run(f.target);
 assert.throws(()=>readFleetEvidencePage(f.db,f.root.task_uid,{section:"runs",limit:1,cursor:a.next_cursor},["demo"]),{code:"EVIDENCE_CHANGED"});
 const refreshed=readFleetEvidencePage(f.db,f.root.task_uid,{section:"relations"},["demo"]);assert.ok(refreshed.page.items.every(r=>r.target===null));assert.ok(!JSON.stringify(refreshed).includes(f.target));
});
test("malformed and out-of-range pagination is rejected; empty sections and bounded limits remain readable",t=>{
 const f=fixture(t),call=q=>readFleetEvidencePage(f.db,f.root.task_uid,q),encoded=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
 for(const q of [{},{section:"secret"},{section:"runs",limit:0},{section:"runs",limit:101},{section:"runs",limit:1.5},{section:"runs",limit:"1"},{section:"runs",cursor:""},{section:"runs",cursor:"x".repeat(1025)},{section:"runs",cursor:encoded([])},{section:"runs",extra:true}])assert.throws(()=>call(q),{code:"BAD_INPUT"});
 const p=call({section:"runs"}).page,c=JSON.parse(Buffer.from(p.cursor,"base64url").toString());assert.equal(p.total,0);assert.equal(p.next_cursor,null);assert.deepEqual(call({section:"runs",cursor:p.cursor}).page,p);
 for(const delta of [{offset:-1},{offset:1},{offset:1.5},{v:2},{extra:1},{snapshot_id:"x"}])assert.throws(()=>call({section:"runs",cursor:encoded({...c,...delta})}),{code:"BAD_INPUT"});
});
