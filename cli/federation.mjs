import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {federationStuck,inspectionError} from '../core/inspection.mjs';
const usage='node cli/federation.mjs stuck --db <现存绝对路径> [--project <项目>] [--limit <1..100>] [--cursor <上一页游标>]';
const [command,...args]=process.argv.slice(2);let db;
try{
 if(!command||command==='--help')console.log(usage);
 else{
  const bad=()=>{throw Object.assign(new Error(),{code:'BAD_INPUT'});};
  if(command!=='stuck')bad();
  const opts={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!['db','project','limit','cursor'].includes(k)||Object.hasOwn(opts,k)||args[i+1]===undefined||args[i+1].startsWith('--'))bad();opts[k]=args[i+1];}
  if(!opts.db)bad();
  db=openSchedulerControlDatabase(opts.db,{readOnly:true});
  const result=federationStuck(db,{projectId:opts.project??null,limit:opts.limit===undefined?100:Number(opts.limit),cursor:opts.cursor??null});
  console.log(JSON.stringify(result,null,2));process.exitCode=result.total?2:0;
 }
}catch(error){console.error(JSON.stringify(inspectionError(error)));process.exitCode=1;}
finally{db?.close();}
