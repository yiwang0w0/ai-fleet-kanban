import {readFleetProgress,progressReceiptDraft} from '../core/fleet-progress.mjs';
const usage='node cli/progress.mjs --config <管理者进度配置绝对路径> [--project <项目>] [--plan <计划> --phase <阶段>]';
try{
 const args=process.argv.slice(2);if(args.length===1&&args[0]==='--help')console.log(usage);
 else{const opts={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['config','project','plan','phase'].includes(key)||Object.hasOwn(opts,key)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);opts[key]=args[i+1];}if(!opts.config||!!opts.plan!==!!opts.phase)throw Error(usage);const view=readFleetProgress(opts.config,{projectId:opts.project??null});console.log(JSON.stringify(opts.plan?progressReceiptDraft(view,opts.plan,opts.phase):view,null,2));}
}catch(e){console.error(e.code??'PROGRESS_UNAVAILABLE',e.message);process.exitCode=1;}
