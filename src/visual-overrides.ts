/**
 * Visual overrides: optional presentation tuning authored in the live preview.
 *
 * The live preview (`tools/preview/preview-live.html`) used to rewrite literal
 * constants inside `src/config.ts`, `src/caption-overlay.ts` and `src/card.ts`.
 * That meant the “Save” button edited source code with regexes, and every
 * save dirtied three tracked files. Presentation tuning is now data:
 *
 *   <repo root>/visual-overrides.json   — written by the preview, gitignored
 *
 * Precedence, lowest to highest:
 *   1. the built-in defaults in this file (the committed composition);
 *   2. `visual-overrides.json`, if present and parseable;
 *   3. environment variables (e.g. `SHOWCASE_CAPTION_TOP_PX`), where a variable
 *      exists for the knob — env always wins, exactly as it did before.
 *
 * The pipeline never crashes on a hand-edited or half-written file: a missing
 * file is simply the defaults, and an unparseable/invalid file is ignored
 * with a one-line warning. The failure mode of this file is “yesterday’s
 * look”, never a broken build.
 */
import fs from "node:fs";
import path from "node:path";

export const VISUAL_OVERRIDES_FILENAME = "visual-overrides.json";

/** Every value the live preview can author. All fields are required in the
 * file; the preview always writes the complete object. */
export type VisualOverrides = {
  mascotAsset: string;
  mascotWidthPx: number;
  mascotRight: number;
  mascotBottom: number;
  mascotShadowOffsetY: number;
  mascotShadowBlur: number;
  mascotShadowOpacity: number;
  captionLeft: number;
  captionTop: number;
  captionWidth: number;
  captionMaxHeight: number;
  captionFontFamily: string;
  captionFontWeight: number;
  captionFontSize: number;
  captionLineHeight: number;
  captionLetterSpacing: number;
  captionColor: string;
  captionShadowOffsetY: number;
  captionShadowBlur: number;
  captionShadowOpacity: number;
  /** Accent pill background; the active-word colour is `highlightText`. */
  highlightBackground: string;
  /** Text colour while the word sits on the accent pill. */
  highlightText: string;
  cardWidth: number;
  cardHeight: number;
  cardRadius: number;
  cardShadowIntensity: number;
  cardShadowBlurScale: number;
  enterMs: number;
  enterYPx: number;
  enterScale: number;
  exitMs: number;
  exitYPx: number;

  calloutEnabled: boolean;
  calloutBubbleWidth: number;
  calloutBubbleHeight: number;
  calloutLeftMin: number;
  calloutRightMargin: number;
  calloutTopOffset: number;
  calloutTopMin: number;
  calloutTopMax: number;
  calloutFaceOffset: number;
  calloutEnterMs: number;
  calloutExitMs: number;
  calloutEnterY: number;
  calloutExitY: number;
  calloutEnterScale: number;
  calloutExitScale: number;
  calloutMinVisibleMs: number;
  calloutMaxVisibleMs: number;
  calloutInterGapMs: number;
  calloutMaxCues: number;
  calloutFill: string;
  calloutOutline: string;
  calloutOutlineWidth: number;
  calloutAccent: string;
  calloutAccentOffsetX: number;
  calloutAccentOffsetY: number;
  calloutTextColor: string;
  calloutFontSize: number;
  calloutFontWeight: number;
  calloutLineHeight: number;

  impactEnabled: boolean;
  impactStrokeColor: string;
  impactStrokeWidth: number;
  impactPeakOpacity: number;
  impactMinBurstCount: number;
  impactMaxBurstCount: number;
  impactMinIntervalMs: number;
  impactJitterMs: number;
  impactBurstDurationMs: number;
  impactLineStaggerMs: number;
};

/** The committed composition. These equal the constants the sources carried
 * before overrides existed, so a repository without the file renders exactly
 * as it always did. `tools/preview/config-model.js` carries an identical copy
 * for the browser fallback; `tests/config-model.test.ts` asserts they match. */
