import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  CharacterCue,
  CharacterPoseName,
  SpeechEnvelope,
  StorySlot,
} from "./types.js";
import { CHARACTER, CHARACTER_ENVELOPE_RATE_HZ } from "./config.js";

/**
 * Deterministic whole-cut-out motion.
 *
 * A single PNG has no mouth states, so this is not lip-sync: the character's
 * body bobs and tilts slightly more while the narrator is speaking. Everything
 * is derived from `timeMs` and a precomputed 0..1 speech envelope, so rendering
 * the same video twice produces exactly the same frames.
 */

export type CharacterPose = {
  x: number;
  y: number;
  rotationDeg: number;
  scale: number;
  opacity: number;
};

const TWO_PI = Math.PI * 2;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Whole-cut-out presenter action. The supplied artwork has one pose, so the
 * action is expressed as a deliberate lean/settle rather than fake limb
 * articulation. If separate pose PNGs are supplied, the framing swaps too.
 */
export function characterPoseAt(
  timeMs: number,
  speechLevel: number,
  action: CharacterPoseName = "present"
): CharacterPose {
  const t = Math.max(0, timeMs) / 1000;
  const speaking = clamp01(speechLevel);

  const idleY = Math.sin(TWO_PI * 0.45 * t) * CHARACTER.idleBobPx;
  const speechY =
    Math.sin(TWO_PI * 2.8 * t) * (1.2 + CHARACTER.speechBobPx * speaking);
  const baseRotation =
    Math.sin(TWO_PI * 1.35 * t) * (0.2 + CHARACTER.speechTiltDeg * speaking);
  const baseScale = 1 + CHARACTER.scaleGain * speaking;
  const baseX = Math.sin(TWO_PI * 0.7 * t) * 1.5;

  // Actions are intentionally small and eased by their own slow oscillation,
  // never random: the same frame always produces the same pose.
  const settle = Math.sin(TWO_PI * 0.33 * t);
  const actionX =
    action === "point" ? -9 + settle * 1.2 : action === "close" ? 0 : -2 + settle * 0.6;
  const actionRotation =
    action === "point" ? -1.7 + settle * 0.25 : action === "close" ? 0.2 : -0.35;
  const actionScale =
    action === "point" ? 1.015 : action === "close" ? 1.03 : 1;

  return {
    x: baseX + actionX,
    y: idleY + speechY,
    rotationDeg: baseRotation + actionRotation,
    scale: baseScale * actionScale,
    opacity: 1,
  };
}

/** Map a grammar slot to a presenter action/framing. */
export function characterPoseForSlot(slot?: StorySlot): CharacterPoseName {
  switch (slot) {
    case "cta":
      return "close";
    case "demo":
    case "setup":
      return "point";
    default:
      return "present";
  }
}

/** The active presenter cue at a timeline position. */
export function characterCueAt(
  cues: CharacterCue[],
  timeMs: number
): CharacterPoseName {
  if (cues.length === 0) return "present";
  const time = Math.max(0, timeMs);
  for (const cue of cues) {
    if (time >= cue.startMs && time < cue.endMs) return cue.pose;
  }
  return time >= cues[cues.length - 1].endMs
    ? cues[cues.length - 1].pose
    : cues[0].pose;
}

/**
 * Exponential moving average over a 0..1 envelope. `alpha` is the weight of
 * the new sample: smaller is smoother.
 */
export function smoothEnvelope(raw: number[], alpha = 0.32): number[] {
  const weight = Math.min(1, Math.max(0.01, alpha));
  const out: number[] = [];
  let previous = 0;
  for (const value of raw) {
    const sample = clamp01(value);
    previous = previous + (sample - previous) * weight;
    out.push(previous);
  }
  return out;
}

/** Normalise RMS values against a high percentile, with a noise gate. */
export function normaliseEnvelope(
  rms: number[],
  options: { percentile?: number; gate?: number } = {}
): number[] {
  if (rms.length === 0) return [];
  const sorted = [...rms].sort((a, b) => a - b);
  const percentile = options.percentile ?? 0.95;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * percentile))
  );
  const peak = Math.max(0.0001, sorted[index]);
  const gate = options.gate ?? 0.035;
  return rms.map(value => {
    const level = clamp01(value / peak);
    return level < gate ? 0 : (level - gate) / (1 - gate);
  });
}

export function speechLevelAt(envelope: SpeechEnvelope | null, timeMs: number): number {
  if (!envelope || envelope.levels.length === 0) return 0;
  const position = (Math.max(0, timeMs) / 1000) * envelope.rateHz;
  const index = Math.floor(position);
  if (index < 0) return 0;
  if (index >= envelope.levels.length - 1) return envelope.levels[envelope.levels.length - 1];
  const fraction = position - index;
  const from = envelope.levels[index];
  const to = envelope.levels[index + 1];
  return clamp01(from + (to - from) * fraction);
}

/**
 * Build a low-rate amplitude envelope from the measured narration WAV.
 *
 * FFmpeg downmixes to mono PCM; Node computes short-window RMS; the result is
 * normalised and EMA-smoothed so individual waveform cycles never jitter the
 * character. A failed analysis returns a silent envelope rather than failing
 * the render.
 */
export async function buildSpeechEnvelope(
  wavPath: string,
  rateHz = CHARACTER_ENVELOPE_RATE_HZ
): Promise<SpeechEnvelope> {
  const sampleRate = 8000;
  const windowSize = Math.max(1, Math.round(sampleRate / rateHz));
  const samples = await decodePcm(wavPath, sampleRate);
  if (samples.length === 0) {
    return { rateHz, durationMs: 0, levels: [] };
  }

  const rms: number[] = [];
  for (let offset = 0; offset < samples.length; offset += windowSize) {
    const end = Math.min(samples.length, offset + windowSize);
    let sum = 0;
    for (let index = offset; index < end; index += 1) {
      const value = samples[index] / 32768;
      sum += value * value;
    }
    rms.push(Math.sqrt(sum / Math.max(1, end - offset)));
  }

  return {
    rateHz,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    levels: smoothEnvelope(normaliseEnvelope(rms), 0.3),
  };
}

function decodePcm(file: string, sampleRate: number): Promise<Int16Array> {
  return new Promise(resolve => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-i", file,
        "-ac", "1",
        "-ar", String(sampleRate),
        "-f", "s16le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", () => resolve(new Int16Array(0)));
    child.on("close", code => {
      if (code !== 0) {
        resolve(new Int16Array(0));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const usable = buffer.length - (buffer.length % 2);
      const samples = new Int16Array(usable / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(index * 2);
      }
      resolve(samples);
    });
  });
}

/** Resolve the configured character asset; absence simply disables the layer. */
export function resolveCharacterAsset(configuredPath: string | null): string | null {
  if (!configuredPath) return null;
  try {
    return existsSync(configuredPath) ? configuredPath : null;
  } catch {
    return null;
  }
}
