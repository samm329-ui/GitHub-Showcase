# GitHub Showcase — Callout Bubble and Premium Caption Implementation Plan

**Scope:** Add a narration-driven white callout bubble and a dark karaoke-caption panel to the existing 1080×1920 GitHub Showcase composition. Preserve the existing GitHub card, page scroll, card shadow, mascot asset, mascot placement and entrance animation. The generated reference is a visual guide only; it must not be used as the final video background.

**Status:** Plan derived from the uploaded `GitHub-Showcase-main (2).zip`, screenshots, and the supplied visual specification. No code has been changed by this audit, and no test suite was run against the archive.

---

## 1. Current code and exact gap

The current project already has much of the low-level caption and composition plumbing:

- `src/config.ts` defines the 1080×1920 canvas, card geometry, current caption position, mascot layout and voice settings.
- `src/card.ts` produces the stationary-card HTML. The GitHub card is a stage-level layer; the caption and transparent mascot are independent layers.
- `src/caption-overlay.ts` creates phrase markup, estimates within-phrase word timings, applies the caption group entrance/exit and defines the moving active-word rectangle.
- `src/mascot-layout.ts` computes mascot placement from visible PNG alpha bounds and provides `mascotHeadAnchor()`.
- `src/character-motion.ts` produces deterministic mascot entrance and idle/speech motion. Preserve this behavior in this pass.
- `src/types.ts` defines `NarrationSegment`, `CaptionPhrase`, `AudioChunk`, and `Timeline`.
- `src/index.ts` obtains measured TTS chunk timings, builds captions and scroll keyframes, creates a timeline and invokes the renderer.
- `src/render.ts` passes rendering options to `renderCardVideo()` in `src/browser-capture.ts`.
- `src/browser-capture.ts` sets scroll, caption HTML, active-word geometry and character pose once per output frame using media time. It captures each frame through CDP and pipes it to FFmpeg.

### Current defects relative to the target

1. `CAPTION_OVERLAY` in `src/config.ts` is currently approximately `{ leftPx:165, topPx:876, widthPx:718, maxHeightPx:314 }`. Its comment explicitly describes captions hanging above the mascot’s head. That explains why they appear over the GitHub About text in the base screenshot.
2. `.caption-overlay` in `src/card.ts` has no filled panel, border, rounded backing or panel shadow. Text is rendered directly over the README image.
3. There is no callout DOM element or callout cue passed through `Timeline`, `RenderVideoOptions`, or `RenderCardOptions`.
4. `speechCalloutZone()` in `src/mascot-layout.ts` is only a caption-placement geometry helper. It does not render a speech bubble and is not currently used by production `card.ts`.
5. The current default active-word colors in `src/caption-overlay.ts` are red `#FF2600` and white `#FFFFFF`, which conflict with the approved lemon-yellow/near-black treatment. `UI_TOKENS.captionYellow` in `src/card.ts` is also a different yellow (`#FFD629`). Use a single canonical accent token.
6. `captionHtml()` marks both `phrase.highlights` and the currently spoken word with the same `active` class. That conflates persistent semantic emphasis with the moving karaoke highlight. The target needs exactly one moving yellow pill for the current word; other emphasized words must not appear as simultaneously active pills.
7. The global CSS reset in `src/card.ts` disables CSS transitions and animations. This is deliberate for frame determinism. New callout and caption animation must be computed from video media time, not `setTimeout`, CSS keyframes or wall-clock transitions.
8. `src/browser-capture.ts` updates caption DOM on every rendered frame and measures word boxes through `window.__showcase`. New callout updates should avoid rebuilding its full DOM on each frame.

### Archive integrity caveat

In the submitted ZIP, `package.json` references `tools/preview-server.ts` and `tools/launch-preview.ts`, and tests import `tools/config-writer.ts`, but those files are missing from this archive. Reconcile that incomplete snapshot with the working repository before treating test/typecheck results as authoritative. This issue is separate from the callout/caption implementation.

---

## 2. Non-negotiable scope boundaries

Do not change:

- `CARD` geometry in `src/config.ts` (`width:810`, `height:1668`, `left:135`, `top:126`, `radius:52`).
- The existing page capture, card shadow, GitHub browser chrome, card scrolling, or scroll keyframe algorithm.
- The current mascot art, alpha-aware placement, `MASCOT_LAYOUT`, or existing 380 ms entrance in `src/character-motion.ts`.
- The `am_fenrir` voice choice, TTS settings, or narration generation in this visual pass.
- The final H.264/30 fps/1080×1920 render pipeline.

