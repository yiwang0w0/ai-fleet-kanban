import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {readFleetProgress,progressReceiptDraft} from '../core/fleet-progress.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-progress-')),AT='2026-10-01T06:00:00.000Z';let serial=0;
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=(f,v)=>writeFileSync(f,JSON.stringify(v,null,2)+'\n');
function fixture(){
 const dir=join(TMP,String(serial++));mkdirSync(dir);const tasks=[['T0a','S0',[]],['T0b','S0',['T0a']],['T1','S1',['T0b']],['T2','S2',[]]].map(([id,phase_id,depends_on])=>({id,phase_id,depends_on,requires_gates:[],subject:id+' task',lead_role:'ENG',acceptance_criteria:['Actual output is correct'],evidence_required:['test receipt'],status:'verifying',implementation_evidence:['code.mjs'],verification_result:{result:'local_component_passed'}}));
 const phases=[['S0','G0',[],['T0a','T0b']],['S1','G1',['S0'],['T1']],['S2','G2',[],['T2']]].map(([id,gate_id,depends_on,task_ids])=>({id,gate_id,depends_on,task_ids,title:id+' phase',operator_confirmation_required:id==='S0'}));
 const plan={artifact_type:'planning_manifest',plan_id:'P1',plan_version:'1',tasks,phases,progress:{accepted_tasks:999,task_completion_percent:100}};
 const manifestFile=join(dir,'manifest.json'),configFile=join(dir,'config.json'),policies=phases.map(p=>{const path=join(dir,p.id+'.mjs');writeFileSync(path,'export const version=1;');return {phase_id:p.id,required_roles:['TEST','REVIEW'],implementer_ids:['builder'],inputs:[{id:'code',path}],receipts:[]};});
 const config={format:'ai-fleet-progress/v1',plans:[{project_id:'demo',manifest_file:manifestFile,phases:policies}]};
 const f={dir,plan,config,policies,configFile,manifestFile,flush(){save(manifestFile,plan);save(configFile,config);},view(){return readFleetProgress(configFile).plans[0];}};f.flush();return f;
}
function record(f,phaseId,{tasks,decision='accepted',confirmations,registeredBy='operator',note='Independent evidence reviewed'}={}){
 const draft=progressReceiptDraft(readFleetProgress(f.configFile),'P1',phaseId),phase=f.plan.phases.find(p=>p.id===phaseId),r={...draft,decision,accepted_task_ids:tasks??(decision==='accepted'?phase.task_ids:[]),confirmations:confirmations??['TEST','REVIEW',...(phase.operator_confirmation_required?['OP']:[])].map(role=>({role,instance_id:role.toLowerCase(),decision:'approve',at:AT,reference:'review-'+role})),evidence_refs:['sha256:'+hash('fixed evidence')],note,verified_at:AT};
 const path=join(f.dir,'receipt-'+randomUUID()+'.json');save(path,r);const entry={path,sha256:hash(readFileSync(path)),registered_by:registeredBy,registered_at:AT};f.policies.find(p=>p.phase_id===phaseId).receipts.push(entry);f.flush();return {r,entry};
}
const phase=(f,id)=>f.view().phases.find(p=>p.phase_id===id);
const repin=(f,record)=>{save(record.entry.path,record.r);record.entry.sha256=hash(readFileSync(record.entry.path));f.flush();};
after(()=>{const target=resolve(TMP),base=resolve(tmpdir());assert.ok(relative(base,target)&&!relative(base,target).startsWith('..'));rmSync(target,{recursive:true,force:true});});

