import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import {
  CONFIG_PATHS,
  normalizePreviewConfig,
  parsePreviewConfig,
  writePreviewConfig,
  type ConfigSources,
} from "../tools/config-writer.js";
import { CARD_SHADOW, CARD_SHADOW_TUNING, buildCardShadow } from "../src/card.js";
import {
  CALLOUT,
  CAPTION_OVERLAY,
  CAPTION_PANEL_STYLE,
  CARD,
  CHARACTER_PNG_FILENAME,
  IMPACT_ACCENTS,
  MASCOT_LAYOUT,
  VIEWPORT,
} from "../src/config.js";

async function readSources(): Promise<ConfigSources> {
  const [configTs, captionOverlayTs, cardTs] = await Promise.all([
    fs.readFile(CONFIG_PATHS.configTs, "utf8"),
    fs.readFile(CONFIG_PATHS.captionOverlayTs, "utf8"),
    fs.readFile(CONFIG_PATHS.cardTs, "utf8"),
  ]);
  return { configTs, captionOverlayTs, cardTs };
}

describe("preview config writer", () => {
  test("reads the committed composition values", async () => {
    // The live preview is *designed* to retune these numbers, so the test
    // follows the committed config instead of hardcoding a snapshot of it.
    const config = parsePreviewConfig(await readSources());
    assert.equal(config.mascotAsset, CHARACTER_PNG_FILENAME);
    assert.equal(
      config.mascotWidthPx,
      Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width)
    );
    assert.equal(config.mascotRight, MASCOT_LAYOUT.offsetX);
    assert.equal(config.mascotBottom, MASCOT_LAYOUT.offsetY);
    assert.equal(config.captionLeft, CAPTION_OVERLAY.leftPx);
    assert.equal(config.captionTop, CAPTION_OVERLAY.topPx);
    assert.equal(config.captionWidth, CAPTION_OVERLAY.widthPx);
    assert.equal(config.captionMaxHeight, CAPTION_OVERLAY.maxHeightPx);
    assert.equal(config.cardWidth, CARD.width);
    assert.equal(config.cardHeight, CARD.height);
    assert.equal(config.cardRadius, CARD.radius);
    assert.equal(config.cardShadowIntensity, CARD_SHADOW_TUNING.intensity);
    assert.equal(config.cardShadowBlurScale, CARD_SHADOW_TUNING.blurScale);
    assert.equal(config.calloutEnabled, CALLOUT.enabled);
    assert.equal(config.calloutBubbleWidth, CALLOUT.bubbleWidthPx);
    assert.equal(config.calloutFontSize, CALLOUT.fontSizePx);
    assert.equal(config.impactEnabled, IMPACT_ACCENTS.enabled);
    assert.equal(config.impactStrokeColor, IMPACT_ACCENTS.strokeColor);
    assert.equal(config.impactStrokeWidth, IMPACT_ACCENTS.strokeWidthPx);
  });

  test("the committed card stays centred on the stage", async () => {
    const config = parsePreviewConfig(await readSources());
    assert.equal(
      (VIEWPORT.width - config.cardWidth) / 2,
      CARD.left,
      "CARD.left must be the horizontal centre"
    );
    assert.equal(
      (VIEWPORT.height - config.cardHeight) / 2,
      CARD.top,
      "CARD.top must be the vertical centre"
    );
  });

  test("the committed caption panel keeps the trimmed vertical padding", async () => {
    // Tuning pass: vertical padding shrinks before the font size does.
    assert.ok(
      CAPTION_PANEL_STYLE.padYPx <= 12,
      `padYPx ${CAPTION_PANEL_STYLE.padYPx} should stay trimmed`
    );
  });

  test("the parsed highlight colours drive the rendered caption style", async () => {
    const config = parsePreviewConfig(await readSources());
    const { CAPTION_HIGHLIGHT, CAPTION_STYLE } = await import(
      "../src/caption-overlay.js"
    );
    assert.equal(CAPTION_HIGHLIGHT.background, config.highlightBackground);
    assert.equal(CAPTION_HIGHLIGHT.text, config.highlightText);
    assert.equal(CAPTION_STYLE.highlightColor, config.highlightBackground);
    assert.equal(CAPTION_STYLE.fontSizePx, config.captionFontSize);
    assert.equal(CAPTION_STYLE.fontFamily, config.captionFontFamily);
  });

  test("a no-op save leaves every source file byte-identical", async () => {
    const sources = await readSources();
    const next = writePreviewConfig(sources, parsePreviewConfig(sources));
    const norm = (s: any) => ({ configTs: s.configTs.replace(/\r\n/g, '\n'), captionOverlayTs: s.captionOverlayTs.replace(/\r\n/g, '\n'), cardTs: s.cardTs.replace(/\r\n/g, '\n') });
    assert.deepEqual(norm(next), norm(sources));
  });

  test("a changed config round-trips back to the same values", async () => {
    const sources = await readSources();
    const before = parsePreviewConfig(sources);
    const after = {
      ...before,
      mascotAsset: "mascot-custom.png",
      mascotWidthPx: 900,
      mascotRight: -12,
      mascotBottom: -6,
      captionTop: 880,
      captionFontSize: 68,
      captionLineHeight: 1.2,
      captionFontWeight: 700,
      captionColor: "#FFF4D6",
      highlightBackground: "#FFE66D",
      highlightText: "#161616",
      cardWidth: 720,
      cardHeight: 1400,
      cardRadius: 40,
      cardShadowIntensity: 0.4,
      cardShadowBlurScale: 1.5,
      enterMs: 170,
      exitYPx: -8,
      calloutBubbleWidth: 390,
      calloutFontSize: 36,
      calloutFill: "#F0F0F0",
      impactStrokeColor: "#FFCC00",
      impactStrokeWidth: 6,
      impactMaxBurstCount: 8,
    };

    const next = writePreviewConfig(sources, after);
    const reread = parsePreviewConfig(next);
    assert.deepEqual(reread, after);
    // Resizing the card re-centres left/top in the same write.
    assert.match(next.configTs, /export const CHARACTER_PNG_FILENAME = "mascot-custom\.png";/);
    assert.match(next.configTs, /width: 720,/);
    assert.match(next.configTs, /height: 1400,/);
    assert.match(next.configTs, /left: 180,/);
    assert.match(next.configTs, /top: 260,/);
    // Hex colours are normalised to the file's convention.
    assert.match(next.captionOverlayTs, /CAPTION_HIGHLIGHT_BG =\n\s*process\.env\.SHOWCASE_CAPTION_HIGHLIGHT_BG \?\? "#FFE66D";/);
    assert.match(next.captionOverlayTs, /CAPTION_HIGHLIGHT_TEXT =\n\s*process\.env\.SHOWCASE_CAPTION_HIGHLIGHT_TEXT \?\? "#161616";/);
    assert.match(next.cardTs, /intensity: 0.4,/);
    assert.match(next.cardTs, /blurScale: 1.5,/);
  });

  test("the card shadow follows the tuned intensity and blur scale", async () => {
    const sources = await readSources();
    const before = parsePreviewConfig(sources);
    const doubled = { ...before, cardShadowIntensity: 0.1, cardShadowBlurScale: 1 };
    const next = writePreviewConfig(sources, doubled);
    const expected = buildCardShadow({ intensity: 0.1, blurScale: 1 });
    assert.equal(CARD_SHADOW, buildCardShadow(CARD_SHADOW_TUNING));
    assert.equal(next.cardTs.includes(`intensity: 0.1`), true);
    assert.ok(expected.includes("0 2px 6px rgba(25,23,20,0.140)"));
  });

  test("a missing target aborts the write instead of producing partial output", async () => {
    const sources = await readSources();
    const broken: ConfigSources = {
      ...sources,
      cardTs: sources.cardTs.replace(/blurScale: -?[\d.]+,/, ""),
    };
    assert.throws(
      () => writePreviewConfig(broken, parsePreviewConfig(sources)),
      /blurScale/
    );
  });

  test("untrusted body values are coerced onto the base shape", async () => {
    const base = parsePreviewConfig(await readSources());
    const normalized = normalizePreviewConfig(
      {
        captionFontSize: "70",
        cardRadius: 44,
        highlightBackground: "#00ff00",
        mascotAsset: "my-mascot.png",
        nonsense: true,
        captionTop: "not-a-number",
      },
      base
    );
    assert.equal(normalized.captionFontSize, 70);
    assert.equal(normalized.cardRadius, 44);
    assert.equal(normalized.highlightBackground, "#00ff00");
    assert.equal(normalized.mascotAsset, "my-mascot.png");
    assert.equal(normalized.captionTop, base.captionTop);
    assert.ok(!("nonsense" in normalized));
  });

  test("a mascot filename can never smuggle a path into config.ts", async () => {
    const sources = await readSources();
    const before = parsePreviewConfig(sources);
    const next = writePreviewConfig(sources, {
      ...before,
      mascotAsset: "../..\\evil.png",
    });
    assert.match(
      next.configTs,
      /export const CHARACTER_PNG_FILENAME = "evil\.png";/,
      "only the basename survives the write"
    );
    assert.equal(parsePreviewConfig(next).mascotAsset, "evil.png");
  });

  test("an extreme card size is clamped so the card stays on the stage", async () => {
    const sources = await readSources();
    const before = parsePreviewConfig(sources);
    const next = writePreviewConfig(sources, {
      ...before,
      cardWidth: 5000,
      cardHeight: -20,
    });
    const reread = parsePreviewConfig(next);
    assert.equal(reread.cardWidth, 1000);
    assert.equal(reread.cardHeight, 560);
    assert.equal(reread.cardWidth / 2 + Number(/left: (-?[\d.]+),/.exec(next.configTs)?.[1]), VIEWPORT.width / 2);
    assert.equal(reread.cardHeight / 2 + Number(/top: (-?[\d.]+),/.exec(next.configTs)?.[1]), VIEWPORT.height / 2);
  });
});
