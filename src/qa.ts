import type { MediaInfo, QaCheck, QaReport } from "./types.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { stat as statFile } from "node:fs/promises";
import { createCanvas, loadImage } from "canvas";
import { promisify } from "node:util";
import { CARD, CARD_CHROME_HEIGHT, FPS, MAX_DURATION_SECONDS, VIEWPORT } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Final media validation.
 *
 * A repository is only marked completed after this passes. Every check is
 * measured from the finished MP4 with ffprobe; nothing is assumed from the
 * render configuration.
 */

function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/").map(Number);
  if (!num) return 0;
  return den ? num / den : num;
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels",
    "-show_entries", "format=duration,size,bit_rate",
    "-of", "json",
    file,
  ]);
  const info = JSON.parse(stdout) as {
    streams?: {
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      r_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }[];
    format?: { duration?: string; size?: string; bit_rate?: string };
  };
  const video = info.streams?.find(stream => stream.codec_type === "video");
  const audio = info.streams?.find(stream => stream.codec_type === "audio");
  if (!video) throw new Error("The rendered file contains no video stream.");
  const fileStat = await statFile(file);
  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    durationSeconds: Number(info.format?.duration ?? 0),
    videoCodec: video.codec_name ?? "",
    pixelFormat: video.pix_fmt ?? "",
    frameRate: parseFrameRate(video.r_frame_rate),
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    audioChannels: audio?.channels ?? null,
    sizeBytes: fileStat.size,
  };
}

export type QaOptions = {
  expectedWidth?: number;
  expectedHeight?: number;
  expectedFps?: number;
  /** Audio duration that the video should reach, in seconds. */
  expectedAudioSeconds: number;
  maxDurationSeconds?: number;
  /** Saved frames sampled from the finished file, used to detect black output. */
  frameSampleCount?: number;
  /** The scroll schedule moves enough that the page must visibly change. */
  expectMotion?: boolean;
  /** Planned scroll positions at 25/50/75% of the clip, for diagnostics. */
  motionStops?: number[];
};

export async function validateOutput(
  file: string,
  options: QaOptions
): Promise<QaReport> {
  const checks: QaCheck[] = [];
  const push = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });

  let media: MediaInfo | null = null;
  try {
    media = await probeMedia(file);
  } catch (error) {
    push(
      "ffprobe-readable",
      false,
      error instanceof Error ? error.message : String(error)
    );
    return { ok: false, checks, media: null };
  }

  push("ffprobe-readable", true, `${media.videoCodec} video, ${media.durationSeconds.toFixed(2)}s`);

  const expectedWidth = options.expectedWidth ?? VIEWPORT.width;
  const expectedHeight = options.expectedHeight ?? VIEWPORT.height;
  push(
    "dimensions",
    media.width === expectedWidth && media.height === expectedHeight,
    `${media.width}x${media.height} (expected ${expectedWidth}x${expectedHeight})`
  );

  const expectedFps = options.expectedFps ?? FPS;
  push(
    "frame-rate",
    Math.abs(media.frameRate - expectedFps) < 0.5,
    `${media.frameRate.toFixed(3)} fps (expected ${expectedFps})`
  );

  push(
    "pixel-format",
    media.pixelFormat === "yuv420p",
    `${media.pixelFormat} (expected yuv420p)`
  );

  push(
    "video-codec",
    media.videoCodec === "h264",
    `${media.videoCodec} (expected h264)`
  );

  push(
    "audio-stream",
    media.hasAudio && media.audioCodec === "aac",
    media.hasAudio
      ? `${media.audioCodec} ${media.audioSampleRate ?? "?"}Hz x${media.audioChannels ?? "?"}`
      : "no audio stream"
  );

  const maxDuration = options.maxDurationSeconds ?? MAX_DURATION_SECONDS;
  push(
    "duration-range",
    media.durationSeconds > 0 &&
      media.durationSeconds <= maxDuration + 0.5 &&
      media.durationSeconds >= Math.min(options.expectedAudioSeconds - 1.0, 1),
    `${media.durationSeconds.toFixed(2)}s (audio ${options.expectedAudioSeconds.toFixed(2)}s, max ${maxDuration}s)`
  );

  push(
    "non-empty",
    media.sizeBytes > 10_000,
    `${(media.sizeBytes / 1_048_576).toFixed(2)} MiB`
  );

  const liveness = await checkNotBlack(file, options.frameSampleCount ?? 4);
  push("not-blank", liveness.ok, liveness.detail);

  const reach = checkAudioReachesEnd(
    media.durationSeconds,
    options.expectedAudioSeconds
  );
  push("audio-reaches-end", reach.ok, reach.detail);

  if (options.expectMotion) {
    const motion = await checkVisualMotion(file, media.durationSeconds);
    push("scroll-motion", motion.ok, motion.detail);
    const fixed = await checkFixedComposition(file, media.durationSeconds);
    push("fixed-composition", fixed.ok, fixed.detail);
  }

  return { ok: checks.every(check => check.ok), checks, media };
}

