# GitHub Showcase — Visual, Scroll, Narration, Captions, and Character Upgrade Plan

## 1. Recommendation

Keep the existing TypeScript/Node.js + Chromium CDP + Kokoro + FFmpeg architecture. Do **not** replace the pipeline, add an LLM, or add paid services. Fix the presentation layer and timeline as a focused retrofit.

The recommended final composition is:

- Output remains **1080 × 1920, 30 fps, H.264/yuv420p, AAC 48 kHz**.
- Keep the current warm stage background `#F2EFE9`, dark card `#0D1117`, card geometry (810 × 1668 at x=135, y=126), 28 px corners, and neutral layered shadow.
- Replace the current synthetic desktop-like GitHub page with a **real, responsive mobile-width screenshot of the public repository page**, captured once and scrolled as one tall raster image. The outer card and background remain fixed.
- Remove the visible progress slider, thumb, fill, and timer completely.
- Use slow, continuous, eased keyframed scroll, not a late start followed by a large jump. Scroll position must be bounded by the actual captured image height.
- Put white captions with selective `#FFD629` highlights over the lower-middle of the page, with a dark text outline/shadow but no filled word boxes.
- Generate narration from verified facts using a constrained, modular story grammar. Select coherent combinations—not random independent sentences.
- Add the future transparent PNG character as an independent visual layer. Move the whole cut-out gently in time with the voice; do not bake it into the page screenshot.
- Keep local QA: validate the rendered MP4 and inspect a contact sheet plus audio/caption timing before marking the run complete.

## 2. What the two attached videos show

### Current render (`redhat-et-ripwire-2a16e8ce.mp4`)

- 1080 × 1920, 30 fps, approximately 34.61 seconds.
- The outer background and dark card are close to the requested design and should be preserved.
- The content looks like a custom, desktop-oriented GitHub mock-up rather than a page captured at a mobile viewport. README images are removed by the current sanitizer, so the composition also loses some of the visual material visible in a real README.
- The page position barely changes across much of the clip; a much larger change appears late in the sample. The changing captions make the long static period more noticeable.
- The progress track, moving thumb, and timer at the bottom look like an editor preview/scrubber. They should not be part of the finished promotional video.
- Captions sit in a separate fixed black zone instead of over the page as in the reference.

### Reference (`Video-84794.mp4`)

- 720 × 1280, 30 fps, approximately 35.97 seconds.
- The repository page occupies the central viewing area and reveals different content as time passes. Images, headings, setup information, and later README sections provide visual variety.
- Captions sit over the page in a fixed screen position, with white text and yellow emphasis.
- The scroll is a continuous narrative reveal rather than a progress slider animating while the page stays still.

The target should borrow the reference's **mobile page framing, slow vertical reveal, and overlaid captions**, while preserving the current output's warm background, dark card, corner radius, and shadow.

## 3. Root causes in the supplied source archive

I inspected `GitHub-Showcase-main.zip` rather than relying on the public branch:

1. `src/card.ts` calls `buildDocument(repo)` to fabricate a GitHub-like page from API data. It is not a screenshot of GitHub at a mobile viewport. The layout contains desktop-style tabs/file rows and the README sanitizer removes images.
2. `src/browser-capture.ts` sets the composition page to 1080 × 1920 with `mobile: false`, then transforms the synthetic `.document` element.
3. `src/card.ts` renders `.progress`, `.fill`, `.thumb`, and `.time`; `browser-capture.ts` updates them every frame.
4. `src/timeline.ts` defaults to a maximum scroll move of 1100 ms, with a 340 ms minimum. It derives targets only from section anchors attached to narration segments. If the usable anchors cluster late in narration or collapse to a few positions, the output can hold still for too long and then move too much at once.
5. `src/narration.ts` already has fact-aware templates and distinct angles. It is a good foundation, but choosing one prebuilt template is not the same as building a wider, constrained compositional grammar.
6. The Kokoro helper reports no real phoneme durations in the bundled model. Caption timing is therefore estimated inside each measured audio chunk using phrase/syllable/punctuation weights; the plan must be honest about that limitation.

## 4. Target visual geometry

Keep these invariants in `src/config.ts`:

```ts
export const VIEWPORT = { width: 1080, height: 1920 };
export const STAGE_BG = "#F2EFE9";
export const CARD_BG = "#0D1117";
export const CARD = {
  width: 810,
  height: 1668,
  left: 135,
  top: 126,
  radius: 28,
  border: "1px solid rgba(255,255,255,0.14)",
} as const;
```

Keep the stage, card, border, browser-address chrome, and shadow stationary. Only the **page image** scrolls. Captions and the optional character are separate fixed composition layers.

### Mobile screenshot scaling

Capture the source webpage at about **405 CSS px wide** with mobile emulation and a device scale factor of 2. The expected raster width is therefore around 810 px, matching the card's content width. Do not assume Chrome's screenshot byte dimensions; decode the image and normalize it to the intended content width while preserving the aspect ratio. Store both source CSS measurements and raster pixel measurements.

