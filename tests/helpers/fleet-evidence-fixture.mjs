import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {migratePeers} from "../../core/federation/peers.mjs";
import {migrateBindings} from "../../core/federation/bindings.mjs";
import {migrateCancellations} from "../../core/federation/cancellation.mjs";
import {migrateResults} from "../../core/federation/results.mjs";
import {canonical,digest,recordSource} from "../../core/federation/sync-store.mjs";
import {enrollTask} from "../../core/mcp/tools.mjs";
const store=createRequire(import.meta.url)("../../core/store.js");
export function evidenceFixture(path=":memory:",{withBinding=true}={}){
 const db=new DatabaseSync(path);store.migrate(db);migratePeers(db);migrateBindings(db);migrateCancellations(db);migrateResults(db);store.renameNode(db,"alpha");
 const local=store.localNode(db),remote=randomUUID(),remoteEpoch=randomUUID(),now=new Date().toISOString();
 const rootId=store.add(db,{subject:"本机父任务",kind:"goal",treeMode:"hierarchical"}),sourceId=store.add(db,{subject:"跨端委派工作",parentId:rootId,treeMode:"hierarchical"});
 for(const id of [rootId,sourceId])enrollTask(db,{id,projectId:"demo",workKind:"implement",capabilities:[],expectedVersion:store.get(db,id).aggregate_version});
 const root=store.get(db,rootId),source=store.get(db,sourceId),target=remote+"/"+randomUUID(),delegationId=randomUUID(),relationId=randomUUID();
 recordSource(db,{node_id:remote,display_name:"alpha",sync_epoch:remoteEpoch});
 db.prepare("INSERT INTO federation_cursors VALUES(?,?,?,?,?)").run(remote,"demo",remoteEpoch,1,now);
 const task={task_uid:target,owner_node_id:remote,subject:'远端工作 <img src=x onerror="alert(1)">',parent_uid:null,description:"仅测试缓存",acceptance:"测试证据",status:"waiting",kind:"task",aggregate_version:1,updated_at:now};
 db.prepare("INSERT INTO federation_replicas VALUES(?,?,?,?,?,?,?,?,?,?)").run(target,remote,remoteEpoch,"demo",1,1,0,canonical(task),1,now);
 const offer={schema_version:1,delegation_id:delegationId,project_id:"demo",source_node_id:local.node_id,source_epoch:local.sync_epoch,source_task_uid:source.task_uid,source_task_version:source.aggregate_version,target_node_id:remote,target_epoch:remoteEpoch,task:{subject:task.subject,description:"PRIVATE-OFFER-BODY",acceptance:"fixture",work_kind:"implement",capabilities:[]}};
 const receipt={schema_version:1,delegation_id:delegationId,project_id:"demo",offer_digest:digest(offer),source_node_id:local.node_id,source_epoch:local.sync_epoch,target_node_id:remote,target_epoch:remoteEpoch,version:2,state:"accepted_unconfirmed",target_task_uid:target,note:"PRIVATE-NOTE",dispatch_ready:false};
 db.prepare("INSERT INTO delegation_outgoing(delegation_id,project_id,source_task_uid,target_node_id,target_epoch,request_digest,offer_digest,offer_json,state,receipt_version,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(delegationId,"demo",source.task_uid,remote,remoteEpoch,digest(offer),digest(offer),canonical(offer),"accepted_unconfirmed",2,canonical(receipt),now,now);
 const descriptor={schema_version:1,type:"delegation",relation_id:relationId,delegation_id:delegationId,project_id:"demo",graph_id:randomUUID(),graph_epoch:randomUUID(),source_node_id:local.node_id,source_epoch:local.sync_epoch,source_task_uid:source.task_uid,target_node_id:remote,target_epoch:remoteEpoch,target_task_uid:target,offer_digest:digest(offer),source_topology_revision:1,target_topology_revision:1};
 if(withBinding)db.prepare("INSERT INTO delegation_bindings(relation_id,delegation_id,project_id,side,node_id,node_epoch,task_id,task_uid,task_version,registrar_node_id,registrar_epoch,descriptor_digest,descriptor_json,contract_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(relationId,delegationId,"demo","source",local.node_id,local.sync_epoch,sourceId,source.task_uid,source.aggregate_version,local.node_id,local.sync_epoch,digest(descriptor),canonical(descriptor),canonical({secret:"PRIVATE-CONTRACT"}),"prepared",now);
 return {db,local,remote,remoteEpoch,root,source,target,offer,receipt,descriptor,delegationId,relationId,now,store};
}

// Synthetic stored history; never launches a model or grants execution authority.
export function addEvidenceHistory(f,count=205){
 const {db,source,local,now}=f;
 const binding=db.prepare("INSERT INTO delegation_bindings(relation_id,delegation_id,project_id,side,node_id,node_epoch,task_id,task_uid,task_version,registrar_node_id,registrar_epoch,descriptor_digest,descriptor_json,contract_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
 const result=db.prepare("INSERT INTO delegation_results(result_id,relation_id,project_id,side,node_id,node_epoch,sequence,task_uid,task_version,run_id,body_json,body_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
 const run=db.prepare("INSERT INTO task_runs(run_id,task_id,task_uid,owner_node_id,executor_node_id,worker,role_id,runtime,agent_instance_id,policy_json,policy_sha256,started_at,first_attempt,last_attempt,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
 db.exec("BEGIN");try{for(let i=0;i<count;i++){
  const d={...f.descriptor,relation_id:randomUUID(),delegation_id:randomUUID()},runId=randomUUID(),resultId=randomUUID();
  binding.run(d.relation_id,d.delegation_id,"demo","source",local.node_id,local.sync_epoch,source.id,source.task_uid,source.aggregate_version,local.node_id,local.sync_epoch,digest(d),canonical(d),"{}","cancelled",now);
  const body={result_id:resultId,relation:d,execution:{run_id:runId,runtime:"fixture",execution_mode:"fixture"},process_result:{status:"success"}};
  result.run(resultId,d.relation_id,"demo","source",local.node_id,local.sync_epoch,1,source.task_uid,source.aggregate_version,runId,canonical(body),digest(body),now);
  run.run(runId,source.id,source.task_uid,local.node_id,local.node_id,"fixture","implementer","fixture",randomUUID(),"{}",digest({}),now,1,1,"ended");
 }db.exec("COMMIT");}catch(e){db.exec("ROLLBACK");throw e;}
}