Implement only:

1. A separate event-driven white callout bubble, attached conceptually to the mascot’s head.
2. A dark rounded backing panel for each current caption phrase.
3. A moving, yellow, rounded active-word background behind the word actually spoken.
4. Caption text wrapping, color, and phrase-level entrance/exit treatment matching the approved reference.
5. Shared timeline wiring and automated geometry/timing validation.

The reference artwork is not an asset to flatten into the video. Use it for visual proportions only, while retaining the real repository screenshot and real mascot PNG.

---

## 3. Coordinate system and layout targets

Canonical canvas: **1080 × 1920 px**, portrait 9:16, origin `(0,0)` at top-left. All element geometry below is expressed in canvas pixels. Do not mix the raw reference-image coordinates, CSS viewport coordinates, source PNG pixels, and output canvas pixels.

The supplied target image is about 947×1661 px, not exactly 9:16. If it must be compared quantitatively, use uniform “cover” scaling:

```ts
const scale = Math.max(1080 / referenceWidth, 1920 / referenceHeight);
const cropX = (referenceWidth * scale - 1080) / 2;
const cropY = (referenceHeight * scale - 1920) / 2;
```

Never stretch it non-uniformly. Treat positions taken from that generated mockup as estimates because the image contains illustration-rendered text and noncanonical UI.

### Recommended initial positions

| Element | Initial target | Notes |
|---|---:|---|
| Stage | 1080×1920 | Existing value; do not change |
| Existing card | 810×1668 at (135,126) | Keep exactly as-is |
| Mascot | Existing `MASCOT_LAYOUT` | Keep asset, position and entrance unchanged |
| Callout | approx. 360×270–310 including tail | Dynamic position derived from `mascotHeadAnchor()` |
| Callout left | usually 650–690 | Clamped to fit inside canvas; derived from head anchor |
| Callout top | usually 830–920 | Head-relative, not a hard-coded timeline coordinate |
| Callout right margin | 32–40 | Keep the bubble body inside canvas |
| Caption panel | left 200, top 1500–1530, width 680, max height 190 | Upward-shifted from the mockup to leave more Reels UI margin |
| Caption panel right edge | 880 | 200 px right margin in the initial layout |
| Caption panel bottom | max y about 1690–1720 | Leaves roughly 200–230 px at bottom, depending on final panel height |

The mockup’s caption panel is close to the bottom edge. For safer mobile playback, start around `topPx:1510`; expose an environment override so the position can be tested in Instagram’s actual interface. Do not assume a single universal Reels safe zone: overlays vary by product surface and device.

### Why the callout is head-relative

The current `mascotHeadAnchor()` returns `headTopY` and `faceCenterX`, calculated from the same measured PNG alpha bounds and placement used for the mascot. Use that instead of inventing a second, unrelated character coordinate system.

Suggested layout function:

```ts
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type CalloutLayout = { left: number; top: number; width: number; height: number; tailTipX: number; tailTipY: number };

function placeCallout(head: MascotHeadAnchor, canvas = { width: 1080, height: 1920 }): CalloutLayout {
  const width = 360;
  const height = 285; // cloud body + tail bounds; exact SVG viewBox is a config constant
  const rightMargin = 36;
  const tailXLocal = 82;
  const tailTargetX = head.faceCenterX + 25;
  const left = clamp(tailTargetX - tailXLocal, 620, canvas.width - rightMargin - width);
  const top = clamp(head.headTopY - 210, 820, 930);
  return {
    left,
    top,
    width,
    height,
    tailTipX: left + tailXLocal,
    tailTipY: top + height - 16,
  };
}
```

The numeric constants are starting values; the final tail must be visually measured against the real mascot head. The position must remain deterministic for all frames. The bubble can overlap the card edge into the cream background, but its body should not leave the canvas.

---

## 4. Callout behaviour: a stable shape with event-driven entrance and exit

### Visual role

The callout provides a short, easy-to-read summary of the project’s main purpose. It is not the subtitle track, and it is not a second full narration transcript.

