@echo off
rem session-stats CDP: launch ZCode (with CDP port) + token bar controller
rem ASCII-only on purpose: cmd misreads UTF-8/Chinese under GBK codepage.
setlocal EnableDelayedExpansion
set "DIR=%~dp0"
set "PORT=9333"
set "ZCODE_EXE=D:\ZCode\ZCode.exe"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  echo [!] node.exe not found. Install Node.js first.
  pause
  exit /b 1
)
if not exist "%ZCODE_EXE%" set "ZCODE_EXE=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"

tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if not errorlevel 1 (
  echo [!] ZCode is already running. CDP needs a debug port: quit ZCode fully first.
  choice /C YN /M "Kill all ZCode processes and relaunch now? [Y/N]"
  if errorlevel 2 exit /b 1
  taskkill /IM ZCode.exe /F >nul 2>&1
  timeout /t 2 /nobreak >nul
)

start "" "%ZCODE_EXE%" --remote-debugging-port=%PORT%
start "session-stats-cdp" /min cmd /c """%NODE_EXE%" "%DIR%cdp-bar.mjs"""
echo Started: ZCode (debug port %PORT%) + token bar controller.
echo The bar appears under the input box about 2 seconds after the window opens.
