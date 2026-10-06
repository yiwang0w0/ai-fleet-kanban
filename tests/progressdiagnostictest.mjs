import vm from "node:vm";
import {readFileSync} from "node:fs";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
const store=createRequire(import.meta.url)("../core/store.js"),dbs=[];
after(()=>{for(const db of dbs)db.close();});
function fixture(){const db=new DatabaseSync(":memory:");dbs.push(db);store.migrate(db);return db;}
function report(db,id){const t=store.claimById(db,{id,worker:"engine"}).task;assert.ok(t);store.report(db,{id,worker:"engine",runId:t.run_id,outcome:"done",evidence:"isolated child result"});}
function finish(db,id){report(db,id);store.resolve(db,{id,verdict:"approve",note:"",resolvedBy:"auto",expectedVersion:store.get(db,id).aggregate_version});}
function parentFixture(db,{held=true,finished=true}={}){
 const parent=store.add(db,{subject:"parent needs child result",line:"engine"});report(db,parent);store.markAutoReviewed(db,{id:parent,note:"await child"});
 const child=store.add(db,{subject:"child",line:"engine",parentId:parent});store.deferToRearm(db);
 if(held)store.update(db,{id:parent,humanGate:true,expectedVersion:store.get(db,parent).aggregate_version});
 db.prepare("UPDATE tasks SET auto_review_at='2000-01-01T00:00:00Z' WHERE id=?").run(parent);
 if(finished)finish(db,child);return {parent,child};
}
const audit=(db,id)=>store.events(db,{taskId:id}).filter(e=>e.kind.startsWith("review.rearm"));
test("H3/M1 a human-gated completed parent records one blocker and rearms only after explicit unlock",()=>{
 const db=fixture(),{parent,child}=parentFixture(db),before=store.get(db,parent);
 assert.deepEqual(store.rearmDone(db),[]);
 const held=store.get(db,parent);assert.equal(held.human_gate,true);assert.equal(held.waiting_for,"rearm");
 assert.equal(held.aggregate_version,before.aggregate_version);assert.equal(held.attempts,before.attempts);
 assert.equal(audit(db,parent).length,1,"the blocked sweep must leave a durable explanation");
 assert.equal(audit(db,parent)[0].kind,"review.rearm_blocked");
 assert.deepEqual(audit(db,parent)[0].detail.reasons.map(x=>x.code),["HUMAN_GATE"]);
 assert.deepEqual(store.stuckWhy(db,parent).filter(x=>x.action==="rearm").map(x=>x.code),["HUMAN_GATE"]);
 assert.equal(store.pendingReview(db).some(t=>t.id===parent),false);
 store.rearmDone(db);store.rearmDone(db);assert.equal(audit(db,parent).length,1,"periodic sweeps must not flood history");
 store.update(db,{id:parent,humanGate:false,expectedVersion:held.aggregate_version});
 assert.deepEqual(store.rearmDone(db),[parent]);assert.equal(store.get(db,parent).waiting_for,"review");
 assert.equal(store.get(db,parent).auto_review_at,null);assert.equal(db.prepare("SELECT review_fp FROM tasks WHERE id=?").get(parent).review_fp,null);
 assert.equal(store.pendingReview(db).some(t=>t.id===parent),true);assert.equal(store.get(db,child).status,"done");
 assert.equal(audit(db,parent).at(-1).kind,"review.rearmed");assert.deepEqual(store.rearmDone(db),[]);assert.equal(audit(db,parent).length,2);
});

