"use strict";
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
function heldSQL(task){return "EXISTS(SELECT 1 FROM cancellation_members m WHERE m.task_id="+task+")";}
function held(db,id){return exists(db,"cancellation_members")&&!!db.prepare("SELECT 1 FROM cancellation_members WHERE task_id=? LIMIT 1").get(id);}
function projection(db,relation){if(!exists(db,"delegation_cancellations"))return null;const c=db.prepare("SELECT cancel_id,state FROM delegation_cancellations WHERE relation_id=?").get(relation);return c?{...c,stopped:c.state==="stopped"}:null;}
module.exports={heldSQL,held,projection};
