# Regression test: controller must self-heal when ZCode is running WITHOUT the debug port
# (e.g. after an auto-update relaunch), and the attempt budget must RESET after a healthy
# era so a new port-loss era gets a fresh budget instead of staying given-up forever.
# Isolation: unique image name (ZCodeTest.exe), unique port, unique tool dir per run;
# pre-clean kills leftovers from earlier aborted runs (production controller excluded).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-selfheal.ps1
$ErrorActionPreference = 'Stop'
$repo  = Split-Path -Parent $PSScriptRoot
$work  = Join-Path $env:TEMP ("zstb-heal-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work, (Join-Path $work 'tool') | Out-Null
$dummy = Join-Path $work 'ZCodeTest.exe'
Copy-Item "$env:SystemRoot\System32\cmd.exe" $dummy
$port  = Get-Random -Minimum 15000 -Maximum 15999
$fail  = 0

function Assert($cond, $msg) {
  if ($cond) { Write-Host "PASS: $msg" } else { Write-Host "FAIL: $msg"; $script:fail = 1 }
}

# --- pre-clean: leftovers from earlier aborted runs (never touch the production controller) ---
Get-Process ZCodeTest -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$realPid = Get-Content "$env:USERPROFILE\.zcode\tools\session-stats-cdp\controller.pid" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'cdp-bar\.mjs' -and "$($_.ProcessId)" -ne "$realPid" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$ctrl = $null; $d1 = $null; $fakeSrv = $null; $d2 = $null; $d1b = $null; $garbageSrv = $null
try {
  $env:ZSTB_PORT        = "$port"
  $env:ZSTB_INTERVAL    = '1000'
  $env:ZSTB_HEAL_TICKS  = '2'
  $env:ZSTB_HEAL_MAX    = '1'
  $env:ZSTB_HEAL_COOLDOWN_MS = '2000'
  $env:ZSTB_ZCODE_IMAGE = 'ZCodeTest.exe'
  $env:ZSTB_ZCODE_EXE   = $dummy
  $env:ZSTB_TOOL_DIR    = Join-Path $work 'tool'
  $logPath = Join-Path $env:ZSTB_TOOL_DIR 'controller.log'

  # Era 1: dummy "ZCode" runs, nothing listens on the port -> heal #1, then (HEAL_MAX=1) give-up
  $d1 = Start-Process $dummy -ArgumentList '/c','ping -n 120 127.0.0.1' -PassThru -WindowStyle Hidden
  $ctrl = Start-Process 'G:\nodejs\node.exe' -ArgumentList (Join-Path $repo 'cdp-bar.mjs') -PassThru -WindowStyle Hidden

  $healed1 = $false
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 1
    $t = ''; if (Test-Path $logPath) { $t = Get-Content $logPath -Raw }
    if ($t -match '自愈：ZCode 已带端口重启' -and $d1.HasExited) { $healed1 = $true; break }
  }
  Assert $healed1 "era 1: heal kills the portless instance and relaunches with --remote-debugging-port=$port"

  # Now simulate the real "give-up" scenario: ZCode stays ALIVE but the port stays broken
  # (e.g. port squatted) — keep a dummy alive + a garbage listener on the port.
  $d1b = Start-Process $dummy -ArgumentList '/c','ping -n 120 127.0.0.1' -PassThru -WindowStyle Hidden
  $garbageJs = Join-Path $work 'garbage-cdp.cjs'
  'require("http").createServer((q,s)=>{s.end("not-json")}).listen(' + $port + ');' | Set-Content $garbageJs -Encoding Ascii
  $garbageSrv = Start-Process 'G:\nodejs\node.exe' -ArgumentList $garbageJs -WindowStyle Hidden -PassThru

  $gaveUp = $false
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 1
    $t = ''; if (Test-Path $logPath) { $t = Get-Content $logPath -Raw }
    if ($t -match '自愈放弃') { $gaveUp = $true; break }
  }
  Assert $gaveUp "era 1: controller gives up after HEAL_MAX attempts"

  # Era 2: a healthy era (fake CDP server -> pages>0) must RESET the attempt budget,
  # then the port dies again and heal must fire once more despite era-1's give-up.
  $fakeJs = Join-Path $work 'fake-cdp.cjs'
  $js = 'require("http").createServer((q,s)=>{s.setHeader("content-type","application/json");s.end(JSON.stringify([{type:"page",id:"fake",webSocketDebuggerUrl:"ws://127.0.0.1:1/x"}]))}).listen(' + $port + ');'
  $js | Set-Content $fakeJs -Encoding Ascii
  # free the port first: the era-1 garbage listener must not squat it
  Stop-Process -Id $garbageSrv.Id -Force -ErrorAction SilentlyContinue; $garbageSrv = $null
  Start-Sleep -Milliseconds 300
  $fakeSrv = Start-Process 'G:\nodejs\node.exe' -ArgumentList $fakeJs -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 4   # healthy era: attempts/gave-up reset
  Stop-Process -Id $fakeSrv.Id -Force -ErrorAction SilentlyContinue; $fakeSrv = $null
  Stop-Process -Id $d1b.Id -Force -ErrorAction SilentlyContinue; $d1b = $null

  $d2 = Start-Process $dummy -ArgumentList '/c','ping -n 120 127.0.0.1' -PassThru -WindowStyle Hidden
  $healed2 = $false
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 1
    $t = Get-Content $logPath -Raw
    $m = ([regex]::Matches($t, '自愈：ZCode 已带端口重启')).Count
    if ($m -ge 2 -and $d2.HasExited) { $healed2 = $true; break }
  }
  Assert $healed2 "era 2: budget reset after healthy era - heal fires again (new era gets fresh attempts)"
  Assert (Test-Path (Join-Path $env:ZSTB_TOOL_DIR 'controller.pid')) "controller writes pidfile into ZSTB_TOOL_DIR (isolated)"
} finally {
  if ($fail -and $env:ZSTB_TOOL_DIR -and (Test-Path (Join-Path $env:ZSTB_TOOL_DIR 'controller.log'))) {
    Write-Host '--- controller.log (kept for diagnosis) ---'
    Get-Content (Join-Path $env:ZSTB_TOOL_DIR 'controller.log')
  }
  if ($ctrl)    { Stop-Process -Id $ctrl.Id -Force -ErrorAction SilentlyContinue }
  if ($d1)      { Stop-Process -Id $d1.Id -Force -ErrorAction SilentlyContinue }
  if ($d2)      { Stop-Process -Id $d2.Id -Force -ErrorAction SilentlyContinue }
  if ($fakeSrv)   { Stop-Process -Id $fakeSrv.Id -Force -ErrorAction SilentlyContinue }
  if ($garbageSrv){ Stop-Process -Id $garbageSrv.Id -Force -ErrorAction SilentlyContinue }
  if ($d1b)       { Stop-Process -Id $d1b.Id -Force -ErrorAction SilentlyContinue }
  Get-Process ZCodeTest -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:ZSTB_PORT, Env:ZSTB_INTERVAL, Env:ZSTB_HEAL_TICKS, Env:ZSTB_HEAL_MAX, Env:ZSTB_HEAL_COOLDOWN_MS, Env:ZSTB_ZCODE_IMAGE, Env:ZSTB_ZCODE_EXE, Env:ZSTB_TOOL_DIR -ErrorAction SilentlyContinue
}

if ($fail) { exit 1 } else { Write-Host 'ALL TESTS PASSED'; exit 0 }
