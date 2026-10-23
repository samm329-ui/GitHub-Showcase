import type { CaptionPhrase } from "./types.js";
import { CAPTION_OVERLAY } from "./config.js";

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
  maxWidthRatio: number;
  topRatio: number;
  maxLines: number;
  maxCharsPerLine: number;
  transform: "none" | "uppercase";
  paddingPx: number;
};

export const CAPTION_STYLE: CaptionStyle = {
  fontFamily:
    "'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  monoFamily:
    "'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace",
  fontSizePx: 42,
  fontWeight: 800,
  lineHeight: 1.12,
  letterSpacingPx: -0.6,
  color: "#FFFFFF",
  highlightColor: "#FFD629",
  textShadow: "0 2px 2px #000, 0 4px 12px rgba(0,0,0,0.95)",
  textStroke: "0.5px rgba(0,0,0,0.65)",
  maxWidthRatio: CAPTION_OVERLAY.maxWidthRatio,
  topRatio: CAPTION_OVERLAY.topRatio,
  maxLines: 2,
  maxCharsPerLine: 27,
  transform: "none",
  paddingPx: 8,
};

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
 */
export function captionHtml(phrase: CaptionPhrase): string {
  const text =
    CAPTION_STYLE.transform === "uppercase" ? phrase.text.toUpperCase() : phrase.text;
  const highlightSet = new Set(phrase.highlights.map(word => word.toLowerCase()));
  const lines = wrapCaptionText(text);

  return lines
    .map(line => {
      const runs = line
        .split(/\s+/)
        .filter(Boolean)
        .map(word => {
          const clean = word.replace(/[^\w.+#-]/g, "");
          const highlighted = highlightSet.has(clean.toLowerCase());
          return highlighted
            ? `<span class="hl">${escapeHtml(word)}</span>`
            : escapeHtml(word);
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
