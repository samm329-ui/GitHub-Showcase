# Implementation checklist — Visual, Scroll, Narration, Captions & Character Upgrade

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done + verified

Source plan: `docs/GitHub-Showcase-Visual-and-Narration-Upgrade-Plan.md`
Character assets: `Character/image.png` source, `assets/character.png` cut-out,
`assets/character-close.png` CTA medium crop

## Phase 0 — Audit
- [x] Read the full upgrade plan
- [x] Inventory `src/`, `tests/`, `tools/`, config, run.bat
- [x] Confirm `canvas`, FFmpeg, FFprobe, Python+Kokoro are available
- [x] Confirm current renderer still fabricates a desktop-like GitHub page
- [x] Confirm progress scrubber exists in `card.ts` + `browser-capture.ts`
- [x] Confirm Kokoro reports zero phoneme timings

## Phase A — Remove preview UI, fix composition + motion policy
- [x] `src/config.ts`: remove progress/caption layout zones; add `SCROLL`, `MOBILE_PAGE`, `CHARACTER`, caption/character settings
- [x] `src/types.ts`: add `StorySlot`, optional narrative metadata, `SpeechEnvelope`
- [x] `src/card.ts`: delete `.progress` / `.track` / `.fill` / `.thumb` / `.time`
- [x] `src/card.ts`: captions become an absolute overlay at 66% of the page viewport
- [x] `src/card.ts`: recompute viewport height as `CARD.height - CARD_CHROME_HEIGHT` (1584 px)
- [x] `src/browser-capture.ts`: remove `setProgress` from the frame loop
- [x] `src/timeline.ts`: duration-aware scroll scheduler, continuous midpoint stops, speed ceiling
- [x] `src/timeline.ts`: caption phrase grouping 3–7 words, positive non-overlapping intervals, no late captions
- [x] `src/caption-overlay.ts`: 42 px bold white/yellow captions, outline/shadow, no filled boxes, two lines max
- [x] `src/caption-overlay.ts`: never drop words when wrapping
- [x] Tests updated: progress absence, overlay position, viewport height

## Phase B — Real mobile page screenshot
- [x] `src/mobile-capture.ts` (new): top-level CDP navigation of the public repo URL
- [x] Mobile emulation 405×720 CSS, DSF 2, before navigation
- [x] Bounded navigation/DOM/image/lazy-load waits
- [x] Full-page capture (`captureBeyondViewport` + clip) with tiled fallback for tall pages
- [x] Decode actual raster size and normalize to 810 px content width with `canvas`
- [x] Record `cssViewport`, `raster`, `pixelsPerCssPx`, `documentHeightCssPx`
- [x] Resilient anchor extraction with selector + heading fallbacks
- [x] Anchor offsets converted from CSS px to displayed raster px
- [x] Failed-page detection (404, sign-in, abuse, blank) 
- [x] Logged local mobile-layout fallback from repository data
- [x] Story-span crop based on narration + speed budget (`chooseStoryEnd`)
- [x] `src/asset-server.ts` (new): 127.0.0.1-only asset server, closes in `finally`
- [x] `src/card.ts`: `.document` is a single tall `<img id="mobile-page">` in primary mode
- [x] `src/card.ts`: keep fallback document only for explicit fallback/tests
- [x] `src/index.ts`: capture → crop → measure → timeline → render

## Phase C — Constrained narration grammar
- [x] `src/narration-grammar.ts` (new): StorySlot, ClauseCandidate, eligibility, transitions
- [x] Curated hook/identity/value/proof/demo/setup/availability/caveat/cta templates
- [x] Story structures: utility-first, problem-solution, try-it, developer workflow, trade-off
- [x] Candidate scoring: fact coverage, specificity, duration fit, repetition, opening rhythm
- [x] Deterministic seeded selection; no random truth
- [x] `src/narration.ts`: keep public API (`buildNarrationPlan`, `validateScript`, `selectAngle`, `pickVariant`, `stableHash`, `niceRepoName`, `readmeHighlights`)
- [x] Preserve `styleVariant` diversity + recent-usage avoidance
- [x] Word budget: target + hard max, optional detail added/dropped
- [x] Every segment cites verified fact IDs

## Phase D — Character layer
- [x] Create transparent `assets/character.png` from `Character/image.png`
- [x] `src/character-motion.ts` (new): deterministic `characterPoseAt`
- [x] RMS speech envelope from narration WAV (low rate, EMA-smoothed)
- [x] `src/card.ts`: optional independent `<img id="character">` layer
- [x] `src/browser-capture.ts`: set character transform every frame
- [x] `src/index.ts`: build envelope once per narration
- [x] Absent asset never fails a run
- [x] Placement avoids caption safe area + install heading
- [x] Unit tests: bounded, deterministic, smooth, silence, interpolation

