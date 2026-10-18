import type {
  AudioChunk,
  CaptionPhrase,
  MeasuredAnchor,
  NarrationSegment,
  ScrollKeyframe,
  VisualAnchor,
} from "./types.js";

/**
 * Caption and scroll timeline.
 *
 * Timing is derived from **measured** audio: each narration segment was
 * synthesized on its own and probed, so we know its real start and end. Inside
 * a segment, phrase boundaries come from the caption text itself, and phrase
 * durations are allocated by syllable/character weight plus explicit punctuation
 * pauses.
 *
 * The installed Kokoro model exposes no duration predictor, so `create_timed`
 * returns zero phoneme timings. When `usePhonemeTimings` is true the caller has
 * real phoneme timings available and they take priority; otherwise this is the
 * documented fallback.
 */

const SENTENCE_PAUSE_MS = 220;
const CLAUSE_PAUSE_MS = 110;
const MIN_PHRASE_MS = 420;
const MAX_PHRASES_PER_SEGMENT = 6;
/** Shortest scroll transition. */
const MIN_MOVE_MS = 340;
/** How long before a section's narration begins the scroll must arrive. */
const SETTLE_MS = 200;

/* ------------------------------------------------------------------ */
/* Phrase splitting                                                    */
/* ------------------------------------------------------------------ */

