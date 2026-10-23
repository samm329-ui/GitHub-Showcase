import type {
  AudioChunk,
  CaptionPhrase,
  MeasuredAnchor,
  NarrationSegment,
  ScrollKeyframe,
  VisualAnchor,
} from "./types.js";
import { SCROLL, VIEWPORT_PADDING } from "./config.js";

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
const MAX_PHRASES_PER_SEGMENT = 8;
/** How long before a section's narration begins the scroll must arrive. */
const SETTLE_MS = 200;

/* ------------------------------------------------------------------ */
/* Phrase splitting                                                    */
/* ------------------------------------------------------------------ */

/** Split into readable phrases of roughly 3-7 words at natural boundaries. */
export function splitPhrases(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const phrases: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    phrases.push(current.join(" "));
    current = [];
  };

  for (const word of words) {
    current.push(word);
    const endsSentence = /[.!?]["')\]]?$/.test(word);
    const endsStrongClause = /[;:—–]["')\]]?$/.test(word);
    const endsWeakClause = /[,]["')\]]?$/.test(word);
    const longEnough = current.length >= 5;

    if (endsSentence) {
      flush();
      continue;
    }
    if (current.length >= 3 && endsStrongClause) {
      // A colon or semicolon is a deliberate beat. Break early rather than
      // letting the remainder become a three-line caption.
      flush();
    } else if (longEnough && (endsWeakClause || current.length >= 7)) {
      flush();
    } else if (current.length >= 8) {
      // A long unpunctuated run still needs a break.
      flush();
    }
  }
  flush();

  // Fold very short fragments into a neighbour so a caption never flashes a
  // single word for a fraction of a second.
  const merged: string[] = [];
  for (const phrase of phrases) {
    const previous = merged[merged.length - 1];
    if (previous && previous.split(/\s+/).length < 3) {
      merged[merged.length - 1] = `${previous} ${phrase}`;
    } else {
      merged.push(phrase);
    }
  }
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    if (last.split(/\s+/).length < 3) {
      merged[merged.length - 2] = `${merged[merged.length - 2]} ${last}`;
      merged.pop();
    }
  }

  // Avoid a three-word caption that lasts a few hundred milliseconds. Fold it
  // into the previous line only when the combined phrase can still wrap to two
  // lines; the 50-character ceiling keeps that promise.
  const folded: string[] = [];
  for (const phrase of merged) {
    const previous = folded[folded.length - 1];
    const combined = previous ? `${previous} ${phrase}` : phrase;
    if (
      previous &&
      phrase.split(/\s+/).length < 4 &&
      combined.length <= 50
    ) {
      folded[folded.length - 1] = combined;
    } else {
      folded.push(phrase);
    }
  }

  return folded;
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
  phonemeTimings?:
    | { segmentId: string; phrases: { text: string; startMs: number; endMs: number }[] }[]
    | null;
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
    const split = splitPhrases(display);
    if (split.length === 0) continue;

    const aligned = phonemeBySegment.get(segment.id);
    if (aligned && aligned.length === split.length) {
      for (const [position, phrase] of split.entries()) {
        const timing = aligned[position];
        const startMs = Math.round(chunk.startMs + timing.startMs);
        const endMs = Math.round(
          Math.min(chunk.endMs, chunk.startMs + timing.endMs)
        );
        if (endMs <= startMs) continue;
        captions.push({
          index: index++,
          startMs,
          endMs,
          text: phrase,
          highlights: highlightsFor(phrase, segment.emphasis),
          segmentId: segment.id,
        });
      }
      continue;
    }

    // Fallback: distribute the measured chunk duration by phrase weight. Merge
    // phrases until each has enough room to stay readable, and never let a
    // caption run past the measured end of its chunk.
    const available = Math.max(1, chunk.endMs - chunk.startMs);
    const maxReadable = Math.max(1, Math.floor(available / MIN_PHRASE_MS));
    const phrases = groupPhrases(split, Math.min(MAX_PHRASES_PER_SEGMENT, maxReadable));
    const weights = phrases.map(phraseWeight);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;

    let cursor = chunk.startMs;
    for (const [position, phrase] of phrases.entries()) {
      const isLast = position === phrases.length - 1;
      const share = (weights[position] / totalWeight) * available;
      const remaining = Math.max(1, chunk.endMs - cursor);
      let duration = isLast ? remaining : Math.max(120, share);
      duration = Math.min(duration, remaining);
      const startMs = Math.round(cursor);
      const endMs = Math.round(cursor + duration);
      if (endMs > startMs) {
        captions.push({
          index: index++,
          startMs,
          endMs: Math.min(chunk.endMs, endMs),
          text: phrase,
          highlights: highlightsFor(phrase, segment.emphasis),
          segmentId: segment.id,
        });
      }
      cursor = Math.min(chunk.endMs, cursor + duration);
      if (isLast) break;
    }
  }

  return enforceMonotonic(captions);
}

