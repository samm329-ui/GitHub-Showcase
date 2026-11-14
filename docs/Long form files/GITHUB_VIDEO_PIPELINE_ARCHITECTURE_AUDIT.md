# GitHub Video Automation Pipeline — Architecture Discovery Audit

**Stage:** Stage 1 — Architecture Discovery Audit (baseline for PRD → TRD → Implementation Plan)
**Audience:** Engineers preparing the Long-form YouTube production mode PRD
**Date:** 2026-11-13
**Scope:** READ-ONLY investigation of the repository at `D:\github-showcase` ("github-showcase", v1.1.0). No source code, configuration, tests, or assets were modified. No dependencies were installed. Nothing was implemented.
**Method:** Direct source-code inspection (all files under `src/` read or grep-verified), docs inspection, read-only queries against the SQLite history DBs, `npm test` and `npm run check` executed. Claims are cited to file paths and function/class names. Unverified or conflicting areas are labelled explicitly.

---

## A. Executive Summary

### What this system is

A **local, terminal-driven, zero-paid-cost video automation studio** that turns either a GitHub repository (channel 1) or a news topic/URL (channel 2) into a narrated, captioned, vertical (9:16, 1080×1920) short-form MP4. It renders **one stationary phone-style card containing a real mobile-width screenshot of the repository page**, with a mascot cut-out, caption overlay, comic speech-bubble callouts, impact accents and sound effects, all driven by a **single measured-audio timeline** (synthesized narration is the timing source of truth).

Two channels share one engine:

| Channel | Entry | Status | Output |
|---|---|---|---|
| GitHub Repository Showcase | `npm run start -- [--discover|--repo …]` (`tsx src/index.ts`) | **Working** (86 MP4s in `output/`, 85 repositories `completed` in history DB as of 2026-11-13) | `output/<owner>-<repo>-<runId>.mp4`, ~18–58 s |
| Lazy News Commentary | `npm run start:news -- …` (`tsx src/channels/news/index.ts`) | Implemented; five MP4s in `output/news/`; mandatory human Gates A/B/C | `output/news/<slug>-<runId>.mp4`, ~≤90 s |

### Architectural shape

- **Runtime:** Node.js ≥ 22.5 (v24.12.0 installed), TypeScript (ESM), executed through `tsx`. Only **two runtime dependencies**: `canvas` (node-canvas, image stitching) and `chrome-remote-interface` (CDP). No framework. `node:sqlite` (built-in) is the persistence layer.
- **Content intelligence:** GitHub REST API (discovery, hydration, scoring) → typed **fact ledger** → **Groq** (chat completions, OpenAI-compatible, default model `openai/gpt-oss-120b`, JSON mode, one request per video + at most one shorten retry) → **`NarrationPlan`** (segments with spoken text, caption text, visual anchors, callout copy, per-segment pause schedule).
- **Voice:** Local **Kokoro v1.0 ONNX TTS** (`tools/python/kokoro-tts.py`), one Python subprocess per narration *segment*; measured per-chunk durations (ffprobe) concatenated into one `narration.wav`; `am_fenrir` @ 1.0 American English. Captions are phrase-level with **syllable-weighted word timing estimated inside measured phrases — there is no word-level alignment on the GitHub channel** (the News channel has real forced alignment via `tools/python/align_audio.py`).
- **Visuals:** The repository page is captured **once** as a true mobile-width screenshot (405 CSS px @ DPR 2 → normalized to 810 px) through headless Chromium over CDP; the render is **per-frame CDP screenshots of static 1080×1920 DOM** piped into FFmpeg (`-f image2pipe`, libx264, yuv420p, AAC 192 kbps 48 kHz, loudnorm −16 LUFS). Frames are **not** written as files (GitHub channel); the News channel writes frames to disk and encodes in a second pass.
- **History:** Two separate SQLite DBs (`db/showcase-history.db`, WAL; `db/news-history.db`) — never cross-opened.
- **Tests:** **532 passing, 0 failing** (`npm test`, 111 suites, ~10 s). `tsc --noEmit` clean (`npm run check`). Tests exercise the GitHub and News business logic with mocks/fixtures; the real browser/TTS/FFmpeg path is not covered by automated tests.
- **`docs/future-pipelines.md` (dated 2026-11-13) is an assessment-only roadmap** for "Pipeline 3" (long YouTube compilation of top-5 GitHub repositories, 16:9 expected, ≤ ~58 min) and "Pipeline 4" (weekly news compilation). **Nothing for long-form exists in code.** There are zero references to 16:9, landscape or 1920×1080 anywhere in `src/`, `tools/` or `tests/`. README, config, launchers, card geometry, mascot offsets, caption geometry, QA dimensions and the FFmpeg filter graph are all hardcoded around 1080×1920.

### Bottom line for Long-form feasibility

The engine has **reusable organs** (Groq client, dataset archive, Kokoro TTS + measured timeline, caption/scroll keyframe builders, SFX mixing, CDP capture, QA probe) but **no long-form body**: it cannot render 16:9, has no multi-repository episode concept, no compilation/no-repeat ledger, no background music, no source-file browsing, no README-line highlighter, no countdown layout, and silently clamps any render at **58 seconds** (`MAX_DURATION_SECONDS`). The shortest honest summary of the gap: *"one clip, one repo, one speaker, ~35–58 s, 9:16"* (as `docs/future-pipelines.md` puts it) — feasible to extend, nowhere near supported today.

---

## B. Technology Stack

### Languages & runtimes

| Item | Version / detail | Source |
|---|---|---|
| Node.js | **v24.12.0** installed; `engines: node >= 22.5.0` (uses built-in `node:sqlite`) | `package.json`, `node --version` |
| TypeScript | ^5.7.3, `type: "module"` ESM | `package.json` |
| tsx (dev runner) | ^4.19.3 | `package.json` |
| @types/node | ^22.13.4 | `package.json` |
| Python | 3.9+ expected; repo-local `.venv` auto-detected | `install/python.*`, `src/python.ts`, `requirements.txt` |
| FFmpeg / ffprobe | **8.1.2-essentials_build** installed on this machine | `ffmpeg -version` |
| npm | bundled with Node | — |

### Key libraries

| Library | Purpose | Source |
|---|---|---|
| `canvas` ^3.2.3 | Decode/stitch/crop the mobile page capture (JPEG normalization to 810 px) | `src/mobile-capture.ts` |
| `chrome-remote-interface` ^0.33.3 | CDP client to Chrome/Chromium/Edge (typed) | `src/cdp.ts` |
| `node:sqlite` (`DatabaseSync`) | History/ledger persistence (WAL on the GitHub DB) | `src/history.ts`, `src/channels/news/history.ts` |
| `numpy`, `scipy`, `soundfile`, `Pillow`, `kokoro-onnx` ≥0.4 | Kokoro wrapper + asset prep + audio alignment | `requirements.txt` |
| `faster-whisper` ≥1.0 | Fallback forced aligner for the News channel (WhisperX preferred, unpinned) | `requirements.txt`, `tools/python/align_audio.py` |

### External services

| Service | Use | Config |
|---|---|---|
| GitHub REST API (`https://api.github.com`) | Search, repo, README (raw), languages, releases, commits, contents | `GITHUB_TOKEN` optional (raises 60/h anonymous limit); headers `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: github-showcase` — `src/github.ts` |
| Groq (`https://api.groq.com/openai/v1`, OpenAI-compatible `/chat/completions`) | Narration script writing (default writer) | `GROQ_API_KEY` required; `GROQ_MODEL` default `openai/gpt-oss-120b`; `GROQ_BASE_URL`, `GROQ_TIMEOUT_MS=60000`, `GROQ_MAX_RETRIES=3`, `GROQ_MAX_TOKENS=3000`, `GROQ_MAX_INPUT_CHARS=4500`, `GROQ_MAX_PROMPT_FACTS=30`, `GROQ_REASONING_EFFORT=low` (gpt-oss only), `GROQ_API_KEYS` (comma-separated rotation, 429-driven) |
| Kokoro v1.0 ONNX (local) | TTS | `models/kokoro/kokoro-v1.0.int8.onnx` + `models/kokoro/voices-v1.0.bin` (~115 MB, downloaded by `install/python.*`); `KOKORO_MODEL`/`KOKORO_VOICES` overrides |
| GitHub web (mobile HTML) | The real repository page screenshot (405 CSS px viewport) | Via CDP; `SHOWCASE_CAPTURE_COLOR_SCHEME=dark` |
| Chromium/Chrome/Edge | Render DOM + capture | CDP port **9222** (GitHub); **9223/9224** (News) |

### Media pipeline facts (verified)

- Video: H.264 High@L4.0, `yuv420p`, BT.709, tv-range, `-movflags +faststart`, CFR at `FPS=30` (`SHOWCASE_FPS` override), CRF 19 default, preset `medium`, `-threads` default. `-vf scale=out_range=tv,format=yuv420p`, `loudnorm=I=-16:TP=-1.5:LRA=11`.
- Audio: AAC 192 kbps, 48 kHz **stereo**, loudness normalized to −16 LUFS.
- Kokoro output: mono WAV PCM (Kokoro default 24 kHz; sample rate taken from the actual file via ffprobe, never assumed).
- Container: MP4.
- Resolution/aspect: **1080×1920 only** (`VIEWPORT` in `src/config.ts:66`).

### Tooling inventory

- Installers: `install/node.bat|sh|command`, `install/python.bat|sh|command` (check Node ≥ 22.5, `npm install`, `npm run check`; venv + `pip install -r requirements.txt`; Kokoro model download).
- Launchers: `run.bat` (Windows, finds Chrome/Edge, checks ffmpeg/ffprobe/python, sets env, interactive menu), `run.sh` (Linux/macOS), `run.command` (macOS Finder shim → `run.sh`). Direct-argument pass-through: `run.bat github --repo o/n`, `run.bat news --topic ai --discover`.
- Preview/tuner: `tools/preview/` (live browser tuning, writes `visual-overrides.json` at repo root; merged at startup by `src/visual-overrides.ts`; precedence env → file → committed default).
- Python tooling: `tools/python/kokoro-tts.py`, `kokoro-audition.py`, `align_audio.py`, `prep_lazy_news_assets.py`; `tools/run-python.mjs` npm shim.
- Dataset CLI: `tools/scripts-dataset.ts` (`npm run scripts:list|scripts:show`).
- Windows Chrome launcher: `tools/windows/launch-github-chrome.ps1`; POSIX: `tools/launch-github-chrome.sh`.

---

## C. Project Structure

Focused view (generated/dependency directories elided: `node_modules/`, `.venv/`, `vendor/`, `models/`, `samples/`, `output/`, `temp/`, `db/*.db`, `dataset/*` are gitignored runtime state):

