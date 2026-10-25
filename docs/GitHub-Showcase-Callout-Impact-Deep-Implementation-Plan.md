# GitHub Showcase — Callout, Mascot Attachment, and Animated Impact-Lines Implementation Plan

**Scope:** Add a reliable multi-callout system and anime/comic-style yellow emphasis strokes to the existing GitHub Showcase video pipeline, preserve the current GitHub card and its scrolling, preserve the existing mascot entrance and captions, and expose the new settings through the project's existing visual-configuration workflow.

**Primary inputs inspected:**
- `GitHub-Showcase-main(1).zip` — source snapshot supplied for this request.
- `agentrq-agentrq-152ba1cd.mp4` — current rendered output.
- `Comic Speech Bubble Sticker(1).png` — transparent callout art supplied for this feature.
- `image(20261025-070659).png` — composition reference showing the intended callout, mascot accents, and bottom subtitle panel.

This document is based on code paths in the supplied archive, not on the repository documentation alone. It is an implementation plan; it does not claim the edits have been applied.

---

## 1. Executive summary

The repository already contains a real callout implementation. It is not necessary to build the whole feature from scratch. The current pipeline has:

- `CalloutCue` and `CalloutState` types in `src/types.ts`.
- Copy shortening and selection in `src/callout-overlay.ts`.
- Media-time entrance/exit math in `calloutStateAt()`.
- A mascot-head anchor and callout positioning via `placeCallout()`.
- A callout image, text layer, and fallback SVG in `src/card.ts`.
- Per-frame callout state updates in `src/browser-capture.ts`.
- Cue construction and timeline logging in `src/index.ts`.
- Some temporal/copy/layout QA in `src/qa.ts`.
- Callout-focused unit tests in `tests/callout-overlay.test.ts` and markup/geometry tests in `tests/card.test.ts`.

The main issues are not “no callout code exists.” The important defects are:

1. **Production callout selection is too narrow.** `src/script-composer.ts` only generates `calloutText` for `purpose`, `tradeoff`, and `benefit` nodes. Examples and mechanisms are not generally eligible even when they would make excellent callouts.
2. **The production comments, types, tests, and limits disagree.** `src/types.ts` describes “at most one” callout; `src/index.ts` comments on “one” purpose callout; `buildCalloutCues()` defaults to three; QA allows four. There is no single coherent product policy.
3. **Cue windows are tied tightly to each individual audio chunk.** They start shortly before a chunk and end shortly afterward. A minimum gap is then enforced. With sequential narration chunks and short pauses, multiple adjacent candidates are frequently rejected. The current exported sample visually shows only one callout around the “Runs on your own machine!” idea.
4. **The cue priority is not a useful importance model.** `cuePriority()` promotes `identity` first, then `identify`, then `benefit`; it does not select a diverse sequence of purpose, mechanism, example/outcome, and trade-off callouts based on value, uniqueness, or timing feasibility.
5. **The callout's anchor geometry is inconsistent with the actual mascot CSS position.** `src/card.ts` places the image using raw `MASCOT_LAYOUT.offsetX/offsetY`, but calculates the callout anchor from `mascotPlacementCss()`, which applies different coordinate semantics. With current defaults, this creates an estimated difference of about **116 px horizontally and 42 px vertically** between the computed mascot box and the real CSS box used to render it. This can make the callout look detached or sit at the wrong height.
6. **The authored asset and the callout geometry do not use the same dimensions.** `assets/callout-bubble.png` is 1082×789 (aspect ratio about 1.371), while `CALLOUT` currently lays it out in a 360×285 box (aspect ratio about 1.263). `object-fit: contain` therefore letterboxes the PNG vertically, while the text box and tail math use the wrapper/SVG coordinate system. The current `tailXLocalPx: 82` is also based on the fallback SVG, not the tail position in the active PNG asset.
7. **The existing “rays opacity” animation is bypassed when the PNG is active.** `src/card.ts` hides `.callout-rays` when `calloutImageUrl` exists. The default asset already contains the bubble's yellow rays and curved arrow, so `calloutStateAt().raysOpacity` cannot animate those embedded pixels.
8. **There is no separate animated yellow impact-line system around the mascot.** The yellow strokes in the reference are part of a static reference composition; the current source has no `ImpactCue` type, no impact-line scheduler, and no independently animated SVG paths around the character.
9. **The callout text geometry is estimated rather than measured.** `calloutLineEstimate()` approximates character width as `fontSizePx * 0.52`, and `.callout-text` is positioned using fixed pixel values. That is not a reliable fit check for actual font metrics or a changed bubble asset.
10. **The configuration editor cannot be fully verified from this ZIP.** `.gitignore` ignores the entire `tools/` directory, yet `Save My Edits.cmd/.vbs`, package scripts, and tests reference configuration/editor files that are absent from the supplied archive. Those files need to be restored from the real working tree before their current behavior can be inspected or safely extended.

The minimum practical solution is to fix the existing callout path, add an independently timed impact-line layer, expose settings through the existing configuration editor, and add geometry/timeline QA. Do not rewrite the page capture, card design, narration engine, caption system, TTS voice, or renderer.

---

## 2. What the supplied artifacts show

### 2.1 Current video

`ffprobe` reports:

- Video: 1080×1920, 30 fps.
- Duration: approximately 20.766 seconds.
- Audio: 48 kHz, stereo.
- The file is an actual rendered MP4, not merely a preview screenshot.

A contact sheet sampled at 1, 4, 7, 10, 13, 16, and 19 seconds shows the current sequence. The speech bubble is visible in the sample around 16 seconds with the copy “Runs on your own machine!”; most sampled frames have no bubble. The bottom caption is concurrently explaining essentially the same idea (“it is built to run on your own machine”), which creates avoidable duplication.

The mascot and the existing caption panel are present throughout the clip. The card/page movement is working and is expressly out of scope for this change.

### 2.2 Callout artwork

The archive contains:

- `assets/callout-bubble.png`: 1082×789 RGBA. This is the default asset selected by `readCalloutPath()`.
- `assets/Comic Speech Bubble Sticker.png`: 1672×941 RGBA. This is the fallback asset if `callout-bubble.png` is absent.
- The separately attached `Comic Speech Bubble Sticker(1).png`: 1672×941 RGBA.
- `image(20261025-070659).png`: a flattened 912×1600 composition reference, not an overlay asset.

The default `assets/callout-bubble.png` contains the white cloud, dark outline, yellow offset edge, rays and curved yellow arrow in one transparent image. It has **no callout text embedded in the white area**; `src/card.ts` renders the text as a separate DOM element. This is good: the text can change without generating a new PNG.

