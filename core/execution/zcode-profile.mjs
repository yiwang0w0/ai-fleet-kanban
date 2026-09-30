import {readFileSync} from "node:fs";
import {basename,dirname} from "node:path";
import {fail} from "../mcp/policy.mjs";
export const ZCODE_PROVIDER="account:bigmodel-individual-coding-plan";
export const ZCODE_MODELS=Object.freeze(["GLM-5.3","GLM-5.3-Flash"]);
export const ZCODE_EFFORTS=Object.freeze(["low","high","max"]);
// Complete built-in registry of the inspected 0.16.9 bundle, plus its legacy
// Workflow entry. Deny at registry construction, independently of permissions.
export const ZCODE_NATIVE_TOOLS=Object.freeze(["Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch","TodoRead","TodoWrite","CronCreate","CronList","CronUpdate","CronDelete","OffPeakCreate","OffPeakList","EnterPlanMode","ExitPlanMode","AskUserQuestion","SendMessage","RespondToCoordinator","submit_result","escalate","TaskOutput","TaskStop","ReadSessionContext","Agent","Task","Skill","js","CreateWorkflow","AmendWorkflow","SaveWorkflow","EvalWorkflowSnippet","ListWorkflowRuns","GetWorkflowRun","ResumeWorkflowRun","ResolveWorkflowQuestion","ListSavedWorkflows","ListModels","Workflow"]);
export function zcodeAuthBase(authHome){
 if(basename(authHome)!=="v2"||basename(dirname(authHome))!==".zcode")fail("BAD_AUTH_HOME","Zcode auth_home 必须指向现有 .zcode/v2 目录");
 return dirname(dirname(authHome));
}
export function zcodeProviderProfile(builtinPath,model,effort){
 if(!ZCODE_MODELS.includes(model)||!ZCODE_EFFORTS.includes(effort))fail("MODEL_UNRESOLVED","Zcode 0.16.9 仅支持已核验的 GLM-5.3/Flash 与 low/high/max");
 let release;try{release=JSON.parse(readFileSync(builtinPath,"utf8"));}catch{fail("BAD_PROVIDER_CONFIG","Zcode 公开供应商配置无效");}
 const matches=release?.config?.providerConfigRules?.providerRules?.filter(p=>p.providerId===ZCODE_PROVIDER),rules=release?.config?.modelConfigRules;
 if(release?.schemaVersion!==1||!Number.isSafeInteger(release.revision)||release.revision<0||matches?.length!==1||!rules||typeof rules!=="object"||Array.isArray(rules))fail("BAD_PROVIDER_CONFIG","Zcode 公开供应商配置不匹配");
 const p=structuredClone(matches[0]),c=p.config;
 if(p.templateId||p.enabled===false||c?.group!=="bigmodel-family"||c.access?.type!=="zhipu-account"||c.access?.accountType!=="bigmodel"||c.access?.mode!=="individual-coding-plan"||Object.keys(c.access).sort().join(",")!=="accountType,mode,type"||c.api?.type!=="anthropic-messages"||c.api?.baseUrl!=="https://open.bigmodel.cn/api/anthropic"||Object.keys(c.api).sort().join(",")!=="baseUrl,type"||!Array.isArray(c.builtinModelIds)||!c.builtinModelIds.includes(model)||c.personalModelIds!==undefined)fail("BAD_PROVIDER_CONFIG","仅使用公开中国版 Coding Plan 配置，不接受端点、认证或自定义模型覆盖");
 const modelRules=structuredClone(rules);
 for(const k of ["modelRules","modelApiRules","providerSiteRules","templateModelRules","builtinProviderModelRules"]){if(!Array.isArray(modelRules[k]))fail("BAD_PROVIDER_CONFIG","供应商模型规则缺失");}
 const specific=modelRules.builtinProviderModelRules.filter(r=>r.providerId===ZCODE_PROVIDER&&r.modelId===model);
 if(specific.length>1)fail("BAD_PROVIDER_CONFIG","供应商模型配置重复");
 const config=specific[0]?.config??{};
 modelRules.templateModelRules=[];
 modelRules.builtinProviderModelRules=[{providerId:ZCODE_PROVIDER,modelId:model,config:{...config,enabled:true,optionSpecs:{...config.optionSpecs,reasoningLevel:{...config.optionSpecs?.reasoningLevel,values:[effort]}}}}];
 p.config={...c,builtinModelIds:[model],visibility:"visible"};
 const builtin={schemaVersion:1,revision:release.revision,config:{providerConfigRules:{templateRules:[],providerRules:[p]},modelConfigRules:modelRules}};
 const personal={schemaVersion:1,config:{providerConfigRules:{providerRules:[]},modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]},defaultModelSelection:{providerId:ZCODE_PROVIDER,modelId:model,options:{reasoningLevel:effort}}}};
 return {builtin,personal};
}
export function zcodeSettings(command,args,tools){
 return {permission:{mode:"plan",allowedTools:tools,disallowedTools:[...ZCODE_NATIVE_TOOLS]},plugins:{enabled:false},skills:{enabled:false,includeInstructions:false},features:{compact:false,rewind:false,skill:false,subagent:false,memory:false,mcp:true},hooks:{enabled:false},memory:{use:false},mcp:{servers:{fleet:{type:"stdio",command,args,enabled:true}}}};
}

export function zcodeArguments(node,bundle,cwd,prompt){
 const args=[bundle,"--prompt",prompt,"--mode","plan","--output-format","stream-json","--cwd",cwd,"--disallowed-tools",ZCODE_NATIVE_TOOLS.join(",")];
 // Conservative quote/escape expansion, below the Windows command line ceiling.
 if(args.reduce((n,a)=>n+a.length*2+3,node.length)>30000)fail("BAD_INPUT","Zcode 启动参数超过 Windows 长度预算",400);
 return args;
}
