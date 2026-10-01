import {federationStuck,dispatchStale} from '../core/inspection.mjs';
import {evidenceFixture,addEvidenceHistory} from './helpers/fleet-evidence-fixture.mjs';
import {migrateCompletion} from '../core/federation/completion.mjs';
import {migrateDispatch} from '../core/execution/dispatch.mjs';
import {migratePeers} from '../core/federation/peers.mjs';
import {migrateBroker} from '../core/mcp/policy.mjs';
import test,{after} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
const store=createRequire(import.meta.url)("../core/store.js"),ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"fleet-inspect-")),dbs=[];let serial=0;
after(()=>{for(const db of dbs)db.close();const rel=relative(resolve(tmpdir()),resolve(TMP));assert.ok(rel&&!rel.startsWith(".."));rmSync(TMP,{recursive:true,force:true});});
function fixture(){const path=join(TMP,"board-"+serial+++".db"),db=new DatabaseSync(path);dbs.push(db);store.migrate(db);return {db,path};}
const sha=p=>createHash("sha256").update(readFileSync(p)).digest("hex");
const cli=(file,args)=>spawnSync(process.execPath,[join(ROOT,"cli",file),...args],{encoding:"utf8",windowsHide:true,timeout:15000});
for(const [file,command,format] of [["federation.mjs","stuck","ai-fleet-federation-stuck/v1"],["dispatch.mjs","stale","ai-fleet-dispatch-stale/v1"]]){
 test("H3 read-only "+command+" CLI inspects an initialized local board without adding protocol schemas",()=>{
  const f=fixture(),before=sha(f.path),schema=f.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
  const r=cli(file,[command,"--db",f.path]);assert.equal(r.status,0,r.stderr);
  const out=JSON.parse(r.stdout);assert.equal(out.format,format);assert.deepEqual(out.items,[]);assert.equal(out.total,0);assert.equal(out.state_changes,false);
  assert.equal(sha(f.path),before);assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),schema);
 });
}

