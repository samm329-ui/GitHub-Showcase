import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPreviewConfig,
  configDiff,
  DEFAULT_PREVIEW_CONFIG,
  normalizePreviewConfig,
  OVERRIDES_PATH,
  readPreviewConfig,
} from "../tools/preview/shared/config-writer.js";
import {
  DEFAULT_VISUAL_OVERRIDES,
  loadVisualOverrides,
  VISUAL_OVERRIDES,
} from "../src/visual-overrides.js";
import { CAPTION_HIGHLIGHT, CAPTION_MOTION, CAPTION_STYLE } from "../src/caption-overlay.js";
import {
  CALLOUT,
  CAPTION_OVERLAY,
  CARD,
  CHARACTER_PNG_FILENAME,
  IMPACT_ACCENTS,
  MASCOT_LAYOUT,
  VIEWPORT,
} from "../src/config.js";
import { buildCardShadow, CARD_SHADOW, CARD_SHADOW_TUNING } from "../src/card.js";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "showcase-overrides-"));
}

/** True when the developer has a `visual-overrides.json` in the repo root;
 * committed-default assertions are only meaningful without it. */
const overridesActive = VISUAL_OVERRIDES !== null;
const committedOnly = {
  skip: overridesActive
    ? "visual-overrides.json is present â€” committed-default assertions skipped"
    : false,
};

