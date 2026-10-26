import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  CAPTION_HIGHLIGHT,
  CAPTION_MOTION,
  CAPTION_STYLE,
  activeWordIndexAt,
  activeWordStateAt,
  blendHex,
  captionFitsPanel,
  captionFrameHtml,
  captionGroupStyleAt,
  captionHtml,
  captionLineEstimate,
  wrapCaptionText,
  type CaptionPhrase,
} from "../src/caption-overlay.js";
import {
  ACCENT_YELLOW,
  CAPTION_OVERLAY,
  CAPTION_PANEL_STYLE,
  INK,
  VIEWPORT,
  captionOverlayGeometry,
} from "../src/config.js";

const phrase: CaptionPhrase = {
  index: 0,
  startMs: 1000,
  endMs: 2200,
  text: "Rocket CLI ships a one command deploy",
  highlights: ["deploy"],
  segmentId: "s1",
};

describe("caption motion", () => {
  test("motion timings stay inside the specified windows", () => {
    assert.ok(CAPTION_MOTION.enterMs >= 140 && CAPTION_MOTION.enterMs <= 220);
    assert.ok(CAPTION_MOTION.exitMs >= 100 && CAPTION_MOTION.exitMs <= 160);
    assert.ok(CAPTION_MOTION.enterYPx >= 12 && CAPTION_MOTION.enterYPx <= 20);
    assert.ok(CAPTION_MOTION.enterScale >= 0.96 && CAPTION_MOTION.enterScale <= 0.98);
    assert.ok(CAPTION_MOTION.activeWordMs >= 60 && CAPTION_MOTION.activeWordMs <= 80);
  });

  test("the group enters fast and settles within the entrance window", () => {
    const atStart = captionGroupStyleAt(phrase, phrase.startMs + 1);
    assert.ok(atStart.opacity < 0.2, "starts invisible");
    assert.ok(atStart.translateY > 10, "rises from below");

    const halfway = captionGroupStyleAt(phrase, phrase.startMs + CAPTION_MOTION.enterMs / 2);
    assert.ok(halfway.opacity > 0 && halfway.opacity < 1);
    assert.ok(halfway.translateY > 0 && halfway.translateY < CAPTION_MOTION.enterYPx);

    const settled = captionGroupStyleAt(phrase, phrase.startMs + CAPTION_MOTION.enterMs);
    assert.equal(settled.opacity, 1);
    assert.equal(settled.translateY, 0);
    assert.equal(settled.scale, 1);
  });

  test("the group stays stable while the same phrase continues", () => {
    const mid = Math.floor((phrase.startMs + phrase.endMs) / 2);
    const a = captionGroupStyleAt(phrase, mid);
    const b = captionGroupStyleAt(phrase, mid + 10);
    for (const key of ["opacity", "translateY", "scale"] as const) {
      assert.equal(a[key], b[key], `${key} must not move mid-phrase`);
    }
  });

  test("the group exits inside the exit window", () => {
    const before = captionGroupStyleAt(phrase, phrase.endMs - CAPTION_MOTION.exitMs - 1);
    assert.equal(before.opacity, 1);
    const late = captionGroupStyleAt(phrase, phrase.endMs - CAPTION_MOTION.exitMs / 2);
    assert.ok(late.opacity < 1 && late.opacity > 0);
    assert.ok(late.translateY < 0, "sinks up on exit");
    const done = captionGroupStyleAt(phrase, phrase.endMs - 1);
    const mid = captionGroupStyleAt(phrase, phrase.endMs - CAPTION_MOTION.exitMs / 3).opacity;
    assert.ok(done.opacity < mid);
    assert.ok(done.opacity < 0.2);
  });

  test("style at a repeated timestamp is identical (no drift)", () => {
    for (const time of [1050, 1200, 1500, 2100, 2199]) {
      assert.deepEqual(captionGroupStyleAt(phrase, time), captionGroupStyleAt(phrase, time));
    }
  });

  test("the underlying typeface rules match the panel specification", () => {
    assert.equal(CAPTION_STYLE.fontSizePx, 50);
    assert.equal(CAPTION_STYLE.maxLines, 2);
    assert.equal(CAPTION_STYLE.lineHeight, 1.08);
    assert.ok(CAPTION_STYLE.fontSizePx >= 48 && CAPTION_STYLE.fontSizePx <= 52);
    assert.ok(CAPTION_STYLE.fontWeight >= 800);
    // One canonical accent: the pill, the semantic tint and config.ts agree.
    assert.equal(CAPTION_STYLE.highlightColor, CAPTION_HIGHLIGHT.background);
    assert.equal(CAPTION_HIGHLIGHT.background, ACCENT_YELLOW);
    assert.equal(CAPTION_HIGHLIGHT.text, INK);
    assert.equal(CAPTION_STYLE.activeTextColor, INK);
  });
});

