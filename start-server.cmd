@echo off
REM Starts the Outlets Cover Report server. Double-click this file.
REM
REM The window it opens IS the server - closing it stops the server.
REM Change the port here if 8080 is taken.

setlocal
cd /d "%~dp0"

if not defined PORT set PORT=8080

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or not on the PATH.
  echo.
  echo   Install the LTS build from https://nodejs.org/ then run this again.
  echo   If you have just installed it, close this window and open a new one
  echo   so the PATH is picked up.
  echo.
  pause
  exit /b 1
)

echo Starting on port %PORT% ...
echo.
node server\server.js

echo.
echo The server has stopped.
pause
