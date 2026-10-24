import type { CaptionPhrase } from "./types.js";

/** Word-level timing estimate inside a measured phrase window. */
export type CaptionWordTiming = {
  text: string;
  startMs: number;
  endMs: number;
};

/**
 * Caption presentation.
 *
 * Captions are real DOM inside the stationary card, floating over the page. This
 * module owns the visual tokens and the wrapping/highlight rules; `card.ts`
 * turns the result into elements.
 *
 * Design rules enforced here:
 *  - no filled background box behind every word;
 *  - at most two lines and never a dropped word;
 *  - only the words a segment marked as `emphasis` receive the highlight;
 *  - highlights are matched whole-word, so partial matches never fire.
 */

export type CaptionStyle = {
  fontFamily: string;
  monoFamily: string;
  fontSizePx: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacingPx: number;
  color: string;
  highlightColor: string;
  textShadow: string;
  textStroke: string;
  maxLines: number;
  maxCharsPerLine: number;
  transform: "none" | "uppercase";
  paddingPx: number;
};

/**
 * Caption motion (Visual Composition Pass).
 *
 * The caption group enters fast and settles naturally, and leaves quickly.
 * Values are applied per frame from the measured audio timeline, so the same
 * timestamp always renders the same visual state — there is no CSS
 * transition, no accumulated state and no dependence on frame order.
 *
 * The active-word colour ramp never *delays* the highlight: the word takes
 * over at its measured start time and only the colour blends during the
 * first ~90 ms.
 */
export const CAPTION_MOTION = {
  /** Group entrance: 160 ms, opacity 0→1, translateY 12→0, scale 0.98→1.0. */
  enterMs: 160,
  enterYPx: 12,
  enterScale: 0.98,
  /** Group exit: 120 ms, opacity 1→0, translateY 0→-6. */
  exitMs: 120,
  exitYPx: 6,
  exitScale: 0.02,
  /** Moving highlight interpolation window (60–80 ms). */
  activeWordMs: 70,
} as const;

/**
 * Moving-highlight colours. Authored live in `tools/preview-live.html` and
 * saved back through `tools/config-writer.ts`. Both the highlight box and the
 * colour ramp on the active word read these, so the two can never drift apart.
 */
const CAPTION_HIGHLIGHT_BG =
  process.env.SHOWCASE_CAPTION_HIGHLIGHT_BG ?? "#FF2600";
const CAPTION_HIGHLIGHT_TEXT =
  process.env.SHOWCASE_CAPTION_HIGHLIGHT_TEXT ?? "#FFFFFF";

export const CAPTION_STYLE: CaptionStyle = {
  fontFamily:
    "'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  monoFamily:
    "'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace",
  fontSizePx: 50,
  fontWeight: 900,
  lineHeight: 1.11,
  letterSpacingPx: -1.3,
  color: "#F8F6EF",
  highlightColor: CAPTION_HIGHLIGHT_BG,
  textShadow: "0 3px 10px rgba(0,0,0,0.95)",
  textStroke: "0",
  maxLines: 2,
  maxCharsPerLine: 22,
  transform: "none",
  paddingPx: 8,
};

/** Moving highlight behind the active word. Colors/geometry are env-overridable. */
export const CAPTION_HIGHLIGHT = {
  background: CAPTION_HIGHLIGHT_BG,
  text: CAPTION_HIGHLIGHT_TEXT,
  radiusPx: 9,
  padXPx: 9,
  padYPx: 4,
} as const;

const CLAUSE_BREAK = /[,;:—–]$/;

/**
 * Break a caption phrase into at most two lines at a natural boundary.
 *
 * No word is ever dropped: if the phrase genuinely needs more room, the last
 * line is allowed to run slightly long rather than losing information. The
 * phrase splitter keeps phrases short enough that this is rare.
 */
export function wrapCaptionText(
  text: string,
  maxLines = CAPTION_STYLE.maxLines,
  maxCharsPerLine = CAPTION_STYLE.maxCharsPerLine
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  if (maxLines <= 1 || words.join(" ").length <= maxCharsPerLine) {
    return [words.join(" ")];
  }

  // Choose the break point that balances the two lines while preferring a
  // clause boundary. This is a tiny exhaustive search, not a heuristic that
  // silently truncates.
  let bestIndex = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ");
    const right = words.slice(index).join(" ");
    const overflow = Math.max(0, left.length - maxCharsPerLine) +
      Math.max(0, right.length - maxCharsPerLine);
    const balance = Math.abs(left.length - right.length);
    const clauseBonus = CLAUSE_BREAK.test(words[index - 1]) ? 18 : 0;
    const cost = overflow * 100 + balance - clauseBonus;
    if (cost < bestCost) {
      bestCost = cost;
      bestIndex = index;
    }
  }

  if (bestIndex < 0) return [words.join(" ")];
  const lines = [
    words.slice(0, bestIndex).join(" "),
    words.slice(bestIndex).join(" "),
  ];

  // More than two lines requested is not supported by the design.
  return lines.slice(0, Math.max(1, maxLines));
}

