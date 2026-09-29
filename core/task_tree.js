"use strict";
// Local tree structure only. Cross-node delegation edges use a separate protocol.
const TREE_MODES=Object.freeze(["legacy","hierarchical"]);
const HIERARCHICAL_MAX_DEPTH=32;
const MAX_TREE_NODES=10000;
// Read-only inspection of a pre-migration database retains its legacy policy.
function modeColumn(db){return db.prepare("PRAGMA table_info(tasks)").all().some(c=>c.name==="tree_mode")?"tree_mode":"'legacy' AS tree_mode";}
function ancestry(db,id){
 const q=db.prepare("SELECT id,parent_id,kind,"+modeColumn(db)+",status,archived_at FROM tasks WHERE id=?");
 let current=q.get(Number(id)),depth=0;const ids=[],closed=[],seen=new Set();
 if(!current)return {valid:false,reason:"missing_task",depth:0,root:null,ids};
 const mode=current.tree_mode;
 while(current){
  if(seen.has(current.id))return {valid:false,reason:"cycle",depth,root:null,ids};
  if(depth>HIERARCHICAL_MAX_DEPTH)return {valid:false,reason:"depth_limit",depth,root:null,ids};
  if(!TREE_MODES.includes(current.tree_mode)||current.tree_mode!==mode)return {valid:false,reason:"mixed_tree_mode",depth,root:null,ids};
  if(current.kind==="goal"&&current.parent_id!==null)return {valid:false,reason:"nested_goal",depth,root:null,ids};
  seen.add(current.id);ids.push(Number(current.id));
  if(current.status==="done"||current.archived_at)closed.push(Number(current.id));
  if(current.parent_id===null)return {valid:true,reason:null,depth,root:current,ids,closed,mode};
  current=q.get(Number(current.parent_id));depth++;
 }
 return {valid:false,reason:"missing_parent",depth,root:null,ids};
}
function subtree(db,id){
 const columns="id,parent_id,kind,"+modeColumn(db)+",status,archived_at";
 const start=db.prepare("SELECT "+columns+" FROM tasks WHERE id=?").get(Number(id));
 if(!start)return {valid:false,reason:"missing_task",height:0,ids:[],active:[]};
 const kids=db.prepare("SELECT "+columns+" FROM tasks WHERE parent_id=? ORDER BY id LIMIT "+(MAX_TREE_NODES+1));
 const stack=[{row:start,depth:0}],seen=new Set(),ids=[],active=[];let height=0;
 while(stack.length){
  const {row,depth}=stack.pop();
  if(seen.has(row.id))return {valid:false,reason:"cycle",height,ids,active};
  if(seen.size>=MAX_TREE_NODES)return {valid:false,reason:"size_limit",height,ids,active};
  if(depth>HIERARCHICAL_MAX_DEPTH)return {valid:false,reason:"depth_limit",height,ids,active};
  if(row.kind==="goal"&&row.parent_id!==null)return {valid:false,reason:"nested_goal",height,ids,active};
  if(row.tree_mode!==start.tree_mode)return {valid:false,reason:"mixed_tree_mode",height,ids,active};
  seen.add(row.id);ids.push(Number(row.id));height=Math.max(height,depth);
  if(row.status==="in_progress"&&!row.archived_at)active.push(Number(row.id));
  for(const child of kids.all(row.id)){
   if(stack.length+seen.size>=MAX_TREE_NODES)return {valid:false,reason:"size_limit",height,ids,active};
   stack.push({row:child,depth:depth+1});
  }
 }
 return {valid:true,reason:null,height,ids,active,mode:start.tree_mode};
}
function placement(db,{id,parentId}){
 const current=ancestry(db,id),branch=subtree(db,id);
 if(!current.valid)return current;if(!branch.valid)return branch;
 if(branch.active.length)return {...branch,valid:false,reason:"active_subtree"};
 if(parentId===null)return {...branch,depth:0};
 const target=ancestry(db,parentId);
 if(!target.valid)return target;
 if(target.mode==="hierarchical"&&target.closed.length)return {...target,valid:false,reason:"closed_parent"};
 if(branch.ids.includes(Number(parentId)))return {...branch,valid:false,reason:"cycle"};
 if(target.mode!==branch.mode)return {...branch,valid:false,reason:"mixed_tree_mode"};
 const depth=target.depth+1;
 if(branch.mode==="hierarchical"&&depth+branch.height>HIERARCHICAL_MAX_DEPTH)return {...branch,valid:false,reason:"subtree_depth_limit"};
 return {...branch,depth};
}
function claimable(db,id){const chain=ancestry(db,id);return chain.valid&&(chain.mode!=="hierarchical"||chain.closed.length===0);}
module.exports={claimable,TREE_MODES,HIERARCHICAL_MAX_DEPTH,MAX_TREE_NODES,ancestry,subtree,placement};