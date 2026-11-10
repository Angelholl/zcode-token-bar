@echo off
rem Boot-time launcher: start ZCode (with CDP port) + token bar controller.
rem Non-interactive and idempotent: safe to re-run, skips anything already alive.
rem ASCII-only on purpose: cmd misreads UTF-8/Chinese under GBK codepage.
setlocal EnableDelayedExpansion
set "DIR=%~dp0"
set "PORT=9333"
set "PIDFILE=%USERPROFILE%\.zcode\tools\session-stats-cdp\controller.pid"
set "ZCODE_EXE=D:\ZCode\ZCode.exe"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" exit /b 1
if not exist "%ZCODE_EXE%" set "ZCODE_EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"

rem --- controller: start only if PID file points to a live node.exe ---
set "CTRL_RUNNING=0"
if exist "%PIDFILE%" for /f %%P in (%PIDFILE%) do (
  tasklist /FI "PID eq %%P" 2>nul | find /I "node.exe" >nul && set "CTRL_RUNNING=1"
)
if "%CTRL_RUNNING%"=="0" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList '%DIR%cdp-bar.mjs' -WindowStyle Hidden"

rem --- ZCode: launch with debug port only if not already running ---
tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if errorlevel 1 start "" "%ZCODE_EXE%" --remote-debugging-port=%PORT%
endlocal
