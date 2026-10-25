import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildCalloutCues,
  calloutCueAt,
  calloutStateAt,
  calloutTextFor,
  placeCallout,
} from "../src/callout-overlay.js";
import {
  CALLOUT,
  DEFAULT_CALLOUT_PROFILE,
  FALLBACK_SVG_CALLOUT_PROFILE,
  MASCOT_LAYOUT,
  STICKER_CALLOUT_PROFILE,
  VIEWPORT,
} from "../src/config.js";
import {
  CHARACTER_ALPHA_BOUNDS,
  getMascotFrameGeometry,
  mascotHeadAnchor,
  mascotPlacementCss,
} from "../src/mascot-layout.js";
import {
  calloutTextBox,
  scoreCalloutCandidate,
} from "../src/callout-overlay.js";
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

  test("asset-aware placement scales height and uses PNG-specific tail coordinates", () => {
    const pngLayout = placeCallout(head, CALLOUT, DEFAULT_CALLOUT_PROFILE);
    assert.equal(pngLayout.width, 370);
    assert.equal(pngLayout.height, Math.round(370 * (789 / 1082)));
    // Tail tip uses normalized ~0.365 of width
    const expectedTailLocal = Math.round(370 * DEFAULT_CALLOUT_PROFILE.tailTip.x);
    assert.ok(Math.abs(pngLayout.tailTipX - (pngLayout.left + expectedTailLocal)) < 0.01);

    const svgLayout = placeCallout(head, { ...CALLOUT, bubbleWidthPx: 360 }, FALLBACK_SVG_CALLOUT_PROFILE);
    assert.equal(svgLayout.width, 360);
    assert.equal(svgLayout.height, 285);
    assert.ok(Math.abs(svgLayout.tailTipX - (svgLayout.left + 82)) < 0.01);
  });

  test("calloutTextBox returns safe coordinates inside the bubble body", () => {
    const box = calloutTextBox(layout, DEFAULT_CALLOUT_PROFILE);
    assert.ok(box.left > layout.left);
    assert.ok(box.top > layout.top);
    assert.ok(box.left + box.width < layout.left + layout.width);
    assert.ok(box.top + box.height < layout.top + layout.height);
  });
});

