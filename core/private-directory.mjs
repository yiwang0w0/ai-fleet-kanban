import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync} from 'node:fs';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {PeerError} from './federation/protocol.mjs';
const encoded=Buffer.from(readFileSync(new URL('./private-directory.ps1',import.meta.url),'utf8').replace(/^\ufeff/,''),'utf16le').toString('base64');
export function checkDirectoryPath(path){
 if(typeof path!=='string'||!isAbsolute(path)||!(/^[a-z]:[\\/]/i.test(path))||path.slice(2).includes(':')||path.includes('\0')||path.split(/[\\/]/).slice(1).some(p=>/^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p)))throw new PeerError('BAD_INPUT','上下文目录必须是本地磁盘普通目录的绝对路径');
 const full=resolve(path);if(dirname(full)===full)throw new PeerError('BAD_INPUT','不能使用磁盘根目录');
 for(let p=full;;p=dirname(p)){if(existsSync(p)){const stat=lstatSync(p);if(stat.isSymbolicLink()||!stat.isDirectory())throw new PeerError('UNSAFE_CONTEXT_ROOT','目录路径包含链接或非目录',409);}if(dirname(p)===p)break;}
 if(!existsSync(dirname(full)))throw new PeerError('BAD_INPUT','上下文目录的父目录必须已存在');return full;
}
// Creates only new directories. An existing permissive ACL is rejected, never changed.
export function privateDirectory(path){
 if(process.platform!=='win32')throw new PeerError('WINDOWS_REQUIRED','上下文目录只支持 Windows',409);
 const full=checkDirectoryPath(path),systemRoot=process.env.SystemRoot;
 if(!systemRoot||!isAbsolute(systemRoot))throw new PeerError('PRIVATE_DIRECTORY_FAILED','Windows 目录保护接口不可用',409);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp'].includes(k.toLowerCase())));
 const result=spawnSync(join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{input:Buffer.from(full,'utf8').toString('base64'),env,windowsHide:true,timeout:10000,maxBuffer:16384,encoding:'utf8',stdio:['pipe','pipe','pipe']});
 if(result.status!==0||result.stdout.trim()!=='PRIVATE_DIRECTORY_OK')throw new PeerError('PRIVATE_DIRECTORY_FAILED','上下文目录须仅由当前 Windows 账户访问；现有宽松目录未被修改',409);
 return full;
}
