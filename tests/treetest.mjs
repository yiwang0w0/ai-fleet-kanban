import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
const require=createRequire(import.meta.url),store=require("../core/store.js"),tree=require("../core/task_tree.js");
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-tree-")),dbs=[];let serial=0;
after(()=>{for(const db of dbs){try{db.close();}catch{}}rmSync(TMP,{recursive:true,force:true});});
function fixture(){
 const dbPath=join(TMP,"tree-"+serial+++".db"),db=new DatabaseSync(dbPath);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);
 return {db,dbPath};
}
function card(db,extra={}){return store.add(db,{subject:"tree task "+serial++,route:"tree-fixture",line:"engine",treeMode:extra.parentId==null?"hierarchical":undefined,...extra});}
function chain(db,depth,{root=card(db,{kind:"goal"}),...extra}={}){
 const ids=[root];for(let i=0;i<depth;i++)ids.push(card(db,{parentId:ids.at(-1),...extra}));return ids;
}
const claim=(db,id,worker="fixture")=>store.claimById(db,{id,worker});
const snapshot=db=>JSON.stringify({tasks:db.prepare("SELECT * FROM tasks ORDER BY id").all(),events:db.prepare("SELECT * FROM task_events ORDER BY id").all()});
test("hierarchical task trees retain every parent through depth 32 and refuse depth 33 atomically",()=>{
 const {db}=fixture(),ids=chain(db,32);
 assert.equal(store.chainDepth(db,ids.at(-1)).depth,32);assert.equal(store.rootOf(db,ids.at(-1)),ids[0]);
 for(let i=0;i<ids.length;i++){
  assert.equal(store.get(db,ids[i]).parent_id,i?ids[i-1]:null);assert.equal(store.get(db,ids[i]).tree_mode,"hierarchical");
 }
 const before=snapshot(db);assert.throws(()=>card(db,{parentId:ids.at(-1)}),{code:"BAD_INPUT"});assert.equal(snapshot(db),before);
 assert.deepEqual(new Set(store.relatedIds(db,ids.at(-1))),new Set(ids));
});
test("the deepest leaf respects root release and creates no run or attempt until released",()=>{
 const {db}=fixture(),ids=chain(db,32);store.setReleased(db,{id:ids[0],released:false});
 assert.equal(claim(db,ids.at(-1)).ok,false);assert.equal(store.claim(db,"queue",5,{route:"tree-fixture",line:"engine"}),null);
 assert.equal(store.get(db,ids.at(-1)).attempts,0);assert.equal(store.runs(db,ids.at(-1)).length,0);
 store.setReleased(db,{id:ids[0],released:true});
 assert.equal(claim(db,ids.at(-1)).ok,true);assert.equal(store.get(db,ids.at(-1)).attempts,1);
});
test("WIP cap is shared by all deep branches of the same root",()=>{
 const {db}=fixture(),root=card(db,{kind:"goal"}),leaves=[];
 for(let i=0;i<store.WIP_PER_ROOT+1;i++)leaves.push(chain(db,8+i,{root}).at(-1));
 for(let i=0;i<store.WIP_PER_ROOT;i++)assert.equal(claim(db,leaves[i],"worker"+i).ok,true);
 const denied=claim(db,leaves.at(-1));assert.equal(denied.ok,false);assert.match(denied.why,/WIP/);assert.equal(store.get(db,leaves.at(-1)).attempts,0);
});
test("moving a subtree checks its deepest descendant before changing any parent or version",()=>{
 const {db}=fixture(),deep=chain(db,31),branch=chain(db,2,{root:card(db)}),before=snapshot(db);
 assert.throws(()=>store.update(db,{id:branch[0],parentId:deep.at(-1)}),{code:"BAD_INPUT"});
 assert.equal(snapshot(db),before);
 store.update(db,{id:branch[0],parentId:deep.at(-3)});
 assert.equal(store.chainDepth(db,branch.at(-1)).depth,32);assert.equal(store.rootOf(db,branch.at(-1)),deep[0]);
});
test("reparenting and detaching a branch with in-flight work are refused",()=>{
 const {db}=fixture(),a=chain(db,3,{root:card(db)}),b=card(db);
 assert.equal(claim(db,a.at(-1)).ok,true);const before=snapshot(db);
 for(const parentId of [b,null])assert.throws(()=>store.update(db,{id:a[1],parentId}),{code:"CONFLICT"});
 assert.equal(snapshot(db),before);assert.equal(store.get(db,a.at(-1)).status,"in_progress");
});
test("parent cycles, nested goals, ghost targets and mixed policy moves are refused",()=>{
 const {db}=fixture(),a=chain(db,3,{root:card(db)}),goal=card(db,{kind:"goal"}),legacy=store.add(db,{subject:"legacy"});
 for(const [id,parentId,code] of [[a[0],a.at(-1),"BAD_INPUT"],[goal,a[0],"BAD_INPUT"],[a[1],999999,"NOT_FOUND"],[a[1],legacy,"BAD_INPUT"]]){
  const before=snapshot(db);assert.throws(()=>store.update(db,{id,parentId}),{code});assert.equal(snapshot(db),before);
 }
});
test("task tree mode persists across migration and cannot be rewritten or mismatched at creation",()=>{
 const {db}=fixture(),root=card(db,{kind:"goal"}),id=card(db,{parentId:root}),before=store.get(db,id);
 store.migrate(db);assert.deepEqual(store.get(db,id),before);
 assert.throws(()=>db.prepare("UPDATE tasks SET tree_mode='legacy' WHERE id=?").run(id),/immutable/);
 assert.throws(()=>card(db,{parentId:root,treeMode:"legacy"}),{code:"BAD_INPUT"});
 assert.throws(()=>card(db,{treeMode:"unbounded"}),{code:"BAD_INPUT"});
 for(const field of ["treeMode","tree_mode"])assert.throws(()=>store.update(db,{id,[field]:"legacy"}),{code:"BAD_INPUT"});
});
test("legacy roots retain the existing two-layer uplift rule without converting historical tasks",()=>{
 const {db}=fixture(),root=store.add(db,{subject:"legacy goal",kind:"goal"}),a=store.add(db,{subject:"a",parentId:root}),b=store.add(db,{subject:"b",parentId:a}),c=store.add(db,{subject:"c",parentId:b});
 assert.equal(store.get(db,c).parent_id,root);assert.equal(store.get(db,c).released,false);assert.equal(store.get(db,c).tree_mode,"legacy");
});
test("closed ancestors prevent new children, moves and claims in hierarchical trees",()=>{
 for(const close of ["done","archived"]){
  const {db}=fixture(),ids=chain(db,3),outside=card(db);
  db.prepare(close==="done"?"UPDATE tasks SET status='done' WHERE id=?":"UPDATE tasks SET archived_at='fixture' WHERE id=?").run(ids[0]);
  assert.throws(()=>card(db,{parentId:ids[1]}),{code:"BAD_INPUT"});
  assert.throws(()=>store.update(db,{id:outside,parentId:ids[1]}),{code:"BAD_INPUT"});
  assert.equal(claim(db,ids.at(-1)).ok,false);assert.equal(store.get(db,ids.at(-1)).attempts,0);
 }
});
test("broken ancestor cycles and ghost links cannot become runnable roots",()=>{
 for(const fault of ["cycle","ghost","nested_goal"]){
  const {db}=fixture(),ids=chain(db,3,{root:card(db)});
  if(fault==="cycle")db.prepare("UPDATE tasks SET parent_id=? WHERE id=?").run(ids.at(-1),ids[0]);
  else if(fault==="ghost")db.prepare("UPDATE tasks SET parent_id=999999 WHERE id=?").run(ids[0]);
  else db.prepare("UPDATE tasks SET kind='goal' WHERE id=?").run(ids[1]);
  assert.equal(tree.ancestry(db,ids.at(-1)).valid,false);assert.equal(store.rootOf(db,ids.at(-1)),null);
  assert.equal(claim(db,ids.at(-1)).ok,false);assert.equal(store.claim(db,"queue",5,{route:"tree-fixture",line:"engine"}),null);
  assert.equal(store.get(db,ids.at(-1)).attempts,0);
 }
});
test("a leaf delivery does not complete its parent before acceptance of each level",()=>{
 const {db}=fixture(),ids=chain(db,4),leaf=ids.at(-1),parent=ids.at(-2);
 const owned=claim(db,leaf);assert.equal(owned.ok,true);
 store.report(db,{id:leaf,worker:"fixture",runId:owned.task.run_id,outcome:"done",evidence:"candidate leaf"});
 assert.equal(store.get(db,leaf).status,"waiting");assert.equal(claim(db,parent).ok,false);
 store.resolve(db,{id:leaf,verdict:"approve"});
 assert.equal(store.get(db,parent).status,"not_started");assert.notEqual(store.get(db,ids[0]).status,"done");
 assert.equal(claim(db,parent).ok,true);
});
test("archived descendants still count toward a moved subtree depth limit",()=>{
 const {db}=fixture(),deep=chain(db,31),branch=chain(db,2,{root:card(db)});
 store.archive(db,{id:branch.at(-1)});
 assert.throws(()=>store.update(db,{id:branch[0],parentId:deep.at(-1)}),{code:"BAD_INPUT"});
});
test("moving unrelated active branches remains possible and leaves the active run untouched",()=>{
 const {db}=fixture(),a=chain(db,2),b=chain(db,2),target=card(db,{kind:"goal"});
 assert.equal(claim(db,a.at(-1)).ok,true);const before=store.get(db,a.at(-1));
 store.update(db,{id:b[1],parentId:target,expectedVersion:store.get(db,b[1]).aggregate_version});
 assert.deepEqual(store.get(db,a.at(-1)),before);
 assert.equal(store.get(db,b[1]).parent_id,target);
});
test("stale reparent requests cannot overwrite a newer parent placement",()=>{
 const {db}=fixture(),a=card(db),b=card(db),c=card(db),v=store.get(db,a).aggregate_version;
 store.update(db,{id:a,parentId:b,expectedVersion:v});
 assert.throws(()=>store.update(db,{id:a,parentId:c,expectedVersion:v}),{code:"CONFLICT"});
 assert.equal(store.get(db,a).parent_id,b);
});
test("two independent processes cannot concurrently create A-parent-B and B-parent-A",async()=>{
 const {db,dbPath}=fixture(),a=card(db),b=card(db),script=join(TMP,"tree-race.mjs");
 writeFileSync(script,[
  'import {createRequire} from "node:module";',
  'import {createInterface} from "node:readline";',
  'import {DatabaseSync} from "node:sqlite";',
  'const require=createRequire(process.argv[2]),store=require("./core/store.js"),db=new DatabaseSync(process.argv[3]);db.exec("PRAGMA busy_timeout=5000");',
  'process.stdout.write("ready\\n");',
  'for await(const line of createInterface({input:process.stdin})){',
  ' try{store.update(db,{id:Number(process.argv[4]),parentId:Number(process.argv[5])});process.stdout.write("moved\\n");}',
  ' catch(e){process.stdout.write("refused:"+e.code+"\\n");}',
  ' db.close();break;',
  '}'
 ].join("\n"));
 const kids=[ [a,b],[b,a] ].map(([id,parent])=>{
  const child=spawn(process.execPath,[script,join(ROOT,"package.json"),dbPath,String(id),String(parent)],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let output="",errors="";let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
  child.stdout.on("data",d=>{output+=d.toString();if(output.includes("ready\n"))readyResolve();});child.stderr.on("data",d=>errors+=d.toString());
  const done=new Promise(r=>child.on("close",code=>{if(!output.includes("ready\n"))readyReject(Error("fixture startup failed: "+errors));r({code,output,errors});}));
  return {child,ready,done};
 });
 let timer;
 try{
  await Promise.race([Promise.all(kids.map(k=>k.ready)),new Promise((_,rej)=>timer=setTimeout(()=>rej(Error("tree race startup timeout")),15000))]);
  for(const k of kids)k.child.stdin.end("go\n");
  const out=await Promise.all(kids.map(k=>k.done));assert.ok(out.every(r=>r.code===0),JSON.stringify(out));
  assert.equal(out.filter(r=>r.output.includes("moved")).length,1);assert.equal(out.filter(r=>r.output.includes("refused:BAD_INPUT")).length,1);
  assert.equal(tree.ancestry(db,a).valid,true);assert.equal(tree.ancestry(db,b).valid,true);
 }finally{clearTimeout(timer);for(const k of kids)if(k.child.exitCode===null)k.child.kill();await Promise.all(kids.map(k=>k.done));}
});

test("read-only ancestry of a pre-profile schema preserves historical roots without migration",()=>{
 const db=new DatabaseSync(":memory:");dbs.push(db);
 db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY,parent_id INTEGER,kind TEXT,status TEXT,archived_at TEXT); INSERT INTO tasks VALUES(1,NULL,'goal','not_started',NULL),(2,1,'task','not_started',NULL)");
 assert.equal(store.rootOf(db,2),1);assert.equal(store.chainDepth(db,2).depth,1);
 assert.equal(tree.subtree(db,1).mode,"legacy");
 assert.ok(!db.prepare("PRAGMA table_info(tasks)").all().some(c=>c.name==="tree_mode"));
});
test("moving a branch rejects a corrupted nested goal among its descendants",()=>{
 const {db}=fixture(),ids=chain(db,2,{root:card(db)}),outside=card(db);
 db.prepare("UPDATE tasks SET kind='goal' WHERE id=?").run(ids.at(-1));const before=snapshot(db);
 assert.throws(()=>store.update(db,{id:ids[0],parentId:outside}),{code:"BAD_INPUT"});assert.equal(snapshot(db),before);
});


test("subtree scans accept exactly 10000 nodes and refuse larger branches",()=>{
 const db=new DatabaseSync(":memory:");dbs.push(db);
 db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY,parent_id INTEGER,kind TEXT,tree_mode TEXT,status TEXT,archived_at TEXT); CREATE INDEX parent_tree_fixture ON tasks(parent_id)");
 const insert=db.prepare("INSERT INTO tasks VALUES(?,?,'task','hierarchical','not_started',NULL)");
 insert.run(1,null);db.exec("BEGIN");for(let id=2;id<=tree.MAX_TREE_NODES;id++)insert.run(id,1);db.exec("COMMIT");
 const full=tree.subtree(db,1);assert.equal(full.valid,true);assert.equal(full.ids.length,10000);assert.equal(full.height,1);
 insert.run(tree.MAX_TREE_NODES+1,1);assert.equal(tree.subtree(db,1).reason,"size_limit");
});