The reference composition shows two distinct text roles:

- White speech/thought callout above the mascot: a brief, meaningful headline.
- Dark bottom caption panel: the actual narration, with the yellow karaoke word highlight.

These two roles must remain separate.

---

## 3. Current source path (verified from code)

The current production flow is:

1. `src/script-composer.ts` creates selected narration segments and adds `calloutText` to some roles.
2. `src/index.ts` synthesizes narration, merges audio, and calls `toTimedChunks()`.
3. `src/index.ts` calls `buildCalloutCues(plan.segments, timedChunks, merged.durationMs)`.
4. `src/index.ts` stores `callouts` in `timeline.json` and passes them to `renderVideo()`.
5. `src/render.ts` passes `callouts` and `calloutImageUrl` through to `renderCardVideo()`.
6. `src/browser-capture.ts` evaluates each output frame at `timeMs`, calls `calloutCueAt()` and `calloutStateAt()`, then calls `window.__showcase.setCallout(...)` before capturing the frame.
7. `src/card.ts` contains the callout stage-level overlay, optional PNG, fallback SVG, and separate `#callout-text` element.
8. `src/qa.ts` checks cue count, non-overlap, bounds, copy length, and presence of evidence IDs.

This is the correct overall architecture. The work should repair and extend these existing connections instead of introducing a second animation runtime.

---

## 4. Specific code-level findings and required fixes

### 4.1 Callout selection is currently limited

In `src/script-composer.ts`, approximately lines 220–225:

```ts
const calloutEligible =
  node.role === "purpose" || node.role === "tradeoff" || node.role === "benefit";
const calloutText = calloutEligible ? calloutTextFor(node.proposition) : null;
```

This omits useful roles such as `mechanism` and `example`. A video with a useful purpose segment plus an interesting supported example can therefore still produce only a single suitable bubble.

**Fix:** keep the eligibility policy in a dedicated callout planner, based on the selected explanation graph and evidence. Candidates should include purpose, mechanism, example/result, benefit, and a meaningful trade-off when present. Do not attach callouts to every node. Add the segment role, node importance, and evidence IDs to each candidate so selection can be made consistently.

### 4.2 Callout count policy is inconsistent

The current code disagrees with itself:

- `src/types.ts`: comment says the first implementation renders at most one per video.
- `src/index.ts`: comment says “One evidence-backed callout for the purpose beat.”
- `buildCalloutCues()` in `src/callout-overlay.ts`: `options.maxCues ?? 3`.
- `src/qa.ts`: `callout-count` checks `cues.length <= 4`.
- `tests/callout-overlay.test.ts`: a test titled “exactly one cue” uses overlapping/adjacent candidate windows and expects one.

**Fix:** adopt one product rule everywhere. For the desired multi-callout behavior, use a duration-based cap: e.g. 2–3 for 18–22 seconds, 3–5 for 25–40 seconds, and never more than 6 under the 58-second ceiling. These are upper limits, not required counts. If the evidence only supports two callouts, produce two. Update type comments, the scheduler, QA, logging, and tests to agree.

### 4.3 Candidate timing currently suppresses neighboring callouts

The current logic roughly does:

```ts
start = max(minStart, min(chunk.start - startLead, chunk.end - 200));
end = min(chunk.end + endTail, start + maxVisible, duration);
```

and then rejects a cue if it collides with an existing cue or violates an 800 ms quiet gap. Since `start` is before a chunk and `end` is after that chunk, sequential cues can overlap or come too close together even when their narrative ideas are both useful. As a result, the loop skips candidates rather than shortening or rescheduling them.

`CALLOUT.minVisibleMs` is defined in `src/config.ts` but is not used in cue construction. The QA checks `minWords`, `maxWords`, and `maxLines`, but not a guaranteed useful hold duration.

**Fix:** schedule cues chronologically in a second pass after candidate ranking. Give each cue a preferred duration and a permitted range. Clip its end to the next accepted callout's start minus the configured gap, rather than simply rejecting the candidate because its original windows overlap. Use the narration/semantic segment boundaries as the starting point, and preserve the relation to the intended spoken idea.

Suggested starting defaults:

- lead-in: 80–120 ms before the associated idea, where enough earlier time exists;
- minimum readable hold: 1,200 ms;
- preferred visible duration: 1,800–2,800 ms;
- hard maximum: 3,400 ms;
- inter-callout visual gap: 450–700 ms;
- entrance: 200 ms;
- exit: 180 ms.

A cue must not begin before the mascot's entrance settles, must not extend past the final audio, and must not overlap another cue. If the remaining interval cannot hold the minimum readable duration, skip or merge that candidate rather than showing a flash too brief to read.

### 4.4 Callout anchor uses geometry different from the actual mascot layer

In `src/card.ts`, the actual character CSS uses:

```ts
right: ${MASCOT_LAYOUT.offsetX}px;
bottom: ${MASCOT_LAYOUT.offsetY}px;
width: ${mascotWidthPx}px;
```

But the callout anchor is computed separately through `mascotPlacementCss()` and `mascotHeadAnchor()`, passing `MASCOT_LAYOUT.offsetX/offsetY` as `clipRightPx/clipBottomPx`. Those input values are documented as CSS right/bottom offsets in `MASCOT_LAYOUT`, but `mascotPlacementCss()` treats the inputs as signed visible-edge clipping values and converts them into new CSS offsets. The calculated anchor therefore does not represent the character element that is actually placed in CSS.

With the current values (`widthRatio = 0.8731`, `offsetX = -60`, `offsetY = -23`, source 1284×1182, recorded visible bounds 6..1278 and 6..1176):

- CSS image width: `round(1080 × 0.8731) = 943 px`.
- Scale: `943 / 1284 ≈ 0.7344`.
- Transparent edge margin: about 3.67 px per edge after scaling.
- The actual CSS uses right = −60 and bottom = −23.
- The helper instead calculates right ≈ +56.33 and bottom ≈ +19.33 when those signed offsets are passed into it.
- Difference between the two geometries: about 116.33 px horizontally and 42.33 px vertically.

The callout may be clamped by `leftMinPx`, which hides part of the horizontal mismatch, but the tail and vertical position can still feel detached.

**Minimal fix:** keep the existing mascot CSS placement and entrance unchanged. Make the anchor calculation use the exact CSS rectangle and transform that the mascot actually uses. Do not change the visual mascot position merely to satisfy the old helper. Introduce one authoritative `getMascotFrameGeometry(timeMs, pose, assetBounds)` function, used both by the mascot layer and by the callout/impact overlays, or put the character and its anchor/accents under one shared transform wrapper. Ensure the code has one interpretation of `offsetX` and `offsetY`.

