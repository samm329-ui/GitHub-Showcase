@echo off
rem GitHub Showcase / Lazy News - Python environment installer (Windows)
rem Linux/macOS: use install/python.sh
rem
rem Creates a repo-local virtual environment (.venv), installs requirements.txt
rem and (optionally) downloads the Kokoro v1.0 model files into models\kokoro\
rem The pipeline auto-detects .venv - you never need to activate it by hand.
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo === Installing the Python environment (.venv) ===
echo.

rem ---- 1. interpreter ------------------------------------------------------
set "PY="
set "PYARGS="
where py >nul 2>nul && set "PY=py" && set "PYARGS=-3"
if not defined PY (
  where python >nul 2>nul && set "PY=python" && set "PYARGS="
)
if not defined PY (
  echo No Python 3 found on PATH.
  echo.
  echo Install it from https://www.python.org/downloads/ - check "Add python.exe to PATH" -
  echo then re-run this file.
  pause
  exit /b 1
)

%PY% %PYARGS% -c "import sys; v = sys.version_info; sys.exit(0 if v >= (3, 9) else 1)" || (
  echo Python ^>= 3.9 is required.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('%PY% %PYARGS% --version') do echo %%v - OK

rem ---- 2. virtual environment ------------------------------------------------
if not exist .venv (
  echo Creating the virtual environment (.venv^)…
  %PY% %PYARGS% -m venv .venv
  if errorlevel 1 (
    echo.
    echo Could not create the virtual environment.
    echo Make sure "venv" is checked in the Python installer, or reinstall from python.org.
    pause
    exit /b 1
  )
) else (
  echo Reusing existing .venv
)

set "VENV_PY=.venv\Scripts\python.exe"
%VENV_PY% -m pip install --upgrade pip --quiet || goto :fail

rem ---- 3. dependencies -------------------------------------------------------
echo Installing Python dependencies (kokoro-onnx, soundfile, faster-whisper, ...).
echo This downloads a few hundred MB the first time.
%VENV_PY% -m pip install -r requirements.txt || goto :fail

rem ---- 4. Kokoro model files (~115 MB, one time) ------------------------------
if "%SKIP_MODELS%"=="1" (
  echo SKIP_MODELS=1 - skipping the Kokoro model download.
  goto :done
)
if not exist models\kokoro mkdir models\kokoro
set "REL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

if exist models\kokoro\kokoro-v1.0.int8.onnx (
  echo kokoro-v1.0.int8.onnx already present.
) else (
  echo Downloading Kokoro v1.0 model (kokoro-v1.0.int8.onnx, ~88 MB^)…
  call :download "%REL%/kokoro-v1.0.int8.onnx" "models\kokoro\kokoro-v1.0.int8.onnx" || goto :model-fail
)

if exist models\kokoro\voices-v1.0.bin (
  echo voices-v1.0.bin already present.
) else (
  echo Downloading Kokoro voices (voices-v1.0.bin, ~27 MB^)…
  call :download "%REL%/voices-v1.0.bin" "models\kokoro\voices-v1.0.bin" || goto :model-fail
)

:done
echo.
echo Python environment OK:  .venv
echo The pipeline finds it automatically (no need to activate).
echo.
echo Sanity check:  .venv\Scripts\python.exe -c "import kokoro_onnx, soundfile, faster_whisper; print('imports OK')"
pause
exit /b 0

:download
rem %1 = url, %2 = destination
where curl >nul 2>nul && curl -fL --retry 3 --continue-at - -o "%~2" "%~1" && exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%~1' -OutFile '%~2' -UseBasicParsing" && exit /b 0
exit /b 1

:model-fail
echo.
echo Model download failed. Download it manually and place it under models\kokoro\
echo   %REL%/kokoro-v1.0.int8.onnx
echo   %REL%/voices-v1.0.bin
pause
exit /b 1

:fail
echo.
echo Installation failed. See the log above.
pause
exit /b 1
