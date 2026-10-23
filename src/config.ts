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
/* Render                                                              */
/* ------------------------------------------------------------------ */

export const STAGE_BG = "#F2EFE9";
export const CARD_BG = "#0D1117";
export const CARD = {
  width: 810,
  height: 1668,
  left: 135,
  top: 126,
  radius: 28,
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

/** Caption overlay: fixed relative to the viewport, lower-middle of the card. */
export const CAPTION_OVERLAY = {
  /** Distance from the top of the clipped page viewport. */
  topRatio: 0.66,
  leftRatio: 0.05,
  rightRatio: 0.05,
  maxWidthRatio: 0.92,
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
  settleMs: 1400,
  navigationTimeoutMs: 45_000,
  jpegQuality: 94,
  /** Hard cap for very long READMEs; keeps canvas stitching tractable. */
  maxCaptureCssHeight: 9_000,
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
 * Dedicated mascot placement config (Phase 1). The presenter is sized by
 * *width ratio of the output canvas* and anchored to the lower-right corner
 * of the stage — not the card — so it fills the marked presentation area.
 *
 * CSS semantics: `right: offsetX` / `bottom: offsetY`. Negative offsets push
 * the layer beyond the canvas edge; the 1080x1920 viewport clips it, which is
 * exactly the "extends partially past the frame" behaviour.
 */
export type MascotLayout = {
  anchor: "bottom-right";
  /** Fraction of the 1080 px canvas width. 0.46 is the tested initial value. */
  widthRatio: number;
  offsetX: number;
  offsetY: number;
  /** Allow the artwork to overflow past the canvas edges (clipped, not clamped). */
  allowOffscreen: boolean;
  /** Guarantee the head stays inside the canvas (guards against extreme sizes). */
  keepFaceVisible: boolean;
};

export const MASCOT_LAYOUT: MascotLayout = {
  anchor: "bottom-right",
  widthRatio: readNumber(process.env.SHOWCASE_MASCOT_WIDTH_RATIO, 0.46),
  offsetX: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_X, -12),
  offsetY: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_Y, 0),
  allowOffscreen: true,
  keepFaceVisible: true,
};

/**
 * The character is a whole cut-out: only its body moves. Motion values only —
 * size and placement live in `MASCOT_LAYOUT`. The presenter is sized by width
 * so every pose keeps the same apparent scale on the canvas.
 */
export const CHARACTER = {
  shadow: "drop-shadow(0 12px 20px rgba(0,0,0,0.38))",
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