For a project that transforms long videos into short clips, a purpose-derived callout might be `Turn long videos into short clips!`. That text may only be used when supported by the selected, verified purpose facts. For a different repository, do not reuse this wording.

Keep a callout to about 3–7 words and a maximum of two lines. If a short, supported summary cannot be constructed deterministically, omit the callout for that run rather than inventing copy.

### Appearance

- Fill: `#FFFDF7`.
- Primary contour: `#151619`, 5 px.
- Yellow accent backing: `#FFE66D`, 4–6 px offset along only part of the bottom/right contour. Do not create a thick yellow border around the entire cloud.
- Shadow: approximately `0 10px 24px rgba(0,0,0,0.18)`.
- Text: `#151619`, 34–36 px, weight 800, line-height about 1.08, centered.
- Inner horizontal padding: 26–30 px.
- Keep three short yellow ray marks as a separate accent element; they should not obstruct the bubble text.
- Use a fixed SVG cloud path with an integrated tail. Do not continuously morph the outline.

### Entrance/hold/exit

Drive animation from `timeMs`, never from browser timers:

| Phase | Duration | Motion |
|---|---:|---|
| Wait | before cue start | Hidden; opacity 0 |
| Enter | 200 ms | Translate up 12 px; scale 0.96→1; opacity 0→1 |
| Ray accent | 140 ms | Rays fade/draw on, then remain still |
| Hold | cue-dependent, typically 1.8–3.4 s total visibility | Shape/text remain stable |
| Exit | 180 ms | Opacity 1→0; translate up about 6 px; scale 1→0.99 |

The callout appears on the first purposeful narration segment, after the mascot’s existing 380 ms entrance is substantially settled. It should normally appear once in this first version. Do not show a bubble for every fact or segment.

Derive timing from the final measured audio chunk belonging to the purpose segment:

```ts
const startMs = Math.max(380, chunk.startMs - 100);
const endMs = Math.min(chunk.endMs + 200, startMs + 3400);
```

In production, also validate a minimum visible duration and do not extend the bubble across a major unrelated narration beat. If the relevant phrase is shorter than the chosen minimum, extend only into a compatible pause/adjacent sentence. If that is not possible, shorten the callout life rather than overlap unrelated content.

### Deterministic easing

```ts
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function easeOutCubic(u: number): number {
  const x = clamp01(u);
  return 1 - Math.pow(1 - x, 3);
}
function easeInCubic(u: number): number {
  const x = clamp01(u);
  return x * x * x;
}
```

Let `t` be the current media timestamp, `t0` be cue start, `t1` cue end, `D_in = 200 ms`, and `D_out = 180 ms`.

```ts
const inU = clamp01((t - t0) / D_in);
const outU = clamp01((t - (t1 - D_out)) / D_out);
const inProgress = easeOutCubic(inU);
const outProgress = easeInCubic(outU);
const opacity = inProgress * (1 - outProgress);
const translateY = 12 * (1 - inProgress) - 6 * outProgress;
const scale = 0.96 + 0.04 * inProgress - 0.01 * outProgress;
```

Return the state as a pure object. If asked to render the same timestamp twice, it must return the same state. Keep the callout DOM and SVG path static between cues; update text only when the cue id changes, and update only opacity/transform/ray opacity per frame.

---

## 5. Keep callout copy evidence-backed

Add optional callout copy to the already-composed narration segment or selected explanation node. Do not generate it independently from the raw README at render time.

Suggested type additions in `src/types.ts`:

```ts
export type CalloutCue = {
  id: string;
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  factIds: string[];
  anchor: "mascot-head";
};
```

Add `calloutText?: string` to `NarrationSegment` as an optional field. The selected `purpose` node is the preferred source. Copy its supporting `factIds` into the cue so the text can be audited.

Suggested deterministic shortening rules:

1. Prefer an existing short `purpose` or `hook` proposition.
2. If the verified purpose has a clear transformation pattern such as `transforms X into Y`, allow a controlled rewrite such as `Turn X into Y!`, provided no scope or meaning is changed.
3. Remove secondary destinations or qualifiers only if they are not essential to the claim.
4. Limit the output to 3–7 words and two lines.
5. If no rule can produce a concise, faithful summary, return `null` and render no bubble.

Do not use a generic fallback such as `Check this out!`; it does not explain the product. Do not repeat the entire subtitle sentence in the callout while it remains visible for several seconds.

---