```
D:\github-showcase
├── run.bat / run.sh / run.command          # terminal launchers (two channels + menu)
├── package.json / package-lock.json        # Node deps + scripts (start, test, check …)
├── tsconfig.json / tsconfig.check.json     # TS config (ESM, strict)
├── requirements.txt                        # Kokoro + alignment Python deps
├── .env.example                            # documented variable names (no values here)
├── README.md / NOTICE / LICENSE            # docs; fonts & SFX licence notes
├── install/                                # one-click installers per OS
├── src/                                    # the pipeline engine (TypeScript, ESM)
│   ├── index.ts                            # GitHub pipeline entry (main) · 976 lines, Stages 1–9
│   ├── config.ts                           # all constants/policy (VIEWPORT 1080×1920, MAX_DURATION_SECONDS 58, …)
│   ├── types.ts                            # shared domain types (the contracts between stages)
│   ├── load-env.ts                         # .env loader (shell wins)
│   ├── github.ts                           # GitHub REST: discovery, hydration, scoring, hard-reject gates
│   ├── facts.ts                            # typed fact ledger builder (46 KB)
│   ├── narration.ts                        # legacy validator/selectAngle/wordCount
│   ├── script-composer.ts                  # legacy rule-based writer (SHOWCASE_SCRIPTER=rule)
│   ├── llm-script.ts                       # Groq writer (default): prompt build, sanitize, NarrationPlan
│   ├── groq.ts                             # minimal Groq client: retries, 429 Retry-After, key rotation
│   ├── narration-grammar.ts / narration-ir.ts / narrative-graph.ts / explanation-planner.ts / scriptability.ts / script-quality.ts / script.ts
│   ├── pronunciation.ts / tts-text.ts      # speech normalization (captionText is never normalised)
│   ├── voice.ts                            # Kokoro synthesis, concat, pause schedule, measured timelines
│   ├── timeline.ts                         # buildCaptions, buildScrollKeyframes, scrollAt, easing
│   ├── captions.ts                         # ASS export (optional)
│   ├── caption-overlay.ts / callout-overlay.ts / impact-accents.ts / character-motion.ts / mascot-layout.ts
│   ├── card.ts / browser-capture.ts / mobile-capture.ts / asset-server.ts / cdp.ts / chrome-paths.ts
│   ├── render.ts                           # encoding entry (renderVideo → renderCardVideo)
│   ├── qa.ts                               # ffprobe validation, not-black, motion, loudness, callout checks
│   ├── sfx.ts                              # SFX scheduling + amix mixing (no BGM)
│   ├── history.ts                          # HistoryStore (node:sqlite): repositories, star_snapshots, pipeline_runs
│   ├── script-dataset.ts                   # the script archive (dataset/github|news + index.jsonl)
│   ├── visual-overrides.ts / font-faces.ts / scroll.ts / scroll-choreography.ts / facts.ts …
│   └── channels/news/                      # Lazy News channel (fully separate pipeline)
│       ├── index.ts                        # News entry (stages, Gates A/B/C)      · 38 KB
│       ├── research-agent.ts / discovery.ts / inshorts.ts / clustering.ts / sources.ts / ledger.ts / claims.ts / perspectives.ts / auto-gates.ts / approvals.ts / history.ts / captions.ts / alignment.ts / scene.ts / scene-events.ts / render-news.ts / credits.ts / script.ts / types.ts / news history & pipeline_runs
│       └── production/                      # designed, tested, UNUSED by any renderer (news-only)
│           ├── types.ts frame-clock.ts easing.ts keyframe-evaluator.ts animation-clip.ts audio-registry.ts timeline-compiler.ts production-validator.ts index.ts
├── tools/                                  # preview tuners, python wrappers, scripts-dataset CLI
├── tests/                                  # 48 test files, 532 tests (all pass)
├── dataset/                                # github/ (9 records, all completed) · news/ (11 records, 3 completed) · README.md
├── db/                                     # showcase-history.db · news-history.db · README.md (gitignored)
├── config/news-sources.json                # 45 KB source permission registry
├── assets/                                 # github/ (presenter, callout, sfx) · news/ (layers) · shared/ (fonts)
├── docs/                                   # architecture.md, configuration.md, lazy-news.md, future-pipelines.md (roadmap), lazy-news-production.md, news-*.md, archive/ (historical)
├── output/                                 # 86 GitHub MP4s + output/news/ (5) · temp/ (202 run dirs)
└── News assets/                            # raw "Lazy news.zip" (gitignored)
```

---

## D. Component Inventory

### D.0 Reading the inventory

Status legend: **Working** = exercised end-to-end in production runs on this machine · **Working (tested)** = covered by automated tests and used in production · **Implemented, unverified in production** = code exists and unit tests pass, but no shipped video proves it · **Legacy/optional** = kept for A/B or fallback · **Unused in render path** = designed/tested, wired to nothing.

### D.1 GitHub channel — engine modules

| Module (`src/`) | Responsibility | Entry points (exact) | Inputs → Outputs | Key dependencies | Communicates with / status |
|---|---|---|---|---|---|
| `index.ts` | Pipeline orchestrator (Stages 1–9), run logging, reservation, QA gate, history finalization | `main()` (entry via `npm run start`) | CLI args → artifacts in `temp/<slug>-<runId>/` + `output/*.mp4` | nearly everything below | Drives all others · **Working** |
| `github.ts` | GitHub REST: discovery queries, hydration, README analysis, 0–100 scoring, hard-reject gates, priority-category boost | `discoverRepos`, `enrichRepo`, `getRepo`, `analyzeReadme`, `scoreCandidate`, `hardReject`, `parseRepoArg`, `TOPIC_ROTATION`, `MODE_ROTATION` (in config/github) | search queries → `Repo[]`, `EnrichedRepo`, `CandidateEvaluation` | `fetch`, GitHub API, `MIN_SCORE` | index.ts, facts.ts, scriptability.ts · **Working** |
| `facts.ts` (46 KB) | Typed **fact ledger** builder: deterministic extraction (API fields, README sections/code/tables, releases, star snapshots), provenance, confidence | `buildFactLedger(repo, {previousStars…})` | `EnrichedRepo` → `FactLedger` | `types.ts` | index.ts, llm-script.ts, script-composer.ts, scriptability.ts · **Working** |
| `llm-script.ts` | **Default writer (Groq)**: system/user prompt build, response sanitize (purposes/anchors coerced, terminal punctuation repaired, 3–9 segments), `NarrationPlan` assembly, one shorten retry | `composeLlmScript(repo, ledger, opts)`, `buildSystemPrompt`, `buildUserPrompt`, `sanitizeSegments` | repo + ledger + target seconds → `LlmScriptResult` | `groq.ts`, `narration.ts` (selectAngle/wordCount), `pronunciation.ts`, `callout-overlay.ts` | index.ts · **Working** (9/9 completed dataset scripts are `groq-openai/gpt-oss-120b`) |
| `groq.ts` | Minimal Groq client: single request/call, 429 `Retry-After` floor + exponential backoff w/ jitter, 5xx single retry, 4xx fail-fast, `GROQ_API_KEYS` rotation on 429, token-usage logging | `groqChatCompletion(messages, opts)` → `GroqCompletion`; `GroqError` | JSON payload → completion content/usage/retries | `config.ts`, `fetch` | llm-script.ts, news (script.ts, research-agent.ts), news gates · **Working** |
| `narration.ts` | Legacy validator + shared helpers: `validateScript`, `selectAngle`, `wordCount` | `validateScript`, `selectAngle`, `wordCount` | `NarrationPlan`+ledger → `ScriptValidation` | `types.ts` | index.ts (rule path), llm-script.ts (angle/wordCount) · **Working (legacy path; LLM path uses only selectAngle/wordCount)** |
| `script-composer.ts` | Legacy rule-based writer (constrained story grammar) | `composeScript(ledger, repo, opts)` | ledger → `{plan, explanation, omissions}` | narration-grammar, explanation-planner, narrative-graph | index.ts (`SHOWCASE_SCRIPTER=rule`) · **Legacy/optional** |
| `narration-ir.ts` | Structural IR: `RepoNarration`; compile check (purpose/mechanism/use-case mandatory) | `compileNarrationIr`, `validateNarrationIr` | `NarrationPlan` → `RepoNarration` | — | index.ts (rule path only), narration-grammar.ts · **Working (rule path)** |
| `scriptability.ts` | Scriptability signal (purpose/mechanism/example/diversity); default: recorded, not blocking | `evaluateScriptability(repo, ledger)` | repo+ledger → `{ok, score, missing}` | config weights | index.ts · **Working** |
| `script-quality.ts` | Legacy quality gate (citation density, metadata share, repetition) | `evaluateScriptQuality(plan, ledger)` | plan+ledger → `{ok, score, hardFailures, warnings}` | — | index.ts (rule path) · **Legacy** |
| `explanation-planner.ts`, `narrative-graph.ts`, `narration-grammar.ts`, `script.ts` | Evidence ranking → explanation graph → story grammar clause selection (legacy writer internals) | `planEvidence`, `buildNarrativeGraph`, `composeFromGrammar` … | ledger → story candidates | EVIDENCE_WEIGHTS, PATH_WEIGHTS | script-composer.ts · **Legacy** |
| `tts-text.ts` | Speech-only normalizer (strips markdown/code/URLs, expands versions/dates/%/acronyms). **Captions never pass through it** | `prepareTtsText(text)` | spoken source → speakable text | pronunciation.ts | voice.ts · **Working** |
| `pronunciation.ts` | Product-name/alias substitutions + number-word expansion dictionary | `toSpoken(text)` | text → text | — | llm-script.ts (spokenText), narration.ts · **Working** |
| `voice.ts` | Kokoro synthesis per segment, ffprobe measurement, chunk concat with per-segment `pauseAfterMs` silence, shared `pauseSchedule`, `toTimedChunks` | `synthesizeSegments`, `synthesizeChunk`, `concatChunks`, `toTimedChunks`, `pauseSchedule`, `probeAudio`, `kokoroPaths`, `makeVoice` | segments → WAVs → `narration.wav` + `AudioChunk[]` | `tools/python/kokoro-tts.py`, `src/python.ts` (whisper-free), ffmpeg/ffprobe | index.ts, news channel · **Working** |
| `timeline.ts` | Caption phrase splitting (syllable weighting), `buildScrollKeyframes` (easeInOutCubic, travel-time pass), `scrollAt`, `scrollCoverage`, `highlightsFor`, `enforceMonotonic` | `buildCaptions`, `buildScrollKeyframes`, `splitPhrases`, `scrollAt`, `easeInOutCubic` | segments+chunks+anchors → `CaptionPhrase[]`, `ScrollKeyframe[]` | config SCROLL | index.ts, browser-capture.ts · **Working** |
| `captions.ts` | Optional ASS export (`captions.ass`) | `writeAssFromCaptions` | phrases → `.ass` | caption-overlay (CAPTION_STYLE) | index.ts · **Working** |
| `caption-overlay.ts` | Caption panel + moving yellow pill ("karaoke"), per-word timings (**estimated** in GitHub; `wordTimings?` supported for news), wrap ≤2 lines, emphasis color | `captionFrameHtml`, `wordTimings`, `captionFitsPanel`, `CAPTION_STYLE`, `CAPTION_MOTION`, `CAPTION_HIGHLIGHT` | phrases → per-frame HTML state | visual-overrides | browser-capture.ts, qa.ts (caption fit checks) · **Working** |
| `callout-overlay.ts` (27 KB) | Evidence-backed 3–7-word bubble cues bound to measured chunks; head-anchor placement; seeded jitter; state pure function of timeMs | `buildCalloutCues`, `calloutCueAt`, `calloutStateAt`, `placeCallout`, `calloutTextFor`, `scoreCalloutCandidate` | segments+chunks+duration → `CalloutCue[]` | CALLOUT config, visual-overrides | index.ts, browser-capture.ts, qa.ts (calloutChecks) · **Working** |
| `impact-accents.ts` | Yellow SVG ray/spark bursts (two-rays/three-rays/short-spark/sweep), seeded jitter, rear/front layers | `buildImpactBurstCues`, `evaluateImpactBurstsAt` | segments+chunks+callouts → `ImpactBurstCue[]` | IMPACT_ACCENTS config | index.ts, browser-capture.ts, qa.ts · **Working** |
| `character-motion.ts` | Deterministic whole-cut-out motion (idle bob/tilt, speech envelope @25 Hz, entrance 380 ms), `characterPoseForSlot` (demo/setup→point, cta→close) | `characterPoseAt`, `buildSpeechEnvelope`, `characterPoseForSlot`, `speechLevelAt` | wav → envelope; time→pose | CHARACTER config, ffmpeg decode | index.ts, browser-capture.ts · **Working** |
| `mascot-layout.ts` | Alpha-aware bottom-right placement math, head anchor, `CHARACTER_ALPHA_BOUNDS` (measured) | `mascotPlacementCss`, `getMascotFrameGeometry`, `mascotHeadAnchor`, `speechCalloutZone` | layout inputs → px geometry | MASCOT_LAYOUT | browser-capture.ts, callout-overlay (anchor), tests · **Working** |
| `card.ts` (43 KB) | The 1080×1920 stationary card DOM: `buildDocument` (repo→styled HTML incl. mobile screenshot `<img>`), `sanitizeReadmeHtml`, `buildCardHtml` | `buildDocument`, `buildCardHtml`, `sanitizeReadmeHtml`, `UI_TOKENS` | repo/composition → HTML string | font-faces | browser-capture.ts · **Working** |
| `browser-capture.ts` | CDP frame capture of the card DOM → FFmpeg stdin; measurement pass (`measureCard`); parallel tabs (`SHOWCASE_CAPTURE_WORKERS`, default **1**); reference frames 0/25/50/75/100 % | `renderCardVideo`, `measureCard`, `captureLivePage` (legacy), `buildFfmpegArgs` | composition+timeline+audio → MP4 | `cdp.ts`, `card.ts`, `timeline.ts` (scrollAt), `caption-overlay.ts`, `callout-overlay.ts`, `character-motion.ts`, `impact-accents.ts`, FFmpeg | index.ts · **Working** (the slowest stage; see risks) |
| `mobile-capture.ts` | Captures the **real public repo page** at 405 CSS px @ DPR 2 (tiled beyond 8000 raster px), failure detection (404/sign-in/abuse walls), normalization to 810 px, anchor measurement | `captureMobileRepositoryPage` (→ `capturePage`/`captureTiled`), `chooseStoryEnd`, `cropMobileCapture`, `detectFailedPage` | URL → `MobilePageCapture` (`mobile-page-full.jpg` + anchors) | `cdp.ts`, node-`canvas` | index.ts · **Working** (fallback: locally-built mock page) |
| `render.ts` | Encode entry: `renderVideo` → `renderCardVideo`; legacy `renderVideoFromStill` | `renderVideo` | options → spawn ffmpeg | browser-capture.ts, MAX_DURATION_SECONDS clamp | index.ts · **Working** |
| `qa.ts` | Post-render validation: ffprobe, dimensions/fps/codec/format/audio, not-black, scroll-motion, fixed-composition, loudness, callout/impact/SFX geometry checks, contact sheet | `validateOutput`, `probeMedia`, `checkNotBlack`, `checkVisualMotion`, `measureLoudness`, `buildContactSheet`, `calloutChecks`, `impactAccentsChecks`, `soundEventsChecks`, `overlayLayoutChecks` | MP4 → `QaReport` (`qa.json`) | ffprobe/ffmpeg | index.ts, news channel · **Working** (defaults assume ≤58 s, 1080×1920) |
| `sfx.ts` | SFX-only mixing: `scheduleSoundEvents` (whoosh@0, pop@each callout), `mixAudioTracks` (`amix`) | `scheduleSoundEvents`, `mixAudioTracks` | narration + events → `narration-sfx.wav` | `SFX_CONFIG`, ffmpeg | index.ts · **Working** (no BGM exists anywhere) |
| `history.ts` | `HistoryStore` — `repositories`, `star_snapshots`, `pipeline_runs`; atomic reservation, retry budget (MAX_ATTEMPTS=3), stale-reservation reclaim (30 min), `excludedFullNames()` | class `HistoryStore` | SQLite (`db/showcase-history.db`) | `node:sqlite` | index.ts · **Working** (588 repos tracked: 85 completed, 468 discovered, 35 failed; 182 runs) |
| `script-dataset.ts` | The script archive: `saveDatasetRecord` (pending→completed), `getDatasetRecord`, `listDatasetRecords`, `updateDatasetRecord`; atomic writes; `dataset/<channel>/<id>.json` + `index.jsonl` | see functions | records → disk JSON | fs | index.ts, news index.ts, `tools/scripts-dataset.ts` · **Working** |
| `asset-server.ts` | Loopback static server on `127.0.0.1:<random>` for render assets (page.jpg, character PNGs, bubble) | `startAssetServer` | files → `{origin}` | http | index.ts, browser-capture.ts · **Working** |
| `cdp.ts` | CDP helpers: `openTarget`, `closeTarget`, `evaluate`, `setViewport`, `navigate`, `waitFor`, `ensureBrowser`, `frameId`, `setEmulatedColorScheme` | see functions | — | chrome-remote-interface | browser-capture, mobile-capture, card · **Working** |
| `config.ts` | **All** policy constants (see §D.3) incl. `VIEWPORT`, `MAX_DURATION_SECONDS=58`, `MIN/MAX` duration, Groq/Kokoro blocks, `MASCOT_LAYOUT`, `CAPTION_OVERLAY`, `SFX_CONFIG`, `DB_PATH` | constants + `resolveTargetSeconds`, `captionOverlayGeometry`, `pauseFor`, `getCalloutAssetProfile` | env → frozen config | visual-overrides | everything · **Working** |
| `visual-overrides.ts` | Merge `visual-overrides.json` (preview-authored) over committed composition at startup | `VISUAL_OVERRIDES` | file → object | — | config.ts, caption-overlay.ts · **Working** |
| `font-faces.ts` | Inlined @font-face data URIs (Roboto/Inter/Montserrat/Roboto Mono woff2) | `bundledFontFaces()` | — | assets/shared/fonts | card.ts, news scene · **Working** |
| `scroll.ts`, `scroll-choreography.ts` | `scrollBounds`; reveal pacing helpers (`SCROLL` policy lives in config) | `scrollBounds`, … | document → bounds | — | index.ts, timeline.ts · **Working** |
| `load-env.ts` | Minimal `.env` parser (shell exports win) | side-effect import | `.env` → process.env | — | entry files · **Working** |