function estimateWordWeight(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z0-9+#]/g, "");
  const syllableEstimate = Math.max(1, Math.round(clean.length / 2.6));
  const punctuationPause = /[,.!?;:]$/.test(word) ? 120 : 0;
  return Math.max(1, syllableEstimate * 10 + punctuationPause);
}

/**
 * Word-level timing inside a measured phrase window.
 *
 * The renderer calls this on the fly so captions do not need to store per-word
 * timings. Reuse the same weighting family the caption engine already uses:
 * a longer/syllable-heavier word holds the screen longer and a terminal
 * punctuation word gets a small extra beat, so the highlight is proportional
 * rather than delegated to equal division.
 */
export function wordTimings(phrase: CaptionPhrase): CaptionWordTiming[] {
  const words = phrase.text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const span = Math.max(1, phrase.endMs - phrase.startMs);
  const weights = words.map(estimateWordWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const timings: CaptionWordTiming[] = [];
  let cursor = phrase.startMs;
  for (let index = 0; index < words.length; index += 1) {
    const startMs = Math.round(cursor);
    const endMs = index === words.length - 1
      ? Math.max(startMs + 60, phrase.endMs)
      : Math.round(cursor + (weights[index] / total) * span);
    timings.push({ text: words[index], startMs, endMs });
    cursor = endMs;
  }
  return timings;
}

/** The word that should be highlighted at a given time, or `null`. */
export function activeWordAt(phrase: CaptionPhrase, timeMs: number): string | null {
  const timing = wordTimings(phrase).find(
    timing => timeMs >= timing.startMs && timeMs < timing.endMs
  );
  return timing ? timing.text : null;
}

/** HTML escape for text or attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type CaptionLayer = {
  start: number;
  end: number;
  file: string;
};

/** Split a phrase into `{ text, highlighted }` runs for rendering. */
export function captionRuns(
  phrase: CaptionPhrase
): { text: string; highlighted: boolean }[] {
  const lines = wrapCaptionText(phrase.text);
  const runs: { text: string; highlighted: boolean }[] = [];
  const highlightSet = new Set(phrase.highlights.map(word => word.toLowerCase()));

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) runs.push({ text: "\n", highlighted: false });
    for (const [wordIndex, word] of line.split(/\s+/).filter(Boolean).entries()) {
      if (wordIndex > 0) runs.push({ text: " ", highlighted: false });
      const clean = word.replace(/[^\w.+#-]/g, "");
      runs.push({
        text: word,
        highlighted: highlightSet.has(clean.toLowerCase()),
      });
    }
  });

  return runs;
}

/**
 * HTML for one caption phrase. The card renderer injects this; the highlight
 * is a colour change only — never a filled box.
 *
 * `activeWord` marks the word currently being spoken; `activeWordColor` lets
 * the caller supply a blended colour for that word's short ramp-in
 * (`activeWordStateAt`). A `null` colour falls back to the plain yellow.
 */
