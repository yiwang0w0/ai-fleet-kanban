import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {prepareRuntimeLockRecovery,applyRuntimeLockRecovery} from '../core/execution/runtime-lock-recovery.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
const usage=['node cli/runtime-lock.mjs prepare --db <绝对路径> --kind scheduler|node-runtime --instance <实例UUID>',
 'node cli/runtime-lock.mjs apply --db <绝对路径> --plan-file <已核对JSON> --digest <计划SHA256>',
 'prepare 只读；apply 要求宿主进程不存在且运行停止证据完整，保留回执后仅清理匹配原锁。不启动服务、不重派或退款。'].join('\n');
let db;
try{const [command,...args]=process.argv.slice(2);if(!command||command==='--help')console.log(usage);else{
 const fields={prepare:['db','kind','instance'],apply:['db','plan-file','digest']}[command];if(!fields)throw Error(usage);const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}if(fields.some(k=>!o[k]))throw Error(usage);
 db=openSchedulerControlDatabase(o.db,{readOnly:command==='prepare'});const r=command==='prepare'?prepareRuntimeLockRecovery(db,{kind:o.kind,instanceId:o.instance}):applyRuntimeLockRecovery(db,{plan:readRecoveryJSON(o['plan-file']),expectedPlanDigest:o.digest});console.log(JSON.stringify(r));if(command==='apply'&&!r.lock_released)process.exitCode=2;
}}catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'LOCK_RECOVERY_ERROR',message:'锁恢复未完成；核对计划、原实例和运行停止证据。原任务不会自动重试。'}));process.exitCode=1;}finally{db?.close();}
