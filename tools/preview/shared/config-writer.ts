import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
// Side-effect import: `config-model.js` is a classic script that publishes its
// API on `globalThis.ShowcaseConfigModel`. Importing it here (rather than
// duplicating the logic) keeps the Node writer and the browser folder fallback
// on one implementation.
import "./config-model.js";
import type { VisualOverrides } from "../../../src/visual-overrides.js";

/**
 * One-click config persistence for the live preview.
 *
 * The preview authors exactly one file: `visual-overrides.json` at the
 * repository root. All coercion/validation lives in `tools/preview/shared/config-model.js`
 * so the dev server (Node) and the in-page folder fallback (browser) share one
 * implementation and can never drift apart.
 *
 * The write is all-or-nothing: the file is written to a temp sibling and
 * renamed over the target, so a crash mid-save can never leave a truncated
 * `visual-overrides.json` for the pipeline to choke on.
 */

/** Every value the live preview can author (the shape of the file). */
export type PreviewConfig = VisualOverrides;

/** The shape published by `tools/preview/shared/config-model.js`. */
type ConfigModel = {
  VIEWPORT_WIDTH_PX: number;
  VIEWPORT_HEIGHT_PX: number;
  OVERRIDES_FILENAME: string;
  DEFAULT_PREVIEW_CONFIG: PreviewConfig;
  normalizePreviewConfig(
    input: Record<string, unknown>,
    base: PreviewConfig
  ): PreviewConfig;
  serializeVisualOverrides(config: PreviewConfig): string;
  parseVisualOverrides(text: string): PreviewConfig;
  configDiff(before: PreviewConfig, after: PreviewConfig): (keyof PreviewConfig)[];
};

const model = (globalThis as unknown as { ShowcaseConfigModel: ConfigModel })
  .ShowcaseConfigModel;

if (!model) {
  throw new Error(
    "config-writer: tools/preview/shared/config-model.js did not publish ShowcaseConfigModel"
  );
}

export const VIEWPORT_WIDTH_PX = model.VIEWPORT_WIDTH_PX;
export const VIEWPORT_HEIGHT_PX = model.VIEWPORT_HEIGHT_PX;
export const OVERRIDES_FILENAME = model.OVERRIDES_FILENAME;
export const DEFAULT_PREVIEW_CONFIG = model.DEFAULT_PREVIEW_CONFIG;

export const normalizePreviewConfig = model.normalizePreviewConfig;
export const serializeVisualOverrides = model.serializeVisualOverrides;
export const parseVisualOverrides = model.parseVisualOverrides;
export const configDiff = model.configDiff;

/** Repo-relative path of the file the preview owns. */
export const OVERRIDES_PATH = OVERRIDES_FILENAME;

async function readOverridesText(root: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, OVERRIDES_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read the composition currently in effect: the file when present and
 *  parseable, the committed defaults otherwise. */
export async function readPreviewConfig(root: string): Promise<PreviewConfig> {
  const text = await readOverridesText(root);
  if (text === null) return model.DEFAULT_PREVIEW_CONFIG;
  try {
    return model.parseVisualOverrides(text);
  } catch {
    // A corrupt file must not brick the preview: the page reloads on the
    // committed defaults and can save again.
    return model.DEFAULT_PREVIEW_CONFIG;
  }
}

/**
 * Write the config into `visual-overrides.json`. The write is atomic
 * (temp sibling + rename) and nothing else is touched.
 */
export async function applyPreviewConfig(
  root: string,
  config: PreviewConfig
): Promise<{ files: string[]; fields: (keyof PreviewConfig)[] }> {
  const before = await readPreviewConfig(root);
  const next = model.normalizePreviewConfig(
    config as unknown as Record<string, unknown>,
    model.DEFAULT_PREVIEW_CONFIG
  );
  const fields = model.configDiff(before, next);
  const serialized = model.serializeVisualOverrides(next);

  const previous = await readOverridesText(root);
  if (previous === serialized) {
    return { files: [], fields };
  }

  const target = path.join(root, OVERRIDES_PATH);
  const temp = path.join(
    root,
    `.${OVERRIDES_PATH}.${process.pid}.tmp`
  );
  await fs.writeFile(temp, serialized, "utf8");
  await fs.rename(temp, target);
  // Best-effort hygiene for the temp file if rename threw before this point.
  try {
    if (fsSync.existsSync(temp)) await fs.unlink(temp);
  } catch {
    /* ignore */
  }
  return { files: [OVERRIDES_PATH], fields };
}

