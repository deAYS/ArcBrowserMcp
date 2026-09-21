#Requires -Version 5.1
<#
.SYNOPSIS
  Records YOUR mouse behavior for humanizer tuning (run once, alone).

.DESCRIPTION
  Polls the cursor position (~every 8 ms) plus left/right/middle button
  transitions and writes timestamped JSONL. Use the browser normally for
  2-3 minutes: click links, focus fields, open menus. Do NOT type during
  this run (record keyboard separately with Record-Keyboard.ps1) so the
  two motor channels stay unconfounded.

  Nothing leaves your machine. The file lands in recordings/ (gitignored).
  Stop by pressing ESC (it is not logged) or with Ctrl+C.

.PARAMETER OutFile
  Destination JSONL path. Defaults to recordings/mouse-<timestamp>.jsonl
  next to the repo root.

.PARAMETER MaxSeconds
  Auto-stop after this many seconds (0 = run until ESC). Default 300.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/record-human/Record-Mouse.ps1
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
using System.Runtime.InteropServices;
public sealed class MouseProbe {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@

$repoRoot = Resolve-Path (Join-Path (Join-Path $PSScriptRoot "..") "..")
$recordDir = Join-Path $repoRoot "recordings"
New-Item -ItemType Directory -Path $recordDir -Force | Out-Null
if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutFile = Join-Path $recordDir "mouse-$stamp.jsonl"
}

$VK_LBUTTON = 1
$VK_RBUTTON = 2
$VK_MBUTTON = 4
$VK_ESCAPE = 27

function Test-KeyDown([int]$vk) {
  return ([MouseProbe]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
}

$writer = [System.IO.StreamWriter]::new($OutFile, $false, [System.Text.Encoding]::UTF8)
try {
  $meta = @{
    kind      = "meta"
    device    = "mouse"
    timerHz   = [System.Diagnostics.Stopwatch]::Frequency
    maxSecs   = $MaxSeconds
    startedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  $writer.WriteLine($meta)
  $writer.Flush()

  Write-Host "Recording MOUSE to $OutFile"
  Write-Host "Move and click naturally for a few minutes. Press ESC to stop." -ForegroundColor Green

  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $lastTick = 0L
  $lastX = -1
  $lastY = -1
  $prevButtons = @{ left = $false; right = $false; middle = $false }
  $moves = 0
  $clicks = 0
  $escArmed = -not (Test-KeyDown $VK_ESCAPE)

  while ($true) {
    $nowMs = $clock.Elapsed.TotalMilliseconds
    if ($MaxSeconds -gt 0 -and $nowMs -ge ($MaxSeconds * 1000)) { break }

    # ESC stops (require release-then-press so a held ESC at startup exits cleanly).
    $escDown = Test-KeyDown $VK_ESCAPE
    if ($escDown -and $escArmed) { break }
    if (-not $escDown) { $escArmed = $true }

    if (($nowMs - $lastTick) -ge 8) {
      $lastTick = $nowMs
      $point = New-Object MouseProbe+POINT
      if ([MouseProbe]::GetCursorPos([ref]$point)) {
        if ($point.X -ne $lastX -or $point.Y -ne $lastY) {
          $lastX = $point.X
          $lastY = $point.Y
          $writer.WriteLine((@{ t = [Math]::Round($nowMs, 3); type = "move"; x = $lastX; y = $lastY } | ConvertTo-Json -Compress))
          $moves++
        }
      }
      $states = @{
        left   = Test-KeyDown $VK_LBUTTON
        right  = Test-KeyDown $VK_RBUTTON
        middle = Test-KeyDown $VK_MBUTTON
      }
      foreach ($button in @("left", "right", "middle")) {
        if ($states[$button] -ne $prevButtons[$button]) {
          $edge = if ($states[$button]) { "down" } else { "up" }
          $writer.WriteLine((@{ t = [Math]::Round($nowMs, 3); type = $edge; button = $button; x = $lastX; y = $lastY } | ConvertTo-Json -Compress))
          if ($edge -eq "down") { $clicks++ }
        }
      }
      $prevButtons = $states
      if (($moves + $clicks) % 500 -eq 0) { $writer.Flush() }
    } else {
      [System.Threading.Thread]::Sleep(1)
    }
  }

  Write-Host "Stopped. moves=$moves button-presses=$clicks" -ForegroundColor Green
  Write-Host "Next: analyze with: node scripts/record-human/analyze.mjs `"$OutFile`""
} finally {
  $writer.Flush()
  $writer.Dispose()
}
