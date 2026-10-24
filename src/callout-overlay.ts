import { CALLOUT, VIEWPORT } from "./config.js";
import type {
  AudioChunk,
  CalloutCue,
  CalloutState,
  NarrationSegment,
} from "./types.js";

/**
 * Callout bubble (Visual Composition Pass).
 *
 * Two independent text systems sit over the GitHub card:
 *
 *   1. the callout — a short summary of the project's purpose, attached to the
 *      mascot's head and shown once for a measured narration beat;
 *   2. the caption panel — the actual spoken phrase, with one moving accent
 *      pill behind the current word.
 *
 * This module owns the callout only, and it is deliberately pure:
 *
 *   - `calloutTextFor()` turns an already-selected, evidence-backed purpose
 *     proposition into concise bubble copy (or `null` — no invented fallback);
 *   - `buildCalloutCues()` binds that copy to the final *measured* audio chunk;
 *   - `calloutStateAt()` derives opacity/transform/rays from media time alone;
 *   - `placeCallout()` derives the bubble position from the mascot's measured
 *     head anchor.
 *
 * No CSS transition, `setTimeout`, frame counter or wall clock is involved, so
 * rendering a timestamp twice always produces the same state.
 */

export type CalloutLayoutConfig = {
  bubbleWidthPx: number;
  bubbleHeightPx: number;
  leftMinPx: number;
  rightMarginPx: number;
  topOffsetPx: number;
  topMinPx: number;
  topMaxPx: number;
  tailXLocalPx: number;
  tailInsetPx: number;
  faceOffsetPx: number;
};

export type CalloutLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  tailTipX: number;
  tailTipY: number;
};

export type CalloutHeadAnchor = {
  headTopY: number;
  faceCenterX: number;
};

/* ------------------------------------------------------------------ */
/* Deterministic math                                                  */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function easeOutCubic(u: number): number {
  const x = clamp01(u);
  return 1 - Math.pow(1 - x, 3);
}

function easeInCubic(u: number): number {
  const x = clamp01(u);
  return x * x * x;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/* ------------------------------------------------------------------ */
/* Callout copy                                                        */
/* ------------------------------------------------------------------ */

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Strip markdown/smart quotes and normalise whitespace without changing words. */
function cleanCopy(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Words that must never be the last word of a shortened bubble line. */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "into", "onto", "for", "with",
  "from", "to", "of", "in", "on", "at", "by", "as", "that", "which",
  "your", "their", "our", "its", "it", "is", "are", "be", "you", "we",
  "they", "so",
]);

function cleanWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9+#-]/g, "");
}

/**
 * Estimate how many lines the callout text needs inside the bubble.
 *
 * The bubble's text box is only `bubbleWidthPx - 2 * textPadXPx` wide, so a
 * seven-word sentence can genuinely require three lines. This check keeps the
 * rendered bubble to the approved two lines instead of letting it overflow.
 */
export function calloutLineEstimate(text: string): number {
  const words = wordsOf(text.trim());
  if (words.length === 0) return 0;
  const contentWidth =
    CALLOUT.bubbleWidthPx - CALLOUT.textPadXPx * 2;
  const charWidth = CALLOUT.fontSizePx * 0.52;
  const gap = CALLOUT.fontSizePx * 0.24;
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const width = word.length * charWidth;
    if (current > 0 && current + gap + width > contentWidth) {
      lines += 1;
      current = width;
    } else {
      current += (current > 0 ? gap : 0) + width;
    }
  }
  return lines;
}

/** True when the copy fits the bubble's approved two lines. */
export function calloutFitsBubble(text: string): boolean {
  return calloutLineEstimate(text) <= CALLOUT.maxLines;
}

/**
 * Give the copy a bubble-sized shape. Only clearly secondary qualifiers are
 * dropped, and only at a word boundary; the claim the words make is unchanged.
 */
