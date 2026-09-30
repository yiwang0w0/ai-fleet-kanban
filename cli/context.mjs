import {exportDesktopContext} from '../core/desktop-context.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
const usage='node cli/context.mjs export|watch --db <绝对路径> --credential-file <observe凭据> --root <新的本机目录> [--board-url <回环看板根地址>] [--interval-seconds <watch间隔，15至3600>]';
const [command,...args]=process.argv.slice(2);let stopped=false;const controller=new AbortController();
try{
 if(command==='--help'||!command)console.log(usage);
 else{
  if(!['export','watch'].includes(command))throw Error(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith('--')||!['db','credential-file','root','board-url','interval-seconds'].includes(key)||Object.hasOwn(opts,key)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);opts[key]=args[i+1];}
  if(!opts.db||!opts['credential-file']||!opts.root)throw Error(usage);const seconds=Number(opts['interval-seconds']??30);if(!Number.isInteger(seconds)||seconds<15||seconds>3600||command==='export'&&opts['interval-seconds'])throw Error(usage);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;controller.abort();});
  do{console.log(JSON.stringify(exportDesktopContext({dbPath:opts.db,credentialFile:opts['credential-file'],root:opts.root,boardUrl:opts['board-url']??null})));if(command==='export')break;try{await sleep(seconds*1000,null,{signal:controller.signal});}catch(e){if(e.name!=='AbortError')throw e;}}while(!stopped);
 }
}catch(e){console.error(e.code??'CONTEXT_EXPORT_FAILED',e.message);process.exitCode=1;}