This scale relationship is important:

- CDP DOM offsets are in CSS pixels.
- The page screenshot is measured in raster pixels.
- If the screenshot is displayed at 810 px wide, convert each measured anchor using `pixelsPerCssPx = renderedRasterWidth / cssViewportWidth`.
- Use the displayed raster height—not the source browser's CSS height—to calculate `maxScroll = imageHeightPx - viewportHeightPx`.

Otherwise anchors will be misplaced by approximately the device scale factor.

## 5. Mobile page capture: implement as a separate preparation stage

### New file: `src/mobile-capture.ts`

Create a top-level Chromium target and navigate directly to the public repository URL. Do **not** depend on putting GitHub in an `<iframe>`: sites can refuse framing using `Content-Security-Policy: frame-ancestors` or `X-Frame-Options`. A direct CDP navigation avoids that dependency. The outer card is rendered later; only the source page is captured here.

Suggested contract:

```ts
export type MobilePageCapture = {
  imagePath: string;
  sourceUrl: string;
  cssViewport: { width: number; height: number };
  raster: { width: number; height: number };
  pixelsPerCssPx: number;
  documentHeightCssPx: number;
  anchors: MeasuredAnchor[]; // in displayed raster pixels
  title: string;
  capturedAt: string;
};

export async function captureMobileRepositoryPage(
  repo: EnrichedRepo,
  outputDir: string
): Promise<MobilePageCapture>;
```

Suggested first-pass configuration:

```ts
const MOBILE_CAPTURE = {
  widthCss: 405,
  heightCss: 720,
  deviceScaleFactor: 2,
  mobile: true,
  settleMs: 1400,
  jpegQuality: 94,
};
```

Recommended capture sequence:

1. Navigate to `https://github.com/${repo.full_name}` in its own CDP target.
2. Set the responsive mobile viewport using `Emulation.setDeviceMetricsOverride` before navigation (or reapply immediately after navigation if the Chrome version resets it).
3. Wait for navigation, then wait for a stable DOM and key image requests. Avoid waiting forever for analytics/long-lived requests; use a bounded timeout.
4. Ensure lazy-loaded content that is intended for the story is loaded. Scroll down in bounded increments, wait briefly for images, then return to the top. Do not capture a page that is still skeleton/loading UI.
5. Measure `document.documentElement.scrollHeight`, `document.documentElement.clientWidth`, title, README root, headings, install/setup heading, feature sections, and license-related elements.
6. Capture the complete page with `Page.captureScreenshot` using `captureBeyondViewport: true` and a clip derived from the measured content size. Decode the screenshot and normalize it to the intended display width using the already-installed `canvas` dependency if necessary.
7. Save the image under the run-specific work directory, not a shared filename.
8. Re-measure the normalized raster dimensions and scale the anchor offsets to those raster pixels.
9. Validate that the page is not a 404, sign-in wall, abuse-check page, or blank screenshot. If validation fails, use an explicitly logged mobile-layout fallback built from the existing local repository data rather than returning an unusable frame.

Example CDP setup (the image-dimension normalization and anchor extraction should be separate pure functions for testing):

```ts
await client.Page.enable();
await client.Runtime.enable();
await client.Emulation.setDeviceMetricsOverride({
  width: MOBILE_CAPTURE.widthCss,
  height: MOBILE_CAPTURE.heightCss,
  deviceScaleFactor: MOBILE_CAPTURE.deviceScaleFactor,
  mobile: true,
});
await client.Page.navigate({ url: `https://github.com/${repo.full_name}` });
// Await Page.loadEventFired with a timeout, then await a bounded settle period.
const metrics = await client.Page.getLayoutMetrics();
const cssWidth = metrics.cssContentSize.width;
const cssHeight = metrics.cssContentSize.height;
const shot = await client.Page.captureScreenshot({
  format: "jpeg",
  quality: MOBILE_CAPTURE.jpegQuality,
  fromSurface: true,
  captureBeyondViewport: true,
  // In implementation, create the clip from measured CSS content size and
  // verify actual decoded pixel dimensions before mapping anchor positions.
});
```

**Important:** CDP protocol versions and screenshot scaling details can differ. Do not hard-code an assumed returned pixel width/height. Decode the actual JPEG/PNG, normalize it, record the transform, and test it against a small local page first. The current official CDP protocol describes device emulation and beyond-viewport capture; these are the appropriate primitives for this approach. See https://chromedevtools.github.io/devtools-protocol/ and its `Emulation` / `Page.captureScreenshot` commands.

### Anchor extraction

Use resilient selectors, with several fallbacks because GitHub's DOM can change:

- `repo-header`: beginning of repository content.
- `file-list`: file table/tree if present.
- `readme-intro`: README container start.
- `install-command`: the first heading whose visible text matches `install|installation|quick start|getting started|setup|usage`.
- `features`: a heading matching `features|what it does|capabilities|how it works`.
- `license`: license heading or detected license section.
- `release`: release information, if present.

For every anchor, store its document `top` in CSS pixels before converting to displayed raster pixels. If GitHub changes the markup and an anchor cannot be located, mark it missing; do not silently invent an offset. Keyframes must only target anchors that exist. For story pages with no useful headings, generate safe, evenly spaced fallback landmarks over the **captured story span**.

### Limit page height based on the narration

A README can be extremely long. Do not force the video to scroll through the entire repository page regardless of length. Pick a `storyEnd` from the last visual section referenced by the narration, include a little breathing space after it, and crop the capture to that point. Use a conservative default of roughly four to six inner viewport heights. If the required install section lies farther down, prefer the actual install section as `storyEnd`, then calculate whether it can be covered within the voice duration at the permitted scroll speed. If not, change the story selection or use the mobile fallback presentation; **do not speed the scroll until the text is unreadable**.

## 6. Rewire the render page to display the captured image

### `src/card.ts`

Keep the outer shell CSS and shadow. Replace the fabricated repository DOM as the primary `.document` content with a single screenshot image:

```html
<div class="viewport" id="viewport">
  <div class="document" id="document">
    <img id="mobile-page" alt="" draggable="false" />
  </div>
  <div class="caption-overlay" id="caption"></div>