function shortenCopy(text: string, maxWords: number): string | null {
  const direct = text.trim();
  if (wordsOf(direct).length <= maxWords) return direct;  // Trailing qualifiers only; the head of the sentence — its claim — is kept.
  const markers = [
    " so that ",
    " so you ",
    " in one step",
    " in a single step",
    " across ",
    " without ",
    " using ",
    " with ",
    " from ",
    " for ",
    " in ",
  ];
  for (const marker of markers) {
    const index = direct.toLowerCase().lastIndexOf(marker);
    if (index <= 0) continue;
    const shortened = direct.slice(0, index).trim().replace(/[,;:]$/, "");
    if (wordsOf(shortened).length >= CALLOUT.minWords) return shortened;
  }
  return null;
}

/**
 * Trim trailing words until the copy fits two bubble lines, never removing a
 * function word or leaving one dangling at the end. If the only way to fit is
 * ungrammatical ("… documentation into"), the copy is rejected instead.
 */
function trimToBubble(text: string, minWords: number): string | null {
  let words = wordsOf(text);
  while (words.length > minWords) {
    const candidate = words.join(" ");
    if (calloutFitsBubble(candidate)) return candidate;
    const last = words[words.length - 1];
    const previous = words[words.length - 2];
    if (
      FUNCTION_WORDS.has(cleanWord(last)) ||
      FUNCTION_WORDS.has(cleanWord(previous))
    ) {
      return null;
    }
    words = words.slice(0, -1);
  }
  const candidate = words.join(" ");
  return calloutFitsBubble(candidate) ? candidate : null;
}

function extractTransformation(text: string): string | null {
  const match = text.match(/\b(?:transforms?|converts?|turns?)\s+(.+?)\s+into\s+(.+)$/i);
  if (!match) return null;
  let source = match[1].trim();
  let target = match[2].trim();

  // Strip trailing destination / secondary clauses ("for TikTok, Reels...")
  target = target.replace(/\s+for\s+.+$/i, "").trim();
  target = target.replace(/\s+across\s+.+$/i, "").trim();

  // Clean common qualifiers that can be simplified without changing meaning:
  // "long-form videos" -> "long videos"
  source = source.replace(/\blong-form\s+videos\b/i, "long videos");
  // "viral-ready 9:16 short clips" -> "short clips"
  target = target.replace(/\b(?:viral-ready|ready-to-share|high-quality)\b/gi, "").trim();
  target = target.replace(/\b\d+:\d+\b/g, "").trim();
  target = target.replace(/\s+/g, " ");

  const candidate = `Turns ${source} into ${target}`.replace(/\s+/g, " ").trim();
  return candidate;
}

function extractSimplifications(text: string): string | null {
  const m = text.match(/^(?:it is\s+)?(?:built|designed|intended)\s+to\s+run\s+(.+)$/i);
  if (m) {
    return `Runs ${m[1]}`.trim();
  }
  return null;
}

/**
 * Concise bubble copy derived from the selected purpose proposition.
 *
 * Rules, in order:
 *  - if a transformation clause exists ("transforms X into Y"), allow a
 *    controlled rewrite such as "Turns X into Y!";
 *  - prefer the `that …` / `which …` clause: "a tool that turns X into Y"
 *    becomes "Turns X into Y!";
 *  - otherwise use the proposition itself, capped at 3–7 words and two lines;
 *  - drop only trailing secondary qualifiers when the sentence is too long;
 *  - return `null` when no faithful short form exists. A generic fallback such
 *    as "Check this out!" is deliberately not used: it explains nothing.
 */