## Phase E — QA, artifacts, docs
- [x] `src/qa.ts`: visual motion check (scrollable clip must move)
- [x] `src/qa.ts`: fixed card/chrome check
- [x] Reference frames at 0/25/50/75/100% + contact sheet
- [x] Save mobile capture metadata + story span JSON in run directory
- [x] `README.md`: mobile capture, network dependency, fallback, character, timing limit
- [x] `TODO.md`: final verified checklist
- [x] `run.bat`: still one command, no new paid services
- [x] `npm run check` clean
- [x] `npm test` clean
- [x] Full end-to-end render inspected with ffprobe + frames

## Phase F — Presenter voice, speech normalization, role-based poses
- [x] Default voice `am_michael`, speed `1.05`, language `en-us`
- [x] `KOKORO_VOICE` / `KOKORO_SPEED` / `KOKORO_LANG` overrides documented
- [x] Audition harness defaults to `am_michael`, `am_fenrir`, `am_puck`
- [x] Generated auditions for all three voices at `1.00` and `1.05`
- [x] `src/tts-text.ts`: speech-only Markdown/code/URL/command cleanup
- [x] Versions, dates, times, percentages and symbols expanded before Kokoro
- [x] `src/pronunciation.ts`: technical acronym and product term coverage
- [x] Captions keep `captionText`; speech uses `segmentSpokenText`
- [x] `tests/tts-text.test.ts`: Markdown, code, commands, versions, display/speech split
- [x] Presenter sized by height (460 px), lower-right, below caption safe area
- [x] `assets/character-close.png` medium CTA crop with face and hands
- [x] Optional `present` / `point` / `close` pose layers with env overrides
- [x] Narration roles choose presenter cues (`demo`/`setup` point, `cta` close)
- [x] Body bob, lean and tilt remain deterministic and speech-envelope driven
- [x] Caption splitter breaks at strong clauses and folds short fragments
- [x] Every generated caption wraps to at most two lines
- [x] CTA medium crop keeps the face and hands in frame
- [x] `README.md`: voice preset, speech boundary, presenter action limitation
- [x] Final real render inspected at 1080x1920, 30 fps, H.264 + AAC
  - `output/sindresorhus-p-map-1dbcce98.mp4`: 33.63 s, 8.68 MiB, AAC 48 kHz stereo
  - 15 captions, all at most two lines; contact sheet and sampled frames checked
  - superseded by the Phase G re-render below (see the new artifact notes there)

## Phase G — Mascot layout, narration IR, voice lock, audio-driven sync
- [x] `MASCOT_LAYOUT` config (`MASCOT_LAYOUT` in `src/config.ts`): anchor
  `bottom-right` of the canvas, `widthRatio 0.46` (497 px of 1080), offsetX -12
  (12 px past the right edge), offsetY 0 (flush bottom), `allowOffscreen`,
  `keepFaceVisible`; env-tunable via `SHOWCASE_MASCOT_WIDTH_RATIO/_OFFSET_X/_OFFSET_Y`
- [x] `src/card.ts` sizes the presenter by canvas-width ratio; clipped at the
  canvas boundary (viewport), never inside the card; strokes/face stay visible
- [x] `src/narration-ir.ts`: `RepoNarration` IR + `compileRepoNarration` +
  `validateNarration`; purpose/mechanism/use-case required when evidence
  exists, omitted (never invented) when it does not; metadata word share capped
  at 35% when explanation evidence exists
- [x] Gate wired into `validateScript`; run writes `narration-structure.json`
- [x] `VOICE_PRESET` (id/speed/language) in one place; `TTS_*` derive from it
- [x] Identical-script auditions regenerated on the real p-map narration:
  `am_liam` 27.8 s, `am_puck` 31.6 s, `am_michael` 37.2 s, `am_fenrir` 32.3 s
  (@1.0) / 31.6 s (@1.05) in `tools/audition/`
- [x] `am_fenrir @ 1.0` locked as baseline after the human listening test;
  speed variants kept for tuning; delivery carried by writing/pauses
- [x] Voice preset + Kokoro model/voices + video spec recorded in
  `render-metadata.json` for every run
- [x] Travel-time pass in `buildScrollKeyframes`: speech-hinted landmarks that
  arrive earlier than the 190 px/s budget allow are delayed until fully
  reachable — late but complete, never stopped mid-air
