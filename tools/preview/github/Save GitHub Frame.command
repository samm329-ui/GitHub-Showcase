#!/bin/bash
# Save GitHub Frame — double-click this on macOS to open the frame tuner.
set -e
cd "$(dirname "$0")/../../.."

echo
echo "  ========================================"
echo "   SAVE GITHUB FRAME"
echo "  ========================================"
echo "  Save your GitHub-video-frame settings: no code, one"
echo "  double-click, one slider drag."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed, or not on PATH."
  echo "  Install Node 22.5+ from https://nodejs.org"
  echo "  then double-click this file again."
  echo
  read -r -p "  Press Enter to close... "
  exit 1
fi

if [ ! -f package.json ]; then
  echo "  This file must live in the tools/preview folder of the"
  echo "  GitHub-Showcase repository. The project root was not found."
  echo
  read -r -p "  Press Enter to close... "
  exit 1
fi

echo "  1. A preview window opens in your browser."
echo "  2. Drag the sliders until the frame looks right."
echo "  3. Changes auto-save 1.5 seconds after you stop moving -"
echo "     or click \"Save (one click)\" to save right now."
echo "  4. When you are happy, close the browser tab, then press"
echo "     Ctrl+C in THIS window (or close it) to stop the server."
echo "  5. Double-click run.command -> [1] GitHub Repository"
echo "     Showcase to render with your frame."
echo
echo "  Starting the preview server..."
echo

( for i in $(seq 1 20); do
    sleep 0.5
    if curl -fsS -m 2 http://127.0.0.1:5178/api/config -o /dev/null 2>&1; then
      open "http://127.0.0.1:5178/tools/preview/github/preview-live.html"
      break
    fi
  done ) &
npm run preview:live

echo
echo "  Save GitHub Frame closed."
echo "  Your frame is saved in visual-overrides.json."
echo
read -r -p "  Press Enter to close... "
