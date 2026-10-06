"use strict";
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t);
function heldSQL(task){return "EXISTS(SELECT 1 FROM result_members m JOIN delegation_results r USING(result_id) WHERE r.side='target' AND m.task_id="+task+" AND NOT EXISTS(SELECT 1 FROM result_decisions d WHERE d.result_id=r.result_id))";}
function held(db,id){return exists(db,"result_members")&&!!db.prepare("SELECT 1 WHERE "+heldSQL("?")).get(id);}
module.exports={heldSQL,held};
