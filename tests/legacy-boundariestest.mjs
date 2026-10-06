import test,{after} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-legacy-"));
const PY=process.env.PYTHON||"python";let seq=0;
after(()=>rmSync(TMP,{recursive:true,force:true}));
function python(script){
 const registry=join(TMP,"registry-"+(seq++)+".json");
 writeFileSync(registry,JSON.stringify({"fixture":["python","-c","print('ORIGINAL')"]}));
 const r=spawnSync(PY,["-c","import os,sys,json,pathlib\nsys.path.insert(0,os.path.join(os.environ['TEST_ROOT'],'loops'))\n"+script],{cwd:ROOT,env:{...process.env,TEST_ROOT:ROOT,BOARD_CONFIG:join(TMP,"missing-config.json"),BOARD_VERIFY_REGISTRY:registry,BOARD_DATA_DIR:TMP,BOARD_REPO:ROOT,PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",windowsHide:true,timeout:30000});
 assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;
}
test("H9a startup-pinned registry rejects changed commands before a verification process starts",()=>{
 python(("import worker_loop as w\nimport verify_lib as v\n"+
   "original=pathlib.Path(v.REGISTRY).read_bytes()\n"+
   "pathlib.Path(v.REGISTRY).write_text(json.dumps({'fixture':['python','-c','print(\\\"REPLACED\\\")']}),encoding='utf-8')\n"+
   "r=v.run_verify({'verify_cmd':'fixture'})\n"+
   "assert r['ok'] is False, r\nassert r.get('code')=='REGISTRY_CHANGED', r\nassert 'REPLACED' not in r.get('out',''), r\n"+
   "assert v.verify_registry()=={}\n"+
   "pathlib.Path(v.REGISTRY).write_bytes(original)\n"+
   "r=v.run_verify({'verify_cmd':'fixture'})\n"+
   "assert r['ok'] and 'ORIGINAL' in r['out'], r\nassert len(r['registry_sha256'])==64\nassert r['registry_sha256'] in v.fmt_verify(r)\n"));
});
test("H9c nonexecuting and unknown deliveries cannot turn copied prose into machine acceptance",()=>{
 python("import reviewer_loop as r\n"+
  "for family in ['claude','zcode','unknown',None]:\n"+
  " t={'id':1,'last_runtime':family,'acceptance':'运行测试并提供 stdout','result':'12 PASS; rc=0'}\n"+
  " ev=r.machine_evidence(t)\n assert not ev['ok'] and ev['muted'], (family,ev)\n"+
  " d=r._gate_core(t,{'verdict':'approve','reason':'copied numbers'})\n assert d['verdict']=='escalate' and d['gated_by']=='machine-evidence',d\n"+
  " assert r.machine_evidence(t,{'ok':True,'key':'fixture','rc':0})['ok']\n"+
  " t['result']='—— 验证(由循环执行;worker 无执行权)——\\nrc=0'\n assert not r.machine_evidence(t)['ok']\n"+
  "t={'last_runtime':'codex','result':'12 PASS; rc=0'}\nassert r.machine_evidence(t)['ok']\nt['result']='本轮一条都没跑; 12 PASS; rc=0'\nassert not r.machine_evidence(t)['ok']\n");
});
test("H9b seat CLI observation includes actual bytes and warns on unmeasured platform or binary",async()=>{
 const {inspectSeatCLI,assessSeatCLI}=await import("../core/seat-cli-evidence.mjs");
 const observation=inspectSeatCLI(process.execPath);
 assert.equal(observation.version,process.versions.node);assert.match(observation.sha256,/^[a-f0-9]{64}$/);
 assert.equal(observation.measurement.status,"unmeasured");
 const record={id:"synthetic-exact-measurement",platform:process.platform,version:observation.version,sha256:observation.sha256};
 assert.equal(assessSeatCLI(observation,[record]).status,"matched");
 for(const changed of [{platform:"different-platform"},{version:"0.0.0"},{sha256:"0".repeat(64)},{sha256:null}])assert.equal(assessSeatCLI(observation,[{...record,...changed}]).status,"unmeasured");
});

test("H9a reviewer executes the pinned verifier and refuses drift before invoking a model",()=>{
 python("import reviewer_loop as r\nimport verify_lib as v\n"+
  "calls=[]\nr.review_one=lambda t,vr:(calls.append(vr) or {'verdict':'approve','reason':'fixture'},None)\n"+
  "t={'id':1,'verify_cmd':'fixture','last_runtime':'claude','acceptance':'运行测试并提供 stdout','result':'12 PASS; rc=0'}\n"+
  "kind,d,err,vr=r.judge_one(t)\nassert kind=='model' and d['verdict']=='approve' and vr['ok'], (kind,d,err,vr)\nassert len(calls)==1\n"+
  "pathlib.Path(v.REGISTRY).write_text('{}',encoding='utf-8')\n"+
  "kind,d,err,vr=r.judge_one(t)\nassert kind=='mech_reject' and vr['code']=='REGISTRY_CHANGED', (kind,d,vr)\nassert len(calls)==1\n");
});
test("H9a unavailable startup registry stays closed and published command lists cannot mutate its snapshot",()=>{
 python("import verify_lib as v\n"+
  "copy=v.verify_registry();copy['fixture'][2]='print(\\\"MUTATED\\\")'\n"+
  "assert 'ORIGINAL' in v.run_verify({'verify_cmd':'fixture'})['out']\n"+
  "pathlib.Path(v.REGISTRY).unlink()\nassert v.run_verify({'verify_cmd':'fixture'})['code']=='REGISTRY_UNAVAILABLE'\n");
 python("pathlib.Path(os.environ['BOARD_VERIFY_REGISTRY']).write_text('{bad',encoding='utf-8')\n"+
  "import verify_lib as v\npathlib.Path(v.REGISTRY).write_text(json.dumps({'fixture':['python','-c','print(1)']}),encoding='utf-8')\n"+
  "r=v.run_verify({'verify_cmd':'fixture'})\nassert r['code']=='REGISTRY_UNAVAILABLE' and r['registry_sha256'] is None,r\n");
});
test("H9b doctor emits native CLI identity and a drift warning without a model call",()=>{
 const registry=join(TMP,"doctor-registry.json");writeFileSync(registry,"{}");
 const r=spawnSync(process.execPath,[join(ROOT,"cli/doctor.mjs")],{cwd:ROOT,env:{...process.env,WORKER_CLAUDE_CLI:process.execPath,BOARD_CODEX_CMD:"",BOARD_CONFIG:join(TMP,"missing-config.json"),BOARD_VERIFY_REGISTRY:registry,BOARD_DATA_DIR:TMP,BOARD_REPO:ROOT,BOARD_PORT:"0",PYTHON:PY,BOARD_PYTHON:PY,PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",windowsHide:true,timeout:30000});
 assert.ok(r.status===0||r.status===1,r.stderr);
 const line=r.stdout.split(/\r?\n/).find(x=>x.includes("seat-cli-evidence: "));
 assert.ok(line,r.stdout+r.stderr);const receipt=JSON.parse(line.split("seat-cli-evidence: ")[1]);
 assert.equal(receipt.version,process.versions.node);assert.equal(receipt.measurement.status,"unmeasured");
 assert.match(r.stdout,/WARN\s+座席 CLI 权限语义尚无/);
});