type CheckResult = { ok: boolean; detail: string };

/**
 * Sample frames across the file and confirm they are not uniformly black.
 * A failed screenshot would otherwise produce a perfectly valid-looking MP4
 * full of nothing.
 */
export async function checkNotBlack(
  file: string,
  samples = 4
): Promise<CheckResult> {
  const { stdout: durationOut } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  const duration = Number(durationOut.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, detail: "could not read the duration for sampling" };
  }

  let blackFrames = 0;
  const details: string[] = [];
  for (let index = 0; index < samples; index += 1) {
    const at = ((index + 0.5) / samples) * Math.max(0, duration - 0.2);
    try {
      const { stdout } = await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", at.toFixed(2),
        "-i", file,
        "-frames:v", "1",
        "-vf", "scale=32:32,format=gray",
        "-f", "rawvideo",
        "-",
      ], { encoding: "buffer", maxBuffer: 4096 });
      const buffer = stdout as unknown as Buffer;
      let sum = 0;
      for (const byte of buffer) sum += byte;
      const mean = buffer.length ? sum / buffer.length : 0;
      details.push(`${at.toFixed(1)}s:${mean.toFixed(0)}`);
      if (mean < 6) blackFrames += 1;
    } catch {
      return { ok: false, detail: "ffmpeg could not extract a sample frame" };
    }
  }

  return {
    ok: blackFrames < samples,
    detail: `luma samples ${details.join(" ")}`,
  };
}

/**
 * The video must not end long before the narration does, otherwise the last
 * thing said is cut off.
 */
export function checkAudioReachesEnd(
  videoSeconds: number,
  audioSeconds: number,
  toleranceSeconds = 0.6
): CheckResult {
  const gap = videoSeconds - audioSeconds;
  return {
    ok: gap >= -toleranceSeconds && gap <= 2.5,
    detail: `video ${videoSeconds.toFixed(2)}s vs audio ${audioSeconds.toFixed(2)}s (gap ${gap.toFixed(2)}s)`,
  };
}

/* ------------------------------------------------------------------ */
/* Composition checks                                                  */
/* ------------------------------------------------------------------ */

/** Decode one frame to raw RGB24 at the native 1080x1920 size. */
async function extractFrameRgb(
  file: string,
  atSeconds: number
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", atSeconds.toFixed(3),
        "-i", file,
        "-frames:v", "1",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-",
      ],
      { encoding: "buffer", maxBuffer: VIEWPORT.width * VIEWPORT.height * 3 + 1024 }
    );
    const buffer = stdout as unknown as Buffer;
    return buffer.length >= VIEWPORT.width * VIEWPORT.height * 3 ? buffer : null;
  } catch {
    return null;
  }
}

function compareRegion(
  a: Buffer,
  b: Buffer,
  region: { x: number; y: number; width: number; height: number },
  threshold = 10
): { ratio: number; pixels: number } {
  let differing = 0;
  let pixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * VIEWPORT.width + x) * 3;
      pixels += 1;
      if (
        Math.abs(a[offset] - b[offset]) > threshold ||
        Math.abs(a[offset + 1] - b[offset + 1]) > threshold ||
        Math.abs(a[offset + 2] - b[offset + 2]) > threshold
      ) {
        differing += 1;
      }
    }
  }
  return { ratio: pixels ? differing / pixels : 0, pixels };
}

