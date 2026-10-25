import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FPS, MAX_DURATION_SECONDS } from "./config.js";
import { renderCardVideo } from "./browser-capture.js";
import type { CharacterPoseAsset } from "./card.js";
import type {
  CalloutCue,
  CaptionPhrase,
  CharacterCue,
  EnrichedRepo,
  ImpactBurstCue,
  ScrollKeyframe,
  SpeechEnvelope,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Encoding entry point.
 *
 * `renderVideo` builds the stationary 9:16 card, streams the frames into
 * FFmpeg and muxes the measured narration. The output duration comes from the
 * audio timeline — there is no hard-coded 30 second window.
 */

export type RenderVideoOptions = {
  repo: EnrichedRepo;
  /** Loopback URL of the real mobile screenshot (primary mode). */
  pageImageUrl?: string | null;
  /** Loopback URL of the transparent character cut-out. */
  characterUrl?: string | null;
  /** Optional named presenter poses (present/point/close). */
  characterPoses?: CharacterPoseAsset[] | null;
  /** Presenter action/framing changes, aligned to narration segments. */
  characterCues?: CharacterCue[] | null;
  captions: CaptionPhrase[];
  /** Callout cues written to timeline.json; passed straight through. */
  callouts?: CalloutCue[] | null;
  /** Animated comic impact accents. */
  impactBursts?: ImpactBurstCue[] | null;
  /** Loopback URL of the comic speech bubble sticker. */
  calloutImageUrl?: string | null;
  scrollKeyframes: ScrollKeyframe[];
  audioPath: string;
  audioDurationMs: number;
  outputPath: string;
  workDir: string;
  speechEnvelope?: SpeechEnvelope | null;
  fps?: number;
  crf?: number;
  preset?: string;
  onProgress?: (frame: number, totalFrames: number) => void;
};

export async function renderVideo(
  options: RenderVideoOptions
): Promise<{ totalFrames: number; durationSeconds: number; referenceFrames: string[] }> {
  const fps = options.fps ?? FPS;
  const durationSeconds = Math.min(MAX_DURATION_SECONDS, options.audioDurationMs / 1000);
  const totalFrames = Math.max(1, Math.round(durationSeconds * fps));

  const result = await renderCardVideo({
    repo: options.repo,
    pageImageUrl: options.pageImageUrl,
    characterUrl: options.characterUrl,
    characterPoses: options.characterPoses,
    characterCues: options.characterCues,
    speechEnvelope: options.speechEnvelope,
    captions: options.captions,
    callouts: options.callouts,
    impactBursts: options.impactBursts,
    calloutImageUrl: options.calloutImageUrl,
    scrollKeyframes: options.scrollKeyframes,
    durationMs: options.audioDurationMs,
    outputPath: options.outputPath,
    audioPath: options.audioPath,
    workDir: options.workDir,
    fps,
    crf: options.crf,
    preset: options.preset,
    onProgress: options.onProgress,
  });

  return { totalFrames, durationSeconds, referenceFrames: result.referenceFrames };
}

/**
 * Legacy signature kept for callers that only have a still image.
 *
 * A still image is now treated as a one-frame scroll document inside the same
 * stationary card, so old callers keep the correct geometry.
 */
export async function renderVideoFromStill(
  imagePath: string,
  wavPath: string,
  durationSeconds: number,
  outputPath: string
): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "showcase-still-"));
  try {
    const audioSeconds = await probeDuration(wavPath);
    const seconds = Math.min(MAX_DURATION_SECONDS, durationSeconds || audioSeconds);
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-framerate", String(FPS), "-i", imagePath,
      "-i", wavPath,
      "-filter_complex",
      `[0:v]scale=810:1668:force_original_aspect_ratio=decrease,pad=810:1668:(ow-iw)/2:(oh-ih)/2:color=${"0D1117"},` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=F2EFE9[v]`,
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "medium", "-crf", "19",
      "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-t", String(seconds), "-movflags", "+faststart",
      outputPath,
    ], { maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  return Number(stdout.trim()) || 0;
}