## 6. Caption panel and word highlight are separate visual layers

### Panel styling

The dark panel holds the current spoken phrase and stops the text from blending into arbitrary README content.

Initial values:

```ts
export const CAPTION_PANEL_STYLE = {
  background: "rgba(23,25,29,0.92)",
  border: "1px solid rgba(255,255,255,0.12)",
  radiusPx: 26,
  padXPx: 24,
  padYPx: 16,
  shadow: "0 14px 32px rgba(0,0,0,0.25)",
  maxLines: 2,
} as const;

export const CAPTION_OVERLAY = {
  leftPx: Number(process.env.SHOWCASE_CAPTION_LEFT_PX ?? 200),
  topPx: Number(process.env.SHOWCASE_CAPTION_TOP_PX ?? 1510),
  widthPx: Number(process.env.SHOWCASE_CAPTION_WIDTH_PX ?? 680),
  maxHeightPx: 190,
} as const;
```

Use the project’s existing config-reader helper if one exists; do not use an unvalidated `Number()` result in production. Values must be finite, positive, and clamped within the canvas.

Panel text defaults:

- Font family: Inter, Segoe UI, or the nearest already-installed bold sans-serif.
- Size: 48–52 px; start at 50 px rather than forcing 54 px into every phrase.
- Weight: 800–900.
- Line-height: 1.06–1.08.
- Inactive text: `#F8F6EF`.
- Maximum two lines. Never discard words to meet this constraint.

The visible panel should size around the current phrase within a fixed width/height bound. The outer `.caption-overlay` is a stable, transparent positioning root with `overflow: visible`, so its shadow is not clipped. The inner `.caption-panel` is present only while a caption phrase is active. Do not give the always-present root a black background, or it will remain as an empty black rectangle when no captions are being shown.

The panel can overlap the mascot’s lower laptop/arms as the reference shows, but it must never obscure the face, glasses or bubble text. Before encoding, measure caption panel and face bounds in the same stage coordinate system and report a collision if the panel intersects the protected head region.

### Active-word pill

- Background `#FFE66D`.
- Active text `#151619`.
- Corner radius 9–10 px.
- Horizontal padding 8–9 px; vertical padding 3–4 px.
- 60–80 ms easing between measured text boxes.
- Exactly one active karaoke word at any timestamp.

The dark phrase panel remains stable for the phrase. The yellow word pill moves inside the panel. These must not be combined into one rectangle.

### Correct layering of word text

Current `captionHtml()` uses the same `.active` class for `phrase.highlights` and the current word. Split this into two concepts:

- `.w.current`: the single currently spoken word; dark text over the yellow moving pill.
- `.w.key-emphasis`: optional semantic/key-word style. This must not create a second active pill or permanently set the active-word text colour to dark.
- `.w`: normal warm-white word.

Render the yellow pill behind the text (`z-index:0`), then draw each word exactly once above it (`z-index:1`). The text and pill must use the same DOM measurement/coordinate basis.

### Word timing

`wordTimings()` presently estimates word intervals inside a measured phrase using word/syllable-like weights and punctuation because the installed Kokoro model does not provide phoneme timings. Do not describe this as true phoneme-level alignment. Keep it for this pass, ensure timing is deterministic, and leave a later forced-aligner task if more precise timing becomes necessary.

Given a phrase duration `D`, for word weights `q_i > 0`:

```ts
const total = q.reduce((sum, x) => sum + x, 0);
const duration_i = D * q[i] / total;
```

Clamp minimum intervals only if the total can still fit within `D`; otherwise normalize weights rather than letting word intervals overrun the phrase. The phrase boundaries stay authoritative.

For a current word measured DOM rectangle `B_i=(x_i,y_i,w_i,h_i)` and padding `px,py`, draw the highlight at:

```ts
left   = x_i - px;
top    = y_i - py;
width  = w_i + 2 * px;
height = h_i + 2 * py;
```

Interpolate the box between previous and current word coordinates over 70 ms with `easeOutCubic`. On a line wrap, the measured target is allowed to jump vertically; interpolate the X/Y/width/height toward that exact target rather than guessing based on character count.

Ensure the current word, active box, and timing index are computed from the same caption phrase object. Handle punctuation/case consistently. `phrase.highlights` must not cause multiple current-word classes.

---

## 7. File-by-file modifications

