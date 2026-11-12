/* eslint-disable */
/**
 * Shared composition model for the live preview.
 *
 * This file is deliberately a CLASSIC script (no `import` / `export`): it must
 * load from a plain `<script src="config-model.js">` tag even when the preview
 * page is opened as `file://`, where Chrome/Edge reject ES modules. Node loads
 * it as a side-effect import and reads the API off `globalThis`, so both the
 * dev server and the folder fallback share one implementation and can never
 * drift apart.
 *
 * The preview never edits source code. "Save" serialises the complete
 * composition to `visual-overrides.json` at the repository root; the pipeline
 * merges that file over the committed defaults at startup
 * (`src/visual-overrides.ts` — the Node half of this contract, kept byte-equal
 * to `DEFAULT_PREVIEW_CONFIG` by `tests/config-model.test.ts`).
 */
(function (root, factory) {
  var api = factory();
  // Node (`require`) path — unreachable under `"type": "module"`, kept for parity.
  if (typeof module === "object" && module.exports) module.exports = api;
  // Browser classic script / Node ESM side-effect import.
  root.ShowcaseConfigModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VIEWPORT_WIDTH_PX = 1080;
  var VIEWPORT_HEIGHT_PX = 1920;
  /** Repo-relative path of the file the preview authors. Forward slashes so the
   *  browser can navigate a picked directory handle, and Node's fs accepts them
   *  on every platform. */
  var OVERRIDES_FILENAME = "visual-overrides.json";

  /** The committed composition. Must stay deep-equal to
   *  `DEFAULT_VISUAL_OVERRIDES` in `src/visual-overrides.ts`. */
  var DEFAULT_PREVIEW_CONFIG = {
    mascotAsset: "mascot-custom.png",
    mascotWidthPx: 681,
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
    captionColor: "#F8F6EF",
    captionShadowOffsetY: 3,
    captionShadowBlur: 10,
    captionShadowOpacity: 0.95,
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
    impactLineStaggerMs: 45
  };

  var NUMBER_KEYS = Object.keys(DEFAULT_PREVIEW_CONFIG).filter(function (key) {
    return typeof DEFAULT_PREVIEW_CONFIG[key] === "number";
  });
  var BOOLEAN_KEYS = ["calloutEnabled", "impactEnabled"];
  var COLOR_KEYS = [
    "captionColor", "highlightBackground", "highlightText",
    "calloutFill", "calloutOutline", "calloutAccent", "calloutTextColor",
    "impactStrokeColor"
  ];

  /** Clamp a card dimension into a range that always keeps the card on-canvas. */
  function clampInt(value, min, max) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return min;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function finiteNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function hex(value, fallback) {
    var trimmed = String(value == null ? "" : value).trim();
    var withHash = trimmed.charAt(0) === "#" ? trimmed : "#" + trimmed;
    return /^#[0-9a-fA-F]{3,8}$/.test(withHash) ? withHash.toUpperCase() : fallback;
  }

  /**
   * A mascot asset must be a bare filename: no directories, no quotes, nothing
   * that could break out of `path.join(ROOT, "assets", …)`.
   */
  function sanitizeAssetFilename(value) {
    var name = String(value == null ? "" : value)
      .split(/[\\/]/)
      .pop()
      .replace(/["'<>:|?*\u0000-\u001f]/g, "")
      .trim();
    return name || "character.png";
  }

  /** Coerce untrusted (JSON body / hand-edited file) input into a complete,
   *  validated config. Unknown keys are dropped; invalid values fall back to
   *  the base for that key. */
  function normalizePreviewConfig(input, base) {
    var source = input && typeof input === "object" ? input : {};
    var out = {};
    Object.keys(base).forEach(function (key) { out[key] = base[key]; });

    NUMBER_KEYS.forEach(function (key) {
      if (source[key] === undefined || source[key] === null) return;
      out[key] = finiteNumber(source[key], base[key]);
    });
    BOOLEAN_KEYS.forEach(function (key) {
      if (source[key] === undefined || source[key] === null) return;
      out[key] = Boolean(source[key]);
    });
    COLOR_KEYS.forEach(function (key) {
      if (source[key] === undefined || source[key] === null) return;
      out[key] = hex(source[key], base[key]);
    });
    if (source.captionFontFamily !== undefined && source.captionFontFamily !== null) {
      out.captionFontFamily = String(source.captionFontFamily);
    }
    out.mascotAsset = sanitizeAssetFilename(
      source.mascotAsset === undefined ? base.mascotAsset : source.mascotAsset
    );

    // A card that leaves the stage is never the intent of a tuning file.
    out.cardWidth = clampInt(out.cardWidth, 360, 1000);
    out.cardHeight = clampInt(out.cardHeight, 560, 1860);
    out.mascotWidthPx = Math.min(1600, Math.max(100, finiteNumber(out.mascotWidthPx, base.mascotWidthPx)));

    return out;
  }

  /** Serialize the complete composition to `visual-overrides.json` content. */
  function serializeVisualOverrides(config) {
    return JSON.stringify(config, null, 2) + "\n";
  }

  /** Parse `visual-overrides.json` content back into a complete config.
   *  Throws on invalid JSON — callers decide how to surface that (the dev
   *  server fails the save, the loader falls back to defaults with a warning). */
  function parseVisualOverrides(text) {
    // Tolerate a BOM: Notepad and PowerShell both write UTF-8 with a BOM.
    var parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    return normalizePreviewConfig(parsed, DEFAULT_PREVIEW_CONFIG);
  }

  /** Names of the fields whose value differs. */
  function configDiff(before, after) {
    return Object.keys(after).filter(function (key) {
      return before[key] !== after[key];
    });
  }

  return {
    VIEWPORT_WIDTH_PX: VIEWPORT_WIDTH_PX,
    VIEWPORT_HEIGHT_PX: VIEWPORT_HEIGHT_PX,
    OVERRIDES_FILENAME: OVERRIDES_FILENAME,
    DEFAULT_PREVIEW_CONFIG: DEFAULT_PREVIEW_CONFIG,
    normalizePreviewConfig: normalizePreviewConfig,
    serializeVisualOverrides: serializeVisualOverrides,
    parseVisualOverrides: parseVisualOverrides,
    configDiff: configDiff
  };
});