The callout should follow the current pose transform (`x`, `y`, rotation and scale) at the same `timeMs`; the current callout's `left` and `top` are calculated once in `buildCardHtml()`, while the mascot is changed per frame in `setCharacterPose()`. So it follows the approximate static head position, but does not actually follow the tiny per-frame bob/tilt/scale. Make the anchor a child of the same motion coordinate system or compute its position for each frame.

### 4.5 The active PNG does not match the current bubble layout box

The default PNG is 1082×789, aspect ratio:

`1082 / 789 ≈ 1.371`

The current CSS box is 360×285, aspect ratio:

`360 / 285 ≈ 1.263`

With `object-fit: contain`, a 360 px wide PNG is only about `360 / 1.371 ≈ 262.6 px` high, leaving approximately 22.4 px of total vertical letterboxing in the 285 px wrapper. However:

- `.callout-text` uses fixed `top: 30px` and a height derived from `bodyHeightPx`.
- `placeCallout()` uses `tailXLocalPx: 82`, a coordinate suitable for the fallback 360×285 SVG path.
- The supplied PNG's actual tail is closer to roughly 0.36 of its source width (about 130 px in a 360 px render), not 82 px (0.228 of the width).

This means the bubble shell, text box, and target point can use different coordinate assumptions. That can make the text look too high/low, or make the tail point away from the mascot.

**Fix:** make the active callout layout asset-aware. Use the actual PNG aspect ratio and a measured normalized text-safe rectangle and tail-tip coordinate for that asset. Keep fallback SVG geometry separate. Do not use the SVG tail coordinate for PNG placement. If a user chooses a different bubble asset, either provide an asset profile with safe text bounds and tail position, or use a vector bubble whose geometry is described by the same layout config.

For the current default PNG, a preliminary width near 360–380 px and the corresponding aspect-preserving height (`height = width × 789 / 1082`, roughly 263–277 px) is a reasonable starting point. Final safe text bounds and tail coordinates must be inspected against the actual asset in the preview, not guessed from a nominal box.

### 4.6 The embedded yellow rays cannot be animated independently

In `src/card.ts` the PNG is rendered if `calloutImageUrl` exists, while the vector bubble and SVG rays are hidden with `display:none`. But `calloutStateAt()` only changes the opacity of `#callout-rays`. With the PNG active, that SVG has `display:none`, and the PNG's rays/arrow are already baked into the raster asset. Its ray opacity cannot change separately.

**Fix:** leave the supplied callout PNG's yellow outline/offset, static rays and curved arrow exactly as designed. Add a second, independent SVG layer for the *mascot impact strokes* shown in the reference. These are not the same as the static strokes embedded in the callout PNG. Do not try to animate the baked PNG pixels by changing the PNG's opacity—the whole callout would fade. Do not add a duplicate SVG burst over the same bubble rays.

### 4.7 Current bubble copy is short, but not selected as a sequence of important thoughts

`calloutTextFor()` is a rule-based copy shortener. It can transform “turns X into Y”, use a `that/which` clause, simplify “built to run…”, or trim trailing qualifiers. This is a useful foundation, but it is not an event-selection policy. The selected callout may closely repeat the sentence visible in the bottom caption, as happens in the supplied video.

**Fix:** separate the stages:

1. generate candidate snippets from supported narrative nodes;
2. score their value and uniqueness;
3. choose a diverse, timeline-feasible sequence;
4. shorten each selected proposition into 3–7 words, preserving its meaning;
5. compare it with the spoken caption and reject exact/near-verbatim duplication when a distinct summary is available;
6. measure actual rendered text bounds inside the bubble and reduce font/wrap or omit the copy if it does not fit.

Do not create generic filler such as “Check this out!” or unsourced hype. The existing no-generic-fallback rule is correct and should remain.

---

## 5. Target experience and callout policy

### 5.1 Viewer experience

The mascot remains the presenter. The white bubble is a short “thought worth noticing” or speech callout. Bottom subtitles are the verbatim narration/caption line with the moving karaoke highlight. Yellow impact marks are tiny comic/anime emphasis accents that appear at irregular, meaningful moments.

These are three distinct roles:

- **Mascot:** personality and visual continuity.
- **Callout bubble:** one important idea from the narration, summarized in a few words.
- **Bottom subtitles:** the actual spoken phrase, highlighted word by word.
- **Impact lines:** brief kinetic emphasis, not text and not decorative noise.

### 5.2 Number of callouts

For a typical 20–35 second Reel, target about 3–5 callouts, with a configurable maximum of 6. This is not a quota. The algorithm should show fewer when only one or two genuinely useful ideas exist.

Suggested candidate roles, in descending general usefulness:

1. purpose / transformation;
2. distinctive mechanism;
3. concrete use case or output;
4. important benefit or differentiator;
5. material limitation / trade-off.

Do not show callouts for routine metadata such as TypeScript, last-updated date, star count, or license unless it is genuinely the point of the video. Keep every callout linked to supporting `factIds`.

### 5.3 Selection should be “varied, but not arbitrary”

The user wants the callouts to feel less predictable. Do not generate truly random words or random display times. Instead:

- rank evidence-backed candidates by semantic importance;
- force the strongest purpose message first when available;
- choose later candidates from the top, non-redundant candidates using a seeded weighted choice;
- schedule them to their related speech segments;
- persist the resulting cue list in `timeline.json`.

Use a stable pseudo-random seed derived from `repository.full_name + runId + effect-version`. That provides controlled variation between runs while making a given run reproducible. Re-rendering the same run must not produce different callout or impact-line timing.

---

## 6. Suggested target geometry (1080×1920)

Keep all existing card/page geometry and movement unchanged. The following are starting settings for overlay calibration, not a claim that every mascot PNG will have identical bounds.

### 6.1 Callout

- Canvas: 1080×1920.
- Bubble width: 360–380 px; default starting point 370 px.
- Height: derive from the selected asset's aspect ratio, not an unrelated fixed number.
- Right margin: 20–32 px, subject to measured head anchor.
- Vertical position: anchor the bubble tail to the measured head region. Use the screenshot as the target, but clamp the cloud body above the protected face/glasses rectangle.
- Outline: preserve the source asset's dark outline and yellow offset accent.
- Fill: preserve the source asset's white/off-white interior.
- Text: 32–36 px bold, dark `#151619`, maximum two lines, centered.
- Text safe box: use normalized fractions of the bubble PNG's intrinsic dimensions. Measure text wrapping against the actual font in Chromium.
- Shadow: keep the existing soft shadow, around `0 10px 24px rgba(0,0,0,.18)`.

