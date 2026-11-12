# Regression test: controller must self-heal when ZCode is running WITHOUT the debug port
# (e.g. after an auto-update relaunch). Uses an isolated image name (ZCodeTest.exe) and an
# isolated tool dir (ZSTB_TOOL_DIR) so the live controller/pidfile/real ZCode are untouched.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-selfheal.ps1
$ErrorActionPreference = 'Stop'
$repo  = Split-Path -Parent $PSScriptRoot
$work  = Join-Path $env:TEMP ("zstb-heal-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work, (Join-Path $work 'tool') | Out-Null
$dummy = Join-Path $work 'ZCodeTest.exe'
Copy-Item "$env:SystemRoot\System32\cmd.exe" $dummy
$fail = 0

function Assert($cond, $msg) {
  if ($cond) { Write-Host "PASS: $msg" } else { Write-Host "FAIL: $msg"; $script:fail = 1 }
}

# dummy "ZCode" instance: the image the controller will detect and relaunch
$d1 = Start-Process $dummy -ArgumentList '/c','ping -n 120 127.0.0.1' -PassThru -WindowStyle Hidden

$env:ZSTB_PORT       = '15999'   # a port nothing listens on -> pages always empty
$env:ZSTB_INTERVAL   = '1000'
$env:ZSTB_HEAL_TICKS = '2'
$env:ZSTB_HEAL_MAX   = '2'
$env:ZSTB_ZCODE_IMAGE = 'ZCodeTest.exe'
$env:ZSTB_ZCODE_EXE   = $dummy
$env:ZSTB_TOOL_DIR    = Join-Path $work 'tool'

$ctrl = Start-Process 'G:\nodejs\node.exe' -ArgumentList (Join-Path $repo 'cdp-bar.mjs') -PassThru -WindowStyle Hidden

$healed = $false
foreach ($i in 1..15) {
  Start-Sleep -Seconds 1
  $logText = ''
  $logPath = Join-Path $env:ZSTB_TOOL_DIR 'controller.log'
  if (Test-Path $logPath) { $logText = Get-Content $logPath -Raw }
  if ($logText -match '自愈：ZCode 已带端口重启' -and $d1.HasExited) { $healed = $true; break }
}

Assert $d1.HasExited "self-heal kills the portless ZCode instance"
Assert $healed   "self-heal logs a successful relaunch with the debug port"
Assert (Test-Path (Join-Path $env:ZSTB_TOOL_DIR 'controller.pid')) "controller writes pidfile into ZSTB_TOOL_DIR (isolated)"

# cleanup
Stop-Process -Id $ctrl.Id -Force -ErrorAction SilentlyContinue
Get-Process ZCodeTest -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:ZSTB_PORT, Env:ZSTB_INTERVAL, Env:ZSTB_HEAL_TICKS, Env:ZSTB_HEAL_MAX, Env:ZSTB_ZCODE_IMAGE, Env:ZSTB_ZCODE_EXE, Env:ZSTB_TOOL_DIR -ErrorAction SilentlyContinue

if ($fail) { exit 1 } else { Write-Host 'ALL TESTS PASSED'; exit 0 }
