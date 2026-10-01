// PR #2 B2/B3: published instructions are part of the client contract.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {ROLE_KINDS,EXECUTION_CAPABILITIES} from "../core/mcp/policy.mjs";
const ROOT=fileURLToPath(new URL("../",import.meta.url));
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("B2 package, desktop manifests and current instructions agree on the review version",()=>{
 const version=JSON.parse(read("package.json")).version;
 assert.equal(version,"0.24.0");
 for(const file of ["packaging/desktop/manifest.json","packaging/desktop/bundle-package.json"])
  assert.equal(JSON.parse(read(file)).version,version,file);
 assert.equal(JSON.parse(read("docs/多终端共享看板-任务清单.json")).repository_package_version,version);
 for(const file of ["README.md","CONTRIBUTING.md","docs/GLOSSARY.md","docs/federation/migration-0.24.md"])
  assert.ok(read(file).includes(version),file+" must name the current version");
});

test("B2 glossary distinguishes line roles from broker roles and documents wire identity fields",()=>{
 const glossary=read("docs/GLOSSARY.md"),row=key=>{
  const found=glossary.split(/\r?\n/).find(line=>line.startsWith("|")&&line.includes(key));
  assert.ok(found,"missing qualified glossary row: "+key);return found.split("|")[2];
 };
 const values=text=>[...text.matchAll(/`([^`]+)`/g)].map(x=>x[1]);
 assert.deepEqual(values(row("fleet.config.json: lines[].role.kind")),["implement","review"]);
 assert.deepEqual(values(row("broker_roles.policy_json.kind")),ROLE_KINDS);
 assert.deepEqual(values(row("broker policy `capabilities`")),EXECUTION_CAPABILITIES);
 for(const key of ["task_uid","owner_node_id","aggregate_version","expected_version","worker_protocol_version","agent_instance_id","run_id","executor_node_id","sync_epoch"])
  assert.ok(glossary.includes("`"+key)||glossary.includes(key+"`")||glossary.includes(key+" /"),"missing machine term: "+key);
 for(const surface of ["/api/*","/peer/v1/*","/local/v1/tools/call","cli/mcp.mjs"])
  assert.ok(read("SECURITY.md").includes(surface),"missing credential surface: "+surface);
 assert.match(read("CONTRIBUTING.md"),/Windows/);
 assert.match(read("CONTRIBUTING.md"),/migration-0\.24\.md/);
});

test("B3 every operator entry links migration and edit examples carry the observed version",()=>{
 const files=["README.md","docs/QUICKSTART.md","docs/OPERATE_WITH_CLAUDE.md",".claude/skills/coordinator-seat/SKILL.md"];
 let examples=0;
 for(const file of files){
  const source=read(file);assert.match(source,/migration-0\.24\.md/,file);
  for(const line of source.split(/\r?\n/).filter(line=>/board\.py\s+edit\s/.test(line))){
   examples++;assert.match(line,/--version\s+\S+/,file+": "+line);
  }
 }
 assert.ok(examples>=2,"keep runnable edit guidance for both operator and coordinator");
 const migration=read("docs/federation/migration-0.24.md");
 for(const term of ["worker_protocol_version: 2","expected_version","aggregate_version","run_id","备份","回滚"])
  assert.ok(migration.includes(term),"missing upgrade contract: "+term);
});

test("B3 CLI refuses an unversioned control before any network call",()=>{
 const probe=[
  "import runpy,sys,urllib.request",
  "def forbid_network(*args,**kwargs): raise AssertionError('NETWORK_ATTEMPT')",
  "urllib.request.urlopen=forbid_network",
  "sys.argv=[sys.argv[1],'take','1','--as','contract-fixture']",
  "runpy.run_path(sys.argv[0],run_name='__main__')",
 ].join("\n");
 const r=spawnSync(process.env.PYTHON||"python",["-c",probe,ROOT+"cli/board.py"],{
  encoding:"utf8",windowsHide:true,timeout:10000,
  env:{...process.env,PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1",BOARD_URL:"http://127.0.0.1:1",BOARD_DATA_DIR:ROOT+".missing-contract-fixture"},
 });
 assert.equal(r.error,undefined);assert.equal(r.status,1,r.stderr);
 assert.match(r.stderr,/--version/);assert.doesNotMatch(r.stderr,/NETWORK_ATTEMPT|Traceback/);
});
