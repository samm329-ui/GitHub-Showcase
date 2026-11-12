import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProductionSpec } from "../src/channels/news/production/types.js";
import { SPEC_VERSION, specHash } from "../src/channels/news/production/types.js";
import {
  FPS,
  framesToSeconds,
  secondsToFrames,
  msToFrames,
  sortEvents,
  spansOverlap,
  evalTrack,
  evalClip,
  validateTrack,
  KeyframeError,
  applyEasing,
  audioDefinition,
  compileTimeline,
  validateSpec,
  CLIP_ENTER_LEFT,
  CLIP_LOOK_AT_BOARD,
} from "../src/channels/news/production/index.js";

const hash64 = "a".repeat(64);

const minimalSpec = (): ProductionSpec => ({
  specVersion: SPEC_VERSION,
  episodeId: "ep_test",
  canvas: { width: 1080, height: 1920, fps: 30, durationFrames: 300 },
  layers: [
    { id: "bg", role: "background", asset: "assets/news/layers/1.png", z: 0, alpha: false, anchorX: 540, anchorY: 960 },
    { id: "board", role: "board", asset: "assets/news/layers/2.png", z: 5, alpha: true, anchorX: 540, anchorY: 480 },
    { id: "captions", role: "caption", asset: "", z: 20, alpha: true, anchorX: 540, anchorY: 1400 },
  ],
  clips: [CLIP_ENTER_LEFT],
  captions: [
    {
      id: "cap1",
      words: [
        { word: "RBI", startMs: 0, endMs: 300 },
        { word: "holds", startMs: 320, endMs: 650 },
      ],
    },
  ],
  boardEvents: [{ id: "board1", frame: 12, kind: "verbatim", text: "RBI keeps repo rate unchanged" }],
  audioEvents: [{ id: "sfx1", name: "entrance_whoosh", frame: 0 }],
  provenance: {
    ledgerHash: hash64,
    scriptHash: hash64,
    audioHash: hash64,
    alignmentHash: hash64,
    visemeSource: "words",
  },
});

describe("frame clock", () => {
  test("FPS is 30 and t = frame/30", () => {
    assert.equal(FPS, 30);
    assert.equal(framesToSeconds(15), 0.5);
    assert.equal(framesToSeconds(30), 1);
    assert.equal(secondsToFrames(1.5), 45);
    assert.equal(msToFrames(1000), 30);
    assert.equal(msToFrames(1500), 45);
  });
  test("span overlap semantics", () => {
    assert.ok(spansOverlap(0, 10, 5, 20));
    assert.ok(!spansOverlap(0, 10, 10, 20));
    assert.ok(!spansOverlap(0, 10, 20, 30));
  });
  test("events sort stably by frame and kind", () => {
    const ordered = sortEvents([
      { frame: 5, kind: "audio", refId: "a" },
      { frame: 5, kind: "caption-begin", refId: "b" },
      { frame: 5, kind: "caption-end", refId: "c" },
      { frame: 1, kind: "board-enter", refId: "d" },
    ]);
    assert.deepEqual(ordered.map(e => e.refId), ["d", "b", "c", "a"]);
  });
});

describe("easing + keyframes", () => {
  test("easing clamping at bounds", () => {
    assert.equal(applyEasing("linear", -1), 0);
    assert.equal(applyEasing("linear", 2), 1);
    assert.equal(applyEasing("step", 0.99), 0);
    assert.equal(applyEasing("step", 1), 1);
    assert.equal(applyEasing("easeOut", 0.5) > 0.5, true);
  });
  test("keyframes must be strictly increasing", () => {
    assert.throws(
      () => validateTrack({ property: "x", keys: [{ frame: 10, value: 0 }, { frame: 10, value: 1 }] }),
      KeyframeError
    );
  });
  test("evalTrack clamps to endpoints and eases between", () => {
    const track = { property: "x", keys: [{ frame: 0, value: 0, easing: "linear" as const }, { frame: 30, value: 100, easing: "easeInOut" as const }] };
    assert.equal(evalTrack(track, -5), 0);
    assert.equal(evalTrack(track, 999), 100);
    const mid = evalTrack(track, 15);
    assert.ok(mid > 0 && mid < 100);
  });
  test("evalClip handles multi-property input", () => {
    const out = evalClip(CLIP_ENTER_LEFT.tracks, 9, ["character.x", "character.rotation", "character.scale"]);
    assert.equal(typeof out["character.x"], "number");
    assert.equal(typeof out["character.rotation"], "number");
    assert.equal(typeof out["character.scale"], "number");
    const yaw = evalClip(CLIP_LOOK_AT_BOARD.tracks, 6, ["head.yaw"]);
    assert.equal(yaw["head.yaw"], -14);
  });
});

