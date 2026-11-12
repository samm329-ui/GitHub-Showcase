# GitHub Showcase Generator

A local, zero-cost pipeline that discovers a GitHub repository and turns it into
a narrated, captioned, 9:16 showcase video.

**Input:** a GitHub repository URL, or automatic discovery mode (`--discover`)
**Output:** `output/<owner>-<repo>-<runId>.mp4` plus a per-run artifact directory in `temp/`
**Stack:** TypeScript/Node.js, GitHub REST API, Groq (groq.com) for narration, Kokoro TTS, Chromium (CDP), FFmpeg, `node:sqlite`
**No:** paid subscriptions beyond a free Groq API key, n8n, Playwright, local LLM

## 1. Requirements

- Node.js 22.5 or newer (the project uses the built-in `node:sqlite`)
- Google Chrome, Chromium, or Microsoft Edge
- FFmpeg and `ffprobe` available in `PATH`
- Python 3.9 or newer with `kokoro-onnx` and `soundfile` installed
- A free Groq API key (https://console.groq.com/keys) — the narration script is written by Groq
- A GitHub token in `GITHUB_TOKEN` (raises the GitHub API rate limit)
- Internet access for GitHub, Groq and loading the repository page

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

Both API keys are read from `.env` in the repository root (see `.env.example`), or
from the shell — the file is gitignored and never committed. `run.bat` and the
pipeline entry point load it automatically; a shell-exported value always wins
over the file:

```bash
GITHUB_TOKEN=ghp_...
GROQ_API_KEY=gsk_...
```

`GITHUB_TOKEN` raises GitHub's anonymous rate limit; `GROQ_API_KEY` is required
for the default (Groq) narration writer. Set `SHOWCASE_SCRIPTER=rule` to use the
legacy offline writer instead (no key needed).

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

Video length is configurable per run with `--length` (18–58 seconds, default 35):

```bash
npm run start -- --repo owner/repo --length 45
npm run start -- --discover --length 58
```

## 6. Discover a candidate repository automatically

```bash
npm run start -- --discover
```

It runs a rotating set of discovery modes (practical, underdog, popular, emerging,
topic-specific), applies hard rejection gates and a transparent 0-100 score, and
picks the best eligible, never-before-completed repository. Repositories in
**priority categories** — AI agents, finance, AI/ML, and innovative technology —
receive a score boost (up to +10) so they surface more often; the boost never
bypasses the hard rejection gates. Use `--dry-run` to
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
| `SHOWCASE_TARGET_SECONDS` | 35 | Target narration length (`--length` wins when set) |
| `SHOWCASE_FPS` | 30 | Output frame rate |
| `SHOWCASE_TEMP_DIR` | `temp/` | Working directory for run artifacts |
| `SHOWCASE_OUTPUT_DIR` | `output/` | Final MP4 directory |
| `SHOWCASE_DB` | `output/showcase-history.db` | SQLite history database |
| `SHOWCASE_MIN_SCORE` | 65 | Eligibility threshold for discovery |
| `GROQ_API_KEY` | (none) | **Required** (default writer) Groq API key from console.groq.com |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq chat model (free tier: try `openai/gpt-oss-20b` if you hit 429s) |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Groq API base URL |
| `GROQ_TIMEOUT_MS` | 60000 | Per-request timeout |
| `GROQ_MAX_RETRIES` | 3 | Retries after the initial attempt (429/backoff honoured) |
| `GROQ_MAX_TOKENS` | 3000 | Completion token cap (reasoning + script; the script itself is ~1k) |
| `GROQ_REASONING_EFFORT` | `low` (gpt-oss only) | `medium`/`high`/`off` — `off` removes the field entirely |
| `GROQ_MAX_INPUT_CHARS` | 4500 | README is trimmed to this before the prompt |
| `GROQ_MAX_PROMPT_FACTS` | 30 | Fact-ledger payload cap (highest-confidence first) |
| `SHOWCASE_SCRIPTER` | `llm` | `llm` = Groq writer; `rule` = legacy offline composer |
| `SHOWCASE_SCRIPTABILITY_GATE` | `0` | `1` restores the old hard scriptability skip |
| `KOKORO_VOICE` | `am_fenrir` | Kokoro voice id (locked audition winner, young developer delivery) |
| `KOKORO_SPEED` | `1.0` | Kokoro speed (natural conversational pace) |
| `KOKORO_LANG` | `en-us` | Kokoro language code |
| `KOKORO_MODEL` | `tools/kokoro/kokoro-v1.0.int8.onnx` | Kokoro model file |
| `KOKORO_VOICES` | `tools/kokoro/voices-v1.0.bin` | Kokoro voices file |
| `SHOWCASE_MASCOT_WIDTH_RATIO` | `0.8731` | Presenter width as a fraction of the 1080 px canvas (943 px) |
| `SHOWCASE_MASCOT_OFFSET_X` | `-60` | Presenter `right` CSS offset (negative extends past the canvas edge) |
| `SHOWCASE_MASCOT_OFFSET_Y` | `462` | Presenter `bottom` offset; part of the Instagram-safe mascot/bubble/caption group (bottom-safe) |
| `SHOWCASE_CAPTION_TOP_PX` | `1388` | Caption panel `top`; same Instagram-safe group as the mascot/bubble |
| `GITHUB_TOKEN` | (none) | Raises the GitHub API rate limit |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | Chrome DevTools endpoint |
| `SHOWCASE_CHARACTER_PNG` | `assets/character.png` | Primary transparent presenter; `none` disables the layer |
| `SHOWCASE_CHARACTER_POINT_PNG` | `assets/character.png` | Optional pointing pose; falls back to the primary cut-out |
| `SHOWCASE_CHARACTER_CLOSE_PNG` | `assets/character-close.png` | Optional medium CTA pose |
| `SHOWCASE_CALLOUT_PNG` | `assets/callout-bubble.png` | Speech bubble shell; transparent background with separate copy |
| `SHOWCASE_SFX_MASCOT` | `1` | `0` disables the mascot slide-in entrance sound effect |
| `SHOWCASE_SFX_CALLOUT` | `1` | `0` disables the callout bubble pop sound effect |

The product rule is a hard maximum of 58 seconds.

## 9. Output

- Final MP4: `output/<owner>-<repo>-<runId>.mp4`
- Per-run artifacts: `temp/<owner>-<repo>-<runId>/`
  - `repository.json`, `selection.json`, `facts.json`, `narration.json`, `timeline.json`
  - `llm-prompt.json`, `llm-response.json`, `llm-script.json` — the exact Groq
    request, the raw completions (with token usage), and the sanitized plan
    (`SHOWCASE_SCRIPTER=llm` only)
  - `explanation-plan.json`, `script-quality.json` — the legacy rule-based
    writer's artifacts (`SHOWCASE_SCRIPTER=rule` only)
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

**Default writer: Groq (`SHOWCASE_SCRIPTER=llm`).** The script is written by a
Groq chat model in a single request per video, grounded on the typed fact
ledger (purpose, features, use cases, install, license, activity, release —
with provenance), the repository metadata, a trimmed README excerpt
(`GROQ_MAX_INPUT_CHARS`) and the requested length budget. The model is told to
open with the name and one-line purpose, explain the mechanism before any
metrics, give one concrete use case, keep commands spoken-as-words, and to
never invent claims. It returns JSON segments, which are sanitized (unknown
purposes coerced, terminal punctuation repaired) and mapped onto the same
`NarrationPlan` the rest of the pipeline consumes — Kokoro, captions, callouts,
scroll, QA all work unchanged. Example:

- One request per video (plus at most one "shorten it" retry when the draft
  overshoots the 58-second ceiling); token usage is logged on every call.
- Rate-limit discipline: `Retry-After` is honoured on HTTP 429 and used as a
  floor, otherwise exponential backoff with full jitter (3s → 6s → 12s),
  other 5xx get one retry, 4xx fails fast. Retries are capped by
  `GROQ_MAX_RETRIES` (default 3). If the free-tier budget is exhausted the
  run fails loudly; point `GROQ_MODEL` at a lighter model (e.g.
  `openai/gpt-oss-20b`) if that keeps happening.
- Minimal gates by design: the LLM path requires parseable JSON, 3+ usable
  segments, and estimated duration ≤ 58s. The legacy citation/repetition
  gates do not run on this path. If Groq errors or the draft is
  unrecoverably over-long, the run fails loudly — there is no silent
  fallback.
- `SHOWCASE_SCRIPTER=rule` reproduces the legacy writer exactly: a typed fact
  ledger feeds a constrained story grammar (`identity → value → proof/demo →
  setup → availability → caveat → cta`), evidence-ranked clauses and a quality
  gate before TTS.
- Priority categories: finance, AI/ML, AI agents and innovative technology
  repositories receive a discovery score boost (max +10, `priority`
  breakdown dimension). The boost never bypasses the hard rejection gates.
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
- A structural gate runs before TTS (`src/narration-ir.ts`) on the **legacy
  writer** (`SHOWCASE_SCRIPTER=rule`): the script must compile to a narration
  that states the repository purpose, explains how it works, and gives a
  practical use case. Popularity metadata (stars, forks, license) may not
  exceed 35% of narration words when real explanation evidence exists. The
  Groq writer does not run this gate; its contract is parseable JSON plus the
  58-second ceiling.

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
  `src/config.ts`), sized by **width ratio of the 1080 px canvas** (0.8731 =
  943 px) and anchored to the lower-right **canvas corner**, not the card. It
  overlaps the card, enters from the bottom-right and settles smoothly within
  the first 380 ms. Pose selection is narration-driven:
  `present` for the introduction, `point` when explaining a feature or install
  step, and `close` for the CTA. Framing and a small lean change with the role;
  body bob and tilt follow the measured speech envelope.
