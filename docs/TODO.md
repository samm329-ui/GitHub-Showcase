# Implementation checklist

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done + verified

## Phase 0 — Audit
- [x] Read README, run.bat, all `src/*.ts`, `kokoro-tts.py`, `tools/kokoro-test.py`
- [x] Verify installed Kokoro interface (`create_timed` exists, returns **0** timings)
- [x] Verify `node:sqlite` available (no new native dependency)
- [x] Audit table published in chat + README

## Phase 1 — Runtime correctness & unified timeline
- [ ] `src/config.ts`: one configurable target duration + hard max 58s, no conflicting constants
- [ ] `src/history.ts`: persistent `node:sqlite` store (repositories, star_snapshots, pipeline_runs)
  - [ ] atomic reservation, completed/failed/interrupted states, malformed-file safety
  - [ ] unique output paths per run (no same-day overwrite)
- [ ] `src/index.ts`: stage-based orchestration, structured logs, artifacts per run
- [ ] Audio is authoritative: no clamping/truncation of narration, export duration from measured audio
- [ ] Verify: `npm run check` + history unit tests

## Phase 2 — Discovery & candidate quality
- [ ] `src/github.ts`: rotating modes, multiple search shapes, README/release/language hydration, cache
- [ ] Hard rejection gates (archived/disabled/fork/empty/dup/reserved/completed)
- [ ] 0–100 transparent score across usefulness, docs, maintenance, adoption, momentum, setup, maturity, novelty
- [ ] Star snapshots → momentum; no "trending" without snapshots
- [ ] Verify: selection/dedup/snapshot tests with local fixtures

## Phase 3 — Fact extraction & narration
- [ ] `src/facts.ts`: typed fact ledger with provenance + confidence
- [ ] `src/narration.ts`: angle selection, several reviewed narrative styles, duration-aware budgets, validation gates
- [ ] `src/pronunciation.ts`: display vs spoken text separation
- [ ] `src/script.ts`: keep `buildRepoFacts` / `makeScript` public signatures, delegate internally
- [ ] Verify: fact/script tests (no unsupported claims, no boilerplate, duration policy)

## Phase 4 — Kokoro TTS & captions
- [ ] `src/voice.ts`: configurable voice + speed, sentence chunks, per-chunk measured duration, concat
- [ ] `src/kokoro-tts.py`: expose speed/metadata, report real sample rate, request timings when available
- [ ] Voice audition harness (`tools/kokoro-audition.py` + `npm run voice:audition`)
- [ ] `src/timeline.ts` + `src/captions.ts` + `src/caption-overlay.ts`: measured audio timing, phrase-level captions, no per-word yellow boxes
- [ ] Verify: caption timing/monotonic/pause tests

## Phase 5 — Stationary 9:16 card + measured scrolling
- [ ] `src/card.ts`: 1080×1920 stage, 810×1668 card, #F2EFE9 bg, #0D1117 card, 28px radius, neutral shadow
- [ ] Fixed chrome (browser bar/captions/progress) + single clipped scrolling document
- [ ] `src/scroll.ts`: measured anchors → clamped keyframes, easeInOut, hold time
- [ ] `src/browser-capture.ts`: Chromium DOM capture of the card, anchors measured from the live DOM
- [ ] `src/render.ts`: frame-accurate FFmpeg encode + audio mux, duration from measured audio
- [ ] `src/qa.ts`: dimensions / fps / pix_fmt / audio stream / duration / freeze checks
- [ ] Verify: geometry, anchor clamping, end-to-end render test

## Phase 6 — Tests, README, delivery
- [ ] Tests for all six required areas (selection, facts, script, TTS/captions, scroll/card, media QA)
- [ ] README updated to match reality (voice engine, settings, limits, commands, limitations)
- [ ] `npm run check` clean, all tests run and reported
- [ ] Final summary: files changed, per-stage changes, test results, remaining limitations