### 7.1 `src/config.ts`

Add one canonical accent color (`#FFE66D`) and the callout/panel config objects. Move `CAPTION_OVERLAY` from the current head-adjacent geometry `(165,876,718,314)` to the bottom panel zone `(200,1510,680,190)` with safe, validated environment overrides.

Add constants for callout size, clamping bounds, colors, typography, ray stroke, enter/exit durations and word transition duration. Do not modify `CARD`, `SCROLL`, `MASCOT_LAYOUT`, or the voice preset.

Avoid having `UI_TOKENS.captionYellow`, `CAPTION_STYLE.highlightColor`, and `CAPTION_HIGHLIGHT.background` carry different values. Use one exported token or route all defaults through one source of truth.

### 7.2 `src/types.ts`

Add optional `calloutText?: string` to `NarrationSegment`; add `CalloutCue` and `CalloutState` types; add `callouts?: CalloutCue[]` to `Timeline` if the project persists the complete visual timeline there.

Suggested state type:

```ts
export type CalloutState = {
  cueId: string | null;
  visible: boolean;
  text: string;
  opacity: number;
  translateY: number;
  scale: number;
  raysOpacity: number;
};
```

Keep the fields optional when possible so legacy callers remain valid during migration.

### 7.3 `src/script-composer.ts` / `src/explanation-planner.ts`

Derive `calloutText` from the already-selected purpose/identity node, after the script passes evidence validation. Reuse its evidence refs; do not independently parse or summarize the raw README in `card.ts`.

The callout should usually be one per video in the first implementation, not one per segment. Do not store generated callout copy as an unsourced visual decoration. Record its `factIds`.

### 7.4 New `src/callout-overlay.ts`

Keep this module pure where possible. It should own:

- `buildCalloutCues(segments, timedChunks)` — choose the single suitable purpose segment and bind it to the measured audio chunk.
- `calloutCueAt(cues, timeMs)` — find the active cue.
- `calloutStateAt(cue, timeMs)` — return deterministic opacity, transform and ray state.
- `placeCallout(headAnchor, config)` — derive position from the current mascot head anchor and canvas bounds.
- `renderCalloutMarkup(...)` or a static template builder — create the white cloud SVG/tail, yellow offset accent, text box and ray marks.

The module must not synthesize TTS, change scrolling or update the mascot. Keep HTML safety: the callout text is repository-derived and untrusted; write it through `textContent`, or use a rigorously escaped static-template path. Never concatenate raw README content into executable markup.

### 7.5 `src/mascot-layout.ts`

Reuse `mascotHeadAnchor()` for callout placement. Do not change `mascotPlacementCss()` or the current `MASCOT_LAYOUT`. The existing `speechCalloutZone()` is caption geometry and should not be treated as a callout renderer. It may remain for backwards compatibility, with its comments updated to distinguish a caption zone from a bubble.

Add geometry tests for the callout’s bounds and the tail’s proximity to the face/head anchor.

### 7.6 `src/card.ts`

Keep the card HTML and CSS unchanged except for adding stage-level siblings and caption styling. The callout must live outside `<article id="card">`, otherwise the card’s `overflow:hidden` will clip the bubble where it extends over the cream background.

Suggested markup:

```html
<div class="stage">
  <article class="card" id="card">…existing card, unchanged…</article>
  <div class="callout-overlay" id="callout" aria-hidden="true">
    <svg class="callout-shape" aria-hidden="true">…fixed cloud/tail paths…</svg>
    <div class="callout-text" id="callout-text"></div>
    <svg class="callout-rays" id="callout-rays" aria-hidden="true">…three rays…</svg>
  </div>
  <div class="caption-overlay" id="caption"></div>
  …existing mascot markup, unchanged…
</div>
```

`z-index` policy:

- Card: existing z-index 1.
- Mascot: existing z-index 2.
- Callout: z-index 4, above page/card and head, within the canvas.
- Caption overlay and panel: z-index 5, so the bottom caption panel is foreground as in the reference.

The exact z-order should be tested with the laptop and caption panel; the mascot face must remain visible and must not be covered by either overlay.

Use a fixed-size SVG path with an integrated tail. A shadow backing path is offset 4–5 px down/right and traced in yellow only along a partial contour; then draw the dark main outline and warm-white fill. Avoid a full thick yellow border.

