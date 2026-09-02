@echo off
title Babel - voice translation
cd /d "%~dp0"

echo.
echo   Babel - live voice translation
echo   ------------------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed. Get it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run - installing dependencies...
  echo.
  call npm install
  echo.
)

REM Run node directly so Ctrl+C reaches it. Piping through PowerShell would
REM put another process between you and the app, and it eats the interrupt.
node src\index.js

echo.
echo   Stopped.
echo.
pause
