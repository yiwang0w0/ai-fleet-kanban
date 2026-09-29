import {writeFileSync,realpathSync,readdirSync,statSync,unlinkSync} from "node:fs";
import {isAbsolute,join,relative,sep,dirname} from "node:path";
import {createHash} from "node:crypto";
import {pinFile} from "./supervisor.mjs";
import {roleTools,loadPrincipalCredential,fail,exact} from "../mcp/policy.mjs";
import {uuid} from "../federation/protocol.mjs";
import {canonical} from "../federation/sync-store.mjs";

export const ADAPTER_CONTRACTS=Object.freeze({claude:"2.1.247",codex:"0.149.1"});
const BASE_ENV=new Set(["systemroot","windir","appdata","localappdata","userprofile","home","homedrive","homepath","temp","tmp","path","pathext","lang","lc_all","http_proxy","https_proxy","all_proxy","no_proxy","ssl_cert_file","node_extra_ca_certs"]);
const EFFORTS={claude:["low","medium","high","xhigh","max"],codex:["none","minimal","low","medium","high","xhigh","max"]};
const configString=s=>JSON.stringify(s);
const preparedPlans=new WeakMap();
const hash=value=>createHash("sha256").update(canonical(value)).digest("hex");
const record=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function directory(value,label){
 if(typeof value!=="string"||!isAbsolute(value))fail("BAD_INPUT",label+" 必须是绝对路径",400);
 const path=realpathSync(value);if(!statSync(path).isDirectory())fail("BAD_INPUT",label+" 必须是目录",400);return path;
}
function contains(parent,child){const r=relative(parent,child);return !r||r!==".."&&!r.startsWith(".."+sep)&&!isAbsolute(r);}
function checkedPin(pin){
 exact(pin,["path","sha256"],"program_pin");const actual=pinFile(pin.path);
 if(actual.sha256!==pin.sha256)fail("RUNTIME_CHANGED","执行程序或桥接代码已变化");
 if(process.platform==="win32"&&!actual.path.toLowerCase().endsWith(".exe"))fail("NATIVE_PROGRAM_REQUIRED","运行时必须使用固定原生可执行文件");
 return actual;
}
function filePin(pin){
 exact(pin,["path","sha256"],"file_pin");const actual=pinFile(pin.path);
 if(actual.sha256!==pin.sha256)fail("RUNTIME_CHANGED","桥接代码已变化");return actual;
}
function cleanWorkspace(workspace){
 // Both mediated profiles use a fresh scratch directory. Provider settings are
 // explicitly disabled by argv; authentication homes may contain user settings.
 // Also refuse ambient dotenv/MCP files anywhere above the scratch directory.
 if(readdirSync(workspace).length)fail("WORKSPACE_NOT_EMPTY","受控执行需要独立空白启动目录");
 let parent=workspace;
 while(true){
  for(const name of [".env",".mcp.json"]){
   try{statSync(join(parent,name));}catch(e){if(e.code==="ENOENT"||e.code==="ENOTDIR")continue;throw e;}
   fail("STARTUP_CONFIG_PRESENT","执行目录或祖先存在自动加载配置");
  }
  const next=dirname(parent);if(next===parent)break;parent=next;
 }
}
function loopback(value){
 let url;try{url=new URL(value);}catch{fail("BAD_INPUT","MCP地址无效",400);}
 if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||url.username||url.password||url.pathname!=="/"||url.search||url.hash)fail("BAD_INPUT","MCP须使用显式端口的IPv4回环根地址",400);
 return url.href;
}
function writePrivate(path,value,created){
 writeFileSync(path,JSON.stringify(value,null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});created.push(path);return pinFile(path);
}
function serializablePlan(plan){
 return {workspace:plan.workspaceBinding,contract:plan.contract,runtime:plan.runtime,version:plan.version,model:plan.model,effort:plan.effort,scope:plan.scope,
  command:plan.command,argv:plan.args,code_root:plan.codeRoot,private_directory:plan.privateDirectory,credential_file:plan.credentialFile,cwd:plan.cwd,auth_home:plan.authHome,mcp_tools:plan.mcpTools,
  files:plan.pins,environment_sha256:hash(plan.env),decoder:plan.decoder,prompt_sha256:plan.promptHash,session_id:plan.sessionId,principal_id:plan.principalId,
  run_id:plan.runId,agent_instance_id:plan.agentInstanceId,containment:plan.containment};
}

/**
 * Board and transactional workspace-file profiles disable native tools.
 * Workspace files are mediated by the broker; no OS filesystem isolation is claimed. Runtime paths and auth home are local
 * operator inputs, never derived from task text or exposed as remote MCP args.
 */
