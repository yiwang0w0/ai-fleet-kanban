# Invoked with a fixed encoded command. Destination and secret bytes arrive only on stdin.
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$credentialStream = $null
$credentialCreated = $false
$credentialPath = $null
try {
    # Two base64 fields separated by a character outside the base64 alphabet.
    # Use only .NET calls; avoid cmdlet/module resolution in the minimal environment.
    $fields = ([Console]::In.ReadToEnd()).Split([char]124)
    if ($fields.Length -ne 2) { throw 'Invalid credential frame' }
    $credentialPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fields[0]))
    $credentialBytes = [Convert]::FromBase64String($fields[1])
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetOwner($ownerSid)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    # CreateNew + supplied security descriptor is one native creation operation.
    # Share.None prevents another handle from opening until verification and flush finish.
    $credentialStream = [IO.FileStream]::new($credentialPath, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
    $credentialCreated = $true
    $actual = $credentialStream.GetAccessControl()
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $ownerSid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unverified credential ACL' }
    $credentialStream.Write($credentialBytes, 0, $credentialBytes.Length)
    $credentialStream.Flush($true)
    $credentialStream.Dispose()
    $credentialStream = $null
    [Console]::Out.WriteLine('PRIVATE_FILE_OK')
    exit 0
} catch {
    $nativeException = $_.Exception
    while ($nativeException.InnerException) { $nativeException = $nativeException.InnerException }
    $nativeCode = $nativeException.HResult -band 65535
    if ($credentialStream) { $credentialStream.Dispose() }
    if ($credentialCreated) { try { [IO.File]::Delete($credentialPath) } catch {} }
    if (-not $credentialCreated -and ($nativeCode -eq 80 -or $nativeCode -eq 183)) {
        [Console]::Out.WriteLine('PRIVATE_FILE_EXISTS')
        exit 2
    }
    [Console]::Out.WriteLine('PRIVATE_FILE_FAILED')
    exit 1
}
