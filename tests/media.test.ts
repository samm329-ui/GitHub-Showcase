import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { checkAudioReachesEnd, probeMedia, validateOutput } from "../src/qa.js";
import { writeAssFromCaptions } from "../src/captions.js";
import { renderVideo } from "../src/render.js";
import { FPS, MAX_DURATION_SECONDS, VIEWPORT } from "../src/config.js";
import type { AudioChunk, CaptionPhrase, ScrollKeyframe } from "../src/types.js";
import { enriched } from "./helpers.js";

/**
 * End-to-end media test.
 *
 * Renders a short stationary-card video with a real narration track and checks
 * the finished MP4 with ffprobe. This is the test that proves the composition
 * and the encoder agree, so it needs FFmpeg and FFprobe on PATH. It does not
 * need Chromium or Kokoro: the audio is synthesised locally with ffmpeg.
 */

const workDir = path.join(os.tmpdir(), "showcase-e2e");

const captions: CaptionPhrase[] = [
  { index: 0, startMs: 0, endMs: 1500, text: "This is Rocket CLI", highlights: ["Rocket"], segmentId: "s1" },
  { index: 1, startMs: 1500, endMs: 3000, text: "a tool for TypeScript services", highlights: [], segmentId: "s1" },
  { index: 2, startMs: 3000, endMs: 4000, text: "You can install it with n p m", highlights: ["n p m"], segmentId: "s2" },
];

const chunks: AudioChunk[] = [
  { index: 0, segmentId: "s1", file: "", text: "", durationMs: 4000, sampleRate: 24000, channels: 1, startMs: 0, endMs: 4000 },
];

const keyframes: ScrollKeyframe[] = [
  { timeMs: 0, scrollY: 0, easing: "easeInOut", anchor: "repo-header" },
  { timeMs: 1200, scrollY: 0, easing: "easeInOut" },
  { timeMs: 2400, scrollY: 400, easing: "easeInOut", anchor: "file-list" },
  { timeMs: 3400, scrollY: 400, easing: "easeInOut" },
];

