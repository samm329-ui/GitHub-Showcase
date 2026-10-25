import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Extract representative frames from the finished render for visual review:
 * opening, mascot entrance, settled pose, spread of caption transitions, and
 * the final frame.
 */
const [video, outDirArg = "temp/frame-review"] = process.argv.slice(2);
if (!video) {
  console.error("usage: tsx tools/frame-review.ts <video.mp4> [outDir]");
  process.exit(1);
}
const outDir = path.resolve(outDirArg);
await mkdir(outDir, { recursive: true });

/** Probe duration via ffprobe. */
async function durationSeconds(): Promise<number> {
  const run = (args: string[]) => new Promise<string>(resolve => {
    const child = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", chunk => (out += String(chunk)));
    child.on("close", () => resolve(out.trim()));
  });
  return Number(
    await run(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video])
  );
}

const total = await durationSeconds();
console.log(`video duration: ${total.toFixed(3)}s`);
const stamps = [0.2, 0.45, 1.5, 4.5, 8, 12, 16, 20, 24, 28, Math.max(0.5, total - 0.12)];
for (const t of stamps.sort((a, b) => a - b)) {
  const file = path.join(outDir, `frame-${String(Math.round(t * 1000)).padStart(6, "0")}ms.jpg`);
  const exit = await new Promise<number>(resolve => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-ss", t.toFixed(3), "-i", video,
      "-frames:v", "1", "-q:v", "2", "-y", file,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", c => (err += String(c)));
    child.on("close", code => {
      if (code !== 0) console.error(`frame ${t}: ${err.slice(-200)}`);
      resolve(code ?? 1);
    });
  });
  if (exit === 0) console.log(`wrote ${file}`);
}
