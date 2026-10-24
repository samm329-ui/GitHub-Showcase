import {
  CAPTION_PANEL_STYLE,
  captionOverlayGeometry,
} from "./config.js";
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
 * Captions are real DOM inside the stationary card, floating over the page.
 * This module owns the visual tokens, the wrapping/highlight rules and the
 * per-frame HTML; `card.ts` turns the result into elements.
 *
 * Two independent layers, never one rectangle:
 *  - the dark `.caption-panel` holds the current phrase steady;
 *  - the moving accent pill (`CAPTION_HIGHLIGHT`) sits behind exactly one word —
 *    the word actually spoken at this instant.
 *
 * Design rules enforced here:
 *  - no filled background behind individual words;
 *  - at most two lines and never a dropped word;
 *  - one `.current` word, full stop; persistent `emphasis` is a separate class;
 *  - highlights are matched whole-word, so partial matches never fire.
 */

export type CaptionStyle = {
  fontFamily: string;
  monoFamily: string;
  fontSizePx: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacingPx: number;
  /** Inactive (spoken phrase) text on the dark panel. */
  color: string;
  /** Accent pill colour; the same value as `CAPTION_HIGHLIGHT.background`. */
  highlightColor: string;
  /** Text colour while the word sits on the accent pill. */
  activeTextColor: string;
  /** Persistent semantic emphasis (marketing words, not the karaoke pill). */
  emphasisColor: string;
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
 * active-word text read these, so the two can never drift apart.
 *
 * The defaults are the canonical lemon-yellow / near-black pair from
 * `config.ts` (`ACCENT_YELLOW` / `INK`); `tests/caption-motion.test.ts` asserts
 * that they stay identical to the exported tokens.
 */
const CAPTION_HIGHLIGHT_BG =
  process.env.SHOWCASE_CAPTION_HIGHLIGHT_BG ?? "#FFE66D";
const CAPTION_HIGHLIGHT_TEXT =
  process.env.SHOWCASE_CAPTION_HIGHLIGHT_TEXT ?? "#151619";

export const CAPTION_STYLE: CaptionStyle = {
  fontFamily:
    "'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  monoFamily:
    "'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace",
  fontSizePx: 50,
  fontWeight: 900,
  lineHeight: 1.08,
  letterSpacingPx: -1.3,
  color: "#F8F6EF",
  highlightColor: CAPTION_HIGHLIGHT_BG,
  activeTextColor: CAPTION_HIGHLIGHT_TEXT,
  emphasisColor: CAPTION_HIGHLIGHT_BG,
  textShadow: "0 3px 10px rgba(0,0,0,0.95)",
  textStroke: "0",
  maxLines: CAPTION_PANEL_STYLE.maxLines,
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
 * No word is ever dropped: the splitter chooses one break point, so every word
 * survives even when a phrase is long. The phrase splitter keeps phrases short
 * enough that a third rendered line is rare; `captionLineEstimate()` reports
 * when it still happens instead of silently clipping.
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
  return [
    words.slice(0, bestIndex).join(" "),
    words.slice(bestIndex).join(" "),
  ].slice(0, Math.max(1, maxLines));
}

/** Usable text width inside the dark panel, in canvas px. */
function panelTextWidthPx(): number {
  const geometry = captionOverlayGeometry();
  // 1px border on each side, then the panel's horizontal padding.
  return Math.max(
    120,
    geometry.widthPx - CAPTION_PANEL_STYLE.padXPx * 2 - 2
  );
}

function estimateWordWidthPx(word: string): number {
  // Bold Inter averages a little over half an em per glyph; letter spacing is
  // negative in the approved style. This is only used to warn about overflow.
  return (
    word.length * CAPTION_STYLE.fontSizePx * 0.56 +
    word.length * CAPTION_STYLE.letterSpacingPx
  );
}

/**
 * Greedy estimate of rendered line count inside the panel.
 *
 * The browser does the real wrapping; this exists so a phrase that would need
 * a third line produces a structured warning in the run log instead of being
 * silently clipped by the panel.
 */
export function captionLineEstimate(
  text: string,
  contentWidthPx = panelTextWidthPx()
): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const width = estimateWordWidthPx(word);
    const gap = current > 0 ? CAPTION_STYLE.fontSizePx * 0.26 : 0;
    if (current > 0 && current + gap + width > contentWidthPx) {
      lines += 1;
      current = width;
    } else {
      current += gap + width;
    }
  }
  return lines;
}