export function prepareAdapter({installation,role,dispatch,codeRoot,workspace,privateDirectory,mcp,prompt,environment=process.env,workspaceBinding=null}){
 exact(installation,["runtime","version","program","auth_home"],"installation");
 if(!record(role)||!record(dispatch)||!record(mcp)||!record(environment))fail("BAD_INPUT","需要完整的角色、分派与本机配置",400);
 for(const k of ["principal_id","node_id","node_epoch","run_id","agent_instance_id"])uuid(dispatch[k],k);
 const runtime=installation.runtime;
 if(!Object.hasOwn(ADAPTER_CONTRACTS,runtime))fail("ADAPTER_UNAVAILABLE","此运行时尚无已接通的供应商启动合同");
 if(installation.version!==ADAPTER_CONTRACTS[runtime])fail("ADAPTER_VERSION_UNVERIFIED","当前运行时版本尚未核验");
 if(role.runtime!==runtime||!["implement","review"].includes(role.kind)||!EFFORTS[runtime].includes(role.effort))fail("POLICY_MISMATCH","角色与运行时或推理档位不匹配");
 if(typeof role.model!=="string"||role.model.length>120||!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]+$/.test(role.model)||runtime==="claude"&&!role.model.startsWith("claude-"))fail("MODEL_UNRESOLVED","需要显式的具体模型标识");
 if(!["read-only","write"].includes(role.tools)||role.kind==="review"&&role.tools!=="read-only")fail("POLICY_MISMATCH","角色工具策略无效");
 // No code/shell capability is silently granted by a board probe profile.
 const fileScope=Array.isArray(role.capabilities)&&role.capabilities.length===1&&role.capabilities[0]==="workspace-files";
 if(!Array.isArray(role.capabilities)||role.capabilities.length!==1||!fileScope&&role.capabilities[0]!=="board-tools")fail("CAPABILITY_UNAVAILABLE","适配配置需要明确的 board-tools 或 workspace-files 能力");
 if(fileScope){exact(workspaceBinding,["workspace_id","descriptor_digest","base_commit","baseline_digest","access"],"workspace_binding");uuid(workspaceBinding.workspace_id,"workspace_id");if(workspaceBinding.access!=="mcp-files-v1"||!/^[a-f0-9]{64}$/.test(workspaceBinding.descriptor_digest)||!/^[a-f0-9]{64}$/.test(workspaceBinding.baseline_digest)||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspaceBinding.base_commit))fail("WORKSPACE_NOT_BOUND","需要受管文件会话");}
 else if(workspaceBinding!==null)fail("WORKSPACE_ADAPTER_REQUIRED","board-tools 不能绑定任务文件会话");
 if(typeof prompt!=="string"||!prompt.trim()||Buffer.byteLength(prompt)>131072||prompt.includes("\0"))fail("BAD_INPUT","提示内容无效或超限",400);
 const root=directory(codeRoot,"治理仓"),cwd=directory(workspace,"执行目录"),privateDir=directory(privateDirectory,"私有运行目录"),authHome=directory(installation.auth_home,"认证目录");
 if([cwd,privateDir,authHome].some(p=>contains(root,p))||contains(cwd,privateDir)||contains(privateDir,cwd)||contains(cwd,authHome)||contains(privateDir,authHome)||contains(authHome,cwd)||contains(authHome,privateDir))fail("UNSAFE_RUNTIME_PATH","执行、凭据、认证与治理目录不能互相混用");
 cleanWorkspace(cwd);
 const command=checkedPin(installation.program),node=checkedPin(mcp.node),bridge=filePin(mcp.bridge),url=loopback(mcp.url);
 if(!contains(root,bridge.path))fail("BRIDGE_UNVERIFIED","MCP桥接代码必须来自当前治理仓");
 const credential=loadPrincipalCredential(mcp.credentialFile);
 if(credential.principal_id!==dispatch.principal_id||credential.node_id!==dispatch.node_id||credential.node_epoch!==dispatch.node_epoch)fail("PRINCIPAL_MISMATCH","MCP凭据与该分派不匹配");
 const credentialPath=realpathSync(mcp.credentialFile);
 if(!contains(privateDir,credentialPath))fail("UNSAFE_CREDENTIAL_PATH","运行凭据必须位于本次私有目录");
 const tools=roleTools(role),argsBridge=[bridge.path,"--url",url,"--credential-file",credentialPath];
 const baseEnv=Object.fromEntries(Object.entries(environment).filter(([k,v])=>BASE_ENV.has(k.toLowerCase())&&typeof v==="string"));
 if(Object.entries(baseEnv).some(([k,v])=>k.includes("\0")||v.includes("\0")))fail("BAD_INPUT","环境参数无效",400);
 let args,env={...baseEnv},pins=[node,bridge,pinFile(credentialPath)],decoder;
 const created=[];
 try{
 const sessionId=dispatch.agent_instance_id;
 if(runtime==="claude"){
  env.CLAUDE_CONFIG_DIR=authHome;env.DISABLE_AUTOUPDATER="1";
  const settings=writePrivate(join(privateDir,"claude-settings.json"),{disableAllHooks:true,enabledPlugins:{},syncClaudeAiPlugins:false,permissions:{defaultMode:"dontAsk"}},created);
  const servers=writePrivate(join(privateDir,"claude-mcp.json"),{mcpServers:{fleet:{command:node.path,args:argsBridge}}},created);
  pins.push(settings,servers);
  args=["--print","--verbose","--output-format","stream-json","--input-format","text","--model",role.model,"--effort",role.effort,
   "--session-id",sessionId,"--no-session-persistence","--permission-mode","dontAsk","--tools","",
   "--allowedTools",tools.map(t=>"mcp__fleet__"+t).join(","),"--disable-slash-commands","--no-chrome",
   "--setting-sources","","--settings",settings.path,"--strict-mcp-config","--mcp-config",servers.path];
  decoder={expectedSessionId:sessionId,expectedModel:role.model,expectedTools:tools.map(t=>"mcp__fleet__"+t),expectedMcpServer:"fleet"};
 }else{
  env.CODEX_HOME=authHome;
  const mcpValue="{fleet={command="+configString(node.path)+",args=["+argsBridge.map(configString).join(",")+"],enabled=true,required=true,enabled_tools=["+tools.map(configString).join(",")+"],startup_timeout_sec=30,tool_timeout_sec=30,default_tools_approval_mode=\"approve\"}}";
  const overrides=[
   ["model_reasoning_effort",configString(role.effort)],["approval_policy",'"never"'],["web_search",'"disabled"'],["project_doc_max_bytes","0"],
   ...["apps","hooks","plugins","remote_plugin","multi_agent","goals","memories","shell_tool","unified_exec","skill_mcp_dependency_install"].map(k=>["features."+k,"false"]),
   ["mcp_servers",mcpValue]
  ];
  args=["exec","--ignore-user-config","--ignore-rules","--ephemeral","--sandbox","read-only","--json","--color","never","--skip-git-repo-check","--model",role.model,"--cd",cwd,...overrides.flatMap(([k,v])=>["-c",k+"="+v]),"-"];
  decoder={};
 }
 const plan={contract:fileScope?"ai-fleet-adapter/workspace-files-v1":"ai-fleet-adapter/board-tools-v1",runtime,version:installation.version,model:role.model,effort:role.effort,scope:fileScope?"workspace-files":"board-tools",workspaceBinding:workspaceBinding?structuredClone(workspaceBinding):null,
  command,args,env,input:prompt,codeRoot:root,privateDirectory:privateDir,credentialFile:credentialPath,cwd,authHome,pins,decoder,mcpTools:tools,sessionId:runtime==="claude"?sessionId:null,
  principalId:dispatch.principal_id,runId:dispatch.run_id,agentInstanceId:dispatch.agent_instance_id,
  promptHash:createHash("sha256").update(prompt).digest("hex"),containment:{filesystem:"not_claimed",process:process.platform==="win32"?"windows-job":"posix-process-group"}};
 const manifest=serializablePlan(plan);
 const prepared={plan,manifest,manifestDigest:hash(manifest)};
 preparedPlans.set(prepared,prepared.manifestDigest);
 return prepared;
 }catch(e){for(const path of created){try{unlinkSync(path);}catch{}}throw e;}
}

/** Recheck just before consuming the one-use permit. No returned snapshot grants a restart. */
export function validatePreparedAdapter(prepared){
 if(!record(prepared)||!preparedPlans.has(prepared))fail("ADAPTER_PLAN_UNKNOWN","启动配置必须在当前进程内准备");
 const {plan,manifest,manifestDigest}=prepared;
 if(manifestDigest!==preparedPlans.get(prepared))fail("ADAPTER_PLAN_CHANGED","启动配置身份已改变");
 if(createHash("sha256").update(canonical(manifest)).digest("hex")!==manifestDigest||canonical(serializablePlan(plan))!==canonical(manifest))fail("ADAPTER_PLAN_CHANGED","启动合同已改变");
 if(createHash("sha256").update(plan.input).digest("hex")!==plan.promptHash)fail("ADAPTER_PLAN_CHANGED","任务提示已改变");
 cleanWorkspace(plan.cwd);checkedPin(plan.command);
 for(const pin of plan.pins)filePin(pin);
 return true;
}
