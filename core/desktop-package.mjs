// Fixed public-file allowlist. Does not inspect credentials or copy a working directory.
import {existsSync,lstatSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {crc32,deflateRawSync} from 'node:zlib';
import {checkDirectoryPath} from './private-directory.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const FILES={
 'manifest.json':'packaging/desktop/manifest.json','package.json':'packaging/desktop/bundle-package.json','README.md':'packaging/desktop/README.md','LICENSE':'LICENSE','preflight.ps1':'packaging/desktop/preflight.ps1',
 'cli/mcp.mjs':'cli/mcp.mjs','cli/desktop-check.mjs':'cli/desktop-check.mjs','core/mcp/stdio.mjs':'core/mcp/stdio.mjs','core/mcp/credential.mjs':'core/mcp/credential.mjs','core/federation/protocol.mjs':'core/federation/protocol.mjs'
};
const hash=b=>createHash('sha256').update(b).digest('hex');
// ZIP 2.0, PKWARE APPNOTE 4.3.7/4.3.12/4.3.16. Only our bounded public snapshot.
// Compression and CRC use Node's built-in zlib; no shell, stdin or extra runtime.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// ⚠ 2026-09-30: the PowerShell child this replaced hit spawnSync's 30 s budget on three consecutive
//   Windows CI runs after passing once. The precise stall was not reproduced locally.
//   The build spawns nothing now; tests/desktop-archivetest.mjs pins that.
export function archiveSnapshot(entries){
 if(entries.length>32)throw Error('Desktop archive file limit exceeded');
 const locals=[],directory=[],seen=new Set();let offset=0,total=0;
 for(const {path,bytes} of [...entries].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){
  if(typeof path!=='string'||path.startsWith('/')||/[\\:\0]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(path.toLowerCase()))throw Error('Invalid desktop archive entry');
  seen.add(path.toLowerCase());const name=Buffer.from(path,'utf8');total+=bytes.length;
  if(name.length>1024||bytes.length>1024*1024||total>16*1024*1024)throw Error('Desktop archive size limit exceeded');
  const compressed=bytes.length?deflateRawSync(bytes,{level:9}):Buffer.alloc(0),method=bytes.length?8:0,checksum=crc32(bytes);
  const local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);
  local.writeUInt16LE(0x5021,12); // 2020-01-01 00:00:00, independent of host timezone.
  local.writeUInt32LE(checksum,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);
  local.copy(central,6,4,30); // Matching version, flags, method, date, checksum, sizes and name/extra lengths.
  central.writeUInt32LE(offset,42);
  locals.push(local,name,compressed);directory.push(central,name);offset+=local.length+name.length+compressed.length;
 }
 const centralBytes=Buffer.concat(directory),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,centralBytes,end]);
}
export function buildDesktopPackage(output){
 if(process.platform!=='win32')throw Error('Desktop kit packaging requires Windows');output=checkDirectoryPath(output);if(existsSync(output))throw Error('Output must be a new directory');
 const inputs=Object.entries(FILES).map(([path,source])=>{const full=join(ROOT,source),st=lstatSync(full);if(st.isSymbolicLink()||!st.isFile()||st.size>1024*1024)throw Error('Invalid package source '+source);return {path,source,bytes:Buffer.from(readFileSync(full,'utf8').replace(/\r\n/g,'\n'),'utf8')};});
 const manifest=JSON.parse(inputs.find(x=>x.path==='manifest.json').bytes);if(manifest.manifest_version!=='0.3'||manifest.server.entry_point!=='cli/mcp.mjs'||JSON.stringify(manifest.compatibility.platforms)!=='["win32"]')throw Error('Unexpected desktop manifest');
 mkdirSync(output);writeFileSync(join(output,'.incomplete'),'desktop package build in progress\n',{flag:'wx'});const bundle=join(output,'bundle');mkdirSync(bundle);
 for(const f of inputs){const dest=join(bundle,f.path);if(relative(bundle,resolve(dest)).startsWith('..'))throw Error('Invalid package path');mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,f.bytes,{flag:'wx'});}
 const inventory={format:'ai-fleet-desktop-package/v1',version:manifest.version,files:inputs.map(f=>({path:f.path,source:f.source,bytes:f.bytes.length,sha256:hash(f.bytes)}))},inventoryBytes=Buffer.from(JSON.stringify(inventory,null,2)+'\n','utf8');
 writeFileSync(join(bundle,'FILES.json'),inventoryBytes,{flag:'wx'});
 const zip=join(output,'ai-fleet-board.mcpb');
 writeFileSync(zip,archiveSnapshot([...inputs,{path:'FILES.json',bytes:inventoryBytes}]),{flag:'wx',flush:true});
 const receipt={format:'ai-fleet-desktop-package-receipt/v1',version:manifest.version,archive:'ai-fleet-board.mcpb',sha256:hash(readFileSync(zip)),bytes:lstatSync(zip).size,files:inputs.length+1,signed:false,contains_credentials:false,desktop_installation_verified:false};writeFileSync(join(output,'RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});unlinkSync(join(output,'.incomplete'));return {...receipt,output};
}
