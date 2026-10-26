import fs from "node:fs/promises";
import path from "node:path";
// Side-effect import: `config-model.js` is a classic script that publishes its
// API on `globalThis.ShowcaseConfigModel`. Importing it here (rather than
// duplicating the logic) keeps the Node writer and the browser folder fallback
// on one implementation.
import "./config-model.js";

/**
 * One-click config persistence for the live preview.
 *
 * All rewriting lives in `tools/config-model.js` so the dev server (Node) and
 * the in-page folder fallback (browser) share exactly one implementation. This
 * module is only the filesystem wrapper: it reads the three source files, calls
 * the shared model, and writes back the files that actually changed.
 *
 * Two guarantees make the flow trustworthy:
 *
 *  1. Every rewrite must match *exactly one* location. If a pattern is missing
 *     or ambiguous the whole save fails, so a partial/corrupt write is
 *     impossible.
 *  2. `parsePreviewConfig` is the inverse of `writePreviewConfig`, so the
 *     preview can always reload the values that are actually in the codebase.
 */

/** Every value the live preview can author. */
export type PreviewConfig = {
  /** Mascot artwork filename inside `assets/` (uploaded or already present). */
  mascotAsset: string;
  /** Rendered mascot width in canvas px. */
  mascotWidthPx: number;
  /** CSS `right` offset in canvas px (negative = past the edge). */
  mascotRight: number;
  /** CSS `bottom` offset in canvas px (negative = past the edge). */
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
  highlightBackground: string;
  highlightText: string;
  /** Card width in canvas px; `left` is re-centred on save. */
  cardWidth: number;
  /** Card height in canvas px; `top` is re-centred on save. */
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

export type ConfigSources = {
  configTs: string;
  captionOverlayTs: string;
  cardTs: string;
};

/** The shape published by `tools/config-model.js`. */
type ConfigModel = {
  CONFIG_PATHS: ConfigSources;
  VIEWPORT_WIDTH_PX: number;
  writePreviewConfig(sources: ConfigSources, config: PreviewConfig): ConfigSources;
  parsePreviewConfig(sources: ConfigSources): PreviewConfig;
  configDiff(before: PreviewConfig, after: PreviewConfig): (keyof PreviewConfig)[];
  normalizePreviewConfig(
    input: Record<string, unknown>,
    base: PreviewConfig
  ): PreviewConfig;
};

const model = (globalThis as unknown as { ShowcaseConfigModel: ConfigModel })
  .ShowcaseConfigModel;

if (!model) {
  throw new Error(
    "config-writer: tools/config-model.js did not publish ShowcaseConfigModel"
  );
}

/** Repo-relative paths of the files the writer owns. */
export const CONFIG_PATHS = model.CONFIG_PATHS;

export const VIEWPORT_WIDTH_PX = model.VIEWPORT_WIDTH_PX;

export const writePreviewConfig = model.writePreviewConfig;
export const parsePreviewConfig = model.parsePreviewConfig;
export const configDiff = model.configDiff;
export const normalizePreviewConfig = model.normalizePreviewConfig;

async function readConfigSources(root: string): Promise<ConfigSources> {
  const [configTs, captionOverlayTs, cardTs] = await Promise.all([
    fs.readFile(path.join(root, CONFIG_PATHS.configTs), "utf8"),
    fs.readFile(path.join(root, CONFIG_PATHS.captionOverlayTs), "utf8"),
    fs.readFile(path.join(root, CONFIG_PATHS.cardTs), "utf8"),
  ]);
  return { configTs, captionOverlayTs, cardTs };
}

/** Read the values currently committed in the codebase. */
export async function readPreviewConfig(root: string): Promise<PreviewConfig> {
  return parsePreviewConfig(await readConfigSources(root));
}

/**
 * Write the config into the codebase. Only changed files are touched, and the
 * write is all-or-nothing: `writePreviewConfig` throws before any file is
 * written if a target pattern is missing.
 */
export async function applyPreviewConfig(
  root: string,
  config: PreviewConfig
): Promise<{ files: string[]; fields: (keyof PreviewConfig)[] }> {
  const sources = await readConfigSources(root);
  const before = parsePreviewConfig(sources);
  const next = writePreviewConfig(sources, config);

  const files: string[] = [];
  for (const key of Object.keys(CONFIG_PATHS) as (keyof ConfigSources)[]) {
    if (sources[key] === next[key]) continue;
    await fs.writeFile(path.join(root, CONFIG_PATHS[key]), next[key], "utf8");
    files.push(CONFIG_PATHS[key]);
  }
  return { files, fields: configDiff(before, config) };
}