`.caption-overlay` should have `overflow: visible` so the panel shadow is not clipped; the inner panel controls clipping and height. Add `window.__showcase.setCallout(...)` and `measureCallout()`/geometry methods. `setCallout` updates text only when cue ID changes, not for every frame.

### 7.7 `src/caption-overlay.ts`

Centralize colors from config: default highlight `#FFE66D`, active text `#151619`, inactive text `#F8F6EF`. Update `CAPTION_STYLE` to the approved size/line spacing and panel-safe typography.

Make `captionFrameHtml()` return the inner panel only when `phrase !== null`. The HTML structure should be:

```html
<div class="caption-group" style="…media-time-derived transform…">
  <div class="caption-panel">
    <div class="caption-highlight" id="caption-hl"></div>
    <div class="caption-lines">…one span per word…</div>
  </div>
</div>
```

The panel must not appear when no caption phrase is active. The moving pill remains a separate absolute element from the dark panel. Ensure each word is rendered once. Keep the current 160 ms entrance, 120 ms exit and 70 ms word-box interpolation unless a visual test proves otherwise; style changes should not unnecessarily alter the timing that already works.

The current `wrapCaptionText()` uses character counts (22) rather than actual rendered width. Preserve source words, but let the browser wrap word spans in the 680 px panel and measure the actual DOM rectangles. Add two-line/overflow validation; do not drop words to satisfy the line limit.

### 7.8 `src/browser-capture.ts`

Extend `RenderCardOptions` with `callouts?: CalloutCue[]`. At each frame:

1. Compute `timeMs = frame / fps * 1000` as today.
2. Keep the existing `scrollAt`, `captionFor`, `characterCueAt`, `characterPoseAt` behavior.
3. Resolve `cue = calloutCueAt(callouts, timeMs)`.
4. Compute `state = calloutStateAt(cue, timeMs)`.
5. Compute callout position from the same mascot layout/head anchor used by the card geometry.
6. Call `window.__showcase.setCallout(...)` with the cue id/text only when changed and update opacity/transform/rays from the state.
7. Update caption HTML, measure the word rectangles and move the word pill exactly as current code does.
8. Capture the frame.

Never use CSS `transition`/`animation`, `setTimeout`, frame-accumulated deltas, or real elapsed wall time for these animations. A frame requested out of sequence must render exactly as if it were rendered in sequence.

Add `callout` and `captionPanel` measured bounds to `CaptureGeometry`. Keep the existing card viewport movement untouched.

### 7.9 `src/render.ts`

Add `callouts?: CalloutCue[]` to `RenderVideoOptions` and pass it straight through to `renderCardVideo`. Do not modify output dimensions, FFmpeg settings, sound mixing or frame rate.

### 7.10 `src/index.ts`

The current flow measures synthesis and `toTimedChunks()` before creating captions and scroll keyframes. After `timedChunks` and `captions` exist:

```ts
const callouts = buildCalloutCues(plan.segments, timedChunks);
const timeline: Timeline = {
  durationMs: merged.durationMs,
  sampleRate: merged.sampleRate,
  chunks: timedChunks,
  captions,
  scroll: scrollKeyframes,
  anchors: storyCapture.anchors,
  documentHeight: measured.documentHeight,
  viewportHeight: measured.viewportHeight,
  callouts,
  story: { /* existing data unchanged */ },
};
```

Pass that same `callouts` array to `renderVideo()`. Write it within `timeline.json` as part of the exact timeline used for rendering. Do not calculate callout timing from estimated words per minute or a fixed `time=2.0s`.

### 7.11 `src/qa.ts`

Add geometry and temporal checks:

- A callout cue references a valid narration segment and real `factIds`.
- Cue bounds are within audio duration and have `startMs < endMs`.
- Only one callout is active in the first version.
- Callout body fits within the canvas (small intentional right offset only if specifically approved; default target should fit).
- Bubble tail is within a measured distance of the mascot head anchor.
- Caption panel is within the expected bottom safe zone and at most two lines.
- Caption panel does not overlap the protected face/glasses region.
- Active word rectangle is within the panel.
- No caption panel remains visible outside a caption phrase.
- Existing audio/video duration, scroll and export checks still pass.

Geometry alone cannot prove visual premium quality. Keep contact sheets/reference frames and inspect the purpose beat, caption transitions, wrapped phrase and outro.

