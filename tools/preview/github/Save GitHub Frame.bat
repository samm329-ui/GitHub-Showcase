@echo off
setlocal
cd /d "%~dp0..\..\.."

echo.
echo   ========================================
echo    SAVE GITHUB FRAME
echo   ========================================
echo    Save your GitHub-video-frame settings: no code, one
echo    double-click, one slider drag.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo    Node.js is not installed, or not on PATH.
  echo    Install Node 22.5+ from https://nodejs.org
  echo    then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist package.json (
  echo    This file must live in the Tools ^> preview folder of the
  echo    GitHub-Showcase repository (GitHub pipeline). The project root was not found.
  echo.
  pause
  exit /b 1
)

echo    1. A preview window opens in your browser.
echo    2. Drag the sliders until the frame looks right.
echo    3. Changes auto-save 1.5 seconds after you stop moving -
echo       or click "Save (one click)" to save right now.
echo    4. When you are happy, close the browser tab, then press
echo       Ctrl+C in THIS window (or close it) to stop the server.
echo    5. Double-click run.bat and pick [1] GitHub Repository
echo       Showcase to render videos with your frame.
echo.
echo    Starting the preview server...
echo.

start "" /MIN powershell -NoProfile -ExecutionPolicy Bypass -Command "1..20 | ForEach-Object { Start-Sleep -Milliseconds 500; try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:5178/api/config' -TimeoutSec 2 -UseBasicParsing; Start-Process 'http://127.0.0.1:5178/tools/preview/github/preview-live.html'; break } catch { } }"
call npm run preview:live

echo.
echo    Save GitHub Frame closed.
echo    Your frame is saved in visual-overrides.json.
echo.
pause
exit /b 0
