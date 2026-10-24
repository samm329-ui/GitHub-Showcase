import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { pauseSchedule, toTimedChunks, type SynthesizedChunk } from "../src/voice.js";
import type { NarrationSegment } from "../src/types.js";

/**
 * The pause schedule is shared: `concatChunks` writes it into the audio and
 * `toTimedChunks` lays the timeline over the same gaps, so what a viewer
 * hears and what the captions do can never drift apart.
 */

function segments(pauses: (number | undefined)[]): NarrationSegment[] {
  return pauses.map((pause, index) => ({
    id: `seg-${String(index + 1).padStart(2, "0")}`,
    purpose: "explain" as const,
    spokenText: `Sentence number ${index + 1} for the schedule.`,
    captionText: `Sentence number ${index + 1} for the schedule.`,
    factIds: [`fact-${index}`],
    ...(pause === undefined ? {} : { pauseAfterMs: pause }),
  }));
}

function chunks(count: number, durationMs = 1000): SynthesizedChunk[] {
  return Array.from({ length: count }, (_unused, index) => ({
    index,
    segmentId: `seg-${String(index + 1).padStart(2, "0")}`,
    file: `/tmp/chunk-${index}.wav`,
    text: `chunk ${index}`,
    durationMs,
    sampleRate: 24000,
    channels: 1,
    startMs: 0,
    endMs: durationMs,
    hasPhonemeTimings: false,
  }));
}

describe("shared pause schedule", () => {
  test("per-segment pauses override the fallback; absence uses it", () => {
    const schedule = pauseSchedule(4, segments([undefined, 240, undefined]), 120);
    assert.deepEqual(schedule, [0, 120, 240, 120]);
  });

  test("no pause is scheduled before the first chunk", () => {
    const schedule = pauseSchedule(3, segments([300, 300]), 120);
    assert.equal(schedule[0], 0);
  });

  test("without segments the fallback applies between every pair", () => {
    const schedule = pauseSchedule(3, undefined, 150);
    assert.deepEqual(schedule, [0, 150, 150]);
  });

  test("the timeline consumes exactly the shared schedule", () => {
    const parts = segments([undefined, 240, 90]);
    const schedule = pauseSchedule(3, parts, 120);
    const timed = toTimedChunks(chunks(3), parts, 120);
    assert.equal(timed[0].startMs, 0);
    for (let index = 1; index < timed.length; index += 1) {
      assert.equal(
        timed[index].startMs - timed[index - 1].endMs,
        schedule[index],
        `gap ${index} matches the schedule`
      );
    }
    assert.equal(timed[1].startMs, 1000 + 120);
    assert.equal(timed[2].startMs, 2000 + 120 + 240);
  });

  test("the timeline ends at the last chunk with no trailing pause", () => {
    const parts = segments([200, 200, 200]);
    const timed = toTimedChunks(chunks(3), parts, 120);
    const last = timed[timed.length - 1];
    assert.equal(last.endMs, 3000 + 200 + 200, "the final pause is not appended");
  });

  test("intervals stay monotonic for any pause mix", () => {
    const parts = segments([undefined, 350, undefined, 60]);
    const timed = toTimedChunks(chunks(4, 800), parts, 120);
    for (let index = 1; index < timed.length; index += 1) {
      assert.ok(timed[index].startMs >= timed[index - 1].endMs);
      assert.ok(timed[index].endMs > timed[index].startMs);
    }
  });
});
