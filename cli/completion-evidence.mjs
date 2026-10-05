import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {captureCompletionSourceEvidence} from '../core/federation/completion-evidence.mjs';
const usage='node cli/completion-evidence.mjs source --db <absolute DB path> --id <completion UUID> --accepted-rev <absolute approval file>\n只读复查原完成合同的来源证据；不会重新验收、放行、执行或发送。';
let db;
try{const [command,...args]=process.argv.slice(2);if(!command||command==='--help')console.log(usage);else{if(command!=='source')throw Error('bad command');const o={},fields=['db','id','accepted-rev'];for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error('bad arguments');o[k]=args[i+1];}if(fields.some(k=>!o[k]))throw Error('missing arguments');const sourceGate=createSourceGate({codeRoot:resolve(dirname(fileURLToPath(import.meta.url)),'..'),approvalFile:o['accepted-rev']});sourceGate.check();db=openSchedulerControlDatabase(o.db,{readOnly:true});console.log(JSON.stringify(captureCompletionSourceEvidence(db,{completionId:o.id,sourceGate})));}}
catch(e){console.error(JSON.stringify({status:'failed',code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'COMPLETION_EVIDENCE_ERROR',message:'来源封存证据未获复查确认；核对原合同、恢复链、治理代码和本机文件。不会自动验收或放行。'}));process.exitCode=1;}finally{db?.close();}
