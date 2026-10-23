import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "canvas";
import {
  chooseStoryEnd,
  cropMobileCapture,
  detectFailedPage,
  normalizeRasterSize,
  scaleAnchorOffsets,
} from "../src/mobile-capture.js";
import { CARD_VIEWPORT_HEIGHT, MOBILE_PAGE } from "../src/config.js";
import type { MobilePageCapture } from "../src/types.js";

describe("mobile raster geometry", () => {
  test("CSS anchor offsets are converted to displayed raster pixels", () => {
    const anchors = scaleAnchorOffsets(
      [
        { anchor: "repo-header", offsetTop: 0, offsetHeight: 120 },
        { anchor: "readme-intro", offsetTop: 500.4, offsetHeight: 800.2 },
        { anchor: "license", offsetTop: -4, offsetHeight: 10 },
        { anchor: "release", offsetTop: 900, offsetHeight: 0 },
      ],
      2
    );
    assert.deepEqual(anchors, [
      { anchor: "repo-header", offsetTop: 0, offsetHeight: 240, source: "captured" },
      { anchor: "readme-intro", offsetTop: 1001, offsetHeight: 1600, source: "captured" },
    ]);
  });

  test("normalisation keeps the aspect ratio and the target width", () => {
    const result = normalizeRasterSize(810, 4000, 810);
    assert.equal(result.width, 810);
    assert.equal(result.height, 4000);
    assert.equal(result.scale, 1);

    const doubled = normalizeRasterSize(1620, 8000, 810);
    assert.equal(doubled.width, 810);
    assert.equal(doubled.height, 4000);
    assert.equal(doubled.scale, 0.5);
  });
});

describe("failed page detection", () => {
  const healthy = {
    url: "https://github.com/acme/rocket-cli",
    title: "acme/rocket-cli",
    bodyText: "x".repeat(500),
    documentHeightCssPx: 4000,
    viewportHeightCssPx: 720,
  };

  test("a real repository page passes", () => {
    assert.equal(detectFailedPage(healthy), null);
  });

  test("sign-in, 404, abuse and blank pages are rejected", () => {
    assert.match(
      detectFailedPage({ ...healthy, url: "https://github.com/login?return_to=x" }) ?? "",
      /sign-in/
    );
    assert.match(
      detectFailedPage({ ...healthy, title: "Page not found" }) ?? "",
      /404/
    );
    assert.match(
      detectFailedPage({ ...healthy, bodyText: "Whoa there! unusual traffic" }) ?? "",
      /abuse/
    );
    assert.match(
      detectFailedPage({ ...healthy, bodyText: "short" }) ?? "",
      /blank/
    );
  });
});

describe("story span", () => {
  const anchors = [
    { anchor: "repo-header" as const, offsetTop: 0, offsetHeight: 300, source: "captured" as const },
    { anchor: "readme-intro" as const, offsetTop: 900, offsetHeight: 1600, source: "captured" as const },
    { anchor: "install-command" as const, offsetTop: 3200, offsetHeight: 300, source: "captured" as const },
  ];

  test("the crop ends after the last narrated section plus breathing room", () => {
    const span = chooseStoryEnd({
      anchors,
      fullHeightPx: 8000,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      durationMs: 50_000,
      referencedAnchors: ["repo-header", "readme-intro"],
    });
    assert.ok(span.endPx > 900 + 1600);
    assert.ok(span.endPx < 8000);
    assert.equal(span.startPx, 0);
  });

  test("the crop is capped by the speed and viewport budgets", () => {
    const span = chooseStoryEnd({
      anchors,
      fullHeightPx: 40_000,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      durationMs: 12_000,
      referencedAnchors: ["install-command"],
      maxPxPerSecond: 190,
      maxStoryViewports: 2.2,
    });
    assert.ok(span.endPx <= Math.round(CARD_VIEWPORT_HEIGHT * 2.2) + 1);
    assert.ok(span.warnings.length > 0, "a capped story must say why");
  });

  test("a story always has substance even with a short page", () => {
    const span = chooseStoryEnd({
      anchors: anchors.slice(0, 1),
      fullHeightPx: 300,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      durationMs: 35_000,
      referencedAnchors: ["repo-header"],
    });
    assert.equal(span.endPx, 300);
    assert.equal(span.fullHeightPx, 300);
  });
});

describe("story crop output", () => {
  test("cropping trims the image and clamps anchors to the new height", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "showcase-crop-"));
    const source = path.join(dir, "full.jpg");
    const target = path.join(dir, "story.jpg");
    try {
      const canvas = createCanvas(810, 2400);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, 810, 2400);
      await fs.writeFile(source, canvas.toBuffer("image/jpeg", { quality: 90 }));

      const capture: MobilePageCapture = {
        imagePath: source,
        sourceUrl: "https://github.com/acme/rocket-cli",
        source: "live",
        cssViewport: { width: MOBILE_PAGE.viewportWidthCss, height: MOBILE_PAGE.viewportHeightCss },
        raster: { width: 810, height: 2400 },
        rawRaster: { width: 1620, height: 4800 },
        pixelsPerCssPx: 2,
        documentHeightCssPx: 1200,
        anchors: [
          { anchor: "repo-header", offsetTop: 0, offsetHeight: 300, source: "captured" },
          { anchor: "features", offsetTop: 1000, offsetHeight: 500, source: "captured" },
          { anchor: "license", offsetTop: 2300, offsetHeight: 200, source: "captured" },
        ],
        title: "acme/rocket-cli",
        capturedAt: new Date().toISOString(),
        warnings: [],
      };

      const cropped = await cropMobileCapture(capture, 1800, target);
      assert.equal(cropped.raster.width, 810);
      assert.equal(cropped.raster.height, 1800);
      assert.equal(cropped.imagePath, target);
      assert.equal(cropped.anchors.length, 2, "the anchor below the crop is removed");
      const clipped = cropped.anchors.find(anchor => anchor.anchor === "features");
      assert.equal(clipped?.offsetHeight, 500);
      const image = await fs.readFile(target);
      assert.ok(image.length > 1000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
