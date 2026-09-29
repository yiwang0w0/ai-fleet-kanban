"use strict";
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
// This predicate describes current local authorization, not remote liveness.
function readySQL(task){
 return "EXISTS(SELECT 1 FROM delegation_bindings b JOIN binding_source_commits c ON c.relation_id=b.relation_id JOIN federation_peers p ON p.peer_node_id=json_extract(b.descriptor_json,'$.source_node_id') JOIN board_node n ON n.singleton=1 WHERE b.task_id="+task+" AND b.side='target' AND b.state='confirmed' AND b.node_id=n.node_id AND b.node_epoch=n.sync_epoch AND p.status='active' AND p.peer_epoch=json_extract(b.descriptor_json,'$.source_epoch') AND c.credential_version=p.credential_version AND EXISTS(SELECT 1 FROM json_each(p.projects_json) j WHERE j.value=b.project_id) AND EXISTS(SELECT 1 FROM json_each(p.scopes_json) j WHERE j.value='delegation:binding') AND EXISTS(SELECT 1 FROM json_each(p.scopes_json) j WHERE j.value='delegation:offer') AND NOT EXISTS(SELECT 1 FROM federation_retired_epochs e WHERE e.origin_node_id=p.peer_node_id AND e.origin_epoch=p.peer_epoch))";
}
function heldSQL(task){return "EXISTS(WITH RECURSIVE held(id) AS (SELECT task_id FROM delegation_bindings WHERE side='source' AND state IN('prepared','confirmed') UNION SELECT t.parent_id FROM tasks t JOIN held h ON t.id=h.id WHERE t.parent_id IS NOT NULL) SELECT 1 FROM held WHERE id="+task+")";}
function sourceHeld(db,id){return exists(db,"delegation_bindings")&&!!db.prepare("SELECT 1 WHERE "+heldSQL("?")).get(id);}
function ready(db,id){return exists(db,"delegation_bindings")&&!!db.prepare("SELECT 1 WHERE "+readySQL("?")).get(id);}
function claimable(db,id){
 if(sourceHeld(db,id))return false;
 if(!exists(db,"delegation_incoming")||!db.prepare("SELECT 1 FROM delegation_incoming WHERE target_task_id=? AND state='accepted_unconfirmed'").get(id))return true;
 return ready(db,id);
}
function projection(db,delegationId){if(!exists(db,"delegation_bindings"))return null;const b=db.prepare("SELECT relation_id,task_id,task_uid,side,state,node_id,node_epoch FROM delegation_bindings WHERE delegation_id=? ORDER BY rowid DESC LIMIT 1").get(delegationId);if(!b)return null;const n=db.prepare("SELECT node_id,sync_epoch FROM board_node WHERE singleton=1").get();return {relation_id:b.relation_id,task_uid:b.task_uid,side:b.side,state:b.state,identity_current:b.node_id===n.node_id&&b.node_epoch===n.sync_epoch,binding_authorized:b.side==="target"&&ready(db,b.task_id)};}
module.exports={projection,heldSQL,readySQL,ready,sourceHeld,claimable};
