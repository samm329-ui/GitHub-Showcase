# Pipelines 3 & 4 â€” Roadmap, Assessment and Open Decisions

**Date:** 2026-11-13
**Status:** Assessment + design notes. **Nothing in this document is implemented.**
**Audience:** Future implementation sessions (tomorrow onwards)

---

## 0. Context

The project is evolving from a single-purpose video generator into a four-track
pipeline family. All four tracks share the same engine and the same rules:
Kokoro TTS (measure audio first), captions + speech separated by `src/tts-text.ts`,
real browser screenshots over CDP, Chromium â†’ FFmpeg render, QA gate, `node:sqlite`
history, human gates for news. The four tracks:

| # | Pipeline | Status | Format |
| --- | --- | --- | --- |
| 1 | GitHub Repository Showcase â€” single repo, ~35â€“58 s | **Done** (in production) | 1080Ã—1920, 9:16 |
| 2 | Lazy News Commentary â€” one story per episode, ~49â€“90 s | Under construction | 1080Ã—1920, 9:16 |
| 3 | **Top-5 GitHub repositories** â€” long YouTube compilation built from previously generated scripts | **Not started** | Long format (â‰¤ 58 min), 16:9 expected |
| 4 | **Weekly news compilation** â€” one long video per week from the daily episodes | **Not started** | Long format (â‰¤ 56 min), English, 2 speakers |

Pipelines 3 and 4 reuse the scripts of 1 and 2 rather than writing new ones â€”
the script dataset (`dataset/`) was created for exactly this purpose.

---

## 1. Question 1 â€” Is the pipeline ready for Pipelines 3 and 4?

**Verdict: No. Foundation: yes. Capability: not close.**

Everything today produces **one clip, one speaker, ~35â€“90 s, 9:16**. Pipelines 3
and 4 are a different product shape (long form, multi-part structure, possibly
multi-speaker). The gaps are concrete, not architectural:

### 1.1 Pipeline 3 â€” Top-5 GitHub repositories compilation

| Need | Status | Notes |
| --- | --- | --- |
| Reuse existing scripts without re-writing | ðŸŸ¢ | `dataset/github/*.json` stores segments (spoken + caption text) verbatim, plus provenance and phase |
| "Which repositories were already covered" | ðŸŸ¡ | `repositories.status = 'completed'` in `db/showcase-history.db`; no concept of "already used in a compilation" |
| Scripts re-renderable from dataset alone | ðŸ”´ | Dataset does **not** include the repo capture (mobile screenshot), README snapshot, per-segment measured timing, or audio |
| Audio reuse (no re-TTS of compiled episodes) | ðŸ”´ | `narration.wav` lives in `temp/` â€” scratch space, may be deleted at any time |
| Long-format design (16:9, chapters, repo cards, intro/outro) | ðŸ”´ | Entire renderer is a single stationary 1080Ã—1920 card |
| Top-N selection policy (stars? recency? manual?) | ðŸ”´ | Undefined â€” needs product decision |
| Compilation bookkeeping (which run was in which compilation) | ðŸ”´ | No `compilation_members` / `compilation_runs` table exists |
| CI/QA for 30â€“58 min exports | ðŸ”´ | All current QA assumptions are scoped to < 90 s |

**Pipeline 3 detail notes**

- The dataset is a **script archive, not a media archive**. It is sufficient to
  reconstruct the *wording*, not the *media*.
- The three pieces of per-episode state that must be preserved to compile without
  re-render are: **(a)** the captured mobile screenshot (`temp/<run>/work/capture/*`),
  **(b)** the measured timeline (`temp/<run>/timeline.json` / alignment), and
  **(c)** the synthesized audio (`temp/<run>/audio/narration.wav`). All three are
  currently treated as scratch and will disappear.
- The scoping risk is **scope creep into "re-render everything"**. Compilation
  should concatenate *pre-rendered* episode videos; re-rendering is the fallback
  when the video file is missing â€” and it requires the three items above.

### 1.2 Pipeline 4 â€” Weekly news compilation

| Need | Status | Notes |
| --- | --- | --- |
| Weekly episode inventory | ðŸŸ¢ | `dataset/news/*.json` + `news_episodes` in `db/news-history.db` |
| News fact/ledger correctness | ðŸŸ¢ | Gates A/B already enforced â€” weekly reuse keeps them |
| De-duplication of stories | ðŸŸ¢ | Fingerprint exclusion exists in `NewsHistory.excludedStoryFingerprints()` |
| Two speakers per episode | ðŸ”´ | `VOICE_PRESET` is a single voice; no roleâ†’voice mapping anywhere |
| Cloned voices | ðŸ”´ | **Kokoro cannot clone voices.** Fixed voices only: `am_fenrir`, `am_liam`, `am_michael`, `am_puck` (already in `samples/voice/`) |
| Multi-speaker script format | ðŸ”´ | `EpisodeScript` has no `speaker` field per narration line |
| Weekly roll-up selector | ðŸ”´ | Nothing groups episodes by ISO week or marks "already in this week's compilation" |
| ~56 min render budget / long-form QA | ðŸ”´ | Everything assumes â‰¤ ~90 s clips |

