#!/bin/bash
# Ensures a VISIBLE, debuggable Chrome on port 9222 for the GitHub Showcase pipeline.
# Linux & macOS equivalent of tools/windows/launch-github-chrome.ps1.
#
# Exit codes: 0 = ready on 9222   1 = failed (caller must stop, never fall back)
set -uo pipefail

port=9222
probe_url="http://127.0.0.1:$port/json/version"
profile_tag="github-showcase-chrome"
user_data_dir="${TMPDIR:-/tmp}/$profile_tag"

probe() {
  curl -fsS --max-time 2 "$probe_url" >/dev/null 2>&1
}

find_browser() {
  if [ -n "${CHROME_BIN:-}" ] && [ -x "${CHROME_BIN:-}" ]; then
    echo "$CHROME_BIN"; return 0
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    for c in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium" \
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
      "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/opt/homebrew/bin/google-chrome" \
      "/usr/local/bin/google-chrome"; do
      [ -x "$c" ] && { echo "$c"; return 0; }
    done
  else
    for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge chrome; do
      if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    done
    for c in /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium /opt/google/chrome/chrome; do
      [ -x "$c" ] && { echo "$c"; return 0; }
    done
  fi
  return 1
}

# 1) Already served on 9222?
if probe; then
  echo "Port $port is already served by a debuggable browser — reusing it."
  exit 0
fi

# 2) Kill leftovers from previous automation runs, then launch visible Chrome.
pkill -f "$profile_tag" 2>/dev/null
sleep 1

browser="$(find_browser)" || {
  echo "No Chrome/Chromium/Edge found. Install one, or set CHROME_BIN=/path/to/browser."
  exit 1
}

echo "Starting visible Chrome on port $port ($browser) …"
nohup "$browser" \
  --remote-debugging-port=$port \
  --user-data-dir="$user_data_dir" \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --ignore-gpu-blocklist \
  --enable-gpu-rasterization \
  --use-gl=angle \
  --use-angle=gl \
  >/dev/null 2>&1 &
disown 2>/dev/null || true

for i in $(seq 1 24); do
  sleep 1
  if probe; then
    echo "Chrome is ready on port $port."
    exit 0
  fi
done

echo
echo "ERROR: Chrome did not open its debugging port on $port within 24 seconds."
echo "  - Try: \"$browser\" --remote-debugging-port=$port --user-data-dir=\"$user_data_dir\""
echo "  - Close any stale $profile_tag windows and retry."
echo "The pipeline will NOT continue into a silent, slow headless fallback."
exit 1