describe("caption panel", () => {
  test("the panel is a separate dark layer with a moving pill", () => {
    assert.equal(CAPTION_PANEL_STYLE.maxLines, 2);
    assert.match(CAPTION_PANEL_STYLE.background, /^rgba\(23,25,29,/);
    assert.ok(CAPTION_PANEL_STYLE.radiusPx >= 20);
    // Tuning pass: vertical padding is trimmed before the font size is.
    assert.ok(CAPTION_PANEL_STYLE.padYPx <= 12);
    assert.equal(CAPTION_HIGHLIGHT.radiusPx, 9);
    // The panel stays inside the canvas at its committed placement.
    assert.ok(CAPTION_OVERLAY.topPx + CAPTION_OVERLAY.maxHeightPx <= VIEWPORT.height);
    assert.ok(CAPTION_OVERLAY.leftPx + CAPTION_OVERLAY.widthPx <= VIEWPORT.width);
  });

  test("the committed geometry renders exactly where the preview saved it", () => {
    // Regression: the committed values used to be clamped as if they were
    // overrides, so a saved caption (e.g. top 1590) rendered higher than the
    // position the live preview showed.
    assert.deepEqual(captionOverlayGeometry({} as NodeJS.ProcessEnv), {
      leftPx: CAPTION_OVERLAY.leftPx,
      topPx: CAPTION_OVERLAY.topPx,
      widthPx: CAPTION_OVERLAY.widthPx,
      maxHeightPx: CAPTION_OVERLAY.maxHeightPx,
    });
  });

  test("environment overrides are validated and clamped to the canvas", () => {
    const wide = captionOverlayGeometry({
      SHOWCASE_CAPTION_LEFT_PX: "700",
      SHOWCASE_CAPTION_WIDTH_PX: "900",
      SHOWCASE_CAPTION_TOP_PX: "9999",
    } as NodeJS.ProcessEnv);
    assert.equal(wide.leftPx, 700);
    assert.equal(wide.widthPx, 380, "width is clamped to the remaining canvas");
    assert.equal(wide.topPx, VIEWPORT.height - 120, "top is clamped above the bottom margin");
    // Bad or zero values fall back to the committed geometry instead of NaN.
    const fallback = captionOverlayGeometry({
      SHOWCASE_CAPTION_LEFT_PX: "nope",
      SHOWCASE_CAPTION_TOP_PX: "0",
    } as NodeJS.ProcessEnv);
    assert.equal(fallback.leftPx, CAPTION_OVERLAY.leftPx);
    assert.equal(fallback.topPx, CAPTION_OVERLAY.topPx);
  });

  test("the frame html contains the panel, the pill and the words once", () => {
    const html = captionFrameHtml(phrase, phrase.startMs + 30);
    assert.match(html, /<div class="caption-group" style="opacity:[\d.]+;transform:[^"]+">/);
    assert.match(html, /<div class="caption-panel">/);
    assert.match(html, /<div class="caption-highlight" id="caption-hl"><\/div>/);
    assert.match(html, /<div class="caption-lines">/);
    // Every source word appears exactly once.
    for (const word of phrase.text.split(" ")) {
      const matches = html.split(`>${word}<`).length - 1;
      assert.ok(matches <= 1, `"${word}" rendered more than once`);
    }
    assert.ok(!/background:/i.test(html), "the pill is styled in CSS, not inline");
  });

  test("no panel is emitted when no phrase is active", () => {
    assert.equal(captionFrameHtml(null, 0), "");
  });

  test("exactly one word carries the current class at any timestamp", () => {
    for (const time of [1000, 1100, 1500, 2000, 2199]) {
      const html = captionFrameHtml(phrase, time);
      assert.equal(
        (html.match(/class="w current"/g) ?? []).length,
        1,
        `expected one current word at ${time}ms`
      );
    }
  });

  test("semantic emphasis is a separate class from the current word", () => {
    // "deploy" is the emphasised word; at the first word it is tinted, but it
    // never becomes a second active pill while another word is spoken.
    const first = captionHtml(phrase, 0);
    assert.match(first, /<span class="w current" data-i="0">Rocket<\/span>/);
    assert.match(first, /class="w key-emphasis" data-i="6">deploy<\/span>/);
    assert.equal((first.match(/class="w current"/g) ?? []).length, 1);

    // When the emphasised word becomes current, it is only `.current`.
    const last = captionHtml(phrase, 6);
    assert.match(last, /class="w current" data-i="6">deploy<\/span>/);
    assert.ok(!/class="w key-emphasis"/.test(last));
  });

  test("the current word index follows the measured word schedule", () => {
    assert.equal(activeWordIndexAt(phrase, phrase.startMs), 0);
    assert.equal(activeWordIndexAt(phrase, phrase.startMs - 1), -1);
    assert.equal(activeWordIndexAt(phrase, phrase.endMs + 1), -1);
  });

  test("two-line estimation flags an overlong phrase instead of dropping words", () => {
    assert.equal(captionLineEstimate("Short phrase"), 1);
    assert.ok(captionFitsPanel("Rocket CLI ships a one command deploy"));
    const long =
      "A deterministic narration pipeline that turns long repository documentation into short vertical clips";
    assert.ok(captionLineEstimate(long) > 2);
    assert.equal(captionFitsPanel(long), false);
    // Wrapping still keeps every source word.
    const rejoin = wrapCaptionText(long).join(" ");
    for (const word of long.split(" ")) {
      assert.match(rejoin, new RegExp(`\\b${word}\\b`));
    }
  });
});

describe("active-word colour ramp", () => {
  const channel = (color: string, index: number) =>
    parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
  // Green is the strongest channel difference between the warm-white panel
  // text and the near-black pill text, so it is the clearest ramp signal.
  const BASE_GREEN = channel(CAPTION_STYLE.color, 1);
  const ACTIVE_GREEN = channel(CAPTION_STYLE.activeTextColor, 1);

  test("blendHex interpolates cleanly", () => {
    assert.equal(blendHex("#000000", "#FFFFFF", 0), "#000000");
    assert.equal(blendHex("#000000", "#FFFFFF", 1).toLowerCase(), "#ffffff");
    assert.equal(blendHex("#ff0000", "#FF0000", 0.5), "#ff0000");
    const half = blendHex("#000000", "#FFFFFF", 0.5).toLowerCase();
    assert.ok(half >= "#7f7f7f" && half <= "#818181", `mid-grey expected, got ${half}`);
  });

  test("the highlight takes over at the measured word start, ramping not lagging", () => {
    const state = activeWordStateAt(phrase, phrase.startMs + 10, "Rocket");
    assert.ok(state, "the first word is already active at its measured start");
    const green = channel(state.color, 1);
    const low = Math.min(BASE_GREEN, ACTIVE_GREEN);
    const high = Math.max(BASE_GREEN, ACTIVE_GREEN);
    assert.ok(
      green > low && green < high,
      `green channel should sit between panel and pill text, got ${state.color}`
    );
  });

  test("the ramp completes within the activeWord window", () => {
    const state = activeWordStateAt(phrase, phrase.startMs + 200, "Rocket");
    assert.ok(state);
    assert.equal(state.color.toLowerCase(), CAPTION_STYLE.activeTextColor.toLowerCase());
  });

  test("the ramp is monotonic in time", () => {
    const progress = (color: string) =>
      Math.abs(channel(color, 1) - BASE_GREEN) / Math.abs(ACTIVE_GREEN - BASE_GREEN);
    let previous = 0;
    for (let t = 0; t <= CAPTION_MOTION.activeWordMs; t += 5) {
      const state = activeWordStateAt(phrase, phrase.startMs + t, "Rocket");
      assert.ok(state);
      const value = progress(state.color);
      assert.ok(value >= previous - 0.001, `not monotonic at +${t}ms`);
      previous = value;
    }
    assert.ok(previous > 0.99, "the ramp reaches the full pill text colour");
  });
});
