@echo off
rem Stop the session-stats CDP controller (does not touch ZCode itself).
setlocal
rem Must match TOOL_DIR/PID_FILE in cdp-bar.mjs (not the script directory).
set "PIDFILE=%USERPROFILE%\.zcode\tools\session-stats-cdp\controller.pid"
if exist "%PIDFILE%" (
  for /f %%P in (%PIDFILE%) do taskkill /PID %%P /F >nul 2>&1
  del "%PIDFILE%" >nul 2>&1
  echo Controller stopped.
) else (
  echo No running controller found.
)