describe("visual overrides", () => {
  test("absent file â†’ the committed composition (temp root defaults)", async () => {
    const root = tempRoot();
    const config = await readPreviewConfig(root);
    assert.deepEqual(config, DEFAULT_VISUAL_OVERRIDES);
  });

  test("src and tooling defaults never drift", () => {
    // DEFAULT_PREVIEW_CONFIG (tools/preview/shared/config-model.js, browser) and
    // DEFAULT_VISUAL_OVERRIDES (src/visual-overrides.ts, Node) are two copies
    // of one idea; this asserts they are the same object byte-for-byte.
    assert.deepEqual(DEFAULT_PREVIEW_CONFIG, DEFAULT_VISUAL_OVERRIDES);
  });

  test("the preview and the pipeline agree on the committed composition", committedOnly, () => {
    // With no visual-overrides.json, the renderer consumes exactly the values
    // the preview would show. A regression here means the two halves drifted.
    assert.equal(CAPTION_OVERLAY.leftPx, DEFAULT_VISUAL_OVERRIDES.captionLeft);
    assert.equal(CAPTION_OVERLAY.topPx, DEFAULT_VISUAL_OVERRIDES.captionTop);
    assert.equal(CAPTION_OVERLAY.widthPx, DEFAULT_VISUAL_OVERRIDES.captionWidth);
    assert.equal(CAPTION_OVERLAY.maxHeightPx, DEFAULT_VISUAL_OVERRIDES.captionMaxHeight);
    assert.equal(CARD.width, DEFAULT_VISUAL_OVERRIDES.cardWidth);
    assert.equal(CARD.height, DEFAULT_VISUAL_OVERRIDES.cardHeight);
    assert.equal(CARD.radius, DEFAULT_VISUAL_OVERRIDES.cardRadius);
    assert.equal(CALLOUT.bubbleWidthPx, DEFAULT_VISUAL_OVERRIDES.calloutBubbleWidth);
    assert.equal(CALLOUT.bubbleHeightPx, DEFAULT_VISUAL_OVERRIDES.calloutBubbleHeight);
    assert.equal(CALLOUT.fontSizePx, DEFAULT_VISUAL_OVERRIDES.calloutFontSize);
    assert.equal(CALLOUT.outlineWidthPx, DEFAULT_VISUAL_OVERRIDES.calloutOutlineWidth);
    assert.equal(IMPACT_ACCENTS.strokeWidthPx, DEFAULT_VISUAL_OVERRIDES.impactStrokeWidth);
    assert.equal(IMPACT_ACCENTS.maxBurstCount, DEFAULT_VISUAL_OVERRIDES.impactMaxBurstCount);
    assert.equal(MASCOT_LAYOUT.offsetX, DEFAULT_VISUAL_OVERRIDES.mascotRight);
    assert.equal(MASCOT_LAYOUT.offsetY, DEFAULT_VISUAL_OVERRIDES.mascotBottom);
    assert.equal(CHARACTER_PNG_FILENAME, DEFAULT_VISUAL_OVERRIDES.mascotAsset);
    assert.equal(CARD_SHADOW_TUNING.intensity, DEFAULT_VISUAL_OVERRIDES.cardShadowIntensity);
    assert.equal(CARD_SHADOW_TUNING.blurScale, DEFAULT_VISUAL_OVERRIDES.cardShadowBlurScale);
    assert.equal(CAPTION_STYLE.fontSizePx, DEFAULT_VISUAL_OVERRIDES.captionFontSize);
    assert.equal(CAPTION_STYLE.fontWeight, DEFAULT_VISUAL_OVERRIDES.captionFontWeight);
    assert.equal(CAPTION_STYLE.lineHeight, DEFAULT_VISUAL_OVERRIDES.captionLineHeight);
    assert.equal(CAPTION_STYLE.letterSpacingPx, DEFAULT_VISUAL_OVERRIDES.captionLetterSpacing);
    assert.equal(CAPTION_STYLE.color, DEFAULT_VISUAL_OVERRIDES.captionColor);
    assert.equal(CAPTION_STYLE.textShadow, "0 2px 6px rgba(0,0,0,0.25)");
    assert.equal(CAPTION_MOTION.enterMs, DEFAULT_VISUAL_OVERRIDES.enterMs);
    assert.equal(CAPTION_MOTION.exitYPx, DEFAULT_VISUAL_OVERRIDES.exitYPx);
    assert.equal(CAPTION_HIGHLIGHT.background, DEFAULT_VISUAL_OVERRIDES.highlightBackground);
    assert.equal(CAPTION_HIGHLIGHT.text, DEFAULT_VISUAL_OVERRIDES.highlightText);
  });

  test("the card stays centred on the stage", () => {
    assert.equal(CARD.left, Math.round((VIEWPORT.width - CARD.width) / 2));
    assert.equal(CARD.top, Math.round((VIEWPORT.height - CARD.height) / 2));
  });

  test("a save writes visual-overrides.json and nothing else", async () => {
    const root = tempRoot();
    const tuned = { ...DEFAULT_VISUAL_OVERRIDES, captionFontSize: 58, highlightBackground: "#123abc" };
    const result = await applyPreviewConfig(root, tuned);
    assert.deepEqual(result.files, [OVERRIDES_PATH]);
    assert.ok(result.fields.includes("captionFontSize"));
    assert.ok(result.fields.includes("highlightBackground"));
    const text = await fs.readFile(path.join(root, OVERRIDES_PATH), "utf8");
    assert.match(text, /"captionFontSize": 58/);

    // A no-op save touches nothing.
    const second = await applyPreviewConfig(root, tuned);
    assert.deepEqual(second.files, []);

    const loaded = await readPreviewConfig(root);
    assert.equal(loaded.captionFontSize, 58);
    assert.equal(loaded.highlightBackground, "#123ABC");
  });

  test("the atomic write leaves no temp files behind", async () => {
    const root = tempRoot();
    await applyPreviewConfig(root, { ...DEFAULT_VISUAL_OVERRIDES, cardWidth: 720 });
    const leftovers = (await fs.readdir(root)).filter(name => name !== OVERRIDES_PATH);
    assert.deepEqual(leftovers, []);
  });

  test("a corrupt file falls back to defaults instead of bricking the preview", async () => {
    const root = tempRoot();
    await fs.writeFile(path.join(root, OVERRIDES_PATH), "{ not json", "utf8");
    const config = await readPreviewConfig(root);
    assert.deepEqual(config, DEFAULT_VISUAL_OVERRIDES);
    // And the file can still be overwritten with a valid one.
    const result = await applyPreviewConfig(root, { ...DEFAULT_VISUAL_OVERRIDES, captionFontSize: 51 });
    assert.deepEqual(result.files, [OVERRIDES_PATH]);
    assert.equal((await readPreviewConfig(root)).captionFontSize, 51);
  });

  test("extreme values are clamped so the card stays on the stage", async () => {
    const root = tempRoot();
    const result = await applyPreviewConfig(root, {
      ...DEFAULT_VISUAL_OVERRIDES,
      cardWidth: 5000,
      cardHeight: -20,
    });
    assert.deepEqual(result.files, [OVERRIDES_PATH]);
    const loaded = await readPreviewConfig(root);
    assert.equal(loaded.cardWidth, 1000);
    assert.equal(loaded.cardHeight, 560);
  });

  test("untrusted body values are coerced onto the base shape", () => {
    const normalized = normalizePreviewConfig(
      {
        captionFontSize: "70",
        cardRadius: 44,
        highlightBackground: "#00ff00",
        mascotAsset: "my-mascot.png",
        nonsense: true,
        captionTop: "not-a-number",
      },
      DEFAULT_PREVIEW_CONFIG
    );
    assert.equal(normalized.captionFontSize, 70);
    assert.equal(normalized.cardRadius, 44);
    assert.equal(normalized.highlightBackground, "#00FF00");
    assert.equal(normalized.mascotAsset, "my-mascot.png");
    assert.equal(normalized.captionTop, DEFAULT_PREVIEW_CONFIG.captionTop);
    assert.ok(!("nonsense" in normalized));
  });

  test("a mascot filename can never smuggle a path", () => {
    const normalized = normalizePreviewConfig(
      { mascotAsset: "../..\\evil.png" },
      DEFAULT_PREVIEW_CONFIG
    );
    assert.equal(normalized.mascotAsset, "evil.png");
  });

  test("configDiff lists exactly the changed fields", () => {
    const after = { ...DEFAULT_PREVIEW_CONFIG, captionFontSize: 58, cardRadius: 44 };
    assert.deepEqual(
      [...configDiff(DEFAULT_PREVIEW_CONFIG, after)].sort(),
      ["captionFontSize", "cardRadius"]
    );
  });

  test("the loader normalises a hand-written file", async () => {
    const root = tempRoot();
    await fs.writeFile(
      path.join(root, OVERRIDES_PATH),
      JSON.stringify({
        ...DEFAULT_VISUAL_OVERRIDES,
        highlightBackground: "#ff00aa",
        mascotAsset: "../assets/mascot.png",
        cardWidth: 99999,
      }),
      "utf8"
    );
    const loaded = loadVisualOverrides(root);
    assert.ok(loaded);
    assert.equal(loaded!.highlightBackground, "#FF00AA");
    assert.equal(loaded!.mascotAsset, "mascot.png");
    assert.equal(loaded!.cardWidth, 1000);
  });

  test("loadVisualOverrides returns null for a missing file", () => {
    assert.equal(loadVisualOverrides(tempRoot()), null);
  });

  test("a UTF-8 BOM (Notepad/PowerShell) does not brick the loader", async () => {
    const root = tempRoot();
    await fs.writeFile(
      path.join(root, OVERRIDES_PATH),
      `\uFEFF${JSON.stringify({ ...DEFAULT_VISUAL_OVERRIDES, cardWidth: 720 })}`,
      "utf8"
    );
    const loaded = loadVisualOverrides(root);
    assert.ok(loaded, "BOM-prefixed file should still load");
    assert.equal(loaded!.cardWidth, 720);
  });

  test("the card shadow follows the tuned intensity and blur scale", () => {
    assert.equal(CARD_SHADOW, buildCardShadow(CARD_SHADOW_TUNING));
    const expected = buildCardShadow({ intensity: 0.1, blurScale: 1 });
    assert.ok(expected.includes("0 2px 6px rgba(25,23,20,0.140)"));
  });
});

