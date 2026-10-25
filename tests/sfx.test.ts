import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mixAudioTracks, scheduleSoundEvents } from "../src/sfx.js";
import { soundEventsChecks } from "../src/qa.js";
import { SFX_CONFIG, type SfxConfig } from "../src/config.js";
import type { CalloutCue, SoundEvent } from "../src/types.js";

const execFileAsync = promisify(execFile);

function mockCallout(id: string, startMs: number, endMs: number): CalloutCue {
  return {
    id: `callout:${id}`,
    segmentId: `seg:${id}`,
    role: "purpose",
    text: "Turn long videos into short clips!",
    startMs,
    endMs,
    factIds: [`fact:${id}`],
    anchor: "mascot-head",
  };
}

describe("sfx scheduling", () => {
  test("schedules mascot entrance whoosh and callout pops at exact relative offsets", () => {
    const callouts: CalloutCue[] = [
      mockCallout("1", 900, 3500),
      mockCallout("2", 5000, 8000),
    ];
    const durationMs = 15000;
    const events = scheduleSoundEvents(callouts, durationMs, SFX_CONFIG);

    assert.equal(events.length, 3);

    // Mascot whoosh at 0ms (0 + startOffsetMs=0)
    assert.equal(events[0].kind, "mascot-entrance");
    assert.equal(events[0].startMs, 0);
    assert.equal(events[0].gain, 0.18);
    assert.match(events[0].asset, /mascot-slide-whoosh\.wav$/);

    // First callout pop at 920ms (900 + startOffsetMs=20)
    assert.equal(events[1].kind, "callout-pop");
    assert.equal(events[1].startMs, 920);
    assert.equal(events[1].gain, 0.14);
    assert.equal(events[1].cueId, "callout:1");
    assert.match(events[1].asset, /callout-pop\.wav$/);

    // Second callout pop at 5020ms (5000 + startOffsetMs=20)
    assert.equal(events[2].kind, "callout-pop");
    assert.equal(events[2].startMs, 5020);
    assert.equal(events[2].gain, 0.14);
    assert.equal(events[2].cueId, "callout:2");
  });

  test("respects independent toggle switches for mascot entrance and callout pop", () => {
    const callouts = [mockCallout("1", 1000, 4000)];
    const durationMs = 10000;

    // Disabled mascot entrance
    const noMascotConfig: SfxConfig = {
      mascotEntrance: { ...SFX_CONFIG.mascotEntrance, enabled: false },
      calloutPop: { ...SFX_CONFIG.calloutPop, enabled: true },
    };
    const eventsNoMascot = scheduleSoundEvents(callouts, durationMs, noMascotConfig);
    assert.equal(eventsNoMascot.length, 1);
    assert.equal(eventsNoMascot[0].kind, "callout-pop");

    // Disabled callout pop
    const noPopConfig: SfxConfig = {
      mascotEntrance: { ...SFX_CONFIG.mascotEntrance, enabled: true },
      calloutPop: { ...SFX_CONFIG.calloutPop, enabled: false },
    };
    const eventsNoPop = scheduleSoundEvents(callouts, durationMs, noPopConfig);
    assert.equal(eventsNoPop.length, 1);
    assert.equal(eventsNoPop[0].kind, "mascot-entrance");

    // Both disabled
    const bothDisabled: SfxConfig = {
      mascotEntrance: { ...SFX_CONFIG.mascotEntrance, enabled: false },
      calloutPop: { ...SFX_CONFIG.calloutPop, enabled: false },
    };
    const eventsNone = scheduleSoundEvents(callouts, durationMs, bothDisabled);
    assert.equal(eventsNone.length, 0);
  });

  test("omits events exceeding the video duration", () => {
    const callouts = [
      mockCallout("1", 2000, 5000),
      mockCallout("2", 12000, 14000),
    ];
    // Video is only 10 seconds long
    const durationMs = 10000;
    const events = scheduleSoundEvents(callouts, durationMs, SFX_CONFIG);

    assert.equal(events.length, 2); // mascot whoosh + callout 1
    assert.ok(events.every(e => e.startMs < durationMs));
  });

  test("maintains monotonic chronological ordering", () => {
    const callouts = [
      mockCallout("2", 4000, 6000),
      mockCallout("1", 1000, 3000),
      mockCallout("3", 8000, 10000),
    ];
    const events = scheduleSoundEvents(callouts, 12000, SFX_CONFIG);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].startMs >= events[i - 1].startMs);
    }
  });
});