- [x] 190/190 tests pass (`npm run check` + `npm test`) including new
  narration-structure, mascot-layout and travel-time tests
- [x] Final re-render with the locked voice + new layout + travel-time scroll
  - `output/sindresorhus-p-map-1dbcce98.mp4`: 30.42 s, 8.6 MiB, 913 frames
  - voice `am_fenrir` @ 1.0, `render-metadata.json` records preset + model files
  - scroll arrives fully at every landmark: 5.2s→96, 15.1s→1391, 21.9s→2685
    (previously clipped mid-air), 27.9s→3314px
  - QA gate: ffprobe h264/yuv420p 30fps ✓, AAC 48kHz ✓, audio-video gap 0.01s ✓,
    motion 50.5% ✓, fixed composition 0.37% ✓, 15 captions ≤ 2 lines ✓,
    volumedetect mean -20.0 dB / max -4.5 dB ✓, contact sheet + reference
    frames inspected (mascot bottom-right canvas corner, face/hands visible)

## Phase H — Callout Bubble Attachment, Multi-Callout Diversity & Comic Impact Accents
- [x] Pass 1: Mascot head anchor geometry aligned with CSS offsets; consumed entrance animation transforms (`src/mascot-layout.ts`, `src/card.ts`).
- [x] Pass 1: Asset profiles defined for default PNG, sticker, and fallback SVG; bubble placement and safe text bounding box derived from asset aspect ratio and normalized tail tip (`src/config.ts`, `src/callout-overlay.ts`).
- [x] Pass 2: Multi-cue chronological scheduling with diverse role candidates (purpose, mechanism, example, benefit, differentiator, tradeoff); candidate scoring, diversity bonus, collision shortening (`src/script-composer.ts`, `src/callout-overlay.ts`).
- [x] Pass 3: Created `src/impact-accents.ts` with authored SVG strokes (`three-rays`, `two-rays`, `short-spark`, `sweep`), seeded irregular bursts anchored to normalized mascot zones (hair, shoulders, laptop).
- [x] Pass 3: Layered rendering in `src/card.ts` (`#impact-rear`, character, callout, `#impact-front`, caption panel) with per-frame `setImpactState()` in `src/browser-capture.ts`.
- [x] Pass 3: Timeline schema updated with `impactBursts` and reproducible run effect seed (`src/types.ts`, `src/index.ts`, `src/render.ts`).
- [x] Pass 3: Extended QA checks in `src/qa.ts` (`calloutChecks`, `impactAccentsChecks`, `overlayLayoutChecks`).
- [x] Pass 4: Configuration UI & writer updated in `tools/config-model.js`, `tools/config-writer.ts`, and `tools/preview-live.html` with full callout and impact stroke controls, copy presets, guides, and bidirectional persistence.
- [x] Pass 5: 333/333 unit and integration tests passing (`npm test`, `npm run check`).
- [x] Documentation updated in `README.md` and `TODO.md`.

## Phase I — Synchronized Sound Effects (Mascot Whoosh & Callout Pop)
- [x] Converted source MP3 sound assets to standardized 48kHz 16-bit stereo PCM:
  - `assets/sfx/mascot-slide-whoosh.wav` (duration 0.70s, airy upward sweep entrance)
  - `assets/sfx/callout-pop.wav` (duration 1.03s, rounded playful bubble pop)
- [x] Configured independent toggles, gain, and relative start offsets in `src/config.ts` (`SFX_CONFIG`):
  - `mascotEntrance`: `enabled: true`, `startOffsetMs: 0`, `gain: 0.18`
  - `calloutPop`: `enabled: true`, `startOffsetMs: 20`, `gain: 0.14`
- [x] Defined sound effect types in `src/types.ts` (`SoundEvent`, `SoundEventKind`) and recorded in `timeline.json`.
- [x] Created `src/sfx.ts` implementing:
  - `scheduleSoundEvents()`: exact relative timestamp scheduling tied to animation timeline (mascot entrance at 0ms, callouts at `startMs + 20ms`).
  - `mixAudioTracks()`: deterministic FFmpeg mixing using `adelay`, `volume`, and `amix=duration=first:dropout_transition=0:normalize=0`, preserving exact narration length.
- [x] Integrated into showcase pipeline `src/index.ts` before video render; mixed composite audio passed to Chromium capture/encode.
- [x] Added QA checks in `src/qa.ts` (`soundEventsChecks`) verifying bound timing, subtle gains (<= 0.5), and asset integrity.
- [x] Added comprehensive unit and integration tests in `tests/sfx.test.ts` (343/343 tests passing, clean TypeScript check).
