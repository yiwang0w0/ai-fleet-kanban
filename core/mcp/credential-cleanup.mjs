// Local credential disposal. The Windows helper verifies and deletes the same locked file handle.
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {isAbsolute,join} from "node:path";
const script=readFileSync(new URL("./credential-cleanup.ps1",import.meta.url),"utf8");
const encoded=Buffer.from(script,"utf16le").toString("base64");
const statuses=new Set(["deleted","missing","changed","busy","unavailable"]);
export function removePrivateCredential(file,sha256){
 if(process.platform!=="win32"||typeof file!=="string"||!isAbsolute(file)||!/^[a-z]:[\\/]/i.test(file)||file.slice(2).includes(":")||file.includes("\0")||!/^[a-f0-9]{64}$/.test(sha256))return "unavailable";
 const root=process.env.SystemRoot;if(!root||!isAbsolute(root))return "unavailable";
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase())));
 const r=spawnSync(join(root,"System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",encoded],{
  input:Buffer.from(file,"utf8").toString("base64")+"|"+sha256,env,windowsHide:true,timeout:30000,maxBuffer:16384,encoding:"utf8",stdio:["pipe","pipe","pipe"]});
 const status=r.stdout?.trim();
 return r.status===0&&statuses.has(status)?status:"unavailable";
}
