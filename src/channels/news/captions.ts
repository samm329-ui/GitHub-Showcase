import type { AlignedWord } from "./types.js";
import type { CaptionPhrase, CaptionWordTiming } from "../../types.js";
import type { EpisodeScript } from "./types.js";

/**
 * News captions — built from FORCED-ALIGNMENT word timings, never from
 * syllable estimates. Phrase boundaries split at strong clause punctuation;
 * highlights come from the set of segment callouts that reference the word.
 */

const STRONG_CLAUSE = /[.!?]["'\)\]]?$/;

export function captionsFromAlignment(
  script: EpisodeScript,
  words: AlignedWord[],
  segments: { id: string; startMs: number; endMs: number }[]
): CaptionPhrase[] {
  const calloutsFor = new Map<string, string[]>();
  for (const callout of script.callouts) {
    const list = calloutsFor.get(callout.triggerNarrationId) ?? [];
    calloutsFor.set(callout.triggerNarrationId, list.concat(callout.highlightWords));
  }

  const phrases: CaptionPhrase[] = [];
  let index = 0;
  for (const seg of script.narration) {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const timeline = segments.find(s => s.id === seg.id);
    const startMs = timeline?.startMs ?? 0;
    const endMs = timeline?.endMs ?? startMs + tokens.length * 250;
    const segWords = words.filter(w => w.segmentId === seg.id && w.startMs >= startMs - 1 && w.startMs <= endMs + 1);
    if (segWords.length === 0) continue;

    const wantHighlights = (calloutsFor.get(seg.id) ?? []).map(h => h.toLowerCase());
    let startIdx = 0;
    for (let i = 0; i <= tokens.length; i += 1) {
      const atEnd = i === tokens.length;
      const boundary = atEnd || STRONG_CLAUSE.test(tokens[i - 1] ?? "");
      if (!boundary) continue;
      const slice = tokens.slice(startIdx, i);
      if (slice.length === 0) { startIdx = i; continue; }
      const first = segWords[Math.min(startIdx, segWords.length - 1)];
      const last = segWords[Math.min(i - 1, segWords.length - 1)];
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const hits = slice.filter(w => wantHighlights.some(h => norm(h) && (norm(w).includes(norm(h)) || norm(h).includes(norm(w)))));
      phrases.push({
        index: index++,
        startMs: first.startMs,
        endMs: Math.max(last.endMs, first.startMs + 600),
        text: cleanCaption(slice.join(" ")),
        highlights: hits.slice(0, 3),
        segmentId: seg.id,
        wordTimings: slice.map((w, k) => ({
          text: w,
          startMs: segWords[Math.min(startIdx + k, segWords.length - 1)]?.startMs ?? first.startMs,
          endMs: segWords[Math.min(startIdx + k, segWords.length - 1)]?.endMs ?? last.endMs,
        })),
      });
      startIdx = i;
    }
  }
  return phrases;
}

function cleanCaption(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
