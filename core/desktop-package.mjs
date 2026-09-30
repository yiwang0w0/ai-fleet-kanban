// Fixed public-file allowlist. Does not inspect credentials or copy a working directory.
import {existsSync,lstatSync,readFileSync,writeFileSync,mkdirSync,unlinkSync,readdirSync} from 'node:fs';
import {dirname,join,isAbsolute,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {checkDirectoryPath} from './private-directory.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const FILES={
 'manifest.json':'packaging/desktop/manifest.json','package.json':'packaging/desktop/bundle-package.json','README.md':'packaging/desktop/README.md','LICENSE':'LICENSE','preflight.ps1':'packaging/desktop/preflight.ps1',
 'cli/mcp.mjs':'cli/mcp.mjs','cli/desktop-check.mjs':'cli/desktop-check.mjs','core/mcp/stdio.mjs':'core/mcp/stdio.mjs','core/mcp/credential.mjs':'core/mcp/credential.mjs','core/federation/protocol.mjs':'core/federation/protocol.mjs'
};
const hash=b=>createHash('sha256').update(b).digest('hex');
const zipScript=String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$inputObject=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))|ConvertFrom-Json
$source=[IO.Path]::GetFullPath($inputObject.source)
$stream=[IO.File]::Open($inputObject.output,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
 $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
 try { foreach($name in $inputObject.files) {
  $path=[IO.Path]::GetFullPath([IO.Path]::Combine($source,$name))
  if(-not $path.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid archive path'}
  $entry=$zip.CreateEntry($name,[IO.Compression.CompressionLevel]::Optimal)
  $entry.LastWriteTime=[DateTimeOffset]::new(2020,1,1,0,0,0,[TimeSpan]::Zero)
  $inputStream=[IO.File]::OpenRead($path);$outputStream=$entry.Open()
  try{$inputStream.CopyTo($outputStream)}finally{$outputStream.Dispose();$inputStream.Dispose()}
 } } finally { $zip.Dispose() }
 $stream.Flush($true)
} finally { $stream.Dispose() }
[Console]::Out.Write('MCPB_ARCHIVE_OK')`;
export function buildDesktopPackage(output){
 if(process.platform!=='win32')throw Error('Desktop kit packaging requires Windows');output=checkDirectoryPath(output);if(existsSync(output))throw Error('Output must be a new directory');
 const inputs=Object.entries(FILES).map(([path,source])=>{const full=join(ROOT,source),st=lstatSync(full);if(st.isSymbolicLink()||!st.isFile()||st.size>1024*1024)throw Error('Invalid package source '+source);return {path,source,bytes:Buffer.from(readFileSync(full,'utf8').replace(/\r\n/g,'\n'),'utf8')};});
 const manifest=JSON.parse(inputs.find(x=>x.path==='manifest.json').bytes);if(manifest.manifest_version!=='0.3'||manifest.server.entry_point!=='cli/mcp.mjs'||JSON.stringify(manifest.compatibility.platforms)!=='["win32"]')throw Error('Unexpected desktop manifest');
 mkdirSync(output);writeFileSync(join(output,'.incomplete'),'desktop package build in progress\n',{flag:'wx'});const bundle=join(output,'bundle');mkdirSync(bundle);
 for(const f of inputs){const dest=join(bundle,f.path);if(relative(bundle,resolve(dest)).startsWith('..'))throw Error('Invalid package path');mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,f.bytes,{flag:'wx'});}
 const inventory={format:'ai-fleet-desktop-package/v1',version:manifest.version,files:inputs.map(f=>({path:f.path,source:f.source,bytes:f.bytes.length,sha256:hash(f.bytes)}))};writeFileSync(join(bundle,'FILES.json'),JSON.stringify(inventory,null,2)+'\n',{flag:'wx'});
 const systemRoot=process.env.SystemRoot;if(!systemRoot||!isAbsolute(systemRoot))throw Error('Windows runtime unavailable');const zip=join(output,'ai-fleet-board.mcpb'),env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp'].includes(k.toLowerCase())));
 const result=spawnSync(join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(zipScript,'utf16le').toString('base64')],{input:Buffer.from(JSON.stringify({source:bundle,output:zip,files:[...Object.keys(FILES),'FILES.json'].sort()}),'utf8').toString('base64'),env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:32768});
 if(result.status!==0||result.stdout.trim()!=='MCPB_ARCHIVE_OK')throw Error('MCPB archive creation failed; output remains incomplete: '+(result.error?.code??result.stderr.trim().slice(0,1600)));
 const receipt={format:'ai-fleet-desktop-package-receipt/v1',version:manifest.version,archive:'ai-fleet-board.mcpb',sha256:hash(readFileSync(zip)),bytes:lstatSync(zip).size,files:inputs.length+1,signed:false,contains_credentials:false,desktop_installation_verified:false};writeFileSync(join(output,'RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});unlinkSync(join(output,'.incomplete'));return {...receipt,output};
}