/** True when the phrase fits the two-line panel without clipping. */
export function captionFitsPanel(text: string): boolean {
  return captionLineEstimate(text) <= CAPTION_PANEL_STYLE.maxLines;
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
 * timings. A longer/syllable-heavier word holds the screen longer and a
 * terminal punctuation word gets a small extra beat, so the pill is
 * proportional rather than delegated to equal division. This is an estimate
 * inside a measured phrase — not phoneme-level forced alignment.
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

/** Index of the word spoken at `timeMs`, or `-1`. */
export function activeWordIndexAt(
  phrase: CaptionPhrase,
  timeMs: number
): number {
  const timings = wordTimings(phrase);
  for (let index = 0; index < timings.length; index += 1) {
    if (timeMs >= timings[index].startMs && timeMs < timings[index].endMs) {
      return index;
    }
  }
  return -1;
}

/** The word that should be highlighted at a given time, or `null`. */
export function activeWordAt(phrase: CaptionPhrase, timeMs: number): string | null {
  const index = activeWordIndexAt(phrase, timeMs);
  return index >= 0 ? phrase.text.trim().split(/\s+/).filter(Boolean)[index] : null;
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
      const clean = word.replace(/[^a-z0-9.+#-]/gi, "");
      runs.push({
        text: word,
        highlighted: highlightSet.has(clean.toLowerCase()),
      });
    }
  });

  return runs;
}

/** Resolve a legacy word-string argument to a word index. */
function resolveActiveIndex(
  phrase: CaptionPhrase,
  active: number | string | null | undefined
): number {
  if (typeof active === "number") return active;
  if (!active) return -1;
  const words = phrase.text.trim().split(/\s+/).filter(Boolean);
  return words.findIndex(
    word => word.toLowerCase() === active.toLowerCase()
  );
}

/**
 * HTML for one caption phrase.
 *
 * `.w.current` is the single word being spoken right now; `.w.key-emphasis` is
 * the segment's persistent semantic emphasis. They are deliberately separate:
 * only the current word sits on the accent pill, and emphasis never creates a
 * second active box. Each word is rendered exactly once.
 */
export function captionHtml(
  phrase: CaptionPhrase,
  active?: number | string | null
): string {
  const text =
    CAPTION_STYLE.transform === "uppercase" ? phrase.text.toUpperCase() : phrase.text;
  const highlightSet = new Set(phrase.highlights.map(word => word.toLowerCase()));
  const currentIndex = resolveActiveIndex(phrase, active);
  const lines = wrapCaptionText(text);

  let wordIndex = 0;
  return lines
    .map(line => {
      const spans = line
        .split(/\s+/)
        .filter(Boolean)
        .map(word => {
          const clean = word.replace(/[^a-z0-9.+#-]/gi, "");
          const index = wordIndex++;
          const isCurrent = index === currentIndex;
          const emphasised = !isCurrent && highlightSet.has(clean.toLowerCase());
          const cls = isCurrent
            ? "w current"
            : emphasised
              ? "w key-emphasis"
              : "w";
          return `<span class="${cls}" data-i="${index}">${escapeHtml(word)}</span>`;
        })
        .join(" ");
      return `<div class="caption-line">${spans}</div>`;
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
 * In:  160 ms ease-out — rises 12 px, fades in, scales 0.98 → 1.
 * Out: last 120 ms ease-in — sinks 6 px, fades out, scale eases back.
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
 * The active word plus its blended text colour at `timeMs`.
 *
 * The highlight takes over at the word's *measured* start time — the ramp only
 * blends from the panel's inactive text colour to the near-black pill text
 * within the first `CAPTION_MOTION.activeWordMs`, so the glyphs are readable on
 * the accent pill from the first frame without lagging behind the audio.
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
  if (!timing) {
    return { text: activeWord, color: CAPTION_STYLE.activeTextColor };
  }
  const elapsed = timeMs - timing.startMs;
  const t = easeOutCubic(Math.min(1, elapsed / CAPTION_MOTION.activeWordMs));
  return {
    text: activeWord,
    color: blendHex(CAPTION_STYLE.color, CAPTION_STYLE.activeTextColor, t),
  };
}

/**
 * Complete per-frame caption markup: the dark panel, the moving pill and the
 * phrase HTML (with exactly one `.current` word).
 *
 * The panel is absent when no phrase is active, so the overlay never leaves an
 * empty black rectangle on screen. `browser-capture.ts` injects this once per
 * frame. Everything is derived from the shared audio timeline; rendering the
 * same frame twice produces byte-identical markup.
 */
export function captionFrameHtml(
  phrase: CaptionPhrase | null,
  timeMs: number
): string {
  if (!phrase) return "";
  const group = captionGroupStyleAt(phrase, timeMs);
  const inner = captionHtml(phrase, activeWordIndexAt(phrase, timeMs));
  const style = `opacity:${group.opacity};transform:translate3d(0,${group.translateY}px,0) scale(${group.scale})`;
  return (
    `<div class="caption-group" style="${style}">` +
    `<div class="caption-panel">` +
    `<div class="caption-highlight" id="caption-hl"></div>` +
    `<div class="caption-lines">${inner}</div>` +
    `</div></div>`
  );
}