export function captionHtml(
  phrase: CaptionPhrase,
  activeWord?: string | null,
  activeWordColor?: string | null
): string {
  const text =
    CAPTION_STYLE.transform === "uppercase" ? phrase.text.toUpperCase() : phrase.text;
  const highlightSet = new Set(phrase.highlights.map(word => word.toLowerCase()));
  const active = activeWord
    ? phrase.text
        .split(/\s+/)
        .filter(Boolean)
        .some(word => word.toLowerCase() === activeWord.toLowerCase())
      ? activeWord
      : null
    : null;
  const lines = wrapCaptionText(text);

  let wordIndex = 0;
  return lines
    .map(line => {
      const runs = line
        .split(/\s+/)
        .filter(Boolean)
        .map(word => {
          const clean = word.replace(/[^\w.+#-]/g, "");
          const isActive = word && active?.toLowerCase() === word.toLowerCase();
          const highlighted = highlightSet.has(clean.toLowerCase()) || isActive;
          const cls = highlighted ? "w active" : "w";
          const colorStyle = isActive
            ? ` style="color:${CAPTION_HIGHLIGHT.text}"`
            : "";
          const idx = wordIndex++;
          return `<span class="${cls}" data-i="${idx}"${colorStyle}>${escapeHtml(word)}</span>`;
        })
        .join(" ");
      return `<div class="caption-line">${runs}</div>`;
    })
    .join("");
}

/** The caption that should be on screen at a given time, or `null`. */
export function captionAt(
  captions: CaptionPhrase[],
  timeMs: number
): CaptionPhrase | null {
  for (const caption of captions) {
    if (timeMs >= caption.startMs && timeMs < caption.endMs) return caption;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Caption motion (Visual Composition Pass)                            */
/* ------------------------------------------------------------------ */

/** Linear interpolation between two hex colours, clamped to [0,1]. */
export function blendHex(from: string, to: string, t: number): string {
  const parse = (value: string): [number, number, number] => [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
  const clamped = Math.max(0, Math.min(1, t));
  const a = parse(from);
  const b = parse(to);
  const mixed = a.map((channel, index) =>
    Math.round(channel + (b[index] - channel) * clamped)
  );
  return "#" + mixed.map(channel => channel.toString(16).padStart(2, "0")).join("");
}

function easeOutCubic(u: number): number {
  const clamped = Math.max(0, Math.min(1, u));
  return 1 - Math.pow(1 - clamped, 3);
}

function easeInCubic(u: number): number {
  const clamped = Math.max(0, Math.min(1, u));
  return clamped * clamped * clamped;
}

export type CaptionGroupStyle = {
  opacity: number;
  translateY: number;
  scale: number;
};

/**
 * Deterministic group entrance/exit for one caption phrase at `timeMs`.
 *
 * In:   190 ms ease-out — rises 16 px, fades in, scales 0.97 → 1.
 * Out:  last 130 ms ease-in — sinks 8 px, fades out, scale eases back.
 * Between the two the group is perfectly stable while the same phrase stays
 * on screen (words do not re-trigger the entrance).
 */
export function captionGroupStyleAt(
  phrase: CaptionPhrase,
  timeMs: number
): CaptionGroupStyle {
  const elapsed = timeMs - phrase.startMs;
  const remaining = phrase.endMs - timeMs;
  if (elapsed <= 0 || remaining <= 0) {
    // Outside the phrase the caption is not shown at all; the values are
    // still total and deterministic for callers that ask anyway.
    return { opacity: 0, translateY: 0, scale: 1 };
  }

  const enterProgress = easeOutCubic(Math.min(1, elapsed / CAPTION_MOTION.enterMs));
  const exitProgress = easeInCubic(
    Math.max(0, 1 - remaining / CAPTION_MOTION.exitMs)
  );

  const opacity = enterProgress * (1 - exitProgress);
  const translateY =
    CAPTION_MOTION.enterYPx * (1 - enterProgress) -
    CAPTION_MOTION.exitYPx * exitProgress;
  const scale =
    CAPTION_MOTION.enterScale +
    (1 - CAPTION_MOTION.enterScale) * enterProgress -
    CAPTION_MOTION.exitScale * exitProgress;

  return {
    opacity: Math.round(opacity * 1000) / 1000,
    translateY: Math.round(translateY * 100) / 100,
    scale: Math.round(scale * 10000) / 10000,
  };
}

export type ActiveWordState = {
  text: string;
  /** Colour of the active word at this instant (blended, no CSS transition). */
  color: string;
};

/**
 * The active word plus its blended colour at `timeMs`.
 *
 * The highlight takes over at the word's *measured* start time — the ramp
 * only blends from the inactive colour to the yellow within the first
 * `CAPTION_MOTION.activeWordMs` (which lands inside the 70–120 ms spec), so
 * the highlight never lags behind the audio.
 */
export function activeWordStateAt(
  phrase: CaptionPhrase,
  timeMs: number,
  activeWord: string | null
): ActiveWordState | null {
  if (!activeWord) return null;
  const timing = wordTimings(phrase).find(
    entry => entry.text.toLowerCase() === activeWord.toLowerCase()
  );
  if (!timing) return { text: activeWord, color: CAPTION_STYLE.highlightColor };
  const elapsed = timeMs - timing.startMs;
  const t = easeOutCubic(Math.min(1, elapsed / CAPTION_MOTION.activeWordMs));
  return {
    text: activeWord,
    color: blendHex(CAPTION_STYLE.color, CAPTION_STYLE.highlightColor, t),
  };
}

/**
 * Complete per-frame caption markup: the animated group wrapper plus the
 * phrase HTML (with the active individual word, colour-ramped inline).
 *
 * `browser-capture.ts` injects this once per frame. Everything is derived
 * from the shared audio timeline; rendering the same frame twice produces
 * byte-identical markup.
 */
export function captionFrameHtml(
  phrase: CaptionPhrase | null,
  timeMs: number
): string {
  if (!phrase) return "";
  const group = captionGroupStyleAt(phrase, timeMs);
  const inner = captionHtml(phrase, activeWordAt(phrase, timeMs), null);
  const style = `opacity:${group.opacity};transform:translate3d(0,${group.translateY}px,0) scale(${group.scale})`;
  return `<div class="caption-group" style="${style}"><div class="caption-highlight" id="caption-hl"></div>${inner}</div>`;
}
