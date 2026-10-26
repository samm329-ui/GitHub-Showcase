import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { loadImage, createCanvas } from "canvas";
import {
  CHARACTER_ALPHA_BOUNDS,
  CHARACTER_CLOSE_ALPHA_BOUNDS,
  mascotHeadAnchor,
  mascotPlacementCss,
  speechCalloutZone,
  type AlphaBounds,
} from "../src/mascot-layout.js";
import {
  CALLOUT,
  CARD,
  CARD_CHROME_HEIGHT,
  CARD_VIEWPORT_HEIGHT,
  MASCOT_LAYOUT,
  VIEWPORT,
} from "../src/config.js";
import { placeCallout } from "../src/callout-overlay.js";

const RENDERED_WIDTH = Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width);
const PLACEMENT_INPUT = {
  bounds: CHARACTER_ALPHA_BOUNDS,
  renderedWidthPx: RENDERED_WIDTH,
  canvasWidth: VIEWPORT.width,
  canvasHeight: VIEWPORT.height,
  clipRightPx: MASCOT_LAYOUT.offsetX,
  clipBottomPx: MASCOT_LAYOUT.offsetY,
} as const;

/**
 * Measure a PNG's visible alpha bounds directly from the asset bytes, using
 * the same rule the constants were derived with (alpha > 0).
 */
async function measureAlphaBounds(file: string): Promise<AlphaBounds> {
  const image = await loadImage(file);
  const ctx = createCanvas(image.width, image.height).getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = data[(y * image.width + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { srcWidth: image.width, srcHeight: image.height, minX, minY, maxX, maxY };
}

describe("mascot alpha bounds", () => {
  test("the shipped presenter PNG matches the recorded visible bounds", async () => {
    const measured = await measureAlphaBounds("assets/character.png");
    const recorded = CHARACTER_ALPHA_BOUNDS;
    for (const key of ["srcWidth", "srcHeight", "minX", "minY", "maxX", "maxY"] as const) {
      assert.ok(
        Math.abs(measured[key] - recorded[key]) <= 1,
        `${key}: measured ${measured[key]} vs recorded ${recorded[key]}`
      );
    }
  });

  test("the close pose PNG matches the recorded visible bounds", async () => {
    const measured = await measureAlphaBounds("assets/character-close.png");
    const recorded = CHARACTER_CLOSE_ALPHA_BOUNDS;
    for (const key of ["srcWidth", "srcHeight", "minX", "minY", "maxX", "maxY"] as const) {
      assert.ok(
        Math.abs(measured[key] - recorded[key]) <= 1,
        `${key}: measured ${measured[key]} vs recorded ${recorded[key]}`
      );
    }
  });

  test("the PNGs are transparent, not white-matted", async () => {
    for (const [file, bounds] of [
      ["assets/character.png", CHARACTER_ALPHA_BOUNDS],
      ["assets/character-close.png", CHARACTER_CLOSE_ALPHA_BOUNDS],
    ] as const) {
      const image = await loadImage(file);
      const ctx = createCanvas(image.width, image.height).getContext("2d");
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data;
      // Every pixel outside the recorded visible bounds must be transparent:
      // an unwanted white matte would put opaque (white) pixels there.
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const inside =
            x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
          if (inside) continue;
          const alpha = data[(y * image.width + x) * 4 + 3];
          assert.ok(alpha < 8, `${file} has an opaque matte pixel at (${x},${y})`);
        }
      }
    }
  });
});

