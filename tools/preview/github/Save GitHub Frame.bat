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
echo    4. Close the preview tab when you are happy with the look.
echo    5. Double-click run.bat and pick [1] GitHub Repository
echo       Showcase to render videos with your frame.
echo.
echo    Starting the preview (close the black window to quit)...
echo.

call npm run preview:launch

echo.
echo    Save GitHub Frame closed.
echo    Your frame is saved in visual-overrides.json.
echo.
pause
exit /b 0


