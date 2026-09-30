import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {migrateBroker,putRole,inspectRoles,issuePrincipal,revokePrincipal} from "../core/mcp/policy.mjs";
import {enrollTask} from "../core/mcp/tools.mjs";
import {listenBroker} from "../core/mcp/gateway.mjs";
import {readRecoveryJSON} from "../core/recovery.mjs";
const usage="node cli/mcp-admin.mjs roles --db <绝对路径>\n"+
 "node cli/mcp-admin.mjs role --db <绝对路径> --policy-file <角色JSON> [--version <所见版本>]\n"+
 "node cli/mcp-admin.mjs grant --db <绝对路径> --role <身份> --projects <项目列表> --credential-file <新文件> [--run <已领取run>]\n"+
 "node cli/mcp-admin.mjs revoke --db <绝对路径> --principal <ID> --version <版本>\n"+
 "node cli/mcp-admin.mjs enroll --db <绝对路径> --task <ID> --project <项目> --work-kind implement|review --capabilities <逗号分隔能力> --version <任务版本>\n"+
 "node cli/mcp-admin.mjs serve --db <绝对路径> --port <回环端口> [--board-url <本机看板根地址>]";
const [command,...args]=process.argv.slice(2);let db,server;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={roles:["db"],role:["db","policy-file","version"],grant:["db","role","projects","credential-file","run"],revoke:["db","principal","version"],enroll:["db","task","project","work-kind","capabilities","version"],serve:["db","port","board-url"]}[command];
  if(!fields)throw Error(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(key)||Object.hasOwn(opts,key)||args[i+1]===undefined||args[i+1].startsWith("--"))throw Error(usage);opts[key]=args[i+1];}
  if(!opts.db)throw Error("--db 必填");
  db=openPeerDatabase(opts.db);migrateSync(db);migrateBroker(db);
  if(command==="roles")console.log(JSON.stringify({roles:inspectRoles(db)},null,2));
  else if(command==="role")console.log(JSON.stringify(putRole(db,readRecoveryJSON(opts["policy-file"]),opts.version===undefined?undefined:Number(opts.version)),null,2));
  else if(command==="grant")console.log(JSON.stringify(issuePrincipal(db,{roleId:opts.role,projects:(opts.projects??"").split(","),credentialFile:opts["credential-file"],runId:opts.run??null}),null,2));
  else if(command==="revoke")console.log(JSON.stringify(revokePrincipal(db,{principalId:opts.principal,expectedVersion:Number(opts.version)})));
  else if(command==="enroll")console.log(JSON.stringify(enrollTask(db,{id:Number(opts.task),projectId:opts.project,workKind:opts["work-kind"],capabilities:opts.capabilities?opts.capabilities.split(","):[],expectedVersion:Number(opts.version)})));
  else{
   if(!/^[0-9]+$/.test(opts.port??""))throw Error("--port 必须显式指定数字");
   server=await listenBroker(db,{port:Number(opts.port),boardUrl:opts["board-url"]??null});console.log(JSON.stringify({listening:"http://127.0.0.1:"+server.address().port}));
   await new Promise(resolve=>{const stop=()=>{server.closeAllConnections();server.close(resolve);};process.once("SIGINT",stop);process.once("SIGTERM",stop);});
  }
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{db?.close();}
