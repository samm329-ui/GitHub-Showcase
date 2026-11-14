# Octavia — Long-form GitHub Video · Technical Requirements Document (as built)

**Date:** 2026-11-14 · **Status:** Implemented and verified (see `docs/longform/delivery-report.md`) · **Supersedes nothing** — Short-form and News remain frozen.

## 1. Scope and non-negotiables

- Separate production mode inside the existing GitHub Showcase application: menu `[1] GitHub → [2] Long-form Video (16:9)` and `npm run start:longform` / `./run.bat longform`.
- Short-form unchanged: `MAX_DURATION_SECONDS=58`, `VIEWPORT 1080×1920`, card layout, SFX, history DB all untouched (proved by unchanged passing tests).
- 1920×1080 16:9, 30 FPS, H.264 High@4.0, yuv420p, AAC 48 kHz stereo, MP4, `+faststart`, target ≈ 285 s (soft window 270–315 s), duration sourced from the measured narration. No truncation path exists.
- Repositories: exactly five, deterministic quality-based selection, permanent no-repeat ledger, strongest = rank 1 = appears last, presentation order 05→01, **no rank numbers ever shown on screen** (typography-reveal intros replace all cards).

## 2. Module map (all under `src/longform/`)

| Module | Responsibility | Key exports |
|---|---|---|
| `config.ts` | 16:9 profile constants, asset paths, tokens, phases, licence flag | `LONGFORM`, `MASCOT_ASSETS`, `MUSIC_BED`, `SFX`, `PHASES` |
| `types.ts` | Episode/capture/scene contracts | `SelectionResult`, `MasterScript`, `SceneManifest`, `CaptureBundle` |
| `camera.ts` | Pure keyframe math + FFmpeg crop expressions (piecewise ease-in-out cubic, clamped window) | `CameraKey`, `sampleCamera`, `buildCameraCropExpr`, `cropWindow` |
| `db.ts` | `db/longform-history.db` — versioned `schema_migrations` (WAL, backups), `episodes`, `episode_repositories`, `longform_repository_usage UNIQUE(node_id)`, atomic `reserveEpisode` transaction | `LongformHistory` |
| `dataset-loader.ts` | Read-only reconciliation of `dataset/github/*.json` → eligibility + base score (documented in code: facts≤20, readme≤30 log, segments≤10, stars≤20 log, recency≤10, license 5, alignment 5) | `loadCandidates`, `reconcileDataset`, `scoreBase` |
| `repository-selector.ts` | Deterministic diversity-aware greedy pick of 5 (penalty: 8/same primary language, 6/topic jaccard≥0.25), rank by (selectionScore desc, nodeId asc), presentation = reverse | `selectFive`, `diversityPenalty`, `previewSelection` |
| `master-script.ts` | One Groq call; evidence packets (≤12 facts, 1500-char README excerpt, per-repo metadata); strict validation (order, hook, factIds ⊆ packet, ≥3 segments/repo, 480–1200 words, name spoken in identify segment, highlight target must exist in evidence); **one** bounded repair attempt; pauses deterministic | `buildEvidencePacket`, `generateMasterScript`, `validateMasterScript`, `toMasterScript` |
| `scene-planner.ts` | toSynthSegments (purpose coercion), per-segment timings from forced alignment (word.segmentId), monotonic back-to-back scenes; per repo: 1 typography-reveal overlapping the narration start + content scenes grouped by visualTarget (overview/readme-section/install/code-file); camera keys per scene; mascot cues (≤2/repo + escort opening/closing); callouts from `visualTarget.detail`; SFX event list | `toSynthSegments`, `planScenes` |
| `capture.ts` | Desktop 1920×1080 CDP capture: navigation + `detectFailedPage`-style authenticity checks (404/sign-in/abuse/blank/identity); **no mock fallback**; tiled `captureBeyondViewport` → canvas stitch → `overview.jpg` + anchors (h1–h3/repo-header/README headings with offsets); DOM `resolveHighlightRects` (smallest element containing the needle; invalid → highlight dropped, warning logged); source-file blob capture (`chooseSourceFile`: package.json entry → conventional candidates → largest top-level source) | `captureRepositoryPage`, `captureRepositoryBundle`, `chooseSourceFile`, `captureSourceFile` |
| `captions.ts` | Aligned words → 2–5-word phrase groups (max 2 lines, trailing 1-word fold); deterministic style cycle ≈55/20/15/10 (static-focus / slide-up+side / pop / reveal+highlight-bar); auto-emphasis of product-name-like tokens; ASS with `\kf` karaoke sweep, Inter fontsdir burn; `.srt` sidecar | `groupIntoPhrases`, `assignStyles`, `captionsToAss`, `captionsToSrt` |
| `render.ts` | Hybrid compositor: per scene → bounded `segment-NNN.mp4` (video-only); camera = per-frame `crop`/`scale` filter expressions (numeric piecewise ease-in-out); highlights placed at the **static settle state** of the camera (they appear after the push-in, by design); overlays (highlight PNGs, callout pill, title PNG, mascot PNG) as extra inputs with fade/slide expressions; captions burned last via libass; **segment reuse by content hash**; `concatSegments` → video-only concat → `muxAudio` (AAC 48k stereo +faststart) | `renderSegment`, `buildSceneFilterGraph`, `concatSegments`, `muxAudio`, `ensureTitlePng`, `ensureCalloutPng`, `makeBlurredCaptureBackground` |
| `audio-mixer.ts` | Licence-gated mixing: narration −18 LUFS-normalized +2×, BGM looped (`-stream_loop`) −13 dB-ish with `sidechaincompress` ducking (attack 25 ms, release 420 ms), per-event SFX gain table, amix normalize=0, final loudnorm I=−14/TP=−1.5, PCM s16le 48k stereo | `mixEpisodeAudio`, `scheduleSfxFromScenes` |
| `music-manager.ts` | Licence gate reading `assets/longform/asset-licenses.json`; every used asset must be `verified`, or `LONGFORM_ALLOW_UNVERIFIED_ASSETS=1` (dev mode, loud warning, recorded in QA) | `verifyUsedAssets`, `productionAssetFiles` |
| `qa.ts` | Independent 16:9 QA: ffprobe probe, dimensions/fps/codec/pixfmt, audio stream, duration-vs-audio (±3%/2s), audio-reaches-end, not-blank, loudness, true peak | `validateLongformOutput` |
| `checkpoint.ts` | Fingerprint-based stage checkpoints (`checkpoints/<stage>.json`) — stages reuse outputs only when inputs match (master-script, narration, alignment, per-repo captures, render segments) | `CheckpointStore`, `fingerprint` |
| `preflight.ts` | ffmpeg/ffprobe/Kokoro/Groq-key/Chromium/assets/**licence gate**/dataset readiness/storage writability | `runPreflight` |
| `progress.ts` | Real counters: PHASES header `[n/11]`, per-repo sub-steps, render % from completed segments | `Progress` |
| `index.ts` | Phase machine 1–11, dry-run, resume via reserved episode (never re-selects), TTY wait-for-keypress | `main()` |

