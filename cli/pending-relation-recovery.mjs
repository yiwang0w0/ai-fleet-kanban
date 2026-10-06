import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
import {pendingRelationEndpointEvidence,preparePendingRelationRecovery,recordPendingRelationRecovery,pendingRelationRecoveryState} from '../core/federation/pending-relation-recovery.mjs';
const commands={
 'endpoint-evidence':{fields:['db','relation-file','registrar-epoch'],fn:(db,o)=>pendingRelationEndpointEvidence(db,{relation:readRecoveryJSON(o['relation-file']),registrarEpoch:o['registrar-epoch']})},
 'prepare-registrar':{fields:['db','relation','evidence-file'],fn:(db,o)=>preparePendingRelationRecovery(db,{relationId:o.relation,endpointEvidence:readRecoveryJSON(o['evidence-file'])})},
 'record-registrar':{fields:['db','plan-file','digest','attestation-file'],fn:(db,o)=>recordPendingRelationRecovery(db,{plan:readRecoveryJSON(o['plan-file']),expectedPlanDigest:o.digest,attestation:readRecoveryJSON(o['attestation-file'])})},
 status:{fields:['db','relation'],fn:(db,o)=>pendingRelationRecoveryState(db,o.relation)}
};
const usage=Object.entries(commands).map(([name,c])=>'node cli/pending-relation-recovery.mjs '+name+' '+c.fields.map(f=>'--'+f+' <value>').join(' ')).join('\n')+'\n本机人工恢复。已有绑定先通过 binding-recovery 退出；未准备的已收到提议先明确拒绝。仅 record-registrar 写入，不自动放行。';
let db;
try{const [name,...args]=process.argv.slice(2);if(!name||name==='--help')console.log(usage);else{const c=commands[name];if(!c)throw Error('bad command');const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!c.fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error('bad arguments');o[k]=args[i+1];}if(c.fields.some(k=>!o[k]))throw Error('missing arguments');db=openSchedulerControlDatabase(o.db,{readOnly:name!=='record-registrar'});console.log(JSON.stringify(c.fn(db,o)));}}
catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'PENDING_RELATION_RECOVERY_ERROR',message:'未决提议恢复未完成；核对双方退出、停止证据、登记代次与计划摘要。不会自动放行。'}));process.exitCode=1;}finally{db?.close();}
