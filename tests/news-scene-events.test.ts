import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildNewsSceneEvents, sceneStateAt } from "../src/channels/news/scene-events.js";
import { calloutProgress } from "../src/channels/news/scene.js";
import type { EpisodeScript } from "../src/channels/news/types.js";

const script: EpisodeScript = {
  storyId: "story_t",
  workingTitle: "Test story",
  language: "en",
  tone: "dry_sarcastic",
  estimatedDurationSeconds: 60,
  narration: [
    { id: "N001", text: "Hook.", factIds: ["F001"], delivery: "dry_hook", sceneMode: "opening", contentClass: "fact" },
    { id: "N002", text: "What happened with the scheme.", factIds: ["F001"], delivery: "measured_explanation", sceneMode: "narration_focus", contentClass: "fact" },
    { id: "N003", text: "So apparently it is all fine.", factIds: ["F001"], delivery: "punchline", sceneMode: "closing", contentClass: "satire" },
  ],
  callouts: [
    { id: "C001", text: "ON PAPER", factIds: ["F001"], highlightWords: ["ON PAPER"], triggerNarrationId: "N002", priority: "high", reveal: "type_on" },
  ],
  sources: [],
  editorialNotes: [],
  gateBApproval: null,
};

const timeline = [
  { id: "N001", startMs: 0, endMs: 3000 },
  { id: "N002", startMs: 3000, endMs: 12000 },
  { id: "N003", startMs: 12000, endMs: 18000 },
];

describe("news scene events — narration-driven", () => {
  test("callout binds to its trigger segment window", () => {
    const events = buildNewsSceneEvents({ script, timeline, targetMs: 18000 });
    const callout = events.find(e => e.mode === "board_callout");
    assert.ok(callout);
    assert.equal(callout.narrationIds[0], "N002");
    assert.ok(callout.startMs >= 3000);
    assert.ok(callout.endMs <= 3000 + 2600 + 400);
  });

  test("background is dim only outside callouts while narration is on", () => {
    const events = buildNewsSceneEvents({ script, timeline, targetMs: 18000 });
    const duringCallout = sceneStateAt(events, 3300);
    assert.equal(duringCallout.activeCallout?.boardText, "ON PAPER");
    assert.equal(duringCallout.backgroundFocus, "normal");
    const duringNarration = sceneStateAt(events, 8000);
    assert.equal(duringNarration.backgroundFocus, "dim_soft_blur");
    assert.equal(duringNarration.subtitle, "What happened with the scheme.");
    assert.equal(duringNarration.activeCallout, null);
  });

  test("events are time-ordered and retime with the audio", () => {
    const events = buildNewsSceneEvents({ script, timeline, targetMs: 18000 });
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].startMs >= events[i - 1].startMs);
    }
    const stretched = [{ id: "N001", startMs: 0, endMs: 6000 }, { id: "N002", startMs: 6000, endMs: 20000 }, { id: "N003", startMs: 20000, endMs: 30000 }];
    const retimed = buildNewsSceneEvents({ script, timeline: stretched, targetMs: 30000 });
    const callout = retimed.find(e => e.mode === "board_callout");
    assert.ok(callout && callout.startMs >= 6000);
  });

  test("callout progress is monotonic and bounded", () => {
    const start = 8304, end = 9804;
    assert.equal(calloutProgress(start, end, 0), 0);
    assert.equal(calloutProgress(start, end, start), 0);
    let prev = 0;
    for (let ms = start; ms <= end + 4000; ms += 50) {
      const p = calloutProgress(start, end, ms);
      assert.ok(p >= 0 && p <= 1, `progress ${p} out of range at ${ms}ms`);
      assert.ok(p >= prev - 1e-9, "progress must be monotonic");
      prev = p;
    }
    assert.equal(calloutProgress(start, end, start + 10_000), 1);
  });

  test("closing event lands on the last segment", () => {
    const events = buildNewsSceneEvents({ script, timeline, targetMs: 18000 });
    const closing = events.find(e => e.mode === "closing");
    assert.ok(closing);
    assert.equal(closing.endMs, 18000);
  });
});
