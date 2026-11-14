/**
 * Long-form audio production: continuous BGM bed (looped) + narration-aware
 * ducking + event-driven SFX + loudness validation.
 *
 * The mix is one FFmpeg pass; everything is a pure function of the master
 * timeline. Narration always wins.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { LONGFORM, MUSIC_BED, SFX } from "./config.js";
import { verifyUsedAssets } from "./music-manager.js";
import type { Scene } from "./types.js";

const execFileAsync = promisify(execFile);

export type SfxEvent = { role: string; asset: string; atMs: number; gainDb: number };

const SFX_GAIN_DB: Record<string, number> = {
  "mascot-entry": -6,
  "mascot-landing": -9,
  "mascot-exit": -7,
  "callout-appear": -12,
  "caption-tick": -22,
  "caption-impact": -14,
  "caption-pop": -12,
  "reveal-hit": -9,
  "title-reveal": -14,
  "camera-push": -18,
  "significant-zoom": -16,
  "code-highlight": -19,
  "feature-reveal": -16,
  "outro": -8,
};

const SFX_ROLE_TO_ASSET: Record<string, string> = {
  "mascot-entry": SFX.mascotEntry,
  "mascot-landing": SFX.mascotLanding,
  "mascot-exit": SFX.mascotExit,
  "callout-appear": SFX.calloutPop,
  "caption-tick": SFX.captionTick,
  "caption-impact": SFX.captionImpact,
  "caption-pop": SFX.calloutPop,
  "reveal-hit": SFX.revealHit,
  "title-reveal": SFX.titleReveal,
  "camera-push": SFX.cameraPush,
  "significant-zoom": SFX.zoomImpact,
  "code-highlight": SFX.codeHighlight,
  "feature-reveal": SFX.featureReveal,
  "outro": SFX.outroSoftHit,
};

/** Derive the SFX schedule from actual scene events (never arbitrary stamps). */
export function scheduleSfxFromScenes(scenes: Scene[]): SfxEvent[] {
  const events: SfxEvent[] = [];
  for (const scene of scenes) {
    // Scene-authored events are the single source of truth for entry/landing/
    // reveal/zoom/highlight/outro sounds; the mixer only adds sounds the
    // planner does not place by hand (title-reveal for the reveal scenes).
    for (const sfx of scene.sfx) {
      const asset = SFX_ROLE_TO_ASSET[sfx.role];
      if (asset) events.push({ role: sfx.role, asset, atMs: Math.max(0, Math.round(sfx.atMs)), gainDb: SFX_GAIN_DB[sfx.role] ?? -12 });
    }
    if (scene.type === "repo-reveal") {
      events.push({ role: "title-reveal", asset: SFX.titleReveal, atMs: scene.startMs + 180, gainDb: SFX_GAIN_DB["title-reveal"] });
    }
  }
  return events.sort((a, b) => a.atMs - b.atMs);
}

const dbToLinear = (db: number): number => Math.pow(10, db / 20);

export type MixAudioOptions = {
  narrationWav: string;
  durationMs: number;
  sfxEvents: SfxEvent[];
  outputWav: string;
  bgmPath?: string;
  /** Set false to force SFX-only mix (e.g. music gate failed). */
  includeBgm?: boolean;
  onLog?: (line: string) => void;
};

export async function mixEpisodeAudio(options: MixAudioOptions): Promise<{ mixedWav: string; bgmIncluded: boolean }> {
  const durationSec = options.durationMs / 1000;
  const bgm = options.includeBgm === false ? null : (options.bgmPath ?? MUSIC_BED);
  const events = options.sfxEvents;
  const targetLufs = LONGFORM.loudness.integrated;
  const truePeak = LONGFORM.loudness.truePeak;

  // Licence gate — development-mode override logs loudly (see music-manager).
  const usedAssets = events.map(e => `sfx/${path.basename(e.asset)}`);
  if (bgm) usedAssets.push("music/longform_background_bed.mp3");
  const license = verifyUsedAssets(usedAssets);
  if (!license.ok && !license.devMode) {
    throw new Error(
      `BGM/SFX licence verification FAILED for: ${license.unverified.join(", ")}. ` +
        "Set LONGFORM_ALLOW_UNVERIFIED_ASSETS=1 to develop with unverified assets (episode must not be published), " +
        "or verify the assets in assets/longform/asset-licenses.json."
    );
  }

  const inputs: string[] = ["-i", options.narrationWav];
  if (bgm) {
    // Loop the bed to cover the whole episode; start slightly before t=0 so the
    // opening has music from the first frame.
    inputs.push("-stream_loop", "-1", "-i", bgm);
  }
  const sfxStartIndex = bgm ? 2 : 1;
  for (const event of events) {
    inputs.push("-i", event.asset);
  }

  const filters: string[] = [];
  filters.push(`[0:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-18:TP=-2:LRA=8,volume=1.6[narr]`);

  if (bgm) {
    // BGM sits ~13 dB under narration; sidechain compressor ducks it further while speech is active.
    filters.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.16[bgm_raw]`);
    filters.push(`[narr]asplit=2[narr_mix][sc]`);
    filters.push(`[bgm_raw][sc]sidechaincompress=threshold=0.02:ratio=9:attack=25:release=420:makeup=1[bgm_duck]`);
    filters.push(`[bgm_duck]afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, durationSec - 3.5)}:d=3.5[bgm]`);
  } else {
    filters.push(`[narr]anull[narr_mix]`);
  }

  const mixInputs: string[] = [bgm ? "[narr_mix]" : "[narr_mix]"];
  if (bgm) mixInputs.push("[bgm]");
  events.forEach((event, i) => {
    const inputIndex = sfxStartIndex + i;
    const delay = Math.max(0, Math.round(event.atMs));
    filters.push(
      `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${dbToLinear(event.gainDb).toFixed(4)},adelay=${delay}|${delay}[sfx${i}]`
    );
    mixInputs.push(`[sfx${i}]`);
  });

  filters.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[premix]`
  );
  filters.push(`[premix]loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11[aout]`);

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[aout]",
    "-t", durationSec.toFixed(3),
    "-c:a", "pcm_s16le",
    "-ar", "48000",
    "-ac", "2",
    options.outputWav,
  ];
  await execFileAsync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
  return { mixedWav: options.outputWav, bgmIncluded: Boolean(bgm) };
}

/** Hash of the audio plan for checkpoint invalidation. */
export function audioPlanHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
