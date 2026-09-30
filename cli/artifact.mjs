import {openPeerDatabase} from "../core/federation/peers.mjs";
import {migrateArtifacts,registerArtifactTarget,prepareArtifact,artifactState,verifyArtifact} from "../core/artifacts/transfers.mjs";
import {deliverArtifact} from "../core/artifacts/transfer-client.mjs";
const usage=[
 "node cli/artifact.mjs target --db <来源DB> --result <候选UUID> --mapping <本机仓库UUID> --base <批准基线> --allow-full-baseline-read true",
 "node cli/artifact.mjs prepare --db <执行端DB> --result <候选UUID> --id <传输UUID>",
 "node cli/artifact.mjs send --db <执行端DB> --transfer <UUID> --url <来源地址> --credential <反向凭据> [--max-chunks <1..768，默认64>]",
 "node cli/artifact.mjs verify --db <来源DB> --transfer <UUID>",
 "node cli/artifact.mjs get --db <DB> --transfer <UUID>",
 "先回传候选报告，在来源登记接收仓库与完整基线读取许可，再发送实际文件。重复 send 续传同一产物；verify 只核验内容，不运行测试、不合并或批准任务。"
].join("\n");
let db;try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==="--help")console.log(usage);
 else{
  const fields={target:["db","result","mapping","base","allow-full-baseline-read"],prepare:["db","result","id"],send:["db","transfer","url","credential","max-chunks"],verify:["db","transfer"],get:["db","transfer"]}[command],o={};
  if(!fields)throw Error(usage);for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith("--")||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);o[k]=args[i+1];}
  if(fields.some(k=>k!=="max-chunks"&&!o[k]))throw Error(usage);db=openPeerDatabase(o.db);migrateArtifacts(db);let r;
  if(command==="target")r=registerArtifactTarget(db,{resultId:o.result,mappingId:o.mapping,baseCommit:o.base,allowFullBaselineRead:o["allow-full-baseline-read"]==="true"});
  else if(command==="prepare")r=prepareArtifact(db,{resultId:o.result,transferId:o.id});
  else if(command==="verify")r=verifyArtifact(db,{transferId:o.transfer});
  else if(command==="get")r=artifactState(db,o.transfer);
  else r=await deliverArtifact(db,{transferId:o.transfer,url:o.url,credentialFile:o.credential,maxChunks:Number(o["max-chunks"]??64)});
  console.log(JSON.stringify(r,null,2));if(["retry_pending","blocked"].includes(r.delivery_state))process.exitCode=2;
 }
}catch(e){console.error((e.code?e.code+": ":"")+e.message);process.exitCode=1;}finally{db?.close();}
