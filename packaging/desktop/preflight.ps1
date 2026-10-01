param(
  [string]$NodePath='',
  [string]$GitPath='',
  [string]$TailscalePath='',
  [string]$BrokerUrl='',
  [string]$CredentialFile=''
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Find-Program([string]$Requested,[string]$Name,[string]$Fallback) {
  if($Requested){ if([IO.Path]::IsPathRooted($Requested) -and [IO.File]::Exists($Requested) -and [IO.Path]::GetFileName($Requested) -ieq $Name){return [IO.Path]::GetFullPath($Requested)};return $null }
  $command=Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if($command){return $command.Source}
  if($Fallback -and [IO.File]::Exists($Fallback)){return $Fallback}
  return $null
}
function Quote-Argument([string]$Value) {
  $builder=[Text.StringBuilder]::new();[void]$builder.Append([char]34);$slashes=0
  foreach($character in $Value.ToCharArray()) {
    if([int]$character -eq 92){$slashes++;continue}
    if([int]$character -eq 34){[void]$builder.Append([char]92,($slashes*2+1));[void]$builder.Append([char]34)}
    else{[void]$builder.Append([char]92,$slashes);[void]$builder.Append($character)}
    $slashes=0
  }
  [void]$builder.Append([char]92,($slashes*2));[void]$builder.Append([char]34)
  return $builder.ToString()
}
function Invoke-Probe([string]$Executable,[string[]]$ArgumentValues,[int]$Timeout=10000) {
  if(-not $Executable){return @{status='not_found'}}
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$Executable
  $start.Arguments=([string[]]@($ArgumentValues|ForEach-Object {Quote-Argument $_})) -join ' '
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $proc=[Diagnostics.Process]::new();$proc.StartInfo=$start
  try {
    if(-not $proc.Start()){return @{status='start_failed'}}
    $stdout=$proc.StandardOutput.ReadToEndAsync();$stderr=$proc.StandardError.ReadToEndAsync()
    if(-not $proc.WaitForExit($Timeout)){try{$proc.Kill()}catch{};$proc.WaitForExit();return @{status='timeout'}}
    $out=$stdout.GetAwaiter().GetResult();[void]$stderr.GetAwaiter().GetResult()
    if($out.Length -gt 1048576){return @{status='output_too_large'}}
    return @{status=if($proc.ExitCode -eq 0){'ok'}else{'failed'};exit_code=$proc.ExitCode;stdout=$out}
  } catch {return @{status='probe_failed'}} finally {$proc.Dispose()}
}
$node=Find-Program $NodePath 'node.exe' 'C:\Program Files\nodejs\node.exe'
$git=Find-Program $GitPath 'git.exe' 'C:\Program Files\Git\cmd\git.exe'
$tailscale=Find-Program $TailscalePath 'tailscale.exe' 'C:\Program Files\Tailscale\tailscale.exe'
$nv=Invoke-Probe $node @('--version');$gv=Invoke-Probe $git @('--version');$nodeVersion=$null;$gitVersion=$null
if($nv.status -eq 'ok' -and $nv.stdout -match '^v([0-9]+\.[0-9]+\.[0-9]+)'){$nodeVersion=$matches[1]}
if($gv.status -eq 'ok' -and $gv.stdout -match '^git version ([0-9]+\.[0-9]+\.[0-9]+)'){$gitVersion=$matches[1]}
$sqlite=Invoke-Probe $node @('-e','const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE check_runtime(n)");db.close();console.log("SQLITE_OK")')
$ts=Invoke-Probe $tailscale @('status','--json');$network=@{status=$ts.status;peer_query_verified=$false}
if($ts.status -eq 'ok'){
  try {
    $state=$ts.stdout|ConvertFrom-Json
    $network=@{status=$state.BackendState;peer_query_verified=$true;self=@{node_id=$state.Self.ID;hostname=$state.Self.HostName;os=$state.Self.OS;online=$state.Self.Online};windows_peers=@($state.Peer.PSObject.Properties.Value|Where-Object {$_.OS -eq 'windows'}|Select-Object @{Name='node_id';Expression={$_.ID}},@{Name='hostname';Expression={$_.HostName}},@{Name='online';Expression={$_.Online}})}
  } catch {$network=@{status='invalid_response';peer_query_verified=$false}}
}
$connection=@{status='not_requested';actual_desktop_client_verified=$false}
if($BrokerUrl -or $CredentialFile){
  if(-not $BrokerUrl -or -not $CredentialFile){$connection=@{status='both_broker_and_credential_required'}}
  elseif(-not $nodeVersion -or [version]$nodeVersion -lt [version]'24.0.0'){$connection=@{status='node_24_required'}}
  else {
    $probe=Invoke-Probe $node @(([IO.Path]::Combine($PSScriptRoot,'cli','desktop-check.mjs')),'--url',$BrokerUrl,'--credential-file',$CredentialFile) 40000
    if($probe.status -eq 'ok'){try{$connection=$probe.stdout|ConvertFrom-Json}catch{$connection=@{status='invalid_response'}}}else{$connection=@{status=$probe.status;actual_desktop_client_verified=$false}}
  }
}
$report=[ordered]@{
  format='ai-fleet-windows-preflight/v1';checked_at=[DateTime]::UtcNow.ToString('o');machine=$env:COMPUTERNAME;platform='win32'
  node=@{path=$node;version=$nodeVersion;supported=($nodeVersion -and [version]$nodeVersion -ge [version]'24.0.0');sqlite_available=($sqlite.status -eq 'ok' -and $sqlite.stdout.Trim() -eq 'SQLITE_OK')}
  git=@{path=$git;version=$gitVersion;supported=($gitVersion -and [version]$gitVersion -ge [version]'2.45.0')}
  tailscale=$network;desktop_connection=$connection
  providers_called=$false;configuration_changed=$false;real_multi_pc_acceptance=$false
}
$report|ConvertTo-Json -Depth 8