### D.2 News channel — separate engine (`src/channels/news/`)

Entry `npm run start:news` → `channels/news/index.ts` (Stages 1–8 + Gates A/B/C, `--resume`, `--dry-run`, `--skip-audio`). Shares **only** generic infrastructure: `voice.ts`, `qa.ts`, `config.ts` (OUTPUT/TEMP/TTS pause), `script-dataset.ts`, `font-faces.ts`, `types.ts` (`NarrationSegment`, `CaptionPhrase`), `cdp.ts`, `chrome-paths.ts`, `python.ts`. Everything else — discovery (Inshorts lane), evidence ledger, claim verification, clustering, research agent, Gates A/B/C, `scene.ts` (941×1672 office artwork), `render-news.ts` (941×1672→1080×1920 upscale, disk frames + second FFmpeg pass, `NEWS_RENDER_PORT=9224`) — is News-specific. Full channel audit captured during this investigation (entry flow, env vars `NEWS_*`, exit codes 0/1/2/3, `news-history.db` schema with `schema_migrations` and `story_candidates.fingerprint`, and the honest finding that **nothing ever sets `story_candidates.status='completed'`**, so `excludedStoryFingerprints()` is always empty). Also: `production/` (`ProductionSpec`, keyframe evaluator, closed-form easings, deterministic `compileTimeline`, `validateSpec`) is **designed, unit-tested, and unused by any render path**; it is pinned to 1080×1920/30 fps and is news-channel-only. See §L and §M.

### D.3 Hardcoded format anchors (what a Long-form mode must touch)

`src/config.ts`: `FPS=30` (`SHOWCASE_FPS` override exists) · `VIEWPORT={1080,1920}` (**not overridable**) · `MAX_DURATION_SECONDS=58` (**hard product limit; not overridable**) · `MIN_DURATION_SECONDS=18` · `TARGET_DURATION_SECONDS` (default 35) · `CARD` (810×1668 card) · `CAPTION_OVERLAY.topPx=1388` · `MASCOT_LAYOUT {widthRatio:0.6306, offsetX:-60, offsetY:462, anchor:"bottom-right"}` · `CARD_VIEWPORT_HEIGHT` · `MOBILE_PAGE.maxStoryViewports=5.5` · `SCROLL.targetPxPerSecond=150 / maxPxPerSecond=190`.
`src/render.ts`: `durationSeconds = Math.min(MAX_DURATION_SECONDS, audioDurationMs/1000)` — **silently truncates anything longer than 58 s**.
`src/qa.ts`: `expectedWidth/Height` default to `VIEWPORT`; `maxDurationSeconds` defaults to 58.
`src/browser-capture.ts`: viewport hard-set to `VIEWPORT`, CDP screenshot JPEG q=85, FFmpeg `-vf scale=out_range=tv,format=yuv420p`.
`tools/preview/...`, `tests/card.test.ts`, `tests/media.test.ts` assert 1080×1920 geometries.
`docs/configuration.md` documents "The product rule is a hard maximum of 58 seconds."

### D.4 What does **not** exist anywhere in the codebase

- Any reference to 16:9 / landscape / 1920×1080 (verified by repo-wide search).
- Any "long-form" pipeline or "Pipeline 3/4" code (only `docs/future-pipelines.md` assessment, `docs/lazy-news.md` P4 mention, and one caption-sanitizer regex `\blong-form\s+videos\b` in `callout-overlay.ts:256`).
- Background music (no BGM assets, no music bed, no ducking — only SFX whoosh/pop via `mixAudioTracks`).
- No-repeat "ledger" for compilations (the GitHub `repositories.status` reservation system is the only no-repeat mechanism; it is short-form-scoped; news fingerprint exclusion is effectively dead code — see §D.2).
- Source-file browsing/capture (`visualAnchor` ∈ repo-header|file-list|readme-intro|install-command|features|license|release only).
- README-line/code-line highlighting marker (only mascot impact bursts + callout bubbles + caption emphasis color).
- Word-level forced alignment for GitHub captions (news only).
- Chapter markers, intro/outro cards, repo-countdown graphics.
- Any notion of an "episode" containing multiple repositories.

---

## E. Complete Execution Flow — current Short-form GitHub pipeline (verified order)

Reconstructed from `src/index.ts main()` — note this **corrects** the naive sequence (capture happens *after* TTS; mascot/motion are inputs to the single render pass):

