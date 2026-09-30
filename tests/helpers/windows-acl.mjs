import {execFileSync} from "node:child_process";
import {join} from "node:path";
function invoke(path,operation){
 const code=`$ErrorActionPreference='Stop'
 $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
 ${operation}`;
 return execFileSync(join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")],{input:Buffer.from(path,"utf8").toString("base64"),encoding:"utf8",env:Object.fromEntries(Object.entries(process.env).filter(([k])=>["systemroot","windir","temp","tmp"].includes(k.toLowerCase()))),windowsHide:true,timeout:10000,stdio:["pipe","pipe","pipe"]}).trim();
}
export function allowInheritedRead(path){invoke(path,`$acl=Get-Acl -LiteralPath $p
 $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
 $rule=[Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
 Set-Acl -LiteralPath $p -AclObject $acl`);}
export function inspectAcl(path){return JSON.parse(invoke(path,`$acl=Get-Acl -LiteralPath $p
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString()} })
 @{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=$rules} | ConvertTo-Json -Depth 4 -Compress`));}
