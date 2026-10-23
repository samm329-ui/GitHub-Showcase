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
| `KOKORO_VOICE` | `am_fenrir` | Kokoro voice id (locked audition winner, young developer delivery) |
| `KOKORO_SPEED` | `1.0` | Kokoro speed (natural conversational pace) |
| `KOKORO_LANG` | `en-us` | Kokoro language code |
| `KOKORO_MODEL` | `tools/kokoro/kokoro-v1.0.int8.onnx` | Kokoro model file |
| `KOKORO_VOICES` | `tools/kokoro/voices-v1.0.bin` | Kokoro voices file |
| `SHOWCASE_MASCOT_WIDTH_RATIO` | `0.46` | Presenter width as a fraction of the 1080 px canvas |
| `SHOWCASE_MASCOT_OFFSET_X` | `-12` | Presenter `right` offset; negative extends past the canvas edge |
| `SHOWCASE_MASCOT_OFFSET_Y` | `0` | Presenter `bottom` offset from the canvas bottom edge |
| `GITHUB_TOKEN` | (none) | Raises the GitHub API rate limit |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | Chrome DevTools endpoint |
| `SHOWCASE_CHARACTER_PNG` | `assets/character.png` | Primary transparent presenter; `none` disables the layer |
| `SHOWCASE_CHARACTER_POINT_PNG` | `assets/character.png` | Optional pointing pose; falls back to the primary cut-out |
| `SHOWCASE_CHARACTER_CLOSE_PNG` | `assets/character-close.png` | Optional medium CTA pose |

The product rule is a hard maximum of 58 seconds.

## 9. Output

- Final MP4: `output/<owner>-<repo>-<runId>.mp4`
- Per-run artifacts: `temp/<owner>-<repo>-<runId>/`
  - `repository.json`, `selection.json`, `facts.json`, `narration.json`, `narration-structure.json`, `timeline.json`
  - `render-metadata.json` — the voice preset (id/speed/language), the exact
    Kokoro model and voices files, the video spec and the mascot layout used
  - `speech-envelope.json` — the measured 25 Hz amplitude envelope that drives the character
  - `story.json` — the mobile-capture source, crop end and scroll-budget warnings
  - `audio/segment-*.wav`, `narration.wav`, `captions.ass`
  - `work/capture/mobile-page-full.jpg`, `mobile-page.json`, `story-page.jpg`
  - `work/visual/reference-*.jpg` (0/25/50/75/100%), `contact-sheet.jpg`, `ffmpeg-stderr.log`
  - `qa.json`, `run.log`
- History database: `output/showcase-history.db`

## 10. Narration and TTS

- Narration is assembled from a typed fact ledger (purpose, features, use cases,
  install, license, adoption, activity, release, requirements). Every segment
  cites one or more fact IDs; missing facts are omitted, never guessed.
- A constrained story grammar orders clauses as `identity → value → proof/demo →
  setup → availability → caveat → cta`. Structures are selected by evidence and
  rotated between retries, so openings do not repeat, but the same repository
  and attempt always produce the same script.
- Kokoro TTS runs locally with `am_fenrir` at speed `1.0` in American English.
  The preset is configured in one place (`VOICE_PRESET` in `src/config.ts`)
  and recorded into every run's `render-metadata.json`. `am_fenrir` won the
  identical-script audition against `am_liam`, `am_puck` and `am_michael`
  (`tools/audition/`, speed variants 1.00/1.05 included); tune delivery, not
  voices. The writing carries the delivery: short sentences, concrete claims,
  contractions and punctuation pauses. Kokoro has no emotion/voice-design
  control, and this pipeline does not pretend otherwise. Re-run
  `npm run voice:audition` before changing the channel default.
- Captions and speech are separate. Captions use `captionText` exactly as
  authored; only speech passes through `src/tts-text.ts`. That boundary removes
  Markdown, fenced code, URLs and raw command syntax and expands versions,
  dates, times, percentages and technical acronyms before Kokoro sees them.
- Narration never sends README prose, Markdown, code, URLs or metadata directly
  to Kokoro. The rule-based compiler writes a short sentence first; the speech
  normaliser is a safety net, not a second writer.
