<#
  Runs a command as the current user with the Administrators group disabled.

  Why this exists: server/test/ boots a real embedded PostgreSQL, and on Windows
  postgres refuses to start under an elevated token ("Execution of PostgreSQL by a
  user with administrative permissions is not permitted"). Every test in the file
  then fails in under a millisecond, which reads like a flaky suite rather than an
  environment problem.

  Windows' Safer API computes a normal-user token from the current process, and
  CreateProcessAsUser starts the child with it: same user, same profile, no
  Administrators group. The elevated shell never has to be closed.

  Usage:
    pwsh -File tools/run-restricted.ps1 -CommandLine 'C:\Windows\System32\cmd.exe /c E:\HRT\tools\run-tests.cmd' -WorkDir 'E:\HRT\server'
#>
param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [string]$WorkDir = (Get-Location).Path,
    [string]$App = 'C:\Windows\System32\cmd.exe',
    [string]$LogPath = ''
)

$sig = @"
using System;
using System.Runtime.InteropServices;

public static class RestrictedToken {
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO {
    public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
    public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
    public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public long Luid; public uint Attributes; }

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SaferCreateLevel(uint scopeId, uint levelId, uint openFlags, out IntPtr levelHandle, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SaferComputeTokenFromLevel(IntPtr levelHandle, IntPtr inToken, out IntPtr outToken, uint flags, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SaferCloseLevel(IntPtr levelHandle);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES newState, uint bufferLength, IntPtr previous, IntPtr returnLength);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUserW(IntPtr token, string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes,
      bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  public static string Run(string application, string commandLine, string workDir) {
    const uint WIN_SAFER_SCOPEID_USER = 1;
    const uint SAFER_LEVELID_NORMALUSER = 0x20000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    IntPtr level;
    if (!SaferCreateLevel(WIN_SAFER_SCOPEID_USER, SAFER_LEVELID_NORMALUSER, 0, out level, IntPtr.Zero))
      return "SaferCreateLevel failed: " + Marshal.GetLastWin32Error();

    IntPtr token;
    if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero))
      return "SaferComputeTokenFromLevel failed: " + Marshal.GetLastWin32Error();
    SaferCloseLevel(level);

    // CreateProcessAsUser needs this one privilege; it is present but disabled on an
    // elevated token, so enable it for the duration of this script only.
    IntPtr self;
    OpenProcessToken((IntPtr)(-1), 0x0020 | 0x0008, out self);
    long luid;
    LookupPrivilegeValue(null, "SeAssignPrimaryTokenPrivilege", out luid);
    TOKEN_PRIVILEGES privileges = new TOKEN_PRIVILEGES();
    privileges.PrivilegeCount = 1;
    privileges.Luid = luid;
    privileges.Attributes = 0x00000002;
    AdjustTokenPrivileges(self, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero);

    STARTUPINFO startupInfo = new STARTUPINFO();
    startupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION processInformation;
    if (!CreateProcessAsUserW(token, application, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT,
        IntPtr.Zero, workDir, ref startupInfo, out processInformation))
      return "CreateProcessAsUser failed: " + Marshal.GetLastWin32Error();

    CloseHandle(processInformation.hThread);
    CloseHandle(processInformation.hProcess);
    CloseHandle(token);
    return "started pid=" + processInformation.dwProcessId;
  }
}
"@

Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop
$result = [RestrictedToken]::Run($App, $CommandLine, $WorkDir)
if ($LogPath) { "$(Get-Date -Format s) $result" | Add-Content -Path $LogPath }
Write-Output $result
