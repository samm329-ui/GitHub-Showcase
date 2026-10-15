import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { CAPTURE_FPS, FPS } from "./config.js";

const execFileAsync = promisify(execFile);

export async function renderVideo(framesDir: string, wavPath: string, captionsConcatPath: string, outputPath: string): Promise<void> {
  const filterComplex =
    "[0:v]scale=1080:1920:flags=lanczos[base]; [2:v]format=yuva420p[captions]; [base][captions]overlay=shortest=1:eof_action=pass[v]";
  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate", String(CAPTURE_FPS),
    "-i", path.join(framesDir, "frame-%05d.jpg"),
    "-i", wavPath,
    "-f", "concat",
    "-safe", "0",
    "-i", captionsConcatPath,
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "1:a",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-r", String(FPS),
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
    "-shortest", "-t", String(20),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath
  ], { maxBuffer: 20 * 1024 * 1024 });
}
