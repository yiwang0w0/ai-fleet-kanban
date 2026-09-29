"use strict";
// Read-side counterparts to topology's database triggers. Legacy databases remain local.
function enabled(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='topology_bindings'").get();}
function claimable(db,id){
 if(!enabled(db))return true;
 const r=db.prepare("SELECT b.phase,b.owner_node_id,b.owner_epoch,t.task_uid,EXISTS(SELECT 1 FROM topology_vertices v WHERE v.task_id=t.id AND v.task_uid=t.task_uid) registered FROM tasks t JOIN broker_task_projects p ON p.task_id=t.id JOIN topology_bindings b USING(project_id) WHERE t.id=?").get(id);
 if(!r)return true;
 const n=db.prepare("SELECT node_id,sync_epoch FROM board_node WHERE singleton=1").get();
 return r.phase==="ready"&&r.owner_node_id===n.node_id&&r.owner_epoch===n.sync_epoch&&!!r.registered;
}
function finishHeld(db,id){
 return enabled(db)&&!!db.prepare("SELECT 1 FROM topology_holds h JOIN topology_operations o USING(operation_id) WHERE h.task_id=? AND h.block_finish=1 AND o.state='prepared' LIMIT 1").get(id);
}
module.exports={claimable,finishHeld};
