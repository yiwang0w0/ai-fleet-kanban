[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Validate','Install','Enable','Disable','Start','Status','Remove','Run')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Bundle,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Digest
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Set-StrictMode -Version Latest
function Hash-File([string]$File) {
  $item=Get-Item -LiteralPath $File -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'STARTUP_INPUT_CHANGED' }
  $stream=[IO.File]::OpenRead($File)
  $hasher=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $hasher.Dispose();$stream.Dispose() }
}
function Write-Result($Value) { $Value | ConvertTo-Json -Compress -Depth 8 }
function Verify-Pin($Pin) { if((Hash-File $Pin.path) -cne $Pin.sha256) { throw 'STARTUP_INPUT_CHANGED' } }
function Invoke-Check([string]$Command) {
  $priorPreference=$ErrorActionPreference
  try {
    # Windows PowerShell surfaces native stderr warnings as ErrorRecords; the exit code decides success.
    $ErrorActionPreference='Continue'
    $answer=& $script:manifest.node.path $script:manifest.launcher.path $Command --bundle $Bundle --digest $Digest 2>$null
    $nativeExit=$LASTEXITCODE
  } finally { $ErrorActionPreference=$priorPreference }
  if($nativeExit -ne 0) { throw 'STARTUP_INPUT_CHANGED' }
  $result=$answer | ConvertFrom-Json
  if(-not $result.verified) { throw 'STARTUP_INPUT_CHANGED' }
}
function Normalize-Definition($Definition) {
  # Windows may reformat XML. Compare its normalized full definition, allowing only Enabled to change.
  $copy=$script:service.NewTask(0)
  $copy.XmlText=$Definition.XmlText
  $copy.Settings.Enabled=$false
  $doc=[xml]$copy.XmlText
  return $doc.OuterXml
}
function Find-Task {
  try { return $script:folder.GetTask($script:manifest.task_name) }
  catch { if(($_.Exception.HResult -band 0xffff) -eq 2) { return $null }; throw }
}
function Owned-Task {
  $task=Find-Task
  if($null -eq $task) { throw 'STARTUP_TASK_MISSING' }
  if((Normalize-Definition $task.Definition) -cne (Normalize-Definition $script:definition)) { throw 'STARTUP_TASK_CHANGED' }
  return $task
}
try {
  if(-not [IO.Path]::IsPathRooted($Bundle)) { throw 'STARTUP_BAD_PATH' }
  $file=Join-Path $Bundle 'STARTUP.json'
  if((Hash-File $file) -cne $Digest) { throw 'STARTUP_REVIEW_CHANGED' }
  $script:manifest=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) | ConvertFrom-Json
  if($manifest.format -cne 'ai-fleet-node-startup/v1' -or $manifest.directory -cne $Bundle -or $manifest.user_sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'STARTUP_BINDING_CHANGED' }
  foreach($pin in @($manifest.node,$manifest.wrapper,$manifest.launcher)) { Verify-Pin $pin }
  if([IO.Path]::GetFullPath($PSCommandPath) -ine $manifest.wrapper.path) { throw 'STARTUP_BINDING_CHANGED' }
  # Only this process environment changes; never registry/global environment. Avoid Node preload injection.
  $env:NODE_OPTIONS=$null
  $env:NODE_PATH=$null
  Invoke-Check 'inspect'
  if($Action -in @('Validate','Install','Enable','Start','Run')) { Invoke-Check 'check' }
  if($Action -eq 'Run') {
    $argv=@('"'+$manifest.launcher.path+'"','run','--bundle','"'+$Bundle+'"','--digest',$Digest)
    $child=Start-Process -FilePath $manifest.node.path -ArgumentList $argv -WorkingDirectory $manifest.source_root -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    exit $child.ExitCode
  }
  $script:service=New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $script:folder=$service.GetFolder('\')
  $xml=[IO.File]::ReadAllText((Join-Path $Bundle 'task.xml'),[Text.Encoding]::UTF8)
  $script:definition=$service.NewTask(0)
  $definition.XmlText=$xml
  if($Action -eq 'Validate') {
    # TASK_VALIDATE_ONLY=1 checks real Task Scheduler syntax without creating a task.
    $null=$folder.RegisterTask($manifest.task_name,$xml,1,$manifest.user_sid,$null,3,$null)
    Write-Result @{format='ai-fleet-node-startup-action/v1';action=$Action;validated=$true;configuration_changed=$false;task_name=$manifest.task_name}
  } elseif($Action -eq 'Install') {
    if($null -ne (Find-Task)) { throw 'STARTUP_TASK_EXISTS' }
    # TASK_CREATE=2 only; no update/force. XML starts disabled and has no registration trigger.
    $null=$folder.RegisterTask($manifest.task_name,$xml,2,$manifest.user_sid,$null,3,$null)
    $task=Owned-Task
    if($task.Enabled) { throw 'STARTUP_TASK_CHANGED' }
    Write-Result @{format='ai-fleet-node-startup-action/v1';action=$Action;registered=$true;enabled=$false;started=$false;task_name=$manifest.task_name}
  } elseif($Action -eq 'Status') {
    $task=Find-Task
    if($null -eq $task) { Write-Result @{format='ai-fleet-node-startup-action/v1';action=$Action;registered=$false;task_name=$manifest.task_name} }
    else { $task=Owned-Task;Write-Result @{format='ai-fleet-node-startup-action/v1';action=$Action;registered=$true;enabled=[bool]$task.Enabled;scheduler_state=[int]$task.State;running_instances=$task.GetInstances(0).Count;last_result=$task.LastTaskResult;process_liveness='not_checked';task_name=$manifest.task_name} }
  } else {
    $task=Owned-Task
    if($Action -eq 'Enable') { $task.Enabled=$true }
    elseif($Action -eq 'Disable') { $task.Enabled=$false }
    elseif($Action -eq 'Start') { if(-not $task.Enabled) { throw 'STARTUP_TASK_DISABLED' };$null=$task.Run($null) }
    elseif($Action -eq 'Remove') {
      if($task.Enabled -or $task.GetInstances(0).Count -ne 0) { throw 'STARTUP_TASK_ACTIVE' }
      $folder.DeleteTask($manifest.task_name,0)
    }
    Write-Result @{format='ai-fleet-node-startup-action/v1';action=$Action;task_name=$manifest.task_name;process_stop_confirmed=$false}
  }
} catch {
  $code=if($_.Exception.Message -match '^STARTUP_[A-Z_]+$') { $_.Exception.Message } else { 'STARTUP_ACTION_FAILED' }
  Write-Result @{status='failed';code=$code;action=$Action;message='Inspect the exact task and bundle. No automatic takeover or process kill is performed.'}
  exit 1
}
