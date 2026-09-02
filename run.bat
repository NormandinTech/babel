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

REM Live output on screen AND saved to babel-log.txt, in one step.
powershell -NoProfile -ExecutionPolicy Bypass -Command "node src\index.js 2>&1 | Tee-Object -FilePath 'babel-log.txt'"

echo.
echo   Stopped. This session was saved to babel-log.txt
echo.
pause
