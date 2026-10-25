import {
  CALLOUT,
  DEFAULT_CALLOUT_PROFILE,
  VIEWPORT,
} from "./config.js";
import type {
  AudioChunk,
  CalloutAssetProfile,
  CalloutCue,
  CalloutRole,
  CalloutState,
  NarrationSegment,
} from "./types.js";

/**
 * Callout bubble (Visual Composition Pass).
 *
 * Two independent text systems sit over the GitHub card:
 *
 *   1. the callout — short, evidence-backed summaries of key project ideas
 *      (purpose, mechanism, example, outcome, tradeoff), attached to the
 *      mascot's head;
 *   2. the caption panel — the verbatim spoken phrase with a moving accent pill
 *      behind the word currently being spoken.
 *
 * This module owns the callout copy, candidate ranking, seeded scheduling,
 * per-frame entry/exit state, and asset-aware geometry.
 *
 * All functions are pure and deterministic.
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
/* Deterministic math & PRNG                                          */
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

/** Pure deterministic PRNG for reproducible candidate selection. */
export function createPrng(seed: string | number): () => number {
  let h = 0x811c9dc5;
  if (typeof seed === "number") {
    h = (seed ^ 0x5bd1e995) >>> 0;
  } else {
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return function () {
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h >>> 0) / 4294967296;
  };
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
export const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "into", "onto", "for", "with",
  "from", "to", "of", "in", "on", "at", "by", "as", "that", "which",
  "your", "their", "our", "its", "it", "is", "are", "be", "you", "we",
  "they", "so", "may", "might", "can", "could", "will", "would", "shall",
  "should", "must", "involve", "involves", "require", "requires", "include",
  "includes", "contain", "contains", "provide", "provides", "use", "uses",
  "allow", "allows", "need", "needs", "have", "has", "give", "gives",
  "powerful", "user-friendly", "simple", "modern", "fast", "lightweight",
  "easy", "flexible", "popular", "mature", "great", "small", "large",
]);

function cleanWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9+#-]/g, "");
}

/**
 * Estimate how many lines the callout text needs inside the bubble.
 */
