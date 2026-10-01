import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import conflictGuide from '../core/conflicts.js';
const {describeConflict}=conflictGuide,store=createRequire(import.meta.url)('../core/store.js'),html=readFileSync(new URL('../core/panel.html',import.meta.url),'utf8');
const start=html.indexOf('function operationError('),end=html.indexOf('// ⭐ v0.19',start),helper=html.slice(start,end);
test('H3 conflict metadata distinguishes task version, execution identity, request identity and graph state without prose guessing',()=>{
 const samples=[
  [{code:'CONFLICT',expected_version:1,current_version:2},'local','task_version'],
  [{code:'CONFLICT',conflict_kind:'run_identity'},'local','run_identity'],
  [{code:'REQUEST_CONFLICT'},'federation','request_identity'],
  [{code:'GRAPH_VERSION_CONFLICT'},'federation','graph_version'],
  [{code:'CONFLICT',message:'PRIVATE-TEXT version mismatch'},'federation','protocol_state'],
  [{code:'CONFLICT',message:'PRIVATE-TEXT version mismatch'},'local','state']
 ];
 for(const [error,scope,kind] of samples){const r=describeConflict(error,{scope});assert.equal(r.kind,kind);assert.equal(r.automatic_retry,false);assert.doesNotMatch(JSON.stringify(r),/PRIVATE-/);}
 assert.equal(describeConflict({code:'BAD_INPUT'}),null);
 assert.equal(describeConflict({code:'CONFLICT',expected_version:'1',current_version:2}).kind,'state');
});
test('H3 actual old-run callback retains original fence and produces guidance without disclosing a replacement run ID',()=>{
 const db=new DatabaseSync(':memory:');try{
  store.migrate(db);const id=store.add(db,{subject:'conflict fixture'}),first=store.claimById(db,{id,worker:'fixture'}).task;
  store.releaseHeldBy(db,'fixture');const second=store.claimById(db,{id,worker:'fixture'}).task,before=store.get(db,id),events=store.events(db,{taskId:id});
  assert.throws(()=>store.report(db,{id,worker:'fixture',runId:first.run_id,outcome:'done',evidence:'old'}),e=>{
   const r=describeConflict(e);assert.equal(r.kind,'run_identity');assert.doesNotMatch(JSON.stringify(r),new RegExp(second.run_id));return true;
  });
  assert.deepEqual(store.get(db,id),before);assert.deepEqual(store.events(db,{taskId:id}),events);
 }finally{db.close();}
});
test('H3 panel uses structured guidance while retaining HTTP status and original response for existing controls',()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(helper,ctx);
 const body={error:'generic',conflict:describeConflict({code:'CONFLICT',expected_version:2,current_version:3})},e=ctx.operationError(body,409);
 assert.equal(e.message,body.conflict.message);assert.equal(e.status,409);assert.equal(e.body,body);assert.equal(e.retrySameRequest,false);
 assert.equal(ctx.operationError({error:'unavailable'},503).retrySameRequest,true);assert.equal(ctx.operationError({error:'permission'},403).retrySameRequest,false);
});
test('H3 actual fleet dialog disables known conflict retries, preserves drafts and permits only explicit uncertain transport retry',async()=>{
 const a=html.indexOf('$("fleet-action-form").addEventListener("submit"'),b=html.indexOf('\n function renderDelivery',a);assert.ok(a>=0&&b>a);
 for(const scenario of ['conflict','server','network']){
  let callback,calls=0;const draft={action_id:'original-action',project_id:'demo',command:'create_delegation',arguments:{expected_version:2},input:null};
  const ctx={actionBusy:false,actionDraft:draft,actionSubmit:{disabled:false,textContent:''},actionStatus:{textContent:''},WH:{},AbortSignal,load(){throw Error('must not refresh into a retry');},$:()=>({addEventListener:(event,fn)=>{callback=fn;}}),
   fetch:async()=>{calls++;if(scenario==='network')throw Error('connection outcome unknown');return {ok:false,status:scenario==='conflict'?409:503,json:async()=>scenario==='conflict'?{conflict:describeConflict({code:'CONFLICT',expected_version:2,current_version:3})}:{error:'unavailable'}};}};
  vm.createContext(ctx);vm.runInContext(helper+html.slice(a,b),ctx);await callback({preventDefault(){}});
  assert.equal(calls,1);assert.equal(draft.frozen.action_id,'original-action');assert.equal(draft.frozen.arguments.expected_version,2);
  assert.equal(ctx.actionSubmit.disabled,scenario==='conflict');assert.equal(ctx.actionBusy,false);
  if(scenario==='conflict')assert.match(ctx.actionStatus.textContent,/刷新并核对/);else assert.match(ctx.actionStatus.textContent,/不会自动提交/);
 }
});

test('H3 generic state conflicts retain the concrete refusal instead of claiming every 409 is a stale version',()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(helper,ctx);
 const conflict=describeConflict({code:'CONFLICT',message:'line already exists'}),e=ctx.operationError({error:'line already exists',conflict},409);
 assert.equal(conflict.kind,'state');assert.match(e.message,/line already exists/);assert.equal(e.retrySameRequest,false);
});
