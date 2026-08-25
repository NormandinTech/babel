@echo off
REM ============================================================
REM  Babel - first-time setup (Windows CMD)
REM ============================================================

echo.
echo Installing Node dependencies...
call npm install
if errorlevel 1 goto :fail

echo.
echo Checking for required binaries in bin\ ...
echo.

set MISSING=0
call :check bin\whisper-cli.exe  "whisper.cpp (CUDA build)"
call :check bin\piper.exe        "Piper TTS"
call :check bin\ffmpeg.exe       "FFmpeg"
call :check bin\ffplay.exe       "FFplay (ships with FFmpeg)"
call :check models\silero_vad.onnx "Silero VAD model"

echo.
if %MISSING%==0 (
  echo All binaries present.
  echo.
  echo Next:
  echo   1^) npm run devices      ^(find your mic name^)
  echo   2^) npm run processes    ^(with the game running^)
  echo   3^) edit config.json
  echo   4^) run.bat
) else (
  echo %MISSING% item^(s^) missing. See README.md section "Getting the binaries".
)
echo.
goto :eof

:check
if exist %1 (
  echo   [ok]      %~2
) else (
  echo   [MISSING] %~2  -^>  %1
  set /a MISSING+=1
)
goto :eof

:fail
echo.
echo npm install failed. Is Node.js installed? node --version
echo.
