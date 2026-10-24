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
    const config = parsePreviewConfig(await readSources());
    assert.equal(config.mascotWidthPx, 943);
    assert.equal(config.mascotRight, -60);
    assert.equal(config.mascotBottom, -23);
    assert.equal(config.captionLeft, 200);
    assert.equal(config.captionTop, 1510);
    assert.equal(config.captionWidth, 680);
    assert.equal(config.captionMaxHeight, 190);
    assert.equal(config.captionFontWeight, 900);
    assert.equal(config.captionFontSize, 50);
    assert.equal(config.captionLineHeight, 1.08);
    assert.equal(config.captionLetterSpacing, -1.3);
    assert.equal(config.cardRadius, 52);
    assert.equal(config.cardShadowIntensity, CARD_SHADOW_TUNING.intensity);
    assert.equal(config.cardShadowBlurScale, CARD_SHADOW_TUNING.blurScale);
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
      cardRadius: 40,
      cardShadowIntensity: 0.4,
      cardShadowBlurScale: 1.5,
      enterMs: 170,
      exitYPx: -8,
    };

    const next = writePreviewConfig(sources, after);
    const reread = parsePreviewConfig(next);
    assert.deepEqual(reread, after);
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
        nonsense: true,
        captionTop: "not-a-number",
      },
      base
    );
    assert.equal(normalized.captionFontSize, 70);
    assert.equal(normalized.cardRadius, 44);
    assert.equal(normalized.highlightBackground, "#00ff00");
    assert.equal(normalized.captionTop, base.captionTop);
    assert.ok(!("nonsense" in normalized));
  });
});
