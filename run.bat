@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "CHROME=%LOCALAPPDATA%\Chromium\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe"

if not exist "!CHROME!" (
  echo Could not find Chrome, Chromium, or Edge.
  pause
  exit /b 1
)

set "ARGS=%*"

if "!ARGS!"=="" (
  echo GitHub Showcase Pipeline
  echo -----------------------
  echo 1^) Discover a repository automatically
  echo 2^) Use a repository URL or owner/repo
  echo.
  set "MODE="
  set /p "MODE=Choose 1 or 2: "
  set "REPO="
  if "!MODE!"=="2" (
    set /p "REPO=GitHub repository URL or owner/repo: "
  )
  if "!MODE!"=="1" (
    set "ARGS=-- --discover"
  ) else if not "!REPO!"=="" (
    set "ARGS=-- --repo !REPO!"
  ) else (
    echo No valid option or repository entered.
    pause
    exit /b 1
  )
)

echo.
echo Starting browser with remote debugging on port 9222...
start /min "" "!CHROME!" --remote-debugging-port=9222 --user-data-dir="%TEMP%\github-showcase-chrome"

timeout /t 4 /nobreak >nul

echo.
echo Running GitHub Showcase pipeline...
call npm run showcase !ARGS!
set "EXITCODE=!ERRORLEVEL!"

echo.
echo Finished with exit code !EXITCODE!.
pause
exit /b !EXITCODE!
