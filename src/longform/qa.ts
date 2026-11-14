/**
 * Long-form QA — validates the produced MP4 against the 16:9 profile.
 * Separate from Short-form's `src/qa.ts` defaults (58 s / 9:16).
 */
import { probeMedia, checkNotBlack, measureLoudness, checkAudioReachesEnd } from "../qa.js";
import { LONGFORM } from "./config.js";

export type LongformQaReport = {
  ok: boolean;
  hardFailures: string[];
  warnings: string[];
  media: Awaited<ReturnType<typeof probeMedia>> | null;
  loudness: { integrated: number; truePeak: number } | null;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

export async function validateLongformOutput(
  file: string,
  expected: { audioSeconds: number }
): Promise<LongformQaReport> {
  const hardFailures: string[] = [];
  const warnings: string[] = [];
  const checks: LongformQaReport["checks"] = [];
  const push = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });

  let media: LongformQaReport["media"] = null;
  try {
    media = await probeMedia(file);
  } catch (error) {
    push("ffprobe-readable", false, error instanceof Error ? error.message : String(error));
    return { ok: false, hardFailures: ["file unreadable by ffprobe"], warnings, media: null, loudness: null, checks };
  }

  push("ffprobe-readable", true, `${media.videoCodec} video, ${media.durationSeconds.toFixed(2)}s`);
  const dimOk = media.width === LONGFORM.width && media.height === LONGFORM.height;
  push("dimensions", dimOk, `${media.width}x${media.height} (expected ${LONGFORM.width}x${LONGFORM.height})`);
  const fpsOk = Math.abs(media.frameRate - LONGFORM.fps) < 0.5;
  push("frame-rate", fpsOk, `${media.frameRate.toFixed(3)} fps (expected ${LONGFORM.fps})`);
  const pixFmtOk = media.pixelFormat === LONGFORM.pixelFormat;
  push("pixel-format", pixFmtOk, `${media.pixelFormat} (expected ${LONGFORM.pixelFormat})`);
  const codecOk = media.videoCodec === "h264";
  push("video-codec", codecOk, `${media.videoCodec} (expected h264)`);
  const audioOk = media.hasAudio && media.audioCodec === "aac" && media.audioSampleRate === 48000 && media.audioChannels === 2;
  push("audio-stream", audioOk, media.hasAudio ? `${media.audioCodec} ${media.audioSampleRate}Hz x${media.audioChannels}` : "no audio stream");
  const durationOk =
    media.durationSeconds > 0 &&
    Math.abs(media.durationSeconds - expected.audioSeconds) <= Math.max(2, expected.audioSeconds * 0.03);
  push(
    "duration-vs-audio",
    durationOk,
    `${media.durationSeconds.toFixed(2)}s video vs ${expected.audioSeconds.toFixed(2)}s audio`
  );
  const reach = checkAudioReachesEnd(media.durationSeconds, expected.audioSeconds);
  push("audio-reaches-end", reach.ok, reach.detail);
  const sizeOk = media.sizeBytes > 1_000_000;
  push("non-empty", sizeOk, `${(media.sizeBytes / 1_048_576).toFixed(1)} MiB`);

  // Soft target window — warn, never fail the render.
  if (media.durationSeconds < LONGFORM.softMinSeconds) {
    warnings.push(`episode is ${media.durationSeconds.toFixed(0)}s — below the ${LONGFORM.softMinSeconds}s soft floor`);
  } else if (media.durationSeconds > LONGFORM.softMaxSeconds) {
    warnings.push(`episode is ${media.durationSeconds.toFixed(0)}s — above the ${LONGFORM.softMaxSeconds}s soft ceiling`);
  }

  const liveness = await checkNotBlack(file, 6);
  push("not-blank", liveness.ok, liveness.detail);

  let loudness: LongformQaReport["loudness"] = null;
  try {
    const measured = await measureLoudness(file);
    if (measured) loudness = { integrated: measured.integrated, truePeak: measured.truePeak };
  } catch {
    warnings.push("loudness measurement unavailable");
  }
  if (loudness) {
    const lufsOk = loudness.integrated <= -13 && loudness.integrated >= -16;
    push("loudness", lufsOk, `${loudness.integrated.toFixed(1)} LUFS (target ~${LONGFORM.loudness.integrated})`);
    const peakOk = loudness.truePeak <= -1.0;
    push("true-peak", peakOk, `${loudness.truePeak.toFixed(1)} dBTP (target ≤ ${LONGFORM.loudness.truePeak})`);
  }

  for (const check of checks) {
    if (!check.ok) hardFailures.push(`${check.name}: ${check.detail}`);
  }
  return { ok: hardFailures.length === 0, hardFailures, warnings, media, loudness, checks };
}