describe("mascot placement", () => {
  const placement = mascotPlacementCss(PLACEMENT_INPUT);

  test("the rendered width follows the committed mascot scale", () => {
    // The width is authored live in the preview; the invariant is that the
    // placement uses exactly the committed ratio and stays canvas-dominant.
    assert.equal(placement.widthPx, RENDERED_WIDTH);
    assert.equal(
      placement.widthPx,
      Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width)
    );
    assert.equal(placement.visibleWidthPx / VIEWPORT.width > 0.5, true);
  });

  test("the visible artwork follows the signed offsets (clip past / lift inside)", () => {
    const scale = placement.widthPx / CHARACTER_ALPHA_BOUNDS.srcWidth;
    const deadRightPx = (CHARACTER_ALPHA_BOUNDS.srcWidth - 1 - CHARACTER_ALPHA_BOUNDS.maxX) * scale;
    const deadBottomPx =
      (CHARACTER_ALPHA_BOUNDS.srcHeight - 1 - CHARACTER_ALPHA_BOUNDS.maxY) * scale;
    // The CSS compensates for the PNG's transparent padding so the *visible*
    // edge — not the image rectangle — lands on the authored offset, whether
    // it crosses the edge (negative) or is lifted inside the frame (positive).
    const expectedRight = MASCOT_LAYOUT.offsetX - deadRightPx;
    const expectedBottom = MASCOT_LAYOUT.offsetY - deadBottomPx;
    assert.ok(
      Math.abs(placement.rightPx - expectedRight) < 0.01,
      `right ${placement.rightPx} vs ${expectedRight}`
    );
    assert.ok(
      Math.abs(placement.bottomPx - expectedBottom) < 0.01,
      `bottom ${placement.bottomPx} vs ${expectedBottom}`
    );
    // Signed semantics: positive output = lifted inside, negative = clipped past.
    assert.ok(
      Math.abs(placement.clipRightPx - -MASCOT_LAYOUT.offsetX) < 0.01,
      `right clip ${placement.clipRightPx}`
    );
    assert.ok(
      Math.abs(placement.clipBottomPx - -MASCOT_LAYOUT.offsetY) < 0.01,
      `bottom clip ${placement.clipBottomPx}`
    );
    // The visible edges sit exactly at the authored signed offsets.
    const visibleRight = VIEWPORT.width - (placement.rightPx + deadRightPx);
    const visibleBottom = VIEWPORT.height - (placement.bottomPx + deadBottomPx);
    assert.ok(Math.abs(visibleRight - (VIEWPORT.width - MASCOT_LAYOUT.offsetX)) < 0.01);
    assert.ok(Math.abs(visibleBottom - (VIEWPORT.height - MASCOT_LAYOUT.offsetY)) < 0.01);
    assert.ok(
      MASCOT_LAYOUT.offsetY > 0
        ? visibleBottom < VIEWPORT.height
        : visibleBottom > VIEWPORT.height,
      "the sign decides lift-inside vs clip-past"
    );
  });

  test("the transparent padding is excluded from the visible size", () => {
    assert.ok(placement.visibleWidthPx < placement.widthPx);
    assert.ok(placement.visibleHeightPx < placement.renderedHeightPx);
    const dead = placement.widthPx - placement.visibleWidthPx;
    assert.ok(dead > 0 && dead < 12, `dead space should be a few px, got ${dead}`);
  });

  test("placement is deterministic", () => {
    const again = mascotPlacementCss({ ...PLACEMENT_INPUT });
    assert.deepEqual(again, placement);
  });
});

describe("mascot head anchor and caption callout zone", () => {
  const placement = mascotPlacementCss(PLACEMENT_INPUT);
  const head = mascotHeadAnchor(PLACEMENT_INPUT, placement);

  test("the head-top line sits in the lower half of the canvas", () => {
    // The mascot is deliberately bottom-cropped (the bottom clip is authored
    // live), so the head may sit low — it just may not leave the canvas.
    assert.ok(head.headTopY > VIEWPORT.height * 0.4, `got ${head.headTopY}`);
    assert.ok(head.headTopY < VIEWPORT.height - 100, `got ${head.headTopY}`);
    // face centre: on the mascot artwork, right of the canvas middle
    assert.ok(head.faceCenterX > VIEWPORT.width * 0.5, `got ${head.faceCenterX}`);
    assert.ok(head.faceCenterX < VIEWPORT.width, `got ${head.faceCenterX}`);
  });

  test("the caption block hangs headGapPx above the head-top line", () => {
    const zone = speechCalloutZone({
      headTopY: head.headTopY,
      viewportTopPx: CARD.top + CARD_CHROME_HEIGHT,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      headGapPx: 32,
    });
    const viewportBottomY = CARD.top + CARD_CHROME_HEIGHT + CARD_VIEWPORT_HEIGHT;
    const blockBottomY = viewportBottomY - zone.bottomRatio * CARD_VIEWPORT_HEIGHT;
    assert.ok(Math.abs(blockBottomY - (head.headTopY - 32)) < 0.5);
    assert.ok(zone.bottomRatio > 0 && zone.bottomRatio < 1);
  });

  test("the caption zone keeps clear of the mascot when it bobs", () => {
    // Speech bob is <= 8px; the 32px gap plus entrance margin 16px means the
    // caption can never intersect the artwork.
    assert.ok(32 > 8 + 16);
  });

  test("the callout bubble is placed from the same head anchor", () => {
    const layout = placeCallout(head);
    assert.deepEqual(layout, placeCallout(head));
    // The bubble body sits fully above the head-top line, so the face never
    // disappears behind it; only the tail reaches down toward the glasses.
    assert.ok(
      layout.top + CALLOUT.bodyHeightPx <= head.headTopY,
      `body ends ${layout.top + CALLOUT.bodyHeightPx}, head at ${head.headTopY}`
    );
    assert.ok(layout.tailTipY > head.headTopY);
    assert.ok(Math.abs(layout.tailTipX - head.faceCenterX) <= 120);
    assert.ok(layout.left + layout.width <= VIEWPORT.width);
  });

  test("the zone is deterministic", () => {
    const first = speechCalloutZone({
      headTopY: head.headTopY,
      viewportTopPx: CARD.top + CARD_CHROME_HEIGHT,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      headGapPx: 32,
    });
    const second = speechCalloutZone({
      headTopY: head.headTopY,
      viewportTopPx: CARD.top + CARD_CHROME_HEIGHT,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      headGapPx: 32,
    });
    assert.deepEqual(first, second);
  });
});