test("H3/M1 unfinished children and scoped/archived parents never emit a false ready event",()=>{
 const db=fixture(),a=parentFixture(db,{finished:false}),b=parentFixture(db),c=parentFixture(db);
 assert.ok(store.stuckWhy(db,a.parent).some(r=>r.code==="CHILDREN_UNFINISHED"));
 db.prepare("UPDATE tasks SET archived_at='fixture archive' WHERE id=?").run(c.parent);
 assert.deepEqual(store.rearmDone(db,{parentId:a.parent}),[]);assert.equal(audit(db,a.parent).length,0);assert.equal(audit(db,b.parent).length,0);
 store.rearmDone(db,{parentId:b.parent});assert.equal(audit(db,b.parent).length,1);assert.equal(audit(db,c.parent).length,0);
 store.update(db,{id:a.parent,humanGate:false,expectedVersion:store.get(db,a.parent).aggregate_version});
 finish(db,a.child);assert.deepEqual(store.rearmDone(db),[a.parent]);
 assert.equal(audit(db,a.parent)[0].kind,"review.rearmed");assert.equal(audit(db,c.parent).length,0);
 assert.throws(()=>store.rearmDone(db,{parentId:"1"}),{code:"BAD_INPUT"});
});
test("H3/M1 blocker audit changes only for a new reviewed result or changed hold",()=>{
 const db=fixture(),{parent,child}=parentFixture(db);store.rearmDone(db);
 db.prepare("UPDATE tasks SET updated_at='2030-01-01T00:00:00Z' WHERE id=?").run(child);
 store.rearmDone(db);assert.equal(audit(db,parent).length,1,"clock-only changes cannot create a new blocker");
 store.update(db,{id:child,description:"additional child context",expectedVersion:store.get(db,child).aggregate_version});
 store.rearmDone(db);assert.equal(audit(db,parent).length,2);store.rearmDone(db);assert.equal(audit(db,parent).length,2);
});
test("H3/M1 an audit failure rolls back every rearm and preserves the caller transaction",()=>{
 const db=fixture(),a=parentFixture(db,{held:false}),b=parentFixture(db),before=JSON.stringify(store.list(db));
 db.exec("CREATE TEMP TRIGGER fail_rearm_audit BEFORE INSERT ON task_events WHEN NEW.kind='review.rearm_blocked' BEGIN SELECT RAISE(ABORT,'audit fixture failure'); END");
 db.exec("BEGIN IMMEDIATE");assert.throws(()=>store.rearmDone(db),/audit fixture failure/);
 assert.equal(db.isTransaction,true);assert.equal(JSON.stringify(store.list(db)),before);assert.equal(audit(db,a.parent).length,0);assert.equal(audit(db,b.parent).length,0);
 db.exec("ROLLBACK; DROP TRIGGER fail_rearm_audit");assert.deepEqual(store.rearmDone(db),[a.parent]);
 assert.equal(audit(db,a.parent).length,1);assert.equal(audit(db,b.parent).length,1);
});
test("H3 diagnostics are read-only, fresh and identify common claim gates without spending attempts",()=>{
 const db=fixture(),dep=store.add(db,{subject:"prerequisite"}),id=store.add(db,{subject:"held work",released:0,humanGate:true,blockedBy:[dep]});
 const snapshot=store.get(db,id);db.exec("PRAGMA query_only=ON");
 const reasons=store.stuckWhy(db,snapshot),codes=reasons.map(r=>r.code);
 assert.ok(codes.includes("NOT_RELEASED"));assert.ok(codes.includes("HUMAN_GATE"));assert.ok(codes.includes("DEPENDENCIES_UNFINISHED"));
 assert.ok(reasons.every(r=>r.action==="claim"&&r.message&&r.next_action));
 assert.deepEqual(store.get(db,id),snapshot);db.exec("PRAGMA query_only=OFF");
 store.update(db,{id,humanGate:false,expectedVersion:snapshot.aggregate_version});
 assert.equal(store.stuckWhy(db,snapshot).some(r=>r.code==="HUMAN_GATE"),false,"caller snapshots cannot override live gates");
 assert.equal(store.claimById(db,{id,worker:"engine"}).ok,false);assert.equal(store.get(db,id).attempts,0);
 db.prepare("UPDATE tasks SET blocked_by='bad JSON' WHERE id=?").run(id);
 assert.ok(store.stuckWhy(db,id).some(r=>r.code==="BROKEN_DEPENDENCIES"));assert.equal(store.claimById(db,{id,worker:"engine"}).ok,false);
 assert.throws(()=>store.stuckWhy(db,99999),{code:"NOT_FOUND"});assert.throws(()=>store.stuckWhy(db,"1"),{code:"BAD_INPUT"});
});
test("H3 diagnostics preserve locks, attempt limits, ancestor gates and goal completion semantics",()=>{
 const db=fixture(),owner=store.add(db,{subject:"lock owner",lockKey:"fixture"}),waiting=store.add(db,{subject:"wait lock",lockKey:"fixture"});
 report(db,owner);store.resolve(db,{id:owner,verdict:"approve",resolvedBy:"human",disposition:"hand_back",note:"new fixture work",expectedVersion:store.get(db,owner).aggregate_version});
 assert.equal(store.claimById(db,{id:owner,worker:"engine",force:true}).ok,true);
 assert.ok(store.stuckWhy(db,waiting).some(r=>r.code==="LOCK_HELD"));assert.equal(store.claimById(db,{id:waiting,worker:"engine"}).ok,false);
 db.prepare("UPDATE tasks SET attempts=9999 WHERE id=?").run(waiting);assert.ok(store.stuckWhy(db,waiting).some(r=>r.code==="ATTEMPT_LIMIT"));
 const goal=store.add(db,{subject:"goal",kind:"goal",released:0});
 assert.ok(store.stuckWhy(db,goal).some(r=>r.code==="GOAL_WITHOUT_CHILDREN"));
 const kid=store.add(db,{subject:"descendant",parentId:goal});assert.ok(store.stuckWhy(db,kid).some(r=>r.code==="ANCESTOR_NOT_RELEASED"));
 db.prepare("UPDATE tasks SET archived_at='fixture' WHERE id=?").run(kid);
 assert.ok(store.stuckWhy(db,goal).some(r=>r.code==="DESCENDANTS_UNFINISHED"));assert.equal(store.completeGoals(db).includes(goal),false);
 assert.deepEqual(store.stuckWhy(db,kid),[]);
});
test("H3 panel displays blocked rearm and escapes diagnostic text and recovery hints",()=>{
 const source=readFileSync(new URL("../core/panel.html",import.meta.url),"utf8"),a=source.indexOf("function progressTags("),b=source.indexOf("function cardParts(",a);
 assert.ok(a>=0&&b>a);
 const context={esc:s=>String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"),wfLabel:w=>w==="rearm"?"等待重审":w};
 vm.createContext(context);vm.runInContext(source.slice(a,b),context);
 const t={waiting_for:"rearm",progress_blockers:[{message:'人工闸 <img src=x>',next_action:'核对 "权限" <script>'}]};
 assert.equal(context.progressWaitLabel(t),"重审受阻");assert.equal(context.progressWaitLabel({...t,progress_blockers:[]}),"等待重审");
 const rendered=context.progressTags(t);assert.ok(rendered.includes("&lt;img"));assert.ok(rendered.includes("&quot;权限&quot;"));assert.equal(rendered.includes("<script>"),false);
});
