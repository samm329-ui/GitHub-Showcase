# GitHub Showcase Generator

A minimal pipeline for turning a GitHub repository into a vertical promo video (up to 30 seconds).

**Input:** a GitHub repository URL, or automatic discovery mode  
**Output:** `output/<owner>-<repo>.mp4`  
**Stack:** TypeScript/Node.js, GitHub public API, Chrome DevTools Protocol, espeak-ng, FFmpeg  
**No:** n8n, Playwright, local LLM, paid AI API, or paid subscription

## 1. Requirements

- Node.js 20 or newer
- Google Chrome
- FFmpeg with `ffmpeg` and `ffprobe` commands available in PATH
- `espeak-ng` available in PATH
- Internet access for GitHub and loading the repository page

## 2. Install Node dependencies

From this project folder:

```bash
npm install
npm run check
```

## 3. Install the external tools

**Windows**
1. Install Node.js LTS.
2. Install FFmpeg and add its `bin` directory to your PATH.
3. Install `espeak-ng` and add its executable directory to PATH.
4. Open a new PowerShell window and confirm `ffmpeg -version`, `ffprobe -version`, and `espeak-ng --version` work.

**Ubuntu/Debian**
```bash
sudo apt update
sudo apt install ffmpeg espeak-ng chromium
```

**macOS with Homebrew**
```bash
brew install ffmpeg espeak-ng
```

Chrome/Chromium should be installed separately if needed.

## 4. Start Chrome with remote debugging

This project controls a separate Chrome instance. Use a temporary profile; do not expose the debugging port to the public internet.

**Windows PowerShell**
```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\github-showcase-chrome"
```

If Chrome is installed elsewhere, replace the executable path.

**macOS**
```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/github-showcase-chrome
```

**Linux**
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/github-showcase-chrome
```

Leave this Chrome window open while generating the video.

## 5. Generate a video from a repository

```bash
npm run start -- --repo https://github.com/owner/repo
```

You can also pass `owner/repo`:

```bash
npm run start -- --repo owner/repo
```

## 6. Discover a candidate repository automatically

```bash
npm run start -- --discover
```

It searches recently updated repositories in two star ranges, prints candidates, and automatically picks the highest heuristic score. The score favors recent activity and a useful description; it does **not** understand repository quality like a human or an AI model would.

## 7. Output

- Final MP4: `output/`
- Narration and intermediate frames: `temp/<repo>/`

## Important limitations of this zero-cost MVP

- Narration is rule-based, not AI-written. It uses the repository description and README text.
- `espeak-ng` voice sounds robotic but works offline.
- Captions are divided evenly across the audio duration, not synchronized to individual spoken words.
- It records the actual GitHub page at a mobile-sized viewport and scrolls automatically. GitHub layout changes or cookie banners can affect the result.
- Automatic discovery is heuristic. Review the repository and generated claims before publishing.
- GitHub unauthenticated API rate limits apply.
- The first run depends on your local Chrome, FFmpeg, and espeak-ng setup. This package is a starter implementation, not a guarantee that every machine-specific dependency is already configured.