test('disabled progress performs no file access and plan status or test claims cannot accept tasks',()=>{
 assert.deepEqual(readFleetProgress(),{enabled:false,plans:[]});const f=fixture();f.plan.tasks.forEach(t=>t.status='accepted');f.flush();const view=f.view();assert.equal(view.counts.accepted_tasks,0);assert.equal(view.counts.accepted_phases,0);assert.equal(view.counts.pending_acceptance_tasks,4);assert.equal(view.counts.with_implementation_evidence,4);assert.equal(view.counts.with_verification_records,4);
});
test('partial external acceptance counts tasks once but the gate waits for every task and its prerequisites',()=>{
 const f=fixture();record(f,'S0',{tasks:['T0b']});assert.equal(f.view().counts.accepted_tasks,0);record(f,'S0',{tasks:['T0a']});assert.equal(f.view().counts.accepted_tasks,1);assert.equal(phase(f,'S0').accepted,false);record(f,'S1');assert.equal(phase(f,'S1').accepted,false);assert.deepEqual(phase(f,'S1').blocked_by,['S0']);record(f,'S0');assert.equal(f.view().counts.accepted_tasks,3);assert.equal(f.view().counts.accepted_phases,2);assert.equal(f.view().counts.task_percent,75);assert.equal(phase(f,'S0').history.length,3);assert.equal(phase(f,'S0').history.at(-1).confirmations[1].instance_id,'review');
});
test('missing independent roles, operator confirmation and implementer self acceptance never pass',()=>{
 for(const mode of ['missing-review','missing-op','self-review','self-register']){const f=fixture(),x=record(f,'S0');if(mode==='missing-review')x.r.confirmations=x.r.confirmations.filter(c=>c.role!=='REVIEW');if(mode==='missing-op')x.r.confirmations=x.r.confirmations.filter(c=>c.role!=='OP');if(mode==='self-review')x.r.confirmations.find(c=>c.role==='REVIEW').instance_id='builder';if(mode==='self-register')x.entry.registered_by='builder';repin(f,x);assert.equal(f.view().counts.accepted_tasks,0,mode);assert.equal(phase(f,'S0').history.at(-1).state,'invalid',mode);}
});
test('changed acceptance contract invalidates that phase and its dependants but preserves unrelated gate',()=>{
 const f=fixture();for(const id of ['S0','S1','S2'])record(f,id);assert.equal(f.view().counts.accepted_tasks,4);f.plan.tasks[0].acceptance_criteria.push('New acceptance criterion');f.flush();const view=f.view();assert.equal(view.counts.accepted_tasks,1);assert.equal(phase(f,'S0').state,'stale');assert.equal(phase(f,'S1').state,'stale');assert.equal(phase(f,'S2').accepted,true);assert.equal(phase(f,'S0').history[0].decision,'accepted');
});
test('registered code or authority inputs invalidate old receipts while a status note does not',()=>{
 const f=fixture();record(f,'S0');const before=phase(f,'S0').contract_sha256;f.plan.progress={accepted_tasks:0};f.plan.tasks[0].implementation_evidence.push('more-notes.md');f.flush();assert.equal(phase(f,'S0').contract_sha256,before);assert.equal(phase(f,'S0').accepted,true);writeFileSync(f.policies[0].inputs[0].path,'export const version=2;');assert.equal(phase(f,'S0').state,'stale');record(f,'S0');f.policies[0].required_roles.push('ARCH');f.flush();assert.equal(phase(f,'S0').state,'stale');
});
test('changed receipt bytes or a later pending decision cannot fall back to earlier acceptance',()=>{
 const f=fixture();record(f,'S0');const next=record(f,'S0',{decision:'pending'});assert.equal(f.view().counts.accepted_tasks,0);assert.equal(phase(f,'S0').state,'pending');writeFileSync(next.entry.path,'{}');assert.equal(phase(f,'S0').state,'invalid');assert.equal(phase(f,'S0').history.at(-1).code,'RECEIPT_CHANGED');assert.equal(f.view().counts.accepted_tasks,0);
});
test('blocked tasks show actionable fields and cannot remain accepted under a current blocker',()=>{
 const f=fixture();record(f,'S0');f.plan.tasks[0].status='blocked';f.plan.tasks[0].blocker={reason:'Device is unavailable',release_condition:'Device reconnects',responsible_role:'OPS',next_review_at:AT};f.flush();const v=f.view();assert.equal(v.counts.accepted_tasks,0);assert.equal(v.counts.blocked_tasks,1);assert.equal(phase(f,'S0').tasks[0].blocker.release_condition,'Device reconnects');delete f.plan.tasks[0].blocker;f.flush();assert.equal(phase(f,'S0').tasks[0].blocker.reason,'尚未填写阻塞原因');
});
test('project filtering opens no other project files and the public view contains no configured path',()=>{
 const f=fixture();f.config.plans.push({project_id:'secret',manifest_file:join(f.dir,'PRIVATE-not-there.json'),phases:[]});f.flush();const v=readFleetProgress(f.configFile,{projectId:'demo'});assert.equal(v.plans.length,1);const encoded=JSON.stringify(v);assert.ok(!encoded.includes(f.dir));assert.ok(!encoded.includes('PRIVATE'));assert.equal(readFleetProgress(f.configFile,{projectId:'missing'}).plans.length,0);assert.throws(()=>readFleetProgress(f.configFile,{projectId:'../../private'}),e=>e.code==='BAD_INPUT');
});
test('invalid task partitions, cycles, statuses and unbounded files reject instead of yielding a success percentage',()=>{
 for(const mutate of [f=>f.plan.phases[1].task_ids.push('T0a'),f=>f.plan.tasks[0].depends_on.push('T0b'),f=>f.plan.phases[0].depends_on.push('S1'),f=>f.plan.tasks[0].status={token:'PRIVATE'},f=>writeFileSync(f.policies[0].inputs[0].path,Buffer.alloc(4*1024*1024+1))]){const f=fixture();mutate(f);f.flush();assert.throws(()=>f.view());}
});
test('existing unsigned phase drafts remain pending and the real 72-task plan is projected without importing it',()=>{
 const f=fixture(),p=JSON.parse(readFileSync(join(ROOT,'docs/多终端共享看板-任务清单.json'),'utf8'));f.plan=p;save(f.manifestFile,p);f.config.plans[0].phases=p.phases.map(x=>({phase_id:x.id,required_roles:['TEST','REVIEW'],implementer_ids:['builder'],inputs:[{id:'fixture-code',path:f.policies[0].inputs[0].path}],receipts:[]}));const receiptPath=join(ROOT,'docs/federation/gates/G01.draft.json');f.config.plans[0].phases.find(x=>x.phase_id==='S01').receipts=[{path:receiptPath,sha256:hash(readFileSync(receiptPath)),registered_by:'operator',registered_at:AT}];save(f.configFile,f.config);const v=f.view();assert.equal(v.counts.total_tasks,72);assert.equal(v.counts.total_phases,12);assert.equal(v.counts.accepted_tasks,0);assert.equal(v.phases.find(p=>p.phase_id==='S01').state,'pending');
});
test('CLI emits only a pending digest-bound draft without modifying registered files',()=>{
 const f=fixture(),before=readFileSync(f.configFile);const r=spawnSync(process.execPath,[join(ROOT,'cli/progress.mjs'),'--config',f.configFile,'--plan','P1','--phase','S0'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);const d=JSON.parse(r.stdout);assert.equal(d.decision,'pending');assert.deepEqual(d.accepted_task_ids,[]);assert.equal(d.contract_sha256,phase(f,'S0').contract_sha256);assert.deepEqual(readFileSync(f.configFile),before);
});
test('real progress HTTP route uses operator auth and rejects cross-origin, worker and reviewer reads', {timeout:40000},async()=>{
 const f=fixture();record(f,'S0');const board=join(f.dir,'board');mkdirSync(board);const config=join(board,'config.json');save(config,{lines:[{id:'fixture',label:'fixture'}],roles:[],routes:['default'],repo:board});const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));let output='';
 const proc=spawn(process.execPath,[join(ROOT,'core/server.mjs')],{cwd:board,windowsHide:true,env:{...process.env,BOARD_HOST:'127.0.0.1',BOARD_PORT:String(port),BOARD_CONFIG:config,BOARD_DATA_DIR:board,BOARD_DB:join(board,'board.db'),BOARD_REPO:board,BOARD_PROGRESS_CONFIG:f.configFile,BOARD_FLEET_ACTIONS_CONFIG:'',BOARD_POOL_TEST_MODE:'1',BOARD_POOL_TEST_PROBE:'ok'},stdio:['ignore','pipe','pipe']});proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);const base='http://127.0.0.1:'+port;
 try{let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}if(proc.exitCode!==null)break;await sleep(150);}assert.ok(ready,output);const token=readFileSync(join(board,'board_token'),'utf8').trim(),get=(suffix='',headers={})=>fetch(base+'/api/fleet/progress'+suffix,{headers});assert.equal((await get()).status,401);for(const role of ['worker','review'])assert.equal((await get('',{'X-Board-Token':readFileSync(join(board,role+'_token'),'utf8').trim()})).status,403);assert.equal((await get('',{'X-Board-Token':token,Origin:'https://foreign.invalid'})).status,403);const r=await get('',{'X-Board-Token':token});assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal((await r.json()).plans[0].counts.accepted_tasks,2);const empty=await get('?project=missing',{'X-Board-Token':token});assert.deepEqual((await empty.json()).plans,[]);assert.equal((await get('?project=..%2Fbad',{'X-Board-Token':token})).status,400);
 }finally{if(proc.exitCode===null){const exit=new Promise(r=>proc.once('exit',r));proc.kill();await exit;}}
});
