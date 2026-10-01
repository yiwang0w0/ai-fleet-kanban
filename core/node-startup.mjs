// Reviewable per-user Task Scheduler bundle. Preparation never registers or starts a task.
import {readFileSync,writeFileSync,lstatSync,existsSync,realpathSync,openSync,closeSync,writeSync,fsyncSync} from 'node:fs';
import {join,dirname,basename,isAbsolute,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {privateDirectory,checkDirectoryPath} from './private-directory.mjs';
import {readRecoveryJSON} from './recovery.mjs';
import {createSourceGate} from './execution/source-gate.mjs';
import {openSchedulerControlDatabase} from './execution/lifecycle.mjs';
import {localIdentity} from './federation/peers.mjs';
import {validateNodeRuntimeConfig,runNodeRuntime} from './node-runtime.mjs';
import {exact,fail} from './mcp/policy.mjs';
import {uuid} from './federation/protocol.mjs';
// Windows PowerShell expands 8.3 aliases; native realpath pins that same spelling.
const ROOT=realpathSync.native(fileURLToPath(new URL('../',import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex');
const inside=(a,b)=>{const r=relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
function path(value){if(typeof value!=='string'||!isAbsolute(value)||!(/^[a-z]:[\\/]/i.test(value))||/[\x00-\x1f"%]/.test(value)||value.slice(2).includes(':'))fail('BAD_INPUT','启动路径必须是本地磁盘普通绝对路径');checkDirectoryPath(dirname(value));return value;}
function pin(value){path(value);const s=lstatSync(value);if(!s.isFile()||s.isSymbolicLink())fail('BAD_INPUT','启动文件须为普通文件');return {path:realpathSync.native(value),sha256:hash(readFileSync(value))};}
function checkPin(p){exact(p,['path','sha256'],'startup_pin');if(typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256)||pin(p.path).sha256!==p.sha256)fail('STARTUP_INPUT_CHANGED','启动文件摘要已变化');}
export function startupSID(){return execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}).trim();}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const quoted=s=>'"'+s+'"';
export function startupTaskXML(m,digest){
 const args=['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',quoted(m.wrapper.path),'-Action','Run','-Bundle',quoted(m.directory),'-Digest',digest].join(' ');
 return `<?xml version="1.0"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Author>${esc(m.user_sid)}</Author><Description>ai-fleet-node-startup/v1 ${digest}</Description><URI>\\${esc(m.task_name)}</URI></RegistrationInfo>
 <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(m.user_sid)}</UserId><Delay>PT10S</Delay></LogonTrigger></Triggers>
 <Principals><Principal id="User"><UserId>${esc(m.user_sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>false</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>
 <Actions Context="User"><Exec><Command>${esc(m.powershell.path)}</Command><Arguments>${esc(args)}</Arguments><WorkingDirectory>${esc(m.source_root)}</WorkingDirectory></Exec></Actions>
</Task>\n`;
}
function inputs(m){
 const gate=createSourceGate({codeRoot:m.source_root,approvalFile:m.approval.path}),g=gate.check();if(g.tree!==m.source_tree||realpathSync.native(m.source_root)!==ROOT)fail('STARTUP_SOURCE_CHANGED','启动源码不是已固定的当前代码');
 for(const p of [m.node,m.powershell,m.wrapper,m.launcher,m.config,m.approval])checkPin(p);
 if(realpathSync.native(m.node.path)!==realpathSync.native(process.execPath))fail('STARTUP_INPUT_CHANGED','当前Node不是固定程序');
 const db=openSchedulerControlDatabase(m.database,{readOnly:true});let config;try{const n=localIdentity(db);if(n.node_id!==m.node_id||n.sync_epoch!==m.node_epoch)fail('EPOCH_CHANGED','启动包属于旧节点代次');config=validateNodeRuntimeConfig(db,readRecoveryJSON(m.config.path));}finally{db.close();}return {gate,config};
}
export function prepareNodeStartup({dbPath,configFile,approvalFile,output}){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED','启动包仅支持Windows');const gate=createSourceGate({codeRoot:ROOT,approvalFile}),g=gate.check(),db=openSchedulerControlDatabase(dbPath,{readOnly:true});let n,c;
 try{n=localIdentity(db);c=validateNodeRuntimeConfig(db,readRecoveryJSON(configFile));}finally{db.close();}
 output=checkDirectoryPath(output);path(join(output,'STARTUP.json'));if(existsSync(output))fail('STARTUP_EXISTS','启动包必须使用新目录');const canonicalOutput=join(realpathSync.native(dirname(output)),basename(output));if(inside(ROOT,canonicalOutput)||inside(canonicalOutput,ROOT))fail('UNSAFE_RUNTIME_PATH','启动包和治理代码须分离');
 const sid=startupSID();if(!/^S-1-5-\d+(?:-\d+)+$/.test(sid))fail('STARTUP_USER','无法识别当前用户SID');const id=randomUUID();
 const m={format:'ai-fleet-node-startup/v1',bundle_id:id,directory:output,task_name:'AiFleet-'+n.node_id+'-'+id,user_sid:sid,node_id:n.node_id,node_epoch:n.sync_epoch,database:realpathSync.native(dbPath),source_root:ROOT,source_tree:g.tree,node:pin(process.execPath),powershell:pin(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')),wrapper:pin(join(ROOT,'packaging/windows/node-startup.ps1')),launcher:pin(join(ROOT,'cli/node-startup.mjs')),config:pin(configFile),approval:pin(approvalFile),scheduler_enabled:c.scheduler!==null,trigger:'current-user-logon',initially_enabled:false};
 privateDirectory(output);const bytes=JSON.stringify(m,null,2)+'\n',digest=hash(bytes);writeFileSync(join(output,'STARTUP.json'),bytes,{flag:'wx',flush:true});writeFileSync(join(output,'task.xml'),startupTaskXML(m,digest),{flag:'wx',flush:true});
 return {format:'ai-fleet-node-startup-plan/v1',directory:output,manifest_sha256:digest,task_name:m.task_name,node_id:m.node_id,node_epoch:m.node_epoch,user_sid:sid,scheduler_enabled:m.scheduler_enabled,registered:false,enabled:false,started:false};
}
export function verifyNodeStartup(directory,digest,{checkInputs=true}={}){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED','启动包仅支持Windows');directory=checkDirectoryPath(directory);if(!existsSync(directory))fail('STARTUP_NOT_FOUND','启动包目录不存在');privateDirectory(directory);const file=join(directory,'STARTUP.json'),bytes=readFileSync(file);
 if(bytes.length>65536||!/^[a-f0-9]{64}$/.test(digest??'')||hash(bytes)!==digest)fail('STARTUP_REVIEW_CHANGED','启动包不匹配明确核对的摘要');
 const m=JSON.parse(bytes);exact(m,['format','bundle_id','directory','task_name','user_sid','node_id','node_epoch','database','source_root','source_tree','node','powershell','wrapper','launcher','config','approval','scheduler_enabled','trigger','initially_enabled'],'startup_bundle');
 for(const field of ['bundle_id','node_id','node_epoch'])uuid(m[field],field);
 if(m.format!=='ai-fleet-node-startup/v1'||m.directory!==directory||m.task_name!=='AiFleet-'+m.node_id+'-'+m.bundle_id||m.user_sid!==startupSID()||m.trigger!=='current-user-logon'||m.initially_enabled!==false)fail('STARTUP_BINDING_CHANGED','启动包身份不匹配');
 if(readFileSync(join(directory,'task.xml'),'utf8')!==startupTaskXML(m,digest))fail('STARTUP_XML_CHANGED','任务定义与核对范围不同');
 if(!checkInputs)return {manifest:m};
 const checked=inputs(m);if(m.scheduler_enabled!==(checked.config.scheduler!==null))fail('STARTUP_BINDING_CHANGED','执行器启用声明不一致');return {manifest:m,...checked};
}
export async function runNodeStartup(directory,digest,{stopSignal=null,cancelSignal=null}={}){
 const {manifest:m,gate,config}=verifyNodeStartup(directory,digest),log=join(directory,'run-'+randomUUID()+'.jsonl'),fd=openSync(log,'wx',0o600),stop=new AbortController();let bytes=0,capped=false,logError=false;
 const propagate=()=>stop.abort();stopSignal?.addEventListener('abort',propagate);if(stopSignal?.aborted)stop.abort();
 const record=e=>{try{const line=JSON.stringify(e)+'\n',size=Buffer.byteLength(line);if(bytes+size>1024*1024){if(!capped){writeSync(fd,JSON.stringify({kind:'log_limit',database_status_remains_available:true})+'\n');capped=true;}return;}writeSync(fd,line);bytes+=size;}catch{logError=true;stop.abort();}};
 try{record({format:'ai-fleet-node-startup-run/v1',bundle_id:m.bundle_id,manifest_sha256:digest,at:new Date().toISOString()});const r=await runNodeRuntime({dbPath:m.database,config,sourceGate:gate,stopSignal:stop.signal,cancelSignal,onEvent:record});if(logError)fail('STARTUP_LOG_FAILED','运行日志无法保存，已停止新领取');return {...r,log_file:log};}
 finally{stopSignal?.removeEventListener('abort',propagate);try{fsyncSync(fd);}finally{closeSync(fd);}}
}