/**
 * A scrollable clip must actually reveal different page content. The sample
 * region is the upper part of the clipped page viewport, deliberately avoiding
 * the caption band and the character so a caption swap cannot masquerade as
 * scroll motion.
 */
export async function checkVisualMotion(
  file: string,
  durationSeconds: number
): Promise<CheckResult> {
  const first = await extractFrameRgb(file, Math.min(0.2, durationSeconds * 0.03));
  const later = await extractFrameRgb(file, durationSeconds * 0.75);
  if (!first || !later) {
    return { ok: false, detail: "could not extract frames for the motion check" };
  }
  const region = {
    x: CARD.left + 25,
    y: CARD.top + CARD_CHROME_HEIGHT + 30,
    width: CARD.width - 50,
    height: Math.round((CARD.height - CARD_CHROME_HEIGHT) * 0.6),
  };
  const result = compareRegion(first, later, region, 12);
  return {
    ok: result.ratio > 0.01,
    detail: `${(result.ratio * 100).toFixed(1)}% of the page viewport changed between 0s and 75%`,
  };
}

/**
 * The stage, card border and browser chrome must be pixel-identical across the
 * clip. Only `.document`, the caption text and the character pose may change.
 */
export async function checkFixedComposition(
  file: string,
  durationSeconds: number
): Promise<CheckResult> {
  const first = await extractFrameRgb(file, Math.min(0.2, durationSeconds * 0.03));
  const later = await extractFrameRgb(file, durationSeconds * 0.75);
  if (!first || !later) {
    return { ok: false, detail: "could not extract frames for the composition check" };
  }
  const stageTop = compareRegion(
    first,
    later,
    { x: 40, y: 30, width: VIEWPORT.width - 80, height: 60 },
    8
  );
  const chrome = compareRegion(
    first,
    later,
    {
      x: CARD.left + 15,
      y: CARD.top + 10,
      width: CARD.width - 30,
      height: 60,
    },
    8
  );
  const ratio = Math.max(stageTop.ratio, chrome.ratio);
  return {
    ok: ratio < 0.01,
    detail: `static stage/chrome changed ${(ratio * 100).toFixed(2)}% (${stageTop.pixels + chrome.pixels} pixels sampled)`,
  };
}

/* ------------------------------------------------------------------ */
/* Contact sheet                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a single horizontal strip of the reference frames so a run can be
 * inspected at a glance without opening five files.
 */
export async function buildContactSheet(
  frames: string[],
  outputPath: string
): Promise<string | null> {
  if (frames.length === 0) return null;
  const thumbWidth = 216;
  const thumbHeight = 384;
  const gap = 10;
  const padding = 16;
  const labelSpace = 28;
  const width = frames.length * thumbWidth + (frames.length - 1) * gap + padding * 2;
  const height = thumbHeight + labelSpace + padding * 2;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#15181c";
  ctx.fillRect(0, 0, width, height);

  for (const [index, file] of frames.entries()) {
    const image = await loadImage(file);
    const x = padding + index * (thumbWidth + gap);
    const y = padding + labelSpace;
    ctx.drawImage(image, x, y, thumbWidth, thumbHeight);
    ctx.fillStyle = "#f2efe9";
    ctx.font = "600 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round((index / Math.max(1, frames.length - 1)) * 100)}%`, x + thumbWidth / 2, padding + 18);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, canvas.toBuffer("image/jpeg", { quality: 92 }));
  return outputPath;
}

/** Loudness of the exported narration, for the run report. */
export async function measureLoudness(
  file: string
): Promise<{ integrated: number; truePeak: number } | null> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner", "-nostats", "-i", file,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ], { maxBuffer: 20 * 1024 * 1024 });
    const json = stderr.slice(stderr.lastIndexOf("{"));
    const parsed = JSON.parse(json) as {
      input_i?: string;
      input_tp?: string;
    };
    return {
      integrated: Number(parsed.input_i ?? "0"),
      truePeak: Number(parsed.input_tp ?? "0"),
    };
  } catch {
    return null;
  }
}
