import {fileURLToPath} from 'node:url';
import {openPeerDatabase} from '../core/federation/peers.mjs';
import {migrateDispatch} from '../core/execution/dispatch.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {openScheduler} from '../core/execution/scheduler.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
const usage='node cli/scheduler.mjs once|watch|reconcile --db <本机DB绝对路径> --config-file <本机配置JSON> --accepted-rev <既有治理验收文件> [--assignment <恢复用ID>]\nwatch 首次 Ctrl+C 停止领取并等在途任务结束；再次 Ctrl+C 或 SIGTERM 取消在途执行。不会自动重启已消费许可的任务。';
let db,scheduler;
try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==='--help')console.log(usage);
 else{
  if(!['once','watch','reconcile'].includes(command))throw Error(usage);
  const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!['db','config-file','accepted-rev',...(command==='reconcile'?['assignment']:[])].includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}
  if(!o.db||!o['config-file']||!o['accepted-rev']||command==='reconcile'&&!o.assignment)throw Error(usage);
  const sourceGate=createSourceGate({codeRoot:fileURLToPath(new URL('../',import.meta.url)),approvalFile:o['accepted-rev']});sourceGate.check();
  db=openPeerDatabase(o.db);migrateDispatch(db);
  scheduler=openScheduler(db,{dbPath:o.db,sourceGate,config:readRecoveryJSON(o['config-file']),onEvent:e=>console.log(JSON.stringify(e))});
  const stop=new AbortController(),cancel=new AbortController();
  const interrupt=()=>{if(stop.signal.aborted)cancel.abort();stop.abort();},terminate=()=>{cancel.abort();stop.abort();};
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try{
   if(command==='watch')await scheduler.watch({stopSignal:stop.signal,cancelSignal:cancel.signal});
   else if(command==='once')console.log(JSON.stringify(await scheduler.tick({stopSignal:stop.signal,cancelSignal:cancel.signal})));
   else console.log(JSON.stringify(scheduler.reconcile(o.assignment)));
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
 }
}catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'SCHEDULER_ERROR',message:'持续调度停止；请核对本机配置、治理验收和运行回执。未授权自动重试。'}));process.exitCode=1;}
finally{try{scheduler?.close();}finally{db?.close();}}
