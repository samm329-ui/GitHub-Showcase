import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT, SFX_CONFIG, type SfxConfig } from "./config.js";
import type { CalloutCue, SoundEvent } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Schedule sound events bound to the measured media timeline.
 *
 * Mascot entrance triggers at the mascot entrance animation start (0 ms),
 * and each callout pop triggers at the start of each eligible callout bubble entrance.
 * Uses exact timestamp calculations matching the visual render loop.
 */
export function scheduleSoundEvents(
  callouts: CalloutCue[] = [],
  durationMs: number,
  config: SfxConfig = SFX_CONFIG,
  options?: { mascotEntranceMs?: number }
): SoundEvent[] {
  const events: SoundEvent[] = [];

  // Mascot entrance whoosh
  if (config.mascotEntrance?.enabled) {
    const entranceStart = options?.mascotEntranceMs ?? 0;
    const startMs = Math.max(0, Math.round(entranceStart + config.mascotEntrance.startOffsetMs));
    if (startMs < durationMs) {
      events.push({
        asset: config.mascotEntrance.asset,
        startMs,
        gain: config.mascotEntrance.gain,
        kind: "mascot-entrance",
      });
    }
  }

  // Callout pop for each eligible callout bubble
  if (config.calloutPop?.enabled && callouts.length > 0) {
    for (const cue of callouts) {
      const startMs = Math.max(0, Math.round(cue.startMs + config.calloutPop.startOffsetMs));
      if (startMs < durationMs) {
        events.push({
          asset: config.calloutPop.asset,
          startMs,
          gain: config.calloutPop.gain,
          kind: "callout-pop",
          cueId: cue.id,
        });
      }
    }
  }

  return events.sort((a, b) => a.startMs - b.startMs);
}

export type MixAudioOptions = {
  narrationPath: string;
  soundEvents?: SoundEvent[];
  durationMs?: number;
  outputPath: string;
};

/**
 * Mix narration and scheduled sound effects into a single composite audio file using FFmpeg.
 *
 * Uses `adelay`, `volume`, and `amix=duration=first:dropout_transition=0:normalize=0`
 * so the narration timing and duration remain strictly unchanged.
 */
export async function mixAudioTracks(options: MixAudioOptions): Promise<string> {
  const { narrationPath, soundEvents = [], durationMs, outputPath } = options;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const validEvents = soundEvents
    .map(event => {
      const resolved = path.isAbsolute(event.asset)
        ? event.asset
        : path.resolve(ROOT, event.asset);
      return { ...event, resolvedAsset: resolved };
    })
    .filter(event => fsSync.existsSync(event.resolvedAsset) && event.gain > 0);

  if (validEvents.length === 0) {
    if (path.resolve(narrationPath) !== path.resolve(outputPath)) {
      await fs.copyFile(narrationPath, outputPath);
    }
    return outputPath;
  }

  const inputs: string[] = ["-i", narrationPath];
  for (const event of validEvents) {
    inputs.push("-i", event.resolvedAsset);
  }

  const filters: string[] = [
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0]`,
  ];
  const mixInputs: string[] = ["[a0]"];

  for (let i = 0; i < validEvents.length; i++) {
    const event = validEvents[i];
    const inputIdx = i + 1;
    const delay = Math.max(0, Math.round(event.startMs));
    const gain = Math.max(0, Math.min(1, event.gain));
    filters.push(
      `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${gain.toFixed(4)},adelay=${delay}|${delay}[s${inputIdx}]`
    );
    mixInputs.push(`[s${inputIdx}]`);
  }

  filters.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[aout]`
  );

  const filterComplex = filters.join(";");

  const ffmpegArgs = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[aout]",
    "-c:a", "pcm_s16le",
    "-ar", "48000",
    "-ac", "2",
  ];

  if (durationMs !== undefined && durationMs > 0) {
    ffmpegArgs.push("-t", (durationMs / 1000).toFixed(3));
  }

  ffmpegArgs.push(outputPath);

  await execFileAsync("ffmpeg", ffmpegArgs);
  return outputPath;
}