function populated(){const path=join(TMP,'history-'+serial+++'.db'),f=evidenceFixture(path);dbs.push(f.db);migrateCompletion(f.db);migrateDispatch(f.db);return {...f,path};}
function attempt(f,{relation=f.relationId,action='approve',state='pending',created=f.now}={}){
 const id=randomUUID();f.db.prepare('INSERT INTO binding_attempts VALUES(?,?,?,?,?,?,?,?)').run(id,relation,action,'{"secret":"PRIVATE-ARGS"}',state,null,'PRIVATE-ERROR',created);return id;
}
test('H3 inventory reads pending binding actions without private payloads or any database writes',()=>{
 const f=populated(),id=attempt(f),before=sha(f.path);f.db.exec('PRAGMA query_only=ON');
 const out=federationStuck(f.db,{projectId:'demo'});assert.equal(out.total,1);assert.equal(out.items[0].record_id,id);assert.equal(out.items[0].action,'approve');assert.equal(out.items[0].identity_current,true);assert.equal(out.process_liveness,'not_checked');assert.equal(out.remote_state,'not_queried');
 assert.doesNotMatch(JSON.stringify(out),/PRIVATE-|secret|CONTRACT|alpha|source_path/);assert.equal(sha(f.path),before);
 const r=cli('federation.mjs',['stuck','--db',f.path,'--project','demo']);assert.equal(r.status,2,r.stderr);assert.equal(JSON.parse(r.stdout).total,1);assert.equal(sha(f.path),before);
 f.db.exec('PRAGMA query_only=OFF');f.db.prepare("UPDATE binding_attempts SET state='acknowledged' WHERE request_id=?").run(id);assert.equal(federationStuck(f.db).total,0);
 const withdraw=attempt(f,{action:'withdraw'});assert.equal(federationStuck(f.db).items[0].next_action,'resume_binding_withdraw');f.db.prepare("UPDATE binding_attempts SET state='rejected' WHERE request_id=?").run(withdraw);assert.equal(federationStuck(f.db).total,0);
});
test('H3 snapshot pagination is scoped, stable across read times, and refuses stale cursors',()=>{
 const f=populated();addEvidenceHistory(f,104);
 // Projection-only stored-history fixture. Live lifecycle transitions are tested in the protocol harnesses.
 for(const row of f.db.prepare('SELECT relation_id FROM delegation_bindings').all())attempt(f,{relation:row.relation_id});
 const first=federationStuck(f.db,{limit:50,now:Date.now()}),second=federationStuck(f.db,{limit:50,cursor:first.next_cursor,now:Date.now()+1000}),third=federationStuck(f.db,{limit:50,cursor:second.next_cursor});
 assert.equal(first.total,105);assert.equal(third.next_cursor,null);assert.equal(new Set([...first.items,...second.items,...third.items].map(i=>i.record_id)).size,105);
 assert.equal(federationStuck(f.db,{projectId:'other'}).total,0);
 for(const input of [{limit:51,cursor:first.next_cursor},{projectId:'other',limit:50,cursor:first.next_cursor},{cursor:'bad'},{limit:0},{limit:101},{projectId:'../private'}])assert.throws(()=>federationStuck(f.db,input),{code:'BAD_INPUT'});
 f.db.prepare("UPDATE binding_attempts SET state='rejected' WHERE request_id=?").run(first.items[0].record_id);
 assert.throws(()=>federationStuck(f.db,{limit:50,cursor:first.next_cursor}),{code:'SNAPSHOT_CHANGED'});
});
test('H3 old epochs and future clocks remain visible without suggesting an automatic retry',()=>{
 const f=populated();attempt(f,{created:'2999-01-01T00:00:00Z'});
 // Simulate restored identity; retain the old rows to verify inspection does not use active-epoch getters.
 f.db.exec('DROP TRIGGER IF EXISTS board_node_identity_immutable');
 for(const r of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='board_node'").all())f.db.exec('DROP TRIGGER "'+r.name+'"');
 f.db.prepare('UPDATE board_node SET sync_epoch=?').run(randomUUID());
 const out=federationStuck(f.db);assert.equal(out.total,1);assert.equal(out.items[0].identity_current,false);assert.equal(out.items[0].next_action,'review_epoch_recovery');assert.equal(out.items[0].age_ms,null);assert.equal(out.items[0].clock_unknown,true);
});
test('H3 inspectors preserve caller transactions on success and failure',()=>{
 const f=populated();f.db.exec('BEGIN');attempt(f);assert.equal(federationStuck(f.db).total,1);assert.equal(f.db.isTransaction,true);
 f.db.exec('UPDATE completion_schema SET version=99');assert.throws(()=>federationStuck(f.db),{code:'SCHEMA_INCOMPATIBLE'});assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');assert.equal(federationStuck(f.db).total,0);
});
test('H3 unknown or partial schemas cannot masquerade as an empty healthy inventory',()=>{
 const f=fixture();migratePeers(f.db);migrateBroker(f.db);assert.equal(federationStuck(f.db).modules.binding,'not_configured');assert.equal(dispatchStale(f.db).modules.dispatch,'not_configured');
 f.db.exec('CREATE TABLE binding_attempts(request_id TEXT)');assert.throws(()=>federationStuck(f.db),{code:'SCHEMA_INCOMPATIBLE'});
 const g=populated();g.db.exec('UPDATE broker_dispatch_schema SET version=99');assert.throws(()=>dispatchStale(g.db),{code:'SCHEMA_INCOMPATIBLE'});
 const h=populated();h.db.exec('DROP TABLE completion_ready');assert.throws(()=>federationStuck(h.db),{code:'SCHEMA_INCOMPATIBLE'});
});
test('H3 orphan pending records fail visibly instead of disappearing in inner joins',()=>{
 const f=populated();attempt(f,{relation:randomUUID()});assert.throws(()=>federationStuck(f.db),{code:'RECORD_CORRUPT'});
 const g=populated();g.db.prepare('INSERT INTO completion_registrar_attempts VALUES(?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),'{}','pending',null,null,g.now);assert.throws(()=>federationStuck(g.db),{code:'RECORD_CORRUPT'});
});
test('H3 inspection errors never disclose local paths, arbitrary options or stored errors',()=>{
 const f=populated();f.db.exec('UPDATE completion_schema SET version=99');
 for(const [file,command] of [['federation.mjs','stuck'],['dispatch.mjs','stale']]){
  for(const args of [['--db',join(TMP,'PRIVATE-NONEXISTENT.db')],['--db',f.path,'--limit','PRIVATE-LIMIT'],['--db',f.path,'--PRIVATE-OPTION','PRIVATE-VALUE']]){
   const r=cli(file,[command,...args]);assert.equal(r.status,1);assert.equal(r.stdout,'');const out=JSON.parse(r.stderr.trim().split('\n').find(l=>l.startsWith('{')));assert.equal(out.state_changes,false);assert.doesNotMatch(JSON.stringify(out),/PRIVATE-|fleet-inspect-|board-|history-/);
  }
 }
 const r=cli('federation.mjs',['stuck','--db',f.path]);assert.equal(r.status,1);assert.match(r.stderr,/SCHEMA_INCOMPATIBLE/);
});
test('H3 excessive local history fails explicitly and does not silently truncate completeness',()=>{
 const f=populated();f.db.exec('BEGIN');
 // Same synthetic projection fixture as pagination; the single transaction keeps the bound check inexpensive.
 // The helper opens its own transaction, so clone scalar binding rows here.
 const row=f.db.prepare('SELECT * FROM delegation_bindings LIMIT 1').get(),keys=Object.keys(row),sql='INSERT INTO delegation_bindings('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')',insert=f.db.prepare(sql);
 for(let i=0;i<10001;i++){const r={...row,relation_id:randomUUID(),delegation_id:randomUUID(),state:'cancelled'};insert.run(...keys.map(k=>r[k]));attempt(f,{relation:r.relation_id});}
 f.db.exec('COMMIT');assert.throws(()=>federationStuck(f.db),{code:'INSPECTION_LIMIT'});assert.equal(federationStuck(f.db,{projectId:'other'}).total,0);
});

test('H3 malformed or tampered incoming offers fail visibly without exposing their contents',()=>{
 for(const raw of ['PRIVATE-BROKEN-JSON','{"PRIVATE-OFFER":true}']){
  const f=populated();f.db.prepare('INSERT INTO delegation_incoming(delegation_id,project_id,source_node_id,source_epoch,offer_digest,offer_json,state,version,target_task_id,target_task_uid,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'demo',f.remote,f.remoteEpoch,'0'.repeat(64),raw,'accepted_unconfirmed',2,f.source.id,f.source.task_uid,f.now,f.now);
  assert.throws(()=>federationStuck(f.db),{code:'RECORD_CORRUPT'});
  const r=cli('federation.mjs',['stuck','--db',f.path]);assert.equal(r.status,1);assert.match(r.stderr,/RECORD_CORRUPT/);assert.doesNotMatch(r.stderr,/PRIVATE-|fleet-inspect-/);
 }
});
