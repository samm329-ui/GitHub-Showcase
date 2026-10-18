import type { MediaInfo, QaCheck, QaReport } from "./types.js";
import { execFile } from "node:child_process";
import { stat as statFile } from "node:fs/promises";
import { promisify } from "node:util";
import { FPS, MAX_DURATION_SECONDS, VIEWPORT } from "./config.js";

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