/** Split into readable phrases of 4-8 words at natural boundaries. */
export function splitPhrases(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const phrases: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    const endsSentence = /[.!?]["')\]]?$/.test(word);
    const endsClause = /[,;:—]["')\]]?$/.test(word);
    const longEnough = current.length >= 6;
    if (endsSentence || (longEnough && (endsClause || current.length >= 8))) {
      phrases.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) phrases.push(current.join(" "));

  // Fold away very short trailing fragments.
  const merged: string[] = [];
  for (const phrase of phrases) {
    const prev = merged[merged.length - 1];
    if (prev && prev.split(/\s+/).length <= 3) {
      merged[merged.length - 1] = `${prev} ${phrase}`;
    } else {
      merged.push(phrase);
    }
  }
  return merged;
}

/** Weight a phrase by syllable estimate plus punctuation pauses. */
export function phraseWeight(phrase: string): number {
  const trimmed = phrase.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const base = words.reduce((sum, word) => sum + syllableCount(word), 0);
  const punctuationPauses = (trimmed.match(/[,;:]/g)?.length ?? 0) * CLAUSE_PAUSE_MS * 3;
  const terminalPause = /[.!?]$/.test(trimmed) ? SENTENCE_PAUSE_MS * 2 : 0;
  return Math.max(1, base * 12 + punctuationPauses + terminalPause);
}

export function syllableCount(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return 1;
  if (clean.length <= 3) return 1;
  const groups = clean
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "")
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/* ------------------------------------------------------------------ */
/* Caption timeline                                                    */
/* ------------------------------------------------------------------ */

export type BuildCaptionsOptions = {
  /** Phrase-level alignment data, when the engine reported real timings. */
  phonemeTimings?: { segmentId: string; phrases: { text: string; startMs: number; endMs: number }[] }[] | null;
};

export function buildCaptions(
  segments: NarrationSegment[],
  chunks: AudioChunk[],
  options: BuildCaptionsOptions = {}
): CaptionPhrase[] {
  const bySegment = new Map(chunks.map(chunk => [chunk.segmentId, chunk]));
  const phonemeBySegment = new Map(
    (options.phonemeTimings ?? []).map(entry => [entry.segmentId, entry.phrases])
  );

  const captions: CaptionPhrase[] = [];
  let index = 0;

  for (const segment of segments) {
    const chunk = bySegment.get(segment.id);
    if (!chunk) continue;

    const display = segment.captionText.trim();
    const phrases = splitPhrases(display);
    if (phrases.length === 0) continue;

    const aligned = phonemeBySegment.get(segment.id);
    if (aligned && aligned.length === phrases.length) {
      for (const [position, phrase] of phrases.entries()) {
        const timing = aligned[position];
        captions.push({
          index: index++,
          startMs: Math.round(chunk.startMs + timing.startMs),
          endMs: Math.round(chunk.startMs + timing.endMs),
          text: phrase,
          highlights: highlightsFor(phrase, segment.emphasis),
          segmentId: segment.id,
        });
      }
      continue;
    }

    // Fallback: distribute the measured chunk duration by phrase weight.
    const weights = phrases.map(phraseWeight);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    const available = chunk.endMs - chunk.startMs;

    // Compress to at most MAX_PHRASES_PER_SEGMENT by re-joining.
    const grouped = groupPhrases(phrases, MAX_PHRASES_PER_SEGMENT);

    let cursor = chunk.startMs;
    for (const [position, group] of grouped.entries()) {
      const weight = group
        .map(item => phraseWeight(item))
        .reduce((sum, value) => sum + value, 0);
      let span = (weight / totalWeight) * available;
      if (position === grouped.length - 1) span = chunk.endMs - cursor;
      const groupStart = cursor;
      const end = Math.min(chunk.endMs, groupStart + Math.max(MIN_PHRASE_MS, span));
      let phraseStart = groupStart;
      for (const phrase of group) {
        const share = (phraseWeight(phrase) / (weight || 1)) * (end - groupStart);
        const duration = Math.max(220, share);
        captions.push({
          index: index++,
          startMs: Math.round(phraseStart),
          endMs: Math.round(Math.min(end, phraseStart + duration)),
          text: phrase,
          highlights: highlightsFor(phrase, segment.emphasis),
          segmentId: segment.id,
        });
        phraseStart += duration;
      }
      cursor = Math.min(chunk.endMs, end);
    }
  }

  return enforceMonotonic(captions);
}

/** Merge neighbouring phrases until at most `limit` remain. */
function groupPhrases(phrases: string[], limit: number): string[][] {
  if (phrases.length <= limit) return phrases.map(phrase => [phrase]);
  const groups: string[][] = [];
  const perGroup = Math.ceil(phrases.length / limit);
  for (let index = 0; index < phrases.length; index += perGroup) {
    groups.push(phrases.slice(index, index + perGroup));
  }
  return groups;
}

/**
 * Resolve emphasis tokens to the words that are actually displayed.
 *
 * Tokens are matched against word boundaries computed from the phrase itself,
 * so a single-word token never matches inside a longer word ("npm" cannot
 * light up "npmrc"), while a multi-word token highlights exactly the words it
 * covers.
 */
export function highlightsFor(phrase: string, emphasis?: string[]): string[] {
  if (!emphasis || emphasis.length === 0) return [];
  const tokens = emphasis
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2);
  if (tokens.length === 0) return [];

  // Word spans, measured in the original (non-lowercased) phrase. Trailing
  // punctuation is excluded so a match ending before "," still lines up.
  const spans: { word: string; start: number; end: number }[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(phrase)) !== null) {
    const token = match[0];
    const lead = token.length - token.replace(/^[^\w.+#]+/, "").length;
    const core = token.replace(/^[^\w.+#]+/, "").replace(/[^\w.+#]+$/, "");
    if (!core) continue;
    spans.push({
      word: core,
      start: match.index + lead,
      end: match.index + lead + core.length,
    });
  }

  const lower = phrase.toLowerCase();
  const spanStarts = new Set(spans.map(span => span.start));
  const spanEnds = new Set(spans.map(span => span.end));
  const found = new Set<string>();
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(token, from);
      if (index < 0) break;
      const end = index + token.length;
      // The match must line up with word boundaries, otherwise "npm" would
      // light up "npmrc".
      if (spanStarts.has(index) && spanEnds.has(end)) {
        for (const span of spans) {
          if (span.start < end && span.end > index && span.word) found.add(span.word);
        }
      }
      from = index + token.length;
    }
  }
  return [...found];
}

/** Guarantee non-overlapping, non-decreasing intervals. */
export function enforceMonotonic(captions: CaptionPhrase[]): CaptionPhrase[] {
  const sorted = [...captions].sort((a, b) => a.startMs - b.startMs);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (next && current.endMs > next.startMs) {
      current.endMs = Math.max(current.startMs + 120, next.startMs);
    }
    if (current.endMs <= current.startMs) current.endMs = current.startMs + 120;
  }
  return sorted.map((phrase, index) => ({ ...phrase, index }));
}

/* ------------------------------------------------------------------ */
/* Scroll keyframes                                                    */
/* ------------------------------------------------------------------ */

/* Cubic Bézier (0.25, 0.1, 0.25, 1.0) — an ease-in-out with a soft landing. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

export type ScrollPlanInput = {
  segments: NarrationSegment[];
  chunks: AudioChunk[];
  anchors: MeasuredAnchor[];
  documentHeight: number;
  viewportHeight: number;
  /** Extra padding so a section is not flush against the top edge. */
  padding?: number;
  /** Hold at the opening view before the first move. */
  introHoldMs?: number;
  /** Minimum time a section stays still once we arrive. */
  minHoldMs?: number;
  /** Maximum time a single move may take. */
  maxMoveMs?: number;
};

