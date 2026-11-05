@echo off
rem Stop the session-stats CDP controller (does not touch ZCode itself).
setlocal
set "PIDFILE=%~dp0controller.pid"
if exist "%PIDFILE%" (
  for /f %%P in (%PIDFILE%) do taskkill /PID %%P /F >nul 2>&1
  del "%PIDFILE%" >nul 2>&1
  echo Controller stopped.
) else (
  echo No running controller found.
)