- **Animated Comic Speech Bubble Callouts**: Multi-cue callout system scheduled
  chronologically across the timeline (`src/callout-overlay.ts`). Derives short,
  concise, evidence-backed headlines from verified proposition roles (purpose,
  mechanism, workflow/example, benefit). The bubble shell uses a transparent PNG
  with separate rendered text. Bubble placement and safe text bounding box are
  asset-aware (`CalloutAssetProfile`), precisely targeting the mascot's head
  anchor across per-frame animated bobs and leans while respecting face/glasses
  protection and caption collision bounds.
- **Mascot Comic Impact Accents**: Dynamic yellow SVG strokes (`src/impact-accents.ts`)
  authored with varied ray, spark and sweep shapes. Bursts are scheduled with
  reproducible seeded jitter at semantically meaningful beats (idea presentation,
  bubble entrance), rendering on independent rear and front SVG layers without
  obscuring text or mascot facial features.
- **Live Preview & Visual Tuning**: Double-click `Save My Edits.vbs` (or `Save My Edits.cmd`,
  or `npm run preview:launch`) to tweak mascot sizing, shadow, caption panel, callout
  typography, timing and impact strokes with deterministic sliders, one-click
  bidirectional save, live Instagram Reels safe zones and a mock Reels overlay
  (top bar, action rail, caption bar) — the mascot, speech bubble and caption
  panel ship positioned as one Instagram-safe group (`MASCOT_LAYOUT.offsetY`,
  `CAPTION_OVERLAY.topPx`) so subtitles never hide behind the Reels caption bar.
  The preview page shows the exact JSON that gets written back to
  `src/config.ts`, `src/caption-overlay.ts` and `src/card.ts`.
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
npm run start:news      # Lazy News channel (see §14)
npm run news:prepare-assets  # Cut RGBA layers from Lazy news.zip artwork
npm run news:selftest-alignment   # Alignment structural self-check
```

## 14. Lazy News (second channel)

The same automation engine powers a second show: one story per episode, English only, non-commercial. It is NOT a genre fork — it is the same pipeline with a different content-intelligence stage (discover → corroborate → ledger → script), a different presenter (the lazy office commentator from `assets/lazy-news/`), and the same rules: Kokoro voice, measured audio timeline, captions/waveform from alignment, Chromium→FFmpeg render, QA, SQLite history.

**How it works**

`run.bat` → choose `[1] GitHub Repository Showcase` (launches Chrome on port 9222 exactly as before) or `[2] Lazy News Commentary` (uses its own headless Chromium — evidence on 9223, render on 9224 — and never touches the GitHub Chrome window). Direct invocations also work: `run.bat github --repo owner/name`, `run.bat news --topic ai --discover`, and legacy `run.bat --discover` still routes to the GitHub channel with Chrome launched.

```bash
npm run start:news -- --discover --topic ai          # discover + shortlist from permitted sources
npm run start:news -- --url https://pib.gov.in/...    # story from a permitted primary source
npm run start:news -- --url <url> --dry-run           # artifacts + reports, no media
npm run start:news -- --approve A --run-dir temp/news-<slug>   # Gate A (facts)
npm run start:news -- --resume temp/news-<slug>                 # resume after Gate A → Gate B
npm run start:news -- --approve B --run-dir temp/news-<slug>   # Gate B (script + voice)
npm run start:news -- --resume temp/news-<slug>                 # render + QA → output/news/
npm run start:news -- --skip-audio --resume temp/news-<slug>    # re-render without re-synthesizing
```

**Two mandatory human gates before rendering.** Gate A (factual package) and Gate B (script + voice) block the render under every configuration; Gate C (final MP4 preview) blocks publication. No environment variable bypasses them. Approvals are recorded in `gate-approvals.json` with a SHA-256 of the exact payload shown.

**Evidence before writing.** Discovery (RSS/GDELT/Bluesky) is a signal layer only. The script may only use facts that passed a claim-level ledger verifier: every number/date/name/quote must appear in collected evidence from **permitted primary records** (Government of India, RBI, MEA, Sansad, ECI, Supreme Court, UN, SEC EDGAR, company newsrooms, arXiv). Every enabled source has an individual policy with an explicit `permissionBasis` (`public_domain | explicit_license | written_permission | terms_reviewed | discovery_only`); `config/news-sources.json` lists them. BBC/Guardian-style discovery sources can never reach evidence or the Groq prompt. Groq never touches the evidence: atomic claims are extracted deterministically (`src/channels/news/claims.ts`, verbatim rule grammars) and decided by the deterministic claim-level verifier; Groq writes only the narration script. `--assist claims` re-enables LLM claim proposals for comparison, but it is off by default. You approve what is safe to say.

**Alignment.** `tools/align_audio.py` aligns the approved transcript against `narration.wav` with a transcript-conditioned forced aligner (WhisperX/Montreal Forced Aligner preferred; `faster-whisper` CTranslate2 fallback, installed via `pip install faster-whisper`). ≥99% token coverage is enforced; monotonicity is mandatory; missing words are listed, never silently interpolated. Captions & callouts burn at the measured word onsets.

**Scene.** 941×1672 native artwork (`assets/lazy-news/original/`), RGBA-cut layers (`tools/prep_lazy_news_assets.py` — never use a global white color key; the white shirt/paper must survive). Opening has the headline on the noticeboard; `narration_focus` dims/blurs only the background group; `board_callout` restores it with a type-on reveal and yellow marker strip; sticky notes drift at independent phases; the narrator enters from the left and idles. Export 1080×1920 H.264/yuv420p, 30 fps, ~49 s episode, `-16 LUFS` loudnorm.

**Discovery vs evidence, honestly:** `--discover` uses RSS on registered outlets (BBC, Guardian, AJ, NPR, CNBC, and the now-registered `economictimes.indiatimes.com` / `thehindu.com` for non-commercial commentary with on-screen attribution). Outlets whose article text is not licence-cleared never reach evidence or Groq — instead the episode rides on their **metadata** (title + one-line description) and every claim stays attributed to the outlet ("according to BBC…"). The pipeline never fetches, quotes or cites what it is not permitted to use.

**JS-rendered stories:** if the article body is loaded by the client (Economic Times, many news sites), the collector first tries JSON-LD `articleBody` extraction, then falls back to headless Chromium (`NEWS_EVIDENCE_PORT`, default 9223) `document.body.innerText`. Frame capture uses a separate headless Chromium (`NEWS_RENDER_PORT` / `NEWS_CHROME_DEBUG_URL`, default `http://127.0.0.1:9224`) — neither touches the GitHub channel's port-9222 Chrome. No paywall, 403 or CAPTCHA bypass exists anywhere in the code; failures are loud.