The bubble can partially overlap the card, as in the approved composition, but must not cover the mascot's face. Its tail should point towards the mascot's head/upper hair. The positioning function must use the tail point measured for the *selected asset*, not the fallback vector tail point.

### 6.2 Bottom caption panel

Preserve current caption rendering and placement in this pass unless the preview demonstrates a collision:

- `CAPTION_OVERLAY`: left 200 px, top 1510 px, width 680 px, max height 190 px.
- Panel: dark near-black with about 92% opacity; existing 26 px corners and 14/32 px shadow remain.
- Font: current 50 px / weight 900 setting in code.
- Active word pill: current canonical lemon yellow `#FFE66D`, dark text `#151619`.

Do not add the full caption sentence to the callout. The callout has its own separate text element.

### 6.3 Mascot impact lines

Use small SVG strokes attached to normalized mascot reference points. Suggested visual areas from the supplied reference:

- a short ray group near the left/top of the hair;
- a short accent beside the upper-right hair/head edge;
- one near the outer shoulder/sleeve;
- optionally one near the laptop edge or a hand gesture.

Do not put decorative strokes across the eyes, glasses, spoken-word captions, or callout text. Each burst should be 2–4 short paths, not a full starburst around the entire body.

Starting values:

- stroke colour: `#FFE66D`;
- stroke width: 4–7 px at 1080×1920;
- round line caps;
- opacity peak: 0.75–0.95;
- each burst lifetime: 260–480 ms;
- per-path start stagger: 35–100 ms;
- minimum gap between bursts: 500 ms;
- maximum visible bursts: configurable, initially 6 for a 20–35 s video;
- no continuous pulsing, flashing, rotating, or per-frame random variation.

Use two z-order classes if some accents should appear behind the character and others in front: back strokes behind the mascot alpha, foreground strokes above the mascot but below caption text. The initial implementation should favour strokes behind the hair/shoulder and use only a few foreground marks.

---

## 7. Mathematical model

### 7.1 Callout candidate score

Every eligible narrative node has a bounded `importance`, evidence references, a role, and estimated speech timing. Build normalized candidate dimensions in `[0,1]`:

- `importance`: importance assigned by the explanation planner;
- `evidenceStrength`: strength/specificity of its source facts;
- `novelty`: whether it adds a new idea beyond selected callouts;
- `curiosity`: whether the short wording communicates a specific, non-generic outcome;
- `compactness`: how well the line fits the bubble without losing meaning.

Initial score:

`score = 0.30*importance + 0.25*evidenceStrength + 0.20*novelty + 0.15*curiosity + 0.10*compactness`

These are configurable starting weights. Evidence validation remains a hard gate: no high score can rescue an unsupported claim.

Penalize pairwise redundancy between two snippets using token-set similarity. One simple measure is Jaccard similarity:

`J(A,B) = |tokens(A) ∩ tokens(B)| / |tokens(A) ∪ tokens(B)|`

Use it as a warning/penalty, not as a hard rule on all overlap: the callout is supposed to summarize the spoken idea, so some shared vocabulary is expected. At minimum, reject exact duplicates and prefer a shorter, complementary headline over a near-verbatim copy of the bottom subtitle.

### 7.2 Duration-aware callout count

Let `T` be measured audio duration in milliseconds. An initial cap can be:

`maxCues = clamp(round(T / 7000), 2, 6)`

Then apply a hard configured `maxCues`. For example, 20.8 s gives 3 as the nominal cap; 35 s gives 5. The candidate count can be smaller. This is a cap, not a target.

### 7.3 Schedule windows without rejecting all neighboring beats

First derive the desired window from the measured audio chunk for segment `i`:

- `desiredStart_i = max(mascotSettledMs, chunk.startMs - startLeadMs)`
- `desiredEnd_i = min(durationMs, max(chunk.endMs + endTailMs, desiredStart_i + minVisibleMs))`
- `desiredEnd_i = min(desiredEnd_i, desiredStart_i + maxVisibleMs)`

Then sort selected candidates by time. For adjacent candidates, reserve an interval `minGapMs`. If windows collide:

1. prioritize a higher-scoring cue;
2. shorten the earlier/lower-priority cue to end before the next cue if it still meets `minVisibleMs`;
3. otherwise drop the lower-priority cue and record the omission reason.

Do not use the current policy where a cue is simply rejected because the original chunk-based windows plus a gap overlap. Never display two bubbles at once unless explicitly enabled in configuration (default: disabled).

### 7.4 Entry/exit state

Let `t` be media time; cue interval is `[s,e)`. With entry duration `D_in`, exit duration `D_out`:

`u_in = clamp((t-s)/D_in, 0, 1)`

`u_out = clamp((t-(e-D_out))/D_out, 0, 1)`

`E_out(u) = 1-(1-u)^3`

`E_in(u) = u^3`

`opacity(t) = E_out(u_in) * (1-E_in(u_out))`

`translateY(t) = enterY*(1-E_out(u_in)) - exitY*E_in(u_out)`

`scale(t) = enterScale + (1-enterScale)*E_out(u_in) - exitScale*E_in(u_out)`

Use the same current `calloutStateAt()` structure. Keep it a pure function of media time; do not use CSS keyframe animations, `setTimeout`, or accumulated frame state.

### 7.5 Exact head anchor geometry

Do not combine two competing definitions of `right`/`bottom`. The rendered mascot element has a CSS image rectangle and a transform. The callout anchor should derive from that same geometry.

If the CSS image rectangle before transforms is `(L,T,W_i,H_i)` and the normalized head anchor in the source image is `(a_x,a_y)`, then the local untransformed point is:

`x0 = L + a_x*W_i`

`y0 = T + a_y*H_i`

For a mascot transform with translation `(dx,dy)`, scale `q`, rotation `θ`, and transform origin `(o_x,o_y)`, transform the point in local coordinates:

`x' = o_x + q*((x0-o_x)*cosθ - (y0-o_y)*sinθ) + dx`

`y' = o_y + q*((x0-o_x)*sinθ + (y0-o_y)*cosθ) + dy`

Use radians for `θ`. Alternatively, keep the mascot and anchor as children of a common transformed wrapper, which is simpler and less error-prone in browser layout. The selected approach must make the callout follow the same per-frame pose that `setCharacterPose()` applies.

For asset swaps, define a per-mascot normalized head anchor (or a small asset profile) so the callout does not assume every character has the same face position. Keep default canvas placement configurable. Replacing the image should not require rewriting the bubble renderer.

### 7.6 Callout text fit

