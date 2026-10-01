// Opt-in observations against a frozen baseline; successful probes confirm defects remain.
// Reuses that baseline's result protocol fixtures without changing product modules.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,relative,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const args=process.argv.slice(2),o={};
for(let i=0;i<args.length;i+=2){assert.ok(['--code-root','--revision','--output'].includes(args[i])&&args[i+1]);o[args[i].slice(2)]=args[i+1];}
const root=resolve(o['code-root']),git=(...a)=>execFileSync('git',['-c','safe.directory='+root,'-C',root,...a],{encoding:'utf8',windowsHide:true}).trim();
assert.equal(git('rev-parse','HEAD'),o.revision);
assert.match(o.revision,/^[a-f0-9]{40}$/);
assert.equal(git('status','--porcelain','--untracked-files=all'),'');
const sourceFile=join(root,'tests/resulttest.mjs'),original=readFileSync(sourceFile,'utf8');
const start=original.search(/^test\(/m);assert.ok(start>0);
const prefix=original.slice(0,start)
 .replaceAll('import.meta.url',JSON.stringify(pathToFileURL(sourceFile).href))
 .replace(/from "(\.\.?\/[^\"]+)"/g,(_,p)=>'from '+JSON.stringify(pathToFileURL(resolve(dirname(sourceFile),p)).href));
const suffix=`
const observations=[];
test('seven-module frozen cancellation and restore observations',async()=>{
 const f=fullyBound(),{w}=worker(f),c=received(f);
 const before=f.b.db.prepare('SELECT phase FROM broker_dispatches WHERE dispatch_id=?').get(w.dispatch_id).phase;
 assert.equal(before,'prepared');
 const url=await network(f.b),response=await fetch(url+'/peer/v1/delegation/cancel-status',{
  method:'POST',headers:{Authorization:f.ab.auth,'Content-Type':'application/json'},
  body:JSON.stringify({relation_id:f.d.relation_id,project_id:'demo',cancel_id:c.cancel_id})
 });
 assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.stopped,true);
 const after=f.b.db.prepare('SELECT phase FROM broker_dispatches WHERE dispatch_id=?').get(w.dispatch_id).phase;
 assert.equal(after,'abandoned');
 observations.push({id:'seven-module/H4b',runtime_reproduced:true,endpoint:'cancel-status',dispatch_before:before,dispatch_after:after,stopped_receipt_returned:true,model_started:false});
 recordCancellationReceipt(f.a.db,{relationId:f.d.relation_id,receipt});
 const source=bindingState(f.a.db,f.d.relation_id),target=bindingState(f.b.db,f.d.relation_id);
 assert.equal(source.state,'confirmed');assert.equal(target.state,'confirmed');
 assert.equal(f.a.db.prepare('SELECT closed FROM delegation_bindings WHERE relation_id=?').get(f.d.relation_id).closed,0);
 assert.equal(f.b.db.prepare('SELECT closed FROM delegation_bindings WHERE relation_id=?').get(f.d.relation_id).closed,0);
 assert.equal(store.claimById(f.a.db,{id:f.source.id,worker:'after-cancel'}).ok,false);
 observations.push({id:'seven-module/H4a',runtime_reproduced:true,both_cancellations_stopped:true,source_binding_state:source.state,target_binding_state:target.state,source_closed:0,target_closed:0,source_claim_refused:true});
 const g=fullyBound(),evidenceDir=join(TMP,'evidence');mkdirSync(evidenceDir);
 const evidenceFile=join(evidenceDir,'result.md');writeFileSync(evidenceFile,'Synthetic retained evidence; no real provider.\\n');
 // Set the legacy local evidence reference before sealing the result candidate.
 g.b.db.prepare('UPDATE tasks SET evidence_path=? WHERE id=?').run(evidenceFile,g.target.id);
 completed(g);const r=candidate(g);assert.equal(r.accepted,false);
 const backup=join(TMP,'backup-with-result'),dest=join(TMP,'restore-with-result');
 createBackup({dbPath:g.b.path,evidenceDir,destination:backup});
 let failure;try{restoreBackup({backupDirectory:backup,destination:dest});}catch(e){failure=e;}
 assert.ok(failure);assert.match(failure.message,/RESULT_PENDING/);
 assert.equal(existsSync(join(dest,'.incomplete')),true);
 assert.equal(existsSync(join(dest,'restore-receipt.json')),false);
 assert.equal(existsSync(evidenceFile),true);
 observations.push({id:'seven-module/H5a',runtime_reproduced:true,backup_completed:true,restore_error:'RESULT_PENDING',incomplete_marker_retained:true,restore_receipt_created:false,original_evidence_retained:true,setup_note:'Legacy evidence_path set before candidate sealing; protocol fixture uses synthetic process result and real backup/restore.'});
 writeFileSync(${JSON.stringify(resolve(o.output))},JSON.stringify({format:'ai-fleet-seven-module-result-review/v1',code_sha:${JSON.stringify(o.revision)},checked_at:new Date().toISOString(),findings:observations,real_model_calls:0,physical_two_pc:false,production_changed:false},null,2)+'\\n',{flag:'wx'});
});
`;
const temp=mkdtempSync(join(tmpdir(),'fleet-result-review-'));
try{
 const file=join(temp,'frozen-result-probes.mjs');writeFileSync(file,prefix+suffix);
 const run=spawnSync(process.execPath,['--test',file],{cwd:root,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
 if(run.error)throw run.error;if(run.status!==0)process.exitCode=run.status??1;
}finally{
 const rel=relative(resolve(tmpdir()),resolve(temp));assert.ok(rel&&!rel.startsWith('..'));
 rmSync(temp,{recursive:true,force:true});
}