</div>
```

Use an asset URL served from localhost by the render process, or a data URL if the screenshot size is small enough. A tiny local HTTP asset server is preferable for very tall screenshots so the entire base64 image is not duplicated inside HTML strings. Bind only to `127.0.0.1`, serve only the current run's known image/PNG files, and close it in `finally`.

Core CSS:

```css
.viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: #0D1117;
}
.document {
  position: absolute;
  inset: 0 auto auto 0;
  width: 100%;
  will-change: transform;
}
#mobile-page {
  display: block;
  width: 100%;
  height: auto;
  max-width: none;
  user-select: none;
  pointer-events: none;
}
.caption-overlay {
  position: absolute;
  z-index: 5;
  left: 5%;
  right: 5%;
  top: 66%;
  transform: translateY(-50%);
  text-align: center;
  pointer-events: none;
  color: #FFF;
  font-size: 42px;
  line-height: 1.12;
  font-weight: 800;
  text-shadow: 0 2px 2px #000, 0 4px 12px rgba(0,0,0,.95);
  -webkit-text-stroke: 0.5px rgba(0,0,0,.65);
}
.caption-overlay .hl { color: #FFD629; }
```

Use the actual computed `CARD_VIEWPORT_HEIGHT`; do not copy a hard-coded old height after removing the caption/progress zones. Keep the `.document` image as the only scrolling layer. The card, stage, address chrome, captions, and character do not scroll.

If `buildCardHtml` currently expects a full `EnrichedRepo`, preserve its public signature for test compatibility or replace it with a small explicit composition input type and update all callers together. Avoid keeping the unused desktop mock DOM in the critical render path.

### `src/config.ts`

Keep the current palette and card geometry. Remove `CARD_PROGRESS_ZONE` from layout calculations (or set it to zero while transitioning, then delete the constant once tests no longer reference it). Add explicit presentation settings:

```ts
export const SCROLL = {
  introHoldMs: 450,
  outroHoldMs: 650,
  targetPxPerSecond: 150,
  maxPxPerSecond: 190,
  minMoveMs: 1400,
  maxMoveMs: 5000,
  settleMs: 250,
} as const;

export const MOBILE_PAGE = {
  viewportWidthCss: 405,
  viewportHeightCss: 720,
  deviceScaleFactor: 2,
  maxStoryViewports: 5.5,
} as const;
```

Tune scroll settings using the sample videos/contact sheets; do not tune these numbers blindly. The speed ceiling is important for quality. A page that cannot fit the narration at that ceiling should be shortened or use the fallback rather than produce a rushed scroll.

## 7. Remove the visible preview meter completely

### `src/card.ts`

Delete the `.progress` block from the HTML and remove `.track`, `.fill`, `.thumb`, and `.time` markup/styles. Do not just set opacity to zero: the space the progress section consumes should return to the page viewport.

### `src/browser-capture.ts`

Delete the `setProgress` call from the per-frame loop and remove the JavaScript hook that updates the bar/time. Keep the loop deterministic and only call:

```ts
window.__showcase.setScroll(scrollY);
window.__showcase.setCaption(captionHtml);
window.__showcase.setCharacterPose(pose);
```

### Tests

Update `tests/card.test.ts` so it asserts that `.progress`, `#thumb`, `#fill`, and `#time` are absent and that the viewport height is computed correctly without them. A test that confirms the progress bar exists is now testing the old requirement and must be deleted/replaced.

## 8. Rebuild the scroll path around the actual image geometry

### `src/scroll.ts`

Keep `clampScroll`, `scrollBounds`, and the principle of measuring anchors. Change bounds to use the **displayed screenshot height** and the new overlay composition's true viewport height. Keep scroll targets monotonic and clamp every target to `[0, maxScroll]`.

### `src/timeline.ts`

The current 1.1-second maximum move is a poor fit for a slow, approximately 35-second page tour. Rework `buildScrollKeyframes` so it receives `durationMs` and a captured page's scaled anchors.

Recommended rules:

1. Keep a short opening hold (about 0.4–0.7 seconds), and an ending hold (about 0.5–0.8 seconds).
2. Link visible landmarks to the narration segments that actually discuss them.
3. Put the page at a landmark just before its matching narration begins, where possible.
4. Spread anchors over the usable timeline if the speech segments cluster in one part of the video; do not leave the screen motionless for 20 seconds because there are no intermediate anchors.
5. Insert intermediate keyframes between distant landmarks so motion is continuous and never teleports.
6. Enforce monotonic scroll for a single top-to-bottom tour. `scrollY` must never decrease.
7. Enforce `maxScroll = max(0, documentHeightPx - viewportHeightPx)` for every keyframe and for every sampled frame.
8. Enforce the scroll-speed ceiling. Approximate speed over one interval is:

   `v = abs(y₂ - y₁) / ((t₂ - t₁) / 1000)` pixels per second.

   If `v` exceeds the configured ceiling, move the timing landmarks or shorten the captured story span. Do not let the video compensate by racing through the page.

9. Ease each interval in and out (the existing `easeInOutCubic` can be reused). Keep intervals positive and time-sorted.
10. Confirm the animation has real motion: at 25%, 50%, and 75% of duration, the visible page position should be materially different when the content is scrollable; near the end it should reach the planned final anchor with enough time to read it.

The idea is **slowly revealing the story**, not simply mapping elapsed time directly to a huge full README. Measure the actual page and choose a sensible story span first.

### Suggested scheduler shape

Use segment chunks to obtain the time for each narration beat, then blend their natural time with even pacing so the video doesn't stall:

```ts
type Landmark = {
  y: number;             // displayed screenshot pixels
  speechMs: number;      // start of the associated measured audio chunk
  anchor: VisualAnchor;
};

function landmarkTime(
  index: number,
  count: number,
  durationMs: number,
  speechMs: number,
  introMs: number,
  outroMs: number,
): number {
  const usable = Math.max(1, durationMs - introMs - outroMs);
  const uniform = introMs + (index / Math.max(1, count - 1)) * usable;
  // Uniform pacing prevents late clustering; speech retains some authority.
  return 0.65 * uniform + 0.35 * Math.max(introMs, Math.min(durationMs - outroMs, speechMs));
}
```

This is a scheduling sketch, not the entire scheduler. The production implementation must sort and validate the output, correct non-increasing times/positions, and enforce the speed ceiling. If a particular visual anchor is missing, skip it and renormalize the remaining time positions; don't manufacture a DOM offset.

## 9. Build natural scripts without paid AI

A neural network is not required to generate varied data-driven narration, but **randomly combining every sentence fragment cannot guarantee natural language**. The better deterministic design is a constrained story grammar: small, reviewed sentence patterns for each role, compatible transitions between roles, fact-backed filling of slots, and a quality gate. This is a finite-state/data-to-text generator, not a neural network.

### Keep the existing fact provenance contract

Use `src/facts.ts` as the source of truth. Claims about stars, license, install command, release, prerequisites, and features must map to real facts. Never claim “trending” without dated star snapshots. Never call a project “open source” unless a recognized license is identified. Unknown values should be omitted or explicitly phrased as unknown.

### New file: `src/narration-grammar.ts`

Define slots, sentence variants, eligibility predicates, and compatibility. Example types:

```ts
export type StorySlot =
  | "hook" | "identity" | "value" | "proof"
  | "demo" | "setup" | "availability" | "caveat" | "cta";

export type ClauseCandidate = {
  id: string;
  slot: StorySlot;
  text: string;
  factIds: string[];
  requires: string[];       // factual capabilities required for eligibility
  excludes?: string[];      // prevents contradictory/unsupported combinations
  outgoing?: StorySlot[];  // valid next roles
  emphasis?: string[];
  optional?: boolean;
  estimatedWordCost: number;
};
```

Use curated templates like:

```ts
const valueTemplates: ClauseCandidate[] = [
  {
    id: "value.workflow.short",
    slot: "value",
    text: "It brings {capability} into one {workflow}. ",
    factIds: ["feature.primary"],
    requires: ["feature.primary"],
    outgoing: ["proof", "demo", "setup", "cta"],
    estimatedWordCost: 8,
  },
  {
    id: "value.problem.relief",
    slot: "value",
    text: "The useful part is that it can {verifiedOutcome}, without making you {documentedPainPoint}. ",
    factIds: ["purpose", "use-case"],
    requires: ["purpose", "use-case"],
    outgoing: ["proof", "demo", "setup", "cta"],
    estimatedWordCost: 15,
  },
];
```

The strings above are patterns, not usable claims until every placeholder is populated from facts. Any template with a missing required fact is ineligible.

### Build a directed story, not a bag of fragments

Recommended structures (choose one based on evidence):

- **Utility-first:** hook → identity → concrete benefit → demo/feature → verified setup → license/availability → CTA.
- **Problem-solution:** problem → identity → documented solution → evidence → caveat (only when useful) → CTA.
- **Try-it:** identity → use case → install command → requirements/OS → license → CTA.
- **Developer workflow:** hook → specific workflow → feature proof → install → limitation → CTA.
- **Trade-off:** capability → evidence → documented constraint → who it fits → CTA.

Mandatory spine: a non-generic hook, identity/purpose, one concrete value claim, and a close. Optional slots are added only when the repository has verified evidence and enough time. A segment should store `purpose`, `factIds`, `visualAnchor`, `spokenText`, and `captionText` as the current `NarrationSegment` does.

Transitions must be role-compatible. For example, a “problem” clause should lead to a “solution” or “identity” clause, not directly into a dangling “also” clause. Prefer writing several complete sentence shapes for common combinations over stitching adjective fragments together.

### Candidate scoring and selection

Generate a bounded set of candidates, rather than every possible combination. Score candidates on:

- fact coverage and provenance;
- clear referents/pronouns;
- purpose and benefit specificity;
- spoken duration fit;
- repeated phrase penalty from phrase history;
- sentence rhythm (avoid four sentences with the same opening);
- no unsupported superlatives or fake “trending” claims;
- a coherent beginning and close.

Select the highest-scoring candidate, with a seeded tie-breaker so the same repository does not change every time a run is retried. Use recent template history to avoid repetition across different videos. Randomness should select among valid scripts, never decide whether a claim is true.

### Word budget

For a 35-second target, 155 words/minute gives a rough upper planning budget of about 90 words (`35 × 155 / 60 = 90.4`). This is only a first estimate. Actual Kokoro speech duration is authoritative: synthesize the chunks, measure their WAV durations, then shorten/regenerate when the target policy is exceeded. Do not speed the finished video or clip the audio merely to hit the target.

### Preserve the existing module boundary

- `src/narration.ts`: keep `buildNarrationPlan` and `validateScript` as public orchestration/compatibility exports; use the grammar engine internally.
- `src/facts.ts`: fact extraction, evidence, source links, confidence; no prose randomness.
- `src/pronunciation.ts`: spoken substitutions only; captions retain correct repository spelling.
- `src/types.ts`: optionally add `StorySlot`, candidate IDs, and a `narrativeRole` field only if needed by the new engine.
- `src/index.ts`: save each generated plan to the existing `narration.json` run artifact so quality issues are reproducible.
- `tests/script.test.ts`: add golden examples from diverse local fixtures, unsupported-claim tests, slot compatibility tests, repetitions/boilerplate tests, duration tests, and seeds/retry determinism tests.

## 10. Captions: improve perceived sync without fake precision

The bundled Kokoro helper currently has no real phoneme-duration predictor. Therefore there is no reliable way to claim exact word-level alignment from the model output alone. Do not hide this with increasingly elaborate guesses.

### Immediate deterministic improvement

1. Keep each narration segment synthesized independently and measure each segment's real audio start/end.
2. Produce readable phrase captions of roughly 3–7 words, split at natural clause/sentence boundaries.
3. Allocate phrase durations by syllable estimate and punctuation weight within that measured chunk, with leading/trailing silence accounted for where measurable.
4. Enforce positive, monotonic, non-overlapping caption intervals. Do not clamp a phrase into a zero or negative duration.
5. Use a soft whole-word `#FFD629` highlight for the selected power phrase, but no colored text boxes.
6. Keep captions to at most two lines and avoid obstructing the page's strongest heading or setup command.
7. Keep caption position fixed relative to the screen while the page screenshot scrolls behind it.

Suggested caption defaults for 1080 × 1920: about 40–44 px bold type, maximum two lines, centered in the lower-middle of the mobile viewport, white foreground, yellow highlights, and a subtle dark outline/shadow. Tune against the full-resolution output, not a 270-pixel contact sheet.

### Later improvement if exact timing is still unacceptable

Add a local forced-alignment option only after profiling the current method. It should be optional and local, with deterministic fallback; it must not silently add a paid API. A forced aligner or model may have substantial CPU/RAM cost and needs evaluation on the target hardware. In the current zero-cost/no-local-AI constraint, readable phrase-level alignment is the honest production target.

Files:

- `src/timeline.ts`: caption phrase grouping and measured-chunk timing.
- `src/caption-overlay.ts`: wrapping, font, white/yellow text, shadow, safe area.
- `src/captions.ts`: preserve ASS export, but align its styling/highlights with on-screen caption styling. Its color conversion must stay correct; validate the output frame, not only the ASS text.
- `src/voice.ts`: segment WAV measurement, silence trimming or silence metadata (if added), sample-rate detection.
- `tests/timeline.test.ts`: add a regression fixture with fast and slow phrases, punctuation pauses, long phrases, and short chunks; assert no overlaps, no negative intervals, and no late captions beyond audio duration.

## 11. PNG character as an independent puppet-style layer

The character asset is not supplied yet. Build the renderer contract now so adding a transparent PNG later does not require reworking capture/scroll logic.

### New file: `src/character-motion.ts`

Define one pure function from elapsed time and speech-envelope amplitude to a pose:

```ts
export type CharacterPose = {
  x: number;
  y: number;
  rotationDeg: number;
  scale: number;
  opacity: number;
};

export function characterPoseAt(
  timeMs: number,
  speechLevel: number,
): CharacterPose {
  const t = timeMs / 1000;
  const speaking = Math.max(0, Math.min(1, speechLevel));
  const idleY = Math.sin(2 * Math.PI * 0.45 * t) * 2;
  const speechY = Math.sin(2 * Math.PI * 2.8 * t) * (2 + 4 * speaking);
  const rotation = Math.sin(2 * Math.PI * 1.35 * t) * (0.35 + 0.75 * speaking);
  const scale = 1 + 0.004 * speaking;
  return {
    x: Math.sin(2 * Math.PI * 0.7 * t) * 1.5,
    y: idleY + speechY,
    rotationDeg: rotation,
    scale,
    opacity: 1,
  };
}
```

These are gentle starter values; do not rotate or bob so much that the PNG looks detached. Movement must be deterministic and derived from `timeMs`, so rendering the same video twice produces the same motion.

### Speech envelope

From the already-rendered narration WAV, derive a low-rate amplitude envelope locally (for example, 25 samples/second). FFmpeg can downmix and resample the WAV to mono PCM; Node can compute short-window RMS. Smooth the envelope with an exponential moving average so the character does not jitter from individual waveform cycles.

Use `speechLevel` only to modulate the *whole-cutout* bob/tilt, not to make the character vibrate at raw audio frequency. Use a tiny idle breathing motion during pauses. If the future character image includes no independently layered mouth, the effect will imply speaking through body motion; it will not be real lip-sync. Do not claim mouth synchronization from a single static PNG.

### Composition layer

- Expected future asset: `assets/character.png` with transparent background.
- Keep it outside `.document`; scrolling should never move it.
- Add it as a separate `<img id="character">` with an independent transform and z-index.
- Position it in a reserved lower corner/side area, large enough to read but not covering repository name, installation command, or captions. Final placement must be checked with the actual PNG alpha bounds.
- Use a subtle neutral drop shadow, no colorful glow.
- Avoid overlapping the central caption safe area. If the character must overlap the card, it should not change the card's geometry or outer background.
- If character rendering is disabled or the asset is absent, render without it; absence of a PNG must not fail the run.

Files:

- `src/character-motion.ts` (new): deterministic pose function and RMS-envelope smoothing.
- `src/config.ts`: optional `SHOWCASE_CHARACTER_PNG` and motion parameters.
- `src/card.ts`: optional character layer markup; avoid loading arbitrary paths from repository data.
- `src/browser-capture.ts`: set character transform every output frame.
- `src/index.ts`: generate/load the speech envelope once; do not recompute WAV analysis for each video frame.
- `tests/character-motion.test.ts` (new): bounded pose, deterministic output, smoothness, pause behavior, absent-asset fallback.

## 12. File-by-file implementation map

| File | Required change | Keep / avoid |
|---|---|---|
| `src/config.ts` | Add mobile capture settings, scroll speed/holds, caption overlay position, optional character path. Remove progress-zone layout. | Keep current stage/card colors and geometry. |
| `src/mobile-capture.ts` (new) | Capture the true repository page at responsive mobile width; normalize raster size; extract anchors; save capture metadata. | No paid API; no iframe dependency; bounded timeouts and fallback. |
| `src/card.ts` | Keep stage/card/chrome; show the tall mobile screenshot image inside `.viewport`; put captions on top; remove progress UI; add optional PNG layer. | Remove desktop mock as primary visual; do not let repository HTML execute in the composition DOM. |
| `src/browser-capture.ts` | Accept mobile screenshot asset + actual page height/anchors; update scroll/caption/character per frame; delete progress updates. | Keep FFmpeg pipe, H.264 settings, reference-frame capture, deterministic frame loop. |
| `src/scroll.ts` | Bounds/targets measured in displayed screenshot pixels; robust missing-anchor handling. | Keep clamping and measured geometry principles. |
| `src/timeline.ts` | Duration-aware landmarks, longer easing, monotonic scroll, speed ceiling, continuous midpoints, caption safety fixes. | Keep existing easing helper and measured audio chunks. |
| `src/narration-grammar.ts` (new) | Typed clause candidates, slot eligibility, legal transitions, candidate scores and coherent script composition. | No free-form random sentence splicing; every claim needs facts. |
| `src/narration.ts` | Keep public planner and validator; delegate candidate composition to the grammar. Add narrative metadata if needed. | Avoid rewriting fact extraction and pronunciation. |
| `src/facts.ts` | Ensure structured facts feed the grammar with source/confidence. Add missing evidence only where supported by GitHub data. | No invented traction, popularity, license, requirements, or pricing. |
| `src/pronunciation.ts` | Continue separate spoken/caption forms; add repo-specific pronunciation entries only when tested. | On-screen spelling must stay correct. |
| `src/voice.ts` / `src/kokoro-tts.py` | Keep Kokoro; return measured chunk durations and optionally a low-rate speech envelope. | Do not pretend zero phoneme timings are exact. |
| `src/caption-overlay.ts` | Tune type size/wrapping, word-level highlights, text shadow, safe position. | No filled word boxes, no clipped lines. |
| `src/captions.ts` | Align optional ASS styling and highlights with the on-screen styling. | Retain as a diagnostic/export artifact if browser captions are the main render path. |
| `src/character-motion.ts` (new) | Time/speech-driven deterministic pose. | Whole-PNG motion only unless separate body parts are supplied later. |
| `src/index.ts` | Orchestrate: select repo → facts → narration → TTS → mobile capture → scaled timeline → render → QA. Save all intermediates/metadata in the run directory. | Keep unique outputs, structured errors, dry-run, history reservations. |
| `src/qa.ts` | Add visual-motion and progress-meter absence checks where possible; retain `ffprobe` validations. | Do not mark a file complete merely because it decodes. |
| `tests/card.test.ts` | Assert no progress meter; screenshot layer, overlay position, geometry, clipping, colors. | Replace old tests that require the progress bar. |
| `tests/timeline.test.ts` | Test speed ceiling, travel coverage, continuous movement, image-bound clamping, missing anchors, caption interval validity. | Test on both short and very tall page fixtures. |
| `tests/mobile-capture.test.ts` (new) | Unit-test selector fallbacks, coordinate scaling, failed-page detection, normalized image metadata. | Keep actual GitHub network test opt-in, not part of every offline run. |
| `tests/script.test.ts` | Expand factuality, coherent transitions, uniqueness and naturalness fixtures. | Keep validation fail-closed for unsupported claims. |
| `tests/character-motion.test.ts` (new) | Test deterministic smooth bounded movement and silent/low-volume behavior. | No flapping or random transforms. |
| `README.md` / `TODO.md` | Document mobile screenshot capture, network dependency, fallback, render requirements and known alignment limit. | Don't claim exact word alignment when using syllable estimates. |
| `run.bat` | Ensure existing Windows Chrome/CDP setup supports the new capture and optional PNG without adding new paid services. | Preserve one-command workflow. |

## 13. Pipeline sequence after the change

1. **Discover and select** a repository with the existing GitHub data/rules.
2. **Build fact ledger** from actual API/README evidence, including provenance and confidence.
3. **Compose narration** from compatible story slots; validate factual claims and word budget.
4. **Synthesize chunks with Kokoro** and measure each WAV chunk.
5. **Capture a mobile page screenshot** using the real repository URL in Chromium; normalize its raster dimensions and measure anchors.
6. **Select/crop the story span** so the scroll can remain slow and the relevant sections fit the narration.
7. **Build timeline** using scaled anchors, measured audio chunk timing, intro/outro holds, continuous easing and a maximum scroll-speed rule.
8. **Build phrase captions**; precompute the speech envelope for character motion if the asset exists.
9. **Render 1080 × 1920 at 30 fps** using the existing Chromium frame capture → FFmpeg encode pipeline. The screenshot is static image data; only its displayed Y transform changes per frame.
10. **Run technical and visual QA**; save five frame samples at 0%, 25%, 50%, 75%, 100%, plus the page screenshot, facts, narration, timeline, and QA JSON inside the unique run folder.
11. **Only mark the history record complete** if technical QA passes and the visual checks show motion, readable captions, no scrubber, and a valid source page.

## 14. QA and acceptance criteria

### Technical output

- [ ] 1080 × 1920, 30 fps.
- [ ] H.264, `yuv420p`, AAC audio at 48 kHz stereo.
- [ ] Video duration tracks the measured narration audio; no unexpectedly clipped ending.
- [ ] No blank frames or missing audio.
- [ ] Card/background/chrome stay fixed in the same pixel bounds across sampled frames.

### Mobile page capture

- [ ] Page is rendered at a responsive mobile layout width, not the current 1080 px desktop layout.
- [ ] Text remains crisp after normalization to the 810 px card width.
- [ ] Main title, README, important imagery, install/setup, and relevant metadata are visible as intended.
- [ ] No sign-in/404/abuse-challenge page is mistaken for a repository capture.
- [ ] Screenshot and anchor coordinate systems match; no scale-factor bug.

### Movement and composition

- [ ] No visible progress track, thumb, or timer.
- [ ] Scroll is visible by the early part of the clip, not delayed until the last third.
- [ ] Scroll is monotonic, eased, bounded, and does not jump across large distances in one frame.
- [ ] Page position differs materially at 25%, 50%, and 75% of a scrollable clip.
- [ ] The final relevant section is reached before narration ends, with a short readable hold.
- [ ] Captions remain fixed relative to the card while the page moves behind them.
- [ ] Captions are at most two lines, no clipping, and no filled word boxes.
- [ ] If enabled, character motion is subtle, deterministic, speech-reactive, and does not cover the install command/caption safe area.

### Script and captions

- [ ] Every factual claim traces to one or more fact IDs.
- [ ] Unknown license/pricing/trending status is not invented.
- [ ] Complete script reads naturally when spoken—not only when viewed as text.
- [ ] No repeated generic hook/CTA in adjacent releases unless no other valid alternative exists.
- [ ] Caption intervals are positive, ordered, non-overlapping, and end with the audio.
- [ ] Phrase timing is described as estimated inside each measured TTS chunk unless true phoneme/forced-alignment data are supplied.

## 15. Test plan

Do this in layers. Don't run full production renders for every unit test.

1. **Unit tests:** grammar eligibility/transitions, fact provenance, anchor scaling, clamping, scroll monotonicity/speed, caption interval repair, character pose.
2. **Local mobile capture fixture:** serve a small local HTML page at narrow width with headings, images, and a long README-like body; test mobile viewport, screenshot scaling, anchors, and full-page/tiled capture fallback without internet.
3. **Short integration render:** 5–8 seconds, 3–4 anchors, 30 fps, one test narration WAV; verify outer geometry and smooth scroll by comparing viewport crops at frame 0, 25%, 50%, 75%, 100%.
4. **Full end-to-end render:** one public repo with an image-rich README and one with a text-heavy README. Check both, because screenshot height and anchor behavior differ.
5. **Naturalness review set:** make 20–30 scripts from fixtures spanning CLI, web library, desktop app, API/tool, small/large project, with/without installation instructions, known/unknown license, and with/without dated star data. Review output scripts and recorded Kokoro speech, not only test assertions.
6. **Golden render regression:** store expected metadata and a small set of screenshots or image hashes with tolerances. Avoid asserting exact full-image hashes against live GitHub because the website changes; use a local fixture for deterministic visual regression.

## 16. Implementation order

### Phase A — Remove unwanted UI and fix motion policy

- Remove the scrubber from `src/card.ts` and `src/browser-capture.ts`.
- Make captions overlay the visible page rather than occupying a dedicated bottom bar.
- Refactor timeline input/units and add speed/coverage invariants with tests.
- Keep the existing synthetic page temporarily so this phase isolates scroll behavior.

### Phase B — Add mobile screenshot capture

- Add `src/mobile-capture.ts` and local asset serving.
- Capture a real responsive repository page, normalize its raster dimensions and record anchors.
- Update `src/card.ts` to use an image as the scroll document.
- Update `src/index.ts` to create the screenshot before building the render timeline.
- Add network-independent unit fixtures and an explicit fallback mode.

### Phase C — Make the narration composition more modular

- Add `src/narration-grammar.ts` with slot-specific variants and transition rules.
- Integrate it through `src/narration.ts`, preserving the current `NarrationPlan` contract.
- Add diverse repository fixtures and script-quality checks.
- Tune hook/value/setup/CTA diversity only after the visual output is working.

### Phase D — Character layer and quality gate

- Add `src/character-motion.ts` and optional PNG loading; do not block the pipeline if no image exists.
- Derive and smooth a low-rate amplitude envelope once per narration WAV.
- Add visual QA and preview frames; keep the whole-card geometry unchanged.
- Update README and run the full integration suite.

## 17. Important limitations and decisions

- **Natural does not mean infinite randomness.** A constrained grammar can be varied and factual, but it cannot guarantee every possible combination sounds natural. Curated templates, compatible transitions, candidate scoring, and recorded review are the quality controls.
- **The captured website is external content.** GitHub DOM layout, image lazy loading, and public availability can change. The capture stage needs timeouts, page validation, resilient selectors, and a logged fallback.
- **A single PNG does not create true lip-sync.** Whole-character bob/tilt can imply speaking. Real mouth articulation would require separately supplied mouth/face states, which is outside this phase.
- **Kokoro timing limitation remains.** Measured chunk duration is reliable; exact word timing within a chunk is not unless the TTS backend exposes real timings or a separate aligner is adopted.
- **Quality beats full-README coverage.** Select a useful story span and preserve readable movement. If the page contains far more material than fits the narration, don't race through it.

## 18. Definition of done

The first acceptance render should show the same warm outer background and same dark card, but the inner content should look like a real mobile GitHub page, with visible images/content from the actual page, smoothly scrolling from the repository overview through selected README/setup sections. There is no bottom scrubber. White/yellow captions remain fixed over the page. The narrator uses coherent, evidence-backed variations without paid AI. If the optional character PNG is present, it gently reacts to speech without covering the important page content. All of that is backed by measured geometry, local tests, `ffprobe`, and inspected sample frames—not inferred from a successful build alone.
