import fs from "node:fs";
import path from "node:path";
import type { CalloutAssetProfile, DiscoveryMode, ImpactAnchor } from "./types.js";

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

/**
 * One canonical accent for the whole composition. The caption pill, the
 * callout's offset accent and every yellow accent read this token (or the
 * config-writer-backed defaults that are asserted equal to it), so the
 * overlay can never drift into three different yellows.
 */
export const ACCENT_YELLOW = "#FFE66D";
/** Near-black used for callout text and the active karaoke word. */
export const INK = "#151619";
/**
 * Card geometry. The live preview rewrites `width`/`height` as one anchored
 * block and re-centres `left`/`top` on the 1080x1920 stage in the same write,
 * so the card can never end up off-centre or half-updated.
 */
export const CARD = {
  width: 810,
  height: 1668,
  left: 135,
  top: 126,
  radius: 60,
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
 * Caption panel: a dark backing plate for the current spoken phrase.
 *
 * The panel is what keeps subtitles legible over arbitrary README content.
 * It is a separate layer from the moving yellow word pill: the panel holds the
 * phrase steady, while exactly one rounded accent pill travels behind the word
 * actually being spoken.
 */
export const CAPTION_PANEL_STYLE = {
  background: "rgba(23,25,29,0.92)",
  border: "1px solid rgba(255,255,255,0.12)",
  radiusPx: 26,
  padXPx: 24,
  /** Vertical padding is trimmed before touching the font size (tuning pass). */
  padYPx: 10,
  shadow: "0 14px 32px rgba(0,0,0,0.25)",
  maxLines: 2,
} as const;

/**
 * Caption panel placement in canvas coordinates.
 *
 * The panel sits in the lower third, clear of the mascot's face and of the
 * Reels-style UI margins. These authored numbers are the committed
 * geometry the live preview reads and writes; `captionOverlayGeometry()`
 * layers validated environment overrides on top for device testing.
 */
export const CAPTION_OVERLAY = {
  leftPx: 205,
  topPx: 1590,
  widthPx: 680,
  maxHeightPx: 325,
} as const;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type CaptionOverlayGeometry = {
  leftPx: number;
  topPx: number;
  widthPx: number;
  maxHeightPx: number;
};

/**
 * One environment override, validated and clamped to the canvas.
 *
 * When the variable is absent (the normal path) the committed value passes
 * through untouched, so the geometry authored in the live preview renders at
 * exactly the position that was saved. The clamp only guards bad shell input.
 */
function envOverridePx(
  env: NodeJS.ProcessEnv,
  key: string,
  committed: number,
  min: number,
  max: number
): number {
  const raw = env[key];
  if (raw === undefined) return committed;
  return clampNumber(readNumber(raw, committed), min, max);
}

/**
 * Committed caption geometry with validated, canvas-clamped environment
 * overrides. Every override is parsed by `readNumber` (finite and positive)
 * and then clamped so an overlay can never be pushed outside the 1080x1920
 * canvas, even by a bad shell variable. The committed values themselves are
 * never clamped: `maxHeightPx` is a cap on panel growth, not the panel's real
 * height, so using it to bound `topPx` would silently drag a saved caption
 * upward in the render while the preview showed the saved position.
 */
export function captionOverlayGeometry(
  env: NodeJS.ProcessEnv = process.env
): CaptionOverlayGeometry {
  const leftPx = envOverridePx(
    env,
    "SHOWCASE_CAPTION_LEFT_PX",
    CAPTION_OVERLAY.leftPx,
    0,
    VIEWPORT.width - 240
  );
  const widthPx = envOverridePx(
    env,
    "SHOWCASE_CAPTION_WIDTH_PX",
    CAPTION_OVERLAY.widthPx,
    240,
    VIEWPORT.width - leftPx
  );
  const topPx = envOverridePx(
    env,
    "SHOWCASE_CAPTION_TOP_PX",
    CAPTION_OVERLAY.topPx,
    0,
    // A panel needs breathing room to stay visible; 120px is the smallest
    // two-line panel that still reads, so an override can reach lower than
    // the old maxHeight-based bound without leaving the canvas.
    VIEWPORT.height - 120
  );
  return {
    leftPx: Math.round(leftPx),
    topPx: Math.round(topPx),
    widthPx: Math.round(widthPx),
    maxHeightPx: CAPTION_OVERLAY.maxHeightPx,
  };
}

/* ------------------------------------------------------------------ */
/* Callout asset profiles                                              */
/* ------------------------------------------------------------------ */

function createAssetProfile(
  width: number,
  height: number,
  tailTip: { x: number; y: number },
  textSafeRect: { x: number; y: number; width: number; height: number },
  containsEmbeddedRays: boolean,
  containsEmbeddedArrow: boolean
): CalloutAssetProfile {
  return {
    widthPx: width,
    heightPx: height,
    tailTip,
    textSafeRect,
    containsEmbeddedRays,
    containsEmbeddedArrow,
  };
}

export const DEFAULT_CALLOUT_PROFILE: CalloutAssetProfile = createAssetProfile(
  1082,
  789,
  { x: 0.365, y: 0.944 },
  { x: 0.14, y: 0.22, width: 0.72, height: 0.48 },
  true,
  true
);

export const STICKER_CALLOUT_PROFILE: CalloutAssetProfile = createAssetProfile(
  1672,
  941,
  { x: 0.28, y: 0.92 },
  { x: 0.12, y: 0.16, width: 0.76, height: 0.52 },
  false,
  false
);

export const FALLBACK_SVG_CALLOUT_PROFILE: CalloutAssetProfile = createAssetProfile(
  360,
  285,
  { x: 82 / 360, y: (285 - 27) / 285 },
  { x: 28 / 360, y: 30 / 285, width: (360 - 56) / 360, height: (176 - 34) / 285 },
  false,
  false
);

export function getCalloutAssetProfile(assetPath?: string | null): CalloutAssetProfile {
  if (!assetPath) return FALLBACK_SVG_CALLOUT_PROFILE;
  const basename = path.basename(assetPath).toLowerCase();
  if (basename.includes("callout-bubble")) return DEFAULT_CALLOUT_PROFILE;
  if (basename.includes("comic speech bubble")) return STICKER_CALLOUT_PROFILE;
  return DEFAULT_CALLOUT_PROFILE;
}

/**
 * Callout bubble: short, evidence-backed summaries attached to the mascot's
 * head. Geometry is derived from the mascot's head anchor and active asset
 * profile at render time; the constants here are the authored shape, bounds
 * and motion.
 *
 * Motion is a pure function of media time (see `src/callout-overlay.ts`); there
 * are no CSS transitions and no browser timers, so a frame rendered out of
 * order looks exactly the same as one rendered in order.
 */
export const CALLOUT = {
  // Named `bubble*` deliberately: the live preview rewrites the caption's
  // `widthPx`, and two `widthPx` keys in this file would make that save
  // ambiguous (the writer refuses to guess).
  enabled: true,
  /** ~90% of the previous width so the bubble stops covering the page. */
  bubbleWidthPx: 340,
  bubbleHeightPx: 400,
  /** Rounded cloud body height before the tail. */
  bodyHeightPx: 176,
  /**
   * Clamp bounds so the tail can track the face without leaving the canvas.
   * `leftMinPx` sits below the right bound so the right margin — not the
   * minimum — decides the horizontal pin, keeping the bubble tucked toward
   * the mascot. The top band follows the measured head-top line: the body
   * stays above the head while the tail reaches down toward the glasses.
   */
  leftMinPx: 630,
  rightMarginPx: 0,
  /**
   * Head-relative drop from the measured head-top line. The window
   * [bodyHeightPx, height - tailInset] keeps the body above the head while
   * the tail reaches down toward the glasses, whatever the mascot scale.
   */
  topOffsetPx: 215,
  /**
   * Clamp band for the head-anchored top. It spans the canvas (minus the
   * bubble's own height) because the mascot itself can be lifted anywhere
   * over the frame by `MASCOT_LAYOUT.offsetY`; the anchor, not this band,
   * decides the position in the normal case.
   */
  topMinPx: 0,
  topMaxPx: 871,
  /** Tail tip, in callout-local pixels (derived from asset profile). */
  tailXLocalPx: 135,
  tailInsetPx: 15,
  /** The tail aims this far right of the measured face centre. */
  faceOffsetPx: 100,
  /** Entrance / exit / ray timing, all in media milliseconds. */
  enterMs: 200,
  rayMs: 140,
  exitMs: 180,
  enterYPx: 12,
  exitYPx: 6,
  enterScale: 0.96,
  exitScale: 0.01,
  /** Cue bounds relative to the measured audio chunk. */
  startLeadMs: 100,
  endTailMs: 200,
  minStartMs: 380,
  minVisibleMs: 1200,
  preferredVisibleMs: 2200,
  minCueDurationMs: 400,
  maxVisibleMs: 3400,
  interCalloutGapMs: 550,
  maxCues: 5,
  /** Copy limits: a bubble is a summary, never a second subtitle track. */
  minWords: 3,
  maxWords: 7,
  maxLines: 2,
  /** Visual tokens. */
  fill: "#FFFDF7",
  outline: "#151619",
  outlineWidthPx: 5,
  accent: "#FFE66D",
  accentOffsetX: -3,
  accentOffsetY: 8,
  text: "#151619",
  fontSizePx: 31,
  fontWeight: 900,
  lineHeight: 1,
  textPadXPx: 28,
  rayStrokePx: 6,
} as const;

/* ------------------------------------------------------------------ */
/* Mascot impact accents                                               */
/* ------------------------------------------------------------------ */

export const IMPACT_ACCENTS = {
  enabled: true,
  strokeColor: "#FFE66D",
  strokeWidthPx: 5,
  peakOpacity: 0.88,
  minBurstCount: 2,
  maxBurstCount: 6,
  minIntervalMs: 500,
  jitterMs: 120,
  burstDurationMs: 360,
  lineStaggerMs: 45,
  allowedAnchors: [
    "hair-left",
    "hair-right",
    "shoulder-left",
    "shoulder-right",
    "laptop-edge",
  ] as ImpactAnchor[],
  variationMode: "seeded" as const,
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

/**
 * Default mascot artwork, as a filename inside `assets/`.
 *
 * This is the one value the live preview rewrites when you pick a new
 * character image (`tools/preview-live.html` → Save), so the rendered
 * pipeline — including the pose fallbacks below — follows the choice.
 * `SHOWCASE_CHARACTER_PNG` still wins when set.
 */
export const CHARACTER_PNG_FILENAME = "mascot-custom.png";

function readCharacterPath(): string | null {
  const raw = process.env.SHOWCASE_CHARACTER_PNG;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
    return path.resolve(ROOT, trimmed);
  }
  return path.join(ROOT, "assets", CHARACTER_PNG_FILENAME);
}

function readOptionalCharacterPath(envKey: string): string | null {
  const raw = process.env[envKey];
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
    return path.resolve(ROOT, trimmed);
  }
  return null;
}

