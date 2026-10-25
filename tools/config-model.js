/* eslint-disable */
/**
 * Shared composition rewrite engine for the live preview.
 *
 * This file is deliberately a CLASSIC script (no `import` / `export`): it must
 * load from a plain `<script src="config-model.js">` tag even when the preview
 * page is opened as `file://`, where Chrome/Edge reject ES modules. Node loads
 * it as a side-effect import and reads the API off `globalThis`, so both the
 * dev server and the folder fallback share one implementation and can never
 * drift apart.
 *
 * Two guarantees make the save trustworthy:
 *  1. Every rewrite must match exactly one location. A missing or ambiguous
 *     pattern aborts the whole save, so a partial/corrupt write is impossible.
 *  2. `parsePreviewConfig` is the inverse of `writePreviewConfig`, so the
 *     preview can always reload the values that are actually in the codebase.
 */
(function (root, factory) {
  var api = factory();
  // Node (`require`) path — unreachable under `"type": "module"`, kept for parity.
  if (typeof module === "object" && module.exports) module.exports = api;
  // Browser classic script / Node ESM side-effect import.
  root.ShowcaseConfigModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Repo-relative paths of the files the writer owns (forward slashes so the
   *  browser can navigate a picked directory handle, and Node's fs accepts them
   *  on every platform). */
  var CONFIG_PATHS = {
    configTs: "src/config.ts",
    captionOverlayTs: "src/caption-overlay.ts",
    cardTs: "src/card.ts"
  };

  var VIEWPORT_WIDTH_PX = 1080;

  function num(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }

  function hex(value) {
    var trimmed = String(value).trim();
    var withHash = trimmed.charAt(0) === "#" ? trimmed : "#" + trimmed;
    return withHash.toUpperCase();
  }

  /**
   * Replace exactly one occurrence of `pattern`. Any other count is an error:
   * the caller is editing source code, never guessing.
   */
  function sub(source, pattern, replace, label) {
    var global = new RegExp(
      pattern.source,
      pattern.flags.indexOf("g") === -1 ? pattern.flags + "g" : pattern.flags
    );
    var count = 0;
    var out = source.replace(global, function () {
      var args = Array.prototype.slice.call(arguments);
      count += 1;
      var groups = args.slice(0, -2);
      return replace.apply(null, groups);
    });
    if (count !== 1) {
      throw new Error(
        "config-writer: " + label + ": expected exactly one match, found " + count
      );
    }
    return out;
  }

  function readNumber(source, pattern, label) {
    var match = source.match(pattern);
    if (!match) throw new Error("config-writer: could not read " + label);
    return Number(match[1]);
  }

  function readString(source, pattern, label) {
    var match = source.match(pattern);
    if (!match) throw new Error("config-writer: could not read " + label);
    return match[1];
  }

  function readBoolean(source, pattern, label) {
    var match = source.match(pattern);
    if (!match) throw new Error("config-writer: could not read " + label);
    return match[1] === "true";
  }

  /** Serialize a config object into the three source files. */
  function writePreviewConfig(sources, config) {
    var widthRatio = (config.mascotWidthPx / VIEWPORT_WIDTH_PX).toFixed(4);
    var mascotShadow = "drop-shadow(0 " + num(config.mascotShadowOffsetY) + "px " +
      num(config.mascotShadowBlur) + "px rgba(0,0,0," + num(config.mascotShadowOpacity) + "))";
    var captionShadow = "0 " + num(config.captionShadowOffsetY) + "px " +
      num(config.captionShadowBlur) + "px rgba(0,0,0," + num(config.captionShadowOpacity) + ")";
    var highlightBg = hex(config.highlightBackground);
    var highlightText = hex(config.highlightText);

    /* ---------------- src/config.ts ---------------- */
    var configTs = sources.configTs;
    configTs = sub(
      configTs,
      /widthRatio: readNumber\(process\.env\.SHOWCASE_MASCOT_WIDTH_RATIO, -?[\d.]+\)/,
      function () {
        return "widthRatio: readNumber(process.env.SHOWCASE_MASCOT_WIDTH_RATIO, " + widthRatio + ")";
      },
      "MASCOT_LAYOUT.widthRatio"
    );
    configTs = sub(
      configTs,
      /offsetX: readNumber\(process\.env\.SHOWCASE_MASCOT_OFFSET_X, -?[\d.]+\)/,
      function () {
        return "offsetX: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_X, " + num(config.mascotRight) + ")";
      },
      "MASCOT_LAYOUT.offsetX"
    );
    configTs = sub(
      configTs,
      /offsetY: readNumber\(process\.env\.SHOWCASE_MASCOT_OFFSET_Y, -?[\d.]+\)/,
      function () {
        return "offsetY: readNumber(process.env.SHOWCASE_MASCOT_OFFSET_Y, " + num(config.mascotBottom) + ")";
      },
      "MASCOT_LAYOUT.offsetY"
    );
    configTs = sub(configTs, /leftPx: -?[\d.]+,/, function () {
      return "leftPx: " + num(config.captionLeft) + ",";
    }, "CAPTION_OVERLAY.leftPx");
    configTs = sub(configTs, /topPx: -?[\d.]+,/, function () {
      return "topPx: " + num(config.captionTop) + ",";
    }, "CAPTION_OVERLAY.topPx");
    configTs = sub(configTs, /widthPx: -?[\d.]+,/, function () {
      return "widthPx: " + num(config.captionWidth) + ",";
    }, "CAPTION_OVERLAY.widthPx");
    configTs = sub(configTs, /maxHeightPx: -?[\d.]+,/, function () {
      return "maxHeightPx: " + num(config.captionMaxHeight) + ",";
    }, "CAPTION_OVERLAY.maxHeightPx");
    configTs = sub(configTs, /radius: -?[\d.]+,/, function () {
      return "radius: " + num(config.cardRadius) + ",";
    }, "CARD.radius");
    configTs = sub(
      configTs,
      /shadow: "drop-shadow\(0\s+-?[\d.]+px\s+-?[\d.]+px\s+rgba\(0,\s*0,\s*0,\s*[\d.]+\)\)",/,
      function () {
        return "shadow: " + JSON.stringify(mascotShadow) + ",";
      },
      "CHARACTER.shadow"
    );

    /* ---------------- CALLOUT (src/config.ts) ---------------- */
    configTs = sub(
      configTs,
      /(export const CALLOUT = \{[\s\S]*?\n\s*enabled: )(?:true|false)(,)/,
      function (all, pre, post) {
        return pre + (config.calloutEnabled ? "true" : "false") + post;
      },
      "CALLOUT.enabled"
    );
    configTs = sub(configTs, /bubbleWidthPx: -?[\d.]+,/, function () {
      return "bubbleWidthPx: " + num(config.calloutBubbleWidth) + ",";
    }, "CALLOUT.bubbleWidthPx");
    configTs = sub(configTs, /bubbleHeightPx: -?[\d.]+,/, function () {
      return "bubbleHeightPx: " + num(config.calloutBubbleHeight) + ",";
    }, "CALLOUT.bubbleHeightPx");
    configTs = sub(configTs, /leftMinPx: -?[\d.]+,/, function () {
      return "leftMinPx: " + num(config.calloutLeftMin) + ",";
    }, "CALLOUT.leftMinPx");
    configTs = sub(configTs, /rightMarginPx: -?[\d.]+,/, function () {
      return "rightMarginPx: " + num(config.calloutRightMargin) + ",";
    }, "CALLOUT.rightMarginPx");
    configTs = sub(configTs, /topOffsetPx: -?[\d.]+,/, function () {
      return "topOffsetPx: " + num(config.calloutTopOffset) + ",";
    }, "CALLOUT.topOffsetPx");
    configTs = sub(configTs, /topMinPx: -?[\d.]+,/, function () {
      return "topMinPx: " + num(config.calloutTopMin) + ",";
    }, "CALLOUT.topMinPx");
    configTs = sub(configTs, /topMaxPx: -?[\d.]+,/, function () {
      return "topMaxPx: " + num(config.calloutTopMax) + ",";
    }, "CALLOUT.topMaxPx");
    configTs = sub(configTs, /faceOffsetPx: -?[\d.]+,/, function () {
      return "faceOffsetPx: " + num(config.calloutFaceOffset) + ",";
    }, "CALLOUT.faceOffsetPx");
    configTs = sub(configTs, /enterMs: -?[\d.]+,/, function () {
      return "enterMs: " + num(config.calloutEnterMs) + ",";
    }, "CALLOUT.enterMs");
    configTs = sub(configTs, /exitMs: -?[\d.]+,/, function () {
      return "exitMs: " + num(config.calloutExitMs) + ",";
    }, "CALLOUT.exitMs");
    configTs = sub(configTs, /enterYPx: -?[\d.]+,/, function () {
      return "enterYPx: " + num(config.calloutEnterY) + ",";
    }, "CALLOUT.enterYPx");
    configTs = sub(configTs, /exitYPx: -?[\d.]+,/, function () {
      return "exitYPx: " + num(config.calloutExitY) + ",";
    }, "CALLOUT.exitYPx");
    configTs = sub(configTs, /enterScale: -?[\d.]+,/, function () {
      return "enterScale: " + num(config.calloutEnterScale) + ",";
    }, "CALLOUT.enterScale");
    configTs = sub(configTs, /exitScale: -?[\d.]+,/, function () {
      return "exitScale: " + num(config.calloutExitScale) + ",";
    }, "CALLOUT.exitScale");
    configTs = sub(configTs, /minVisibleMs: -?[\d.]+,/, function () {
      return "minVisibleMs: " + num(config.calloutMinVisibleMs) + ",";
    }, "CALLOUT.minVisibleMs");
    configTs = sub(configTs, /maxVisibleMs: -?[\d.]+,/, function () {
      return "maxVisibleMs: " + num(config.calloutMaxVisibleMs) + ",";
    }, "CALLOUT.maxVisibleMs");
    configTs = sub(configTs, /interCalloutGapMs: -?[\d.]+,/, function () {
      return "interCalloutGapMs: " + num(config.calloutInterGapMs) + ",";
    }, "CALLOUT.interCalloutGapMs");
    configTs = sub(configTs, /maxCues: -?[\d.]+,/, function () {
      return "maxCues: " + num(config.calloutMaxCues) + ",";
    }, "CALLOUT.maxCues");
    configTs = sub(configTs, /fill: "#[0-9A-Fa-f]+",/, function () {
      return "fill: " + JSON.stringify(hex(config.calloutFill)) + ",";
    }, "CALLOUT.fill");
    configTs = sub(configTs, /outline: "#[0-9A-Fa-f]+",/, function () {
      return "outline: " + JSON.stringify(hex(config.calloutOutline)) + ",";
    }, "CALLOUT.outline");
    configTs = sub(configTs, /outlineWidthPx: -?[\d.]+,/, function () {
      return "outlineWidthPx: " + num(config.calloutOutlineWidth) + ",";
    }, "CALLOUT.outlineWidthPx");
    configTs = sub(configTs, /accent: "#[0-9A-Fa-f]+",/, function () {
      return "accent: " + JSON.stringify(hex(config.calloutAccent)) + ",";
    }, "CALLOUT.accent");
    configTs = sub(configTs, /accentOffsetX: -?[\d.]+,/, function () {
      return "accentOffsetX: " + num(config.calloutAccentOffsetX) + ",";
    }, "CALLOUT.accentOffsetX");
    configTs = sub(configTs, /accentOffsetY: -?[\d.]+,/, function () {
      return "accentOffsetY: " + num(config.calloutAccentOffsetY) + ",";
    }, "CALLOUT.accentOffsetY");
    configTs = sub(configTs, /text: "#[0-9A-Fa-f]+",/, function () {
      return "text: " + JSON.stringify(hex(config.calloutTextColor)) + ",";
    }, "CALLOUT.text");
    configTs = sub(configTs, /fontSizePx: -?[\d.]+,/, function () {
      return "fontSizePx: " + num(config.calloutFontSize) + ",";
    }, "CALLOUT.fontSizePx");
    configTs = sub(configTs, /fontWeight: -?[\d.]+,/, function () {
      return "fontWeight: " + num(config.calloutFontWeight) + ",";
    }, "CALLOUT.fontWeight");
    configTs = sub(configTs, /lineHeight: -?[\d.]+,/, function () {
      return "lineHeight: " + num(config.calloutLineHeight) + ",";
    }, "CALLOUT.lineHeight");

    /* ---------------- IMPACT_ACCENTS (src/config.ts) ---------------- */
    configTs = sub(
      configTs,
      /(export const IMPACT_ACCENTS = \{[\s\S]*?\n\s*enabled: )(?:true|false)(,)/,
      function (all, pre, post) {
        return pre + (config.impactEnabled ? "true" : "false") + post;
      },
      "IMPACT_ACCENTS.enabled"
    );
    configTs = sub(configTs, /strokeColor: "#[0-9A-Fa-f]+",/, function () {
      return "strokeColor: " + JSON.stringify(hex(config.impactStrokeColor)) + ",";
    }, "IMPACT_ACCENTS.strokeColor");
    configTs = sub(configTs, /strokeWidthPx: -?[\d.]+,/, function () {
      return "strokeWidthPx: " + num(config.impactStrokeWidth) + ",";
    }, "IMPACT_ACCENTS.strokeWidthPx");
    configTs = sub(configTs, /peakOpacity: -?[\d.]+,/, function () {
      return "peakOpacity: " + num(config.impactPeakOpacity) + ",";
    }, "IMPACT_ACCENTS.peakOpacity");
    configTs = sub(configTs, /minBurstCount: -?[\d.]+,/, function () {
      return "minBurstCount: " + num(config.impactMinBurstCount) + ",";
    }, "IMPACT_ACCENTS.minBurstCount");
    configTs = sub(configTs, /maxBurstCount: -?[\d.]+,/, function () {
      return "maxBurstCount: " + num(config.impactMaxBurstCount) + ",";
    }, "IMPACT_ACCENTS.maxBurstCount");
    configTs = sub(configTs, /minIntervalMs: -?[\d.]+,/, function () {
      return "minIntervalMs: " + num(config.impactMinIntervalMs) + ",";
    }, "IMPACT_ACCENTS.minIntervalMs");
    configTs = sub(configTs, /jitterMs: -?[\d.]+,/, function () {
      return "jitterMs: " + num(config.impactJitterMs) + ",";
    }, "IMPACT_ACCENTS.jitterMs");
    configTs = sub(configTs, /burstDurationMs: -?[\d.]+,/, function () {
      return "burstDurationMs: " + num(config.impactBurstDurationMs) + ",";
    }, "IMPACT_ACCENTS.burstDurationMs");
    configTs = sub(configTs, /lineStaggerMs: -?[\d.]+,/, function () {
      return "lineStaggerMs: " + num(config.impactLineStaggerMs) + ",";
    }, "IMPACT_ACCENTS.lineStaggerMs");

    /* ---------------- src/caption-overlay.ts ---------------- */
    var captionOverlayTs = sources.captionOverlayTs;
    captionOverlayTs = sub(captionOverlayTs, /fontFamily:\s*"[^"]*",/, function () {
      return "fontFamily:\n    " + JSON.stringify(config.captionFontFamily) + ",";
    }, "CAPTION_STYLE.fontFamily");
    captionOverlayTs = sub(captionOverlayTs, /fontWeight: \d+,/, function () {
      return "fontWeight: " + num(config.captionFontWeight) + ",";
    }, "CAPTION_STYLE.fontWeight");
    captionOverlayTs = sub(captionOverlayTs, /fontSizePx: \d+,/, function () {
      return "fontSizePx: " + num(config.captionFontSize) + ",";
    }, "CAPTION_STYLE.fontSizePx");
    captionOverlayTs = sub(captionOverlayTs, /lineHeight: [\d.]+,/, function () {
      return "lineHeight: " + num(config.captionLineHeight) + ",";
    }, "CAPTION_STYLE.lineHeight");
    captionOverlayTs = sub(captionOverlayTs, /letterSpacingPx: -?[\d.]+,/, function () {
      return "letterSpacingPx: " + num(config.captionLetterSpacing) + ",";
    }, "CAPTION_STYLE.letterSpacingPx");
    captionOverlayTs = sub(captionOverlayTs, /color: "#[0-9A-Fa-f]+",/, function () {
      return "color: " + JSON.stringify(hex(config.captionColor)) + ",";
    }, "CAPTION_STYLE.color");
    captionOverlayTs = sub(captionOverlayTs, /highlightColor: [A-Z_]+,/, function () {
      return "highlightColor: CAPTION_HIGHLIGHT_BG,";
    }, "CAPTION_STYLE.highlightColor");
    captionOverlayTs = sub(
      captionOverlayTs,
      /textShadow: "0 -?[\d.]+px -?[\d.]+px rgba\(0,0,0,[\d.]+\)",/,
      function () {
        return "textShadow: " + JSON.stringify(captionShadow) + ",";
      },
      "CAPTION_STYLE.textShadow"
    );
    captionOverlayTs = sub(
      captionOverlayTs,
      /CAPTION_HIGHLIGHT_BG =\s*\n\s*process\.env\.SHOWCASE_CAPTION_HIGHLIGHT_BG \?\? "#[0-9A-Fa-f]+";/,
      function () {
        return "CAPTION_HIGHLIGHT_BG =\n  process.env.SHOWCASE_CAPTION_HIGHLIGHT_BG ?? " +
          JSON.stringify(highlightBg) + ";";
      },
      "CAPTION_HIGHLIGHT_BG"
    );
    captionOverlayTs = sub(
      captionOverlayTs,
      /CAPTION_HIGHLIGHT_TEXT =\s*\n\s*process\.env\.SHOWCASE_CAPTION_HIGHLIGHT_TEXT \?\? "#[0-9A-Fa-f]+";/,
      function () {
        return "CAPTION_HIGHLIGHT_TEXT =\n  process.env.SHOWCASE_CAPTION_HIGHLIGHT_TEXT ?? " +
          JSON.stringify(highlightText) + ";";
      },
      "CAPTION_HIGHLIGHT_TEXT"
    );
    captionOverlayTs = sub(captionOverlayTs, /enterMs: \d+,/, function () {
      return "enterMs: " + num(config.enterMs) + ",";
    }, "CAPTION_MOTION.enterMs");
    captionOverlayTs = sub(captionOverlayTs, /enterYPx: -?[\d.]+,/, function () {
      return "enterYPx: " + num(config.enterYPx) + ",";
    }, "CAPTION_MOTION.enterYPx");
    captionOverlayTs = sub(captionOverlayTs, /enterScale: [\d.]+,/, function () {
      return "enterScale: " + num(config.enterScale) + ",";
    }, "CAPTION_MOTION.enterScale");
    captionOverlayTs = sub(captionOverlayTs, /exitMs: \d+,/, function () {
      return "exitMs: " + num(config.exitMs) + ",";
    }, "CAPTION_MOTION.exitMs");
    captionOverlayTs = sub(captionOverlayTs, /exitYPx: -?[\d.]+,/, function () {
      return "exitYPx: " + num(config.exitYPx) + ",";
    }, "CAPTION_MOTION.exitYPx");

    /* ---------------- src/card.ts ---------------- */
    var cardTs = sources.cardTs;
    cardTs = sub(cardTs, /intensity: -?[\d.]+,/, function () {
      return "intensity: " + num(config.cardShadowIntensity) + ",";
    }, "CARD_SHADOW_TUNING.intensity");
    cardTs = sub(cardTs, /blurScale: -?[\d.]+,/, function () {
      return "blurScale: " + num(config.cardShadowBlurScale) + ",";
    }, "CARD_SHADOW_TUNING.blurScale");

    return { configTs: configTs, captionOverlayTs: captionOverlayTs, cardTs: cardTs };
  }

  /** Read the authored values back out of the three source files. */
  function parsePreviewConfig(sources) {
    var configTs = sources.configTs;
    var captionOverlayTs = sources.captionOverlayTs;
    var cardTs = sources.cardTs;

    var widthRatio = readNumber(
      configTs,
      /widthRatio: readNumber\(process\.env\.SHOWCASE_MASCOT_WIDTH_RATIO, (-?[\d.]+)\)/,
      "MASCOT_LAYOUT.widthRatio"
    );
    var mascotShadow = configTs.match(
      /shadow: "drop-shadow\(0\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+rgba\(0,\s*0,\s*0,\s*([\d.]+)\)\)",/
    );
    if (!mascotShadow) throw new Error("config-writer: could not read CHARACTER.shadow");
    var captionShadow = captionOverlayTs.match(
      /textShadow: "0 (-?[\d.]+)px (-?[\d.]+)px rgba\(0,0,0,([\d.]+)\)",/
    );
    if (!captionShadow) throw new Error("config-writer: could not read CAPTION_STYLE.textShadow");

    return {
      mascotWidthPx: Math.round(widthRatio * VIEWPORT_WIDTH_PX),
      mascotRight: readNumber(configTs, /offsetX: readNumber\(process\.env\.SHOWCASE_MASCOT_OFFSET_X, (-?[\d.]+)\)/, "MASCOT_LAYOUT.offsetX"),
      mascotBottom: readNumber(configTs, /offsetY: readNumber\(process\.env\.SHOWCASE_MASCOT_OFFSET_Y, (-?[\d.]+)\)/, "MASCOT_LAYOUT.offsetY"),
      mascotShadowOffsetY: Number(mascotShadow[1]),
      mascotShadowBlur: Number(mascotShadow[2]),
      mascotShadowOpacity: Number(mascotShadow[3]),
      captionLeft: readNumber(configTs, /leftPx: (-?[\d.]+),/, "CAPTION_OVERLAY.leftPx"),
      captionTop: readNumber(configTs, /topPx: (-?[\d.]+),/, "CAPTION_OVERLAY.topPx"),
      captionWidth: readNumber(configTs, /widthPx: (-?[\d.]+),/, "CAPTION_OVERLAY.widthPx"),
      captionMaxHeight: readNumber(configTs, /maxHeightPx: (-?[\d.]+),/, "CAPTION_OVERLAY.maxHeightPx"),
      captionFontFamily: readString(captionOverlayTs, /fontFamily:\s*"([^"]*)",/, "CAPTION_STYLE.fontFamily"),
      captionFontWeight: readNumber(captionOverlayTs, /fontWeight: (\d+),/, "CAPTION_STYLE.fontWeight"),
      captionFontSize: readNumber(captionOverlayTs, /fontSizePx: (\d+),/, "CAPTION_STYLE.fontSizePx"),
      captionLineHeight: readNumber(captionOverlayTs, /lineHeight: ([\d.]+),/, "CAPTION_STYLE.lineHeight"),
      captionLetterSpacing: readNumber(captionOverlayTs, /letterSpacingPx: (-?[\d.]+),/, "CAPTION_STYLE.letterSpacingPx"),
      captionColor: readString(captionOverlayTs, /color: "(#[0-9A-Fa-f]+)",/, "CAPTION_STYLE.color"),
      captionShadowOffsetY: Number(captionShadow[1]),
      captionShadowBlur: Number(captionShadow[2]),
      captionShadowOpacity: Number(captionShadow[3]),
      highlightBackground: readString(captionOverlayTs, /CAPTION_HIGHLIGHT_BG =\s*\n\s*process\.env\.SHOWCASE_CAPTION_HIGHLIGHT_BG \?\? "(#[0-9A-Fa-f]+)";/, "CAPTION_HIGHLIGHT_BG"),
      highlightText: readString(captionOverlayTs, /CAPTION_HIGHLIGHT_TEXT =\s*\n\s*process\.env\.SHOWCASE_CAPTION_HIGHLIGHT_TEXT \?\? "(#[0-9A-Fa-f]+)";/, "CAPTION_HIGHLIGHT_TEXT"),
      cardRadius: readNumber(configTs, /radius: (-?[\d.]+),/, "CARD.radius"),
      cardShadowIntensity: readNumber(cardTs, /intensity: (-?[\d.]+),/, "CARD_SHADOW_TUNING.intensity"),
      cardShadowBlurScale: readNumber(cardTs, /blurScale: (-?[\d.]+),/, "CARD_SHADOW_TUNING.blurScale"),
      enterMs: readNumber(captionOverlayTs, /enterMs: (\d+),/, "CAPTION_MOTION.enterMs"),
      enterYPx: readNumber(captionOverlayTs, /enterYPx: (-?[\d.]+),/, "CAPTION_MOTION.enterYPx"),
      enterScale: readNumber(captionOverlayTs, /enterScale: ([\d.]+),/, "CAPTION_MOTION.enterScale"),
      exitMs: readNumber(captionOverlayTs, /exitMs: (\d+),/, "CAPTION_MOTION.exitMs"),
      exitYPx: readNumber(captionOverlayTs, /exitYPx: (-?[\d.]+),/, "CAPTION_MOTION.exitYPx"),

      calloutEnabled: readBoolean(configTs, /export const CALLOUT = \{[\s\S]*?\n\s*enabled:\s*(true|false),/, "CALLOUT.enabled"),
      calloutBubbleWidth: readNumber(configTs, /bubbleWidthPx: (-?[\d.]+),/, "CALLOUT.bubbleWidthPx"),
      calloutBubbleHeight: readNumber(configTs, /bubbleHeightPx: (-?[\d.]+),/, "CALLOUT.bubbleHeightPx"),
      calloutLeftMin: readNumber(configTs, /leftMinPx: (-?[\d.]+),/, "CALLOUT.leftMinPx"),
      calloutRightMargin: readNumber(configTs, /rightMarginPx: (-?[\d.]+),/, "CALLOUT.rightMarginPx"),
      calloutTopOffset: readNumber(configTs, /topOffsetPx: (-?[\d.]+),/, "CALLOUT.topOffsetPx"),
      calloutTopMin: readNumber(configTs, /topMinPx: (-?[\d.]+),/, "CALLOUT.topMinPx"),
      calloutTopMax: readNumber(configTs, /topMaxPx: (-?[\d.]+),/, "CALLOUT.topMaxPx"),
      calloutFaceOffset: readNumber(configTs, /faceOffsetPx: (-?[\d.]+),/, "CALLOUT.faceOffsetPx"),
      calloutEnterMs: readNumber(configTs, /enterMs: (-?[\d.]+),/, "CALLOUT.enterMs"),
      calloutExitMs: readNumber(configTs, /exitMs: (-?[\d.]+),/, "CALLOUT.exitMs"),
      calloutEnterY: readNumber(configTs, /enterYPx: (-?[\d.]+),/, "CALLOUT.enterYPx"),
      calloutExitY: readNumber(configTs, /exitYPx: (-?[\d.]+),/, "CALLOUT.exitYPx"),
      calloutEnterScale: readNumber(configTs, /enterScale: (-?[\d.]+),/, "CALLOUT.enterScale"),
      calloutExitScale: readNumber(configTs, /exitScale: (-?[\d.]+),/, "CALLOUT.exitScale"),
      calloutMinVisibleMs: readNumber(configTs, /minVisibleMs: (-?[\d.]+),/, "CALLOUT.minVisibleMs"),
      calloutMaxVisibleMs: readNumber(configTs, /maxVisibleMs: (-?[\d.]+),/, "CALLOUT.maxVisibleMs"),
      calloutInterGapMs: readNumber(configTs, /interCalloutGapMs: (-?[\d.]+),/, "CALLOUT.interCalloutGapMs"),
      calloutMaxCues: readNumber(configTs, /maxCues: (-?[\d.]+),/, "CALLOUT.maxCues"),
      calloutFill: readString(configTs, /fill: "(#[0-9A-Fa-f]+)",/, "CALLOUT.fill"),
      calloutOutline: readString(configTs, /outline: "(#[0-9A-Fa-f]+)",/, "CALLOUT.outline"),
      calloutOutlineWidth: readNumber(configTs, /outlineWidthPx: (-?[\d.]+),/, "CALLOUT.outlineWidthPx"),
      calloutAccent: readString(configTs, /accent: "(#[0-9A-Fa-f]+)",/, "CALLOUT.accent"),
      calloutAccentOffsetX: readNumber(configTs, /accentOffsetX: (-?[\d.]+),/, "CALLOUT.accentOffsetX"),
      calloutAccentOffsetY: readNumber(configTs, /accentOffsetY: (-?[\d.]+),/, "CALLOUT.accentOffsetY"),
      calloutTextColor: readString(configTs, /text: "(#[0-9A-Fa-f]+)",/, "CALLOUT.text"),
      calloutFontSize: readNumber(configTs, /fontSizePx: (-?[\d.]+),/, "CALLOUT.fontSizePx"),
      calloutFontWeight: readNumber(configTs, /fontWeight: (-?[\d.]+),/, "CALLOUT.fontWeight"),
      calloutLineHeight: readNumber(configTs, /lineHeight: (-?[\d.]+),/, "CALLOUT.lineHeight"),

      impactEnabled: readBoolean(configTs, /export const IMPACT_ACCENTS = \{[\s\S]*?\n\s*enabled:\s*(true|false),/, "IMPACT_ACCENTS.enabled"),
      impactStrokeColor: readString(configTs, /strokeColor: "(#[0-9A-Fa-f]+)",/, "IMPACT_ACCENTS.strokeColor"),
      impactStrokeWidth: readNumber(configTs, /strokeWidthPx: (-?[\d.]+),/, "IMPACT_ACCENTS.strokeWidthPx"),
      impactPeakOpacity: readNumber(configTs, /peakOpacity: (-?[\d.]+),/, "IMPACT_ACCENTS.peakOpacity"),
      impactMinBurstCount: readNumber(configTs, /minBurstCount: (-?[\d.]+),/, "IMPACT_ACCENTS.minBurstCount"),
      impactMaxBurstCount: readNumber(configTs, /maxBurstCount: (-?[\d.]+),/, "IMPACT_ACCENTS.maxBurstCount"),
      impactMinIntervalMs: readNumber(configTs, /minIntervalMs: (-?[\d.]+),/, "IMPACT_ACCENTS.minIntervalMs"),
      impactJitterMs: readNumber(configTs, /jitterMs: (-?[\d.]+),/, "IMPACT_ACCENTS.jitterMs"),
      impactBurstDurationMs: readNumber(configTs, /burstDurationMs: (-?[\d.]+),/, "IMPACT_ACCENTS.burstDurationMs"),
      impactLineStaggerMs: readNumber(configTs, /lineStaggerMs: (-?[\d.]+),/, "IMPACT_ACCENTS.lineStaggerMs")
    };
  }

  /** Names of the fields whose value differs. */
  function configDiff(before, after) {
    return Object.keys(after).filter(function (key) {
      return before[key] !== after[key];
    });
  }

  /** Coerce untrusted (JSON body) input into a complete config. */
  function normalizePreviewConfig(input, base) {
    var out = {};
    Object.keys(base).forEach(function (key) { out[key] = base[key]; });
    Object.keys(base).forEach(function (key) {
      var value = input[key];
      if (value === undefined || value === null) return;
      if (typeof base[key] === "number") {
        var parsed = Number(value);
        if (Number.isFinite(parsed)) out[key] = parsed;
      } else if (typeof base[key] === "boolean") {
        out[key] = Boolean(value);
      } else if (typeof value === "string") {
        out[key] = value;
      }
    });
    return out;
  }

  return {
    CONFIG_PATHS: CONFIG_PATHS,
    VIEWPORT_WIDTH_PX: VIEWPORT_WIDTH_PX,
    writePreviewConfig: writePreviewConfig,
    parsePreviewConfig: parsePreviewConfig,
    configDiff: configDiff,
    normalizePreviewConfig: normalizePreviewConfig
  };
});
