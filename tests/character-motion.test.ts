import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildSpeechEnvelope,
  characterCueAt,
  characterPoseAt,
  characterPoseForSlot,
  normaliseEnvelope,
  smoothEnvelope,
  speechLevelAt,
} from "../src/character-motion.js";
import type { CharacterCue } from "../src/types.js";

describe("character pose", () => {
  test("the pose is deterministic for the same time and speech level", () => {
    assert.deepEqual(characterPoseAt(1234, 0.7), characterPoseAt(1234, 0.7));
  });

  test("every action stays inside its own gentle envelope", () => {
    for (const action of ["present", "point", "close"] as const) {
      for (let time = 0; time < 60_000; time += 137) {
        for (const level of [0, 0.5, 1]) {
          const pose = characterPoseAt(time, level, action);
          assert.ok(Math.abs(pose.x) <= 12, `${action} x ${pose.x}`);
          assert.ok(Math.abs(pose.y) <= 10, `${action} y ${pose.y}`);
          assert.ok(
            Math.abs(pose.rotationDeg) <= 3,
            `${action} rotation ${pose.rotationDeg}`
          );
          assert.ok(
            pose.scale >= 1 && pose.scale <= 1.04,
            `${action} scale ${pose.scale}`
          );
          assert.equal(pose.opacity, 1);
        }
      }
    }
  });

  test("the pointing action actually leans toward the page", () => {
    const at = 1000;
    const present = characterPoseAt(at, 0.4, "present");
    const point = characterPoseAt(at, 0.4, "point");
    assert.ok(point.x < present.x - 3, `point ${point.x} vs present ${present.x}`);
    assert.ok(point.rotationDeg < present.rotationDeg);
  });

  test("narration slots choose a presenter action and carry it on the timeline", () => {
    assert.equal(characterPoseForSlot("cta"), "close");
    assert.equal(characterPoseForSlot("demo"), "point");
    assert.equal(characterPoseForSlot("setup"), "point");
    assert.equal(characterPoseForSlot("hook"), "present");
    assert.equal(characterPoseForSlot(undefined), "present");

    const cues: CharacterCue[] = [
      { startMs: 0, endMs: 1000, pose: "present" },
      { startMs: 1200, endMs: 2000, pose: "point" },
      { startMs: 2000, endMs: 3000, pose: "close" },
    ];
    assert.equal(characterCueAt(cues, 0), "present");
    assert.equal(characterCueAt(cues, 1100), "present");
    assert.equal(characterCueAt(cues, 1500), "point");
    assert.equal(characterCueAt(cues, 2500), "close");
    assert.equal(characterCueAt(cues, 6000), "close");
    assert.equal(characterCueAt([], 500), "present");
  });

  test("speaking produces a larger bob than silence", () => {
    const at = 250;
    const quiet = Math.abs(characterPoseAt(at, 0).y);
    const speaking = Math.abs(characterPoseAt(at, 1).y);
    assert.ok(speaking > quiet);
  });

  test("silence still has a subtle idle motion", () => {
    const values = new Set(
      [0, 400, 800, 1200, 1600].map(time => characterPoseAt(time, 0).y)
    );
    assert.ok(values.size > 1, "the character must not be frozen in silence");
  });
});

describe("speech envelope", () => {
  test("smoothing is bounded and lags a step input", () => {
    const raw = [0, 0, 1, 1, 1, 1, 1, 1];
    const smooth = smoothEnvelope(raw, 0.3);
    assert.equal(smooth.length, raw.length);
    assert.ok(smooth[2] < 1, "the first sample must not jump to full amplitude");
    assert.ok(smooth[smooth.length - 1] > 0.8);
    for (const value of smooth) assert.ok(value >= 0 && value <= 1);
  });

  test("normalisation applies a gate and a 0..1 ceiling", () => {
    const levels = normaliseEnvelope([0, 0.001, 0.01, 0.1, 0.5, 1], { gate: 0.05 });
    assert.equal(levels[0], 0);
    assert.equal(levels[1], 0);
    assert.equal(levels[2], 0);
    assert.ok(levels[levels.length - 1] > 0.9);
    assert.ok(levels.every(value => value >= 0 && value <= 1));
  });

  test("interpolation samples between envelope points", () => {
    const envelope = { rateHz: 10, durationMs: 400, levels: [0, 1, 0] };
    assert.equal(speechLevelAt(envelope, 0), 0);
    assert.ok(Math.abs(speechLevelAt(envelope, 50) - 0.5) < 0.001);
    assert.equal(speechLevelAt(envelope, 100), 1);
    assert.ok(Math.abs(speechLevelAt(envelope, 150) - 0.5) < 0.001);
    assert.equal(speechLevelAt(null, 100), 0);
    assert.equal(speechLevelAt({ rateHz: 10, durationMs: 0, levels: [] }, 100), 0);
  });

  test("a measured WAV becomes a low-rate envelope", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "showcase-envelope-"));
    const wav = path.join(dir, "tone.wav");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "ffmpeg",
          [
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", "sine=frequency=220:sample_rate=24000:duration=1.2",
            "-c:a", "pcm_s16le",
            wav,
          ],
          { stdio: "ignore", windowsHide: true }
        );
        child.on("error", reject);
        child.on("close", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
      });

      const envelope = await buildSpeechEnvelope(wav, 25);
      assert.equal(envelope.rateHz, 25);
      assert.ok(envelope.durationMs >= 1100 && envelope.durationMs <= 1300);
      assert.ok(envelope.levels.length >= 25);
      assert.ok(Math.max(...envelope.levels) > 0.5, "a non-silent tone must register");
      assert.ok(envelope.levels.every(value => value >= 0 && value <= 1));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
