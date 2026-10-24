import path from "node:path";
import type { DiscoveryMode } from "./types.js";

export const ROOT = process.cwd();
export const OUTPUT_DIR = process.env.SHOWCASE_OUTPUT_DIR
  ? path.resolve(process.env.SHOWCASE_OUTPUT_DIR)
  : path.join(ROOT, "output");
export const TEMP_DIR = process.env.SHOWCASE_TEMP_DIR
  ? path.resolve(process.env.SHOWCASE_TEMP_DIR)
  : path.join(ROOT, "temp");

/* ------------------------------------------------------------------ */
/* Duration policy                                                     */
/*                                                                     */
/* There is exactly ONE timeline in this pipeline and it is driven by    */
/* the measured narration audio. `TARGET_DURATION_SECONDS` is the value  */
/* the narration planner aims for; `MAX_DURATION_SECONDS` is a hard     */
/* product limit that nothing is allowed to exceed. Nothing clamps the   */
/* audio down to a target — a too-long script is shortened and          */
/* regenerated instead.                                                */
/* ------------------------------------------------------------------ */

function readNumber(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) return fallback;
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Desired finished narration length. */
export const TARGET_DURATION_SECONDS = readNumber(
  process.env.SHOWCASE_TARGET_SECONDS,
  35
);

/** Hard ceiling. The product rule is "under 60 seconds"; 58 leaves headroom. */
export const MAX_DURATION_SECONDS = 58;

/** Lower bound a script may target. Shorter than this and it is not a Reel. */
export const MIN_DURATION_SECONDS = 18;

/** Words-per-minute used only for *estimates* before TTS. Audio is truth. */
export const ESTIMATED_WPM = 155;

export const FPS = readNumber(process.env.SHOWCASE_FPS, 30);
export const VIEWPORT = { width: 1080, height: 1920 };
export const CHROME_DEBUG_URL =
  process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222";

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export const MIN_SCORE = readNumber(process.env.SHOWCASE_MIN_SCORE, 65);
export const MAX_CANDIDATES_PER_RUN = 50;
export const MAX_CANDIDATES_ENRICHED = 12;
export const MODE_ROTATION: DiscoveryMode[] = [
  "practical",
  "underdog",
  "popular",
  "emerging",
];
/** `null` means "never re-use a completed repository". */
export const ALLOW_REVISIT_AFTER_DAYS: number | null = null;
export const MAX_ATTEMPTS = 3;
/** A `processing` reservation older than this is considered interrupted. */
export const RESERVATION_TIMEOUT_MINUTES = 30;

/* ------------------------------------------------------------------ */
/* Narration                                                           */
/* ------------------------------------------------------------------ */

export const FACT_CONFIDENCE_THRESHOLD = 0.5;
export const MAX_REPEATED_TEMPLATE_USAGE = 2;

/* ------------------------------------------------------------------ */
/* TTS                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Configurable narrator preset. `am_fenrir` is the locked baseline voice —
 * auditioned against `am_liam`, `am_puck` and `am_michael` on the identical
 * script in `tools/audition/`. Speed 1.0 vs 1.05 is tuned by listening; the
 * *delivery* (young, curious, conversational) comes from the writing, the
 * punctuation and the brief measured pauses between segments, not from an
 * emotion knob — Kokoro has none.
 */
export const VOICE_PRESET = {
  id: process.env.KOKORO_VOICE ?? "am_fenrir",
  /** 1.0 is natural conversational speed; the voice must not sound rushed. */
  speed: readNumber(process.env.KOKORO_SPEED, 1.0),
  language: process.env.KOKORO_LANG ?? "en-us",
} as const;

/** Backwards-compatible views onto the preset, used across the pipeline. */
export const TTS_VOICE: string = VOICE_PRESET.id;
export const TTS_SPEED: number = VOICE_PRESET.speed;
export const TTS_LANG: string = VOICE_PRESET.language;
export const TTS_PAUSE_BETWEEN_SEGMENTS_MS = readNumber(
  process.env.SHOWCASE_TTS_PAUSE_MS,
  120
);
export const TTS_MAX_RETRIES = 2;

/* ------------------------------------------------------------------ */
/* Script engine (evidence -> explanation -> composition)              */
/*                                                                     */
/* The pipeline has three deliberately separate stages:                */
/*   (1) repository understanding (facts + semantic roles),            */
/*   (2) script composition (graph path -> sentences),                 */
/*   (3) speech delivery (pause schedule + TTS + timeline).            */
/* These weights are tunable defaults, not claims of precision.        */
/* ------------------------------------------------------------------ */