---

## 8. Shared timeline and mathematics

The project already uses the measured narration duration as the main timeline. Preserve that invariant: callout, captions and mascot animation must all be functions of the same `timeMs`.

For output frame `n` at frame rate `F`:

```ts
const timeMs = (n / F) * 1000;
```

Do not use the wall clock. For 30 fps, one frame is 33.333… ms. Event bounds should be rounded only when selecting a rendered frame; store the original millisecond times in the timeline.

### Callout event selection

Match the chosen purpose segment to `AudioChunk` by `segmentId`, and use that chunk’s measured `startMs`/`endMs`. A segment without suitable `calloutText`, evidence IDs or chunk should produce no cue.

```ts
function buildCalloutCue(segment: NarrationSegment, chunk: AudioChunk): CalloutCue | null {
  const text = segment.calloutText?.trim();
  if (!text || segment.factIds.length === 0) return null;
  const startMs = Math.max(380, chunk.startMs - 100);
  const endMs = Math.min(chunk.endMs + 200, startMs + 3400);
  if (endMs <= startMs) return null;
  return {
    id: `callout:${segment.id}`,
    segmentId: segment.id,
    text,
    startMs,
    endMs,
    factIds: [...segment.factIds],
    anchor: "mascot-head",
  };
}
```

Before production, add a minimum hold rule and ensure it does not spill into an unrelated narration beat. The sample shows the mapping, not a complete validated implementation.

### Active-word box geometry

If the measured current word rectangle is `(x, y, w, h)` and padding is `(px, py)`, then:

```ts
const box = {
  left: x - px,
  top: y - py,
  width: w + 2 * px,
  height: h + 2 * py,
};
```

Between previous and current word rectangles, use an easing interpolation over 70 ms:

```ts
const u = clamp01((timeMs - wordStartMs) / 70);
const e = 1 - Math.pow(1 - u, 3);
const interpolate = (a: number, b: number) => a + (b - a) * e;
```

Apply interpolation to left, top, width and height. If the next word is on another line, use the real browser-measured target rectangle.

### Layer order

The target reference has two independent text systems:

1. The callout — a short static summary positioned by the mascot head and timed to the purpose segment.
2. The caption panel — the actual current spoken phrase, changing on the caption timeline with one yellow current-word pill.

A callout must never be generated as a second complete copy of the spoken transcript. If the bubble contains “Turn long videos into short clips!”, the spoken caption can carry a more detailed phrase such as “It takes a long recording and finds short, vertical segments ready to edit.” Only use such copy if supported by the selected evidence. If bubble and current spoken phrase would be identical, shift the bubble to the gap just after that phrase or omit it for that beat.

---

## 9. Suggested module API

`src/callout-overlay.ts` should export these functions:

```ts
export function buildCalloutCues(
  segments: NarrationSegment[],
  chunks: AudioChunk[],
): CalloutCue[];

export function calloutCueAt(
  cues: CalloutCue[],
  timeMs: number,
): CalloutCue | null;

export function calloutStateAt(
  cue: CalloutCue | null,
  timeMs: number,
): CalloutState;

export function placeCallout(
  head: MascotHeadAnchor,
  config?: CalloutLayoutConfig,
): CalloutLayout;
```

Keep cue construction, temporal state and spatial layout separate:

- Cue construction knows about narration and measured audio.
- Temporal state knows about cue start/end and easing.
- Spatial layout knows about canvas and mascot head anchor.
- `card.ts` knows about DOM/SVG drawing.
- `browser-capture.ts` orchestrates all parts at a media timestamp.

That separation makes each function testable without rendering a full video.

---

## 10. Tests

Add `tests/callout-overlay.test.ts` for:

- No cue when callout text is absent or has no evidence.
- Exactly one cue is generated for the purpose segment in the first implementation.
- Cue timing derives from the matching measured chunk, not a hard-coded time.
- Start does not occur before the mascot’s entrance is substantially settled.
- End is within audio duration and cue duration stays bounded.
- Same timestamp returns identical state.
- Entrance starts at opacity 0 and reaches 1 at the end of the entrance window.
- Exit reaches opacity 0 at cue end.
- Bubble layout stays inside the canvas, and tail approaches the measured head anchor.

Update `tests/caption-motion.test.ts` for:

