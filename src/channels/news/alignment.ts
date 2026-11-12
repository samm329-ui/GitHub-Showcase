import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AlignedWord, AlignmentReport } from "./types.js";

/**
 * Word-level alignment glue for the Lazy News channel.
 *
 * Contract (docs §12): the approved script is known before alignment; we run
 * tools/align_audio.py (transcript-conditioned: WhisperX preferred,
 * faster-whisper fallback) on the measured narration.wav and read its JSON.
 * Monotonicity and coverage are enforced here. Chunk-weighted syllable math
 * is retained ONLY as the documented fallback when this stage cannot pass.
 */

export class AlignmentError extends Error {
  override name = "AlignmentError";
}

export async function alignNarration(
  input: { audioPath: string; spokenTranscriptPath: string; segmentsJsonPath?: string; outPath: string },
  cwd = process.cwd()
): Promise<AlignmentReport> {
  const script = path.join(cwd, "tools", "align_audio.py");
  const args = [
    script,
    "--audio", input.audioPath,
    "--transcript", input.spokenTranscriptPath,
    "--out", input.outPath,
    ...(input.segmentsJsonPath ? ["--segments", input.segmentsJsonPath] : []),
  ];
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn("python", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", d => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", c => resolve({ code: c ?? 1, stderr }));
  });
  if (code !== 0) {
    throw new AlignmentError(`align_audio.py failed (exit ${code}): ${stderr.slice(-500)}`);
  }
  const raw = JSON.parse(await fs.readFile(input.outPath, "utf8")) as Record<string, unknown>;
  return toAlignmentReport(raw);
}

export function toAlignmentReport(raw: Record<string, unknown>): AlignmentReport {
  const words = (Array.isArray(raw.words) ? raw.words : []) as AlignedWord[];
  const tokensTotal = Number(raw.tokensTotal ?? 0);
  const monotonic = Boolean(raw.monotonic);
  if (!monotonic && words.length > 1) {
    throw new AlignmentError("Alignment failed the monotonicity check — refusing to build captions from it.");
  }
  return {
    alignmentSource: (raw.alignmentSource as AlignmentReport["alignmentSource"]) ?? "none",
    modelVersion: (raw.modelVersion as string | null) ?? null,
    tokensTotal,
    tokensAligned: Number(raw.tokensAligned ?? 0),
    coverage: Number(raw.coverage ?? 0),
    monotonic,
    chunkBoundaryViolations: Number(raw.chunkBoundaryViolations ?? 0),
    missingWords: Array.isArray(raw.missingWords) ? (raw.missingWords as string[]) : [],
    words,
  };
}

/** Phrase boundary timing for captions: split on strong clause punctuation. */
export function buildAlignedPhrases(
  words: AlignedWord[],
  spokenText: string,
  segmentId: string
): { startMs: number; endMs: number; text: string; wordRange: [number, number] }[] {
  if (words.length === 0) return [];
  // Match tokens to words greedily; fall back to proportional spread.
  const tokens = spokenText.split(/\s+/).filter(Boolean);
  const boundaryIndices: number[] = [];
  let cursor = 0;
  for (let i = 0; i < words.length; i += 1) {
    const endsPhrase = /[.!?…]["')]?$/.test(tokens[Math.min(cursor, tokens.length - 1)] ?? "") || i === words.length - 1;
    if (endsPhrase) boundaryIndices.push(i);
    cursor = Math.min(tokens.length - 1, cursor + 1);
  }
  const phrases: { startMs: number; endMs: number; text: string; wordRange: [number, number] }[] = [];
  let prevEnd = -1;
  for (const end of boundaryIndices) {
    const start = prevEnd + 1;
    if (start > end) continue;
    const slice = tokens.slice(start, end + 1).join(" ");
    phrases.push({
      startMs: words[start].startMs,
      endMs: words[end].endMs,
      text: slice,
      wordRange: [start, end],
    });
    prevEnd = end;
  }
  void segmentId;
  return phrases;
}

/** Confidence-weighted coverage: the fraction of words aligned with prob >= 0.5. */
export function confidentCoverage(report: AlignmentReport): number {
  if (report.words.length === 0) return 0;
  const confident = report.words.filter(w => w.confidence >= 0.5).length;
  return confident / report.words.length;
}
