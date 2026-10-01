import {execFileSync} from "node:child_process";
import {join} from "node:path";
function invoke(path,operation){
 const code=`$ErrorActionPreference='Stop'
 $PSModuleAutoLoadingPreference='None'
 $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
 $item=if([IO.Directory]::Exists($p)){[IO.DirectoryInfo]::new($p)}else{[IO.FileInfo]::new($p)}
 ${operation}`;
 return execFileSync(join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")],{input:Buffer.from(path,"utf8").toString("base64"),encoding:"utf8",env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),windowsHide:true,timeout:10000,stdio:["pipe","pipe","pipe"]}).trim();
}
export function allowInheritedRead(path){invoke(path,`$acl=$item.GetAccessControl()
 $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
 $rule=[Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
 $item.SetAccessControl($acl)`);}
export function inspectAcl(path){
 const lines=invoke(path,`$acl=$item.GetAccessControl()
 [Console]::Out.WriteLine([string]::Join('|',@($acl.AreAccessRulesProtected.ToString(),$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)))
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   [Console]::Out.WriteLine([string]::Join('|',@($rule.IdentityReference.Value,$rule.IsInherited.ToString(),([int]$rule.FileSystemRights).ToString(),$rule.AccessControlType.ToString())))
 }`).split(/\r?\n/);
 const boolean=v=>{if(!['True','False'].includes(v))throw Error('Invalid ACL boolean');return v==='True';};
 const [protectedValue,owner,current]=lines.shift().split('|');
 return {protected:boolean(protectedValue),owner,current,rules:lines.map(line=>{const [sid,inherited,rights,type]=line.split('|');return {sid,inherited:boolean(inherited),rights:Number(rights),type};})};
}
