import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IMPACT_VARIANTS,
  buildImpactBurstCues,
  evaluateImpactBurstsAt,
} from "../src/impact-accents.js";
import { IMPACT_ACCENTS, VIEWPORT } from "../src/config.js";
import type { AudioChunk, CalloutCue, ImpactAnchor, NarrationSegment } from "../src/types.js";

function sampleSegment(id: string, purpose: NarrationSegment["purpose"] = "identify"): NarrationSegment {
  return {
    id,
    purpose,
    spokenText: "Explaining the project feature.",
    captionText: "Explaining the project feature.",
    factIds: ["fact:" + id],
  };
}

function sampleChunk(segmentId: string, startMs: number, endMs: number): AudioChunk {
  return {
    index: 0,
    segmentId,
    file: "/tmp/sample.wav",
    text: "spoken",
    durationMs: endMs - startMs,
    sampleRate: 24000,
    channels: 1,
    startMs,
    endMs,
  };
}

function sampleCallout(segmentId: string, startMs: number, endMs: number): CalloutCue {
  return {
    id: "callout:" + segmentId,
    segmentId,
    role: "purpose",
    text: "Turn long videos into short clips!",
    startMs,
    endMs,
    factIds: ["fact:" + segmentId],
    anchor: "mascot-head",
  };
}

const mockAnchors: Record<ImpactAnchor, { x: number; y: number }> = {
  "hair-left": { x: 420, y: 1100 },
  "hair-right": { x: 800, y: 1080 },
  "shoulder-left": { x: 300, y: 1450 },
  "shoulder-right": { x: 920, y: 1420 },
  "laptop-edge": { x: 620, y: 1650 },
};

describe("impact accents scheduler", () => {
  const segments = [
    sampleSegment("seg-01", "identify"),
    sampleSegment("seg-02", "explain"),
    sampleSegment("seg-03", "demo"),
    sampleSegment("seg-04", "benefit"),
  ];
  const chunks = [
    sampleChunk("seg-01", 1000, 3500),
    sampleChunk("seg-02", 4000, 7500),
    sampleChunk("seg-03", 8000, 11500),
    sampleChunk("seg-04", 12000, 16000),
  ];
  const callouts = [
    sampleCallout("seg-01", 1000, 3200),
    sampleCallout("seg-02", 4500, 7000),
    sampleCallout("seg-04", 12500, 15000),
  ];
  const durationMs = 20_000;

  test("the same seed yields identical, byte-equivalent cue plans", () => {
    const planA = buildImpactBurstCues(segments, chunks, callouts, durationMs, { seed: "run-abc-123" });
    const planB = buildImpactBurstCues(segments, chunks, callouts, durationMs, { seed: "run-abc-123" });
    assert.deepEqual(planA, planB);
    assert.ok(planA.length >= 2, "schedules at least 2 bursts for a 20s clip");
  });

  test("different seeds vary anchor and rotation but respect constraints", () => {
    const plan1 = buildImpactBurstCues(segments, chunks, callouts, durationMs, { seed: "seed-1" });
    const plan2 = buildImpactBurstCues(segments, chunks, callouts, durationMs, { seed: "seed-2" });
    assert.notDeepEqual(plan1, plan2);
    for (const plan of [plan1, plan2]) {
      for (const burst of plan) {
        assert.ok(IMPACT_ACCENTS.allowedAnchors.includes(burst.anchor));
        assert.ok(Math.abs(burst.rotationDeg) <= 25);
        assert.ok(burst.scale >= 0.8 && burst.scale <= 1.25);
        assert.ok(burst.opacity <= 1.0);
      }
    }
  });

  test("timing is nonuniform but stays bounded within video duration", () => {
    const bursts = buildImpactBurstCues(segments, chunks, callouts, durationMs, { seed: "timing-test" });
    assert.ok(bursts.length > 0);
    for (let i = 0; i < bursts.length; i += 1) {
      const b = bursts[i];
      assert.ok(b.startMs >= 400, "burst never appears before mascot has settled");
      assert.ok(b.endMs <= durationMs, `burst end ${b.endMs} exceeds duration ${durationMs}`);
      assert.ok(b.endMs - b.startMs === IMPACT_ACCENTS.burstDurationMs);
      if (i > 0) {
        assert.ok(
          b.startMs >= bursts[i - 1].endMs + IMPACT_ACCENTS.minIntervalMs - 10,
          `cooldown between burst ${i - 1} and ${i} respected`
        );
      }
    }
  });

  test("maximum burst count is strictly enforced", () => {
    const manySegments = Array.from({ length: 20 }, (_, i) =>
      sampleSegment(`seg-${i}`, "explain")
    );
    const manyChunks = Array.from({ length: 20 }, (_, i) =>
      sampleChunk(`seg-${i}`, i * 2000, i * 2000 + 1800)
    );
    const bursts = buildImpactBurstCues(manySegments, manyChunks, [], 60_000, {
      maxBurstCount: 4,
      seed: "max-test",
    });
    assert.equal(bursts.length, 4);
  });
});

describe("impact bursts per-frame evaluation", () => {
  const burst = {
    id: "impact:01",
    startMs: 2000,
    endMs: 2400,
    anchor: "hair-left" as const,
    variant: "three-rays" as const,
    rotationDeg: -12,
    scale: 1.05,
    opacity: 0.88,
    layer: "behind-mascot" as const,
    seed: 42,
  };

  test("hidden before start and after end", () => {
    const before = evaluateImpactBurstsAt([burst], 1999, mockAnchors);
    assert.equal(before.length, 0);

    const after = evaluateImpactBurstsAt([burst], 2400, mockAnchors);
    assert.equal(after.length, 0);
  });

  test("evaluates active burst with progressive stroke reveal", () => {
    const mid = evaluateImpactBurstsAt([burst], 2150, mockAnchors)[0];
    assert.ok(mid);
    assert.equal(mid.id, "impact:01");
    assert.equal(mid.x, mockAnchors["hair-left"].x);
    assert.equal(mid.y, mockAnchors["hair-left"].y);
    assert.equal(mid.strokes.length, IMPACT_VARIANTS["three-rays"].length);
    assert.ok(mid.opacity > 0 && mid.opacity <= 0.88);
    // Stroke dash offset shrinks as the path reveals
    for (const stroke of mid.strokes) {
      assert.ok(stroke.strokeDashoffset >= 0 && stroke.strokeDashoffset <= stroke.strokeDasharray);
    }
  });

  test("evaluation is pure and frame-order-independent", () => {
    const t = 2200;
    const first = evaluateImpactBurstsAt([burst], t, mockAnchors);
    const second = evaluateImpactBurstsAt([burst], t, mockAnchors);
    assert.deepEqual(first, second);
  });

  test("paths stay outside the protected face and canvas bounds", () => {
    for (let t = burst.startMs; t < burst.endMs; t += 50) {
      const active = evaluateImpactBurstsAt([burst], t, mockAnchors);
      for (const item of active) {
        assert.ok(item.x >= 0 && item.x <= VIEWPORT.width);
        assert.ok(item.y >= 0 && item.y <= VIEWPORT.height);
      }
    }
  });
});
