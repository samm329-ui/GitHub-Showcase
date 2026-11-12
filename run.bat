@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem =========================================
rem  Video Automation Studio — two channels
rem    [1] GitHub Repository Showcase  (launches Chrome on 9222, as before)
rem    [2] Lazy News Commentary        (own headless Chromium: 9224; evidence: 9223)
rem =========================================

set "CHROME=%LOCALAPPDATA%\Chromium\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
if not exist "!CHROME!" set "CHROME=%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe"
if not exist "!CHROME!" set "CHROME=%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe"

if not exist "!CHROME!" (
  echo Could not find Chrome, Chromium, or Edge.
  echo Install one of them and run this again.
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo FFmpeg was not found on PATH. Install it and add its bin directory to PATH.
  pause
  exit /b 1
)

where ffprobe >nul 2>nul
if errorlevel 1 (
  echo FFprobe was not found on PATH. Install it and add its bin directory to PATH.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH. Install Python with the kokoro-onnx and soundfile packages.
  pause
  exit /b 1
)

rem ---- load .env keys (shell-exported values win) ----
if exist ".env" (
  for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
    if /I "%%A"=="GITHUB_TOKEN" set "GITHUB_TOKEN=%%B"
    if /I "%%A"=="GROQ_API_KEY" set "GROQ_API_KEY=%%B"
    if /I "%%A"=="GROQ_MODEL" set "GROQ_MODEL=%%B"
    if /I "%%A"=="GUARDIAN_API_KEY" set "GUARDIAN_API_KEY=%%B"
  )
)

rem ---- direct invocations ----
rem   run.bat github --repo owner/name     : GitHub channel, Chrome on 9222
rem   run.bat news --topic ai --discover   : Lazy News channel (its own Chromium)
rem   run.bat --discover                   : legacy shorthand = github --discover
if /I "%~1"=="github" (
  set "GH_ARGS=%~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9"
  if "!GH_ARGS!"=="" set "GH_ARGS=--discover"
  call :launch_github_chrome
  if errorlevel 1 exit /b 1
  call npm run showcase -- !GH_ARGS!
  goto finished
)
if /I "%~1"=="news" (
  if "%~2"=="" (
    echo Usage: run.bat news --topic politics --discover ^| --url URL ^| --approve A --run-dir DIR
    goto done
  )
  goto news_run_args
)
if not "%~1"=="" (
  if /I not "%~1"=="0" (
    set "FIRST=%~1"
    if "!FIRST:~0,1!"=="-" (
      set "GH_ARGS=%*"
      call :launch_github_chrome
      if errorlevel 1 exit /b 1
      call npm run showcase -- !GH_ARGS!
      goto finished
    )
  )
)

rem ---- interactive main menu ----
echo.
echo ========================================
echo     VIDEO AUTOMATION STUDIO
echo ========================================
echo.
echo  [1] GitHub Repository Showcase
echo  [2] Lazy News Commentary
echo  [0] Exit
echo.
set "CHANNEL="
set /p "CHANNEL=Choose pipeline: "
if "%CHANNEL%"=="1" goto github_interactive
if "%CHANNEL%"=="2" goto news_interactive
if "%CHANNEL%"=="0" goto done
echo No valid option.
goto done

rem NOTE: Chrome is launched with a VISIBLE window on purpose.
rem The news channel uses its own headless Chromium (9224/9223) - never this one.
:launch_github_chrome
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\windows\launch-github-chrome.ps1" -ChromeExe "!CHROME!"
if errorlevel 1 (
  pause
  exit /b 1
)
goto :eof

:github_interactive

if "%GITHUB_TOKEN%"=="" (
  set "TOKEN="
  set /p "TOKEN=GitHub token (optional, press Enter to skip): "
  if not "!TOKEN!"=="" (
    set "GITHUB_TOKEN=!TOKEN!"
    > .env echo GITHUB_TOKEN=!TOKEN!
  )
)

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
  set "GH_ARGS=--discover"
) else if not "!REPO!"=="" (
  set "GH_ARGS=--repo !REPO!"
) else (
  echo No valid option or repository entered.
  pause
  exit /b 1
)
call :launch_github_chrome
if errorlevel 1 exit /b 1
call npm run showcase -- !GH_ARGS!
goto finished

:news_interactive
echo.
echo LAZY NEWS COMMENTARY
echo --------------------
echo  [1] Discover stories (auto)
echo  [2] Enter a story URL with evidence
echo  [3] Approve a gate (A/B/C)
echo  [0] Back
echo.
set "NEWS_MODE="
set /p "NEWS_MODE=Choose 1, 2 or 3: "
if "!NEWS_MODE!"=="1" (
  set "TOPIC="
  set /p "TOPIC=Topic (politics/geopolitics/ai/technology/finance/environment/under_covered/mixed): "
  if "!TOPIC!"=="" set "TOPIC=mixed"
  set "NEWS_ARGS=--topic !TOPIC! --discover"
  goto news_run
)
if "!NEWS_MODE!"=="2" (
  set "URL="
  set /p "URL=Story URL (must be a permitted primary/primary-record source): "
  set "NEWS_ARGS=--url !URL!"
  goto news_run
)
if "!NEWS_MODE!"=="3" (
  set "GATE="
  set /p "GATE=Which gate (A/B/C)? "
  set "RUNDIR="
  set /p "RUNDIR=Run directory (temp\news-...): "
  call npm run start:news -- --approve !GATE! --run-dir "!RUNDIR!"
  goto finished
)
echo No valid option.
goto done

:news_run_args
set "NEWS_ARGS=%~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9"

:news_run
echo.
echo LAZY NEWS - gates A (facts) and B (script) require explicit approval.
echo Lazy News uses its own headless Chromium (render port 9224, evidence port 9223).
echo The GitHub Showcase Chrome on 9222 is not used or required by this channel.
echo With --dry-run it prints candidates without rendering.
call npm run start:news -- !NEWS_ARGS!
set "EXITCODE=!ERRORLEVEL!"
echo.
echo Finished with exit code !EXITCODE!.
echo Episodes: output\news\
pause
exit /b !EXITCODE!

:finished
echo.
echo Finished with exit code !ERRORLEVEL!.
echo GitHub videos: output\
pause
exit /b !ERRORLEVEL!

:done
echo.
echo Cancelled.
pause
exit /b 0