## 3. Data flow

```
PREFLIGHT ─► RECON (read-only) ─► SELECT (deterministic) ─► RESERVE (single transaction)
   ─► MASTER SCRIPT (Groq, 1 call + ≤1 repair) ─► NARRATION (Kokoro) ─► ALIGNMENT (faster-whisper, ≥99% gate)
   ─► CAPTURE (desktop CDP, authentic-only) ─► COMPOSE (scene manifest + camera + titles)
   ─► AUDIO (loop+ duck + SFX) ─► RENDER (segments, reuse) ─► QA ─► FINALIZE (artifacts + ledger)
```

Timing truth: measured Kokoro chunk durations → concatenated `narration.wav` → forced word alignment → captions and the scene manifest inherit those absolute ms. The 5-minute target never truncates; the alignment and current gate treat coverage < 99% as a hard failure (`LONGFORM_ALIGN_DEGRADED=1` overrides loudly).

## 4. Persistence

- `db/longform-history.db` (separate file) — `episodes`, `episode_repositories`, `longform_repository_usage` with `UNIQUE(repository_node_id)`. `reserveEpisode` runs `BEGIN IMMEDIATE` and re-checks usage for all five inside the transaction → concurrent instances cannot overlap. A failed episode keeps its five. Dry-run never reserves. An existing incomplete episode resumes with the same five (never re-selected). Backup: timestamped copy taken before any migration (`*.pre-migrate-<ts>.bak`). **Not** a cross-machine guarantee.
- Artifacts: `temp/longform/<episodeId>/` (workDir) and `output/longform/<episodeId>/final.mp4` + `episode-metadata.json`, `chapters.json`, `captions.srt|.ass`, `scene-manifest.json`, `asset-licenses-used.json`, `qa-report.json`, `contact-sheet/`.