- The installed Kokoro model exposes no duration predictor, so caption timing
  uses measured per-chunk audio durations with syllable and punctuation weighting.
  There is no exact word-level alignment claim; phrase boundaries are estimated
  inside a measured segment. Phoneme timings are used automatically if a model
  provides them.
- Audio duration is authoritative for the final timeline. A script that runs
  long is shortened and regenerated, never sped up. Every sentence is timed by
  the synthesizer's measured output — fixed per-sentence durations are never
  assigned — and captions, scroll and gestures are rebuilt from those timings.
- A structural gate runs before TTS (`src/narration-ir.ts`): every script must
  compile to a narration that states the repository purpose, explains how it
  works, and gives a practical use case. Popularity metadata (stars, forks,
  license) may not exceed 35% of narration words when real explanation evidence
  exists. Claims are only made from ledger facts; where evidence is missing the
  section is omitted rather than invented, and the gate records the omission
  rationale instead of allowing filler.

## 11. Visual composition

- 1080 x 1920, 9:16, solid `#F2EFE9` background.
- One upright `#0D1117` card, 810 x 1668 px, 28 px radius, neutral multi-layer
  shadow. No tilt, phone frame, scenery, or neon glow.
- The repository content is a **real mobile-width screenshot** of the public
  GitHub page: 405 x 720 CSS px at device scale factor 2, captured once and
  normalized to the 810 px card width. It is one tall image, not a rebuilt
  desktop mock.
- The card, browser bar, caption overlay and character stay stationary. Only the
  tall page image is translated inside a clipped 810 x 1584 viewport.
- The story is cropped to the last narrated section, the scroll-speed budget and
  a five-viewport cap. If the install section sits farther down than the budget
  allows, the video ends earlier instead of racing.
- GitHub's mobile DOM does not always expose a `features` heading. The scroll
  planner falls back to the README intro so a feature tour does not park on the
  file list.
- Captions are 42 px bold white text with selective `#FFD629` highlights, seated
  over the lower-middle of the page with an outline and shadow. Phrases break at
  strong clause marks and wrap to at most two lines. No filled word boxes, no
  progress bar, no scrubber.
- The presenter is a configurable mascot layer (`MASCOT_LAYOUT` in
  `src/config.ts`), sized by **width ratio of the 1080 px canvas** (0.46 =
  497 px) and anchored to the lower-right **canvas corner**, not the card. It
  overlaps the card, may extend past the right and bottom canvas edges
  (`allowOffscreen`; the viewport clip crops it at the canvas boundary, never
  inside a small container), and a `keepFaceVisible` guard prevents extreme
  sizes from pushing the head out of frame. Pose selection is narration-driven:
  `present` for the introduction, `point` when explaining a feature or install
  step, and `close` for the CTA. Framing and a small lean change with the role;
  body bob and tilt follow the measured speech envelope. A missing asset
  disables the layer without failing the run.
- Scroll scheduling includes a travel-time pass: a narrated section whose
  speech hint arrives earlier than the speed ceiling permits is reached **late
  in full** rather than stopped halfway. The measured audio timeline is the
  single source for caption, scroll and gesture timing, in this order:
  generate + validate narration → synthesize → measure durations → align
  captions → schedule scroll reveals → trigger gestures → render + validate.
- `assets/character-close.png` is a medium close-up crop of the same supplied
  artwork. It keeps the face and hands in frame at the CTA. The artwork contains
  a single pose, so the renderer does not invent arm or hand articulation. Real
  pointing/gesture art can be dropped in through `SHOWCASE_CHARACTER_POINT_PNG`
  / `SHOWCASE_CHARACTER_CLOSE_PNG` without code changes. This is presenter
  motion, not lip-sync or skeletal animation.

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
- Primary mode uses a real mobile-width screenshot of the public repository
  page. The DOM fallback (used only when that capture fails) is built from
  repository data, so its layout is an approximation.
- Automatic discovery is heuristic. Review the repository and generated claims
  before publishing.
- GitHub unauthenticated API rate limits apply; set `GITHUB_TOKEN` to raise them.
- The first run depends on your local Chrome, FFmpeg, Python and Kokoro setup.