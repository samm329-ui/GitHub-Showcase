import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
const execFileAsync = promisify(execFile);

const piperCandidates = [
  process.env.PIPER_EXE,
  "C:\\tools\\piper\\piper.exe",
  "piper"
].filter(Boolean) as string[];

const piperModel = process.env.PIPER_MODEL ?? "C:\\tools\\piper\\voices\\en_US-lessac-medium.onnx";

export async function makeVoice(text: string, outputWav: string): Promise<void> {
  for (const candidate of piperCandidates) {
    try {
      execFileSync(candidate, ["-m", piperModel, "-f", outputWav], {
        input: `${text}\n`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      return;
    } catch {
      // Try the next available engine.
    }
  }

  const espeakCandidates = [
    process.env.ESPEAK_NG_PATH,
    "espeak-ng",
    "C:\\Program Files\\eSpeak NG\\espeak-ng.exe"
  ].filter(Boolean) as string[];

  for (const candidate of espeakCandidates) {
    try {
      await execFileAsync(candidate, ["-s", "155", "-v", "en-us", "-w", outputWav, text]);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  throw new Error("No speech engine was found. Install Piper or espeak-ng.");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