/** Evidence ranking weights; must sum to 1. */
export const EVIDENCE_WEIGHTS = {
  strength: 0.3,
  specificity: 0.25,
  actionability: 0.2,
  relevance: 0.15,
  novelty: 0.1,
} as const;

/** Narrative-path scoring weights. */
export const PATH_WEIGHTS = {
  relation: 0.5,
  redundancy: 0.7,
  metadata: 0.6,
} as const;

/** Evidence quality floor; below this a fact may still be spoken but not relied on. */
export const EVIDENCE_STRENGTH_FLOOR = 0.5;

/** Scriptability gate: can this repository support an honest explanation? */
export const SCRIPTABILITY = {
  threshold: readNumber(process.env.SHOWCASE_SCRIPTABILITY_MIN, 0.65),
  weights: { purpose: 0.25, how: 0.35, example: 0.25, diversity: 0.15 },
} as const;

/** A practical use case is mandatory whenever this much example evidence exists. */
export const MIN_EXAMPLE_EVIDENCE = 0.55;

/**
 * Phrase-level pause policy (milliseconds). One schedule is shared by
 * `concatChunks()` and `toTimedChunks()` so the audio and the visual timeline
 * can never diverge. Values are starting points, calibrated by listening.
 */
export const TTS_PAUSE_POLICY = {
  /** Continuation of the same explanatory thought. */
  continuation: { min: 80, max: 130, default: 100 },
  /** Transition to a new mechanism or idea. */
  newIdea: { min: 140, max: 200, default: 170 },
  /** Before a concrete example. */
  example: { min: 180, max: 240, default: 200 },
  /** Before a genuine contrast or limitation. */
  contrast: { min: 220, max: 300, default: 260 },
  /** Before installation or closing. */
  closing: { min: 140, max: 220, default: 180 },
} as const;

export type PauseKind = keyof typeof TTS_PAUSE_POLICY;

/** Hard ceiling on a single inter-segment pause; guards against runaway gaps. */
export const MAX_PAUSE_MS = 400;

/** Clamp a requested pause to its kind's range (and the hard ceiling). */
export function pauseFor(kind: PauseKind, requested?: number): number {
  const range = TTS_PAUSE_POLICY[kind];
  const value = requested ?? range.default;
  return Math.max(0, Math.min(MAX_PAUSE_MS, Math.min(range.max, Math.max(range.min, value))));
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export const STAGE_BG = "#F2EFE9";
export const CARD_BG = "#0D1117";
export const CARD = {
  width: 810,
  height: 1668,
  left: 135,
  top: 126,
  radius: 52,
  border: "1px solid rgba(255,255,255,0.14)",
} as const;

/**
 * Stationary-card geometry. The card, its border, its shadow, the browser bar,
 * the caption overlay and the character never move. Only `.document` (the tall
 * page screenshot) is translated inside the clipped `.viewport`.
 *
 * There is deliberately no caption zone and no progress zone: captions float
 * over the page and the editor-style scrubber was removed entirely.
 */
export const CARD_CHROME_HEIGHT = 84;
export const CARD_VIEWPORT_HEIGHT = CARD.height - CARD_CHROME_HEIGHT;
export const VIEWPORT_PADDING = 32;

/**
 * Caption overlay: speech-callout placement near the mascot's head.
 *
 * The mascot owns the lower-right corner, so captions hang just *above* its
 * head like a callout: the block's bottom edge sits `headGapPx` above the
 * head-top line computed by `src/mascot-layout.ts`. Horizontal ratios are
 * safe-area margins against the card viewport (platform UI overlays live in
 * the far corners). There is deliberately no fixed top position: the block
 * grows upward from the head.
 */
export const CAPTION_OVERLAY = {
  /** Canvas-coordinate geometry of the stable caption group. */
  leftPx: 165,
  topPx: 876,
  widthPx: 718,
  maxHeightPx: 314,
} as const;

/**
 * Scroll policy. The page must reveal continuously without ever racing:
 * `targetPxPerSecond` is the pacing aim, `maxPxPerSecond` is a hard ceiling
 * used by the timeline to repair a too-dense plan.
 */
export const SCROLL = {
  introHoldMs: 450,
  outroHoldMs: 650,
  targetPxPerSecond: 150,
  maxPxPerSecond: 190,
  minMoveMs: 1400,
  maxMoveMs: 5000,
  settleMs: 250,
  /** If a landmark gap exceeds this many viewports, insert a midpoint stop. */
  maxLandmarkGapViewports: 1.35,
} as const;

/* ------------------------------------------------------------------ */
/* Real mobile page capture                                            */
/* ------------------------------------------------------------------ */

export const MOBILE_PAGE = {
  viewportWidthCss: 405,
  viewportHeightCss: 720,
  deviceScaleFactor: 2,
  /** Content width of the card viewport, in output pixels. */
  displayWidthPx: CARD.width,
  /** Never tour more than this many page viewports in one Reel. */
  maxStoryViewports: 5.5,
  /** A story is at least this many viewports tall so the reveal has substance. */
  minStoryViewports: 2.4,
  settleMs: 800,
  navigationTimeoutMs: 20_000,
  jpegQuality: 94,
  /** Hard cap for very long READMEs; keeps canvas stitching tractable. */
  maxCaptureCssHeight: 6_000,
  /** Chromium captures beyond this many raster pixels are tiled. */
  tileRasterHeight: 8_000,
} as const;

/* ------------------------------------------------------------------ */
/* Character layer                                                     */
/* ------------------------------------------------------------------ */

function readCharacterPath(): string | null {
  const raw = process.env.SHOWCASE_CHARACTER_PNG;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
    return path.resolve(ROOT, trimmed);
  }
  return path.join(ROOT, "assets", "character.png");
}

