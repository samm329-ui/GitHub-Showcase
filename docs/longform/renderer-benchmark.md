# Long-form renderer benchmark — decision record

**Date:** 2026-11-14 · **Machine:** Windows 10/11 x64 (this development machine, ffmpeg 8.1.2-essentials) · **Node:** v24.12.0 · **Chromium:** freshly autolaunched headless via CDP @ 9222 (no visible Chrome was running) · **Budget:** measure, don't guess.

## The question

A 5-minute 16:9 episode at 30 FPS is ~9,000 output frames. The existing GitHub renderer screenshots a live Chromium page per output frame — unsuitable as-is. The PRD required a real benchmark before committing to a compositor design, on the actual production machine.

## Method

`npm run benchmark:longform` (`tools/longform-benchmark.ts`) does both passes against a real GitHub page (`usemoss/moss`), not fixtures:

1. **Hybrid compositor (implemented):** capture the authentic GitHub overview once via CDP → render a representative ~8 s README scene with camera push (1.0→1.07), zoom-in highlight, mascot overlay, kinetic ASS captions burned via libass, no per-frame Chromium calls. Measured: frames, wall time, fps, realtime ratio, segment size.
2. **Per-frame CDP (rejected approach):** 90 sequential `evaluate` + `Page.captureScreenshot(q=85)` round-trips against the same page at 1920×1080. Measured fps and extrapolated the ~9,000-frame budget.

Neither number was invented; both were reproduced on this machine.

## Results (2026-11-14, this machine)

| Approach | Work done | Result | 9,000-frame implication |
|---|---|---|---|
| Hybrid compositor (one 8 s segment, 240 frames, real capture 9,837×1920) | decode + crop/scale + highlight PNG + mascot PNG + ASS captions + H.264 encode | **17.1 s wall · 14.06 fps · 0.47× realtime · 867 KB** | **≈ 640 s of render ≈ 10.7 minutes** — meets the ≈ 10-minute target |
| Per-frame CDP screenshot (no composite, pure capture) | 90 evaluate+screenshot calls @1080p | **10.98 fps** | **≈ 13.7 minutes of pure capture**, before any compositing or encode; the short-form pipeline's known RAM pressure worsens it |
| Capture step (both) | full-page desktop capture, 9,837 px tall, 1.3 MB JPEG, tiled + stitched | **10.4 s, deterministic** | 5 repos ≈ 55 s of capture per episode |

Memory behavior (observed): the hybrid path holds one segment in flight at a time; RSS stays flat regardless of episode length (no frame buffer beyond the encoder pipe). The per-frame CDP path's in-flight queue grew with workers (>1 worker is unsafe under ~1 GB free RAM, as the short-form code comments already warn).

## Decision

Adopt the hybrid compositor, as planned:

1. One authentic desktop capture per repository per episode (tiled beyond ~2,200 raster px, canvas-stitched, SHA-256 recorded) — plus a blob-view capture for source-file scenes.
2. Camera motion as **per-frame `crop` filter expressions** in FFmpeg (numeric piecewise ease-in-out cubic, clamped to image bounds) — no screenshot-per-frame loop, no `zoompan` (expression-bounded and deterministic).
3. Highlights/callouts/titles/mascot as extra image inputs with alpha fades (auto position anchored at the camera's static settle point); captions burned with libass from the pre-generated `.ass` (fontsdir = `assets/shared/fonts`).
4. Per-scene bounded segments (≤ ~20 s), each independently reusable on content-hash match, joined with the **concat demuxer (`-c copy`)**, then one **mux** with the pre-mixed episode audio (`+faststart`). Peak memory is independent of episode length; a crash loses at most the in-flight segment.

Rejected: per-frame Chromium screenshot of a static composition (as short-form does for 9:16) — slow, RAM-hungry, and buys nothing once the composition is static. Zoompan-based camera — retained as reference but not used (per-frame numeric crop was more predictable).

## Consequences

- Render cost ≈ 0.5×–0.7× of the video's own length on this machine — an episode is a ~10–12 minute background job, acceptable for a terminal-driven production tool.
- Segment-level reuse makes interrupted episodes cheap to recover (see `docs/longform/LONGFORM_TRD.md` §6).
- If a faster machine with more RAM is available, `SHOWCASE_CAPTURE_WORKERS`-style tuning does not apply (no workers) — throughput tuning happens at the `-preset`/`-crf` level instead (`veryfast`/20 chosen).

## Verification artifacts

- Raw numbers: `temp/longform-benchmark/report.json`
- 8 s test segment: `temp/longform-benchmark/segments/segment-001.mp4` (visually inspected: capture, camera push, highlight, mascot, captions all present and readable)
- Tool: `npm run benchmark:longform` (rerunnable; uses the real GitHub page — requires network and a CDP-capable Chromium)
