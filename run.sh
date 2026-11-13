#!/bin/bash
# Video Automation Studio — two channels (Linux & macOS)
#   [1] GitHub Repository Showcase  (launches a visible Chrome on 9222)
#   [2] Lazy News Commentary        (its own headless Chromium: 9224 / evidence 9223)
# Windows: use run.bat
set -uo pipefail
cd "$(dirname "$0")"

pause() { read -r -p "Press Enter to continue..." _; }

banner() {
  echo
  echo "========================================"
  echo "     VIDEO AUTOMATION STUDIO"
  echo "========================================"
  echo
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$2"
    return 1
  fi
}

checks() {
  local ok=1
  need ffmpeg "FFmpeg not found. Install it: sudo apt install ffmpeg (Debian/Ubuntu) | sudo dnf install ffmpeg (Fedora) | sudo pacman -S ffmpeg (Arch) | brew install ffmpeg (macOS)" || ok=0
  need ffprobe "FFprobe not found (comes with FFmpeg)." || ok=0
  if [ ! -d .venv ] && ! command -v python3 >/dev/null 2>&1; then
    echo "Python not found and no .venv exists. Run install/python.sh first."
    ok=0
  fi
  if [ "$ok" = "0" ]; then
    echo
    echo "Install everything with:  install/python.sh   (creates .venv + downloads Kokoro models)"
    pause
    exit 1
  fi
}

load_env() {
  [ -f .env ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      GITHUB_TOKEN|GROQ_API_KEY|GROQ_MODEL|GUARDIAN_API_KEY)
        key="${key#export }"; [ -z "${!key:-}" ] && export "$key=$value" ;;
    esac
  done < <(grep -E '^(GITHUB_TOKEN|GROQ_API_KEY|GROQ_MODEL|GUARDIAN_API_KEY)=' .env)
}

launch_github() {
  # $1..$n = args passed to the pipeline
  bash tools/launch-github-chrome.sh || exit 1
  npm run showcase -- "$@"
}

news_usage() {
  echo "Usage: ./run.sh news --topic politics --discover | --url URL | --approve A --run-dir DIR"
}

# ---------------------------------------------------------------- direct modes
if [ "$#" -ge 1 ]; then
  case "${1,,}" in
    github)
      shift
      checks
      load_env
      ARGS=("$@"); [ "${#ARGS[@]}" -eq 0 ] && ARGS=(--discover)
      launch_github "${ARGS[@]}"
      echo "Finished. Videos: output/"
      pause
      exit 0 ;;
    news)
      shift
      if [ "$#" -eq 0 ]; then news_usage; pause; exit 1; fi
      checks
      : "${NEWS_AUTO_GATES:=1}"
      : "${NEWS_SOURCE:=inshorts}"
      export NEWS_AUTO_GATES NEWS_SOURCE
      echo "LAZY NEWS — discovery lane: Inshorts (NEWS_SOURCE=$NEWS_SOURCE; set NEWS_SOURCE=fortress to restore the retired lane)."
      echo "LAZY NEWS — automated gates engaged (NEWS_AUTO_GATES=$NEWS_AUTO_GATES; override with NEWS_AUTO_GATES=0 in .env)."
      npm run start:news -- "$@"
      echo "Finished. Episodes: output/news/"
      pause
      exit 0 ;;
    -*)
      # Legacy shorthand: ./run.sh --discover  ⇒  GitHub channel
      checks
      load_env
      launch_github "$@"
      echo "Finished. Videos: output/"
      pause
      exit 0 ;;
  esac
fi

# ---------------------------------------------------------------- menu
checks
banner
echo " [1] GitHub Repository Showcase"
echo " [2] Lazy News Commentary"
echo " [0] Exit"
echo
read -r -p "Choose pipeline: " choice

case "$choice" in
  1)
    load_env
    echo "GitHub Showcase Pipeline"
    echo "-----------------------"
    echo "1) Discover a repository automatically"
    echo "2) Use a repository URL or owner/repo"
    echo
    read -r -p "Choose 1 or 2: " mode
    if [ "$mode" = "1" ]; then
      ARGS=(--discover)
    else
      read -r -p "GitHub repository URL or owner/repo: " repo
      [ -z "$repo" ] && { echo "No repository given."; exit 1; }
      ARGS=(--repo "$repo")
    fi
    launch_github "${ARGS[@]}"
    echo "Finished. Videos: output/"
    pause ;;
  2)
    echo
    echo "LAZY NEWS COMMENTARY"
    echo "--------------------"
    echo " [1] Discover stories (auto)"
    echo " [2] Enter a story URL with evidence"
    echo " [3] Approve a gate (A/B/C)"
    echo " [0] Back"
    echo
    read -r -p "Choose 1, 2 or 3: " newsmode
    case "$newsmode" in
      1)
        read -r -p "Topic (politics/geopolitics/ai/technology/finance/environment/under_covered/mixed) [mixed]: " topic
        topic="${topic:-mixed}"
        : "${NEWS_AUTO_GATES:=1}"
        : "${NEWS_SOURCE:=inshorts}"
        export NEWS_AUTO_GATES NEWS_SOURCE
        npm run start:news -- --topic "$topic" --discover
        echo "Finished. Episodes: output/news/" ;;
      2)
        read -r -p "Story URL (must be a permitted primary/primary-record source): " url
        [ -z "$url" ] && { echo "No URL given."; exit 1; }
        : "${NEWS_AUTO_GATES:=1}"
        export NEWS_AUTO_GATES
        npm run start:news -- --url "$url" ;;
      3)
        read -r -p "Which gate (A/B/C)? " gate
        read -r -p "Run directory (e.g. temp/news-<slug>): " rundir
        npm run start:news -- --approve "$gate" --run-dir "$rundir" ;;
      *) exit 0 ;;
    esac
    pause ;;
  *) exit 0 ;;
esac
