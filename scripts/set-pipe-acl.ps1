#Requires -Version 5.1
<#
  Grant access on an arc-mcp bridge named pipe so a browser-launched native
  host (restricted process token) can connect to the MCP-owned listener.
  Node cannot set pipe security descriptors; this uses built-in OS
  facilities only (kernel32/advapi32 via Add-Type, no downloads).
  The script touches ONLY pipes matching the arc-mcp bridge namespace.
  Authentication still rests on the 256-bit session nonce, never on this ACE.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$PipeName
)

if ($PipeName -notmatch '^\\\\\.\\pipe\\arc-mcp-bridge-v1-[a-z0-9-]+$') {
  Write-Error "refusing pipe outside the arc-mcp bridge namespace: $PipeName"
  exit 2
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ArcMcpPipeAcl {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(
        string fileName, uint desiredAccess, uint shareMode,
        IntPtr securityAttributes, uint creationDisposition,
        uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string sddl, uint revision, out IntPtr result, out uint resultLength);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint SetSecurityInfo(
        IntPtr handle, int objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetSecurityDescriptorDacl(
        IntPtr descriptor, out bool daclPresent, ref IntPtr dacl, ref bool defaulted);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr handle);
}
"@

$WRITE_DAC = 0x00040000
$OPEN_EXISTING = 3
$SE_KERNEL_OBJECT = 6
$DACL_SECURITY_INFORMATION = 4

$handle = [ArcMcpPipeAcl]::CreateFileW($PipeName, $WRITE_DAC, 0, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
if ($handle -eq [IntPtr](-1)) {
  Write-Error "cannot open pipe for DACL update: $PipeName"
  exit 3
}
try {
  # Everyone full access: lets the restricted-token host connect. The 256-bit
  # session nonce (verified after connect) remains the real authentication.
  $sd = [IntPtr]::Zero
  $len = 0
  if (-not [ArcMcpPipeAcl]::ConvertStringSecurityDescriptorToSecurityDescriptorW(
      "D:(A;;GA;;;WD)", 1, [ref]$sd, [ref]$len)) {
    Write-Error "cannot build security descriptor"
    exit 4
  }
  try {
    $daclPresent = $false
    $daclPtr = [IntPtr]::Zero
    $defaulted = $false
    if (-not [ArcMcpPipeAcl]::GetSecurityDescriptorDacl($sd, [ref]$daclPresent, [ref]$daclPtr, [ref]$defaulted)) {
      Write-Error "cannot extract DACL from security descriptor"
      exit 4
    }
    if (-not $daclPresent) {
      Write-Error "security descriptor contains no DACL"
      exit 4
    }
    $status = [ArcMcpPipeAcl]::SetSecurityInfo($handle, $SE_KERNEL_OBJECT, $DACL_SECURITY_INFORMATION,
      [IntPtr]::Zero, [IntPtr]::Zero, $daclPtr, [IntPtr]::Zero)
    if ($status -ne 0) {
      Write-Error "SetSecurityInfo failed with Win32 error $status"
      exit 5
    }
  } finally {
    [void][ArcMcpPipeAcl]::LocalFree($sd)
  }
} finally {
  [void][ArcMcpPipeAcl]::CloseHandle($handle)
}
"pipe-acl-applied $PipeName"