1. **Startup & env** — `import "./load-env.js"` (shell > `.env`); `main()` parses `--discover|--repo|--mode|--length|--dry-run`; no `--long-form` flag exists. (`src/index.ts:271–304`, `src/load-env.ts`)
2. **Selection** — `--discover`: `MODE_ROTATION` (practical→underdog→popular→emerging by `completedFullNames().length`), `discoverRepos` (2 search queries/mode), hard gates (`hardReject`), 0–100 `scoreCandidate` (MIN_SCORE=65), enrich top-12 (`enrichRepo`: README/languages/release/rootFiles/latestCommit; cached 10 min), re-gate, `MIN_SCORE`, pick `eligible[0]`. `--repo owner/name`: forced enrichment (`force:true`), README ≥120 chars required. (`selectCandidate`, `src/github.ts`) · **Stage 1/9**
3. **Reservation** — `HistoryStore.reserveRepository(nodeId, runId, {force: !discoverMode})` — atomic `processing` flip, attempt_count+1; completed repos refused (ALLOW_REVISIT_AFTER_DAYS=null); stale `processing` >30 min reclaimed as `failed`. (`src/history.ts:256–351`)
4. **Facts** — `buildFactLedger(repo, {star snapshots})` → `facts.json` (Stage 2/9). (`src/facts.ts`)
5. **Scriptability + Narration** — `evaluateScriptability` (recorded; blocks only if `SHOWCASE_SCRIPTABILITY_GATE=1`). Default `SHOWCASE_SCRIPTER=llm`: `composeLlmScript` → Groq single call (system+user; JSON mode; ≤`GROQ_MAX_RETRIES` 429/5xx retries with `Retry-After`-floored backoff; `GROQ_MAX_TOKENS=3000`; `GROQ_MAX_INPUT_CHARS=4500` README trim; `GROQ_MAX_PROMPT_FACTS=30`) → sanitize (≥3 segments; purpose/anchor coercion; `toSpoken`) → `NarrationPlan`; one "shorten it" follow-up if `estimateSeconds > min(target+4, 58)`; hard fail otherwise. `llm-prompt.json`/`llm-response.json`/`llm-script.json`/`narration.json` written. Legacy `rule` path exists behind env flag. (Stage 3/9)
6. **Dataset phase 1** — `saveDatasetRecord({phase:"pending", …})` → `dataset/github/<slug>-<runId>.json` (best-effort, never blocks). (`src/index.ts:513–541`)
7. **Dry-run stop** — `--dry-run` exits here (failure recorded as `{stage:"narration", error:"dry run"}`, exit 0). Note: dry runs are *not* reserved and the run is recorded as **failed**, not succeeded.
8. **TTS** — `synthesizeSegments` (Kokoro, per segment, `TTS_MAX_RETRIES=2`, speech-normalized only), `concatChunks` with `pauseAfterMs` silence (numbered gap WAVs via ffmpeg `anullsrc`), `toTimedChunks`, ffprobe measurement; **throws if merged narration > 58 s**. `render-metadata.json` records voice preset + Kokoro file paths + video spec + mascot layout. `speech-envelope.json` (25 Hz RMS) built in Stage 5. (Stage 4/9)
9. **Mobile capture + timeline** — `captureMobileRepositoryPage` (live → fallback mock page on failure: HTTP/404/sign-in/abuse/blank detection; `story-page.jpg` crop via `chooseStoryEnd` bounded by `SCROLL.maxPxPerSecond` and `maxStoryViewports=5.5`). `buildSpeechEnvelope`. Character cues from segment `narrativeRole`. Assets served on loopback (`startAssetServer`). `measureCard` (real Chromium lay-out measurement) → `buildCaptions`, `buildScrollKeyframes` (+travel-time pass), `buildCalloutCues` (seed `${full_name}-${runId}-v1`), `buildImpactBurstCues`, `scheduleSoundEvents`, `mixAudioTracks` → `narration-sfx.wav`. `timeline.json`, `captions.ass` written. (Stage 5/9)
10. **Render** — `renderVideo` → `renderCardVideo`: viewport 1080×1920 `deviceScaleFactor:1`; per frame: evaluate JS state (scroll/caption/callout/pose/impacts) → CDP `Page.captureScreenshot(jpeg, q=85, optimizeForSpeed)` → pipe to `ffmpeg -f image2pipe … loudenorm …`; references at 0/25/50/75/100 %; default **1 capture worker** (`SHOWCASE_CAPTURE_WORKERS` opt-in); **9000 frames would be needed for 5 min @30 fps — see §L**. (Stages 6–7/9)
11. **QA** — `validateOutput` (dimensions 1080×1920, fps 30, yuv420p, h264, aac, duration ≤58 s+0.5, not-black, scroll-motion (≥120 px coverage range), fixed-composition, loudness, callout/impact/SFX/overlay checks; `checkVisualMotion`, contact sheet). QA failure ⇒ **repository NOT marked complete**, run fails. (Stage 8/9)
12. **Completion** — dataset phase 2 (`phase:"completed"` + measured `alignment.durationMs`), `updateDatasetRecord(output=…)`, `history.completeRepository(nodeId, output, hashScript(plan))` (FNV-1a 32-bit hash of spoken texts), `finishRun("succeeded")`. Interactive `pause` happens in the **launcher** (`run.bat`/`run.sh`), not in `src/index.ts`. (Stage 9/9)
13. **Failure path** — any throw ⇒ `currentStage` logged, `history.failRepository`, `finishRun("failed", {stage, error})`, `run.log` flushed, exit 1. **No resume capability on the GitHub channel** (News has `--resume`; GitHub does not) — every run starts from zero; only the reservation ledger prevents re-work.

### E.1 Step → source map (condensed)

| Step | File | Function/class | Input → Output | Failure conditions |
|---|---|---|---|---|
| Discover | `src/github.ts` | `discoverRepos` | queries → `Repo[]` | all search queries fail with empty pool → throw; else tolerate partial failure |
| Hydrate | `src/github.ts` | `enrichRepo` | repo → `EnrichedRepo` (README raw, languages, release, rootFiles, latestCommit) | README 404 → `null` (allowed); other errors → retryable GitHubApiError; README <120 chars → reject |
| Score | `src/github.ts` | `scoreCandidate` | repo → `CandidateEvaluation` | total <65 or 0 usefulness/documentation → ineligible |
| Ledger | `src/facts.ts` | `buildFactLedger` | repo → `FactLedger` | never throws (facts may be empty) |
| Script | `src/llm-script.ts` | `composeLlmScript` | ledger → `NarrationPlan` | Groq unreachable/JSON unparseable/<3 segments/over 58 s after shorten retry → **hard throw, run dies, repo marked failed** |
| TTS | `src/voice.ts` | `synthesizeSegments`/`concatChunks` | plan → `narration.wav` | Kokoro missing files/python; segment >TTS_MAX_RETRIES; merged >58 s |
| Capture | `src/mobile-capture.ts` | `captureMobileRepositoryPage` | repo → jpg+anchors | live capture fails ⇒ **fallback mock page** (logged, `source:"fallback"`); totally blank ⇒ throw |
| Timeline | `src/timeline.ts` | `buildCaptions`, `buildScrollKeyframes` | chunks → captions/keys | none (always produces a timeline) |
| Render | `src/browser-capture.ts` | `renderCardVideo` | → MP4 | CDP crash/timeout (30 s shot timeout), ffmpeg non-zero exit ⇒ `work/ffmpeg-stderr.log` kept |
| QA | `src/qa.ts` | `validateOutput` | MP4 → report | any check fails ⇒ run fails, repo **not** completed |
| Persist | `src/history.ts` | `completeRepository` | — | SQLite write failure ⇒ run fails after video exists |

### E.2 Artifact directory (`temp/<owner>-<repo>-<runId>/`)

`repository.json`, `selection.json`, `facts.json`, `scriptability.json`, `llm-prompt.json`, `llm-response.json`, `llm-script.json`, `narration.json` (+legacy `explanation-plan.json`, `script-quality.json`, `narration-structure.json`), `render-metadata.json`, `speech-envelope.json`, `story.json`, `timeline.json`, `qa.json`, `run.log`, `work/audio/segment-*.wav`, `work/narration.wav`, `work/narration-sfx.wav`, `work/captions.ass`, `work/capture/mobile-page-full.jpg`, `work/capture/mobile-page.json`, `work/capture/story-page.jpg`, `work/visual/reference-*.jpg`, `contact-sheet.jpg`. (All gitignored.)

---

## F. Data Models and Schemas (as actually stored)

### F.1 `Repo` (raw REST) — `src/types.ts:27` (abbreviated)

```ts
{ node_id?: string; full_name: string; name?: string; html_url: string;
  description: string | null; updated_at: string; created_at?: string;
  pushed_at?: string | null; stargazers_count: number; forks_count: number;
  language: string | null; default_branch: string; license: { key|name|spdx_id } | null;
  topics?: string[]; homepage?: string | null; archived?: boolean; disabled?: boolean;
  fork?: boolean; size?: number }
```

### F.2 `EnrichedRepo` — `src/types.ts:54` (abbreviated, real fields)

```ts
Repo & { nodeId: string; owner: string; name: string;            // node_id, split name
  createdAt; updatedAt; pushedAt; archived; disabled; fork; topics: string[];
  homepage; languages: Record<string,number>; primaryLanguage: string | null;
  licenseSpdxId; licenseName; openSourceLicense: string | null;   // allow-list check
  readmeText: string | null; readmeUrl: string | null;
  latestRelease: GitHubRelease | null;                             // tag/name/published_at/html_url
  rootFiles: RootEntry[];                                          // top-level listing (name/path/type/size)
  latestCommit: { message; authorLogin; committedAt } | null;
  sizeKb: number; capturedAt: string }
```

### F.3 `FactLedger` / `Fact` — `src/types.ts:206–231`

```ts
{ id, kind: FactKind, semantic?: FactSemantic, claim, spoken,
  source: { kind: "api-field"|"readme-section"|"readme-code"|"readme-table"|"source-file"|"release"|"star-snapshot",
            location, capturedAt },
  provenance?: { excerpt?, path?, lineStart?, lineEnd?, rule? },
  confidence: number /* 0..1 */ }
FactLedger = { repositoryNodeId, fullName, capturedAt, facts: Fact[] }
```

Real example (excerpt from `dataset/github/makralabs-makra-4d2ba6af.json`):

```json
{ "id": "purpose:repo.description:the-repository-describes-itself-",
  "kind": "purpose", "semantic": "identity",
  "claim": "makralabs/makra — The repository describes itself as: …",
  "spoken": "…",
  "source": { "kind": "api-field", "location": "repo.description", "capturedAt": "2026-11-12T22:45:14.949Z" },
  "provenance": { "path": "GitHub API", "rule": "api-description" },
  "confidence": 0.95 }
```

### F.4 `NarrationPlan` / `NarrationSegment` — `src/types.ts:270–323`

```ts
NarrationSegment = { id, purpose: "identify"|"problem"|"explain"|"benefit"|"demo"|"install"|"license"|"adoption"|"caveat"|"cta",
  spokenText /* TTS input, normalised */, captionText /* screen, NOT normalised */,
  factIds: string[], visualAnchor?: "repo-header"|"file-list"|"readme-intro"|"install-command"|"features"|"license"|"release",
  pauseAfterMs?, emphasis?: string[] /* ≤3 */, narrativeRole?, clauseId?,
  calloutText?, calloutRole?, calloutImportance? }
NarrationPlan = { repositoryNodeId, fullName, angle, angleReason, targetDurationSeconds,
  styleVariant /* e.g. groq-openai/gpt-oss-120b */, voiceId: "am_fenrir", speed: 1.0,
  estimatedWords, segments: NarrationSegment[], structure?, scriptScore? }
```

Real completed example (abridged; `Ikalus1988/MisakaNet`, discovered 2026-11-13):

```json
{ "script": { "estimatedWords": 100, "estimatedSeconds": 39,
              "styleVariant": "groq-openai/gpt-oss-120b", "angle": "quick-tour",
    "segments": [
      { "id": "seg-01", "purpose": "identify",
        "spokenText": "MisakaNet is a git-backed failure memory that lets agents fetch graded fix lessons.",
        "captionText": "MisakaNet is a git-backed failure memory that lets agents fetch graded fix lessons.",
        "factIds": ["purpose:repo.description:…"], "visualAnchor": "repo-header",
        "calloutText": "git-backed failure memory", "calloutRole": "purpose",
        "emphasis": ["MisakaNet", "failure memory"], "narrativeRole": "identity",
        "clauseId": "llm.1", "pauseAfterMs": 170 },
      { "id": "seg-02", "purpose": "explain", "visualAnchor": "readme-intro", "pauseAfterMs": 200, … },
      … { "id": "seg-04", "purpose": "install", … }
    ] } }
```

### F.5 Dataset record — `src/script-dataset.ts:43–83` (real shape)