describe("sfx audio mixing", () => {
  test("mixes narration tone with scheduled SFX preserving duration", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-test-"));
    const narrationWav = path.join(tmpDir, "narration.wav");
    const mixedWav = path.join(tmpDir, "mixed.wav");

    try {
      // Generate a 2-second reference audio tone (48kHz stereo 16-bit PCM)
      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=2",
        "-ar", "48000",
        "-ac", "2",
        narrationWav,
      ]);

      const soundEvents: SoundEvent[] = [
        {
          asset: SFX_CONFIG.mascotEntrance.asset,
          startMs: 0,
          gain: SFX_CONFIG.mascotEntrance.gain,
          kind: "mascot-entrance",
        },
        {
          asset: SFX_CONFIG.calloutPop.asset,
          startMs: 500,
          gain: SFX_CONFIG.calloutPop.gain,
          kind: "callout-pop",
        },
      ];

      const resultPath = await mixAudioTracks({
        narrationPath: narrationWav,
        soundEvents,
        durationMs: 2000,
        outputPath: mixedWav,
      });

      assert.equal(resultPath, mixedWav);
      const stat = await fs.stat(mixedWav);
      assert.ok(stat.size > 10000);

      // Verify duration and audio format
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration:stream=sample_rate,channels",
        "-of", "json",
        mixedWav,
      ]);
      const probe = JSON.parse(stdout);
      const duration = Number(probe.format?.duration);
      assert.ok(Math.abs(duration - 2.0) < 0.05, `Expected 2.0s, got ${duration}s`);
      assert.equal(probe.streams?.[0]?.sample_rate, "48000");
      assert.equal(probe.streams?.[0]?.channels, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("transparently passes narration through if no sound events are scheduled", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-test-"));
    const narrationWav = path.join(tmpDir, "narration.wav");
    const mixedWav = path.join(tmpDir, "mixed.wav");

    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=1",
        "-ar", "48000",
        "-ac", "2",
        narrationWav,
      ]);

      const resultPath = await mixAudioTracks({
        narrationPath: narrationWav,
        soundEvents: [],
        durationMs: 1000,
        outputPath: mixedWav,
      });

      assert.equal(resultPath, mixedWav);
      const originalStat = await fs.stat(narrationWav);
      const mixedStat = await fs.stat(mixedWav);
      assert.equal(originalStat.size, mixedStat.size);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("sfx QA checks", () => {
  test("passes valid scheduled sound events", () => {
    const events: SoundEvent[] = [
      {
        asset: SFX_CONFIG.mascotEntrance.asset,
        startMs: 0,
        gain: 0.18,
        kind: "mascot-entrance",
      },
      {
        asset: SFX_CONFIG.calloutPop.asset,
        startMs: 1500,
        gain: 0.14,
        kind: "callout-pop",
      },
    ];

    const checks = soundEventsChecks(events, 5000);
    assert.ok(checks.length >= 3);
    assert.ok(checks.every(c => c.ok), checks.map(c => `${c.name}: ${c.detail}`).join(", "));
  });

  test("flags out-of-bounds timestamps and excessive gains", () => {
    const invalidEvents: SoundEvent[] = [
      {
        asset: SFX_CONFIG.mascotEntrance.asset,
        startMs: -50,
        gain: 0.85, // too loud!
        kind: "mascot-entrance",
      },
      {
        asset: "assets/sfx/non-existent-sound.wav",
        startMs: 6000, // exceeds 5000ms duration
        gain: 0.14,
        kind: "callout-pop",
      },
    ];

    const checks = soundEventsChecks(invalidEvents, 5000);
    const timingCheck = checks.find(c => c.name === "sfx-timing");
    const gainCheck = checks.find(c => c.name === "sfx-gain");
    const assetCheck = checks.find(c => c.name === "sfx-assets-exist");

    assert.equal(timingCheck?.ok, false);
    assert.equal(gainCheck?.ok, false);
    assert.equal(assetCheck?.ok, false);
  });
});