The current estimated character-width calculation is useful as a fast pre-check, not a final correctness gate. Use Chromium's actual measured text bounds for final fit:

- text container width/height;
- `scrollWidth <= clientWidth`;
- `scrollHeight <= clientHeight`;
- line count no more than the configured maximum.

Use font-ready measurement after the page's fonts load. If copy overflows, try one deterministic shorter candidate or a smaller permitted font size. If it still does not fit, reject that cue and record why. Never draw text on top of the tail, outside the white interior, or touching the outline.

### 7.7 Impact-line nonuniform schedule

Impact strokes must be irregular but reproducible—not randomly different on every rendered frame.

Use a small seeded PRNG in the *planning* stage only. Seed it from `repository.full_name + runId + effectVersion`. Use meaningful events (callout starts, example starts, benefit statements, emphasized words) as candidate windows. Add bounded time jitter, then enforce cooldown and count limits.

For each candidate event:

- choose an anchor zone from safe zones around hair/shoulders/laptop;
- choose one of 3–5 authored stroke arrangements;
- pick a bounded scale and rotation variation;
- set `startMs` and `endMs` in `timeline.json`;
- stagger individual strokes inside the burst by a bounded offset.

Do not generate one event every fixed second. Also do not use pure uniform randomness across the video: that could place marks during silence or in the middle of important caption text. Seeded variation is applied only to semantically valid candidates.

A candidate timing recipe is:

`startMs = clamp(semanticTimeMs + jitter, mascotSettledMs, durationMs - burstDurationMs)`

where `jitter` is sampled within `[-jitterMaxMs, +jitterMaxMs]`. Reject or re-place candidates if they violate `minIntervalMs` or collide with protected rectangles.

For each SVG stroke with path length `L`, animate its reveal by stroke dash:

`dashOffset(t) = L * (1 - easeOutCubic(progress))`

Opacity fades in during the first short fraction, remains near full for a brief hold, and fades out before `endMs`. All values are evaluated from media time. The exact same frame timestamp must always yield the same stroke state.

---

## 8. Recommended type contracts

Extend existing types rather than creating duplicate timelines.

### 8.1 Callout cue

```ts
export type CalloutRole =
  | "purpose"
  | "mechanism"
  | "example"
  | "benefit"
  | "tradeoff";

export type CalloutCue = {
  id: string;
  segmentId: string;
  role: CalloutRole;
  text: string;
  startMs: number;
  endMs: number;
  factIds: string[];
  anchor: "mascot-head";
  importance: number; // normalized 0..1
  selectionScore: number;
  omissionAlternatives?: string[];
};
```

Keep source provenance in the existing `factIds`; do not duplicate raw README content into `timeline.json`.

### 8.2 Impact burst cue

```ts
export type ImpactAnchor =
  | "hair-left"
  | "hair-right"
  | "shoulder-left"
  | "shoulder-right"
  | "laptop-edge";

export type ImpactBurstCue = {
  id: string;
  startMs: number;
  endMs: number;
  anchor: ImpactAnchor;
  variant: "two-rays" | "three-rays" | "short-spark" | "sweep";
  rotationDeg: number;
  scale: number;
  opacity: number;
  layer: "behind-mascot" | "front-mascot";
  relatedSegmentId?: string;
  seed: number;
};
```

Store `impactBursts` alongside `callouts` in `Timeline`. Do not create a second independently scheduled clock.

### 8.3 Asset profile

```ts
export type CalloutAssetProfile = {
  widthPx: number;
  heightPx: number;
  // Normalized coordinates in the asset's actual image box.
  tailTip: { x: number; y: number };
  // Normalized safe rectangle for separate text.
  textSafeRect: { x: number; y: number; width: number; height: number };
  containsEmbeddedRays: boolean;
  containsEmbeddedArrow: boolean;
};
```

The default profile must describe `assets/callout-bubble.png` (1082×789). The alternate sticker is 1672×941 and must not silently reuse the default tail/text geometry.

---

## 9. File-by-file implementation plan

### 9.1 `src/config.ts`

**Change:** add a canonical `CALLOUT` configuration and a new `IMPACT_ACCENTS` configuration, preserving the current exported names where possible.

Make the following configurable:

- enable/disable callouts;
- max calls and min/max visible duration;
- lead-in, tail, inter-callout gap, entrance/exit durations;
- bubble width, right margin, anchor offset and allowed top range;
- per-asset aspect/text-safe/tail profile;
- font family, font size, weight, line height, text padding and maximum lines;
- fill, outline, outline width, yellow accent and shadow;
- enable/disable impact strokes;
- stroke colour, width, peak opacity, min/max burst count, min interval, jitter, burst duration, per-line stagger, allowed anchor zones and seeded-variation mode.

Do not silently change the card, `CARD_SHADOW`, `MASCOT_LAYOUT`, `CHARACTER` motion, or current caption defaults in this pass.

Validate all numeric settings as finite and within bounds. Colours should be normalized to valid hex/RGBA strings. Invalid values should fall back to the last valid/default value and produce a warning, not a broken render.

### 9.2 `src/types.ts`

- Update the `CalloutCue` documentation to reflect multiple non-overlapping cues.
- Add the impact event types above.
- Add `impactBursts?: ImpactBurstCue[]` to `Timeline`.
- Keep caption phrases, callout cues, character cues and impact cues as separate arrays, all using the same `durationMs` clock.
- Do not mix callout text with `captionText`; these must remain distinct strings.

### 9.3 `src/script-composer.ts`

Current behavior only attaches `calloutText` to purpose/tradeoff/benefit. Change it to attach a potential bubble headline for supported role types, particularly:

- `purpose`;
- `mechanism`;
- `example` / `workflow`;
- `benefit` / outcome;
- material `tradeoff`.

Do not make every segment eligible. Record the semantic role and importance so the selector can choose a balanced story, not simply the first identity/purpose lines.

A callout headline should be a shortened summary, not a second full narration sentence. Keep the existing evidence IDs. If shortening would change the proposition or remove a key qualifier, return `null` instead of guessing.

### 9.4 `src/callout-overlay.ts`

Keep the existing pure-function structure, but refactor into clear separate responsibilities:

1. candidate creation and candidate score;
2. seeded/diverse candidate selection;
3. chronological cue scheduling with min/max duration and inter-cue gaps;
4. text fitting and copy validation;
5. `calloutCueAt()`;
6. `calloutStateAt()`;
7. asset-aware placement based on a correct mascot head anchor.

Do not use `cuePriority()` as the whole selection algorithm. Use scored candidates plus diversity so the final list can contain purpose, mechanism and example/outcome. Make selection results stable for a saved run.