```jsonc
{ "version": 1, "id": "<slug>-<runId>", "channel": "github",
  "phase": "completed",                     // or "pending" (die before TTS)
  "title": "<owner>/<repo>", "subject": "https://github.com/<owner>/<repo>",
  "runId": "a1b2c3d4", "invocation": { "kind": "discover", "detail": "practical" },
  "script": { "segments": [ …verbatim NarrationSegment… ],
              "estimatedWords": 100, "estimatedSeconds": 39,
              "styleVariant": "groq-openai/gpt-oss-120b", "angle": "quick-tour",
              "llm": { "model": "…", "usage": …, "retries": 0 } },   // NOTE: absent from all 9 stored GitHub records
  "facts": { "ledger": { /* full FactLedger */ } },                  // GitHub only (large)
  "selection": { /* full CandidateEvaluation incl. enriched repo, README text (4102 chars in the sample) */ },
  "alignment": { "durationMs": 27349, "sampleRate": 24000 },          // GitHub: no per-segment timings, no coverage
  "output": "output/<slug>-<runId>.mp4",      // or absent
  "createdAt": "…", "updatedAt": "…" }
```

`dataset/github/index.jsonl` (one JSON line per record): `{id, channel, phase, title, subject, createdAt, runId, output?}` — 9 records, all `phase:"completed"`. `dataset/news/index.jsonl`: 11 records (3 `completed`). Retrieval: `npm run scripts:list -- github`, `npm run scripts:show -- github <id>` (`tools/scripts-dataset.ts`). Read-side API for any new mode: `listDatasetRecords()`, `getDatasetRecord()` (async FS; ids sanitized against path escape).

### F.6 SQLite schemas (verified via `node:sqlite`, read-only)

**`db/showcase-history.db`** (`src/history.ts:67`):
`repositories(node_id PK, canonical_full_name UNIQUE(lower), html_url, first_seen_at, last_seen_at, first_stars, latest_stars, latest_pushed_at, status [discovered|processing|completed|failed|skipped], completed_at, video_path, run_id, reserved_at, last_error_stage, last_error, attempt_count, script_hash, metadata_json)` · `star_snapshots(node_id, captured_at, stars, PK(node_id,captured_at))` · `pipeline_runs(run_id PK, started_at, finished_at, status[running|succeeded|failed], stage, repository_node_id, output_path, error_json)`.

**`db/news-history.db`** (`src/channels/news/history.ts`): adds versioned `schema_migrations` + `story_candidates(story_id PK, …, fingerprint UNIQUE, status default 'discovered')`, `source_records`, `fact_claims`, `news_episodes(… gate_a_at/gate_b_at/gate_c_at …)`, `pipeline_runs(…, channel TEXT default 'news')`.

### F.7 Timeline / caption / capture structures (`src/types.ts:375–472`)

```ts
CaptionPhrase = { index, startMs, endMs, text, highlights: string[], segmentId,
                  wordTimings?: CaptionWordTiming[] /* news only today */ }
AudioChunk    = { index, segmentId, file, text, durationMs, sampleRate, channels, startMs, endMs }
ScrollKeyframe= { timeMs, scrollY, easing: "linear"|"easeInOut", anchor? }
Timeline      = { durationMs, sampleRate, chunks, captions, callouts?, impactBursts?, soundEvents?, scroll, anchors, documentHeight, viewportHeight, story? }
MobilePageCapture = { imagePath, source: "live"|"fallback", cssViewport{405,720}, raster{810,H}, rawRaster, pixelsPerCssPx, documentHeightCssPx, anchors: MeasuredAnchor[], title, capturedAt, warnings }
```

### F.8 What the stored script does NOT preserve

No audio, no per-segment measured timing, no capture (`story-page.jpg` lives only in `temp/`), no frames, no `visualAnchor` render info beyond the anchor name, no `pauseAfterMs` deviations beyond what's in segments (that *is* kept), no token usage in practice (the `script.llm` field documented in `dataset/README.md` is empty in all 9 GitHub records), and — critically for reusing the repo set — **no link from a dataset record back to `pipeline_runs` other than `runId`**, though `selection.enriched.nodeId` is present inside the record. Repository identity **is** consistent across GitHub discovery → DB (`repositories.node_id`) → dataset (`selection.enriched.nodeId`) → (no video-side persistence other than `output/` filename slug). News has no equivalent node_id linkage.

---

## G. Integration Map

```
                       ┌─────────────────────────────── user (terminal) ───────────────────────────────┐
                       │  run.bat / run.sh / run.command  (menu: [1] GitHub  [2] News  [0] Exit)       │
                       │  launchers: check ffmpeg/ffprobe/python/Chrome; load .env; launch Chrome 9222 │
                       └───────────────┬───────────────────────────────────────┬─────────────────────┘
                                       │ npm run showcase                      │ npm run start:news
                                       ▼                                       ▼
              ┌─────────────────────────────────────────────┐   ┌──────────────────────────────────────┐
              │ src/index.ts  (GitHub Showcase, Stages 1-9) │   │ channels/news/index.ts (Gates A/B/C) │
              └───────┬─────────────────────────────────────┘   └───────────────┬──────────────────┘
                      │ shared engine (imported, not copied):                   │
                      │  voice.ts · qa.ts · script-dataset.ts · cdp.ts ·         │
                      │  config.ts · font-faces.ts · types.ts · chrome-paths.ts  │
   ┌──────────────────┴────────────────┐   ┌─────────────────┬──────────────────┴───────┐
   ▼                                   ▼   ▼                 ▼                        ▼
GitHub REST API            Groq API (groq.ts)        Kokoro ONNX (voice.ts)      Chromium CDP (cdp.ts)
(src/github.ts)            gpt-oss-120b JSON         per-segment WAVs            9222 GitHub · 9223/9224 news
search/repo/readme/        system+user, ≤3 retries   concat w/ pauseAfterMs       captureMobileRepositoryPage
languages/release/         GROQ_API_KEYS rotation     ffprobe-measured             measureCard / renderCardVideo
commits/contents            (fact ledger grounding)   → narration.wav
   │                                   │                   │                        │
   ▼                                   ▼                   ▼                        ▼
facts.ts ────────────► llm-script.ts → NarrationPlan ─► voice.ts chunks ─► timeline.ts (captions,
 (FactLedger,           (sanitize, attach factIds,       toTimedChunks        scroll keyframes, syllable
  provenance,           pause schedule)                   (ms truth)           word weighting)
  confidence)                                                │                       │
                                                             ▼                       ▼
              ┌───────────────────────────────► browser-capture.ts (per-frame CDP JPEG q=85)
              │                               → ffmpeg image2pipe → H.264/yuv420p/AAC/loudnorm
              ▼                                                                │
        card.ts DOM composition, mascot (character-motion/mascot-layout),       ▼
        callouts (callout-overlay), impacts (impact-accents), captions           qa.ts → qa.json
        (caption-overlay), SFX (sfx.ts: amix)                                   history.ts → db/showcase-history.db
                                                                               script-dataset.ts → dataset/github/
```

Notable integration facts:

- **There is exactly one timeline authority:** measured audio. Captions, scroll, character cues, callouts, SFX, and impact bursts are all pure functions of `timeMs` on that clock (`src/types.ts` `Timeline`; `src/index.ts` Stage 5→6). News adds forced-alignment word timings over the same clock.
- **FFmpeg has two distinct roles:** (a) continuous encode from stdin (`-f image2pipe`, GitHub), and (b) audio tooling (loudnorm/concat/amix/decode for envelope). News additionally uses JPEG-on-disk frames → second ffmpeg pass.
- **The browser is only ever a frame source.** No video is "recorded" from the page; GitHub captures the page once as a still, then screenshots a *different* DOM (the card) per output frame.
- **State crossing processes:** Python (Kokoro) is spawned per segment with stdin text; CDP is a socket; FFmpeg is stdin/stdout pipes; SQLite is in-process `node:sqlite`. No IPC, no queue, no daemon (except the long-lived Chrome on 9222 and the loopback `asset-server`).

---

## H. Persistence Architecture

| Data | Where | Format | Written by | Read by | Notes |
|---|---|---|---|---|---|
| Repository history + reservations + star snapshots + run ledger | `db/showcase-history.db` | SQLite (WAL) | `HistoryStore` | `index.ts` (dedup at discovery; reservation; completion) | 588 repos / 182 runs today; gitignored; not portable across machines |
| News history (stories, sources, claims, episodes, runs) | `db/news-history.db` | SQLite (versioned migrations + backups) | `NewsHistory` | news pipeline | separate file, never opened by GitHub |
| Script archive (both channels) | `dataset/github|news/*.json` + `index.jsonl` | JSON / JSONL (atomic upsert) | `saveDatasetRecord`/`updateDatasetRecord` | news/GitHub completion; `scripts:list|show`; intended for compilations | 9 github records (all `phase:"completed"`), 11 news (3 completed). **Dataset is archival & best-effort — never load-bearing.** |
| Per-run artifacts | `temp/<slug>-<runId>/` (202 dirs) | JSON/WAV/JPG | pipeline | humans, preview tooling | includes `llm-prompt.json`/`llm-response.json` (exact Groq request/response + token usage) — **valuable for Long-form re-grounding** |
| Final videos | `output/*.mp4` (86), `output/news/*.mp4` (5) | MP4 | ffmpeg | users | filename slug `<owner>-<repo>-<runId>`; news has `output/news/` subdir |
| Kokoro models | `models/kokoro/*.onnx|.bin` | ONNX | `install/python.*` | `voice.ts` | gitignored, ~115 MB |
| Fonts | `assets/shared/fonts/*.woff2` | woff2 | repo | `font-faces.ts` (inlined base64) | committed |
| Mascot / bubble / SFX | `assets/github/**` | PNG/WAV | repo | card.ts, config (`MASCOT_LAYOUT` …) | committed; SFX licences **unverified** (see `assets/github/sfx/ATTRIBUTION.md`) |
| Visual overrides | `visual-overrides.json` (repo root) | JSON | preview tuner | `visual-overrides.ts` | absent on this machine; env > file > committed |
| Logs | `temp/<run>/run.log`; console | text | `log()` | humans | no log rotation, no global logger, no level/structured logs |
| Caches | none on disk (enrichment cache is in-memory, 10 min TTL) | — | — | — | deleted with `clearEnrichmentCache()` at process exit |
| Scratch | `temp/scratch/` | mixed | humans | humans | experiments |

**Repository identity consistency:** `node_id`/`nodeId` flows DB ↔ dataset record (`selection.enriched.nodeId`) ↔ fact ledger ↔ NarrationPlan ↔ history reservation. News has no such global identity (story fingerprints are in-memory + `story_candidates.fingerprint`, which is never flipped to `completed` — see §D.2). Identity does **not** reach the MP4 filename (slug only), and the dataset records carry no `video_path`; the only link is `runId` and human naming convention.

**No-repeat persistence today:** `repositories.status='completed'` (or `processing`, or `failed` at `attempt_count>=3`) ⇒ excluded from future discovery (`excludedFullNames()`), and `reserveRepository()` refuses completed repos atomically. **There is no usage ledger scoped to a hypothetical Long-form episode, and no cross-mode exclusion.** Note the asymmetry a Long-form mode would inherit: the 85 `completed` repositories in history vastly outnumber the **9** usable dataset records (dataset only began with the current codebase; many runs never produced a dataset record or failed pre-phase-2) — "previously stored short-form repository scripts" actually exists for only 9 repos today.

---

## I. Test and Reliability Assessment

### I.1 What is verified (run on this machine, 2026-11-13)

