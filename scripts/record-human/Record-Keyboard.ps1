#Requires -Version 5.1
<#
.SYNOPSIS
  Records YOUR keystroke dynamics for humanizer tuning (run once, alone).

.DESCRIPTION
  Installs a thread-local WH_KEYBOARD_LL hook and logs press/release
  timestamps (microsecond clock), virtual-key codes, and the resolved
  character for YOUR layout (ToUnicode, so AZERTY/QWERTZ work too).

  Type ONLY the throwaway sample texts below - never passwords, secrets,
  or personal messages. Everything you type IS captured to recordings/
  (gitignored, stays on your machine). Do NOT move the mouse during this
  run (record it separately with Record-Mouse.ps1) so the channels stay
  unconfounded. Press ESC to stop (the ESC itself is logged, then ignored
  by the analyzer).

.PARAMETER OutFile
  Destination JSONL path. Defaults to recordings/kb-<timestamp>.jsonl.

.PARAMETER MaxSeconds
  Auto-stop after this many seconds (0 = run until ESC). Default 300.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/record-human/Record-Keyboard.ps1
#>
[CmdletBinding()]
param(
  [string]$OutFile = "",
  [int]$MaxSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class KeyProbe {
  public sealed class Ev {
    public long micros;
    public int vk;
    public int sc;
    public bool down;
    public bool alt;
    public string ch;
  }

  public static readonly ConcurrentQueue<Ev> Queue = new ConcurrentQueue<Ev>();

  private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT {
    public int vkCode;
    public int scanCode;
    public int flags;
    public int time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int ptX;
    public int ptY;
  }

  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;
  private const int WM_KEYUP = 0x0101;
  private const int WM_SYSKEYUP = 0x0105;
  private const uint WM_QUIT = 0x0012;

  [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string lpModuleName);
  [DllImport("user32.dll")] private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
  [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern int GetKeyboardState(byte[] lpKeyState);
  [DllImport("user32.dll")] private static extern int ToUnicode(uint wVirtKey, uint wScanCode, byte[] lpKeyState, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszBuff, int cchBuff, uint wFlags);

  private static IntPtr hookId = IntPtr.Zero;
  private static HookProc hookProc;
  private static uint pumpThreadId;
  private static Thread pumpThread;

  private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    try {
      if (nCode >= 0) {
        int msg = wParam.ToInt32();
        bool down = (msg == WM_KEYDOWN) || (msg == WM_SYSKEYDOWN);
        bool up = (msg == WM_KEYUP) || (msg == WM_SYSKEYUP);
        if (down || up) {
          KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
          string ch = "";
          try {
            byte[] ks = new byte[256];
            if (GetKeyboardState(ks) != 0 && down) {
              StringBuilder sb = new StringBuilder(8);
              int n = ToUnicode((uint)kb.vkCode, (uint)kb.scanCode, ks, sb, sb.Capacity, 0);
              if (n > 0) { ch = sb.ToString(); }
            }
          } catch { ch = ""; }
          Queue.Enqueue(new Ev {
            micros = DateTime.UtcNow.Ticks / 10L,
            vk = kb.vkCode,
            sc = kb.scanCode,
            down = down,
            alt = (kb.flags & 0x20) != 0,
            ch = ch ?? ""
          });
        }
      }
    } catch { }
    return CallNextHookEx(hookId, nCode, wParam, lParam);
  }

  public static void Start() {
    if (hookId != IntPtr.Zero) { return; }
    hookProc = new HookProc(HookCallback);
    pumpThread = new Thread(new ThreadStart(delegate {
      pumpThreadId = GetCurrentThreadId();
      IntPtr hMod = GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName);
      hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, hMod, 0);
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) != 0) { }
    }));
    pumpThread.IsBackground = true;
    pumpThread.Start();
    while (hookId == IntPtr.Zero) { Thread.Sleep(10); }
  }

  public static void Stop() {
    try { PostThreadMessage(pumpThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch { }
    try {
      if (pumpThread != null) { pumpThread.Join(2000); }
    } catch { }
    try {
      if (hookId != IntPtr.Zero) { UnhookWindowsHookEx(hookId); }
    } catch { }
    hookId = IntPtr.Zero;
  }
}
"@

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot ".." "..")
$recordDir = Join-Path $repoRoot "recordings"
New-Item -ItemType Directory -Path $recordDir -Force | Out-Null
if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutFile = Join-Path $recordDir "kb-$stamp.jsonl"
}

$VK_ESCAPE = 27

$samples = @(
  "hey sorry for the late reply, was stuck in traffic and my phone died halfway home",
  "the quick brown fox jumps over the lazy dog 1234567890!?",
  "function renderList(items) { return items.filter(x => x.visible).map(x => x.name); }"
)

Write-Host "Type ONLY these throwaway samples (never real secrets). Aim for 2-3 minutes." -ForegroundColor Yellow
for ($i = 0; $i -lt $samples.Count; $i++) {
  Write-Host ("[{0}] {1}" -f ($i + 1), $samples[$i]) -ForegroundColor Cyan
}
Write-Host ""
Write-Host "Recording KEYBOARD to $OutFile" -ForegroundColor Green
Write-Host "Click into any text field, type naturally, press ESC to stop." -ForegroundColor Green

$writer = [System.IO.StreamWriter]::new($OutFile, $false, [System.Text.Encoding]::UTF8)
try {
  $writer.WriteLine((@{ kind = "meta"; device = "keyboard"; maxSecs = $MaxSeconds; startedAt = (Get-Date).ToString("o") } | ConvertTo-Json -Compress))
  $writer.Flush()
  [KeyProbe]::Start()

  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $events = 0
  $stop = $false
  while (-not $stop) {
    if ($MaxSeconds -gt 0 -and $clock.Elapsed.TotalSeconds -ge $MaxSeconds) { break }
    $ev = $null
    $drained = 0
    while ([KeyProbe]::Queue.TryDequeue([ref]$ev)) {
      $drained++
      $events++
      # Drop auto-repeat (same vk down twice with no up): analyzer-hardened,
      # but keep the stream clean here too.
      $writer.WriteLine((@{
          t    = [long]$ev.micros
          unit = "micros"
          vk   = [int]$ev.vk
          sc   = [int]$ev.sc
          type = $(if ($ev.down) { "down" } else { "up" })
          alt  = [bool]$ev.alt
          ch   = [string]$ev.ch
        } | ConvertTo-Json -Compress))
      if ($ev.down -and $ev.vk -eq $VK_ESCAPE) { $stop = $true }
    }
    if ($drained -ge 100) { $writer.Flush() }
    if ($events % 100 -eq 0 -and $events -gt 0) {
      Write-Host ("... {0} key events" -f $events) -ForegroundColor DarkGray
    }
    [System.Threading.Thread]::Sleep(50)
  }
  Write-Host "Stopped. key-events=$events" -ForegroundColor Green
  Write-Host "Next: analyze with: node scripts/record-human/analyze.mjs `"$OutFile`""
} finally {
  [KeyProbe]::Stop()
  $writer.Flush()
  $writer.Dispose()
}
