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

export const TTS_VOICE = process.env.KOKORO_VOICE ?? "af_heart";
export const TTS_SPEED = Number(process.env.KOKORO_SPEED ?? "1.0");
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
 * Stationary-card geometry. The card, its border, its shadow, the browser
 * bar, the captions and the progress bar never move. Only `.repo-viewport`
 * clips a scrolling `.repo-document`.
 */
export const CARD_CHROME_HEIGHT = 84;
export const CARD_CAPTION_ZONE = 210;
export const CARD_PROGRESS_ZONE = 64;
export const VIEWPORT_PADDING = 48;

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export const DB_PATH = process.env.SHOWCASE_DB
  ? path.resolve(process.env.SHOWCASE_DB)
  : path.join(OUTPUT_DIR, "showcase-history.db");