export function calloutTextFor(
  proposition: string,
  options: { maxWords?: number; minWords?: number } = {}
): string | null {
  const maxWords = options.maxWords ?? CALLOUT.maxWords;
  const minWords = options.minWords ?? CALLOUT.minWords;
  const base = cleanCopy(proposition);
  if (!base) return null;

  const candidates: string[] = [];
  const transformation = extractTransformation(base);
  if (transformation) candidates.push(transformation);

  const clause = base.match(/\b(?:that|which)\s+(.+)$/i)?.[1]?.trim() ?? null;
  if (clause) candidates.push(clause);

  const simplification = extractSimplifications(base);
  if (simplification) candidates.push(simplification);

  candidates.push(base);

  for (const candidate of candidates) {
    const shortened = shortenCopy(sentenceCase(candidate), maxWords);
    if (!shortened) continue;
    const fitted = trimToBubble(shortened, minWords);
    if (!fitted) continue;
    const count = wordsOf(fitted).length;
    if (count < minWords || count > maxWords) continue;
    return /[!?]$/.test(fitted) ? fitted : `${fitted}!`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Cue construction                                                    */
/* ------------------------------------------------------------------ */

function normaliseForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cuePriority(segment: NarrationSegment): number {
  if (segment.narrativeRole === "identity") return 0;
  if (segment.purpose === "identify") return 1;
  if (segment.purpose === "benefit") return 2;
  return 3;
}

/**
 * Choose the one callout for this video and bind it to the measured audio.
 *
 * The cue starts just before the purpose chunk speaks and ends shortly after
 * it; it is clipped to the segment's own measured window (plus a small tail),
 * so it can never drift across an unrelated narration beat.
 */
export function buildCalloutCues(
  segments: NarrationSegment[],
  chunks: AudioChunk[],
  /** Total audio duration: a cue may never outlive the video. */
  durationMs?: number,
  options: { maxCues?: number; minGapMs?: number } = {}
): CalloutCue[] {
  const maxCues = options.maxCues ?? 3;
  const minGapMs = options.minGapMs ?? 800;
  const chunkBySegment = new Map(chunks.map(chunk => [chunk.segmentId, chunk]));
  const candidates = segments
    .map((segment, index) => ({ segment, index }))
    .filter(
      ({ segment }) =>
        Boolean(segment.calloutText?.trim()) &&
        segment.factIds.length > 0 &&
        chunkBySegment.has(segment.id)
    )
    .sort(
      (a, b) =>
        cuePriority(a.segment) - cuePriority(b.segment) || a.index - b.index
    );

  const cues: CalloutCue[] = [];

  for (const { segment } of candidates) {
    if (cues.length >= maxCues) break;
    const chunk = chunkBySegment.get(segment.id)!;
    const text = segment.calloutText!.trim();

    // A bubble that repeats the subtitle verbatim is a second copy of the same
    // line. Omit it rather than showing the same sentence twice.
    if (normaliseForComparison(text) === normaliseForComparison(segment.captionText)) {
      continue;
    }

    const startMs = Math.max(
      CALLOUT.minStartMs,
      Math.min(chunk.startMs - CALLOUT.startLeadMs, chunk.endMs - 200)
    );
    const endMs = Math.min(
      chunk.endMs + CALLOUT.endTailMs,
      startMs + CALLOUT.maxVisibleMs,
      durationMs ?? Number.POSITIVE_INFINITY
    );
    if (endMs - startMs < CALLOUT.minCueDurationMs) continue;

    // Reject if it overlaps with an already scheduled cue or violates minimum quiet gap
    const overlaps = cues.some(
      existing =>
        Math.max(startMs, existing.startMs) < Math.min(endMs, existing.endMs) + minGapMs
    );
    if (overlaps) continue;

    cues.push({
      id: `callout:${segment.id}`,
      segmentId: segment.id,
      text,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      factIds: [...segment.factIds],
      anchor: "mascot-head",
    });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** The cue on screen at `timeMs`, or `null`. Cues never overlap. */
export function calloutCueAt(
  cues: CalloutCue[],
  timeMs: number
): CalloutCue | null {
  for (const cue of cues) {
    if (timeMs >= cue.startMs && timeMs < cue.endMs) return cue;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Temporal state                                                      */
/* ------------------------------------------------------------------ */

/**
 * Deterministic visual state of a callout at `timeMs`.
 *
 * Enter: 200 ms, ease-out — rise 12 px, scale 0.96 → 1, opacity 0 → 1.
 * Rays:  140 ms, ease-out — fade in once, then hold still.
 * Exit:  180 ms, ease-in  — opacity 1 → 0, rise 6 px, scale → 0.99.
 */
export function calloutStateAt(
  cue: CalloutCue | null,
  timeMs: number
): CalloutState {
  const hidden: CalloutState = {
    cueId: cue?.id ?? null,
    visible: false,
    text: cue?.text ?? "",
    opacity: 0,
    translateY: 0,
    scale: 1,
    raysOpacity: 0,
  };
  if (!cue) return hidden;
  if (timeMs < cue.startMs || timeMs >= cue.endMs) return hidden;

  const inU = clamp01((timeMs - cue.startMs) / CALLOUT.enterMs);
  const outU = clamp01(
    (timeMs - (cue.endMs - CALLOUT.exitMs)) / CALLOUT.exitMs
  );
  const inProgress = easeOutCubic(inU);
  const outProgress = easeInCubic(outU);
  const opacity = inProgress * (1 - outProgress);

  return {
    cueId: cue.id,
    visible: opacity > 0.001,
    text: cue.text,
    opacity: round3(opacity),
    translateY: round2(
      CALLOUT.enterYPx * (1 - inProgress) - CALLOUT.exitYPx * outProgress
    ),
    scale: round4(
      CALLOUT.enterScale +
        (1 - CALLOUT.enterScale) * inProgress -
        CALLOUT.exitScale * outProgress
    ),
    raysOpacity: round3(
      easeOutCubic(clamp01((timeMs - cue.startMs) / CALLOUT.rayMs)) *
        (1 - outProgress)
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Spatial layout                                                      */
/* ------------------------------------------------------------------ */

/**
 * Place the bubble from the mascot's measured head anchor.
 *
 * The body stays inside the canvas (right margin) while the tail is allowed to
 * point at the face. The result is a pure function of the head anchor and the
 * authored bounds.
 */
export function placeCallout(
  head: CalloutHeadAnchor,
  config: CalloutLayoutConfig = CALLOUT
): CalloutLayout {
  const left = clamp(
    head.faceCenterX + config.faceOffsetPx - config.tailXLocalPx,
    config.leftMinPx,
    VIEWPORT.width - config.rightMarginPx - config.bubbleWidthPx
  );
  const top = clamp(
    head.headTopY - config.topOffsetPx,
    config.topMinPx,
    config.topMaxPx
  );
  return {
    left: round2(left),
    top: round2(top),
    width: config.bubbleWidthPx,
    height: config.bubbleHeightPx,
    tailTipX: round2(left + config.tailXLocalPx),
    tailTipY: round2(top + config.bubbleHeightPx - config.tailInsetPx),
  };
}

/* ------------------------------------------------------------------ */
/* Fixed SVG geometry                                                  */
/* ------------------------------------------------------------------ */

/**
 * The white cloud with its integrated tail, authored in a 360x285 box.
 * The outline never morphs: only the wrapper's opacity/transform animate.
 */
export const CALLOUT_PATH = [
  "M 28 100",
  "C 16 76 34 48 60 40",
  "C 74 16 108 12 123 27",
  "C 138 6 176 6 188 22",
  "C 206 10 236 18 244 36",
  "C 274 28 302 46 300 70",
  "C 322 82 322 112 306 124",
  "C 316 146 300 168 280 172",
  "C 272 190 248 200 228 192",
  "L 120 192",
  "L 82 258",
  "L 58 192",
  "C 38 196 22 180 22 158",
  "C 4 148 2 120 20 110",
  "C 18 104 20 100 28 100",
  "Z",
].join(" ");

/** Three short accent rays, drawn separately from the bubble contour. */
export const CALLOUT_RAY_PATHS = [
  "M 18 82 L 34 66",
  "M 44 58 L 54 38",
  "M 14 52 L 12 30",
] as const;
