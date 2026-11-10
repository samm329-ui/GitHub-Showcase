@echo off
rem Save My Edits.cmd - fallback launcher for machines where .vbs is blocked.
rem Double-click to open the live composition preview. On success the
rem browser opens and this window closes by itself; on failure it shows why.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed, or it is not on PATH.
  echo Install Node.js 22.5+ from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules\
(
  echo Dependencies are not installed yet.
  echo Open a terminal in this folder and run:  npm install
  echo Then double-click this file again.
  pause
  exit /b 1
)

if not exist temp\ mkdir temp

node --import tsx tools\launch-preview.ts > temp\preview-launch.log 2>&1
if errorlevel 1 (
  echo ========================================
  echo  The live preview could not be started.
  echo ========================================
  type temp\preview-launch.log
  echo.
  echo Details: temp\preview-launch.log
  echo Quick checks: npm install  /  npm run preview:launch
  pause
  exit /b 1
)
exit /b 0
