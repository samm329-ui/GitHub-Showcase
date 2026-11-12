#!/bin/bash
# GitHub Showcase / Lazy News — Node.js dependency installer (Linux & macOS)
# Windows: use install\node.bat
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Installing Node.js dependencies ==="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 22.5 is required but was not found on PATH."
  echo
  echo "Install it first, then re-run this file:"
  echo "  Debian/Ubuntu : sudo apt install nodejs npm"
  echo "  Fedora/RHEL   : sudo dnf install nodejs"
  echo "  Arch          : sudo pacman -S nodejs npm"
  echo "  macOS (brew)  : brew install node"
  echo "  or download from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "Node.js >= 22.5.0 is required; found $(node --version)."
  echo "Upgrade via your package manager or https://nodejs.org/ and re-run."
  exit 1
fi
echo "Node $(node --version) — OK"

echo "Installing npm dependencies (this may take a minute for canvas)…"
npm install

echo
echo "Type-checking (src + tests + tools)…"
npm run check

echo
echo "Node.js environment OK."
echo "Next: install the Python side with  ./install/python.sh"