**Pipeline 4 detail notes**

- English-only is already satisfied â€” both channels are English.
- Two-person talk **without cloning** is possible today with the four voices
  above (propose `am_fenrir` + `am_michael` as cast). Voice mapping is a code
  change, not a research project.
- **Cloned voices** require an external model (XTTS-v2, F5-TTS, or OpenVoice â€”
  local, quality varies, CPU-heavy) or a paid API (ElevenLabs, PlayHT). Either
  way it is a separate project with a **consent** requirement (whose voice is
  it, and do they agree to it being used for AI-generated content?).
- The weekly format is conceptually closer to a "podcast episode" than to the
  current news reel â€” design it as such from day one.

---

## 2. Question 2 â€” Why can't the browser save the frame into production?

**Short answer: it can â€” today, in fact. But only parameter-level, not frame-level.**

### 2.1 What exists and works today (every OS)

| Path | What it does |
| --- | --- |
| `run.bat` / `run.sh` / `run.command` â†’ `npm run preview:launch` | Starts the helper server and opens the preview page |
| `npm run preview:live` (server only) | Opens the preview; save still works |
| Click **Save (one click)** in the page | Page POSTs JSON to `http://127.0.0.1:<port>/api/save` â†’ server atomically writes **`visual-overrides.json`** at the repo root â†’ pipeline merges it at startup (`src/visual-overrides.ts`) |
| "Save to folderâ€¦" button | Page writes the same file itself via the **File System Access API** (Chromium-family, user gesture required) |
| "Copy text" textarea | Manual fallback â€” paste into your editor to create/merge the file |

Precedence is: environment variable â†’ `visual-overrides.json` â†’ committed default.

**This works on every OS** because the save path is: (1) an HTTP POST to a local
Node server, or (2) a Chromium File System Access write, or (3) manual copy.
No browser extension, no plugin, no filesystem hack required.

### 2.2 Why it *feels* impossible â€” the real constraint

`visual-overrides.json` is a **typed schema of parameter values** (mascot size,
card geometry, captions, callout, accents, highlight colourâ€¦). It is not the
frame. The browser cannot save "the frame" because:

| Thing you want to change from the browser | Saved by the preview? | Why |
| --- | --- | --- |
| Mascot width/offset/shadow, pose PNG filename | ðŸŸ¢ | It's a slider in `visual-overrides.json` |
| Caption font size, weight, colour, highlight colours | ðŸŸ¢ | Sliders/colour pickers in the JSON |
| Card width/height/radius/shadow, callout geometry | ðŸŸ¢ | Same |
| Impact accent colours/timings | ðŸŸ¢ | Same |
| **The card's HTML structure** (`src/card.ts` template string) | ðŸ”´ | It's HTML source; a browser cannot and should not patch it |
| **The news scene** (`src/channels/news/scene.ts`) â€” anchors, layers, timings, typography | ðŸ”´ | **No preview exists at all** â€” scene is hardcoded |
| **The render path** â€” scroll choreography, caption timing math, SFX scheduling, pose logic | ðŸ”´ | It's runtime code, not config |
| **Any design decision not already in the JSON** | ðŸ”´ | Unknown parameters |

The browser sandbox is the hard boundary: an HTML page cannot write to the
filesystem on its own. The two channels that exist today get around this with
(a) the local helper server (primary path) and (b) the File System Access API
(fallback, Chromium only) â€” and every browser keeps the manual copy as a last
resort.

### 2.3 The design question is therefore: *what may the browser write?*

Any answer to "let me edit the frame in a browser" is really answering:

> Which subset of the visual system is **data** (a file the browser may write),
> and which is **code** (the renderer)?

Three coherent positions:

| Option | What the browser may write | Effort | Risk |
| --- | --- | --- | --- |
| **A â€” Keep as tuning** | `visual-overrides.json` (existing) | 0 (today) | Low |
| **B â€” Shared `design.json` for both channels (recommended)** | All visual parameters for both channels in one typed schema: GitHub + News | ~1â€“2 days | Low â€” it's the same pattern as `visual-overrides.json` |
| **C â€” Full frame-template editor** | Named, versioned HTML templates in the repo; JSON slots per template | Weeks | High â€” scope explosion; template validation and security surface |

**Recommendation: Option B.**

- One schema (`design.json`), one save path, both channels.
- News scene finally becomes editable: dim %, anchor positions, entrance/idle
  parameters, note phase, callout typography, subtitle size, SFX gains, Reels
  overlay presets.
- The browser never writes arbitrary HTML â€” only validated, bounded numbers/
  strings/booleans. That keeps both correctness and security.
