import {saveDesktopHandoff} from "../core/desktop-context.mjs";
const usage="node cli/context-handoff.mjs --db <绝对路径> --credential-file <observe凭据> --root <上下文目录> --task-uid <任务UID> --expected-version <版本> --handoff-id <UUID> --client <来源客户端> --summary-file <明确准备的UTF-8 md或txt> [--board-url <回环看板根地址>]";
try{
 const args=process.argv.slice(2);if(args.length===1&&args[0]==="--help")console.log(usage);
 else{const opts={},allowed=["db","credential-file","root","task-uid","expected-version","handoff-id","client","summary-file","board-url"];
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!allowed.includes(key)||Object.hasOwn(opts,key)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);opts[key]=args[i+1];}
  if(allowed.slice(0,8).some(k=>!opts[k])||!/^[1-9][0-9]*$/.test(opts["expected-version"]))throw Error(usage);
  const result=saveDesktopHandoff({dbPath:opts.db,credentialFile:opts["credential-file"],root:opts.root,taskUid:opts["task-uid"],expectedVersion:Number(opts["expected-version"]),handoffId:opts["handoff-id"],client:opts.client,summaryFile:opts["summary-file"],boardUrl:opts["board-url"]??null});
  console.log(JSON.stringify(result));
 }
}catch(e){console.error(e.code??"CONTEXT_HANDOFF_FAILED",e.message);process.exitCode=1;}
