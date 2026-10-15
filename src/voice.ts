import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const kokoroModel = process.env.KOKORO_MODEL ?? path.join(process.cwd(), "tools", "kokoro", "kokoro-v1.0.int8.onnx");
const kokoroVoices = process.env.KOKORO_VOICES ?? path.join(process.cwd(), "tools", "kokoro", "voices-v1.0.bin");
const kokoroVoice = process.env.KOKORO_VOICE ?? "af_heart";
const kokoroScript = path.join(process.cwd(), "src", "kokoro-tts.py");

const pythonCandidates = [
  process.env.PYTHON,
  "python",
  "python3"
].filter(Boolean) as string[];

export async function makeVoice(text: string, outputWav: string): Promise<void> {
  if (!kokoroModel || !kokoroVoices) {
    throw new Error("Set KOKORO_MODEL and KOKORO_VOICES to your Kokoro model and voices file. No other speech engine is configured.");
  }
  if (!(await exists(kokoroModel)) || !(await exists(kokoroVoices))) {
    throw new Error(`Kokoro files were not found: ${kokoroModel}, ${kokoroVoices}`);
  }

  for (const python of pythonCandidates) {
    try {
      execFileSync(python, [
        kokoroScript,
        "--model", kokoroModel,
        "--voices", kokoroVoices,
        "--voice", kokoroVoice,
        "--output", outputWav
      ], { input: `${text}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  throw new Error("Kokoro could not be run. Install Python and kokoro-onnx, then set KOKORO_MODEL and KOKORO_VOICES.");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
