import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateSync} from "../core/federation/sync-store.mjs";
import {prepareSourceRecovery,acceptSourceRecovery,sourceRecoveryHistory} from "../core/federation/epoch-recovery.mjs";
import {readRecoveryJSON,writeRecoveryJSON} from "../core/recovery.mjs";
const usage="node cli/source-recovery.mjs prepare --db <绝对路径> --url <固定根地址> --credential-file <新凭据> --expected-epoch <所见旧代次> --plan-file <新计划文件>\n"+
 "node cli/source-recovery.mjs accept --db <绝对路径> --plan-file <已核对计划> --plan-digest <所见摘要>\n"+
 "node cli/source-recovery.mjs history --db <绝对路径> --origin <来源UUID>";
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={prepare:["db","url","credential-file","expected-epoch","plan-file"],accept:["db","plan-file","plan-digest"],history:["db","origin"]}[command];
  if(!fields)throw Error(usage);const opts={};
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(key)||Object.hasOwn(opts,key)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);opts[key]=args[i+1];}
  if(fields.some(k=>!opts[k]))throw Error(usage);
  db=openPeerDatabase(opts.db);migrateSync(db);
  if(command==="prepare"){
   const plan=await prepareSourceRecovery(db,{url:opts.url,credentialFile:opts["credential-file"],expectedEpoch:opts["expected-epoch"]});
   writeRecoveryJSON(opts["plan-file"],plan);console.log(JSON.stringify(plan,null,2));
  }else if(command==="accept"){
   console.log(JSON.stringify(await acceptSourceRecovery(db,{plan:readRecoveryJSON(opts["plan-file"]),expectedPlanDigest:opts["plan-digest"]}),null,2));
  }else console.log(JSON.stringify(sourceRecoveryHistory(db,opts.origin),null,2));
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}
finally{db?.close();}
