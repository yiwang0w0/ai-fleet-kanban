import vm from "node:vm";
import {requireGitVersion,probeGitVersion} from "../core/git-version.mjs";
import {PeerError} from "../core/federation/protocol.mjs";
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {createHash,randomUUID} from "node:crypto";
import {execFileSync,spawn} from "node:child_process";
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,chmodSync,symlinkSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {deflateSync} from "node:zlib";
import {artifactPath,repositoryReader,MAX_FILE_BYTES} from "../core/artifacts/git-reader.mjs";
import {migrateRepositories,registerRepository,approveRepositoryBase,repositoryState,listRepositories,captureRepositoryFiles} from "../core/artifacts/repositories.mjs";
import {createBackup,restoreBackup} from "../core/backup.mjs";
import {prepareRecovery,activateRecovery,retireNode} from "../core/recovery.mjs";
import {migrateBroker,putRole,issuePrincipal} from "../core/mcp/policy.mjs";
import {callTool,listTools} from "../core/mcp/tools.mjs";
const require=createRequire(import.meta.url),store=require("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url));
const TMP=mkdtempSync(join(tmpdir(),"fleet-repository-")),dbs=[],children=[];let seq=0;
const fresh=n=>join(TMP,n+"-"+seq++),hash=b=>createHash("sha256").update(b).digest("hex");
const execPath=execFileSync("git",["--exec-path"],{encoding:"utf8"}).trim();
const gitPath=process.platform==="win32"?realpathSync(join(execPath,"../../bin/git.exe")):realpathSync(execFileSync("which",["git"],{encoding:"utf8"}).trim());
const git={path:gitPath,sha256:hash(readFileSync(gitPath))};
const env={...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_CONFIG_SYSTEM:process.platform==="win32"?"NUL":"/dev/null",GIT_TERMINAL_PROMPT:"0"};
function g(root,args,input){return execFileSync(gitPath,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false",...args],{cwd:root,env,input,windowsHide:true,timeout:10000,stdio:["pipe","pipe","pipe"]});}
const text=(root,args,input)=>g(root,args,input).toString("utf8").trim();
function repo(format="sha1"){
 const root=fresh("仓库");mkdirSync(root);g(root,["init","--template=","--object-format="+format]);mkdirSync(join(root,"src"));mkdirSync(join(root,"docs"));
 const original=Buffer.from("line1\r\n中文\r\n");writeFileSync(join(root,"src","demo.txt"),original);writeFileSync(join(root,"docs","说明.md"),"base\n");writeFileSync(join(root,"private.txt"),"excluded\n");
 g(root,["-c","core.autocrlf=false","add","."]);g(root,["commit","-m","base"]);const base=text(root,["rev-parse","HEAD"]);
 writeFileSync(join(root,"docs","说明.md"),"delivery\n");g(root,["-c","core.autocrlf=false","add","."]);g(root,["commit","-m","delivery"]);const commit=text(root,["rev-parse","HEAD"]);
 return {root,base,commit,original};
}
function board(){const dir=fresh("board");mkdirSync(dir);const path=join(dir,"board.db"),db=new DatabaseSync(path);dbs.push(db);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");store.migrate(db);migrateRepositories(db);return {db,path,node:store.localNode(db)};}
function register(b,r,extra={}){const config={mappingId:randomUUID(),projectId:"demo",repoId:"app",root:r.root,git,baseCommit:r.base,paths:["src/","docs/"],...extra};return {config,state:registerRepository(b.db,config)};}
const capture=(b,r,extra={})=>captureRepositoryFiles(b.db,{projectId:"demo",repoId:"app",baseCommit:r.base,commit:r.commit,paths:["src/demo.txt","docs/说明.md"],...extra});
after(async()=>{for(const p of children)if(p.exitCode===null&&p.signalCode===null){const done=new Promise(r=>p.once("close",r));p.kill();await done;}for(const db of dbs)try{db.close();}catch{}rmSync(TMP,{recursive:true,force:true});});

test("two nodes map the same repository/base at different local paths and capture identical committed bytes",()=>{
 const r=repo(),other=fresh("另一电脑路径");g(TMP,["clone","--local","--no-hardlinks","--template=",r.root,other]);const a=board(),b=board();register(a,r);register(b,{...r,root:other});
 writeFileSync(join(r.root,"src","demo.txt"),"dirty local content");const x=capture(a,r),y=capture(b,{...r,root:other});assert.deepEqual(x.manifest,y.manifest);assert.equal(x.manifest_digest,y.manifest_digest);assert.deepEqual(x.files.find(f=>f.path==="src/demo.txt").bytes,r.original);assert.equal(x.accepted,false);
 assert.equal(JSON.stringify(x.manifest).includes(r.root),false);assert.equal(JSON.stringify(repositoryState(a.db,{projectId:"demo",repoId:"app"})).includes(r.root),false);assert.match(text(r.root,["status","--porcelain"]),/src\/demo.txt/);
});
test("mapping requests are immutable, exact replays are idempotent, and audit failure rolls back registration",()=>{
 const r=repo(),b=board(),x=register(b,r);assert.deepEqual(registerRepository(b.db,x.config),x.state);assert.throws(()=>register(b,r),{code:"MAPPING_EXISTS"});assert.throws(()=>registerRepository(b.db,{...x.config,paths:["docs/"]}),{code:"REQUEST_CONFLICT"});
 b.db.exec("CREATE TRIGGER fail_repo_event BEFORE INSERT ON repository_events BEGIN SELECT RAISE(ABORT,'fixture audit'); END");assert.throws(()=>register(b,r,{repoId:"other"}),/fixture audit/);assert.equal(b.db.prepare("SELECT count(*) n FROM repository_mappings").get().n,1);assert.equal(b.db.prepare("SELECT count(*) n FROM repository_bases").get().n,1);
 for(const table of ["repository_mappings","repository_bases","repository_events"])assert.throws(()=>b.db.exec("DELETE FROM "+table),/retained/);
});
test("missing commits, revision expressions, subdirectory roots and changed Git pins fail before registration",()=>{
 const r=repo(),b=board();for(const baseCommit of ["HEAD",r.base+"^{tree}","--help","f".repeat(40)])assert.throws(()=>register(b,r,{baseCommit}));
 assert.throws(()=>register(b,r,{root:join(r.root,"src")}),{code:"REPOSITORY_ROOT_REQUIRED"});assert.throws(()=>register(b,r,{root:"relative"}),{code:"ABSOLUTE_PATH_REQUIRED"});assert.throws(()=>register(b,r,{git:{...git,sha256:"0".repeat(64)}}),{code:"GIT_CHANGED"});assert.equal(listRepositories(b.db,{projectId:"demo"}).repositories.length,0);
});
test("new bases need explicit local approval and captures cannot substitute an unrelated commit",()=>{
 const r=repo(),b=board(),x=register(b,r);assert.throws(()=>capture(b,r,{baseCommit:r.commit}),{code:"BASE_NOT_APPROVED"});approveRepositoryBase(b.db,{mappingId:x.state.mapping_id,baseCommit:r.commit});assert.equal(capture(b,r,{baseCommit:r.commit}).manifest.base_commit,r.commit);
 const orphan=text(r.root,["commit-tree",text(r.root,["rev-parse",r.base+":"])],"unrelated\n");assert.throws(()=>capture(b,r,{commit:orphan}),{code:"BASE_NOT_ANCESTOR"});assert.equal(repositoryState(b.db,{mappingId:x.state.mapping_id}).approved_bases.length,2);
});
test("portable path rules and explicit local allowlists reject traversal, aliases and unwanted files",()=>{
 for(const p of ["../a","a/../b","/root","C:/x","a\\b","a//b",".git/config","git~1/config","AUX.txt","a:b","a ","a.","COM¹.txt","nul/x","e\u0301.txt","x\u0000y","x\u202ey"])assert.throws(()=>artifactPath(p),{code:"UNSAFE_ARTIFACT_PATH"},p);
 const r=repo(),b=board();register(b,r);assert.throws(()=>capture(b,r,{paths:["private.txt"]}),{code:"PATH_NOT_ALLOWED"});assert.throws(()=>capture(b,r,{paths:["docs/说明.md","DOCS/说明.md"]}),{code:"PATH_COLLISION"});assert.throws(()=>capture(b,r,{paths:["src/missing.txt"]}),{code:"FILE_NOT_COMMITTED"});
});
test("symlinks, symlink traversal, submodules and LFS pointers cannot masquerade as actual files",()=>{
 const r=repo(),b=board();register(b,r);const link=text(r.root,["hash-object","-w","--stdin"],"../../outside");g(r.root,["update-index","--add","--cacheinfo","120000,"+link+",src/link"]);g(r.root,["update-index","--add","--cacheinfo","160000,"+r.base+",src/submodule"]);writeFileSync(join(r.root,"src","large.bin"),"version https://git-lfs.github.com/spec/v1\noid sha256:"+"0".repeat(64)+"\nsize 100\n");g(r.root,["add","src/large.bin"]);g(r.root,["commit","-m","special files"]);r.commit=text(r.root,["rev-parse","HEAD"]);
 for(const name of ["src/link","src/link/secret","src/submodule"])assert.throws(()=>capture(b,r,{paths:[name]}),{code:"FILE_TYPE_UNSUPPORTED"});assert.throws(()=>capture(b,r,{paths:["src/large.bin"]}),{code:"LFS_CONTENT_REQUIRED"});
});
test("Git filters, replacement refs and ambient Git configuration do not change captured content",()=>{
 const r=repo(),b=board();register(b,r);const sentinel=join(r.root,"FILTER_RAN");writeFileSync(join(r.root,"filter.cjs"),"require('fs').writeFileSync("+JSON.stringify(sentinel)+",'bad')");g(r.root,["config","filter.trap.smudge",'"'+process.execPath+'" "'+join(r.root,"filter.cjs")+'"']);writeFileSync(join(r.root,".gitattributes"),"*.txt filter=trap\n");g(r.root,["add",".gitattributes"]);g(r.root,["commit","-m","attributes"]);const commit=text(r.root,["rev-parse","HEAD"]);
 g(r.root,["replace",r.commit,r.base]);const saved={GIT_DIR:process.env.GIT_DIR,GIT_CONFIG_COUNT:process.env.GIT_CONFIG_COUNT,GIT_CONFIG_KEY_0:process.env.GIT_CONFIG_KEY_0,GIT_CONFIG_VALUE_0:process.env.GIT_CONFIG_VALUE_0};Object.assign(process.env,{GIT_DIR:"missing-repository",GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"core.repositoryformatversion",GIT_CONFIG_VALUE_0:"999"});
 try{assert.deepEqual(capture(b,r,{commit}).files.find(f=>f.path==="src/demo.txt").bytes,r.original);}finally{for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
 assert.equal(existsSync(sentinel),false);assert.equal(capture(b,r).manifest.commit,r.commit);assert.equal(capture(b,r).files.find(f=>f.path==="docs/说明.md").bytes.toString(),"delivery\n");
});
test("SHA-256 repositories produce verified native object IDs and portable content hashes",()=>{
 const r=repo("sha256"),b=board();register(b,r);const out=capture(b,r);assert.equal(out.manifest.object_format,"sha256");assert.equal(out.manifest.commit.length,64);assert.equal(out.manifest.files[0].sha256,hash(out.files[0].bytes));
});
test("corrupt blobs and child trees are rejected even when stored under an expected object filename",()=>{
 for(const type of ["blob","tree"]){const r=repo(),b=board();register(b,r);const oid=text(r.root,["rev-parse",r.commit+":"+(type==="blob"?"src/demo.txt":"src")]),body=type==="blob"?Buffer.from("forged"):Buffer.from("100644 counterfeit\0"+"x".repeat(20)),object=Buffer.concat([Buffer.from(type+" "+body.length+"\0"),body]);chmodSync(join(r.root,".git","objects",oid.slice(0,2),oid.slice(2)),0o600);writeFileSync(join(r.root,".git","objects",oid.slice(0,2),oid.slice(2)),deflateSync(object));assert.throws(()=>capture(b,r),{code:"OBJECT_CORRUPT"});}
});
test("missing local objects never trigger an implicit promisor fetch",()=>{
 const r=repo(),b=board();register(b,r);const oid=text(r.root,["rev-parse",r.commit+":src/demo.txt"]);rmSync(join(r.root,".git","objects",oid.slice(0,2),oid.slice(2)));g(r.root,["config","core.repositoryformatversion","1"]);g(r.root,["config","extensions.partialClone","origin"]);g(r.root,["config","remote.origin.promisor","true"]);g(r.root,["config","remote.origin.url","ext::never-execute-this-helper"]);
 assert.throws(()=>capture(b,r),{code:"GIT_READ_FAILED"});assert.equal(existsSync(join(r.root,".git","FETCH_HEAD")),false);
});
test("file size bounds are checked before capturing oversized content",()=>{
 const r=repo(),b=board();register(b,r);writeFileSync(join(r.root,"src","huge.bin"),Buffer.alloc(MAX_FILE_BYTES+1));g(r.root,["add","src/huge.bin"]);g(r.root,["commit","-m","oversized"]);r.commit=text(r.root,["rev-parse","HEAD"]);assert.throws(()=>capture(b,r,{paths:["src/huge.bin"]}),{code:"CAPTURE_LIMIT"});
});

test("empty and executable files preserve exact bytes/mode; untracked files are never read",()=>{
 const r=repo(),b=board();register(b,r);writeFileSync(join(r.root,"src","empty"),Buffer.alloc(0));writeFileSync(join(r.root,"src","run.sh"),"echo fixture\n");g(r.root,["add","src/empty","src/run.sh"]);g(r.root,["update-index","--chmod=+x","src/run.sh"]);g(r.root,["commit","-m","regular artifacts"]);r.commit=text(r.root,["rev-parse","HEAD"]);writeFileSync(join(r.root,"src","untracked"),"never read");
 const x=capture(b,r,{paths:["src/empty","src/run.sh"]});assert.equal(x.manifest.files[0].size,0);assert.equal(x.manifest.files[1].mode,"100755");assert.throws(()=>capture(b,r,{paths:["src/untracked"]}),{code:"FILE_NOT_COMMITTED"});
});
test("intermediate ancestry commit corruption is detected before asserting approved-base descent",()=>{
 const r=repo(),b=board();register(b,r);const middle=r.commit;writeFileSync(join(r.root,"docs","说明.md"),"third\n");g(r.root,["add","."]);g(r.root,["commit","-m","third"]);r.commit=text(r.root,["rev-parse","HEAD"]);
 const body=g(r.root,["cat-file","commit",middle]),changed=Buffer.from(body.toString().replace("delivery","tampered")),file=join(r.root,".git","objects",middle.slice(0,2),middle.slice(2));chmodSync(file,0o600);writeFileSync(file,deflateSync(Buffer.concat([Buffer.from("commit "+changed.length+"\0"),changed])));assert.throws(()=>capture(b,r),{code:"OBJECT_CORRUPT"});
});
test("base approval and migrations retain history and roll back a nested failed audit",()=>{
 const r=repo(),b=board(),x=register(b,r);b.db.exec("BEGIN IMMEDIATE; CREATE TRIGGER injected_base BEFORE INSERT ON repository_events WHEN NEW.kind='base_approved' BEGIN SELECT RAISE(ABORT,'base audit'); END");assert.throws(()=>approveRepositoryBase(b.db,{mappingId:x.state.mapping_id,baseCommit:r.commit}),/base audit/);assert.equal(b.db.isTransaction,true);assert.equal(repositoryState(b.db,{mappingId:x.state.mapping_id}).approved_bases.length,1);b.db.exec("COMMIT; DROP TRIGGER injected_base");
 migrateRepositories(b.db);store.migrate(b.db);assert.equal(capture(b,r).manifest.commit,r.commit);b.db.exec("UPDATE repository_schema SET version=99");assert.throws(()=>migrateRepositories(b.db),{code:"SCHEMA_INCOMPATIBLE"});assert.throws(()=>capture(b,r),{code:"SCHEMA_INCOMPATIBLE"});assert.throws(()=>listRepositories(b.db,{projectId:"demo"}),{code:"SCHEMA_INCOMPATIBLE"});
});
test("MCP repository metadata is project scoped and never exposes paths or a registration/file-read tool",()=>{
 const r=repo(),b=board();register(b,r);migrateBroker(b.db);putRole(b.db,{role_id:"observer",kind:"observe",projects:["demo"],capabilities:[],runtime:null,model:null,effort:null,tools:"read-only",priority:1,enabled:true,limits:{max_task_attempts:1,max_open_tasks:10,requests_per_minute:300}});const credential=fresh("mcp")+".json";issuePrincipal(b.db,{roleId:"observer",projects:["demo"],credentialFile:credential});const auth="Bearer "+JSON.parse(readFileSync(credential,"utf8")).token;
 const value=callTool(b.db,auth,"get_repository",{project_id:"demo",repo_id:"app"});assert.equal(value.repo_id,"app");assert.equal(JSON.stringify(value).includes(r.root),false);assert.equal(JSON.stringify(value).includes(git.path),false);assert.equal(callTool(b.db,auth,"list_repositories",{project_id:"demo",limit:100}).repositories.length,1);
 assert.throws(()=>callTool(b.db,auth,"get_repository",{project_id:"other",repo_id:"app"}),{code:"FORBIDDEN"});assert.equal(listTools(b.db,auth).tools.some(t=>["register_repository","capture_repository_files","approve_repository_base"].includes(t.name)),false);assert.throws(()=>callTool(b.db,auth,"get_repository",{project_id:"demo",repo_id:"app",path:r.root}),{code:"BAD_INPUT"});
});
test("explicit local CLI registers/approves/inspects and emits a captured manifest without claiming transfer",()=>{
 const r=repo(),b=board(),config=fresh("config")+".json",paths=fresh("paths")+".json",mapping=randomUUID();writeFileSync(config,JSON.stringify({mapping_id:mapping,project_id:"demo",repo_id:"app",root:r.root,git,base_commit:r.base,paths:["docs/","src/"]}));writeFileSync(paths,JSON.stringify(["docs/说明.md"]));
 const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[join(ROOT,"cli","repository.mjs"),...args],{windowsHide:true,timeout:15000,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
 assert.equal(cli("register","--db",b.path,"--config-file",config).mapping_id,mapping);assert.equal(cli("get","--db",b.path,"--project","demo","--repo","app").approved_bases.length,1);assert.equal(cli("list","--db",b.path,"--project","demo").repositories.length,1);
 const out=cli("manifest","--db",b.path,"--project","demo","--repo","app","--base",r.base,"--commit",r.commit,"--paths-file",paths);assert.equal(out.manifest.files[0].sha256,hash(Buffer.from("delivery\n")));assert.equal(out.content_captured,true);assert.equal(out.content_persisted,false);assert.equal(out.transferred,false);assert.equal(out.accepted,false);assert.equal(cli("approve-base","--db",b.path,"--mapping",mapping,"--base",r.commit).approved_bases.length,2);
});
test("actual backup activation invalidates old location approvals and permits a fresh local re-registration",()=>{
 const r=repo(),b=board(),x=register(b,r),evidence=fresh("evidence");mkdirSync(evidence);writeFileSync(join(evidence,"fixture.txt"),"isolated repository evidence");const backup=createBackup({dbPath:b.path,evidenceDir:evidence,destination:fresh("backup")}),dest=fresh("restored");restoreBackup({backupDirectory:backup.destination,destination:dest});const path=join(dest,"board.db"),db=new DatabaseSync(path);dbs.push(db);assert.throws(()=>repositoryState(db,{mappingId:x.state.mapping_id}),{code:"RESTORE_HOLD"});retireNode({dbPath:b.path,expectedEpoch:b.node.sync_epoch});const plan=prepareRecovery({dbPath:path});
 activateRecovery({dbPath:path,plan,expectedPlanDigest:plan.plan_digest,attestation:{format:"ai-fleet-retirement-attestation/v1",node_id:plan.node_id,retired_epoch:plan.retired_epoch,plan_digest:plan.plan_digest,original_board_stopped:true,original_agents_stopped:true,original_identity_disabled:true,other_restored_writers_stopped:true,evidence_ref:"isolated repository fixture",attested_at:new Date().toISOString()}});
 assert.throws(()=>repositoryState(db,{mappingId:x.state.mapping_id}),{code:"REPOSITORY_RECOVERY_REQUIRED"});assert.equal(listRepositories(db,{projectId:"demo"}).repositories[0].identity_current,0);assert.throws(()=>capture({db},r),{code:"REPOSITORY_NOT_REGISTERED"});register({db},r);assert.equal(capture({db},r).manifest.commit,r.commit);
});
test("two independent administrators racing one project/repository create one durable mapping",async()=>{
 const r=repo(),b=board();const script='import {DatabaseSync} from "node:sqlite"; import {registerRepository} from '+JSON.stringify(new URL("../core/artifacts/repositories.mjs",import.meta.url).href)+'; const [path,config]=process.argv.slice(1);const db=new DatabaseSync(path);db.exec("PRAGMA busy_timeout=5000");try{const value=registerRepository(db,JSON.parse(config));console.log(JSON.stringify({ok:true,id:value.mapping_id}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}finally{db.close();}';
 function launch(){return new Promise((resolve,reject)=>{const config={mappingId:randomUUID(),projectId:"demo",repoId:"app",root:r.root,git,baseCommit:r.base,paths:["docs/","src/"]},p=spawn(process.execPath,["--input-type=module","-e",script,b.path,JSON.stringify(config)],{windowsHide:true,stdio:["ignore","pipe","pipe"]});children.push(p);let out="",err="";p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>err+=b);p.once("error",reject);p.once("close",code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));});}
 const outcomes=await Promise.all([launch(),launch()]);assert.equal(outcomes.filter(x=>x.ok).length,1);assert.equal(outcomes.find(x=>!x.ok).code,"MAPPING_EXISTS");assert.equal(b.db.prepare("SELECT count(*) n FROM repository_mappings").get().n,1);assert.equal(b.db.prepare("SELECT count(*) n FROM repository_events").get().n,1);
});

test("raw commit headers cannot use high-bit bytes to impersonate an approved parent hash",()=>{
 const r=repo(),b=board();register(b,r);const tree=text(r.root,["rev-parse",r.commit+":"]),encoded=Buffer.from(r.base);for(let i=0;i<encoded.length;i++)encoded[i]|=128;const body=Buffer.concat([Buffer.from("tree "+tree+"\nparent "),encoded,Buffer.from("\nauthor Fixture <fixture@example.invalid> 1000000000 +0000\ncommitter Fixture <fixture@example.invalid> 1000000000 +0000\n\nmalformed parent\n")]);const commit=text(r.root,["hash-object","-t","commit","--literally","-w","--stdin"],body);assert.throws(()=>capture(b,r,{commit}),{code:"BAD_OBJECT_ID"});
});
test("selected files reject directory-prefix case aliases even when individual file names differ",()=>{
 const r=repo(),b=board();register(b,r);const blob=text(r.root,["rev-parse",r.base+":src/demo.txt"]),a=text(r.root,["mktree"],"100644 blob "+blob+"\ta\n"),z=text(r.root,["mktree"],"100644 blob "+blob+"\tb\n"),src=text(r.root,["mktree"],"040000 tree "+a+"\tFoo\n040000 tree "+z+"\tfoo\n"),root=text(r.root,["mktree"],"040000 tree "+src+"\tsrc\n"),commit=text(r.root,["commit-tree",root,"-p",r.base],"case collision\n");assert.throws(()=>capture(b,r,{commit,paths:["src/Foo/a","src/foo/b"]}),{code:"PATH_COLLISION"});
});

test("aggregate capture size and file counts are bounded even for deduplicated Git blobs",()=>{
 const r=repo(),b=board();register(b,r);const paths=[];for(let i=0;i<5;i++){const name="src/block"+i;paths.push(name);writeFileSync(join(r.root,name),Buffer.alloc(MAX_FILE_BYTES));}g(r.root,["add","src/"]);g(r.root,["commit","-m","bounded bundle"]);r.commit=text(r.root,["rev-parse","HEAD"]);assert.throws(()=>capture(b,r,{paths}),{code:"CAPTURE_LIMIT"});assert.throws(()=>capture(b,r,{paths:Array(257).fill("src/demo.txt")}),{code:"CAPTURE_LIMIT"});
});

test("filesystem identity accepts native/alias paths but still rejects a child directory as repository root",()=>{
 const r=repo(),b=board();let alias;
 if(process.platform==="win32"){
  // Invoke the native API through the existing test Python; avoid cold
  // PowerShell/COM startup becoming the subject of this filesystem test.
  const script="import ctypes, os; f=ctypes.WinDLL('kernel32', use_last_error=True).GetShortPathNameW; f.argtypes=[ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_uint32]; f.restype=ctypes.c_uint32; p=os.environ['AFK_TEST_LONG_ROOT']; n=f(p,None,0); assert n, ctypes.get_last_error(); b=ctypes.create_unicode_buffer(n); count=f(p,b,n); assert 0<count<n, ctypes.get_last_error(); print(b.value)";
  alias=execFileSync(process.env.BOARD_PYTHON||process.env.PYTHON||"python",["-I","-S","-X","utf8","-c",script],{encoding:"utf8",windowsHide:true,timeout:10000,env:{...process.env,AFK_TEST_LONG_ROOT:r.root}}).trim();assert.notEqual(alias,realpathSync.native(r.root),"Windows fixture must exercise an actual short-path alias");
 }
 else{alias=fresh("repository-alias");symlinkSync(r.root,alias,"dir");}
 const x=register(b,{...r,root:alias});assert.equal(repositoryReader({root:alias,git}).info.root,realpathSync.native(r.root));assert.deepEqual(registerRepository(b.db,x.config),x.state);assert.deepEqual(capture(b,r).files.find(f=>f.path==="src/demo.txt").bytes,r.original);assert.throws(()=>repositoryReader({root:join(alias,"src"),git}),{code:"REPOSITORY_ROOT_REQUIRED"});
});


test("Git version and required no-lazy-fetch capability fail early with actionable diagnostics",()=>{
 for(const value of ["git version 1.99.9","git version 2.43.0.windows.1","git version 2.44.99"])
  assert.throws(()=>requireGitVersion(value),{code:"GIT_TOO_OLD"});
 for(const value of ["git version 2.45.0","git version 2.45.2.windows.1","git version 3.0.0\n"])
  assert.ok(requireGitVersion(value));
 for(const value of [null,"git 2.45.0","git version 2.45","warning\ngit version 2.45.0","git version 99999999999999999999.0.0"])
  assert.throws(()=>requireGitVersion(value),{code:"GIT_VERSION_UNVERIFIED"});
 assert.ok(probeGitVersion(git.path));
 const source=readFileSync(join(ROOT,"core/git-version.mjs"),"utf8").replace(/^import .*;$/gm,"").replace(/^export /gm,"");
 for(const mode of ["old","missing","unsupported","current"]){
  const calls=[],context=vm.createContext({PeerError,process,execFileSync:(path,args,opts)=>{
   calls.push(args);assert.equal(path,"fixture-git");assert.equal(opts.timeout,5000);assert.equal(opts.maxBuffer,4096);
   if(mode==="missing"||mode==="unsupported"&&calls.length===2)throw Error("synthetic failure");
   return mode==="old"?"git version 2.43.0":"git version 2.45.0.windows.1";
  }});vm.runInContext(source,context);
  if(mode==="current")assert.equal(context.probeGitVersion("fixture-git"),"2.45.0");
  else assert.throws(()=>context.probeGitVersion("fixture-git"),{code:{old:"GIT_TOO_OLD",missing:"GIT_UNAVAILABLE",unsupported:"GIT_CAPABILITY_UNAVAILABLE"}[mode]});
  assert.equal(calls.length,["old","missing"].includes(mode)?1:2);
 }
});

test("ordinary git directories are portable artifacts while metadata aliases stay forbidden",()=>{
 for(const path of ["git/readme.txt","src/Git/tool.mjs","git.txt"])assert.equal(artifactPath(path),path);
 for(const path of [".git/config","src/.GIT/index","git~1/config","GIT~23/config"])assert.throws(()=>artifactPath(path),{code:"UNSAFE_ARTIFACT_PATH"});
 const r=repo();mkdirSync(join(r.root,"git"));writeFileSync(join(r.root,"git","readme.txt"),"ordinary source directory");
 g(r.root,["add","git/readme.txt"]);g(r.root,["commit","-m","ordinary git directory"]);r.commit=text(r.root,["rev-parse","HEAD"]);
 const reader=repositoryReader({root:r.root,git}),result=reader.capture({baseCommit:r.base,commit:r.commit,paths:["git/readme.txt"],allowed:["git/"]});
 assert.equal(result.files[0].bytes.toString(),"ordinary source directory");
 const seen=[];reader.snapshot({commit:r.commit,consume:file=>seen.push(file.path)});assert.ok(seen.includes("git/readme.txt"));
});