**Outputs:** `output/news/<slug>-<runId>.mp4` and the full episode audit bundle in `temp/news-<slug>/` (evidence ledger, source records, script, gate approvals, alignment, QA).

**Editing:** unlike the GitHub mascot preview, v1 tuning is code-driven (`config/news-scene.json` is read by the renderer via `scene.ts`); a `--skip-audio` fast pass makes visual iterations ~90 s. An interactive news preview page is a planned follow-up.

See `docs/Lazy_News_Detailed_Implementation_Plan.md` (FINAL IMPLEMENTATION SPECIFICATION) for the full specification, legal source policies, gates, acceptance criteria and phase plan.

## 13. Known limitations

- Narration is written by Groq (`SHOWCASE_SCRIPTER=llm`, the default). It is
  grounded on the typed fact ledger and the README excerpt, but unlike the
  legacy rule-based writer it is not fact-citation-gated — the prompt's
  no-invention rule is the guardrail, and `llm-prompt.json` /
  `llm-response.json` in the run directory record exactly what the model saw
  and said. Set `SHOWCASE_SCRIPTER=rule` for the deterministic offline writer
  (no API key, no non-determinism, duller copy).
- Groq output is non-deterministic: the same repository can produce a
  different script on re-run. The script hash recorded in history is still
  stable per output, not per input.
- Priority discovery is heuristic (topics + description keywords); a priority
  repository with an unparsable README can still lose to a stronger generic
  one, and a non-priority repository can still win outright.
- "Trending" is never claimed without dated star snapshots.
- Primary mode uses a real mobile-width screenshot of the public repository
  page. The DOM fallback (used only when that capture fails) is built from
  repository data, so its layout is an approximation.
- Automatic discovery is heuristic. Review the repository and generated claims
  before publishing.
- GitHub unauthenticated API rate limits apply; set `GITHUB_TOKEN` to raise them.
- The first run depends on your local Chrome, FFmpeg, Python and Kokoro setup.