## 5. Motion / caption / audio contracts

- Captions: phrase groups (2–5 words, ≤2 lines), ASS `\kf` karaoke + deterministic style cycle ≈55/20/15/10, auto-emphasis of product names, Inter via fontsdir; ≤2 emphasis words per phrase; bottom-safe 100 px, sides 100 px.
- Camera: keyframe-driven `crop` window inside a fixed 1920×1080 viewRect; ease-in-out cubic; overview push-in 1.0→1.08, README 1.0→1.07, code 1.0→1.13, hold when no semantic need to move; direct hard cuts everywhere.
- Highlight: constant world-space rect (DOM hit-test at capture), rendered as a rounded translucent-blue overlay that **appears only at the camera's static settle point** (post-push-in); never arbitrary.
- Typography reveal intros: blurred real capture + 66% black overlay, Inter 900 white, opacity fade (0.4 s in / 0.4 s out), appears ~120 ms after scene start, holds < 2.4 s, direct cut into the footage. Locked: no countdown numbers anywhere.
- Audio: narration wins always; BGM ducked via sidechaincompress; SFX only on actual timeline events (mascot entry/landing, reveal-hit per reveal, title-reveal, camera-push, zoom-impact, code-highlight, feature-reveal, callout pop, outro). Never on every caption/word; never restarting at repository boundaries; loudnorm I=−14/TP=−1.5 on the final mix.

## 6. Failure and recovery model

- Every expensive stage is content-fingerprinted; a resume recomputes only stale/missing pieces; render segments are individually reusable by hash. Capture failure ⇒ stage fails ⇒ episode `failed` with stage recorded ⇒ resume re-captures (never falls back to fake footage). Groq failure ⇒ ≤1 validation repair ⇒ loud failure, episode marked failed. QA failure ⇒ not complete, ledger keeps the five. Checkpoints cleared only on full success.

## 7. Verified-by-default limits (documented, not silently wrong)

- Only 9 completed GitHub dataset records exist today; all selection is honest about that ceiling (preflight prints the exact count and blocks below five).
- `ffmpeg -preset veryfast -crf 20` chosen for 1080p/30fps reliability over marginal quality gains.
- The SFX entry whoosh is 8 s; only its first ~1.2 s is used at the opening. BGM loops seamlessly (`-stream_loop`), never restarts per repository.
- Render throughput measured at ~14 fps/segment on this machine (see `docs/longform/renderer-benchmark.md`) → a ~5-minute episode is ≈ 11 minutes of render compute; memory stays flat (per-segment bounded).

## 8. Out of scope / never in scope

No Short-form changes (config, card, SFX, DB). No News changes. No new paid services. No Playwright. No redesign of the mascot. No `repositories.status` re-use for Long-form.