/** Merge neighbouring phrases until at most `limit` remain. */
function groupPhrases(phrases: string[], limit: number): string[] {
  const safeLimit = Math.max(1, limit);
  if (phrases.length <= safeLimit) return phrases;
  const groups: string[] = [];
  const perGroup = Math.ceil(phrases.length / safeLimit);
  for (let index = 0; index < phrases.length; index += perGroup) {
    groups.push(phrases.slice(index, index + perGroup).join(" "));
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

/** Guarantee non-overlapping, non-decreasing, positive intervals. */
export function enforceMonotonic(captions: CaptionPhrase[]): CaptionPhrase[] {
  const sorted = [...captions].sort((a, b) => a.startMs - b.startMs);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (next && current.endMs > next.startMs) {
      current.endMs = Math.max(current.startMs + 60, next.startMs);
    }
    if (current.endMs <= current.startMs) {
      current.endMs = current.startMs + Math.max(60, MIN_PHRASE_MS / 4);
    }
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
  /** Measured narration duration. New code should always pass this. */
  durationMs?: number;
  /** Extra padding so a section is not flush against the top edge. */
  padding?: number;
  /** Hold at the opening view before the first move. */
  introHoldMs?: number;
  /** Hold on the final section before the clip ends. */
  outroHoldMs?: number;
  /** Pacing aim and hard ceiling, in displayed pixels per second. */
  targetPxPerSecond?: number;
  maxPxPerSecond?: number;
  minMoveMs?: number;
  maxMoveMs?: number;
  /** Gap (in viewports) above which a midpoint landmark is inserted. */
  maxLandmarkGapViewports?: number;
};

type Landmark = {
  y: number;
  speechMs: number | null;
  anchor?: VisualAnchor;
};

export function buildScrollKeyframes(input: ScrollPlanInput): ScrollKeyframe[] {
  const padding = input.padding ?? VIEWPORT_PADDING;
  const introHold = input.introHoldMs ?? SCROLL.introHoldMs;
  const outroHold = input.outroHoldMs ?? SCROLL.outroHoldMs;
  const targetSpeed = input.targetPxPerSecond ?? SCROLL.targetPxPerSecond;
  const maxSpeed = input.maxPxPerSecond ?? SCROLL.maxPxPerSecond;
  const maxLandmarkGap =
    (input.maxLandmarkGapViewports ?? SCROLL.maxLandmarkGapViewports) *
    Math.max(1, input.viewportHeight);

  const maxScroll = Math.max(0, input.documentHeight - input.viewportHeight);
  // A page that barely overflows cannot produce a meaningful reveal. This uses
  // the same "a fifth of a viewport" rule as `isScrollable`, so a 90px overflow
  // does not become a pointless two-pixel-per-frame creep.
  const minimumScroll = Math.max(48, Math.round(input.viewportHeight * 0.2));
  const durationMs =
    input.durationMs ??
    Math.max(
      1000,
      (input.chunks[input.chunks.length - 1]?.endMs ?? 1000) + outroHold
    );

  const startKey: ScrollKeyframe = {
    timeMs: 0,
    scrollY: 0,
    easing: "easeInOut",
    anchor: "repo-header",
  };

  // A page that barely overflows cannot produce a meaningful reveal.
  if (maxScroll < minimumScroll) return [startKey];

  const byAnchor = new Map(input.anchors.map(anchor => [anchor.anchor, anchor]));
  const clamp = (value: number) => Math.min(maxScroll, Math.max(0, value));

  // GitHub's mobile DOM does not expose a stable "features" heading. The README
  // intro is the closest truthful destination for a feature tour, and using it
  // prevents the video from staring at the file list while the narrator explains
  // a README section.
  const anchorFallbacks: Partial<Record<VisualAnchor, VisualAnchor[]>> = {
    features: ["readme-intro"],
  };

  const targetFor = (anchor: VisualAnchor): number | null => {
    for (const candidate of [anchor, ...(anchorFallbacks[anchor] ?? [])]) {
      const measured = byAnchor.get(candidate);
      if (!measured || measured.offsetHeight <= 0) continue;
      return clamp(measured.offsetTop - padding);
    }
    return null;
  };
  const chunkFor = (segmentId: string) =>
    input.chunks.find(chunk => chunk.segmentId === segmentId) ?? null;

  /* ---- 1. Landmarks explicitly referenced by the narration ---------- */
  const referenced: Landmark[] = [];
  for (const segment of input.segments) {
    if (!segment.visualAnchor) continue;
    const y = targetFor(segment.visualAnchor);
    if (y === null) continue;
    const chunk = chunkFor(segment.id);
    referenced.push({
      y,
      speechMs: chunk ? chunk.startMs : null,
      anchor: segment.visualAnchor,
    });
  }

  // Final target: the last narrated landmark, unless there is no usable
  // narration anchor at all, in which case tour most of the available page.
  const desiredFinal =
    referenced.length > 0
      ? Math.max(...referenced.map(landmark => landmark.y))
      : Math.round(maxScroll * 0.92);
  const finalY = clamp(Math.max(desiredFinal, Math.min(maxScroll, 1)));

  /* ---- 2. Extra existed anchors fill the gaps between beats --------- */
  const allAnchors = [...input.anchors]
    .map(anchor => ({
      y: clamp(anchor.offsetTop - padding),
      anchor: anchor.anchor,
    }))
    .filter(item => item.y > 0 && item.y <= finalY)
    .sort((a, b) => a.y - b.y);

  const chosen: Landmark[] = [...referenced]
    .filter(landmark => landmark.y > 0 && landmark.y <= finalY)
    .sort((a, b) => a.y - b.y);

  const addLandmark = (landmark: Landmark) => {
    const duplicate = chosen.some(
      item => Math.abs(item.y - landmark.y) < Math.max(8, maxLandmarkGap * 0.08)
    );
    if (!duplicate) chosen.push(landmark);
  };

  for (const anchor of allAnchors) addLandmark({ ...anchor, speechMs: null });

  // Always end on the planned final position even when no anchor sits there.
  if (!chosen.some(item => Math.abs(item.y - finalY) < 2)) {
    chosen.push({ y: finalY, speechMs: null });
  }

  chosen.sort((a, b) => a.y - b.y);

  /* ---- 3. Evenly spaced fallbacks for a heading-free page ----------- */
  const minimumLandmarks = 3;
  if (chosen.length < minimumLandmarks) {
    const count = minimumLandmarks;
    for (let index = 1; index < count; index += 1) {
      const y = Math.round((finalY * index) / count);
      if (y > 0) addLandmark({ y, speechMs: null });
    }
    chosen.sort((a, b) => a.y - b.y);
  }

  /* ---- 4. Insert midpoints so no interval jumps across a screen ----- */
  const withMidpoints: Landmark[] = [];
  for (const [index, landmark] of chosen.entries()) {
    const previous = withMidpoints[withMidpoints.length - 1];
    if (previous) {
      const gap = landmark.y - previous.y;
      const steps = Math.floor(gap / Math.max(1, maxLandmarkGap));
      for (let step = 1; step <= steps; step += 1) {
        const fraction = step / (steps + 1);
        withMidpoints.push({
          y: Math.round(previous.y + gap * fraction),
          speechMs: null,
        });
      }
    }
    withMidpoints.push(landmark);
  }

  // Deduplicate again after midpoint insertion.
  const landmarks: Landmark[] = [];
  for (const landmark of withMidpoints) {
    if (
      landmarks.length === 0 ||
      landmark.y - landmarks[landmarks.length - 1].y > 1
    ) {
      landmarks.push(landmark);
    }
  }
  if (landmarks.length === 0) return [startKey];

  /* ---- 5. Schedule landmark times (uniform pacing + speech hint) ---- */
  const usable = Math.max(1, durationMs - introHold - outroHold);
  const minimumGap = Math.max(
    180,
    Math.min(
      input.minMoveMs ?? SCROLL.minMoveMs,
      usable / Math.max(2, landmarks.length + 1)
    )
  );

  const rawTimes = landmarks.map((landmark, index) => {
    const uniform = introHold + ((index + 1) / landmarks.length) * usable;
    if (landmark.speechMs === null) return uniform;
    const speech = Math.max(
      introHold,
      Math.min(durationMs - outroHold, landmark.speechMs - SETTLE_MS)
    );
    // Uniform pacing prevents late clustering; speech keeps some authority.
    return 0.65 * uniform + 0.35 * speech;
  });

  // Enforce strictly increasing times with a readable minimum move duration.
  const times: number[] = [];
  for (const [index, raw] of rawTimes.entries()) {
    const previous = times[index - 1];
    const t = previous === undefined ? Math.max(introHold, raw) : Math.max(previous + minimumGap, raw);
    times.push(t);
  }
  // If the minimum gaps pushed us past the outro, compress the whole schedule
  // proportionally into the usable window instead of clipping the last beat.
  const lastAllowed = Math.max(introHold + minimumGap, durationMs - outroHold);
  if (times[times.length - 1] > lastAllowed) {
    const first = times[0];
    const span = Math.max(1, times[times.length - 1] - first);
    const scale = Math.max(0, (lastAllowed - first) / span);
    for (let index = 0; index < times.length; index += 1) {
      times[index] = first + (times[index] - first) * scale;
    }
    for (let index = 1; index < times.length; index += 1) {
      times[index] = Math.max(times[index - 1] + 1, times[index]);
    }
  }

  /* ---- 5b. Travel-time pass ----------------------------------------- */
  // A speech hint can demand more distance than the speed ceiling allows in
  // the scheduled interval. The old ceiling repair would clip such a move
  // mid-air, so the narrated section never actually reached the viewport.
  // Instead, each key arrives late but *fully*: its time is delayed until the
  // move from the previous position is physically achievable. The final key
  // may run slightly past the outro window — a full, late arrival beats a
  // clipped, on-time one, because the final view is what the viewer reads.
  for (let index = 0; index < times.length; index += 1) {
    const fromY = index === 0 ? 0 : landmarks[index - 1].y;
    const distance = Math.abs(landmarks[index].y - fromY);
    const travelMs = (distance / Math.max(1, maxSpeed)) * 1000;
    const moveStart = index === 0 ? introHold : times[index - 1];
    times[index] = Math.max(
      times[index],
      Math.round(moveStart + travelMs)
    );
  }

  /* ---- 6. Build keyframes, then repair the speed ceiling ------------ */
  const keys: ScrollKeyframe[] = [
    { timeMs: 0, scrollY: 0, easing: "easeInOut", anchor: "repo-header" },
    { timeMs: Math.round(introHold), scrollY: 0, easing: "easeInOut" },
  ];

  let previousY = 0;
  for (const [index, landmark] of landmarks.entries()) {
    const timeMs = Math.round(times[index]);
    const dt = Math.max(1, timeMs - keys[keys.length - 1].timeMs);
    const maxDistance = (maxSpeed * dt) / 1000;
    const dy = landmark.y - previousY;
    // A single interval may never exceed the hard speed ceiling. This is a
    // safety net: the story span is cropped upstream so it rarely fires.
    const repairedY = previousY + Math.min(dy, maxDistance);
    const scrollY = Math.round(
      Math.min(maxScroll, Math.max(previousY, repairedY))
    );
    keys.push({
      timeMs,
      scrollY,
      easing: "easeInOut",
      anchor: landmark.anchor,
    });
    previousY = scrollY;
  }

  // Make sure the last frame reaches the planned destination when the pacing
  // permits it. If the ceiling prevented it, leave the safe repaired position.
  const finalKey = keys[keys.length - 1];
  const finalKeyIndex = keys.length - 1;
  if (finalKey.scrollY < finalY) {
    const previousKey = keys[finalKeyIndex - 1];
    const dt = Math.max(1, finalKey.timeMs - previousKey.timeMs);
    const allowed = (maxSpeed * dt) / 1000;
    if (finalY - previousKey.scrollY <= allowed) {
      finalKey.scrollY = finalY;
    }
  }

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
      scrollY: Math.max(previous.scrollY, key.scrollY),
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

/** Average pixels-per-second for every keyframe interval. */
export function scrollSpeeds(keyframes: ScrollKeyframe[]): number[] {
  const speeds: number[] = [];
  for (let index = 1; index < keyframes.length; index += 1) {
    const dt = keyframes[index].timeMs - keyframes[index - 1].timeMs;
    if (dt <= 0) continue;
    const dy = Math.abs(keyframes[index].scrollY - keyframes[index - 1].scrollY);
    speeds.push((dy / dt) * 1000);
  }
  return speeds;
}

/**
 * Materially different viewport positions at 25/50/75% of the duration.
 * Used by tests and the QA report; a static page returns an empty list.
 */
export function scrollCoverage(
  keyframes: ScrollKeyframe[],
  durationMs: number,
  stops = [0.25, 0.5, 0.75]
): number[] {
  return stops.map(stop => scrollAt(keyframes, durationMs * stop));
}
