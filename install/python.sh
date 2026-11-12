#!/bin/bash
# GitHub Showcase / Lazy News — Python environment installer (Linux & macOS)
# Windows: use install\python.bat
#
# Creates a repo-local virtual environment (.venv), installs requirements.txt
# and (optionally) downloads the Kokoro v1.0 model files into models/kokoro/.
# The pipeline auto-detects .venv — you never need to activate it by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Installing the Python environment (.venv) ==="
echo

# ---- 1. interpreter ------------------------------------------------------
# Find the first candidate that actually RUNS and is >= 3.9. Checking for
# existence alone is wrong on Windows, where `python3` may be the Microsoft
# Store stub (present, but not an interpreter).
PY=""
for candidate in python python3 py; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  fi
done
if [ -z "$PY" ]; then
  echo "No working Python 3 found on PATH."
  echo
  echo "Install it first, then re-run this file:"
  echo "  Windows       : https://www.python.org/downloads/  (check 'Add python.exe to PATH')"
  echo "  Debian/Ubuntu : sudo apt update && sudo apt install python3 python3-venv python3-pip"
  echo "  Fedora/RHEL   : sudo dnf install python3"
  echo "  Arch          : sudo pacman -S python"
  echo "  macOS (brew)  : brew install python"
  exit 1
fi
echo "$("$PY" --version) — OK"

# ---- 2. virtual environment ----------------------------------------------
if [ ! -d .venv ]; then
  echo "Creating the virtual environment (.venv)…"
  if ! $PY -m venv .venv; then
    echo
    echo "Could not create the virtual environment."
    echo "On Debian/Ubuntu the venv module is separate:  sudo apt install python3-venv python3-pip"
    echo "…or install into your user site-packages instead:  $PY -m pip install --user -r requirements.txt"
    exit 1
  fi
else
  echo "Reusing existing .venv"
fi

# The venv interpreter lives at .venv/bin/python on Linux/macOS and at
# .venv\Scripts\python.exe on Windows (git bash sees both).
VENV_PY=""
for candidate in ".venv/bin/python" ".venv/Scripts/python.exe"; do
  if [ -x "$candidate" ]; then VENV_PY="$candidate"; break; fi
done
if [ -z "$VENV_PY" ]; then
  echo "The virtual environment was created but its interpreter was not found where expected (.venv)."
  echo "Remove the .venv folder and re-run this file."
  exit 1
fi

"$VENV_PY" -m pip install --upgrade pip --quiet

# ---- 3. dependencies -------------------------------------------------------
echo "Installing Python dependencies (kokoro-onnx, soundfile, faster-whisper, …)…"
echo "This downloads a few hundred MB the first time."
"$VENV_PY" -m pip install -r requirements.txt

# ---- 4. Kokoro model files (~115 MB, one time) -----------------------------
if [ "${SKIP_MODELS:-0}" = "1" ]; then
  echo "SKIP_MODELS=1 — skipping the Kokoro model download."
else
  mkdir -p models/kokoro
  REL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
  if [ ! -f models/kokoro/kokoro-v1.0.int8.onnx ]; then
    echo "Downloading Kokoro v1.0 model (kokoro-v1.0.int8.onnx, ~88 MB)…"
    if ! curl -fL --retry 3 --continue-at - -o models/kokoro/kokoro-v1.0.int8.onnx "$REL/kokoro-v1.0.int8.onnx"; then
      echo
      echo "Model download failed. Get it manually and place it here:"
      echo "  models/kokoro/kokoro-v1.0.int8.onnx"
      echo "from: $REL/kokoro-v1.0.int8.onnx"
      exit 1
    fi
  else
    echo "kokoro-v1.0.int8.onnx already present."
  fi

  if [ ! -f models/kokoro/voices-v1.0.bin ]; then
    echo "Downloading Kokoro voices (voices-v1.0.bin, ~27 MB)…"
    if ! curl -fL --retry 3 --continue-at - -o models/kokoro/voices-v1.0.bin "$REL/voices-v1.0.bin"; then
      echo
      echo "Voices download failed. Get it manually and place it here:"
      echo "  models/kokoro/voices-v1.0.bin"
      echo "from: $REL/voices-v1.0.bin"
      exit 1
    fi
  else
    echo "voices-v1.0.bin already present."
  fi
fi

echo
echo "Python environment OK:  .venv"
echo "The pipeline finds it automatically (no need to activate)."
echo
echo "Sanity check:  \"$VENV_PY\" -c \"import kokoro_onnx, soundfile, faster_whisper; print('imports OK')\""