Fix the active PNG geometry: do not use `tailXLocalPx=82` from the fallback SVG to place `assets/callout-bubble.png`. Use `CalloutAssetProfile.tailTip.x * renderedAssetWidth`. Use the asset aspect ratio to calculate height. Adjust placement and text box using the same coordinate basis.

Use actual DOM text layout measurements to verify final fit. Keep `textContent`, never `innerHTML`, for repository-derived bubble copy.

### 9.5 New `src/impact-accents.ts`

Create one new pure module to:

- define authored SVG path variants (short rays, two-line spark, small sweep);
- choose an anchor zone from a safe, normalized list around the mascot;
- schedule irregular but reproducible bursts from semantic timing candidates;
- calculate per-frame opacity, stroke dash, scale and translation from media time;
- enforce minimum interval, maximum count and protected regions;
- return an empty list when disabled.

Use a local seeded PRNG implementation or the project's already available deterministic hash utility. Do not add a new package dependency just for randomness.

Do not draw the impact lines into `Character/image.png` or into the bubble PNG. They must be independent SVG/HTML overlays so their timing, position and colour are editable.

### 9.6 `src/mascot-layout.ts`

- Make one canonical geometry path for the actual CSS `right`, `bottom`, width and alpha bounds.
- Fix the signed-offset mismatch. Existing values in `MASCOT_LAYOUT` are CSS offsets; do not interpret them as positive clip values.
- Expose a stable normalized head anchor for each configured mascot asset. If poses have different aspect ratio/alpha bounds, allow a per-pose anchor profile or use a shared anchor wrapper with a consistent source box.
- Expose normalized impact anchor zones for hair/shoulders/laptop. Avoid hard-coded absolute positions tied to one PNG's blank margins.
- Preserve the rendered mascot position and current entrance. This change should repair the *anchor calculation*, not move the mascot to a new location.

### 9.7 `src/character-motion.ts`

- Preserve the current `characterPoseAt()` and `speechLevelAt()` motion.
- Ensure that the head anchor and impact anchors see the same evaluated pose transform as `setCharacterPose()`.
- The current code returns `entranceX`, `entranceY`, `entranceOpacity`, and `entranceScale` fields from `entranceAt()`, while `setCharacterPose()` consumes `x`, `y`, `rotationDeg`, `scale`, and `opacity`. Audit this mismatch during implementation: do not inadvertently rewrite the approved entrance, but make sure any entrance fields that are meant to affect motion are actually consumed by the renderer.
- If the character is a single PNG, do not fake facial animation. Keep the existing small body bob/tilt; the new impact strokes supply visual emphasis.

### 9.8 `src/card.ts`

- Keep the GitHub card markup/CSS, scroll clipping, browser chrome and card shadow unchanged.
- Keep the callout outside `.card` and outside its `overflow:hidden`, as the current tests require.
- Use an asset-aware bubble wrapper whose actual rendered ratio matches the selected PNG.
- Position the text inside the measured safe rectangle. `callout-text` remains a separate text node.
- Keep the callout's PNG background transparent; never put a solid white rectangle behind the full PNG.
- Add SVG containers for impact strokes, separate into back/front layer if required.
- Give the new overlays an explicit z-index order: card/page unchanged; rear accents behind mascot; mascot; callout; front accents (only safe zones); caption panel/highlight/text. Preserve the intended rule that the character is in front of the GitHub card and that captions/callout do not cover the eyes/glasses.
- Add `window.__showcase.setImpactState(...)` or an equivalent deterministic setter. It must set SVG path state from numeric arguments, not start CSS animations.
- Extend `window.__showcase.geometry()` with the actual callout asset box, callout text box, mascot box/head anchor, and impact bounding boxes for QA/preview.

If the callout is nested inside a shared mascot-motion wrapper so it follows movement naturally, preserve the intended layer order. Do not accidentally put the callout behind the card or inside the clipped viewport.

### 9.9 `src/browser-capture.ts`

The current frame loop already computes `timeMs`, callout state, pose, caption, and scroll. Extend that loop, do not introduce another timer.

At each frame:

1. compute `pose = characterPoseAt(timeMs, speechLevel, poseName)`;
2. set scroll;
3. set the current caption and active-word highlight;
4. set the mascot pose;
5. compute/apply the callout's layout from the same actual mascot geometry/pose;
6. compute/apply the impact-stroke state for `timeMs`;
7. capture the screenshot.

If the callout position is computed in the browser from the live mascot wrapper, apply the character transform before measuring the anchor. If computed in TypeScript, use the same documented transform math as the renderer. Do not mix a static pre-transform anchor with a moving image.

All animations remain a pure function of the requested `timeMs`. Repeated or out-of-order frame capture must return the same result.

### 9.10 `src/index.ts`

- After final TTS chunk timing exists, build callout candidates/cues and impact bursts.
- Pass the actual `runId` as part of the effect seed and save it in the run artifacts.
- Add both arrays to `timeline.json`.
- Pass `callouts`, `impactBursts`, and the existing asset/pose data to the renderer.
- Replace the contradictory “one callout” log with a summary showing count, role, text, and interval for each cue. Include skipped candidate reasons in a separate report.
- The selected callout list must be made after narration composition and audio timing, not in the PNG generation path.

### 9.11 `src/render.ts`

Pass through the new `impactBursts` data to `renderCardVideo()`. Do not add a second clock or render these in a separate video stage. Preserve the existing FFmpeg encoding chain and audio path.

### 9.12 `src/qa.ts`

Extend QA beyond current count/timing/copy checks:

Callout checks:
- count within configured cap;
- no overlaps;
- minimum readable duration unless explicitly marked as a short beat;
- cue end within audio duration;
- every cue has non-empty evidence IDs and valid segment ID;
- copy fits within actual text box at actual font metrics;
- callout image aspect ratio matches layout;
- tail target stays within allowed distance of the mascot head anchor;
- callout does not intersect the protected face/glasses region;
- callout does not overlap the caption panel beyond a configured tolerance;
- callout does not go outside the canvas.

Impact checks:
- burst count within config;
- start/end within duration;
- minimum inter-burst gap;
- no non-finite animation values;
- bounded stroke width, scale and rotation;
- no impact path covers protected face/caption zones;
- no overlapping bursts unless allowed;
- deterministic result for the same seed.

The existing `overlayLayoutChecks()` uses static values and currently tests callout/caption bounds, but it does not check callout/caption overlap or the actual transformed mascot anchor. Add these checks while keeping existing card checks unchanged.

### 9.13 Existing tests

