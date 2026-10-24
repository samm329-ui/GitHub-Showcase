import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  interpolateScroll,
  minimumTransitionMs,
  planScrollBeats,
  targetScrollPosition,
  quinticProgress,
} from "../src/scroll-choreography.js";
import type { MeasuredAnchor } from "../src/types.js";

describe("scroll choreography", () => {
  test("the easing curve is monotonic and lands squarely on the target", () => {
    assert.equal(quinticProgress(0), 0);
    assert.equal(quinticProgress(1), 1);
    let previous = 0;
    for (let step = 0; step <= 20; step += 1) {
      const value = quinticProgress(step / 20);
      assert.ok(value >= previous - 1e-12, `quinticProgress must stay monotonic at ${step}`);
      previous = value;
    }
  });

  test("target scroll position honours document bounds", () => {
    const anchor: MeasuredAnchor = { anchor: "features", offsetTop: 1400, offsetHeight: 240 };
    assert.equal(targetScrollPosition(anchor, 720, 2000), 1220);
    assert.equal(targetScrollPosition(anchor, 720, 1000), 280);
  });

  test("interpolated scroll never overshoots or undershoots", () => {
    const values = [];
    for (let step = 0; step <= 20; step += 1) {
      values.push(interpolateScroll(0, 500, step / 20));
    }
    for (const value of values) {
      assert.ok(value >= 0 && value <= 500, `interpolated value out of bounds: ${value}`);
    }
  });

  test("transition duration respects the speed bound", () => {
    assert.equal(minimumTransitionMs(0), 0);
    assert.ok(minimumTransitionMs(900) >= 1405);
  });

  test("scroll beats only target anchors that exist", () => {
    const anchors: MeasuredAnchor[] = [
      { anchor: "features", offsetTop: 400, offsetHeight: 500 },
      { anchor: "install-command", offsetTop: 1800, offsetHeight: 260 },
    ];
    const beats = planScrollBeats({
      anchors,
      documentHeight: 2200,
      viewportHeight: 720,
      targetTimes: [
        { anchor: "features", startMs: 200, endMs: 2000 },
        { anchor: "install-command", startMs: 2200, endMs: 3500 },
      ],
    });
    assert.equal(beats.length, 2);
    assert.ok(beats[0].startMs <= beats[1].startMs);
    for (const beat of beats) {
      assert.ok(beat.holdMs > 0);
      assert.ok(beat.startMs < beat.endMs);
    }
  });
});

function expect(actual: number) {
  return {
    toBeGreaterThanOrEqual: (expected: number) =>
      assert.ok(actual >= expected, `${actual} should be >= ${expected}`),
  };
}
