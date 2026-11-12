# Architecture

One engine, two channels. Both render a 1080×1920 (9:16) narrated, captioned
Reel with the same rules: Kokoro TTS locally, measured-audio timeline, real
mobile-width browser screenshots driven over Chrome DevTools Protocol, FFmpeg
H.264 export, QA gates, SQLite run history.

## Channels

| Channel | Entry point | Flow |
| --- | --- | --- |
| GitHub Repository Showcase | `npm run start -- --repo owner/name` | discover → fetch → fact ledger → Groq script → Kokoro → render |
| Lazy News Commentary | `npm run start:news -- --discover --topic ai` | discover (RSS/GDELT/Bluesky) → evidence ledger → Gates A/B → Kokoro → render |

Lazy News is **not** a genre fork: it is the same pipeline with a different
content-intelligence stage (corroborate → claim ledger → script) and a different
presenter (the lazy office commentator from `assets/news/`). See
[`lazy-news.md`](lazy-news.md) for the channel spec.

## Runtime environment (cross-OS)

- **Installers** (`install/`): `node` checks Node ≥ 22.5, `npm install`, type-check;
  `python` run-tests `python`/`python3`/`py` (the Windows Store stub is skipped
  because it isn't an interpreter), creates a repo-local `.venv`, installs
  `requirements.txt`, and downloads the Kokoro v1.0 models into `models/kokoro/`.
  One file per OS: `node.bat` / `node.sh` / `node.command` (macOS double-click),
  same for python.
- **Runners** (repo root): `run.bat` (Windows), `run.sh` (Linux/macOS),
  `run.command` (macOS double-click). Same interactive menu; direct invocation
  via arguments passes straight to the pipeline.
- **Python resolution** (`src/python.ts`): `PYTHON` → repo `.venv` (POSIX or
  Windows layout) → `python` → `python3`, probed by importing the required
  modules. npm scripts route Python through `tools/run-python.mjs`, the same
  resolution, so `npm run voice:audition` works on every OS.
- **Chrome/Edge discovery** (`src/chrome-paths.ts`): env override (`CHROME_BIN`
  / `LAZY_NEWS_CHROME`) → well-known install locations per OS → `which`/`where`
  on PATH. Shared by the GitHub CDP harness and the Lazy News Chromium pair.
- **Fonts** (`assets/shared/fonts/`): the latin subsets the renderers use
  (Roboto 400/700/900, Inter 700/900, Inter ExtraBold Italic, Montserrat
  ExtraBold Italic, Roboto Mono 400) are inlined as `@font-face` data URIs at
  render time (`src/font-faces.ts`), so the output is identical on Windows,
  Linux and macOS regardless of installed system fonts.

## Pipeline stages (GitHub channel)

1. **Selection** (`src/github.ts`) — rotating discovery modes with hard rejection
   gates and a transparent 0–100 score; never-before-completed repositories only.
2. **Facts** (`src/facts.ts`) — typed fact ledger with provenance and confidence.
3. **Script** (`src/llm-script.ts`, default; `src/script-composer.ts` for
   `SHOWCASE_SCRIPTER=rule`) — Groq writes grounded JSON segments; sanitized and
   mapped onto the same `NarrationPlan` the rest of the pipeline consumes.
4. **Speech** (`src/voice.ts` → `tools/python/kokoro-tts.py`) — Kokoro `am_fenrir`
   locally; speech passes through `src/tts-text.ts` which expands versions,
   dates, acronyms etc. Captions use the authored `captionText` untouched.
5. **Alignment & timeline** (`src/timeline.ts`) — measured per-chunk audio durations
   are authoritative; captions, scroll and gestures are rebuilt from them. A too-long
   script is shortened and regenerated, never sped up.
6. **Render** (`src/card.ts`, `src/browser-capture.ts`, `src/render.ts`) — real
   mobile-width screenshot of the public GitHub page inside a stationary card;
   FFmpeg crops/composes; `-16 LUFS` loudnorm.
7. **QA** (`src/qa.ts`) — per-run `qa.json`; history in `db/showcase-history.db`.

## Visual composition & the preview

Presentation tuning (mascot width/offset/shadow, card geometry and radius,
caption style/motion, callout bubble, impact accents, highlight colours) is
authored in the live preview:

- `npm run preview:launch` starts the helper server and opens
  `tools/preview/preview-live.html` in your browser.
- Save writes **`visual-overrides.json`** at the repo root — the one file the
  preview owns — via `tools/preview/config-writer.ts` (server path) or the
  shared `tools/preview/config-model.js` (browser folder fallback).
- The pipeline merges that file over the committed composition at startup
  (`src/visual-overrides.ts`). Precedence: env var → file → committed default.
  Invalid files are ignored with a warning; the card re-centres from the
  stored width/height.
- The two halves never touch — `tests/config-writer.test.ts` asserts the
  preview and the renderer consume the same defaults.

## Repository layout

```
src/            pipeline engine (TypeScript, ESM)
  channels/     channel-specific code (news/)
tools/
  preview/      live preview: server, page, shared model, writer
  python/       Kokoro wrapper, audio aligner, asset prep
  assets/       media processing utilities
  windows/      Chrome launcher helpers
assets/
  github/       GitHub channel artwork (presenter, callout, sfx)
  news/         Lazy News artwork (original, layers, reference)
  shared/fonts/ bundled latin subsets (Roboto, Inter, Montserrat, Roboto Mono)
install/        one-click installers per OS (node + python)
docs/           architecture.md, configuration.md, lazy-news.md, archive/ (historical plans)
samples/        voice auditions (gitignored)
models/kokoro/  Kokoro model files (gitignored, download separately)
temp/           per-run artifacts + scratch/ for experiments
output/         final MP4s
db/             SQLite history DBs (one per pipeline — see db/README.md)
dataset/        archived narration scripts, one per channel (see dataset/README.md)
```

## Cross-cutting rules

- One timeline: measured audio is the single source for captions, scroll and
  gestures — nothing else schedules time.
- Nothing is invented: Groq writes only from the fact ledger/README excerpt;
  Lazy News facts must pass the claim-level verifier before reaching the script.
- Failures are loud. There is no silent fallback between writers, and no
  bypass for the Lazy News human gates.