- `npm test` → **532 tests, 111 suites, 0 failures** (~10 s). Test files cover (GitHub): facts, script pipeline (script, llm-script with mocked fetch/sleep, script-composer, scriptability, script-quality, explanation, narration-grammar, narration-ir, tts-text, text-sanitize, pronunciation), discovery/selection (selection.test.ts, scoring via github fixtures in `tests/fixtures/repositories.json`), timeline captions & scroll keyframes, caption motion, card composition (`card.test.ts`), mascot layout, character motion, callout overlay, impact accents, sfx, media probe QA (`media.test.ts`), history (`history.test.ts`), script dataset, config writer/model, scroll-choreography, voice-timing. (News): alignment, auto-gates, claims, clustering, credits, history, inshorts, ledger, permissions, perspective, production engine, research-agent, scene events, script.
- `npm run check` (`tsc --noEmit -p tsconfig.check.json`) → **clean**.
- Production evidence: 86 GitHub MP4s + 5 News MP4s on disk; `db/showcase-history.db` shows 85 `completed`.

### I.2 What the tests mock (i.e., what is NOT verified automatically)

- **Groq** is mocked in `tests/llm-script.test.ts` (injected `fetchImpl`/`sleep`); no test hits the real API.
- **Kokoro/TTS** is not exercised end-to-end (tests cover `pauseSchedule`, `toTimedChunks`, timing math — not `synthesizeChunk` against the real ONNX model).
- **Chromium/CDP/FFmpeg** are not exercised (no fixture renders a real video in `npm test`; `tests/media.test.ts` probes canned files).
- **GitHub REST** is mocked via fixtures.
- Visual quality of output is only verified by the live `qa.json` artifacts of real runs (contact sheets, not-black, motion), not by CI.

### I.3 Production-critical behaviors with no automated test

1. `renderCardVideo` end-to-end (frame pump, backpressure, ffmpeg stdin handling) — the code contains a hard-won EPIPE fix (`browser-capture.ts` comment: "the bug that froze Stage 6"), so regressions here are silent-kill risks.
2. `captureMobileRepositoryPage` against the real GitHub (live network, anti-bot responses) — the fallback mock page path is tested (`tests/mobile-capture.test.ts`) but the live path is not.
3. Groq prompt/response contract against the real service (model drift, `reasoning_effort` handling, JSON mode) — only unit-level with mocks.
4. Kokoro Python wrapper behavior (phoneme availability, sample-rate mismatch handling).
5. FFmpeg presence/version and filter correctness on a clean machine (installers only check `where`/`command -v`).
6. `saveDatasetRecord` failure path in a real run (it is intentionally swallowed — by design, but untested for disk-full/permissions).
7. Long-duration rendering (>58 s) — **structurally impossible today**; nothing tests it because nothing can do it.

### I.4 Reliability posture of the GitHub pipeline (from code)

| Failure class | Behavior today | Recovery |
|---|---|---|
| GitHub API 4xx/5xx/rate limit | `GitHubApiError`; `--discover` tolerates one query failing if the other succeeded; hydration failures skip the candidate; manual `--repo` fails loudly | Fix token / retry; no automatic resume |
| Groq 429 | Honour `Retry-After` floor + backoff w/ jitter; ≤`GROQ_MAX_RETRIES` (default 3, max 5); `GROQ_API_KEYS` rotation on persistent 429 | Otherwise: **run fails, repo marked failed** (attempts counted; retryable ≤3) |
| Groq malformed JSON | `GroqError` thrown → run fails | none (no second-chance parser, no fallback writer) |
| Narration >58 s after shorten retry | `GroqError` → run fails | none |
| TTS/Kokoro per segment | 2 retries; failed chunk never persists; `concatChunks` propagates sample-rate mismatch | run fails; segment WAVs preserved in `work/audio/` |
| Mobile capture (live) failure | **Automatic fallback to locally-built mock page** (`source:"fallback"`, logged warning) | degraded video still ships (QA may still pass) — flagged only in `story.json`/logs |
| CDP screenshot timeout | 30 s per shot → `shardErrors` → run fails | none |
| ffmpeg non-zero exit | run fails; `work/ffmpeg-stderr.log` kept; `render-metadata.json` kept | none (no resume) |
| QA failure | **Repo NOT marked complete**; run fails; attempts consumed | manual re-run (attempt_count++) |
| Interruption (crash/Ctrl-C) | `processing` reservation reclaimed as `failed` after 30 min (`reclaimStaleReservations`) — but artifacts (audio/frames) are orphaned in `temp/`; nothing resumes | effectively restart from zero |
| Partial production recovery | **Not available on GitHub channel.** News channel has `--resume` + `--skip-audio`; GitHub does not | restart |
| `temp/` corruption | no integrity checks; artifacts rebuilt from scratch | restart |
| Dataset write failure | logged, run continues (archival only) | — |

### I.5 Quality attributes not tested anywhere

Loudness targets beyond the loudnorm filter are asserted by QA (`measureLoudness`), but there is no regression test that a real render lands at −16 LUFS (only on real runs). Caption sync is **estimate-based** on GitHub; nothing measures word-level drift.

---

## J. Long-form Integration Feasibility Matrix (vs. intended UX)

Intended UX (user-supplied in the brief): menu adds a GitHub submenu Choosing **Short-form (9:16)** — unchanged — or **Long-form (16:9)**. Long-form auto-retrieves stored short-form scripts, selects **five unused repositories**, maintains a persistent no-repeat ledger, generates one cohesive master script via Groq, opens with a supplied front-facing mascot image (≤~5 s intro), presents the repos in **countdown order #5→#1**, captures the real GitHub pages/source files, syncs demos to narration, continuous narration + captions, zoom/pan/scroll keyframes, README/code line highlighting, mascot entering from different positions, BGM + SFX, one continuous ~5-minute landscape video, detailed live progress, repository names + per-repo recording progress shown, validated output, wait-for-keypress exit.

Classification legend: ✅ Already supported · 🟡 Partially supported · 🔶 Requires extension (existing module modified) · 🆕 Requires new implementation · ❓ Cannot be determined from source.

