import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { FPS } from "./config.js";

const execFileAsync = promisify(execFile);

export async function renderVideo(
  imagePath: string, wavPath: string, captionsConcatPath: string,
  durationSeconds: number, outputPath: string
): Promise<void> {
  const duration = Math.max(1, durationSeconds);
  const filterComplex =
    `[0:v]crop=540:960:0:'min((ih-oh)*t/${duration},ih-oh)',scale=1080:1920:flags=lanczos,vignette=PI/5[base]; ` +
    `[2:v]format=yuva420p[captions]; ` +
    `[base][captions]overlay=shortest=1:eof_action=pass[v]`;
  await execFileAsync("ffmpeg", [
    "-y",
    "-loop", "1",
    "-framerate", String(FPS),
    "-i", imagePath,
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
    "-shortest", "-t", String(duration),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath
  ], { maxBuffer: 20 * 1024 * 1024 });
}