/** `null` disables the character layer entirely. */
export const CHARACTER_PNG = readCharacterPath();

function readCalloutPath(): string | null {
  const raw = process.env.SHOWCASE_CALLOUT_PNG;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
    return path.resolve(ROOT, trimmed);
  }
  const cropped = path.join(ROOT, "assets", "callout-bubble.png");
  if (fs.existsSync(cropped)) return cropped;
  const sticker = path.join(ROOT, "assets", "Comic Speech Bubble Sticker.png");
  if (fs.existsSync(sticker)) return sticker;
  return null;
}

/** Authentic comic speech bubble sticker asset. */
export const CALLOUT_PNG = readCalloutPath();

/**
 * Optional presenter poses. Any pose without dedicated artwork falls back to
 * `CHARACTER_PNG` — the chosen default mascot — so swapping the character in
 * the live preview replaces every pose, not just the standing one. Supply
 * separate transparent artwork through the environment for true hand/arm
 * gestures.
 */
export const CHARACTER_POSE_PNGS = {
  present: CHARACTER_PNG,
  point: readOptionalCharacterPath("SHOWCASE_CHARACTER_POINT_PNG") ?? CHARACTER_PNG,
  close: readOptionalCharacterPath("SHOWCASE_CHARACTER_CLOSE_PNG") ?? CHARACTER_PNG,
} as const;