function readOptionalCharacterPath(envKey: string, fallback: string): string | null {
  const raw = process.env[envKey];
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
    return path.resolve(ROOT, trimmed);
  }
  return path.join(ROOT, fallback);
}

/** `null` disables the character layer entirely. */
export const CHARACTER_PNG = readCharacterPath();

/**
 * Optional presenter poses. The renderer falls back to `CHARACTER_PNG` for any
 * pose that is missing, so a single cut-out still works. Supply separate
 * transparent artwork through the environment for true hand/arm gestures.
 */
export const CHARACTER_POSE_PNGS = {
  present: CHARACTER_PNG,
  point: readOptionalCharacterPath("SHOWCASE_CHARACTER_POINT_PNG", "assets/character.png"),
  close: readOptionalCharacterPath("SHOWCASE_CHARACTER_CLOSE_PNG", "assets/character-close.png"),
} as const;

/**
 * Dedicated mascot placement config (Visual Composition Pass). The presenter
 * is sized by *width ratio of the output canvas* and anchored to the
 * lower-right corner of the stage — not the card — so it fills the marked
 * presentation area.
 *
 * Anchoring is alpha-aware: `offsetX` / `offsetY` are the *deliberate clip* in
 * canvas px of the visible artwork beyond the right/bottom canvas edge (the
 * transparent PNG padding is subtracted first by `src/mascot-layout.ts`), so
 * invisible PNG margins never push the character off the corner. The
 * 1080x1920 viewport clips the overflow — "extends partially past the frame"
 * by design, never by accident.
 */
export type MascotLayout = {
  anchor: "bottom-right";
  /** Fraction of the 1080 px canvas width, applied to the PNG rectangle. */
  widthRatio: number;
  /** CSS `right` offset in canvas px (negative = extends past edge). */
  offsetX: number;
  /** CSS `bottom` offset in canvas px (negative = extends past edge). */
  offsetY: number;
  /** Guarantee the head stays inside the canvas (guards against extreme sizes). */
  keepFaceVisible: boolean;
};

export const MASCOT_LAYOUT: MascotLayout = {
  anchor: "bottom-right",
  // CSS right/bottom offsets (negative = extends past canvas edge).
  widthRatio: readNumber(process.env.SHOWCASE_MASCOT_WIDTH_RATIO, 0.8731),
  offsetX: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_X, -60),
  offsetY: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_Y, -23),
  keepFaceVisible: true,
};

/**
 * The character is a whole cut-out: only its body moves. Motion values only —
 * size and placement live in `MASCOT_LAYOUT`. The presenter is sized by width
 * so every pose keeps the same apparent scale on the canvas.
 */
export const CHARACTER = {
  /** Alpha-mask shadow: drop-shadow follows the cut-out silhouette, never a
   * rectangle, and always renders *behind* the artwork. Soft, dark, offset
   * downward; the blur scales with the rendered mascot size. */
  shadow: "drop-shadow(0 10px 54px rgba(0,0,0,1))",
  idleBobPx: 2,
  speechBobPx: 6,
  tiltDeg: 1.1,
  speechTiltDeg: 0.75,
  scaleGain: 0.004,
} as const;

/**
 * Captions are fixed size and position. The page scrolls behind them, so they
 * need an outline/shadow strong enough to survive both dark and light READMEs.
 */
export const CHARACTER_ENVELOPE_RATE_HZ = 25;

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export const DB_PATH = process.env.SHOWCASE_DB
  ? path.resolve(process.env.SHOWCASE_DB)
  : path.join(OUTPUT_DIR, "showcase-history.db");