describe("multi-callout scheduling and diversity", () => {
  const multiSegments: NarrationSegment[] = [
    segment({
      id: "seg-01",
      purpose: "identify",
      calloutRole: "purpose",
      calloutText: "Turn long videos into short clips!",
      factIds: ["p:01"],
    }),
    segment({
      id: "seg-02",
      purpose: "explain",
      calloutRole: "mechanism",
      calloutText: "Finds the strongest moments!",
      factIds: ["m:01"],
    }),
    segment({
      id: "seg-03",
      purpose: "demo",
      calloutRole: "example",
      calloutText: "Exports clean vertical video!",
      factIds: ["e:01"],
    }),
  ];

  const multiChunks: AudioChunk[] = [
    chunk({ segmentId: "seg-01", startMs: 1000, endMs: 3800 }),
    chunk({ segmentId: "seg-02", startMs: 5000, endMs: 8200 }),
    chunk({ segmentId: "seg-03", startMs: 9500, endMs: 12800 }),
  ];

  test("schedules multiple non-overlapping cues across sequential chunks", () => {
    const cues = buildCalloutCues(multiSegments, multiChunks, 20_000);
    assert.equal(cues.length, 3);
    assert.equal(cues[0].role, "purpose");
    assert.equal(cues[1].role, "mechanism");
    assert.equal(cues[2].role, "example");

    for (let i = 1; i < cues.length; i += 1) {
      assert.ok(
        cues[i].startMs >= cues[i - 1].endMs + 400,
        `gap between cue ${i - 1} and ${i} is at least 400ms`
      );
    }
  });

  test("shortens earlier cue to resolve collision instead of rejecting", () => {
    const collidingChunks: AudioChunk[] = [
      chunk({ segmentId: "seg-01", startMs: 1000, endMs: 4000 }),
      chunk({ segmentId: "seg-02", startMs: 4500, endMs: 7500 }),
    ];
    const cues = buildCalloutCues(multiSegments.slice(0, 2), collidingChunks, 20_000, { minGapMs: 500 });
    assert.equal(cues.length, 2);
    assert.ok(cues[0].endMs <= cues[1].startMs - 500);
    assert.ok(cues[0].endMs - cues[0].startMs >= 1200);
  });

  test("seeded selection is deterministic across repeated runs", () => {
    const run1 = buildCalloutCues(multiSegments, multiChunks, 20_000, { seed: "repo-123" });
    const run2 = buildCalloutCues(multiSegments, multiChunks, 20_000, { seed: "repo-123" });
    assert.deepEqual(run1, run2);
  });

  test("candidate scoring rewards specific action copy and penalizes caption overlap", () => {
    const scored1 = scoreCalloutCandidate(multiSegments[0], multiChunks[0]);
    assert.ok(scored1 && scored1.score > 0.6);
    assert.ok(scored1.curiosity >= 0.8, "turns long videos into clips has action curiosity");

    const verbatimSeg = segment({
      captionText: "turn long videos into short clips",
      calloutText: "turn long videos into short clips",
    });
    const scoredVerbatim = scoreCalloutCandidate(verbatimSeg, multiChunks[0]);
    assert.equal(scoredVerbatim, null, "verbatim copy is rejected");
  });

  test("callout anchor follows the mascot transform", () => {
    const placementInput = {
      bounds: CHARACTER_ALPHA_BOUNDS,
      renderedWidthPx: Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width),
      canvasWidth: VIEWPORT.width,
      canvasHeight: VIEWPORT.height,
      clipRightPx: MASCOT_LAYOUT.offsetX,
      clipBottomPx: MASCOT_LAYOUT.offsetY,
    };
    const placement = mascotPlacementCss(placementInput);
    const resting = getMascotFrameGeometry(placementInput, placement);
    const bobbed = getMascotFrameGeometry(placementInput, placement, {
      x: 0,
      y: 6,
      rotationDeg: 1.5,
      scale: 1.01,
      entranceX: 0,
      entranceY: 0,
    });
    assert.notEqual(resting.transformedHeadAnchor.headTopY, bobbed.transformedHeadAnchor.headTopY);
    assert.notEqual(resting.transformedHeadAnchor.faceCenterX, bobbed.transformedHeadAnchor.faceCenterX);
  });

  test("extracts concise copy across diverse real-world narrative beats", () => {
    assert.equal(
      calloutTextFor("Trimora is an AI-powered pipeline that transforms long-form videos into viral-ready 9:16 short clips"),
      "Turns long videos into short clips!"
    );
    assert.equal(
      calloutTextFor("The composer reasons over knowledge that has already been extracted by Pass 1"),
      "Reasons over knowledge!"
    );
    assert.equal(
      calloutTextFor("it is built to run on your own machine"),
      "Runs on your own machine!"
    );
    assert.equal(
      calloutTextFor("you can bring it up with Docker Compose"),
      "Runs with Docker Compose!"
    );
    assert.equal(
      calloutTextFor("XrayFA is a powerful and user-friendly Android / iOS client for Xray-core"),
      "Android / iOS client!"
    );
  });

  test("schedules 4 distinct callouts across a 35s narration", () => {
    const fullStorySegments: NarrationSegment[] = [
      segment({
        id: "seg-01",
        purpose: "identify",
        calloutRole: "purpose",
        calloutText: "Android and iOS client!",
        factIds: ["p:01"],
      }),
      segment({
        id: "seg-02",
        purpose: "explain",
        calloutRole: "mechanism",
        calloutText: "Built with Kotlin Multiplatform!",
        factIds: ["m:01"],
      }),
      segment({
        id: "seg-03",
        purpose: "demo",
        calloutRole: "example",
        calloutText: "Import node links in seconds!",
        factIds: ["e:01"],
      }),
      segment({
        id: "seg-04",
        purpose: "caveat",
        calloutRole: "tradeoff",
        calloutText: "Runs on your own machine!",
        factIds: ["t:01"],
      }),
      segment({
        id: "seg-05",
        purpose: "install",
        calloutRole: "installation",
        calloutText: "Runs with Docker Compose!",
        factIds: ["i:01"],
      }),
    ];

    const fullStoryChunks: AudioChunk[] = [
      chunk({ segmentId: "seg-01", startMs: 500, endMs: 5500 }),
      chunk({ segmentId: "seg-02", startMs: 6500, endMs: 12000 }),
      chunk({ segmentId: "seg-03", startMs: 13000, endMs: 19000 }),
      chunk({ segmentId: "seg-04", startMs: 20000, endMs: 25000 }),
      chunk({ segmentId: "seg-05", startMs: 26000, endMs: 32000 }),
    ];

    const cues = buildCalloutCues(fullStorySegments, fullStoryChunks, 35_000);
    assert.ok(cues.length >= 4, `expected at least 4 cues across the video, got ${cues.length}`);
    for (let i = 1; i < cues.length; i += 1) {
      assert.ok(cues[i].startMs >= cues[i - 1].endMs + 400);
    }
  });
});