| # | Requirement | Status | Evidence (file · function) |
|---|---|---|---|
| 1 | Launchers surface GitHub as menu choice with Short/Long submenu; Short-form unchanged | 🔶/🆕 | `run.bat` interactive menu `:github_interactive` (`[1] Discover / [2] URL` only), `run.sh` case `1)`; `run.command` → `run.sh`. Integration points are explicit and localized (launcher echo + `set /p`), but **no submenu exists and no `--long-form` arg is parsed** anywhere (`src/index.ts:272–291`). Short-form can stay byte-identical if the submenu routes to the same command line. |
| 2 | Auto-retrieve previously stored short-form scripts | ✅ 🟡 | `script-dataset.ts` `listDatasetRecords`/`getDatasetRecord` (atomic JSON, indexed) + `dataset/github/index.jsonl` (9 completed records, each embeds segments + fact ledger + full selection incl. README text). 🟡 Notes: (a) retrievable independently of discovery — yes; (b) `phase:"pending"` records are unusable as-is; (c) no payload hash/cross-check against `temp/` artifacts; (d) `script.llm` usage absent in all 9 records; (e) only **9** usable repos today (dataset is younger than the 85 completed history rows). |
| 3 | Select five **previously unused** repositories | 🔶 | Candidate pool exists: history `excludedFullNames()` (85 completed) ∩ dataset `phase:"completed"` (9) → **today the eligible pool is 9 < 5-with-headroom; exactly 5 exist**, leaving zero margin if any preference ordering is applied. Uniqueness across Long-form episodes requires a **persistent long-form usage ledger** — see #4. |
| 4 | Persistent no-repeat ledger, survives restarts/failures; completed/attempted long-form repos never re-selected | 🆕 | Nothing like this exists. Closest mechanisms: `repositories.status` reservation ledger (atomic, restart-safe, 30-min reclaim) and `pipeline_runs` — both short-form-scoped and keyed to `node_id`. A Long-form-specific table (e.g., `longform_usage(repository_node_id, run_id, episode_path, status)` written at reservation time *and* at failure time) must be added; `node_id` is the stable identity to key on. Note open design tension: should long-form-used repos be excluded from *short-form* discovery too? (Unspecified — see M-3.) |
| 5 | Generate one cohesive master script via existing Groq integration | 🟡 | `groq.ts groqChatCompletion` reusable as-is (JSON mode, retry discipline, `GROQ_API_KEYS`). But `llm-script.ts composeLlmScript` is single-repo/≤58 s-specific (hard ceiling check, single-repo prompt, `<3 segments → throw`, target≈155wpm). A multi-repo master-script planner does not exist; token budget is fine (~750–900 words for 5 min ≈ 1.2–1.6k tokens ≤ `GROQ_MAX_TOKENS=3000`) but `GROQ_MAX_INPUT_CHARS×5` readme payload (~22 KB) needs deliberate budgeting and per-repo fact selection. |
| 6 | Introduce episode with **supplied mascot image** (front-facing; new asset) | 🆕 | Mascot pipeline exists (ordinal poses `present/point/close`, `character-motion.ts`, `mascot-layout.ts` alpha-aware bounds, `CHARACTER_POSE_PNGS` env overrides `SHOWCASE_CHARACTER_PNG/POINT_PNG/CLOSE_PNG`), but the required **front-facing opening pose does not exist** and assets must not be generated/modified by this work; the opening composition (0–5 s) is a new scene/beat, not a pose swap. |
| 7 | ≤ ~5 s mascot introduction (bounded) | 🟡 | Entrance animation exists (380 ms ramp, `character-motion.ts entranceAt`); a bounded intro beat is achievable via a new first segment/cue; no "intro slot" concept exists; `pauseSchedule` and timeline are ms-based so bounding to 5 s is a planner concern. |
| 8 | Present repositories in countdown order #5→#1 | 🆕 | No countdown concept, no episode scene list, no "repo card" scene. Requires new composition (DOM or canvas layers) reusing the card approach or a new landscape layout; ordering logic is trivial once the selection ledger records episode membership. |
| 9 | Capture **actual GitHub repository pages** and relevant **source files** | 🟡 | Pages: ✅ real capture exists (`captureMobileRepositoryPage`, anti-wall detection, anchors). Source files: 🆕 — `visualAnchor` vocabulary has no `source-file`/`blob` anchor; nothing navigates to `github.com/<owner>/<repo>/blob/HEAD/<path>`; no file-specific capture. (GitHub REST can fetch file contents via `contents/<path>` — `getRootFiles` already lists top-level.) |
| 10 | Synchronize screen demonstrations with narration | 🟡 | Scroll keyframes are built from **narration segments** (`buildScrollKeyframes`, `visualAnchor` → measured DOM anchor offsets, travel-time repair pass). This is real narration↔screen binding — but only within one tall page for one repo, and only for the 7 anchors above. Extending to "scroll to file X at 02:31" is a matter of new anchor types + per-segment file selection; the timing machinery is reusable. |
| 11 | Continuous narration across the episode | ✅/🔶 | Per-segment Kokoro synthesis + `concatChunks` with pause schedule = continuous track (5 min is just more segments; `TTS_MAX_RETRIES=2`; per-chunk WAV on disk). 🔶 Blocker: `voice.ts`/index hard-fail >58 s in two places (`index.ts` `audioSeconds > 58` throw; `render.ts` clamp; QA `maxDurationSeconds`). All three are mechanical parameterizations. Voice consistency across 5 min: same `am_fenrir` — stable (Kokoro deterministic given same model/speed). |
| 12 | Synchronized captions | 🟡 | GitHub captions are phrase-level with syllable-estimated in-phrase word timing (`caption-overlay.ts wordTimings`, 70 ms active-word window). For a 5-min continuous track this works mechanically (timeline is ms-based) but drift risk grows with length; News channel already ships **real forced word alignment** (`tools/python/align_audio.py`, WhisperX/faster-whisper, ≥99% coverage gate + monotonicity) and news caption format supports `wordTimings` natively — reusable for Long-form. Caption typography/layout is portrait-panel-hardcoded (`CAPTION_OVERLAY`, `maxCharsPerLine: 22`), so 16:9 layout needs retuning anyway. |
| 13 | Zoom, pan, scroll and keyframe motion | 🔶/🆕 | Scroll (vertical document translation) ✅ with easing/hold policy. **Zoom: none.** **Pan: none** (translation is Y-only). Keyframes exist as `ScrollKeyframe[]` (timeMs, value, easing) — reusable shape; the unwired `channels/news/production/keyframe-evaluator.ts` supports arbitrary property tracks (x/y/scale/opacity, closed-form easings incl. `spring`, binary search, clamp-to-ends) but is frame-based, 1080×1920-pinned, news-only and unused. 16:9 zoom/pan needs new DOM/transform parameters (Chromium can apply `transform: scale()` natively — no new capture tech needed). |
| 14 | Highlight relevant README lines or code (marker/highlighter effect) | 🆕 | Nothing text-line-specific exists. Adjacent pieces: callout "yellow marker" strip (`board_callout`, news scene only), impact bursts (mascot SVG accents), caption emphasis color (`#9A6700`). A DOM/CSS marker layer inside the captured page (injected at render time, since frames are screenshots of a live DOM) is the natural seam — `card.ts buildDocument`/`sanitizeReadmeHtml` is where line-level markup can be introduced. |
| 15 | Mascot from **different screen positions** during repository explanations | 🔶 | Placement is single-anchor by design: `MASCOT_LAYOUT.anchor: "bottom-right"` sized as width-ratio with signed offsets (`offsetX/offsetY`), alpha-aware `CHARACTER_ALPHA_BOUNDS`, head-anchored callouts. "Different positions per repository beat" = per-cue placement extension (e.g., bottom-right/bottom-left/mid-right) with head-anchor recomputation — math exists in `mascot-layout.ts` (`getMascotFrameGeometry`, `speechCalloutZone`) but is parameter-frozen. Framing/pose variants per beat exist (`characterCueAt`). |
| 16 | Background music | 🆕 | Zero BGM anywhere — no assets, no bed track, no ducking (SFX `amix` only). Needs: licensed BGM asset(s) (none present — none may be added by this stage), a mixing path (`mixAudioTracks` is SFX-only with `adelay/volume/amix`), gains/fades/ducking design, and loudnorm pass ordering decisions. The mixing *machinery* (filter_complex, `-16 LUFS`, stereo 48 kHz) is reusable. |
| 17 | Appropriate SFX | ✅ | `SFX_CONFIG` (mascot whoosh, callout pop), `scheduleSoundEvents`, `mixAudioTracks` — reusable; extendable to per-beat kinds (`SoundEventKind` is open-ended string union). Licence of the two committed WAVs is **unverified** (ATTRIBUTION.md). |
| 18 | One continuous landscape video (~5 min, no hard cutoff) | 🔶 | Render path is continuous and audio-driven (`-t audioDurationMs`), CFR, +faststart. But: `VIEWPORT`, card CSS, `CARD` geometry, `CAPTION_OVERLAY`, `MASCOT_LAYOUT`, QA `expectedWidth/Height`, ASS PlayRes (`captions.ts` defaults 1080×1920), browser viewport, FFmpeg scale filter, and `render.ts`'s **58 s clamp** are all portrait/58 s-locked. "Without a strict hard cutoff" directly conflicts with `MAX_DURATION_SECONDS`; there is **no flag** today to lift it — it requires code change, which is out of scope for this audit. |
| 19 | ~5-minute target, no strict hard cutoff | 🔶 | `TARGET_DURATION_SECONDS` is env-tunable; `--length` clamps to [18,58]; news clamps [20,90]; GitHub pipeline throws >58 s. A 300 s episode needs ceiling removal/parameterization across config/render/QA — mechanical but touches the frozen product rule. |
| 20 | Detailed live production progress in terminal; repo names + per-repo recording progress | 🔶 | `log()` prints timestamped stages; `onProgress` in `renderCardVideo` prints %, frames, fps, ETA (`index.ts:842–856`); candidate list printed with scores (Stage 1). Missing: per-repository episode progress (5 discrete capture/render phases), aggregate episode timeline, and a "recording repository i/5" display. Straightforward extension of the existing `log()` + `onProgress` pattern. |
| 21 | Validate the completed output | ✅/🔶 | `qa.ts validateOutput` (dimensions/fps/codec/pix-fmt/audio/duration/not-black/scroll-motion/fixed-composition/loudness/callout checks) — reusable with `expectedWidth:1920, expectedHeight:1080, expectedFps:30, maxDurationSeconds:∞` (params already exist). Scroll-motion heuristic (≥120 px) and "fixed-composition" checks are 9:16-card-specific; a landscape episode needs new or relaxed checks. No A/V sync-drift check exists at any length. |
| 22 | Wait for a key press before exiting | ✅ (launcher-level) | `run.bat`/`run.sh` call `pause` after pipeline exit with exit-code echo. The GitHub entry itself never waits; adding "press any key" is launcher- or menu-level, not engine-level. News path also ends with `pause`. |
| 23 | 5 previously unused repositories + master script cohesion | 🔶 | No episode selection record exists (see #4); no cohesion scoring; dataset gives per-repo facts/scripts but no cross-repo threading. New planner work required. |
| 24 | Mascot opening + countdown + 5 demos + CTA arc | 🆕 | Entirely new narrative structure; no arc/phase model exists in either channel (news is single-story as well). |
| 25 | 1920×1080 rendering without relying on exported short-form videos | 🔶 | Possible in principle (all assets are re-renderable from repo+script data; nothing requires the MP4s), but it means re-shooting 5 repos at 16:9 — i.e., the pipeline must become composition-parameterized first. Reusing existing short-form MP4s via concat is also technically possible (ffmpeg `concat`) but produces mixed layouts and is **not** a current capability (no concat path exists in code). |
| 26 | Long-form entirely separate from Short-form behaviour | ✅ (feasible by construction) | Channels already coexist without cross-talk (GitHub vs News never import each other); a third selection arm in the launcher + a new entry module can leave Short-form untouched, exactly as News did — the established pattern. |
| 27 | Per-repository recording progress (capture phase) | 🔶 | Capture is a single blocking call per repository (`captureMobileRepositoryPage`) with no intermediate events; would need step logging or events (e.g., "capturing repo 3/5: owner/name…"). |
| 28 | Word-level caption sync for 5-min track | 🟡 | News-quality word alignment exists in-repo (`align_audio.py`); invoking it for GitHub is additive. Or accept syllable estimates (status quo). |

**Summary:** 0 rows fully ✅ as an end-to-end Long-form capability; ~5 rows ✅-as-components (2-retrieval, 11-core, 17, 22, 26); everything else requires 🔶 extension or 🆕 implementation. **Nothing in the current build can produce a 16:9, five-repository, five-minute video today.** This matches `docs/future-pipelines.md`'s verdict ("Pipeline 3 … Not started … Entire renderer is a single stationary 1080×1920 card") with two corrections: (i) the dataset situation is worse than the doc implies — only 9 completed GitHub records exist, and the often-cited `repositories.status='completed'` is the short-form ledger, not a compilation selector; (ii) News' `excludedStoryFingerprints()` does not work (no `status='completed'` write path), so "fingerprint exclusion" claims in the roadmap doc are not backed by code.

---

## K. Integration Opportunities (future Long-form attachment points)

Ordered by reuse leverage. All cited modules are verified above.

1. **`src/groq.ts` — reuse unchanged.** Master-script generation = one `groqChatCompletion` call (or a small fixed number) with a new system prompt; `GROQ_MODEL`/`GROQ_REASONING_EFFORT`/`GROQ_API_KEYS` apply as-is. Token usage logging already surfaces in `run.log`.
2. **`src/script-dataset.ts` — reuse as the retrieval layer.** `listDatasetRecords("github")` → filter `phase==="completed"` → `getDatasetRecord(id)`; records embed `facts.ledger` (full typed ledger with provenance), `selection.enriched` (complete repo incl. `readmeText`) and `script.segments` (spoken/caption text + pauses). This is **sufficient grounding for a master script without re-hitting the GitHub API** (README is preserved inside the record). What must be added: episode bookkeeping (which records consumed by which episode), and a renderer that ignores `alignment` (total only, no per-segment timings; `temp/` has the WAVs but they're not archived).
3. **`src/history.ts` `HistoryStore` — reuse as pattern (or extend).** New Long-form ledger should live beside it in `db/showcase-history.db` (or `db/longform-history.db`) with the same node:sqlite/WAL/atomic-reservation semantics; `RESERVATION_TIMEOUT_MINUTES`-style reclaim for interrupted episodes; `pipeline_runs` rows with `stage` values like `longform:capture:<owner>/<repo>` give free per-repository progress observability. Do **not** repurpose `repositories.status` (it means short-form completion).
4. **`src/voice.ts` — reuse unchanged** (modulo ceiling): `synthesizeSegments`, `concatChunks`, `toTimedChunks`, `pauseSchedule`, `probeAudio`. 5 min = more segments; sample rates asserted consistent; nothing about it is short-form-specific except call sites' 58 s checks in `index.ts`/`render.ts`.
5. **`src/timeline.ts` + `src/caption-overlay.ts` — reuse with a landscape caption profile.** `buildCaptions`, `easeInOutCubic`, `scrollAt` semantics are format-agnostic; `CAPTION_STYLE`/`CAPTION_OVERLAY` constants are not (parameterize or add a 16:9 profile).
   **Optional:** `tools/python/align_audio.py` + `channels/news/captions.ts` pattern for true word-level captions (only instance of ≥99%-coverage word timing in the codebase).
6. **`src/sfx.ts` + `src/config.ts` `SFX_CONFIG` — reuse; extend `SoundEventKind`.** Add BGM as a non-event bed in `mixAudioTracks` (adelay/volume/amix chain already mixes ≥2 inputs; add a looped `-stream_loop` music input with `volume` + optional `sidechaincompress`-free fixed ducking or `duck` via repeated `volume` expressions — keep deterministic; loudnorm final pass stays).
7. **`src/browser-capture.ts` — parameterize, don't rewrite.** `setViewport` already takes width/height; `renderCardVideo` uses `VIEWPORT` (one constant) + JPEG/ffmpeg args. A 16:9 composition = new `VIEWPORT_16x9`/`CARD_16x9` constants + new card DOM (or a new scene module modeled on `channels/news/scene.ts`, which proves the Chromium→FFmpeg path works for non-card layouts). Capture-beyond-viewport and tiled capture work for landscape pages equally well. **Risk: render time** (see §L-1).
8. **`src/qa.ts` — extend, don't fork.** `validateOutput` already accepts `expectedWidth/Height/Fps/maxDurationSeconds`; add 16:9 reference frames + relaxed motion checks; keep loudnorm/not-black/ffprobe core.
9. **`src/asset-server.ts`, `src/cdp.ts`, `src/chrome-paths.ts`, `src/font-faces.ts`, `src/load-env.ts`, `src/types.ts`** — unchanged reuse.
10. **News channel's forced-alignment + gate discipline + `render-news.ts` disk-frame pattern** — two transferable ideas: (a) word-level timing upgrade path for captions; (b) writing frames to disk first ("a crash never destroys captured work") directly addresses Long-form's much higher interruption cost.
11. **Launcher scripts (`run.bat`/`run.sh`/`run.command`)** — add `[1b] Long-form Video (16:9)` under the GitHub interactive path (or a `--long-form` flag) mirroring how `news` was bolted on without touching GitHub dispatch. `run.command` needs nothing new if it delegates to `run.sh`.
12. **`tools/scripts-dataset.ts`** — natural CLI surface for "which repos would the next episode pick?" (`scripts:list -- github`, then filter by `phase:"completed"`) once long-form bookkeeping exists.

Not recommended for reuse as-is: `card.ts` (portrait layout, phone-browser-bar chrome, no 16:9 story), `channels/news/production/*` (portrait spec, frame-based, unwired, would need a second spec version), `assets/github/sfx/*.wav` until licences verified.

---

## L. Technical Risks

1. **Render-time blowup (highest).** GitHub render = one CDP screenshot per output frame; default **1 capture worker** chosen deliberately for RAM (`browser-capture.ts` comment: "This machine starves below ~1 GB free RAM… opt in with SHOWCASE_CAPTURE_WORKERS=2|3|4 on a roomier machine"). A 5 min 16:9 episode = **~9 000 frames**. At the historical pace of short episodes (each ≈ 1 000–1 700 frames, Stage 6 the longest stage), expect **well over an hour** of capture on this class of machine — plus screenshot/eval overhead, on top of TTS (hundreds of Kokoro segments). Mitigation directions: `SHOWCASE_CAPTURE_WORKERS=2–3` (RAM permitting), disk-frame pattern (news) so a crash loses ≤ seconds of work, and realistic episode-length expectations. This must be engineered, not wished away.
2. **`MAX_DURATION_SECONDS` is a silent audio killer.** `render.ts:62` `Math.min(58, audio)` and `browser-capture.ts:224` equivalent would truncate a 5-min mix to 58 s of video with 5 min of audio → `qa.ts` duration-vs-audio check fails (luckily loud) or, worse, `-t 58` loses the ending with a confusing error message. Any Long-form mode **must** lift/parameterize this first, and Short-form behaviour must remain untouched.
3. **58 s product rule woven into tests.** `tests/media.test.ts`, `qa.ts` defaults, `config.ts` `MAX_DURATION_SECONDS`, README/docs. A clean fork of constants per mode is required; a global raise would silently change Short-form QA thresholds.
4. **Dataset is not a media archive.** Long-form cannot reuse short-form audio/frames (not archived); nearest alternative is re-TTS from `segments` (segments carry `pauseAfterMs` and measured totals only — per-segment timings are absent) or re-render+recompute. Both mean Long-form **re-generates voice**, so exact wording ties to the dataset (good) but timing will differ from the short videos (fine, different cut). Also: dataset records are gitignored, machine-local — a "team" Long-form workflow would lose them on re-clone.
5. **Only 9 usable completed GitHub scripts exist today.** The "select five" flow is legitimate but leaves zero slack; any record with corrupt JSON/missing `facts`/`selection` (readExisting discards silently) shrinks the pool further. A Long-form mode shipped today would frequently "not enough eligible repositories".
6. **No cross-mode identity for episodes.** `node_id` is the only join key across DB↔dataset; a 5-repo episode spanning two runs has no atomicity (crash mid-episode ⇒ some repos "used", ledger inconsistent) unless the long-form ledger reserves **all five atomically up front** and marks them on any terminal outcome (success or definitive failure), with the 30-min-reclaim caveat.
7. **Groq non-determinism & budget.** Same repo ⇒ different script each run (documented in README); a failed Long-form run may consume the daily free-tier budget for little progress; `GROQ_API_KEYS` rotation helps. `llm-prompt/response` artifacts are the only audit trail — Long-form should extend that pattern to the master script (it will be unique per episode).
8. **News `production/` seduction.** The keyframe engine is elegant but: portrait-pinned, frame-clock rationals, unused by any renderer, tested only structurally (`tests/news-production.test.ts`). Adopting it for Long-form would import an unproven path; treat as reference, not foundation.
9. **SFX licence exposure.** `mascot-slide-whoosh.wav` and `callout-pop.wav` have **no recorded origin**; Pixabay MP3s **unverified** (see ATTRIBUTION.md). Any published Long-form video inherits this risk. BGM assets (currently absent) would add new licensing burden.
10. **GitHub anti-bot fragility.** Mobile capture relies on unauthenticated HTML; abuse walls → silent fallback to a **mock** page (by design) which would look out of place in a "real repository" demo if unnoticed; detection exists (`detectFailedPage`) but fallback is opt-in-silent. Long-form must surface "repo #N captured from mock, not live" loudly in progress and QA.
11. **SQLite operational caveats.** Two DBs, no migrations on the GitHub side (`CREATE TABLE IF NOT EXISTS` only — schema drift is possible and silent), WAL sidecars, `node:sqlite` still prints an experimental warning on some builds (explicitly silenced). A third DB file for long-form adds backup surface.
12. **Caption drift on 5-min tracks.** Syllable weighting error accumulates in multi-phrase chunks; without forced alignment, expect visible desync late in long episodes. News's aligner should be lifted into a shared path (or run per episode post-TTS).
13. **16:9 "safe areas" and YouTube UI overlays.** Nothing in the codebase knows about 16:9 safe margins (all tuning is Reels/9:16); a landscape mode needs its own layout constants, or text will collide with YouTube's caption/card UI.
14. **Cost of "wait for keypress" in an unattended pipeline.** Trivial in a human terminal; a blocker for automation/CI; fine for the stated interactive UX.
15. **Testing gap compounds.** Every untested Stage-6/FFmpeg/CDP behavior above is multiplied by 5 repos; an episode is a long lever arm for rare races (EPIPE, stdin backpressure) that already froze Stage 6 once (per the code comment).

---

## M. Outstanding Questions (cannot be answered from source)

**Product/scope**
1. Is Long-form exactly "Pipeline 3" from `docs/future-pipelines.md` (compilation of previously *completed* short-form repos), or a distinct "top-5 evergreen picks" format? The docs assume the former; the brief's "retrieve previously stored short-form repository scripts" agrees, but selection criteria (stars? recency? score? category? diversity?) remain undefined even in the roadmap (open decisions #2/#3 there).
2. May a repository that is in `dataset/github` but not in `repositories.status='completed'` (e.g. manually re-cut) qualify? What about `phase:"pending"` records (script exists, no measured audio)?
3. Should Long-form usage **also** exclude the repo from future Short-form discovery (cross-mode ledger), or is the Long-form ledger independent? Does a Long-form rejection (repo declined by the user during review) count as "used"?
4. Selection "unused": across episodes only, or across all channels (a repo narrated in News can't be — different URL domain, so moot for GitHub repos)?
5. Episode metadata for upload: chapters, pinned comments, description links, category ordering (#5→#1) — in scope?
6. Exact countdown visual design and the supplied front-facing mascot asset: dimensions, transparency, placement grid? (Asset will be supplied later — its spec cannot be inferred.)
7. Is the 5-repository count fixed, or `min(5, eligible)` with graceful degradation when fewer than 5 usable records exist (today: exactly 9, so this will happen)?
8. "Without a strict hard cutoff" — but `MAX_DURATION_SECONDS` is a documented **product rule** (58 s) for Short-form; is raising it for Long-form acceptable, and who signs off on the new rule?
9. BGM: may we add assets, or generate/synthesize (Kokoro has no music), or use none? Which licence basis? Ducking amount? Fade in/out length?
10. SFX beyond whoosh/pop for transitions between countdown beats — desired?
11. Captions: continue syllable estimates, or adopt news-grade forced alignment (adds a `pip install faster-whisper` dependency footprint for GitHub users)?
12. Language/locale: English-only (Kokoro am_fenrir) confirmed? Any multi-presenter (am_fenrir + am_michael) for the countdown?
13. Should failed Long-form episodes retry automatically (attempt budget?) or always surface to the human? Resume semantics for crash mid-episode (`--resume`-like) required?
14. Output naming: `output/longform/<episodeSlug>-<runId>.mp4` (new subfolder) — confirm convention.
15. QA acceptance bar for a 5-minute render: same not-black/motion/loudnorm + new checks (per-repo chapter presence? integrated loudness across episode? A/V sync at episode midpoint)?
16. Should the episode render use the **news-style disk-frames + two-pass encode** (crash resilience) instead of image2pipe?
17. Preview/tuning: new `visual-overrides-16x9.json` or reuse? Live-preview reuse (`tools/preview/`) expected or manual tuning acceptable for v1?
18. Does the user want the five per-repo screen demos to show **source files** from the start (needs new capture type now) or is page-scroll sufficient for the first Long-form iteration?
19. Legal: any branding/trademark constraint on using GitHub pages as visual evidence for a 5-minute commercial-adjacent video (MIT/Apache content fine; page appearance is GitHub's trade dress)?
20. Do existing `output/*.mp4` short videos get mentioned/linked in the episode (they're not in the repo)?
21. Publishing automation (YouTube API/upload) — out of scope obviously, but is any upload metadata pre-generated (e.g., chapter list written into artifacts)?

**Engineering/verification**
22. Where does the Long-form ledger live — inside `db/showcase-history.db` (shared reservation UX) or a new `db/longform-history.db`? Who owns its backups?
23. Atomic reservation of all five up front vs. per-repo reservation as the episode progresses — crash semantics differ; needs a decision.
24. How are per-repo captures bounded (pages can be 10 000+ px tall)? Keep 5.5-viewport cap per repo, or allow deeper tours for feature-rich repos?
25. What happens when a dataset record references a repo that was "completed" but is now archived/deleted on GitHub (page gone → mock fallback in an episode)?
26. Do we keep `pipeline_runs` rows for Long-form episodes (yes, presumably — naming convention `longform:*`)?
27. Target machine for the ~9 000-frame render — documented RAM ≥? (capture workers default 1 implies memory fragility.)

---

## Appendix — Verification performed for this audit

Read-only commands executed: directory scans (`Get-ChildItem`), full reads of `src/index.ts`, `config.ts`, `types.ts`, `github.ts`, `groq.ts`, `history.ts`, `llm-script.ts`, `voice.ts`, `render.ts`, `captions.ts`, `browser-capture.ts`, `mobile-capture.ts` (capture paths), `sfx.ts`, `character-motion.ts`, `caption-overlay.ts` (style blocks), `script-dataset.ts`, `qa.ts` (validateOutput), `tools/scripts-dataset.ts`, `run.bat`, `run.sh`, `README.md`, `package.json`, `requirements.txt`, `docs/future-pipelines.md` (via delegated read), `docs/configuration.md`, `docs/architecture.md`, `dataset/README.md`, `db/README.md`, `.env.example`, `assets/*/ATTRIBUTION.md`, `install/README.md`; `npm test` (532 pass), `npm run check` (clean), `git log --oneline -8`, `git status --short` (clean), read-only `node:sqlite` queries on `db/showcase-history.db` (status counts: 85 completed / 468 discovered / 35 failed; 182 runs), dataset JSON sampling, repo-wide case-insensitive searches for `long-form|16:9|1920|landscape|longform`. A scratch query file was created under the session temp dir and is not part of the repo.

**Not done (by design):** no source/config/test/asset modifications, no dependency installs, no network calls to GitHub/Groq, no video rendering, no `.env` parsing (secrets never read), no destructive tests, no TRD/PRD authoring. News channel findings were gathered by delegated read-only inspection and spot-verified against `src/channels/news/index.ts` excerpts quoted above.

**Confidence:** High for everything cited to code (verified against source on this machine). Explicitly lower for: real-browser behavior on other machines, Kokoro output on different quantizations, Groq's current free-tier limits, SFX licensing, and performance timings (no render benchmark was run). These are marked as such in-line.