export function buildScrollKeyframes(input: ScrollPlanInput): ScrollKeyframe[] {
  const padding = input.padding ?? 48;
  const introHold = input.introHoldMs ?? 800;
  const minHold = input.minHoldMs ?? 900;
  const maxMove = input.maxMoveMs ?? 1100;

  const maxScroll = Math.max(0, input.documentHeight - input.viewportHeight);
  const byAnchor = new Map(input.anchors.map(anchor => [anchor.anchor, anchor]));

  const clamp = (value: number) => Math.min(maxScroll, Math.max(0, value));
  const targetFor = (anchor: VisualAnchor): number | null => {
    const measured = byAnchor.get(anchor);
    if (!measured) return null;
    return clamp(measured.offsetTop - padding);
  };

  const keys: ScrollKeyframe[] = [{ timeMs: 0, scrollY: 0, easing: "easeInOut", anchor: "repo-header" }];

  // Resolve each anchored segment to a target first, so we can tell how many
  // *distinct* stops the render actually contains.
  interface Move {
    anchor: VisualAnchor;
    segmentIndex: number;
    target: number;
  }

  // Anchored segments, in narration order.
  const anchored: { anchor: VisualAnchor; segmentIndex: number }[] = [];
  input.segments.forEach((segment, segmentIndex) => {
    if (segment.visualAnchor) {
      anchored.push({ anchor: segment.visualAnchor, segmentIndex });
    }
  });
  if (anchored.length === 0) return keys;

  // Resolve each anchored segment to a clamped target, dropping duplicates.
  const resolved: Move[] = [];
  const seen = new Set<number>();
  for (const entry of anchored) {
    const target = targetFor(entry.anchor);
    if (target === null || seen.has(target)) continue;
    seen.add(target);
    resolved.push({ anchor: entry.anchor, segmentIndex: entry.segmentIndex, target });
  }

  let moves = resolved;

  // A short document (or a script whose segments all point at the same place)
  // would collapse to one move and then hold still for the rest of the reel.
  // Subdivide the available range so the viewer still gets purposeful stops.
  const wouldMove = moves.filter(move => move.target > 0).length;
  if (resolved.length > 0 && wouldMove < 2 && maxScroll > 120) {
    const wanted = Math.min(4, anchored.length + 1);
    const spread: Move[] = [];
    for (let index = 1; index < wanted; index += 1) {
      const anchorEntry = anchored[
        Math.min(anchored.length - 1, Math.round((index * anchored.length) / wanted))
      ];
      spread.push({
        anchor: anchorEntry.anchor,
        segmentIndex: anchorEntry.segmentIndex,
        target: clamp(Math.round((maxScroll * index) / wanted)),
      });
    }
    moves = [...resolved.filter(move => move.target === 0), ...spread].sort(
      (a, b) => a.segmentIndex - b.segmentIndex
    );
  }

  let cursor = 0; // current scroll position
  let time = introHold;

  for (const move of moves) {
    if (move.target <= cursor) continue;
    const segment = input.segments[move.segmentIndex];
    const chunk = segment
      ? input.chunks.find(item => item.segmentId === segment.id)
      : undefined;

    // Snap forward only: revisiting is not needed for a short Reel and keeps
    // the interpolation monotonic.
    const destination = move.target;
    const distance = Math.abs(destination - cursor);

    // The reveal is scheduled to *finish* just before the segment that talks
    // about this section begins, so each section gets reading time and the
    // moves are spread across the whole narration instead of bunched at the
    // start.
    const proportional = 250 + (distance / Math.max(1, maxScroll)) * 1400;
    const naturalMove = Math.min(maxMove, Math.max(MIN_MOVE_MS, proportional));
    const latestFinish = chunk
      ? Math.max(time + MIN_MOVE_MS, chunk.startMs - SETTLE_MS)
      : time + naturalMove;
    const finish = Math.min(latestFinish, Math.max(time + MIN_MOVE_MS, latestFinish));
    const start = Math.max(time, finish - naturalMove);

    keys.push({ timeMs: Math.round(start), scrollY: cursor, easing: "easeInOut" });
    keys.push({
      timeMs: Math.round(Math.max(start + MIN_MOVE_MS, finish)),
      scrollY: destination,
      easing: "easeInOut",
      anchor: move.anchor,
    });
    cursor = destination;
    // Leave reading time between one section and the next.
    time = Math.max(start + MIN_MOVE_MS, finish) + minHold;
  }

  // Final hold so the last section is readable and the frame does not freeze
  // long after the audio ends.
  keys.sort((a, b) => a.timeMs - b.timeMs);
  return dedupeKeyframes(keys);
}

/**
 * Remove keyframes that land on the same millisecond.
 *
 * A keyframe pair with an unchanged position but a later time is *kept*: it is
 * the "hold still here" marker that makes the following move start at the right
 * moment instead of interpolating from the beginning of the video.
 */
function dedupeKeyframes(keys: ScrollKeyframe[]): ScrollKeyframe[] {
  const out: ScrollKeyframe[] = [];
  for (const key of keys) {
    const previous = out[out.length - 1];
    if (!previous || key.timeMs - previous.timeMs > 16) {
      out.push(key);
      continue;
    }
    out[out.length - 1] = {
      ...previous,
      scrollY: key.scrollY,
      anchor: key.anchor ?? previous.anchor,
    };
  }
  return out;
}

/** Sample the keyframe list at an arbitrary time. Used by tests and previews. */
export function scrollAt(keyframes: ScrollKeyframe[], timeMs: number): number {
  if (keyframes.length === 0) return 0;
  if (timeMs <= keyframes[0].timeMs) return keyframes[0].scrollY;
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    if (timeMs <= to.timeMs) {
      const span = to.timeMs - from.timeMs;
      if (span <= 0) return to.scrollY;
      const progress = (timeMs - from.timeMs) / span;
      const eased = to.easing === "easeInOut" ? easeInOutCubic(progress) : progress;
      return from.scrollY + (to.scrollY - from.scrollY) * eased;
    }
  }
  return keyframes[keyframes.length - 1].scrollY;
}