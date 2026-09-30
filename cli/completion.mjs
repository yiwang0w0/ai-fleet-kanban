import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {openPeerDatabase} from "../core/federation/peers.mjs";
import {createSourceGate} from "../core/execution/source-gate.mjs";
import {migrateCompletion,prepareCompletion,completionState,settleCompletion} from "../core/federation/completion.mjs";
import {deliverCompletion,submitCompletion} from "../core/federation/completion-client.mjs";
const usage=[
 "node cli/completion.mjs prepare --db <来源DB> --integration <合并UUID> --id <完成UUID> --version <来源任务版本> --note <验收说明> --accepted-rev <治理树验收文件> [--allow-fixture]",
 "node cli/completion.mjs send --db <来源DB> --id <完成UUID> --url <执行节点地址> --credential <凭据JSON>",
 "node cli/completion.mjs register --db <端点DB> --id <完成UUID> --mode approve|poll [--url <固定登记节点地址> --credential <凭据JSON>]",
 "node cli/completion.mjs settle --db <端点DB> --id <完成UUID> --accepted-rev <治理树验收文件>",
 "node cli/completion.mjs get --db <端点DB> --id <完成UUID>",
 "prepare 是来源操作员的明确验收决定；不向 worker 暴露。双端确认和登记完成后才能 settle；不会直接批准父任务。"
].join("\n");
let db;try{const [command,...args]=process.argv.slice(2);if(!command||command==="--help")console.log(usage);else{
 const required={prepare:["db","integration","id","version","note","accepted-rev"],send:["db","id","url","credential"],register:["db","id","mode"],settle:["db","id","accepted-rev"],get:["db","id"]}[command];if(!required)throw Error(usage);const optional=command==="register"?["url","credential"]:[],o={};let allowFixture=false;
 for(let i=0;i<args.length;i++){if(command==="prepare"&&args[i]==="--allow-fixture"&&!allowFixture){allowFixture=true;continue;}const k=args[i].slice(2);if(!args[i].startsWith("--")||![...required,...optional].includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[++i];}if(required.some(k=>!o[k])||Boolean(o.url)!==Boolean(o.credential))throw Error(usage);
 const sourceGate=o["accepted-rev"]?createSourceGate({codeRoot:resolve(dirname(fileURLToPath(import.meta.url)),".."),approvalFile:o["accepted-rev"]}):null;sourceGate?.check();db=openPeerDatabase(o.db);migrateCompletion(db);let r;
 if(command==="prepare")r=prepareCompletion(db,{completionId:o.id,integrationId:o.integration,expectedSourceVersion:Number(o.version),note:o.note,allowFixture,sourceGate});else if(command==="send")r=await deliverCompletion(db,{completionId:o.id,url:o.url,credentialFile:o.credential});else if(command==="register")r=await submitCompletion(db,{completionId:o.id,mode:o.mode,url:o.url,credentialFile:o.credential});else if(command==="settle")r=settleCompletion(db,{completionId:o.id,sourceGate});else r=completionState(db,o.id);
 console.log(JSON.stringify(r,null,2));if(["retry_pending","blocked","rejected","waiting_peer"].includes(r.delivery_state))process.exitCode=2;
 }}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
