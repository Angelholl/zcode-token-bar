# Regression test for stop.cmd: it must kill the controller via the PID file
# at %USERPROFILE%\.zcode\tools\session-stats-cdp\controller.pid (not %~dp0).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-stop.ps1
$ErrorActionPreference = 'Stop'
$repo   = Split-Path -Parent $PSScriptRoot
$tool   = Join-Path $env:USERPROFILE '.zcode\tools\session-stats-cdp'
$pidfile = Join-Path $tool 'controller.pid'
New-Item -ItemType Directory -Force -Path $tool | Out-Null
$fail = 0

function Assert($cond, $msg) {
  if ($cond) { Write-Host "PASS: $msg" } else { Write-Host "FAIL: $msg"; $script:fail = 1 }
}

# Case 1: pid file with a live dummy process -> stop.cmd kills it and removes the file
$dummy = Start-Process cmd -ArgumentList '/c','ping -n 30 127.0.0.1' -PassThru -WindowStyle Hidden
Set-Content -Path $pidfile -Value $dummy.Id -Encoding Ascii
& (Join-Path $repo 'stop.cmd') | Out-Null
Start-Sleep -Milliseconds 500
$dummy.Refresh()
Assert ($dummy.HasExited) "stop.cmd kills the PID recorded in the canonical pid file"
Assert (-not (Test-Path $pidfile)) "stop.cmd deletes the pid file after stopping"

# Case 2: no pid file -> friendly no-op, and must NOT touch the repo directory
$repoPid = Join-Path $repo 'controller.pid'
if (Test-Path $repoPid) { Remove-Item $repoPid -Force }   # ensure clean baseline
$out = & (Join-Path $repo 'stop.cmd')
Assert ($out -match 'No running controller found') "stop.cmd reports absence without error"
Assert (-not (Test-Path $repoPid)) "stop.cmd no longer looks for controller.pid in the script directory"

if ($fail) { exit 1 } else { Write-Host 'ALL TESTS PASSED'; exit 0 }
