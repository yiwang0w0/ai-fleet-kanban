// desktop-archivetest — the MCPB ZIP writer pinned on its own, on any OS.
//
// Why this harness exists: the desktop package build used to hand the ZIP to a
// powershell.exe child with a 30 s spawnSync budget. On 2026-09-30 the same code
// passed once on the Windows runner (run 36732624623, step 59 s) and then hit
// ETIMEDOUT at exactly 30.07 s on three consecutive runs (36736332384,
// 36742251129, 36745725816) with no change to the packaging files. The precise
// stall was not reproduced locally; a cold start is only a hypothesis. The build
// now writes the archive with node:zlib and spawns nothing. This file keeps that
// true (source pin), and checks the writer's bytes with an independent decoder
// (Python zipfile), its determinism, and its fail-closed bounds. It needs no
// Windows, so it runs wherever `node` and `python` exist.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {archiveSnapshot} from "../core/desktop-package.mjs";

const ROOT=fileURLToPath(new URL("../",import.meta.url));
const sha256=b=>createHash("sha256").update(b).digest("hex");
const PY=process.env.PYTHON||"python";
const DECODE=[
 "import sys,zipfile,json,hashlib",
 "with zipfile.ZipFile(sys.argv[1]) as z:",
 "    bad=z.testzip()",
 "    rows=[{'path':i.filename,'bytes':i.file_size,'method':i.compress_type,'date':list(i.date_time),",
 "           'utf8':bool(i.flag_bits & 0x800),'extra':len(i.extra),'comment':len(i.comment),",
 "           'sha256':hashlib.sha256(z.read(i.filename)).hexdigest()} for i in z.infolist()]",
 "print(json.dumps({'bad':bad,'rows':rows}))",
].join("\n");

const ENTRIES=[
 {path:"manifest.json",bytes:Buffer.from('{"manifest_version":"0.3"}\n')},
 {path:"core/mcp/stdio.mjs",bytes:Buffer.from("export const x=1;\n".repeat(400))},
 {path:"FILES.json",bytes:Buffer.from("{}\n")},
 {path:"empty.txt",bytes:Buffer.alloc(0)},                       // stored (method 0) branch
 {path:"docs/说明 & 备注.md",bytes:Buffer.from("# 说明\n")},        // UTF-8 name, space, ampersand
];

test("Python zipfile decodes the writer's bytes: sorted entries, byte-identical content, fixed date, UTF-8 flag",()=>{
 const tmp=mkdtempSync(join(tmpdir(),"fleet-desktop-archive-")),zip=join(tmp,"snapshot.mcpb");
 try{
  writeFileSync(zip,archiveSnapshot(ENTRIES),{flag:"wx"});
  const r=spawnSync(PY,["-c",DECODE,zip],{encoding:"utf8",windowsHide:true,maxBuffer:1024*1024,timeout:10000});
  assert.equal(r.status,0,r.stderr);
  const {bad,rows}=JSON.parse(r.stdout);
  assert.equal(bad,null,"testzip found a bad CRC or header");
  const expected=[...ENTRIES].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  assert.deepEqual(rows.map(x=>x.path),expected.map(x=>x.path));
  for(const [i,row] of rows.entries()){
   assert.equal(row.bytes,expected[i].bytes.length);
   assert.equal(row.sha256,sha256(expected[i].bytes));
   assert.equal(row.method,expected[i].bytes.length?8:0);
   assert.deepEqual(row.date,[2020,1,1,0,0,0]);
   assert.equal(row.utf8,true);assert.equal(row.extra,0);assert.equal(row.comment,0);
  }
 }finally{assert.equal(dirname(resolve(tmp)),resolve(tmpdir()));assert.match(tmp,/fleet-desktop-archive-/);rmSync(tmp,{recursive:true,force:true});}
});

test("same entries in any input order produce identical bytes",()=>{
 const a=archiveSnapshot(ENTRIES),b=archiveSnapshot([...ENTRIES].reverse());
 assert.equal(a.length,b.length);assert.equal(sha256(a),sha256(b));
 assert.equal(a.readUInt32LE(0),0x04034b50);assert.equal(a.readUInt32LE(a.length-22),0x06054b50);
 assert.equal(a.readUInt16LE(a.length-22+10),ENTRIES.length);
});

test("unsafe or duplicate entry paths are refused (fail-closed)",()=>{
 const one=[{path:"ok.txt",bytes:Buffer.from("x")}];
 for(const path of ["/abs.txt","a\\b.txt","c:x.txt","a\0b","a//b","./a","a/../b","",42])
  assert.throws(()=>archiveSnapshot([...one,{path,bytes:Buffer.from("x")}]),/Invalid desktop archive entry/,String(path));
 assert.throws(()=>archiveSnapshot([...one,{path:"OK.txt",bytes:Buffer.from("y")}]),/Invalid desktop archive entry/,"case-insensitive duplicate");
});

test("size and count bounds are refused before any bytes are produced",()=>{
 const many=Array.from({length:33},(_,i)=>({path:"f"+i+".txt",bytes:Buffer.from("x")}));
 assert.throws(()=>archiveSnapshot(many),/file limit/);
 assert.throws(()=>archiveSnapshot([{path:"big.bin",bytes:Buffer.alloc(1024*1024+1)}]),/size limit/);
 assert.throws(()=>archiveSnapshot([{path:"n".repeat(1025),bytes:Buffer.from("x")}]),/size limit/);
 const mib=Buffer.alloc(1024*1024);
 assert.throws(()=>archiveSnapshot(Array.from({length:17},(_,i)=>({path:"p"+i,bytes:mib}))),/size limit/);
 assert.equal(archiveSnapshot(Array.from({length:16},(_,i)=>({path:"p"+i,bytes:mib}))).readUInt32LE(0),0x04034b50);
});

test("the build path spawns nothing: no child_process import, no spawn/exec call in core/desktop-package.mjs",()=>{
 const src=readFileSync(join(ROOT,"core","desktop-package.mjs"),"utf8");
 assert.doesNotMatch(src,/child_process/);
 assert.doesNotMatch(src,/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/);
 assert.match(src,/from ['"]node:zlib['"]/);
});