- Implementing Option C only makes sense if a non-developer must redesign the
  card itself; even then, the safer path is a disciplined template system, not
  freeform HTML injection from a browser.

**Concrete work items Option B requires:**

1. `src/design.ts` â€” the typed schema + loader + clamp/validation (pattern:
   `src/visual-overrides.ts`).
2. `src/channels/news/scene.ts` â€” constants â†’ consumed from `design.json`.
3. `tools/preview-news/` â€” a preview page for the news scene: sliders for all
   scene parameters, one-click save â†’ default + override merge, safe-zone overlay.
   (Already specced in `docs/lazy-news.md`; reuse the GitHub preview as the base.)
4. `tools/news-config-writer.ts` â€” the save path for the news preview
   (analogous to `tools/preview/shared/config-writer.ts` + `config-model.js`).
5. `docs/configuration.md` â€” `SHOWCASE_DESIGN_DIR` row.

---

## 3. Proposed order of work (after this document)

| Phase | Goal | Effort |
| --- | --- | --- |
| **P0** | This document + format decisions (Â§4) | done |
| **P1** | Option B: shared `design.json` + news preview page + save path on every OS | ~1â€“2 days |
| **P2** | Pipeline 3 prerequisites: dataset enrichment (repo metadata, audio copy-in, per-segment timing) + compilation bookkeeping | ~1 day |
| **P3** | Pipeline 3: compilation renderer (16:9, chapters, intro/outro); select top-5 completed repos | ~3â€“5 days |
| **P4** | Pipeline 3 QA + end-to-end compile | ~1 day |
| **P5** | Pipeline 4: multi-speaker script + roleâ†’voice mapping (2 Kokoro voices, English) | ~1â€“2 days |
| **P6** | Pipeline 4: weekly roll-up CLI (group episodes by ISO week, exclude already-compiled) | ~1 day |
| **P7** | Pipeline 4 QA + end-to-end weekly | ~1â€“2 days |
| **P8 (optional)** | Cloned voices â€” model selection + license/consent review | weeks, uncertain |

**Do not start P5 before P4 is rendering end-to-end.** Pipeline 3 proves the
compilation machinery on the simpler case; Pipeline 4 is the same machinery
plus multi-voice casting.

---

## 4. Decisions required (tomorrow's session)

1. **Format decision** â€” Option A/B/C for Q2. (Recommendation: **B**)
2. **Pipeline 3 selection metric** â€” what does "top 5" mean?
   - By stars (all-time)?
   - By stars at compile time?
   - By recency (repos completed in the window)?
   - Manual shortlist per compilation?
3. **Pipeline 3 ordering** â€” by stars, by completion date, or by score?
4. **Compilation bookkeeping** â€” table in `db/showcase-history.db`
   (`compilation_runs` + `compilation_members`) â€” OK?
5. **Pipeline 4 cast** â€” two Kokoro voices (am_fenrir + am_michael) or cloned
   voices? If cloned: which model and whose voice?
6. **Weekly format** â€” any repeating segments (intro/outro/sponsor), any target
   chapter structure?
7. **16:9 vs 9:16** for Pipelines 3 & 4 â€” confirm 16:9 (YouTube default).
8. **Audio reuse vs re-TTS** â€” copy per-episode narration into the dataset
   (`dataset/<id>/narration.wav`) at completion time â€” OK? Cost: a few MB per
   episode; benefit: compilation never re-renders audio. (Recommend yes.)

---

## 5. Reference map

- Script dataset contract: `dataset/README.md`
- Dataset implementation: `src/script-dataset.ts`
- DB folder and split rationale: `db/README.md`
- GitHub history schema: `src/history.ts`
- News history schema: `src/channels/news/history.ts`
- Lazy News spec: `docs/lazy-news.md`
- News render: `src/channels/news/render-news.ts`
- News secne: `src/channels/news/scene.ts`
- Live preview: `tools/preview/`
- Visual overrides: `src/visual-overrides.ts`
- Bundled fonts: `assets/shared/fonts/`
- Kokoro voices: `samples/voice/` (am_fenrir, am_liam, am_michael, am_puck)

---

## 6. Known limitations of the current state (for honesty)

- The news channel has **no** override system and **no** preview; tuning is
  source-code-only via `src/channels/news/scene.ts`.
- `docs/lazy-news.md` partially describes a news preview page that does not
  exist yet (it was planned but never built â€” correct the spec as part of P1).
- The GitHub preview saves to `visual-overrides.json` â€” but the file is
  gitignored, so any machine-dependent tuning is local. Compilations on another
  machine require the file to be copied alongside the configured fonts/art.
- `visual-overrides.json` covers ~70 parameters; none cover the card's HTML
  structure, the news scene, or the render path.
- The script dataset deliberately stores the script and QA metadata â€” it does
  **not** store the MP4, the narration audio, or the page capture.