export function calloutLineEstimate(text: string, bubbleWidthPx: number = CALLOUT.bubbleWidthPx): number {
  const words = wordsOf(text.trim());
  if (words.length === 0) return 0;
  const contentWidth = bubbleWidthPx - CALLOUT.textPadXPx * 2;
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
export function calloutFitsBubble(text: string, bubbleWidthPx: number = CALLOUT.bubbleWidthPx): boolean {
  return calloutLineEstimate(text, bubbleWidthPx) <= CALLOUT.maxLines;
}

/**
 * Give the copy a bubble-sized shape. Only clearly secondary qualifiers are
 * dropped, and only at a word boundary; the claim the words make is kept.
 */
function shortenCopy(text: string, maxWords: number): string | null {
  const direct = text.trim();
  if (wordsOf(direct).length <= maxWords) return direct;

  // Try splitting by sentence boundary first
  const sentences = direct.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) {
    for (const sent of sentences) {
      const trimmed = sent.replace(/[.!?]+$/, "").trim();
      const count = wordsOf(trimmed).length;
      if (count >= CALLOUT.minWords && count <= maxWords) {
        return trimmed;
      }
    }
  }

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
    " and ",
    " or ",
    ", ",
    "; ",
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
 * function word or leaving one dangling at the end.
 */
function trimToBubble(text: string, minWords: number, bubbleWidthPx: number = CALLOUT.bubbleWidthPx): string | null {
  let words = wordsOf(text);
  while (words.length >= minWords) {
    const candidate = words.join(" ").replace(/[,;:]+$/, "").trim();
    if (calloutFitsBubble(candidate, bubbleWidthPx)) {
      const last = cleanWord(words[words.length - 1]);
      if (!FUNCTION_WORDS.has(last)) {
        return candidate;
      }
    }
    words = words.slice(0, -1);
  }
  return null;
}

function extractTransformation(text: string): string | null {
  const match = text.match(/\b(?:transforms?|converts?|turns?)\s+(.+?)\s+into\s+(.+)$/i);
  if (!match) return null;
  let source = match[1].trim();
  let target = match[2].trim();

  target = target.replace(/\s+for\s+.+$/i, "").trim();
  target = target.replace(/\s+across\s+.+$/i, "").trim();

  source = source.replace(/\blong-form\s+videos\b/i, "long videos");
  target = target.replace(/\b(?:viral-ready|ready-to-share|high-quality)\b/gi, "").trim();
  target = target.replace(/\b(?:9:16|\d+:\d+)\s*/g, "").trim();
  target = target.replace(/\s+/g, " ");

  const candidate = `Turns ${source} into ${target}`.replace(/\s+/g, " ").trim();
  return candidate;
}

function extractSimplifications(text: string): string[] {
  const results: string[] = [];

  // Deployment / Run
  const m = text.match(/^(?:it is\s+)?(?:built|designed|intended)\s+to\s+run\s+(.+)$/i);
  if (m) results.push(`Runs ${m[1]}`.trim());

  const dockerMatch = text.match(/\b(?:bring(?:\s+it)?\s+up|run|start)\s+with\s+(.+)$/i);
  if (dockerMatch) results.push(`Runs with ${dockerMatch[1]}`.trim());

  const installWith = text.match(/\b(?:install(?:\s+it)?)\s+with\s+(.+)$/i);
  if (installWith) results.push(`Install with ${installWith[1]}`.trim());

  if (/\bsetup\s+section\s+that\s+walks\s+you\s+through/i.test(text)) {
    results.push("Walks you through setup");
  }

  // Active verbs: finds / detects / identifies / reasons over / generates / simulates / provides
  const activeMatch = text.match(
    /\b(?:it\s+)?(finds?|detects?|identifies?|extracts?|generates?|creates?|parses?|manages?|automates?|syncs?|simulates?|reasons?\s+over|provides?|delivers?)\s+(.+)$/i
  );
  if (activeMatch) {
    const verb = activeMatch[1].charAt(0).toUpperCase() + activeMatch[1].slice(1);
    const rest = activeMatch[2]
      .replace(/\s+that\s+.+$/i, "")
      .replace(/\s+with\s+.+$/i, "")
      .replace(/[,;].*$/, "")
      .trim();
    results.push(`${verb} ${rest}`);
  }

  // Tradeoff / Requirements: involves / requires / needs
  const reqMatch = text.match(/\b(?:involves?|requires?|needs?|may\s+involve|may\s+require)\s+(?:an?\s+)?(.+)$/i);
  if (reqMatch) {
    results.push(`Requires ${reqMatch[1]}`.trim());
    results.push(reqMatch[1].trim());
  }

  // Technology / Framework mechanism: e.g. "with Kotlin Multiplatform for shared logic"
  const withMatch = text.match(/\bwith\s+([A-Za-z0-9\s\/-]+?)\s+for\s+([A-Za-z0-9\s\/-]+)/i);
  if (withMatch) {
    results.push(`${withMatch[1].trim()} for ${withMatch[2].trim()}`);
  }

  return results;
}

/**
 * Concise bubble copy derived from an eligible narrative proposition.
 */
export function calloutTextFor(
  proposition: string,
  options: { maxWords?: number; minWords?: number; bubbleWidthPx?: number } = {}
): string | null {
  const maxWords = options.maxWords ?? CALLOUT.maxWords;
  const minWords = options.minWords ?? CALLOUT.minWords;
  const bubbleWidthPx = options.bubbleWidthPx ?? CALLOUT.bubbleWidthPx;
  const base = cleanCopy(proposition);
  if (!base) return null;

  const candidates: string[] = [];
  const transformation = extractTransformation(base);
  if (transformation) candidates.push(transformation);

  const simplifications = extractSimplifications(base);
  for (const s of simplifications) candidates.push(s);

  const clause = base.match(/\b(?:that|which)\s+(.+)$/i)?.[1]?.trim() ?? null;
  if (clause) candidates.push(clause);

  candidates.push(base);

  // Identity / Noun Phrase after "is a / an / the" as fallback when full sentence doesn't fit
  const isMatch = base.match(/^.+?\s+(?:is|are)\s+(?:an?|the)\s+(.+)$/i);
  if (isMatch) {
    const cleaned = isMatch[1]
      .replace(/\b(?:powerful|user-friendly|simple|modern|fast|lightweight|ai-powered)\s+(?:and\s+)?/gi, "")
      .trim();
    candidates.push(cleaned);
  }

  // Colon split: e.g. "AgentRQ: Human-in-loop task manager"
  if (base.includes(": ")) {
    const parts = base.split(/:\s+/);
    if (parts[1]?.trim()) candidates.push(parts[1].trim());
  }

  for (const candidate of candidates) {
    const shortened = shortenCopy(sentenceCase(candidate), maxWords);
    if (!shortened) continue;
    const fitted = trimToBubble(shortened, minWords, bubbleWidthPx);
    if (!fitted) continue;
    const count = wordsOf(fitted).length;
    if (count < minWords || count > maxWords) continue;
    return /[!?]$/.test(fitted) ? fitted : `${fitted}!`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Token comparison & redundancy                                      */
/* ------------------------------------------------------------------ */

export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9+#-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !FUNCTION_WORDS.has(w));
  return new Set(words);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function normaliseForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Candidate scoring                                                  */
/* ------------------------------------------------------------------ */

export type ScoredCalloutCandidate = {
  segment: NarrationSegment;
  chunk: AudioChunk;
  role: CalloutRole;
  text: string;
  importance: number;
  evidenceStrength: number;
  novelty: number;
  curiosity: number;
  compactness: number;
  score: number;
};

const BASE_ROLE_IMPORTANCE: Record<CalloutRole, number> = {
  purpose: 1.0,
  mechanism: 0.86,
  example: 0.82,
  benefit: 0.78,
  tradeoff: 0.70,
  installation: 0.74,
};

function resolveCalloutRole(segment: NarrationSegment): CalloutRole {
  if (segment.calloutRole) return segment.calloutRole;
  if (segment.purpose === "identify" || segment.narrativeRole === "identity") return "purpose";
  if (segment.purpose === "explain" || segment.narrativeRole === "demo") return "mechanism";
  if (segment.purpose === "demo" || segment.narrativeRole === "proof") return "example";
  if (segment.purpose === "benefit" || segment.narrativeRole === "value") return "benefit";
  if (segment.purpose === "caveat" || segment.narrativeRole === "caveat") return "tradeoff";
  if (segment.purpose === "install" || segment.narrativeRole === "setup") return "installation";
  return "purpose";
}

/**
 * Score candidate callouts based on semantic role, evidence, compactness, and novelty.
 */
export function scoreCalloutCandidate(
  segment: NarrationSegment,
  chunk: AudioChunk,
  priorTokens: Set<string>[] = []
): ScoredCalloutCandidate | null {
  const text = segment.calloutText?.trim();
  if (!text || segment.factIds.length === 0) return null;

  // Verbatim copy check: reject exact duplicate of spoken subtitle.
  if (normaliseForComparison(text) === normaliseForComparison(segment.captionText)) {
    return null;
  }

  const role = resolveCalloutRole(segment);
  const baseImportance = segment.calloutImportance ?? BASE_ROLE_IMPORTANCE[role] ?? 0.75;
  const words = wordsOf(text);
  if (words.length < CALLOUT.minWords || words.length > CALLOUT.maxWords) {
    return null;
  }

  const tokens = tokenize(text);
  const captionTokens = tokenize(segment.captionText);
  // High lexical overlap with concurrently displayed subtitle is penalized.
  const captionOverlap = jaccardSimilarity(tokens, captionTokens);
  if (captionOverlap > 0.85) return null;

  // Evidence strength: 0.5 for 1 fact, up to 1.0 for multiple supporting facts.
  const evidenceStrength = clamp01(0.4 + segment.factIds.length * 0.3);

  // Novelty: how unique are these words compared to previously accepted candidate tokens.
  let maxPriorSim = 0;
  for (const prior of priorTokens) {
    const sim = jaccardSimilarity(tokens, prior);
    if (sim > maxPriorSim) maxPriorSim = sim;
  }
  const novelty = clamp01(1 - maxPriorSim);

  // Curiosity: presence of specific action verbs, numbers, or technical outcomes.
  const hasSpecifics = /\b(?:turns?|runs?|finds?|detects?|generates?|creates?|builds?|\d+)\b/i.test(text);
  const curiosity = hasSpecifics ? 0.9 : 0.6;

  // Compactness: peaks around 4-6 words.
  const compactness = clamp01(1 - Math.abs(words.length - 5) / 5);

  // score = 0.30*importance + 0.25*evidenceStrength + 0.20*novelty + 0.15*curiosity + 0.10*compactness
  const rawScore =
    0.30 * baseImportance +
    0.25 * evidenceStrength +
    0.20 * novelty +
    0.15 * curiosity +
    0.10 * compactness -
    0.15 * captionOverlap;
  const score = round3(clamp01(rawScore));

  return {
    segment,
    chunk,
    role,
    text,
    importance: round2(baseImportance),
    evidenceStrength: round2(evidenceStrength),
    novelty: round2(novelty),
    curiosity: round2(curiosity),
    compactness: round2(compactness),
    score,
  };
}

/* ------------------------------------------------------------------ */
/* Multi-cue chronological scheduling                                 */
/* ------------------------------------------------------------------ */

export type BuildCalloutOptions = {
  maxCues?: number;
  minGapMs?: number;
  minVisibleMs?: number;
  minCueDurationMs?: number;
  maxVisibleMs?: number;
  seed?: string | number;
};

/**
 * Build a varied, evidence-backed sequence of callout cues scheduled across the timeline.
 *
 * Enforces:
 *   - non-overlapping cues with an inter-callout visual gap;
 *   - duration-aware cap (e.g. 2-3 for 20s, up to 5-6 for 40s+);
 *   - seeded, deterministic candidate choice across diverse roles (purpose, mechanism, example, benefit);
 *   - chronological alignment with audio chunks without rejecting adjacent beats outright;
 *   - minimum readable hold duration.
 */
export function buildCalloutCues(
  segments: NarrationSegment[],
  chunks: AudioChunk[],
  durationMs?: number,
  options: BuildCalloutOptions = {}
): CalloutCue[] {
  if (!CALLOUT.enabled) return [];
  const minGapMs = options.minGapMs ?? CALLOUT.interCalloutGapMs;
  const minVisibleMs = options.minVisibleMs ?? CALLOUT.minVisibleMs;
  const maxVisibleMs = options.maxVisibleMs ?? CALLOUT.maxVisibleMs;
  const chunkBySegment = new Map(chunks.map(chunk => [chunk.segmentId, chunk]));

  // Calculate duration-aware cue cap: clamp(round(durationMs / 7000), 2, 6)
  const durationCap = durationMs ? clamp(Math.round(durationMs / 7000), 2, 6) : 4;
  const maxCues = options.maxCues ?? Math.min(CALLOUT.maxCues, durationCap);

  // Initial candidate extraction
  const eligible = segments
    .filter(
      seg =>
        Boolean(seg.calloutText?.trim()) &&
        seg.factIds.length > 0 &&
        chunkBySegment.has(seg.id)
    )
    .map(seg => ({ segment: seg, chunk: chunkBySegment.get(seg.id)! }));

  if (eligible.length === 0) return [];

  // Score each candidate
  const scoredCandidates: ScoredCalloutCandidate[] = [];
  const tokenList: Set<string>[] = [];
  for (const item of eligible) {
    const scored = scoreCalloutCandidate(item.segment, item.chunk, tokenList);
    if (scored) {
      scoredCandidates.push(scored);
      tokenList.push(tokenize(scored.text));
    }
  }

  if (scoredCandidates.length === 0) return [];

  // Candidate selection:
  // 1. Force the highest-scoring purpose candidate if available.
  // 2. Select subsequent candidates with role diversity and seeded jitter.
  const prng = createPrng(options.seed ?? "showcase-callouts-v1");
  const purposeCandidates = scoredCandidates
    .filter(c => c.role === "purpose")
    .sort((a, b) => b.score - a.score);
  const otherCandidates = scoredCandidates
    .filter(c => c.role !== "purpose")
    .sort((a, b) => b.score - a.score);

  const selectedForScheduling: ScoredCalloutCandidate[] = [];
  if (purposeCandidates.length > 0) {
    selectedForScheduling.push(purposeCandidates[0]);
  }

  // Add other roles up to candidate pool
  const roleCounts = new Map<CalloutRole, number>();
  if (purposeCandidates.length > 0) roleCounts.set("purpose", 1);

  for (const candidate of otherCandidates) {
    const currentRoleCount = roleCounts.get(candidate.role) ?? 0;
    // Cap at 1 per role for mechanism/example/tradeoff unless pool is sparse
    if (currentRoleCount >= 1 && selectedForScheduling.length >= 3) continue;
    selectedForScheduling.push(candidate);
    roleCounts.set(candidate.role, currentRoleCount + 1);
  }

  // Include any remaining purpose candidates if needed
  for (let i = 1; i < purposeCandidates.length; i += 1) {
    selectedForScheduling.push(purposeCandidates[i]);
  }

  // Sort chronologically by chunk start time
  selectedForScheduling.sort((a, b) => a.chunk.startMs - b.chunk.startMs);

  // Chronological scheduling pass with collision shortening
  const scheduled: CalloutCue[] = [];

  for (const candidate of selectedForScheduling) {
    if (scheduled.length >= maxCues) break;
    const chunk = candidate.chunk;

    // Desired start / end
    let startMs = Math.max(
      CALLOUT.minStartMs,
      Math.min(chunk.startMs - CALLOUT.startLeadMs, chunk.endMs - 200)
    );
    let endMs = Math.min(
      chunk.endMs + CALLOUT.endTailMs,
      startMs + maxVisibleMs,
      durationMs ?? Number.POSITIVE_INFINITY
    );

    // If visible duration is below minimum readable hold, try extending up to natural hold
    if (endMs - startMs < minVisibleMs) {
      endMs = Math.min(startMs + minVisibleMs, durationMs ?? Number.POSITIVE_INFINITY);
    }
    const minCueFloor = options.minCueDurationMs ?? CALLOUT.minCueDurationMs;
    if (endMs - startMs < minCueFloor) {
      // Cannot fit minimum readable hold within video duration
      continue;
    }

    // Check collision with the previously scheduled cue
    if (scheduled.length > 0) {
      const prev = scheduled[scheduled.length - 1];
      const requiredGapEnd = prev.endMs + minGapMs;

      if (startMs < requiredGapEnd) {
        // Overlap or insufficient gap. Try shortening the earlier cue if it still has minVisibleMs
        const possiblePrevEnd = startMs - minGapMs;
        if (possiblePrevEnd - prev.startMs >= minVisibleMs) {
          prev.endMs = Math.round(possiblePrevEnd);
        } else {
          // Earlier cue cannot be shortened enough. Compare scores
          const prevCandidate = selectedForScheduling.find(c => c.segment.id === prev.segmentId);
          const prevScore = prevCandidate?.score ?? 0.8;
          if (candidate.score > prevScore + 0.15) {
            // Replace earlier lower-priority cue
            scheduled.pop();
          } else {
            // Drop current candidate
            continue;
          }
        }
      }
    }

    scheduled.push({
      id: `callout:${candidate.segment.id}`,
      segmentId: candidate.segment.id,
      role: candidate.role,
      text: candidate.text,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      factIds: [...candidate.segment.factIds],
      anchor: "mascot-head",
      importance: candidate.importance,
      selectionScore: candidate.score,
    });
  }

  return scheduled.sort((a, b) => a.startMs - b.startMs);
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
/* Spatial layout (asset-aware)                                        */
/* ------------------------------------------------------------------ */

/**
 * Place the bubble from the mascot's measured head anchor, taking into
 * account the aspect ratio and tail tip of the selected callout asset profile.
 */
export function placeCallout(
  head: CalloutHeadAnchor,
  config: CalloutLayoutConfig = CALLOUT,
  profile: CalloutAssetProfile = DEFAULT_CALLOUT_PROFILE
): CalloutLayout {
  const width = config.bubbleWidthPx;
  const aspect = profile.heightPx / profile.widthPx;
  const height = Math.round(width * aspect);
  const tailXLocal = Math.round(width * profile.tailTip.x);
  const tailInset = Math.round(height * (1 - profile.tailTip.y));

  const left = clamp(
    head.faceCenterX + config.faceOffsetPx - tailXLocal,
    config.leftMinPx,
    VIEWPORT.width - config.rightMarginPx - width
  );
  const top = clamp(
    head.headTopY - config.topOffsetPx,
    config.topMinPx,
    config.topMaxPx
  );

  return {
    left: round2(left),
    top: round2(top),
    width: round2(width),
    height: round2(height),
    tailTipX: round2(left + tailXLocal),
    tailTipY: round2(top + height - tailInset),
  };
}

/**
 * Return the safe text bounding box inside the bubble in canvas pixels.
 */
export function calloutTextBox(
  layout: CalloutLayout,
  profile: CalloutAssetProfile = DEFAULT_CALLOUT_PROFILE
): { left: number; top: number; width: number; height: number } {
  return {
    left: round2(layout.left + profile.textSafeRect.x * layout.width),
    top: round2(layout.top + profile.textSafeRect.y * layout.height),
    width: round2(profile.textSafeRect.width * layout.width),
    height: round2(profile.textSafeRect.height * layout.height),
  };
}

/* ------------------------------------------------------------------ */
/* Fixed SVG geometry (fallback bubble)                               */
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
