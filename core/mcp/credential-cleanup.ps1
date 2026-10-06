# Fixed helper: accepts a local path and the original credential's SHA-256 on stdin.
# Open without sharing and mark this verified handle for deletion; never reopen by path.
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$handle = $null
$stream = $null
$outcome = 'unavailable'
try {
    $fields = ([Console]::In.ReadToEnd()).Split([char]124)
    if ($fields.Length -ne 2 -or $fields[1] -notmatch '^[a-f0-9]{64}$') { throw 'Invalid frame' }
    $file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fields[0]))
    # Reject reparse-point ancestors. The handle/content checks below cover final-component replacement.
    $parent = [IO.Path]::GetDirectoryName($file)
    while ($parent) {
        if (([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse parent' }
        $next = [IO.Path]::GetDirectoryName($parent)
        if ($next -eq $parent) { break }
        $parent = $next
    }
    Import-Module ([IO.Path]::Combine($PSHOME, "Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"))
    Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CredentialDisposal {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
 [StructLayout(LayoutKind.Sequential)] public struct Attributes { public uint attributes; public uint tag; }
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, out Attributes info, uint size);
 [StructLayout(LayoutKind.Sequential)] public struct Disposition { public byte delete; }
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass, ref Disposition info, uint size);
}
"@
    $handle = [CredentialDisposal]::CreateFileW($file, [uint32]2147549184, 0, [IntPtr]::Zero, 3, [uint32]2097280, [IntPtr]::Zero)
    if ($handle.IsInvalid) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -eq 2 -or $code -eq 3) { $outcome = 'missing' }
        elseif ($code -eq 32 -or $code -eq 33) { $outcome = 'busy' }
    } else {
        $info = [CredentialDisposal+Attributes]::new()
        if (-not [CredentialDisposal]::GetFileInformationByHandleEx($handle, 9, [ref]$info, 8)) { throw 'No attributes' }
        if (($info.attributes -band 1040) -ne 0) { $outcome = 'changed' } # directory or reparse point
        else {
            $stream = [IO.FileStream]::new($handle, [IO.FileAccess]::Read)
            if ($stream.Length -gt 16384) { $outcome = 'changed' }
            else {
                $hash = [Security.Cryptography.SHA256]::Create()
                try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
                finally { $hash.Dispose() }
                if ($actual -ne $fields[1]) { $outcome = 'changed' }
                else {
                    $disposition = [CredentialDisposal+Disposition]::new()
                    $disposition.delete = 1
                    if ([CredentialDisposal]::SetFileInformationByHandle($handle, 4, [ref]$disposition, 1)) { $outcome = 'deleted' }
                }
            }
        }
    }
} catch { $outcome = 'unavailable' }
finally {
    if ($stream) { $stream.Dispose() }
    if ($handle) { $handle.Dispose() }
}
[Console]::Out.WriteLine($outcome)
exit 0
