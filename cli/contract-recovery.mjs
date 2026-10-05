import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
import {prepareEndpointRecovery,recordEndpointRecovery,prepareRegistrarRecovery,recordRegistrarRecovery,prepareRecoverySettlement,recordRecoverySettlement,contractRecoveryState} from '../core/federation/contract-recovery.mjs';
const commands={
 'prepare-endpoint':{fields:['db','relation','registrar-epoch'],fn:(db,o)=>prepareEndpointRecovery(db,{relationId:o.relation,registrarEpoch:o['registrar-epoch']})},
 'record-endpoint':{fields:['db','plan-file','digest','attestation-file'],fn:recordEndpointRecovery},
 'prepare-registrar':{fields:['db','relation','receipts-file'],fn:(db,o)=>prepareRegistrarRecovery(db,{relationId:o.relation,endpointReceipts:readRecoveryJSON(o['receipts-file'])})},
 'record-registrar':{fields:['db','plan-file','digest','attestation-file'],fn:recordRegistrarRecovery},
 'prepare-settlement':{fields:['db','relation','receipt-file'],fn:(db,o)=>prepareRecoverySettlement(db,{relationId:o.relation,registrarReceipt:readRecoveryJSON(o['receipt-file'])})},
 'record-settlement':{fields:['db','plan-file','digest','attestation-file'],fn:recordRecoverySettlement},
 status:{fields:['db','relation'],fn:(db,o)=>contractRecoveryState(db,o.relation)}
};
const usage=Object.entries(commands).map(([name,c])=>'node cli/contract-recovery.mjs '+name+' '+c.fields.map(f=>'--'+f+' <value>').join(' ')).join('\n')+'\n仅本机管理；prepare/status 只读。先保存双方同一取消及停止回执，再核对旧登记节点已禁用的实际证据。无自动放行或验收。';
let db;
try{const [name,...args]=process.argv.slice(2);if(!name||name==='--help')console.log(usage);else{
 const command=commands[name];if(!command)throw Error('bad command');const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!command.fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error('bad arguments');o[k]=args[i+1];}if(command.fields.some(k=>!o[k]))throw Error('missing arguments');
 const writing=name.startsWith('record-');db=openSchedulerControlDatabase(o.db,{readOnly:!writing});const params=writing?{plan:readRecoveryJSON(o['plan-file']),expectedPlanDigest:o.digest,attestation:readRecoveryJSON(o['attestation-file'])}:o;console.log(JSON.stringify(command.fn(db,params)));
}}catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'CONTRACT_RECOVERY_ERROR',message:'合同恢复未完成；核对双方停止回执、登记节点代次和明确计划摘要。不会自动放行。'}));process.exitCode=1;}finally{db?.close();}