- Canonical active colors are `#FFE66D` and `#151619`.
- Only one current word is styled as active at any timestamp.
- Persistent semantic emphasis is separate from the current karaoke word.
- The dark panel is present for a phrase and absent when `captionAt()` returns null.
- Word-box positions are within the panel, including line wraps.
- No word is dropped; a phrase exceeding two lines causes a structured warning/fail rather than silently clipped text.

Update `tests/card.test.ts` for:

- Card geometry and CSS remain unchanged.
- The callout is a stage-level sibling outside `article#card`.
- The bubble shape and text are separate elements.
- Caption panel and callout use the intended z-order.
- No default black caption panel remains when no phrase is active.
- Static DOM and repeat-at-timestamp rendering are deterministic.

Update `tests/mascot-layout.test.ts` for:

- Callout positioning uses `mascotHeadAnchor()`.
- The tail points near the head/face target without covering the face/glasses.
- Card/mascot geometry regression remains unchanged.

Add an integration test to the render path that proves `callouts` emitted in `timeline.json` are the exact cues passed to `renderVideo()` and used during frame capture.

---

## 11. Implementation order

1. **Config + types:** Add one source of truth for colors, dimensions, timing, cue types and optional segment callout text.
2. **Callout copy:** Derive a short evidence-backed phrase from the selected purpose node; do not make up generic copy.
3. **Pure callout module:** Build cues from `timedChunks`, temporal state from media time, and position from mascot head geometry.
4. **Card DOM:** Add a stable cloud SVG/text/ray overlay outside the card. Add a panel wrapper behind current captions.
5. **Caption rendering:** Fix colors, split current-word state from semantic emphasis, measure actual word rectangles, preserve existing word-timing algorithm and group animation.
6. **Render plumbing:** Pass `CalloutCue[]` through `index.ts` → `render.ts` → `browser-capture.ts`; include cues in `timeline.json`.
7. **QA and tests:** Add geometry/timing/presence checks and retain the current card/mascot regression assertions.
8. **Reference render:** Render one real repository at 1080×1920. Inspect purpose-callout onset, the caption panel at multiple phrase transitions, long wrapped phrase, bubble fade-out and final frame.
9. **Calibrate only after evidence:** Adjust bubble position or caption top only after looking at measured geometry and the actual Reels/device preview. Do not modify the card to solve an overlay problem.

---

## 12. Acceptance checklist

A build is not accepted just because typecheck passes. All of these must be verified in an actual export:

- Existing card geometry, shadow and scroll are unchanged.
- Existing mascot asset, position and entrance are unchanged.
- A white bubble with a dark outline, partial lemon-yellow offset accent, readable short copy, tail and soft shadow appears only for a supported purpose segment.
- Bubble enters in about 200 ms, rays appear in about 140 ms, bubble stays stable and fades out in about 180 ms.
- Bubble does not move/rebuild its entire SVG every frame and remains deterministic when a frame is rendered out of order.
- Caption panel appears only when a caption phrase is active.
- Panel is around x=200, y=1510, width=680, max height=190 initially; it can be tuned by validated env overrides.
- Caption font is approximately 48–52 px bold, warm-white and legible on light and dark page areas.
- One yellow `#FFE66D` pill tracks the current word; the active glyph text is `#151619` and is rendered once.
- Other key-emphasis words do not simultaneously appear as active karaoke boxes.
- The caption does not clip long words or drop text; max two lines is checked.
- The caption panel and callout do not cover the mascot’s face/glasses.
- Existing audio/video duration checks still pass; all events use final measured audio time.
- The rendered video is inspected at 0%, purpose-callout interval, at least three active-word transitions, a line wrap, callout exit and 100%.
- `npm run check` and all tests pass in the actual working tree after the incomplete ZIP issue is resolved.

---

## 13. Important limitation

Kokoro timing in this project is currently measured at the audio-chunk level, while word timing inside a phrase is estimated from text/syllable and punctuation weights. The yellow pill can be synchronized consistently to that shared schedule, but it is not true phoneme-level forced alignment. Keep the current method for this visual pass and avoid claiming more precise alignment than the pipeline supplies.

The callout is a UI overlay, not a separate AI capability. Its copy is derived deterministically from the selected purpose evidence, and the time it appears is anchored to the final measured narration chunk. No paid API, LLM, Python addition, new renderer, or card movement change is required.
