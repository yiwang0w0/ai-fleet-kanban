$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
try {
  $inputText = [Console]::In.ReadToEnd()
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputText))
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if (-not [IO.Directory]::Exists($path)) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    [void][IO.Directory]::CreateDirectory($path, $security)
  }
  $directory = [IO.DirectoryInfo]::new($path)
  if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  $actual = $directory.GetAccessControl()
  $rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'ACL' }
  $r = $rules[0]
  if ($r.IdentityReference.Value -ne $sid.Value -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $r.IsInherited -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $r.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $r.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'rule' }
  [Console]::Out.Write('PRIVATE_DIRECTORY_OK')
  exit 0
} catch {
  [Console]::Out.Write('PRIVATE_DIRECTORY_FAILED')
  exit 1
}
