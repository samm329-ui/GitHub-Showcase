import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildCalloutCues,
  calloutCueAt,
  calloutStateAt,
  calloutTextFor,
  placeCallout,
} from "../src/callout-overlay.js";
import { CALLOUT, MASCOT_LAYOUT, VIEWPORT } from "../src/config.js";
import { mascotHeadAnchor, mascotPlacementCss, CHARACTER_ALPHA_BOUNDS } from "../src/mascot-layout.js";
import type { AudioChunk, NarrationSegment } from "../src/types.js";

function segment(overrides: Partial<NarrationSegment> = {}): NarrationSegment {
  return {
    id: "seg-01",
    purpose: "identify",
    spokenText: "Rocket CLI turns long videos into short clips.",
    captionText: "It takes a long recording and finds short, vertical segments.",
    factIds: ["purpose:abc"],
    narrativeRole: "identity",
    calloutText: "Turns long videos into short clips!",
    ...overrides,
  };
}

function chunk(overrides: Partial<AudioChunk> = {}): AudioChunk {
  return {
    index: 0,
    segmentId: "seg-01",
    file: "/tmp/seg-01.wav",
    text: "spoken",
    durationMs: 2000,
    sampleRate: 24000,
    channels: 1,
    startMs: 2000,
    endMs: 4000,
    ...overrides,
  };
}

function headAnchor() {
  const input = {
    bounds: CHARACTER_ALPHA_BOUNDS,
    renderedWidthPx: Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width),
    canvasWidth: VIEWPORT.width,
    canvasHeight: VIEWPORT.height,
    clipRightPx: MASCOT_LAYOUT.offsetX,
    clipBottomPx: MASCOT_LAYOUT.offsetY,
  };
  return mascotHeadAnchor(input, mascotPlacementCss(input));
}

describe("callout copy", () => {
  test("a transformation clause becomes concise bubble copy", () => {
    assert.equal(
      calloutTextFor("A command-line tool that turns long videos into short clips."),
      "Turns long videos into short clips!"
    );
  });

  test("an over-long purpose drops only a trailing qualifier", () => {
    assert.equal(
      calloutTextFor("Rocket CLI is a command-line tool for TypeScript services."),
      "Rocket CLI is a command-line tool!"
    );
  });

  test("no short faithful form means no bubble copy", () => {
    assert.equal(calloutTextFor(""), null);
    assert.equal(calloutTextFor("The tool."), null);
    assert.equal(
      calloutTextFor(
        "Extraordinarily complicated enterprise grade distributed orchestration infrastructure platform software"
      ),
      null
    );
    // A generic cheer is never used as a fallback.
    assert.notEqual(calloutTextFor("The tool."), "Check this out!");
  });

  test("copy stays inside the word and line limits", () => {
    const text = calloutTextFor(
      "A small library that turns long docs into clips"
    );
    assert.ok(text);
    const words = text.trim().split(/\s+/).length;
    assert.ok(words >= CALLOUT.minWords && words <= CALLOUT.maxWords, text);
    assert.ok(!/\s{2,}/.test(text), "copy is normalised");
  });
});

describe("callout cues", () => {
  test("exactly one cue is generated from the purpose segment", () => {
    const cues = buildCalloutCues(
      [segment(), segment({ id: "seg-02", narrativeRole: "value", calloutText: "Other text" })],
      [chunk(), chunk({ index: 1, segmentId: "seg-02", startMs: 4100, endMs: 6000 })]
    );
    assert.equal(cues.length, 1);
    assert.equal(cues[0].segmentId, "seg-01");
    assert.equal(cues[0].anchor, "mascot-head");
    assert.deepEqual(cues[0].factIds, ["purpose:abc"]);
  });

  test("timing derives from the measured chunk, not a fixed timestamp", () => {
    const cue = buildCalloutCues([segment()], [chunk()])[0];
    assert.equal(cue.startMs, 1900, "100 ms before the measured chunk start");
    assert.equal(cue.endMs, 4200, "200 ms after the measured chunk end");
  });

  test("the bubble never appears before the mascot has settled", () => {
    const cue = buildCalloutCues([segment()], [chunk({ startMs: 100, endMs: 1800 })])[0];
    assert.ok(cue.startMs >= CALLOUT.minStartMs, `got ${cue.startMs}`);
    assert.ok(cue.startMs < cue.endMs);
  });

  test("a cue never outlives the video", () => {
    const clamped = buildCalloutCues([segment()], [chunk()], 2500)[0];
    assert.ok(clamped.endMs <= 2500, `end ${clamped.endMs} past the audio`);
    assert.ok(clamped.startMs < clamped.endMs);
    assert.deepEqual(buildCalloutCues([segment()], [chunk()], 2000), []);
  });

  test("the cue stays bounded and inside the narration", () => {
    const cue = buildCalloutCues(
      [segment()],
      [chunk({ startMs: 1000, endMs: 20_000 })]
    )[0];
    assert.ok(cue.endMs - cue.startMs <= CALLOUT.maxVisibleMs);
    assert.ok(cue.endMs <= 20_200);
    assert.equal(calloutCueAt([cue], cue.startMs), cue);
    assert.equal(calloutCueAt([cue], cue.endMs), null);
  });

  test("missing text, evidence or a measured chunk produces no cue", () => {
    assert.deepEqual(
      buildCalloutCues([segment({ calloutText: undefined })], [chunk()]),
      []
    );
    assert.deepEqual(buildCalloutCues([segment({ factIds: [] })], [chunk()]), []);
    assert.deepEqual(buildCalloutCues([segment()], []), []);
  });

  test("a bubble that repeats the subtitle verbatim is omitted", () => {
    assert.deepEqual(
      buildCalloutCues(
        [segment({ calloutText: "It takes a long recording and finds short, vertical segments." })],
        [chunk()]
      ),
      []
    );
  });
});

