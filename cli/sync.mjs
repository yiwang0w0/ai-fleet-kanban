// Local admin commands. Sharing is opt-in and never starts task workers.
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateSync,shareTask,listReplicas,syncStatus} from "../core/federation/sync-store.mjs";
import {pruneHistory} from "../core/federation/snapshots.mjs";
import {syncOnce} from "../core/federation/sync-client.mjs";
const usage="用法: node cli/sync.mjs prune --db <绝对路径> --project <项目> --through-seq <边界> --expected-head <当前末尾> [--allow-lagging true]\n"+
 "用法: node cli/sync.mjs share|withdraw --db <绝对路径> --task <id> --project <项目> --version <任务版本>\n"+
 "      node cli/sync.mjs replicas --db <绝对路径> [--project <项目>]\n      node cli/sync.mjs status --db <绝对路径>\n"+
 "      node cli/sync.mjs pull|watch --db <绝对路径> --url <根地址> --credential-file <凭据文件> --project <项目>";
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help"){console.log(usage);}
 else{
  const fields={share:["db","task","project","version"],withdraw:["db","task","project","version"],
   prune:["db","project","through-seq","expected-head","allow-lagging"],replicas:["db","project"],status:["db"],pull:["db","url","credential-file","project"],watch:["db","url","credential-file","project"]}[command];
  if(!fields)throw Error(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const k=args[i].replace(/^--/,"");
   if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(opts,k)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);
   opts[k]=args[i+1];}
  if(!opts.db)throw Error("--db 必填");db=openPeerDatabase(opts.db);migrateSync(db);
  if(command==="share"||command==="withdraw"){
   if(!/^[1-9][0-9]*$/.test(opts.task||"")||!/^[1-9][0-9]*$/.test(opts.version||""))throw Error("需要正整数 --task 与 --version");
   console.log(JSON.stringify(shareTask(db,{id:Number(opts.task),projectId:opts.project,expectedVersion:Number(opts.version),enabled:command==="share"})));
  }else if(command==="prune"){
   for(const k of ["through-seq","expected-head"])if(!/^[1-9][0-9]*$/.test(opts[k]||""))throw Error(k+" 必须是正整数");
   if(opts["allow-lagging"]!==undefined&&opts["allow-lagging"]!=="true")throw Error("--allow-lagging 仅接受 true");
   console.log(JSON.stringify(pruneHistory(db,{projectId:opts.project,throughSeq:Number(opts["through-seq"]),expectedHead:Number(opts["expected-head"]),allowLagging:opts["allow-lagging"]==="true"})));
  }else if(command==="replicas")console.log(JSON.stringify(listReplicas(db,{projectId:opts.project}),null,2));
  else if(command==="status")console.log(JSON.stringify(syncStatus(db),null,2));
  else{
   const abort=new AbortController();
   let stopped=false,timer,wake;const stop=()=>{stopped=true;abort.abort();clearTimeout(timer);wake?.();};
   process.once("SIGINT",stop);process.once("SIGTERM",stop);
   let last=null;
   do{
    const result=await syncOnce(db,{url:opts.url,credentialFile:opts["credential-file"],projectId:opts.project,signal:abort.signal});
    const summary={state:result.state,error_code:result.error_code,cursor:result.cursor};
    if(command==="pull"||result.applied>0||JSON.stringify(summary)!==last)console.log(JSON.stringify(result));
    last=JSON.stringify(summary);
    if(command==="pull"){if(["error","backoff"].includes(result.state))process.exitCode=1;break;}
    if(!stopped)await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1000,Math.min(30000,(result.retry_after??0)-Date.now())));});
   }while(!stopped);
  }
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{db?.close();}