export const DEFAULT_VISUAL_OVERRIDES: VisualOverrides = {
  mascotAsset: "mascot-custom.png",
  mascotWidthPx: 681, // 0.6306 × 1080
  mascotRight: -60,
  mascotBottom: 462,
  mascotShadowOffsetY: 24,
  mascotShadowBlur: 54,
  mascotShadowOpacity: 1,
  captionLeft: 205,
  captionTop: 1388,
  captionWidth: 680,
  captionMaxHeight: 331,
  captionFontFamily: "'Roboto', 'Helvetica Neue', Arial, sans-serif",
  captionFontWeight: 900,
  captionFontSize: 45,
  captionLineHeight: 0.94,
  captionLetterSpacing: -1.1,
  captionColor: "#000000",
  captionShadowOffsetY: 2,
  captionShadowBlur: 6,
  captionShadowOpacity: 0.25,
  highlightBackground: "#FFD500",
  highlightText: "#151619",
  cardWidth: 810,
  cardHeight: 1668,
  cardRadius: 60,
  cardShadowIntensity: 0.3,
  cardShadowBlurScale: 0.85,
  enterMs: 160,
  enterYPx: 12,
  enterScale: 0.98,
  exitMs: 120,
  exitYPx: 6,

  calloutEnabled: true,
  calloutBubbleWidth: 357,
  calloutBubbleHeight: 400,
  calloutLeftMin: 630,
  calloutRightMargin: 0,
  calloutTopOffset: 17,
  calloutTopMin: 0,
  calloutTopMax: 871,
  calloutFaceOffset: 100,
  calloutEnterMs: 200,
  calloutExitMs: 180,
  calloutEnterY: 12,
  calloutExitY: 6,
  calloutEnterScale: 0.96,
  calloutExitScale: 0.01,
  calloutMinVisibleMs: 1200,
  calloutMaxVisibleMs: 3400,
  calloutInterGapMs: 550,
  calloutMaxCues: 5,
  calloutFill: "#161513",
  calloutOutline: "#FFFFFF",
  calloutOutlineWidth: 5,
  calloutAccent: "#FFE66D",
  calloutAccentOffsetX: -3,
  calloutAccentOffsetY: 8,
  calloutTextColor: "#1A1A1A",
  calloutFontSize: 31,
  calloutFontWeight: 800,
  calloutLineHeight: 1,

  impactEnabled: true,
  impactStrokeColor: "#FFE66D",
  impactStrokeWidth: 5,
  impactPeakOpacity: 0.88,
  impactMinBurstCount: 2,
  impactMaxBurstCount: 6,
  impactMinIntervalMs: 500,
  impactJitterMs: 120,
  impactBurstDurationMs: 360,
  impactLineStaggerMs: 45,
};

const NUMBER_KEYS = Object.keys(DEFAULT_VISUAL_OVERRIDES).filter(
  key => typeof (DEFAULT_VISUAL_OVERRIDES as Record<string, unknown>)[key] === "number"
) as (keyof VisualOverrides & string)[];

const STRING_COLOR_KEYS = [
  "captionColor",
  "highlightBackground",
  "highlightText",
  "calloutFill",
  "calloutOutline",
  "calloutAccent",
  "calloutTextColor",
  "impactStrokeColor",
] as const;

const BOOLEAN_KEYS = ["calloutEnabled", "impactEnabled"] as const;

/** Clamp a card dimension into a range that always keeps the card on-canvas. */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Normalise a hex colour to `#UPPERCASE`; anything that does not look like a
 * hex colour falls back to the default rather than rendering broken CSS. */
function hex(value: unknown, fallback: string): string {
  const trimmed = String(value ?? "").trim();
  const withHash = trimmed.charAt(0) === "#" ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(withHash) ? withHash.toUpperCase() : fallback;
}

/**
 * A mascot asset must be a bare filename: no directories, no quotes, nothing
 * that could break out of `path.join(ROOT, "assets", …)`.
 */
function sanitizeAssetFilename(value: unknown): string {
  const name = String(value ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/["'<>:|?*\u0000-\u001f]/g, "")
    .trim();
  return name || "character.png";
}

/** Coerce untrusted JSON into a complete, valid override object. Unknown keys
 * are dropped; invalid values fall back to the default for that key. */
export function normalizeVisualOverrides(
  input: Record<string, unknown> | null | undefined,
  base: VisualOverrides = DEFAULT_VISUAL_OVERRIDES
): VisualOverrides {
  const source = input && typeof input === "object" ? input : {};
  const out: Record<string, unknown> = { ...base };

  for (const key of NUMBER_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    out[key] = finiteNumber(source[key], base[key] as number);
  }
  for (const key of BOOLEAN_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    out[key] = Boolean(source[key]);
  }
  for (const key of STRING_COLOR_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    out[key] = hex(source[key], base[key]);
  }
  if (source.captionFontFamily !== undefined && source.captionFontFamily !== null) {
    out.captionFontFamily = String(source.captionFontFamily);
  }
  out.mascotAsset = sanitizeAssetFilename(source.mascotAsset ?? base.mascotAsset);

  // A card that leaves the stage is never the intent of a tuning file.
  out.cardWidth = clampInt(finiteNumber(out.cardWidth, base.cardWidth), 360, 1000);
  out.cardHeight = clampInt(finiteNumber(out.cardHeight, base.cardHeight), 560, 1860);
  out.mascotWidthPx = Math.min(1600, Math.max(100, finiteNumber(out.mascotWidthPx, base.mascotWidthPx)));

  return out as unknown as VisualOverrides;
}

function visualOverridesPath(root: string): string {
  return path.join(root, VISUAL_OVERRIDES_FILENAME);
}

/** Load and normalize the file, or `null` when absent/invalid (defaults win). */
export function loadVisualOverrides(root = process.cwd()): VisualOverrides | null {
  const file = visualOverridesPath(root);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[visual-overrides] cannot read ${file}: ${(error as Error).message}`);
    return null;
  }
  try {
    // Tolerate a BOM: Notepad and PowerShell both write UTF-8 with a BOM.
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return normalizeVisualOverrides(parsed);
  } catch (error) {
    console.warn(
      `[visual-overrides] ignoring ${file}: ${(error as Error).message}`
    );
    return null;
  }
}

/** The overrides in effect for this process, resolved once at import time. */
export const VISUAL_OVERRIDES: VisualOverrides | null = loadVisualOverrides();