/**
 * Dedicated mascot placement config (Visual Composition Pass). The presenter
 * is sized by *width ratio of the output canvas* and anchored to the
 * lower-right corner of the stage — not the card — so it fills the marked
 * presentation area.
 *
 * Anchoring is alpha-aware: `offsetX` / `offsetY` are signed offsets in canvas
 * px of the *visible artwork* from the right/bottom edge — positive lifts the
 * mascot inside the frame so the sliders can move it up and down anywhere over
 * the stage, negative lets it extend past the edge where the 1080x1920
 * viewport clips it. The transparent PNG padding is subtracted first by
 * `src/mascot-layout.ts`, so invisible margins never shift the visible edge.
 */
export type MascotLayout = {
  anchor: "bottom-right";
  /** Fraction of the 1080 px canvas width, applied to the PNG rectangle. */
  widthRatio: number;
  /** Signed visible offset from the right edge (+ = inside, − = past edge). */
  offsetX: number;
  /** Signed visible offset from the bottom edge (+ = lifted up, − = past edge). */
  offsetY: number;
  /** Guarantee the head stays inside the canvas (guards against extreme sizes). */
  keepFaceVisible: boolean;
};

export const MASCOT_LAYOUT: MascotLayout = {
  anchor: "bottom-right",
  // Signed visible offsets from the bottom-right edge (see MascotLayout).
  // 0.5889 ≈ the previous 0.6204 scaled by the 0.95 tuning pass (636 px wide;
  // chosen so widthRatio round-trips through the integer pixel width).
  widthRatio: readNumber(process.env.SHOWCASE_MASCOT_WIDTH_RATIO, 0.5889),
  offsetX: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_X, -60),
  offsetY: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_Y, 252),
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
  shadow: "drop-shadow(0 24px 54px rgba(0,0,0,1))",
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
/* Sound Effects (SFX)                                                */
/* ------------------------------------------------------------------ */

export type SfxEffectConfig = {
  enabled: boolean;
  asset: string;
  startOffsetMs: number;
  gain: number;
};

export type SfxConfig = {
  mascotEntrance: SfxEffectConfig;
  calloutPop: SfxEffectConfig;
};

export const SFX_CONFIG: SfxConfig = {
  mascotEntrance: {
    enabled: process.env.SHOWCASE_SFX_MASCOT !== "0",
    asset: path.join(ROOT, "assets", "sfx", "mascot-slide-whoosh.wav"),
    startOffsetMs: 0,
    gain: 0.18,
  },
  calloutPop: {
    enabled: process.env.SHOWCASE_SFX_CALLOUT !== "0",
    asset: path.join(ROOT, "assets", "sfx", "callout-pop.wav"),
    startOffsetMs: 20,
    gain: 0.14,
  },
};

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export const DB_PATH = process.env.SHOWCASE_DB
  ? path.resolve(process.env.SHOWCASE_DB)
  : path.join(OUTPUT_DIR, "showcase-history.db");