Update `tests/callout-overlay.test.ts` to test the intended multi-cue policy instead of the old “exactly one cue” assumption. Add tests for:
- purpose + mechanism + example candidate selection;
- score and diversity behavior;
- seeded reproducibility;
- multiple cue scheduling across sequential chunks;
- minimum readable hold and maximum duration;
- shortening/clipping behavior around collisions;
- near-verbatim copy duplication handling;
- actual asset aspect ratio and tail profile;
- callout follows the same frame-specific mascot transform;
- PNG mode and SVG fallback mode both render correctly;
- embedded PNG rays do not get incorrectly treated as animated SVG rays.

Update `tests/card.test.ts` to check the independent impact SVG layers, z-index ordering, text layer, and transparent PNG behavior.

Add `tests/impact-accents.test.ts` covering:
- same seed yields byte-equivalent cue plans;
- different seeds can vary only within permitted options;
- timing is nonuniform but bounded;
- no burst occurs outside the video duration;
- the maximum burst count and minimum gaps are enforced;
- easing/path state is frame-order-independent;
- path positions stay outside protected face/caption regions.

Update the geometry tests so the anchor is compared with the actual CSS layout values rather than only asserting that `mascotPlacementCss()` agrees with its own input.

### 9.14 Configuration editor and root launcher

Important archive limitation: `.gitignore` contains `tools/`, but the supplied ZIP references files under `tools/` that are missing from the archive. Specifically:

- `Save My Edits.cmd` and `Save My Edits.vbs` invoke `tools/launch-preview.ts` (missing from this ZIP).
- `package.json` references `tools/preview-server.ts` (missing from this ZIP).
- `tests/config-writer.test.ts` imports `tools/config-writer.ts` (missing from this ZIP).
- `tests/config-model.test.ts` expects `tools/config-model.js` and `tools/preview-live.html` (missing from this ZIP).

Therefore, the existing live configuration editor cannot be fully verified from the submitted archive. Recover these files from the actual working tree before implementing the configuration UI changes. Do not create a second settings editor if the real working tree already contains one.

Extend the existing editor's shared config schema, save model, UI controls, parser/writer and validation so it covers every callout and impact setting listed in Section 9.1. The preview must render the current settings without requiring a full TTS render. Saving should round-trip values without modifying unrelated code, and a no-op save should leave source files byte-identical, matching the current tests' intent.

Suggested UI groups:

**Callout**
- enabled;
- asset select/path;
- maximum bubbles;
- width and right/top offsets;
- text font size/weight/line height;
- safe text box offsets and maximum lines;
- fill, outline, outline width, yellow edge/offset and shadow;
- enter/exit duration and translation/scale;
- minimum/maximum visibility and quiet gap.

**Impact lines**
- enabled;
- colour and stroke width;
- minimum/maximum burst count;
- interval/jitter range;
- burst duration and per-line stagger;
- anchor zones;
- intensity/opacity;
- seed/variation mode.

**Preview actions**
- show/hide callout;
- preview purpose/mechanism/example callout copy;
- preview mascot anchor markers;
- show safe-area, face-protection and caption collision guides;
- reset the new values to defaults.

Keep the existing mascot, card shadow, card radius and caption controls as they are. The new controls should only append new fields and preserve the existing settings' meanings.

### 9.15 `README.md`, `TODO.md`, and `.gitignore`

The code is authoritative for this change. Update docs only after implementation.

- Document the multi-callout selection/timing behavior and impact-line system.
- Document the new configuration values/UI controls.
- Correct the stale mascot ratio/default in README if needed after comparing it to the committed code (`src/config.ts` currently sets `widthRatio` to `0.8731`, while README says `0.46`). Do not change the working mascot size merely to match stale documentation.
- Fix `.gitignore` to ignore only runtime assets/dependencies that should not be versioned, rather than blanket-ignoring the entire `tools/` source directory. If large binaries inside `tools/` must stay local, ignore those exact subpaths/files instead. Ensure the editor/config writer/preview server/launcher sources are committed and available to tests.

---

## 10. Asset behavior and icon source

### 10.1 Callout art

Use `assets/callout-bubble.png` as the default shell, because `readCalloutPath()` already chooses it before the broader `Comic Speech Bubble Sticker.png`. Preserve its transparent background, white fill, dark outline, yellow offset and curved arrow/rays. Render text separately as HTML/SVG text.

Do not flatten the text into the PNG; that would make the message non-editable and require a different image for each callout.

The active PNG has rays and arrow embedded in the raster. Leave those elements static as part of the bubble. The *new mascot accent lines* must be independent SVG elements so they can be animated at separate times.

### 10.2 GitHub icons

Icons inside the GitHub card (GitHub mark, notification bell, fork/star, README/license/activity/folder icons) are part of the captured GitHub page asset or the current fallback DOM. Keep using the existing page capture/fallback. Do not replace them with a new icon pack.

Only the new yellow comic impact strokes are authored by this project as SVG paths. They need no external assets or dependencies.

---

## 11. Timeline schema and exact sample

For each run, `timeline.json` should contain the final selected `callouts` and `impactBursts` along with existing chunks/captions/scroll.

Illustrative callout plan for a 20.8-second clip (times only demonstrate the format; production uses measured chunks):

```json
{
  "callouts": [
    {
      "id": "callout:purpose",
      "segmentId": "seg-01",
      "role": "purpose",
      "text": "Turn long videos into short clips!",
      "startMs": 650,
      "endMs": 2850,
      "factIds": ["purpose:..."],
      "anchor": "mascot-head",
      "importance": 0.98,
      "selectionScore": 0.91
    },
    {
      "id": "callout:mechanism",
      "segmentId": "seg-03",
      "role": "mechanism",
      "text": "Finds the strongest moments",
      "startMs": 6900,
      "endMs": 9200,
      "factIds": ["mechanism:..."],
      "anchor": "mascot-head",
      "importance": 0.86,
      "selectionScore": 0.79
    },
    {
      "id": "callout:outcome",
      "segmentId": "seg-05",
      "role": "benefit",
      "text": "Ready for vertical video",
      "startMs": 13100,
      "endMs": 15300,
      "factIds": ["benefit:..."],
      "anchor": "mascot-head",
      "importance": 0.78,
      "selectionScore": 0.74
    }
  ],
  "impactBursts": [
    {
      "id": "impact:01",
      "startMs": 1100,
      "endMs": 1460,
      "anchor": "hair-left",
      "variant": "three-rays",
      "rotationDeg": -9,
      "scale": 1.0,
      "opacity": 0.88,
      "layer": "behind-mascot",
      "relatedSegmentId": "seg-01",
      "seed": 1834021
    }
  ]
}
```

