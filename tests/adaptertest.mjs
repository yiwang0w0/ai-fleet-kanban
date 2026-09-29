import test,{after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {prepareAdapter,validatePreparedAdapter,ADAPTER_CONTRACTS} from "../core/execution/adapters.mjs";
import {pinFile} from "../core/execution/supervisor.mjs";
import {ROLE_TOOLS,WORKSPACE_READ_TOOLS,WORKSPACE_WRITE_TOOLS} from "../core/mcp/policy.mjs";
const TMP=mkdtempSync(join(tmpdir(),"fleet adapters 中文 "));
after(()=>rmSync(TMP,{recursive:true,force:true}));
function fixture(runtime="claude"){
 const base=mkdtempSync(join(TMP,"case-"));
 const dirs=Object.fromEntries(["root","work","private","auth"].map(k=>{const p=join(base,k);mkdirSync(p);return [k,p];}));
 const bridge=join(dirs.root,"bridge.mjs");writeFileSync(bridge,"// fixture only; never a model\n");
 const dispatch=Object.fromEntries(["principal_id","node_id","node_epoch","run_id","agent_instance_id"].map(k=>[k,randomUUID()]));
 const credentialFile=join(dirs.private,"principal.json");
 writeFileSync(credentialFile,JSON.stringify({format:"ai-fleet-mcp-credential/v1",node_id:dispatch.node_id,node_epoch:dispatch.node_epoch,principal_id:dispatch.principal_id,credential_version:1,token:dispatch.principal_id+"."+"x".repeat(43)}));
 return {base,dirs,input:{installation:{runtime,version:ADAPTER_CONTRACTS[runtime],program:pinFile(process.execPath),auth_home:dirs.auth},
  role:{runtime,kind:"implement",tools:"write",model:runtime==="claude"?"claude-fixture-1":"gpt-fixture",effort:"low",capabilities:["board-tools"]},
  dispatch,codeRoot:dirs.root,workspace:dirs.work,privateDirectory:dirs.private,
  mcp:{node:pinFile(process.execPath),bridge:pinFile(bridge),url:"http://127.0.0.1:43111",credentialFile},
  prompt:"只读取任务，中文 $(literal) & text",environment:{SystemRoot:process.env.SystemRoot??"",PATH:process.env.PATH??process.env.Path??"",HTTPS_PROXY:"http://user:private-fixture@127.0.0.1:4321",ANTHROPIC_API_KEY:"private-api",OPENAI_API_KEY:"private-api",NODE_OPTIONS:"--require untrusted",CODEX_HOME:"untrusted",ZCODE_TOKEN:"private-api"}}};
}
const arg=(args,name)=>args[args.indexOf(name)+1];
test("Claude uses exact native pins, subscription home, explicit tools and isolated configuration",()=>{
 const f=fixture(),p=prepareAdapter(f.input);assert.equal(validatePreparedAdapter(p),true);
 assert.equal(p.plan.env.CLAUDE_CONFIG_DIR,f.dirs.auth);
 for(const key of ["ANTHROPIC_API_KEY","OPENAI_API_KEY","NODE_OPTIONS","ZCODE_TOKEN"])assert.equal(p.plan.env[key],undefined);
 assert.equal(p.plan.input,f.input.prompt);assert.equal(p.plan.args.includes(f.input.prompt),false);
 assert.equal(arg(p.plan.args,"--tools"),"");assert.equal(arg(p.plan.args,"--setting-sources"),"");assert.ok(p.plan.args.includes("--strict-mcp-config"));
 assert.equal(arg(p.plan.args,"--permission-mode"),"dontAsk");
 assert.equal(p.plan.decoder.expectedSessionId,f.input.dispatch.agent_instance_id);
 const servers=JSON.parse(readFileSync(arg(p.plan.args,"--mcp-config"),"utf8"));assert.deepEqual(Object.keys(servers.mcpServers),["fleet"]);
 assert.deepEqual(servers.mcpServers.fleet.args,[f.input.mcp.bridge.path,"--url","http://127.0.0.1:43111/","--credential-file",f.input.mcp.credentialFile]);
 const settings=JSON.parse(readFileSync(arg(p.plan.args,"--settings"),"utf8"));
 assert.equal(settings.disableAllHooks,true);assert.equal(settings.syncClaudeAiPlugins,false);
 assert.deepEqual(p.plan.decoder.expectedTools,ROLE_TOOLS.implement.map(t=>"mcp__fleet__"+t));
 assert.ok(!JSON.stringify(p.manifest).includes("private-fixture"));assert.ok(!JSON.stringify(p.manifest).includes("private-api"));
 assert.equal(p.plan.containment.filesystem,"not_claimed");
});
test("Codex retains subscription home while disabling user rules, plugin features and built-in shell",()=>{
 const f=fixture("codex"),p=prepareAdapter(f.input),args=p.plan.args;
 assert.equal(validatePreparedAdapter(p),true);assert.equal(p.plan.env.CODEX_HOME,f.dirs.auth);
 for(const flag of ["--ignore-user-config","--ignore-rules","--ephemeral","--json"])assert.ok(args.includes(flag));
 assert.equal(arg(args,"--sandbox"),"read-only");assert.equal(args.at(-1),"-");
 for(const setting of ['approval_policy="never"','web_search="disabled"',"features.shell_tool=false","features.unified_exec=false","features.plugins=false","features.multi_agent=false"])assert.ok(args.includes(setting));
 const mcp=args.find(v=>v.startsWith("mcp_servers="));assert.ok(mcp.includes("required=true"));assert.ok(mcp.includes("enabled_tools="));
 assert.ok(!args.some(v=>v.includes("dangerously-bypass")));assert.ok(!JSON.stringify(p.manifest).includes("private-fixture"));
});
test("review role receives its exact MCP tool subset",()=>{
 const f=fixture();f.input.role.kind="review";f.input.role.tools="read-only";
 const p=prepareAdapter(f.input);assert.deepEqual(p.plan.mcpTools,ROLE_TOOLS.review);
 assert.ok(!p.plan.decoder.expectedTools.includes("mcp__fleet__split_task"));
});
test("unsupported provider, unverified version, runtime mismatch and unresolved model fail before writing config",()=>{
 for(const [mutate,code] of [
  [f=>f.input.installation.runtime="zcode","ADAPTER_UNAVAILABLE"],
  [f=>f.input.installation.version="999","ADAPTER_VERSION_UNVERIFIED"],
  [f=>f.input.role.runtime="codex","POLICY_MISMATCH"],
  [f=>f.input.role.model="sonnet","MODEL_UNRESOLVED"],
  [f=>f.input.role.effort="automatic","POLICY_MISMATCH"]
 ]){
  const f=fixture();mutate(f);assert.throws(()=>prepareAdapter(f.input),{code});
  assert.equal(existsSync(join(f.dirs.private,"claude-settings.json")),false);
 }
});
test("file/shell capabilities and malformed role policies are never upgraded to board capability",()=>{
 for(const capabilities of [[],["shell"],["board-tools","files"],["board-tools","board-tools"],null,{}]){
  const f=fixture();f.input.role.capabilities=capabilities;
  assert.throws(()=>prepareAdapter(f.input),{code:"CAPABILITY_UNAVAILABLE"});
 }
 const f=fixture();f.input.role.kind="review";
 assert.throws(()=>prepareAdapter(f.input),{code:"POLICY_MISMATCH"});
});
test("MCP principal, node and epoch must match the dispatch",()=>{
 for(const k of ["principal_id","node_id","node_epoch"]){
  const f=fixture();f.input.dispatch[k]=randomUUID();
  assert.throws(()=>prepareAdapter(f.input),{code:"PRINCIPAL_MISMATCH"});
 }
 const f=fixture();f.input.dispatch.run_id="bad";
 assert.throws(()=>prepareAdapter(f.input),{code:"BAD_INPUT"});
});
test("MCP bridge must be in governance code and credential in private directory",()=>{
 const f=fixture();const bridge=join(f.base,"outside.mjs");writeFileSync(bridge,"fixture");f.input.mcp.bridge=pinFile(bridge);
 assert.throws(()=>prepareAdapter(f.input),{code:"BRIDGE_UNVERIFIED"});
 const g=fixture();const credential=join(g.base,"outside.json");writeFileSync(credential,readFileSync(g.input.mcp.credentialFile));g.input.mcp.credentialFile=credential;
 assert.throws(()=>prepareAdapter(g.input),{code:"UNSAFE_CREDENTIAL_PATH"});
});
test("remote MCP addresses, URL credentials and extra paths are rejected",()=>{
 for(const url of ["http://localhost:80","http://192.0.2.1:80","https://127.0.0.1:1234","http://127.0.0.1:1234/other","http://user:pass@127.0.0.1:1234","http://127.0.0.1:1234/?a=1"]){
  const f=fixture();f.input.mcp.url=url;assert.throws(()=>prepareAdapter(f.input),{code:"BAD_INPUT"});
 }
});
test("governance, workspace, private and authentication directories cannot be reused",()=>{
 for(const mutate of [
  f=>f.input.workspace=f.dirs.root,
  f=>f.input.privateDirectory=f.dirs.work,
  f=>f.input.installation.auth_home=f.dirs.work,
  f=>{const p=join(f.dirs.auth,"nested");mkdirSync(p);f.input.workspace=p;},
  f=>{const p=join(f.dirs.auth,"private");mkdirSync(p);f.input.privateDirectory=p;}
 ]){
  const f=fixture();mutate(f);assert.throws(()=>prepareAdapter(f.input),{code:"UNSAFE_RUNTIME_PATH"});
 }
});
test("scratch content and ambient startup files refuse launch",()=>{
 const f=fixture();writeFileSync(join(f.dirs.work,"unexpected"),"fixture");
 assert.throws(()=>prepareAdapter(f.input),{code:"WORKSPACE_NOT_EMPTY"});
 const g=fixture();writeFileSync(join(g.base,".env"),"FIXTURE=1");
 assert.throws(()=>prepareAdapter(g.input),{code:"STARTUP_CONFIG_PRESENT"});
 const h=fixture();const p=prepareAdapter(h.input);writeFileSync(join(h.base,".mcp.json"),"{}");
 assert.throws(()=>validatePreparedAdapter(p),{code:"STARTUP_CONFIG_PRESENT"});
});
test("configuration generation is exclusive and removes only files created by this attempt",()=>{
 const f=fixture();const collision=join(f.dirs.private,"claude-mcp.json");writeFileSync(collision,"existing");
 assert.throws(()=>prepareAdapter(f.input),{code:"EEXIST"});
 assert.equal(existsSync(join(f.dirs.private,"claude-settings.json")),false);
 assert.equal(readFileSync(collision,"utf8"),"existing");assert.ok(existsSync(f.input.mcp.credentialFile));
});
test("mutating argv, prompt, environment, parser bindings or a manifest invalidates the prepared launch",()=>{
 for(const mutate of [
  p=>p.plan.args.push("--new-flag"),p=>p.plan.input+="changed",
  p=>p.plan.env.NODE_OPTIONS="--require changed",p=>p.plan.env.HTTPS_PROXY="http://changed",
  p=>p.plan.decoder.expectedTools.push("Bash"),p=>p.plan.decoder={},
  p=>p.manifest.model="changed",p=>p.plan.principalId=randomUUID(),
  p=>p.manifestDigest="0".repeat(64)
 ]){
  const p=prepareAdapter(fixture().input);mutate(p);assert.throws(()=>validatePreparedAdapter(p),{code:"ADAPTER_PLAN_CHANGED"});
 }
});
test("serialized or fabricated plans cannot act as a current-process launch plan",()=>{
 const p=prepareAdapter(fixture().input);
 assert.throws(()=>validatePreparedAdapter(structuredClone(p)),{code:"ADAPTER_PLAN_UNKNOWN"});
 assert.throws(()=>validatePreparedAdapter(null),{code:"ADAPTER_PLAN_UNKNOWN"});
});
test("changed bridge or generated configuration pins refuse launch",()=>{
 for(const choose of [f=>f.input.mcp.bridge.path,f=>join(f.dirs.private,"claude-settings.json"),f=>f.input.mcp.credentialFile]){
  const f=fixture(),p=prepareAdapter(f.input);writeFileSync(choose(f),"changed");
  assert.throws(()=>validatePreparedAdapter(p),{code:"RUNTIME_CHANGED"});
 }
});
test("bad input, environment NUL and mismatched executable hash fail without starting a process",()=>{
 const f=fixture();f.input.prompt="x".repeat(131073);assert.throws(()=>prepareAdapter(f.input),{code:"BAD_INPUT"});
 const g=fixture();g.input.environment.PATH="bad\0path";assert.throws(()=>prepareAdapter(g.input),{code:"BAD_INPUT"});
 const h=fixture();h.input.installation.program.sha256="0".repeat(64);assert.throws(()=>prepareAdapter(h.input),{code:"RUNTIME_CHANGED"});
});
const fileBinding=()=>({workspace_id:randomUUID(),descriptor_digest:"a".repeat(64),base_commit:"b".repeat(40),baseline_digest:"c".repeat(64),access:"mcp-files-v1"});
test("Claude and Codex workspace profiles bind the descriptor and expose only mediated file tools",()=>{
 for(const runtime of ["claude","codex"]){
  const f=fixture(runtime);f.input.role.capabilities=["workspace-files"];f.input.workspaceBinding=fileBinding();
  const p=prepareAdapter(f.input);assert.equal(validatePreparedAdapter(p),true);assert.equal(p.plan.contract,"ai-fleet-adapter/workspace-files-v1");assert.equal(p.plan.scope,"workspace-files");assert.deepEqual(p.manifest.workspace,f.input.workspaceBinding);
  assert.deepEqual(p.plan.mcpTools,[...ROLE_TOOLS.implement,...WORKSPACE_READ_TOOLS,...WORKSPACE_WRITE_TOOLS]);assert.equal(p.plan.cwd,f.dirs.work);assert.equal(p.plan.containment.filesystem,"not_claimed");
  if(runtime==="claude"){assert.equal(arg(p.plan.args,"--tools"),"");assert.deepEqual(p.plan.decoder.expectedTools,p.plan.mcpTools.map(n=>"mcp__fleet__"+n));}
  else{assert.ok(p.plan.args.includes("features.shell_tool=false"));assert.equal(arg(p.plan.args,"--sandbox"),"read-only");assert.ok(p.plan.args.find(a=>a.startsWith("mcp_servers=")).includes('"edit_workspace_file"'));}
  f.input.workspaceBinding.descriptor_digest="d".repeat(64);assert.equal(validatePreparedAdapter(p),true);
  p.plan.workspaceBinding.descriptor_digest="e".repeat(64);assert.throws(()=>validatePreparedAdapter(p),{code:"ADAPTER_PLAN_CHANGED"});
 }
});
test("workspace review and read-only policies never gain write tools",()=>{
 for(const runtime of ["claude","codex"])for(const kind of ["implement","review"]){
  const f=fixture(runtime);Object.assign(f.input.role,{kind,tools:"read-only",capabilities:["workspace-files"]});f.input.workspaceBinding=fileBinding();
  const p=prepareAdapter(f.input);for(const t of WORKSPACE_READ_TOOLS)assert.ok(p.plan.mcpTools.includes(t));for(const t of WORKSPACE_WRITE_TOOLS)assert.equal(p.plan.mcpTools.includes(t),false);assert.equal(validatePreparedAdapter(p),true);
 }
});
test("missing or malformed workspace bindings and board profile upgrades fail before config creation",()=>{
 for(const binding of [null,{...fileBinding(),access:"native-files"},{...fileBinding(),base_commit:"HEAD"},{...fileBinding(),descriptor_digest:"bad"},{...fileBinding(),extra:true}]){
  const f=fixture();f.input.role.capabilities=["workspace-files"];f.input.workspaceBinding=binding;
  assert.throws(()=>prepareAdapter(f.input));assert.equal(existsSync(join(f.dirs.private,"claude-settings.json")),false);
 }
 const f=fixture();f.input.workspaceBinding=fileBinding();assert.throws(()=>prepareAdapter(f.input),{code:"WORKSPACE_ADAPTER_REQUIRED"});
});
