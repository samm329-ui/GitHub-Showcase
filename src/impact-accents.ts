import { IMPACT_ACCENTS } from "./config.js";
import { createPrng } from "./callout-overlay.js";
import type {
  AudioChunk,
  CalloutCue,
  ImpactAnchor,
  ImpactBurstCue,
  ImpactLayer,
  ImpactVariant,
  NarrationSegment,
} from "./types.js";

/**
 * Animated Comic Impact Accents.
 *
 * Comic/anime style yellow emphasis strokes (#FFE66D) attached to the mascot's
 * silhouette. Bursts appear at irregular, meaningful narrative moments (such
 * as the arrival of an important idea or key explanation beat), hold briefly,
 * and disappear.
 *
 * All state is a pure function of media time and a deterministic seed.
 */

export type AuthoredStroke = {
  d: string;
  length: number;
};

export const IMPACT_VARIANTS: Record<ImpactVariant, AuthoredStroke[]> = {
  "three-rays": [
    { d: "M 0 0 L -26 -26", length: 37 },
    { d: "M 4 -6 L -10 -40", length: 37 },
    { d: "M 10 -4 L 38 -32", length: 40 },
  ],
  "two-rays": [
    { d: "M 0 0 L -28 -18", length: 34 },
    { d: "M 4 -4 L -8 -36", length: 35 },
  ],
  "short-spark": [
    { d: "M -16 0 L 16 0", length: 32 },
    { d: "M 0 -16 L 0 16", length: 32 },
    { d: "M -8 -8 L 8 8", length: 23 },
  ],
  sweep: [
    { d: "M -24 -8 Q 0 -32 28 -18", length: 54 },
    { d: "M -12 -2 Q 6 -20 22 -10", length: 38 },
  ],
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function easeOutCubic(u: number): number {
  const x = clamp01(u);
  return 1 - Math.pow(1 - x, 3);
}

function easeInCubic(u: number): number {
  const x = clamp01(u);
  return x * x * x;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

export type ScheduleImpactOptions = {
  seed?: string | number;
  minIntervalMs?: number;
  burstDurationMs?: number;
  maxBurstCount?: number;
  enabled?: boolean;
};

/**
 * Schedule impact bursts at irregular, semantically meaningful moments across the video.
 */
export function buildImpactBurstCues(
  segments: NarrationSegment[],
  chunks: AudioChunk[],
  callouts: CalloutCue[],
  durationMs: number,
  options: ScheduleImpactOptions = {}
): ImpactBurstCue[] {
  if (options.enabled === false || !IMPACT_ACCENTS.enabled) return [];

  const seed = options.seed ?? "showcase-impact-seed";
  const prng = createPrng(seed);
  const minIntervalMs = options.minIntervalMs ?? IMPACT_ACCENTS.minIntervalMs;
  const burstDurationMs = options.burstDurationMs ?? IMPACT_ACCENTS.burstDurationMs;
  const maxBursts = options.maxBurstCount ?? IMPACT_ACCENTS.maxBurstCount;
  const jitterMax = IMPACT_ACCENTS.jitterMs;
  const mascotSettledMs = 400; // Mascot settles at ~380ms

  // Collect candidate semantic trigger timestamps:
  // 1. Callout start moments (high value)
  // 2. Chunks with key roles (purpose, mechanism, example, benefit)
  type Candidate = { timeMs: number; segmentId?: string; priority: number };
  const candidates: Candidate[] = [];

  for (const callout of callouts) {
    candidates.push({
      timeMs: callout.startMs + 60, // Slight sync delay as bubble pops up
      segmentId: callout.segmentId,
      priority: 3,
    });
  }

  for (const chunk of chunks) {
    const seg = segments.find(s => s.id === chunk.segmentId);
    if (!seg) continue;
    if (seg.purpose === "identify" || seg.purpose === "explain" || seg.purpose === "benefit" || seg.purpose === "demo") {
      candidates.push({
        timeMs: chunk.startMs + 120,
        segmentId: chunk.segmentId,
        priority: 2,
      });
    }
  }

  // Sort chronologically
  candidates.sort((a, b) => a.timeMs - b.timeMs);

  const bursts: ImpactBurstCue[] = [];
  const variantKeys: ImpactVariant[] = ["three-rays", "two-rays", "short-spark", "sweep"];
  const anchorKeys: ImpactAnchor[] = [...IMPACT_ACCENTS.allowedAnchors];

  let lastEndMs = 0;
  let burstIndex = 0;

  for (const cand of candidates) {
    if (bursts.length >= maxBursts) break;

    // Apply bounded jitter: [-jitterMax, +jitterMax]
    const jitter = (prng() * 2 - 1) * jitterMax;
    const startMs = Math.round(
      Math.min(
        durationMs - burstDurationMs,
        Math.max(mascotSettledMs, cand.timeMs + jitter)
      )
    );
    const endMs = startMs + burstDurationMs;

    if (startMs < lastEndMs + minIntervalMs) {
      // Respect cooldown between accent bursts
      continue;
    }

    const anchor = anchorKeys[Math.floor(prng() * anchorKeys.length)];
    const variant = variantKeys[Math.floor(prng() * variantKeys.length)];
    const rotationDeg = round2((prng() * 2 - 1) * 20); // -20 to +20 deg
    const scale = round2(0.9 + prng() * 0.25); // 0.9 to 1.15
    const opacity = round2(IMPACT_ACCENTS.peakOpacity * (0.9 + prng() * 0.15));
    const layer: ImpactLayer = anchor === "laptop-edge" ? "front-mascot" : "behind-mascot";

    bursts.push({
      id: `impact:${String(burstIndex + 1).padStart(2, "0")}`,
      startMs,
      endMs,
      anchor,
      variant,
      rotationDeg,
      scale,
      opacity,
      layer,
      relatedSegmentId: cand.segmentId,
      seed: Math.floor(prng() * 1000000),
    });

    lastEndMs = endMs;
    burstIndex += 1;
  }

  return bursts;
}

/* ------------------------------------------------------------------ */
/* Per-frame evaluation                                                */
/* ------------------------------------------------------------------ */

export type EvaluatedStroke = {
  d: string;
  strokeDasharray: number;
  strokeDashoffset: number;
  opacity: number;
};

export type EvaluatedBurst = {
  id: string;
  anchor: ImpactAnchor;
  layer: ImpactLayer;
  x: number;
  y: number;
  rotationDeg: number;
  scale: number;
  opacity: number;
  strokes: EvaluatedStroke[];
};

/**
 * Evaluate the visual state of active impact bursts at a given media timestamp.
 */
export function evaluateImpactBurstsAt(
  bursts: ImpactBurstCue[],
  timeMs: number,
  anchorPositions: Record<ImpactAnchor, { x: number; y: number }>
): EvaluatedBurst[] {
  const active: EvaluatedBurst[] = [];

  for (const burst of bursts) {
    if (timeMs < burst.startMs || timeMs >= burst.endMs) continue;

    const duration = burst.endMs - burst.startMs;
    const elapsed = timeMs - burst.startMs;
    const progress = clamp01(elapsed / duration);

    // Fade in during first 20%, hold, fade out during last 30%
    const inU = clamp01(progress / 0.20);
    const outU = clamp01((progress - 0.70) / 0.30);
    const inProg = easeOutCubic(inU);
    const outProg = easeInCubic(outU);
    const burstOpacity = round3(burst.opacity * inProg * (1 - outProg));
    if (burstOpacity <= 0.001) continue;

    const pos = anchorPositions[burst.anchor] ?? { x: 0, y: 0 };
    const rawStrokes = IMPACT_VARIANTS[burst.variant] ?? IMPACT_VARIANTS["three-rays"];

    // Evaluate each stroke with per-line stagger
    const staggerMs = IMPACT_ACCENTS.lineStaggerMs;
    const evaluatedStrokes: EvaluatedStroke[] = [];

    for (let i = 0; i < rawStrokes.length; i += 1) {
      const stroke = rawStrokes[i];
      const strokeStart = i * staggerMs;
      const strokeElapsed = Math.max(0, elapsed - strokeStart);
      const strokeRevealDuration = duration * 0.45;
      const strokeProg = easeOutCubic(clamp01(strokeElapsed / strokeRevealDuration));

      const strokeDashoffset = round2(stroke.length * (1 - strokeProg));
      evaluatedStrokes.push({
        d: stroke.d,
        strokeDasharray: stroke.length,
        strokeDashoffset,
        opacity: round3(clamp01(strokeProg * 2) * (1 - outProg)),
      });
    }

    active.push({
      id: burst.id,
      anchor: burst.anchor,
      layer: burst.layer,
      x: pos.x,
      y: pos.y,
      rotationDeg: burst.rotationDeg,
      scale: burst.scale,
      opacity: burstOpacity,
      strokes: evaluatedStrokes,
    });
  }

  return active;
}