This is an example schema, not a claim that the current video has those segments or facts. The real event times must be built from the measured audio chunks in the run.

---

## 12. Rendering order

Keep the existing card/document motion intact. Introduce the new elements at the stage level, outside the card's `overflow:hidden` clipping.

Recommended layer order:

1. Cream stage/background.
2. Existing stationary card and its existing shadow.
3. Rear impact strokes around the mascot silhouette.
4. Existing mascot image/pose, with current shadow and movement.
5. White callout bubble PNG (or fallback SVG), positioned from the actual mascot anchor.
6. Separate callout text inside the bubble.
7. Small callout-side ray accents if they are not baked into the selected asset; do not duplicate the PNG's existing rays.
8. Optional front impact strokes in safe regions, below text layers.
9. Existing dark caption panel.
10. Existing moving yellow word highlight and subtitle text.

If the desired artistic effect needs a few strokes in front of the character and others behind, use two SVG groups; don't put every stroke above the face. The bottom caption panel should remain fully legible and must not be partially hidden by the character or callout.

---

## 13. Acceptance tests for the actual MP4

Unit tests are necessary, but the release gate must include a rendered output. Use the current video/reference as the visual baseline.

### 13.1 At 1080×1920, review these points

- Opening frame/mascot entrance.
- First callout entrance.
- Middle callout while a different narrative idea is spoken.
- Example or outcome callout.
- A moment where no callout is appropriate (bubble absent, no residual text).
- At least three yellow impact bursts at different, irregular intervals.
- Any callout during a pose change/mascot bob.
- Bottom caption highlight before/during/after a line wrap.
- Closing frame.

### 13.2 Visual criteria

- Bubble text is inside the white bubble, centered and not touching its outline/tail.
- The bubble's tail points toward the mascot's head/hair.
- The bubble follows the actual character position/pose and does not float independently.
- Callouts are present at several meaningful points when the evidence supports them, not just one purpose line.
- No two callouts overlap; no callout remains after its idea has ended.
- The bottom caption is separate from the callout; it continues word-by-word timing independently.
- Yellow impact lines appear irregularly, briefly, and in relation to meaningful beats; they do not flash continuously or cover eyes/text.
- Replacing the mascot with another asset that uses a declared head-anchor profile does not require editing the callout component.
- Replacing the callout PNG preserves the image/text separation and requires only its asset profile settings.
- The card and its scroll choreography are visually unchanged.
- No new player controls or browser UI appear in the MP4.

### 13.3 Automated criteria

- `npm run check` passes.
- Full test suite passes.
- `timeline.json` records all cue schedules and the seed.
- QA fails on overlaps, too-short unreadable cues, invalid text fit, invalid anchor geometry, out-of-frame paths, and invalid cue timing.
- Re-rendering the same saved timeline produces identical callout/impact states for each timestamp.
- Output duration/frame-rate/audio encoding stay under the existing project constraints.

---

## 14. Implementation order

Do not edit everything at once. Use this order:

### Pass 1 — Fix attachment and PNG coordinates

1. Make mascot geometry/anchor use the exact real CSS placement and per-frame pose.
2. Make callout aspect ratio, text-safe rectangle and tail position derive from the actual selected bubble asset.
3. Render a temporary reference frame at a callout timestamp and fix placement before implementing more events.

### Pass 2 — Enable multiple callouts

1. Expand `calloutText` candidates to mechanism/example/outcome roles where supported.
2. Add candidate scoring, diversity, and seeded selection.
3. Replace the chunk-window rejection behavior with chronological cue scheduling.
4. Remove inconsistent one/three/four-cue assumptions in type comments, index logging and QA.
5. Add tests for three meaningful non-overlapping cues across sequential chunks.

### Pass 3 — Add animated impact strokes

1. Add `src/impact-accents.ts` and `ImpactBurstCue`.
2. Create SVG strokes anchored to normalized mascot zones.
3. Use a seeded, bounded scheduler with semantic candidates and irregular timing.
4. Pass events through `Timeline`, `src/index.ts`, `src/render.ts`, and `src/browser-capture.ts`.
5. Add per-frame pure state evaluation and geometry QA.

### Pass 4 — Wire customization UI

1. Restore/commit the ignored `tools/` preview/config files from the real working tree.
2. Extend the shared preview configuration model/writer and live UI with callout, text-fit, schedule and impact-line settings.
3. Add no-op-save and round-trip tests for each new setting.
4. Keep existing controls and values unchanged.

### Pass 5 — End-to-end render and calibration

1. Run a fixed, well-documented repository through TTS, capture, timeline and render.
2. Inspect callout frames and impact strokes at full resolution and at mobile scale.
3. Adjust only the measured geometry/config values that fail review.
4. Verify no changes to the card movement and existing subtitle behavior.
5. Run the full tests and retain `timeline.json`, `qa.json`, and the contact sheet with the output.

---

## 15. Important archive limitation

The supplied ZIP's `.gitignore` contains `tools/`, while tests and launchers reference several files under that directory that are not present in this archive. The code in the ZIP is enough to analyze the render/runtime callout path, but it is **not enough to fully audit or modify the existing visual configuration editor**. Specifically, the files `tools/config-writer.ts`, `tools/config-model.js`, `tools/preview-live.html`, `tools/preview-server.ts`, and `tools/launch-preview.ts` are referenced but missing from this snapshot.

Before making the configuration UI changes, recover those files from the actual working tree and track the source files appropriately. The implementation plan should extend that editor rather than inventing a parallel UI. The source archive also contains `tools/preview.ts`, but this is a one-off fixture renderer, not the missing live configuration editor.

---

## 16. Out-of-scope items

Do not change these in this implementation pass:

- GitHub card size, shape, border, shadow or movement.
- Mobile screenshot capture and scroll keyframe generation.
- Voice preset (`am_fenrir`), TTS engine, script generation, or audio processing.
- Existing mascot asset design, target size, base position, or approved entrance timing.
- Existing caption phrase/word timing except where a geometry integration test is needed.
- FFmpeg encoding, frame rate, audio mapping or output format.

The objective is a reliable, configurable, character-linked multi-callout and impact-line system—not a redesign of the working output.

---

## Final implementation principle

Use one shared media timeline and one consistent mascot geometry. Select multiple callout ideas from verified narrative segments, schedule them in a deterministic but varied way, keep callout text separate from the transparent PNG, and animate yellow comic impact lines as independent SVG paths. Expose all new values through the existing configuration editor. Preserve the card, mascot asset and working caption pipeline. Validate the actual MP4, not just unit tests.
