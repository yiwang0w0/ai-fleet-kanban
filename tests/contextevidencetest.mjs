import test,{after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,renameSync,rmSync,linkSync,unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {evidenceFixture} from "./helpers/fleet-evidence-fixture.mjs";
import {putRole,issuePrincipal,revokePrincipal} from "../core/mcp/policy.mjs";
import {enrollTask} from "../core/mcp/tools.mjs";
import {canonical,digest} from "../core/federation/sync-store.mjs";
import {readDesktopSnapshot,publishDesktopSnapshot,exportDesktopContext,saveDesktopHandoff} from "../core/desktop-context.mjs";
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-handoff-")),handles=[];let seq=0;
after(()=>{for(const db of handles)try{db.close();}catch{}const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith(".."));rmSync(TMP,{recursive:true,force:true});});
function fixture({withBinding=true}={}){
 const dir=join(TMP,String(++seq));mkdirSync(dir);const dbPath=join(dir,"board.db"),f=evidenceFixture(dbPath,{withBinding});handles.push(f.db);
 putRole(f.db,{role_id:"observe",kind:"observe",projects:["demo","second","private"],capabilities:[],runtime:null,model:null,effort:null,tools:"read-only",priority:10,enabled:true,limits:{max_task_attempts:1,max_open_tasks:100,requests_per_minute:300}});
 const credentialFile=join(dir,"observe.json"),p=issuePrincipal(f.db,{roleId:"observe",projects:["demo","second"],credentialFile}),c=JSON.parse(readFileSync(credentialFile,"utf8"));
 const root=join(dir,"context"),summaryFile=join(dir,"摘要.md");writeFileSync(summaryFile,"已核对任务。下一步：等待远端回执。\n<img src=x onerror=alert(1)>\n");
 return {...f,rootTask:f.root,dir,dbPath,credentialFile,principal:p,credential:c,auth:"Bearer "+c.token,root,summaryFile,handoffId:randomUUID()};
}
const snapshot=f=>readDesktopSnapshot(f.db,f.auth);
const exportNow=f=>exportDesktopContext({dbPath:f.dbPath,credentialFile:f.credentialFile,root:f.root});
const save=(f,extra={})=>saveDesktopHandoff({dbPath:f.dbPath,credentialFile:f.credentialFile,root:f.root,taskUid:f.source.task_uid,expectedVersion:f.source.aggregate_version,handoffId:f.handoffId,client:"Zcode",summaryFile:f.summaryFile,...extra});
function generation(f){const entry=readFileSync(join(f.root,"ENTRY.md"),"utf8"),id=entry.match(/ai-fleet-context\/v1 ([0-9a-f-]+)/)[1],base=join(f.root,"snapshots",id),manifest=JSON.parse(readFileSync(join(base,"manifest.json"),"utf8"));return {entry,id,base,manifest};}
const taskPath=(base,uid)=>join(base,"tasks",uid.replace("/","--")+".md");
test("one scoped catalog exports direct task evidence and parent links without private raw fields",()=>{
 const f=fixture(),privateId=f.store.add(f.db,{subject:"PRIVATE-TASK"});enrollTask(f.db,{id:privateId,projectId:"private",workKind:"implement",capabilities:[],expectedVersion:f.store.get(f.db,privateId).aggregate_version});
 const policy=JSON.stringify({context:{model:"fixture-model",effort:"low",secret:"PRIVATE-POLICY"}}),run=randomUUID();
 f.db.prepare("INSERT INTO task_runs(run_id,task_id,task_uid,owner_node_id,executor_node_id,worker,role_id,runtime,agent_instance_id,policy_json,policy_sha256,started_at,first_attempt,last_attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(run,f.source.id,f.source.task_uid,f.local.node_id,f.local.node_id,"fixture","implementer","zcode",randomUUID(),policy,createHash("sha256").update(policy).digest("hex"),f.now,1,1);
 const before=f.db.prepare("SELECT total_changes() n").get().n,s=snapshot(f);assert.equal(s.evidence.format,"ai-fleet-evidence-catalog/v1");assert.equal(s.evidence.runs.total,1);publishDesktopSnapshot(s,{root:f.root});
 const g=generation(f),evidence=readFileSync(join(g.base,"EVIDENCE.md"),"utf8"),task=readFileSync(taskPath(g.base,f.source.task_uid),"utf8"),parent=readFileSync(taskPath(g.base,f.rootTask.task_uid),"utf8");
 assert.match(task,new RegExp("../EVIDENCE.md#run-"+run));assert.ok(parent.includes(f.source.task_uid.replace("/","--")+".md"));assert.ok(evidence.includes('id="run-'+run+'"'));assert.ok(evidence.includes("fixture-model"));assert.ok(g.entry.includes("HANDOFFS.md"));
 let all="";for(const file of g.manifest.files){const raw=readFileSync(join(g.base,file.path));assert.equal(createHash("sha256").update(raw).digest("hex"),file.sha256);all+=raw.toString();}
 for(const v of ["PRIVATE-TASK","PRIVATE-POLICY","PRIVATE-CONTRACT","PRIVATE-OFFER-BODY",f.credential.token])assert.ok(!all.includes(v),v);assert.equal(f.db.prepare("SELECT total_changes() n").get().n,before);
});
test("catalog includes authorized projects and all relations beyond the ordinary 500-edge page",()=>{
 const f=fixture(),id=f.store.add(f.db,{subject:"第二项目"});enrollTask(f.db,{id,projectId:"second",workKind:"implement",capabilities:[],expectedVersion:f.store.get(f.db,id).aggregate_version});
 const stmt=f.db.prepare("INSERT INTO delegation_outgoing(delegation_id,project_id,source_task_uid,target_node_id,target_epoch,request_digest,offer_digest,offer_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
 f.db.exec("BEGIN");for(let i=0;i<501;i++){const o={...f.offer,delegation_id:randomUUID()},h=digest(o);stmt.run(o.delegation_id,"demo",f.source.task_uid,f.remote,f.remoteEpoch,h,h,canonical(o),"pending",f.now,f.now);}f.db.exec("COMMIT");
 const s=snapshot(f);assert.equal(s.view.relations.items.length,500);assert.equal(s.evidence.relations.items.length,502);assert.equal(s.evidence.relations.truncated,false);assert.ok(s.tasks.some(t=>t.project_id==="second"));publishDesktopSnapshot(s,{root:f.root});assert.match(readFileSync(join(generation(f).base,"EVIDENCE.md"),"utf8"),/本机可见记录：502/);
});
test("explicit handoff saves once, preserves task state and exports safe Markdown",()=>{
 const f=fixture(),before=f.db.prepare("SELECT total_changes() n").get().n,a=save(f),g=generation(f),b=save(f);assert.equal(a.handoff_status,"saved");assert.equal(b.handoff_status,"already_saved");assert.equal(b.status,"unchanged");assert.equal(a.generation,b.generation);
 assert.equal(readdirSync(join(f.root,"handoffs")).length,1);const note=readFileSync(join(g.base,"HANDOFFS.md"),"utf8");assert.match(note,/来源客户端：Zcode/);assert.match(note,/版本一致/);assert.ok(note.includes("    <img"));assert.ok(!note.includes(f.credential.token));assert.equal(f.db.prepare("SELECT total_changes() n").get().n,before);
});
test("version mismatch refuses a new note; an existing request stays idempotent and visibly becomes stale",()=>{
 const f=fixture({withBinding:false});save(f);f.db.prepare("UPDATE tasks SET description='updated' WHERE id=?").run(f.source.id);
 assert.throws(()=>save(f,{handoffId:randomUUID()}),{code:"STALE_TASK"});assert.equal(readdirSync(join(f.root,"handoffs")).length,1);
 const result=save(f);assert.equal(result.handoff_status,"already_saved");assert.match(readFileSync(join(generation(f).base,"HANDOFFS.md"),"utf8"),/任务已变化/);
});
test("same handoff ID with changed content cannot overwrite history or the current entry",()=>{
 const f=fixture();save(f);const g=generation(f),path=join(f.root,"handoffs",f.handoffId+".json"),raw=readFileSync(path,"utf8");writeFileSync(f.summaryFile,"changed");
 assert.throws(()=>save(f),{code:"HANDOFF_CONFLICT"});assert.equal(readFileSync(path,"utf8"),raw);assert.equal(generation(f).entry,g.entry);
});
test("unauthorized task and revoked principal cannot publish a summary",()=>{
 const f=fixture(),id=f.store.add(f.db,{subject:"PRIVATE-TASK"}),task=f.store.get(f.db,id);enrollTask(f.db,{id,projectId:"private",workKind:"implement",capabilities:[],expectedVersion:task.aggregate_version});
 assert.throws(()=>save(f,{taskUid:task.task_uid,expectedVersion:f.store.get(f.db,id).aggregate_version}),{code:"NOT_FOUND"});assert.ok(!existsSync(join(f.root,"ENTRY.md")));
 revokePrincipal(f.db,{principalId:f.principal.principal_id,expectedVersion:1});assert.throws(()=>save(f),{code:"UNAUTHENTICATED"});
});
test("corrupt or unrecognized note files preserve the last published snapshot",()=>{
 const f=fixture();save(f);const g=generation(f),path=join(f.root,"handoffs",f.handoffId+".json"),raw=JSON.parse(readFileSync(path,"utf8"));raw.record.summary="tamper";writeFileSync(path,JSON.stringify(raw));
 assert.throws(()=>exportNow(f),{code:"HANDOFF_CHANGED"});assert.equal(generation(f).entry,g.entry);
});
test("a completely written pending note resumes the original ID without overwriting or recapturing its version",()=>{
 const f=fixture({withBinding:false});save(f);const path=join(f.root,"handoffs",f.handoffId+".json"),pending=join(f.root,"handoffs","."+f.handoffId+".tmp"),raw=readFileSync(path,"utf8");renameSync(path,pending);
 assert.throws(()=>exportNow(f),{code:"HANDOFF_PENDING"});f.db.prepare("UPDATE tasks SET description='later' WHERE id=?").run(f.source.id);
 const r=save(f);assert.equal(r.handoff_status,"saved");assert.equal(readFileSync(path,"utf8"),raw);assert.ok(!existsSync(pending));assert.match(readFileSync(join(generation(f).base,"HANDOFFS.md"),"utf8"),/任务已变化/);
});
test("invalid UTF-8, credential-like file extensions and oversized summaries are rejected before publishing",()=>{
 const f=fixture();assert.throws(()=>save(f,{summaryFile:f.credentialFile}),{code:"BAD_INPUT"});writeFileSync(f.summaryFile,Buffer.from([0xff,0xfe,0]));
 assert.throws(()=>save(f),{code:"BAD_INPUT"});writeFileSync(f.summaryFile,"x".repeat(64*1024+1));assert.throws(()=>save(f),{code:"HANDOFF_CHANGED"});assert.ok(!existsSync(join(f.root,"ENTRY.md")));
});
test("evidence or handoff file edits are caught before a repeated export",()=>{
 const f=fixture();exportNow(f);const g=generation(f);writeFileSync(join(g.base,"EVIDENCE.md"),"user content");assert.throws(()=>exportNow(f),{code:"CONTEXT_CHANGED"});assert.equal(generation(f).entry,g.entry);
});
test("truncated evidence cannot be published as a complete snapshot",()=>{
 const f=fixture();exportNow(f);const g=generation(f),s=snapshot(f);s.evidence.results.truncated=true;assert.throws(()=>publishDesktopSnapshot(s,{root:f.root}),{code:"CONTEXT_TOO_LARGE"});assert.equal(generation(f).entry,g.entry);
});
test("actual handoff CLI writes a note and prints only its receipt",()=>{
 const f=fixture(),r=spawnSync(process.execPath,[join(ROOT,"cli/context-handoff.mjs"),"--db",f.dbPath,"--credential-file",f.credentialFile,"--root",f.root,"--task-uid",f.source.task_uid,"--expected-version",String(f.source.aggregate_version),"--handoff-id",f.handoffId,"--client","Claude","--summary-file",f.summaryFile],{encoding:"utf8",windowsHide:true,timeout:30000});
 assert.equal(r.status,0,r.stderr);const receipt=JSON.parse(r.stdout);assert.equal(receipt.handoff_id,f.handoffId);assert.equal(receipt.handoff_status,"saved");assert.ok(!r.stdout.includes(f.credential.token));assert.ok(!r.stdout.includes("已核对任务"));assert.ok(existsSync(receipt.entry));
});

test("carriage-return Markdown cannot escape a literal handoff block",()=>{
 const f=fixture();writeFileSync(f.summaryFile,"line\r<img src=https://outside.invalid/x>\r# override");save(f);
 const md=readFileSync(join(generation(f).base,"HANDOFFS.md"),"utf8");assert.ok(md.includes("\n    <img"));assert.ok(md.includes("\n    # override"));assert.ok(!md.includes("\r"));
});
test("a crash after creating the final hard link resumes without duplicate records",()=>{
 const f=fixture();save(f);const path=join(f.root,"handoffs",f.handoffId+".json"),pending=join(f.root,"handoffs","."+f.handoffId+".tmp");linkSync(path,pending);
 assert.throws(()=>exportNow(f),{code:"HANDOFF_PENDING"});const result=save(f);assert.equal(result.handoff_status,"already_saved");assert.ok(!existsSync(pending));assert.equal(readdirSync(join(f.root,"handoffs")).length,1);
});
test("partial pending content and conflicting files are preserved for operator recovery",()=>{
 const f=fixture();exportNow(f);const old=generation(f).entry,pending=join(f.root,"handoffs");mkdirSync(pending);const partial=join(pending,"."+f.handoffId+".tmp");writeFileSync(partial,'{"record":');
 assert.throws(()=>save(f),{code:"HANDOFF_CHANGED"});assert.equal(readFileSync(partial,"utf8"),'{"record":');assert.equal(generation(f).entry,old);assert.ok(!existsSync(join(pending,f.handoffId+".json")));
});
test("snapshot retention preserves handoff records and can prune generated evidence files",context=>{
 context.mock.timers.enable({apis:["Date"],now:Date.now()});const f=fixture({withBinding:false});save(f);const note=join(f.root,"handoffs",f.handoffId+".json"),raw=readFileSync(note,"utf8"),first=generation(f).base;
 for(let i=0;i<4;i++){context.mock.timers.tick(1000);f.db.prepare("UPDATE tasks SET description=? WHERE id=?").run("revision "+i,f.source.id);publishDesktopSnapshot(snapshot(f),{root:f.root,retention:{keep:2,minAgeMinutes:1}});}
 context.mock.timers.tick(61000);const result=publishDesktopSnapshot(snapshot(f),{root:f.root,retention:{keep:2,minAgeMinutes:1}});assert.ok(result.retention.completed_generations>0);assert.ok(!existsSync(first));assert.equal(readFileSync(note,"utf8"),raw);assert.ok(existsSync(join(generation(f).base,"EVIDENCE.md")));
});
test("legacy snapshot entries without evidence files remain readable during upgrade",()=>{
 const f=fixture();exportNow(f);const g=generation(f),m={...g.manifest,files:g.manifest.files.filter(x=>!["EVIDENCE.md","HANDOFFS.md"].includes(x.path))};
 for(const name of ["EVIDENCE.md","HANDOFFS.md"])unlinkSync(join(g.base,name));const raw=JSON.stringify(m,null,2)+"\n",h=createHash("sha256").update(raw).digest("hex");writeFileSync(join(g.base,"manifest.json"),raw);
 const legacy=g.entry.replace(g.manifest.files.length?"- [运行与交付证据](snapshots/"+g.id+"/EVIDENCE.md)\n":"unused","").replace("- [对话交接摘要](snapshots/"+g.id+"/HANDOFFS.md)\n","").replace(/^<!-- ai-fleet-context\/v1 [^\n]+/,"<!-- ai-fleet-context/v1 "+g.id+" "+h+" -->");
 writeFileSync(join(f.root,"ENTRY.md"),legacy);f.db.prepare("UPDATE tasks SET description='changed' WHERE id=?").run(f.rootTask.id);const r=exportNow(f);assert.equal(r.status,"published");assert.ok(generation(f).entry.includes("EVIDENCE.md"));assert.equal(readFileSync(join(g.base,"manifest.json"),"utf8"),raw);
});
test("notes for tasks withdrawn from the active view remain stored but are absent from the new index",()=>{
 const f=fixture({withBinding:false});save(f);const note=join(f.root,"handoffs",f.handoffId+".json");f.db.prepare("UPDATE tasks SET archived_at=? WHERE id=?").run(new Date().toISOString(),f.source.id);exportNow(f);
 assert.ok(existsSync(note));const md=readFileSync(join(generation(f).base,"HANDOFFS.md"),"utf8");assert.ok(!md.includes(f.handoffId));assert.ok(md.includes("本代没有可见"));
});

test("a valid 64 KiB summary remains readable when JSON escaping expands its stored representation",()=>{
 const f=fixture(),summary="x"+"\\".repeat(64*1024-1);writeFileSync(f.summaryFile,summary);const first=save(f);assert.equal(first.handoff_status,"saved");
 const raw=readFileSync(join(f.root,"handoffs",f.handoffId+".json"),"utf8");assert.ok(Buffer.byteLength(raw)>128*1024);assert.equal(JSON.parse(raw).record.summary,summary);assert.equal(save(f).handoff_status,"already_saved");
});