describe("callout state", () => {
  const cue = {
    id: "callout:seg-01",
    segmentId: "seg-01",
    text: "Turns long videos into short clips!",
    startMs: 1000,
    endMs: 4000,
    factIds: ["purpose:abc"],
    anchor: "mascot-head" as const,
  };

  test("before, at and after the cue", () => {
    const before = calloutStateAt(cue, cue.startMs - 1);
    assert.equal(before.visible, false);
    assert.equal(before.opacity, 0);
    const after = calloutStateAt(cue, cue.endMs);
    assert.equal(after.visible, false);
    assert.equal(after.opacity, 0);
    const hidden = calloutStateAt(null, 2000);
    assert.equal(hidden.cueId, null);
    assert.equal(hidden.visible, false);
  });

  test("entrance starts at zero and reaches full opacity at its window end", () => {
    const start = calloutStateAt(cue, cue.startMs);
    assert.equal(start.opacity, 0);
    assert.ok(start.translateY > 0);
    assert.equal(start.scale, CALLOUT.enterScale);

    const settled = calloutStateAt(cue, cue.startMs + CALLOUT.enterMs);
    assert.equal(settled.opacity, 1);
    assert.equal(settled.translateY, 0);
    assert.equal(settled.scale, 1);
    assert.equal(settled.raysOpacity, 1);
  });

  test("the rays arrive inside their own shorter window", () => {
    const mid = calloutStateAt(cue, cue.startMs + CALLOUT.rayMs / 2);
    assert.ok(mid.raysOpacity > 0 && mid.raysOpacity < 1);
    assert.equal(calloutStateAt(cue, cue.startMs + CALLOUT.rayMs).raysOpacity, 1);
  });

  test("the bubble holds still, then fades out completely", () => {
    const held = calloutStateAt(cue, cue.endMs - CALLOUT.exitMs - 100);
    const later = calloutStateAt(cue, cue.endMs - CALLOUT.exitMs / 2);
    assert.equal(held.opacity, 1);
    assert.equal(held.scale, 1);
    assert.ok(later.opacity < 1 && later.opacity > 0);
    assert.ok(later.translateY < 0, "rises slightly on exit");
    const almost = calloutStateAt(cue, cue.endMs - 1);
    assert.ok(almost.opacity < 0.2);
  });

  test("the same timestamp always produces the same state", () => {
    for (const time of [1000, 1150, 2000, 3900]) {
      assert.deepEqual(calloutStateAt(cue, time), calloutStateAt(cue, time));
    }
  });
});

describe("callout layout", () => {
  const head = headAnchor();
  const layout = placeCallout(head);

  test("the bubble body stays inside the canvas", () => {
    assert.ok(layout.left >= 0);
    assert.ok(layout.top >= 0);
    assert.ok(layout.left + layout.width <= VIEWPORT.width);
    assert.ok(layout.top + layout.height <= VIEWPORT.height);
    assert.ok(layout.left >= CALLOUT.leftMinPx);
  });

  test("the tail aims at the measured head anchor", () => {
    // The tail tip is below the head-top line and near the face horizontally.
    assert.ok(layout.tailTipY > head.headTopY, "tail points down toward the face");
    assert.ok(Math.abs(layout.tailTipX - head.faceCenterX) <= 120);
    assert.ok(layout.tailTipX >= layout.left && layout.tailTipX <= layout.left + layout.width);
  });

  test("placement is deterministic and head-relative", () => {
    assert.deepEqual(placeCallout(head), layout);
    const shifted = placeCallout({ headTopY: head.headTopY - 40, faceCenterX: head.faceCenterX });
    assert.notEqual(shifted.top, layout.top);
  });
});
