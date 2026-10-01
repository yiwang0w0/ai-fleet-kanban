import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {prepareGraphRecovery,recordGraphRecovery,prepareTopologyRecovery,recordTopologyRecovery} from '../core/federation/graph-recovery.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
const usage=[
 'node cli/graph-recovery.mjs prepare-registrar --db <绝对路径> --project <项目> --members-file <成员数组JSON>',
 'node cli/graph-recovery.mjs apply-registrar --db <绝对路径> --plan-file <JSON> --digest <SHA256> --attestation-file <全员声明JSON>',
 'node cli/graph-recovery.mjs prepare-topology --db <绝对路径> --project <项目> --receipt-file <登记恢复回执JSON>',
 'node cli/graph-recovery.mjs apply-topology --db <绝对路径> --plan-file <JSON> --digest <SHA256>',
 'prepare 只读。仅支持工作已停止、未决关系已核对的原登记节点换代；保留旧图，任务暂停至重新登记及人工放行。'
].join('\n');
let db;
try{const [command,...args]=process.argv.slice(2);if(!command||command==='--help')console.log(usage);else{
 const fields={'prepare-registrar':['db','project','members-file'],'apply-registrar':['db','plan-file','digest','attestation-file'],'prepare-topology':['db','project','receipt-file'],'apply-topology':['db','plan-file','digest']}[command];if(!fields)throw Error(usage);const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}if(fields.some(k=>!o[k]))throw Error(usage);
 db=openSchedulerControlDatabase(o.db,{readOnly:command.startsWith('prepare-')});const result=command==='prepare-registrar'?prepareGraphRecovery(db,{projectId:o.project,members:readRecoveryJSON(o['members-file'])}):command==='apply-registrar'?recordGraphRecovery(db,{plan:readRecoveryJSON(o['plan-file']),expectedPlanDigest:o.digest,attestation:readRecoveryJSON(o['attestation-file'])}):command==='prepare-topology'?prepareTopologyRecovery(db,{projectId:o.project,graphReceipt:readRecoveryJSON(o['receipt-file'])}):recordTopologyRecovery(db,{plan:readRecoveryJSON(o['plan-file']),expectedPlanDigest:o.digest});console.log(JSON.stringify(result));
}}catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'GRAPH_RECOVERY_ERROR',message:'图恢复未完成；核对计划、全员停工证据与未决关系。任务不会自动放行。'}));process.exitCode=1;}finally{db?.close();}
