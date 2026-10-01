import {fileURLToPath} from 'node:url';
import {readRecoveryJSON} from '../core/recovery.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {runNodeRuntime,nodeLifecycle,nodeRuntimeStatus} from '../core/node-runtime.mjs';
const usage=['异常退出残留锁：使用 cli/runtime-lock.mjs prepare/apply；不按心跳超时自动接管。',
 'node cli/node-runtime.mjs watch --db <绝对路径> --config-file <节点配置JSON> --accepted-rev <治理验收文件>',
 'node cli/node-runtime.mjs status --db <绝对路径> [--instance <实例UUID>]',
 'node cli/node-runtime.mjs drain|cancel --db <绝对路径> --instance <实例UUID> --version <所见revision> --request-id <请求UUID>',
 'watch 只启动明确配置的组件；scheduler非null时会按既有许可调用执行器。未安装开机启动。'].join('\n');
let db;
try{
 const [command,...args]=process.argv.slice(2);if(!command||command==='--help')console.log(usage);
 else{
  const fields={watch:['db','config-file','accepted-rev'],status:['db','instance'],drain:['db','instance','version','request-id'],cancel:['db','instance','version','request-id']}[command];if(!fields)throw Error(usage);const o={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}if(!o.db)throw Error(usage);
  if(command==='watch'){
   if(!o['config-file']||!o['accepted-rev'])throw Error(usage);const gate=createSourceGate({codeRoot:fileURLToPath(new URL('../',import.meta.url)),approvalFile:o['accepted-rev']}),stop=new AbortController(),cancel=new AbortController();
   const interrupt=()=>{if(stop.signal.aborted)cancel.abort();stop.abort();},terminate=()=>{cancel.abort();stop.abort();};process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
   try{console.log(JSON.stringify(await runNodeRuntime({dbPath:o.db,config:readRecoveryJSON(o['config-file']),sourceGate:gate,stopSignal:stop.signal,cancelSignal:cancel.signal,onEvent:e=>console.log(JSON.stringify(e))})));}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
  }else{
   if(command!=='status'&&(!o.instance||!o['request-id']||!/^([1-9][0-9]*)$/.test(o.version??'')))throw Error(usage);
   db=openSchedulerControlDatabase(o.db,{readOnly:command==='status'});console.log(JSON.stringify(command==='status'?nodeRuntimeStatus(db,{instanceId:o.instance??null}):nodeLifecycle.requestStop(db,{instanceId:o.instance,expectedRevision:Number(o.version),requestId:o['request-id'],mode:command})));
  }
 }
}catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'NODE_RUNTIME_ERROR',message:'节点常驻命令失败；请核对实例、组件及配置记录。'}));process.exitCode=1;}
finally{db?.close();}
