import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  TTS_LANG,
  TTS_MAX_RETRIES,
  TTS_PAUSE_BETWEEN_SEGMENTS_MS,
  TTS_SPEED,
  TTS_VOICE,
} from "./config.js";
import type { AudioChunk, AudioMeasurement, NarrationSegment } from "./types.js";
import { prepareTtsText } from "./tts-text.js";

const execFileAsync = promisify(execFile);

type RunOptions = {
  input?: string;
  timeout?: number;
  maxBuffer?: number;
};

/** `execFile` with an explicit signature; the promisified overloads are ambiguous. */
function run(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} exited with code ${(error as NodeJS.ErrnoException & { code?: number | string }).code ?? "?"}: ${String(stderr || error.message).slice(0, 800)}`
            )
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export type KokoroPaths = {
  model: string;
  voices: string;
  script: string;
};

export function kokoroPaths(): KokoroPaths {
  const root = process.cwd();
  return {
    model: process.env.KOKORO_MODEL ?? path.join(root, "tools", "kokoro", "kokoro-v1.0.int8.onnx"),
    voices: process.env.KOKORO_VOICES ?? path.join(root, "tools", "kokoro", "voices-v1.0.bin"),
    script: path.join(root, "src", "kokoro-tts.py"),
  };
}

const pythonCandidates = [process.env.PYTHON, "python", "python3"].filter(
  Boolean
) as string[];

export class TtsError extends Error {
  constructor(message: string, readonly stage = "tts") {
    super(message);
    this.name = "TtsError";
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* ffprobe                                                             */
/* ------------------------------------------------------------------ */

export async function probeAudio(file: string): Promise<AudioMeasurement> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=sample_rate,channels,codec_name",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);
  const info = JSON.parse(stdout) as {
    streams?: { sample_rate?: string; channels?: number; codec_name?: string }[];
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  if (!stream?.sample_rate) {
    throw new TtsError(`ffprobe could not read an audio stream from ${file}`);
  }
  return {
    file,
    durationMs: Math.round(Number(info.format?.duration ?? 0) * 1000),
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels ?? 1,
  };
}

/* ------------------------------------------------------------------ */
/* Python resolution                                                   */
/* ------------------------------------------------------------------ */

let cachedPython: string | null = null;

export async function resolvePython(): Promise<string> {
  if (cachedPython) return cachedPython;
  for (const python of pythonCandidates) {
    try {
      await execFileAsync(python, ["-c", "import kokoro_onnx, soundfile"]);
      cachedPython = python;
      return python;
    } catch {
      // try the next interpreter
    }
  }
  throw new TtsError(
    "Kokoro could not be run. Install Python with the `kokoro-onnx` and `soundfile` packages, " +
      "or set the PYTHON environment variable to an interpreter that has them."
  );
}

export async function assertKokoroAvailable(): Promise<KokoroPaths> {
  const paths = kokoroPaths();
  if (!(await exists(paths.model)) || !(await exists(paths.voices))) {
    throw new TtsError(
      `Kokoro files were not found: ${paths.model}, ${paths.voices}. ` +
        "Set KOKORO_MODEL and KOKORO_VOICES to point at them."
    );
  }
  if (!(await exists(paths.script))) {
    throw new TtsError(`Kokoro wrapper script is missing: ${paths.script}`);
  }
  await resolvePython();
  return paths;
}

/* ------------------------------------------------------------------ */
/* Synthesis                                                           */
/* ------------------------------------------------------------------ */

export type SynthesizeOptions = {
  voice?: string;
  speed?: number;
  lang?: string;
};

export type SynthesizedChunk = AudioChunk & {
  /** True when the model reported real phoneme timings. */
  hasPhonemeTimings: boolean;
};

/**
 * Synthesize one chunk. Retries a small number of times; a failing chunk never
 * discards the chunks that already succeeded.
 */
export async function synthesizeChunk(
  text: string,
  outputWav: string,
  options: SynthesizeOptions = {}
): Promise<SynthesizedChunk> {
  const paths = await assertKokoroAvailable();
  const python = await resolvePython();
  const metadataPath = `${outputWav}.json`;
  const voice = options.voice ?? TTS_VOICE;
  const speed = options.speed ?? TTS_SPEED;
  const lang = options.lang ?? TTS_LANG;

  // Speech-only normalisation. Captions are built from `captionText` elsewhere
  // and never pass through this path.
  const speechText = prepareTtsText(text);
  if (!speechText.trim()) {
    throw new TtsError("Narration segment was empty after speech normalisation.");
  }

  await fs.mkdir(path.dirname(outputWav), { recursive: true });

  let lastError: unknown;
  for (let attempt = 0; attempt <= TTS_MAX_RETRIES; attempt += 1) {
    try {
      await run(
        python,
        [
          paths.script,
          "--model", paths.model,
          "--voices", paths.voices,
          "--voice", voice,
          "--speed", String(speed),
          "--lang", lang,
          "--output", outputWav,
          "--metadata", metadataPath,
        ],
        { input: `${speechText}\n`, timeout: 300000 }
      );
      const measured = await probeAudio(outputWav);
      let phonemeTimings = 0;
      try {
        phonemeTimings = Number(
          JSON.parse(await fs.readFile(metadataPath, "utf8")).phonemeTimings ?? 0
        );
      } catch {
        phonemeTimings = 0;
      }
      await fs.rm(metadataPath, { force: true });
      return {
        index: -1,
        segmentId: "",
        file: outputWav,
        text: speechText,
        durationMs: measured.durationMs,
        sampleRate: measured.sampleRate,
        channels: measured.channels,
        startMs: 0,
        endMs: measured.durationMs,
        hasPhonemeTimings: phonemeTimings > 0,
      };
    } catch (error) {
      lastError = error;
      await fs.rm(outputWav, { force: true });
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new TtsError(`Kokoro failed after ${TTS_MAX_RETRIES + 1} attempts: ${detail}`);
}

/** Minimal silence, used to join chunks without a hard click. */
async function silenceWav(ms: number, sampleRate: number, target: string): Promise<void> {
  const samples = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const buffer = Buffer.alloc(samples * 2);
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=r=${sampleRate}:cl=mono`,
      "-t", String(ms / 1000),
      "-c:a", "pcm_s16le",
      target,
    ], { windowsHide: true });
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg silence exit ${code}`))));
  });
  void buffer;
}

/**
 * Concatenate measured chunks with an intentional short pause between them.
 * Returns the merged file plus its measured properties.
 */
export async function concatChunks(
  chunks: SynthesizedChunk[],
  outputWav: string,
  pauseMs: number = TTS_PAUSE_BETWEEN_SEGMENTS_MS
): Promise<AudioMeasurement> {
  if (chunks.length === 0) throw new TtsError("No audio chunks were produced.");
  if (chunks.length === 1) {
    await fs.copyFile(chunks[0].file, outputWav);
    return probeAudio(outputWav);
  }

  const sampleRate = chunks[0].sampleRate;
  if (chunks.some(chunk => chunk.sampleRate !== sampleRate)) {
    throw new TtsError("Kokoro returned chunks with mismatched sample rates.");
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "showcase-join-"));
  const listFile = path.join(scratch, "concat.txt");
  try {
    const lines: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0 && pauseMs > 0) {
        const gap = path.join(scratch, `gap-${index}.wav`);
        await silenceWav(pauseMs, sampleRate, gap);
        lines.push(`file '${gap.replace(/\\/g, "/")}'`);
      }
      lines.push(`file '${chunk.file.replace(/\\/g, "/")}'`);
    }
    await fs.writeFile(listFile, `${lines.join("\n")}\n`, "utf8");
    await run("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:a", "pcm_s16le", outputWav,
    ]);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return probeAudio(outputWav);
}

/* ------------------------------------------------------------------ */
/* Narration -> chunks                                                 */
/* ------------------------------------------------------------------ */

/**
 * One TTS request per narration segment. Segment boundaries are chosen by the
 * script planner, which already produces one idea per segment, so prosody and
 * pauses survive.
 */
export async function synthesizeSegments(
  segments: NarrationSegment[],
  audioDir: string,
  options: SynthesizeOptions = {}
): Promise<SynthesizedChunk[]> {
  await fs.mkdir(audioDir, { recursive: true });
  const chunks: SynthesizedChunk[] = [];
  for (const [index, segment] of segments.entries()) {
    const file = path.join(audioDir, `segment-${String(index + 1).padStart(3, "0")}.wav`);
    const chunk = await synthesizeChunk(segment.spokenText, file, options);
    chunks.push({ ...chunk, index, segmentId: segment.id });
  }
  return chunks;
}

/**
 * Turn measured chunks into absolute timeline intervals, inserting the
 * configured pause between segments.
 */
export function toTimedChunks(
  chunks: SynthesizedChunk[],
  segments: NarrationSegment[],
  pauseMs: number = TTS_PAUSE_BETWEEN_SEGMENTS_MS
): AudioChunk[] {
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const pauseAfter = segments[index]?.pauseAfterMs ?? pauseMs;
    const startMs = cursor;
    const endMs = startMs + chunk.durationMs;
    cursor = endMs + pauseAfter;
    return {
      index,
      segmentId: chunk.segmentId || segments[index]?.id || `seg-${index}`,
      file: chunk.file,
      text: chunk.text,
      durationMs: chunk.durationMs,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
      startMs,
      endMs,
    };
  });
}

/** Legacy single-shot API, kept so existing callers still work. */
export async function makeVoice(
  text: string,
  outputWav: string,
  options: SynthesizeOptions = {}
): Promise<void> {
  await synthesizeChunk(text, outputWav, options);
}