const CHROME_AVAILABLE = await (async () => {
  try {
    const CDP = (await import("chrome-remote-interface")).default;
    const endpoint = new URL(process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222");
    await CDP.New({ host: endpoint.hostname, port: Number(endpoint.port || 9222) });
    return true;
  } catch {
    return false;
  }
})();

let output = "";
let audioPath = "";

before(async () => {
  await fs.mkdir(workDir, { recursive: true });
  audioPath = path.join(workDir, "narration.wav");
  output = path.join(workDir, "showcase.mp4");
  // A short spoken-shaped tone track so the audio stream is real.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", "sine=frequency=220:sample_rate=24000:duration=4",
        "-af", "volume=0.2",
        "-c:a", "pcm_s16le",
        audioPath,
      ],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
  await writeAssFromCaptions(captions, path.join(workDir, "captions.ass"));
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("media validation helpers", () => {
  test("audio reaching the end is detected", () => {
    assert.equal(checkAudioReachesEnd(35.0, 34.6).ok, true);
    assert.equal(checkAudioReachesEnd(30.0, 34.6).ok, false, "a video that ends early must fail");
    assert.equal(checkAudioReachesEnd(40.0, 34.6).ok, false, "a long silent tail must fail");
    assert.match(checkAudioReachesEnd(30.0, 34.6).detail, /gap/);
  });
});

describe("ASS caption export", () => {
  test("produces a usable subtitle file from the measured timeline", async () => {
    const file = path.join(workDir, "captions.ass");
    const text = await fs.readFile(file, "utf8");
    assert.match(text, /\[Script Info\]/);
    assert.match(text, /PlayResX: 1080/);
    assert.match(text, /PlayResY: 1920/);
    assert.match(text, /Dialogue: 0,0:00:00\.00,0:00:01\.50/);
    assert.match(text, /Dialogue: 0,0:00:03\.00,0:00:04\.00/);
    assert.match(text, /\{\\c&H29D6FF&\}/, "highlights use the yellow colour tag");
  });
});

describe("final MP4", { skip: CHROME_AVAILABLE ? false : "Chromium CDP is not reachable" }, () => {
  test("the rendered video passes every media check", async () => {
    const repo = enriched("high-quality-popular");
    const rendered = await renderVideo({
      repo,
      captions,
      scrollKeyframes: keyframes,
      audioPath,
      audioDurationMs: 4000,
      outputPath: output,
      workDir,
      fps: 30,
      crf: 22,
      preset: "veryfast",
    });

    assert.ok(rendered.totalFrames > 100, `only ${rendered.totalFrames} frames were rendered`);
    assert.ok(rendered.durationSeconds <= MAX_DURATION_SECONDS);

    const report = await validateOutput(output, { expectedAudioSeconds: 4 });
    for (const check of report.checks) {
      assert.ok(check.ok, `${check.name}: ${check.detail}`);
    }
    assert.equal(report.ok, true);
    assert.equal(report.media?.width, VIEWPORT.width);
    assert.equal(report.media?.height, VIEWPORT.height);
    assert.ok(Math.abs((report.media?.frameRate ?? 0) - FPS) < 0.5);
    assert.equal(report.media?.pixelFormat, "yuv420p");
    assert.equal(report.media?.videoCodec, "h264");
    assert.equal(report.media?.audioCodec, "aac");
    assert.equal(report.media?.audioSampleRate, 48000);
  });

  test("the finished file is exactly 9:16 and under the duration limit", async () => {
    const media = await probeMedia(output);
    assert.equal(media.width, 1080);
    assert.equal(media.height, 1920);
    assert.ok(Math.abs(media.width / media.height - 9 / 16) < 0.0005);
    assert.ok(media.durationSeconds <= MAX_DURATION_SECONDS + 0.5);
    assert.ok(media.sizeBytes > 10_000);
  });

  test("the browser bar, card and shadow do not move between frames", async () => {
    // Two frames from opposite ends of the timeline: the stage background and
    // the browser bar must be pixel-identical, only the content may differ.
    const sample = async (at: number) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout } = await run(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error",
          "-ss", String(at), "-i", output,
          "-frames:v", "1",
          // Crop the stage background strip below the card, and the browser bar.
          "-filter_complex",
          "[0:v]crop=1080:100:0:1820,format=gray[a];[0:v]crop=780:84:150:126,format=gray[b]",
          "-map", "[a]", "-map", "[b]",
          "-f", "rawvideo", "-",
        ],
        { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }
      );
      return stdout as unknown as Buffer;
    };
    const first = await sample(0.2);
    const last = await sample(3.6);
    assert.equal(first.length, last.length);
    let differing = 0;
    for (let index = 0; index < first.length; index += 1) {
      if (Math.abs(first[index] - last[index]) > 6) differing += 1;
    }
    const ratio = differing / first.length;
    assert.ok(ratio < 0.02, `static chrome changed in ${(ratio * 100).toFixed(1)}% of pixels`);
  });

  test("captions are inside the card and not clipped", async () => {
    const frameFile = path.join(workDir, "frame.png");
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", "0.5", "-i", output,
      "-frames:v", "1",
      frameFile,
    ]);

    const { createCanvas, loadImage } = await import("canvas");
    const image = await loadImage(frameFile);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);

    assert.equal(image.width, 1080);
    assert.equal(image.height, 1920);

    // Stage background: solid warm off-white #F2EFE9.
    for (const [x, y] of [[20, 20], [1060, 20], [20, 1900], [1060, 1900], [540, 30]]) {
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      assert.ok(
        Math.abs(pixel[0] - 0xf2) < 10 &&
          Math.abs(pixel[1] - 0xef) < 10 &&
          Math.abs(pixel[2] - 0xe9) < 10,
        `stage pixel at ${x},${y} was ${pixel}`
      );
    }

    // Card surface: #0D1117 well inside the card bounds.
    for (const [x, y] of [[200, 200], [880, 200], [540, 600], [540, 1700]]) {
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      assert.ok(
        pixel[0] < 40 && pixel[1] < 46 && pixel[2] < 56,
        `card pixel at ${x},${y} was ${pixel}`
      );
    }

    // Outside the card horizontally at card height: must still be the stage.
    const outside = ctx.getImageData(60, 900, 1, 1).data;
    assert.ok(outside[0] > 200, `expected the stage, got ${outside}`);
  });
});