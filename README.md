# GitHub Showcase Generator

A local, zero-cost pipeline that discovers a GitHub repository and turns it into
a narrated, captioned, 9:16 showcase video.

**Input:** a GitHub repository URL, or automatic discovery mode (`--discover`)
**Output:** `output/<owner>-<repo>-<runId>.mp4` plus a per-run artifact directory in `temp/`
**Stack:** TypeScript/Node.js, GitHub REST API, Kokoro TTS, Chromium (CDP), FFmpeg, `node:sqlite`
**No:** paid LLM, paid TTS API, n8n, Playwright, local LLM, or paid subscription

## 1. Requirements

- Node.js 22.5 or newer (the project uses the built-in `node:sqlite`)
- Google Chrome, Chromium, or Microsoft Edge
- FFmpeg and `ffprobe` available in `PATH`
- Python 3.9 or newer with `kokoro-onnx` and `soundfile` installed
- Internet access for GitHub and loading the repository page

## 2. Install Node dependencies

```bash
npm install
npm run check
npm test
```

## 3. Install the external tools

**Windows**

1. Install Node.js LTS (22.5 or newer).
2. Install FFmpeg and add its `bin` directory to your `PATH`.
3. Install Python and run `pip install kokoro-onnx soundfile`.
4. Open a new PowerShell window and confirm `ffmpeg -version`, `ffprobe -version`, and `python --version` work.
5. Place the Kokoro model and voices files under `tools/kokoro/`, or set `KOKORO_MODEL` and `KOKORO_VOICES`.

**Ubuntu/Debian**

```bash
sudo apt update
sudo apt install ffmpeg espeak-ng chromium
pip install kokoro-onnx soundfile
```

Chrome/Chromium should be installed separately if needed.

## 4. Start Chrome with remote debugging

This project controls a separate Chrome instance. Use a temporary profile; do not expose the debugging port to the public internet. `run.bat` does this for you on Windows; on other platforms:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/github-showcase-chrome
```

Leave the browser open while generating the video.

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

It runs a rotating set of discovery modes (practical, underdog, popular, emerging,
topic-specific), applies hard rejection gates and a transparent 0-100 score, and
picks the best eligible, never-before-completed repository. Use `--dry-run` to
report the selection and narration without rendering, and `--mode` to force a
mode:

```bash
npm run start -- --discover --dry-run
npm run start -- --discover --mode underdog
```

## 7. One-command Windows workflow

```bat
run.bat
```

`run.bat` checks for Chrome/Edge, FFmpeg, FFprobe and Python, starts the
browser, and runs the pipeline.

## 8. Configuration

All behaviour is driven by environment variables (there is no second config file):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHOWCASE_TARGET_SECONDS` | 35 | Target narration length |
| `SHOWCASE_FPS` | 30 | Output frame rate |
| `SHOWCASE_TEMP_DIR` | `temp/` | Working directory for run artifacts |
| `SHOWCASE_OUTPUT_DIR` | `output/` | Final MP4 directory |
| `SHOWCASE_DB` | `output/showcase-history.db` | SQLite history database |
| `SHOWCASE_MIN_SCORE` | 65 | Eligibility threshold for discovery |
| `KOKORO_VOICE` | `af_heart` | Kokoro voice id |
| `KOKORO_SPEED` | `1.0` | Kokoro speed |
| `KOKORO_MODEL` | `tools/kokoro/kokoro-v1.0.int8.onnx` | Kokoro model file |
| `KOKORO_VOICES` | `tools/kokoro/voices-v1.0.bin` | Kokoro voices file |
| `GITHUB_TOKEN` | (none) | Raises the GitHub API rate limit |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | Chrome DevTools endpoint |

The product rule is a hard maximum of 58 seconds.

## 9. Output

- Final MP4: `output/<owner>-<repo>-<runId>.mp4`
- Per-run artifacts: `temp/<owner>-<repo>-<runId>/`
  - `repository.json`, `selection.json`, `facts.json`, `narration.json`, `timeline.json`
  - `audio/segment-*.wav`, `narration.wav`, `captions.ass`
  - `work/visual/reference-*.jpg`, `ffmpeg-stderr.log`
  - `qa.json`, `run.log`
- History database: `output/showcase-history.db`

## 10. Narration and TTS

- Narration is assembled from a typed fact ledger (purpose, features, use cases,
  install, license, adoption, activity, release, requirements). Every segment
  cites one or more fact IDs; missing facts are omitted, never guessed.
- Several narrative styles are rotated per repository, chosen by evidence and
  by recent usage so openings do not repeat.
- Kokoro TTS runs locally. Voice and speed are configurable and can be auditioned
  with `npm run voice:audition`.
- The installed Kokoro model exposes no duration predictor, so caption timing
  uses measured per-chunk audio durations with syllable and punctuation weighting
  (documented fallback). Phoneme timings are used automatically if the model
  provides them.
- Audio duration is authoritative for the final timeline. A script that runs
  long is shortened and regenerated, never sped up.

## 11. Visual composition

- 1080 x 1920, 9:16, solid `#F2EFE9` background.
- One upright `#0D1117` card, 810 x 1668 px, 28 px radius, neutral multi-layer
  shadow. No tilt, phone frame, scenery, or neon glow.
- The card, browser bar, captions and progress bar stay stationary. Only the
  repository content inside a clipped viewport scrolls.
- Scroll targets come from measured DOM section bounds, paired with narration
  segments, with smooth easing and clamped bounds.
- Captions are white Inter text with selective `#FFD629` highlights. No filled
  background boxes around words.

## 12. Commands

```bash
npm run check           # TypeScript type check
npm test                # Run all tests
npm run preview         # Render a single preview (uses a fixture repository)
npm run voice:audition   # Generate Kokoro voice samples
```

## 13. Known limitations

- Narration is rule-based, not AI-written. It uses repository metadata and the
  README, and never invents star counts, licenses, or platform support.
- "Trending" is never claimed without dated star snapshots.
- The rendered card is built from repository data; it is not a screenshot of the
  live GitHub website, so layout fidelity depends on the local rendering.
- Automatic discovery is heuristic. Review the repository and generated claims
  before publishing.
- GitHub unauthenticated API rate limits apply; set `GITHUB_TOKEN` to raise them.
- The first run depends on your local Chrome, FFmpeg, Python and Kokoro setup.