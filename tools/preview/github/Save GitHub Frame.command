#!/bin/bash
# Save GitHub Frame â€” double-click this on macOS to open the frame tuner.
# macOS double-clicking a .command file opens Terminal automatically.
set -e
cd "$(dirname "cd "$(dirname "$0")/../.."")/../../.."

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
echo "  4. Close the preview tab when you are happy."
echo "  5. Double-click run.command -> [1] GitHub Repository"
echo "     Showcase to render with your frame."
echo
echo "  Starting the preview (Ctrl+C to quit)..."
echo

npm run preview:launch

echo
echo "  Save GitHub Frame closed."
echo "  Your frame is saved in visual-overrides.json."
echo
read -r -p "  Press Enter to close... "



