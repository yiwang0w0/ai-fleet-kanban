// Windows node host: owned loopback gateways, bounded sync loops and opt-in scheduler.
import {randomUUID} from 'node:crypto';
import {realpathSync,openSync,writeFileSync,fsyncSync,closeSync,readFileSync,unlinkSync} from 'node:fs';
import {dirname,basename,join,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createLifecycleRegistry,openSchedulerControlDatabase} from './execution/lifecycle.mjs';
import {openScheduler} from './execution/scheduler.mjs';
import {migrateDispatch} from './execution/dispatch.mjs';
import {migratePeers,localIdentity} from './federation/peers.mjs';
import {migrateSync,digest,canonical} from './federation/sync-store.mjs';
import {migrateBroker,exact,fail} from './mcp/policy.mjs';
import {uuid,names} from './federation/protocol.mjs';
import {listenPeerServer} from './federation/gateway.mjs';
import {listenBroker} from './mcp/gateway.mjs';
import {boardURL} from './mcp/context.mjs';
import {endpoint,loadCredential,syncOnce} from './federation/sync-client.mjs';
export const nodeLifecycle=createLifecycleRegistry('node-runtime');
const schedulerLifecycle=createLifecycleRegistry('scheduler');
const errorCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'NODE_RUNTIME_ERROR';
function port(value){if(!Number.isInteger(value)||value<0||value>65535)fail('BAD_INPUT','必须显式指定回环端口',400);return value;}
function policy(db,input){
 exact(input,['format','node_id','node_epoch','peer','mcp','sync','scheduler'],'node_runtime');if(input.format!=='ai-fleet-node-runtime/v1')fail('BAD_INPUT','节点常驻配置格式无效',400);
 uuid(input.node_id,'node_id');uuid(input.node_epoch,'node_epoch');const n=localIdentity(db);if(input.node_id!==n.node_id||input.node_epoch!==n.sync_epoch)fail('EPOCH_CHANGED','常驻配置不属于本机当前代次');
 if(input.peer!==null){exact(input.peer,['host','port'],'peer_listener');if(!['127.0.0.1','::1'].includes(input.peer.host))fail('UNSAFE_BIND','节点仅监听数字回环地址',400);port(input.peer.port);}
 if(input.mcp!==null){exact(input.mcp,['port','board_url'],'mcp_listener');port(input.mcp.port);boardURL(input.mcp.board_url);}
 if(input.peer?.port&&input.peer.port===input.mcp?.port)fail('BAD_INPUT','网关与MCP端口不能相同',400);
 if(!Array.isArray(input.sync)||input.sync.length>32)fail('BAD_INPUT','同步配置最多32项',400);const seen=new Set();
 for(const s of input.sync){
  exact(s,['project_id','url','credential_file','server_node_id','server_epoch','poll_ms'],'sync_profile');names([s.project_id],'project_id',null,1);endpoint(s.url);uuid(s.server_node_id,'server_node_id');uuid(s.server_epoch,'server_epoch');
  if(typeof s.credential_file!=='string'||!isAbsolute(s.credential_file)||!Number.isInteger(s.poll_ms)||s.poll_ms<1000||s.poll_ms>30000)fail('BAD_INPUT','同步文件须为绝对路径，轮询须为1–30秒',400);
  const key=s.server_node_id+'/'+s.project_id;if(seen.has(key))fail('BAD_INPUT','同一来源和项目不能配置两次',400);seen.add(key);credential(db,s);
 }
 if(input.scheduler!==null){if(!input.mcp||!input.mcp.port)fail('BAD_INPUT','执行器需要本机MCP的固定端口',400);if(!input.scheduler||typeof input.scheduler!=='object'||Array.isArray(input.scheduler))fail('BAD_INPUT','执行器配置无效',400);
  if(!Array.isArray(input.scheduler.profiles)||input.scheduler.profiles.some(p=>p.mcp_url!=='http://127.0.0.1:'+input.mcp.port))fail('BAD_INPUT','执行器MCP必须指向本进程管理的端口',400);
 }
 if(input.peer===null&&input.mcp===null&&!input.sync.length&&input.scheduler===null)fail('BAD_INPUT','至少配置一个节点组件',400);
 return structuredClone(input);
}
function credential(db,p){const c=loadCredential(p.credential_file,localIdentity(db),p.project_id);if(c.server_node_id!==p.server_node_id||c.server_epoch!==p.server_epoch)fail('SOURCE_MISMATCH','同步凭据不属于配置的固定来源');return c;}
export function nodeRuntimeStatus(db,options={}){
 const status=nodeLifecycle.status(db,options),has=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='node_runtime_components'").get();
 return {...status,instances:status.instances.map(r=>({...r,components:has?db.prepare('SELECT name,state,updated_at,summary_json FROM node_runtime_components WHERE instance_id=? ORDER BY name').all(r.instance_id).map(({summary_json,...c})=>({...c,summary:JSON.parse(summary_json)})):[]}))};
}
async function closeServer(server){if(!server?.listening)return;await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});}
export async function runNodeRuntime({dbPath,config,sourceGate,stopSignal=null,cancelSignal=null,environment=process.env,onEvent=()=>{}}){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED','节点常驻只支持Windows');sourceGate.check();const db=openSchedulerControlDatabase(dbPath);let fd=null,lock=null,id=null,registered=false,timer=null,scheduler=null,schedulerDone=null,failure=null,unconfirmed=0;
 const drain=new AbortController(),cancel=new AbortController(),syncStop=new AbortController(),servers=[],loops=[],notices=new Map();let removeSignals=()=>{};
 const emit=event=>{try{onEvent({format:'ai-fleet-node-runtime-event/v1',instance_id:id,at:new Date().toISOString(),...event});}catch{}};
 const stop=()=>drain.abort(),abort=()=>{cancel.abort();drain.abort();};
 const attach=()=>{stopSignal?.addEventListener('abort',stop);cancelSignal?.addEventListener('abort',abort);if(stopSignal?.aborted)stop();if(cancelSignal?.aborted)abort();removeSignals=()=>{stopSignal?.removeEventListener('abort',stop);cancelSignal?.removeEventListener('abort',abort);};};
 function component(name,state,summary={}){
  db.prepare('INSERT INTO node_runtime_components VALUES(?,?,?,?,?) ON CONFLICT(instance_id,name) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,summary_json=excluded.summary_json').run(id,name,state,new Date().toISOString(),canonical(summary));
  const stable=canonical({state,...summary});if(notices.get(name)!==stable){notices.set(name,stable);emit({kind:'component',name,state,...summary});}
 }
 const fatal=e=>{failure??=errorCode(e);drain.abort();emit({kind:'attention',code:failure});};
 try{
  const c=policy(db,config),database=realpathSync(dbPath);id=randomUUID();lock=join(dirname(database),'.'+basename(database)+'.fleet-node-runtime.lock');
  try{fd=openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('NODE_RUNTIME_BUSY','已有节点常驻锁；须核对原实例停止后处理残留');throw e;}
  writeFileSync(fd,JSON.stringify({instance_id:id,pid:process.pid,node_id:c.node_id,node_epoch:c.node_epoch})+'\n');fsyncSync(fd);
  nodeLifecycle.register(db,{instanceId:id,pid:process.pid,configDigest:digest(c)});registered=true;
  db.exec('CREATE TABLE IF NOT EXISTS node_runtime_components(instance_id TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,summary_json TEXT NOT NULL,PRIMARY KEY(instance_id,name))');
  migratePeers(db);migrateSync(db);migrateBroker(db);
  if(c.scheduler!==null){migrateDispatch(db);scheduler=openScheduler(db,{dbPath:database,sourceGate,config:c.scheduler,environment,onEvent:e=>emit({kind:'scheduler',scheduler_event:e})});component('scheduler','prepared',{instance_id:scheduler.instance_id});}
  if(c.peer!==null){const server=await listenPeerServer(db,c.peer);servers.push({name:'peer',server});component('peer','listening',{host:c.peer.host,port:server.address().port});server.on('error',fatal);}
  if(c.mcp!==null){const server=await listenBroker(db,{port:c.mcp.port,boardUrl:c.mcp.board_url});servers.push({name:'mcp',server});component('mcp','listening',{host:'127.0.0.1',port:server.address().port});server.on('error',fatal);}
  sourceGate.check();attach();
  const observe=()=>{try{const o=nodeLifecycle.observe(db,id);if(o.mode!=='run')drain.abort();if(o.mode==='cancel')cancel.abort();if(o.changed)emit({kind:'control_observed',mode:o.mode,revision:o.revision,executor_stop_confirmed:false});}catch(e){clearInterval(timer);fatal(e);}};
  observe();if(!failure)timer=setInterval(observe,1000);
  for(const p of c.sync){const name='sync:'+p.server_node_id+':'+p.project_id;loops.push((async()=>{
   let healthy=false;while(!syncStop.signal.aborted){let retry=0;
    try{credential(db,p);const r=await syncOnce(db,{url:p.url,credentialFile:p.credential_file,projectId:p.project_id,signal:syncStop.signal});healthy=!['error','backoff'].includes(r.state);component(name,r.state,{server_node_id:p.server_node_id,project_id:p.project_id,cursor:r.cursor??null,error_code:r.error_code??null});retry=r.retry_after??0;
    }catch(e){if(syncStop.signal.aborted)break;component(name,'error',{server_node_id:p.server_node_id,project_id:p.project_id,error_code:errorCode(e)});retry=Date.now()+30000;}
    if(!syncStop.signal.aborted)try{await delay(Math.max(p.poll_ms,Math.min(30000,retry-Date.now())),undefined,{signal:syncStop.signal});}catch(e){if(e.name!=='AbortError')throw e;}
   }component(name,'stopped',{last_attempt_healthy:healthy});
  })().catch(e=>{fatal(e);}))}
  if(scheduler){component('scheduler','running',{instance_id:scheduler.instance_id});schedulerDone=scheduler.watch({stopSignal:drain.signal,cancelSignal:cancel.signal}).catch(fatal).finally(()=>drain.abort());}
  emit({kind:'started',node_id:c.node_id,node_epoch:c.node_epoch,scheduler_enabled:!!scheduler});
  if(!drain.signal.aborted)await new Promise(resolve=>drain.signal.addEventListener('abort',resolve,{once:true}));
  if(schedulerDone)await schedulerDone;
 }catch(e){fatal(e);}
 finally{
  drain.abort();removeSignals();
  try{
   if(schedulerDone)await schedulerDone;
   if(scheduler){scheduler.close({errorCode:failure});const s=schedulerLifecycle.status(db,{instanceId:scheduler.instance_id}).instances[0];unconfirmed=s.unconfirmed_runs??1;if(s.state!=='stopped')failure??=s.error_code??'EXECUTOR_STOP_UNCONFIRMED';component('scheduler',s.state,{instance_id:s.instance_id,unconfirmed_runs:unconfirmed,executor_stop_confirmed:s.executor_stop_confirmed});}
  }catch(e){unconfirmed=Math.max(1,unconfirmed);failure??=errorCode(e);}
  syncStop.abort();await Promise.allSettled(loops);
  for(const {name,server} of servers.reverse()){try{await closeServer(server);component(name,'stopped');}catch(e){failure??=errorCode(e);}}
  clearInterval(timer);
  let terminal;
  try{
   if(fd!==null){const record=JSON.parse(readFileSync(lock,'utf8'));if(record.instance_id!==id)fail('NODE_RUNTIME_LOCK_CHANGED','常驻锁身份已变化，未移除');}
   if(registered)terminal=nodeLifecycle.finish(db,id,{unconfirmedRuns:unconfirmed,errorCode:failure});
   if(fd!==null){closeSync(fd);fd=null;unlinkSync(lock);}
   if(terminal)emit({kind:'closed',state:terminal.state,error_code:terminal.error_code,unconfirmed_runs:terminal.unconfirmed_runs});
  }catch(e){failure??=errorCode(e);}
  finally{if(fd!==null)closeSync(fd);db.close();}
 }
 if(failure)fail(failure,'节点常驻未正常结束；请核对实例及组件记录');return {instance_id:id,state:'stopped'};
}
