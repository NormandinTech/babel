@echo off
title Babel - voice translation
cd /d "%~dp0"

REM Optional: uncomment to auto-start llama-server for non-English targets.
REM start "llama-server" /min bin\llama-server.exe -m models\qwen2.5-3b-instruct-q4_k_m.gguf -c 2048 -ngl 99 --port 8080
REM timeout /t 6 /nobreak >nul

node src\index.js
pause
