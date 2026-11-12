@echo off
rem GitHub Showcase / Lazy News - Node.js dependency installer (Windows)
rem Linux/macOS: use install/node.sh
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo === Installing Node.js dependencies ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ^>= 22.5 is required but was not found on PATH.
  echo.
  echo Install it from https://nodejs.org/ (check "Add to PATH"), then re-run this file.
  pause
  exit /b 1
)

rem Compare versions without floating-point tricks: print major.minor, check it.
for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set "NODEV=%%v"
for /f "tokens=1,2 delims=." %%a in ("%NODEV%") do (
  set "MAJ=%%a"
  set "MIN=%%b"
)
if %MAJ% LSS 22 goto :too-old
if %MAJ% EQU 22 if %MIN% LSS 5 goto :too-old
echo Node v%NODEV% - OK

echo Installing npm dependencies (this may take a minute for canvas)...
call npm install
if errorlevel 1 (
  echo npm install failed. See the log above.
  pause
  exit /b 1
)

echo.
echo Type-checking (src + tests + tools)...
call npm run check || goto :fail

echo.
echo Node.js environment OK.
echo Next: install the Python side with  install\python.bat
pause
exit /b 0

:too-old
echo Node.js ^>= 22.5.0 is required; found v%NODEV%.
echo Upgrade from https://nodejs.org/ and re-run this file.
pause
exit /b 1

:fail
echo Type-check failed. See the log above.
pause
exit /b 1
