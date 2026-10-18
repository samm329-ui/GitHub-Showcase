import type { CaptionPhrase } from "./types.js";

/**
 * Caption presentation.
 *
 * Captions are real DOM inside the stationary card, not one PNG per word.
 * This module owns the visual tokens and the wrapping/highlight rules; the
 * card renderer (`card.ts`) turns the result into elements.
 *
 * Design rules enforced here:
 *  - no filled background box behind every word;
 *  - at most `maxLines` lines, broken at a natural phrase boundary;
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
  maxWidthRatio: number;
  bottomInsetPx: number;
  maxLines: number;
  maxCharsPerLine: number;
  transform: string;
  paddingPx: number;
};

export const CAPTION_STYLE: CaptionStyle = {
  fontFamily:
    "'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  monoFamily:
    "'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace",
  fontSizePx: 34,
  fontWeight: 800,
  lineHeight: 1.12,
  letterSpacingPx: -0.5,
  color: "#FFFFFF",
  highlightColor: "#FFD629",
  textShadow: "0 2px 5px rgba(0,0,0,.8), 0 0 18px rgba(0,0,0,.45)",
  maxWidthRatio: 0.92,
  bottomInsetPx: 60,
  maxLines: 2,
  maxCharsPerLine: 30,
  transform: "uppercase",
  paddingPx: 8,
};

const CLAUSE_BREAK = /[,;:—–]$/;

/**
 * Break a caption phrase into at most `maxLines` lines at a natural boundary.
 *
 * The character budget is widened when necessary so the text is never dropped:
 * losing the tail of a caption is worse than a slightly longer line.
 */
export function wrapCaptionText(
  text: string,
  maxLines = CAPTION_STYLE.maxLines,
  maxCharsPerLine = CAPTION_STYLE.maxCharsPerLine
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const totalChars = words.join(" ").length;
  const limit = Math.max(maxCharsPerLine, Math.ceil(totalChars / maxLines));

  const lines: string[] = [];
  let current: string[] = [];

  for (const [index, word] of words.entries()) {
    const candidate = [...current, word];
    const remaining = words.length - index - 1;

    if (current.length > 0 && candidate.join(" ").length > limit) {
      lines.push(current.join(" "));
      current = [word];
      continue;
    }
    current = candidate;

    // Prefer to break after a clause, as long as more text follows.
    if (
      current.length >= 3 &&
      CLAUSE_BREAK.test(word) &&
      remaining > 0 &&
      lines.length < maxLines - 1
    ) {
      lines.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) lines.push(current.join(" "));

  return lines.slice(0, maxLines);
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
    if (lineIndex > 0) runs.push({ text: " ", highlighted: false });
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
  const text = CAPTION_STYLE.transform === "uppercase" ? phrase.text.toUpperCase() : phrase.text;
  const runs = captionRuns(phrase).map(run =>
    run.highlighted
      ? `<span class="hl">${escapeHtml(run.text)}</span>`
      : escapeHtml(run.text)
  );
  return `<div class="caption-line">${runs.join("")}</div>`;
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