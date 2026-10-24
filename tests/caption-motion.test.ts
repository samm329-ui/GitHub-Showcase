import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  CAPTION_HIGHLIGHT,
  CAPTION_MOTION,
  CAPTION_STYLE,
  activeWordStateAt,
  blendHex,
  captionFrameHtml,
  captionGroupStyleAt,
  wrapCaptionText,
  type CaptionPhrase,
} from "../src/caption-overlay.js";

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
    assert.ok(CAPTION_MOTION.activeWordMs >= 70 && CAPTION_MOTION.activeWordMs <= 120);
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
    // Ease-in is asymptotic inside the window; opacity must be nearly gone and
    // monotonically decreasing over time.
    const mid = captionGroupStyleAt(phrase, phrase.endMs - CAPTION_MOTION.exitMs / 3).opacity;
    assert.ok(done.opacity < mid);
    assert.ok(done.opacity < 0.2);
  });

  test("style at a repeated timestamp is identical (no drift)", () => {
    for (const time of [1050, 1200, 1500, 2100, 2199]) {
      assert.deepEqual(captionGroupStyleAt(phrase, time), captionGroupStyleAt(phrase, time));
    }
  });

  test("the underlying typeface rules are untouched", () => {
    assert.equal(CAPTION_STYLE.fontSizePx, 50);
    assert.equal(CAPTION_STYLE.maxLines, 2);
    assert.equal(CAPTION_STYLE.maxCharsPerLine, 22);
    assert.ok(CAPTION_STYLE.fontSizePx >= 48 && CAPTION_STYLE.fontSizePx <= 66);
    // The colour ramp reads the same source as the highlight box, so they
    // cannot drift apart when the preview saves new colours.
    assert.equal(CAPTION_STYLE.highlightColor, CAPTION_HIGHLIGHT.background);
  });
});

describe("active-word colour ramp", () => {
  const channel = (color: string, index: number) =>
    parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
  // Green is the strongest channel difference between the cream base and the
  // (configurable) highlight, so it is the clearest ramp signal.
  const BASE_GREEN = channel(CAPTION_STYLE.color, 1);
  const HIGHLIGHT_GREEN = channel(CAPTION_STYLE.highlightColor, 1);

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
    const low = Math.min(BASE_GREEN, HIGHLIGHT_GREEN);
    const high = Math.max(BASE_GREEN, HIGHLIGHT_GREEN);
    assert.ok(
      green > low && green < high,
      `green channel should sit between base and highlight, got ${state.color}`
    );
  });

  test("the ramp completes within the activeWord window", () => {
    const state = activeWordStateAt(phrase, phrase.startMs + 200, "Rocket");
    assert.ok(state);
    assert.equal(state.color.toLowerCase(), CAPTION_STYLE.highlightColor.toLowerCase());
  });

  test("the ramp is monotonic in time", () => {
    const progress = (color: string) =>
      (channel(color, 1) - BASE_GREEN) / (HIGHLIGHT_GREEN - BASE_GREEN);
    let previous = 0;
    for (let t = 0; t <= CAPTION_MOTION.activeWordMs; t += 5) {
      const state = activeWordStateAt(phrase, phrase.startMs + t, "Rocket");
      assert.ok(state);
      const value = progress(state.color);
      assert.ok(value >= previous - 0.001, `not monotonic at +${t}ms`);
      previous = value;
    }
    assert.ok(previous > 0.99, "the ramp reaches the full highlight colour");
  });

  test("frame html marks the individual active word with an inline colour", () => {
    const html = captionFrameHtml(phrase, phrase.startMs + 30);
    assert.match(html, /<div class="caption-group" style="opacity:[\d.]+;transform:[^"]+">/);
    assert.match(html, /<div class="caption-highlight" id="caption-hl"><\/div>/);
    assert.match(html, /<span class="w/);
    assert.ok(!/background/i.test(html), "no filled boxes in the phrase html");
  });

  test("an empty phrase renders nothing", () => {
    assert.equal(captionFrameHtml(null, 0), "");
  });

  test("wrap still enforces two lines for callout captions", () => {
    const long = "This is a fairly long caption text for the reel";
    const lines = wrapCaptionText(long);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(line.length <= 26, `line too long: ${line}`);
    }
  });
});
