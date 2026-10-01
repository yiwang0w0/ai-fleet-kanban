import {fileURLToPath} from 'node:url';
import {openPeerDatabase} from '../core/federation/peers.mjs';
import {migrateDispatch} from '../core/execution/dispatch.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {openScheduler} from '../core/execution/scheduler.mjs';
import {openSchedulerControlDatabase,schedulerStatus,requestSchedulerStop} from '../core/execution/lifecycle.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
const usage=['异常退出残留锁：使用 cli/runtime-lock.mjs prepare/apply；不按心跳超时自动接管。',
 'node cli/scheduler.mjs once|watch|reconcile --db <本机DB绝对路径> --config-file <本机配置JSON> --accepted-rev <既有治理验收文件> [--assignment <恢复用ID>]',
 'node cli/scheduler.mjs status --db <本机DB绝对路径> [--instance <实例UUID>]',
 'node cli/scheduler.mjs drain|cancel --db <本机DB绝对路径> --instance <实例UUID> --version <所见控制版本> --request-id <唯一请求UUID>',
 'drain 停止新领取并等待在途完成；cancel 另行请求取消在途执行。请求成功不代表已停止，须再查 status。',
 'watch 首次 Ctrl+C 等待在途结束；再次 Ctrl+C 或 SIGTERM 取消在途。不会自动重启已消费许可的任务。'].join('\n');
let db,scheduler,failure=null;
const errorCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'SCHEDULER_ERROR';
try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==='--help')console.log(usage);
 else{
  const control=['status','drain','cancel'].includes(command),fields=control?['db','instance',...(command==='status'?[]:['version','request-id'])]:['db','config-file','accepted-rev',...(command==='reconcile'?['assignment']:[])];
  if(!control&&!['once','watch','reconcile'].includes(command))throw Error(usage);
  const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}
  if(!o.db)throw Error(usage);
  if(control){
   if(command!=='status'&&(!o.instance||!o['request-id']||!/^([1-9][0-9]*)$/.test(o.version??'')))throw Error(usage);
   db=openSchedulerControlDatabase(o.db,{readOnly:command==='status'});
   console.log(JSON.stringify(command==='status'?schedulerStatus(db,{instanceId:o.instance??null}):requestSchedulerStop(db,{instanceId:o.instance,expectedRevision:Number(o.version),requestId:o['request-id'],mode:command})));
  }else{
   if(!o['config-file']||!o['accepted-rev']||command==='reconcile'&&!o.assignment)throw Error(usage);
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
 }
}catch(e){failure=errorCode(e);console.error(JSON.stringify({status:'failed',code:failure,message:'调度命令失败；请核对实例版本、配置、治理验收和运行回执。未授权自动重试。'}));process.exitCode=1;}
finally{try{scheduler?.close({errorCode:failure});}catch(e){console.error(JSON.stringify({status:'failed',code:errorCode(e),message:'调度关闭未完整记录；请保留锁和证据核对。'}));process.exitCode=1;}finally{db?.close();}}
