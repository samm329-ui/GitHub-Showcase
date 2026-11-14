/**
 * Long-form production profile — completely separate from Short-form.
 *
 * Nothing in this file touches or imports Short-form policy constants
 * (MAX_DURATION_SECONDS, VIEWPORT, CARD, MASCOT_LAYOUT, …). The 58-second
 * Short-form ceiling is deliberately absent here: the episode duration is
 * whatever the measured narration says it is. There is no hard truncation.
 */
import path from "node:path";
import { ROOT } from "../config.js";

export const LONGFORM = {
  width: 1920,
  height: 1080,
  fps: 30,
  aspect: "16:9",
  /** Soft target window; never enforced by truncation. */
  targetDurationSeconds: 285,
  softMinSeconds: 270,
  softMaxSeconds: 315,
  codec: "h264",
  profile: "high",
  level: "4.0",
  crf: 20,
  preset: "veryfast",
  pixelFormat: "yuv420p",
  audio: { codec: "aac", bitrate: "192k", sampleRate: 48000, channels: 2 },
  loudness: { integrated: -14, truePeak: -1.5, lra: 11 },
  /** Safe margins (px) for captions/callouts. */
  safeMarginX: 100,
  safeMarginBottom: 100,
  /** Approx. frame count guardrail for bounded buffering (not a content limit). */
  maxEpisodeFrames: 30 * 60 * 20, // 20 minutes of headroom in frame units
} as const;

export const OUTPUT_DIR_LONGFORM = process.env.LONGFORM_OUTPUT_DIR
  ? path.resolve(process.env.LONGFORM_OUTPUT_DIR)
  : path.join(ROOT, "output", "longform");
export const TEMP_DIR_LONGFORM = process.env.LONGFORM_TEMP_DIR
  ? path.resolve(process.env.LONGFORM_TEMP_DIR)
  : path.join(ROOT, "temp", "longform");
export const LONGFORM_DB_PATH = process.env.LONGFORM_DB
  ? path.resolve(process.env.LONGFORM_DB)
  : path.join(ROOT, "db", "longform-history.db");

/** Mascot assets — user-supplied, see assets/longform/asset-licenses.json. */
export const MASCOT_ASSETS = {
  escort: path.join(ROOT, "assets", "longform", "mascot", "mascot-intro-escort-cutout.png"),
  explainerPoint: path.join(ROOT, "assets", "longform", "mascot", "mascot-explainer-point.png"),
  explainerPresent: path.join(ROOT, "assets", "longform", "mascot", "mascot-explainer-present-cutout.png"),
} as const;

export const MUSIC_BED = path.join(
  ROOT,
  "assets",
  "longform",
  "music",
  "longform_background_bed.mp3"
);

export const SFX = {
  mascotEntry: path.join(ROOT, "assets", "longform", "sfx", "sfx_mascot_entry_whoosh.mp3"),
  mascotLanding: path.join(ROOT, "assets", "longform", "sfx", "sfx_mascot_land_impact.mp3"),
  mascotExit: path.join(ROOT, "assets", "longform", "sfx", "sfx_mascot_exit_whoosh.wav"),
  calloutPop: path.join(ROOT, "assets", "longform", "sfx", "sfx_callout_pop.wav"),
  captionTick: path.join(ROOT, "assets", "longform", "sfx", "sfx_caption_tick.wav"),
  captionImpact: path.join(ROOT, "assets", "longform", "sfx", "sfx_caption_impact.mp3"),
  revealHit: path.join(ROOT, "assets", "longform", "sfx", "sfx_repository_card_hit.mp3"),
  titleReveal: path.join(ROOT, "assets", "longform", "sfx", "sfx_card_reveal.wav"),
  cameraPush: path.join(ROOT, "assets", "longform", "sfx", "sfx_camera_push.wav"),
  zoomImpact: path.join(ROOT, "assets", "longform", "sfx", "sfx_zoom_impact.wav"),
  codeHighlight: path.join(ROOT, "assets", "longform", "sfx", "sfx_code_highlight.wav"),
  featureReveal: path.join(ROOT, "assets", "longform", "sfx", "sfx_feature_reveal.wav"),
  outroSoftHit: path.join(ROOT, "assets", "longform", "sfx", "sfx_outro_soft_hit.mp3"),
} as const;

/** Design tokens (VIdeoDesignPhillosophy.md §14). */
export const TOKENS = {
  background: "#0B0F16",
  panel: "#101722",
  panelSecondary: "#111A26",
  accentBlue: "#63B8F2",
  accentYellow: "#FFD166",
  textPrimary: "#F5F7FA",
  textSupporting: "#AAB6C5",
  border: "#334155",
  /** Typography substitutes for the unsupplied Space Grotesk / Poppins / IBM Plex
   *  (all open-licensed; see assets/shared/fonts/LICENSES.md). */
  fontDisplay: "Inter",      // weights 700 / 900
  fontBody: "Inter",         // weight 700
  fontMono: "Roboto Mono",   // weight 400
} as const;

/** Caption styling (design §7). */
export const CAPTION = {
  fontSize: 62,
  emphasisFontSize: 92,
  supportFontSize: 46,
  maxCharsPerLine: 26,
  maxLines: 2,
  /** Deterministic style distribution (design §7.8 guidance). */
  styleWeights: { staticFocus: 0.55, slide: 0.2, pop: 0.15, reveal: 0.1 },
} as const;

/** Licensing gate (assets/longform/asset-licenses.json). */
export const ALLOW_UNVERIFIED_ASSETS =
  process.env.LONGFORM_ALLOW_UNVERIFIED_ASSETS === "1";

export function longformWorkDir(episodeId: string): string {
  return path.join(TEMP_DIR_LONGFORM, episodeId);
}

/** Episode phases in execution order (all UI-facing). */
export const PHASES = [
  "PREFLIGHT",
  "DATASET RECONCILIATION",
  "REPOSITORY SELECTION",
  "MASTER SCRIPT",
  "NARRATION AND ALIGNMENT",
  "REPOSITORY CAPTURE",
  "VISUAL COMPOSITION",
  "AUDIO PRODUCTION",
  "VIDEO RENDERING",
  "FINAL QA",
  "FINALIZATION",
] as const;
export type PhaseName = (typeof PHASES)[number];