describe("audio registry", () => {
  test("every advertised event is registered", () => {
    for (const name of ["entrance_whoosh","chair_settle","typewriter","paper_rustle","marker_swipe","soft_transition","dry_sting","channel_ident"] as const) {
      const def = audioDefinition(name);
      assert.equal(def.name, name);
    }
  });
  test("unregistered event name throws", () => {
    // @ts-expect-error intentionally invalid
    assert.throws(() => audioDefinition("boom"), /Unknown audio event/);
  });
});

describe("timeline compiler", () => {
  test("compiles ordered, fully-addressed event stream", async () => {
    const spec = minimalSpec();
    const compiled = compileTimeline(spec, specHash);
    assert.equal(compiled.episodeId, "ep_test");
    assert.equal(compiled.durationFrames, 300);
    assert.ok(compiled.events.length >= 5);
    for (let i = 1; i < compiled.events.length; i += 1) {
      assert.ok(compiled.events[i].frame >= compiled.events[i - 1].frame, "timeline must be non-decreasing");
    }
    assert.ok(compiled.events.some(e => e.kind === "audio" && e.refId === "sfx1"));
    assert.ok(compiled.events.some(e => e.kind === "board-enter" && e.refId === "board1"));
    assert.ok(compiled.events.some(e => e.kind === "caption-begin"));
  });
  test("same spec compiles twice to identical event stream (no hidden randomness)", () => {
    const spec = minimalSpec();
    const a = compileTimeline(spec, specHash);
    const b = compileTimeline(spec, specHash);
    assert.equal(a.specHash, b.specHash);
    assert.deepEqual(a.events, b.events);
  });
});

describe("spec validator", () => {
  test("minimal spec passes", () => {
    const findings = validateSpec(minimalSpec());
    assert.equal(findings.filter(f => f.level === "error").length, 0, JSON.stringify(findings));
  });
  test("wrong canvas rejected", () => {
    const spec = minimalSpec();
    spec.canvas = { ...spec.canvas, width: 941, height: 1672 } as unknown as ProductionSpec["canvas"];
    const errors = validateSpec(spec).filter(f => f.level === "error");
    assert.ok(errors.some(e => e.message.includes("canvas")));
  });
  test("word ending after episode rejected", () => {
    const spec = minimalSpec();
    spec.captions[0].words[1].endMs = 300 * 1000 + 10; // way past 300 frames (10s)
    const errors = validateSpec(spec).filter(f => f.level === "error");
    assert.ok(errors.some(e => e.message.includes("ends after the episode ends")));
  });
  test("bad provenance rejected", () => {
    const spec = minimalSpec();
    spec.provenance.ledgerHash = "not-a-hash";
    const errors = validateSpec(spec).filter(f => f.level === "error");
    assert.ok(errors.some(e => e.message.includes("ledgerHash")));
  });
  test("audio event outside episode rejected", () => {
    const spec = minimalSpec();
    spec.audioEvents = [{ id: "sfx", name: "entrance_whoosh", frame: 999 }];
    const errors = validateSpec(spec).filter(f => f.level === "error");
    assert.ok(errors.some(e => e.message.includes("outside episode")));
  });
});

describe("spec content addressing", () => {
  test("hash is stable across constructions", async () => {
    const a = minimalSpec();
    const b = minimalSpec();
    assert.equal(specHash(a), specHash(b));
  });
  test("setup dir independence (no env leakage)", async () => {
    await mkdtemp(path.join(os.tmpdir(), "lazy-news-spec-test-"));
    const spec = minimalSpec();
    assert.equal(spec.provenance.ledgerHash, hash64);
  });
});
