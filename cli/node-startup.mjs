import {prepareNodeStartup,verifyNodeStartup,runNodeStartup} from '../core/node-startup.mjs';
const usage='node cli/node-startup.mjs prepare --db <absolute> --config-file <absolute> --accepted-rev <absolute> --output <new absolute directory> | inspect|check|run --bundle <absolute> --digest <reviewed SHA256>';
try{
 const [command,...args]=process.argv.slice(2),fields={prepare:['db','config-file','accepted-rev','output'],inspect:['bundle','digest'],check:['bundle','digest'],run:['bundle','digest']}[command];
 if(command==='--help'||!command)console.log(usage);
 else{if(!fields)throw Error(usage);const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}if(fields.some(k=>!o[k]))throw Error(usage);
 if(command==='prepare')console.log(JSON.stringify(prepareNodeStartup({dbPath:o.db,configFile:o['config-file'],approvalFile:o['accepted-rev'],output:o.output})));
 else if(['inspect','check'].includes(command)){const {manifest:m}=verifyNodeStartup(o.bundle,o.digest,{checkInputs:command==='check'});console.log(JSON.stringify({format:'ai-fleet-node-startup-check/v1',verified:true,runtime_inputs_checked:command==='check',task_name:m.task_name,node_id:m.node_id,node_epoch:m.node_epoch,scheduler_enabled:m.scheduler_enabled,registered:false,started:false}));}
 else{const stop=new AbortController(),cancel=new AbortController(),interrupt=()=>{if(stop.signal.aborted)cancel.abort();stop.abort();},terminate=()=>{cancel.abort();stop.abort();};process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);try{console.log(JSON.stringify(await runNodeStartup(o.bundle,o.digest,{stopSignal:stop.signal,cancelSignal:cancel.signal})));}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}}
 }
}catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'STARTUP_ERROR',message:'节点启动命令失败；请核对固定文件、实例状态与启动包。'}));process.exitCode=1;}
