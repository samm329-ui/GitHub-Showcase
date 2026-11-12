import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CaptionPhrase,
} from "../../types.js";
import type { EpisodeScript, NewsSceneEvent } from "./types.js";
import { buildNewsSceneHtml, calloutProgress, captionHtmlAt, loadNewsAssets } from "./scene.js";
import { sceneStateAt } from "./scene-events.js";
import {
  closeTarget,
  evaluate,
  frameId,
  openTarget,
  setViewport,
  sleep,
} from "../../cdp.js";

const execFileAsync = promisify(execFile);

/**
 * News scene renderer — Chromium CDP frame pump, disk-frames approach.
 *
 * Design (deliberately different from the GitHub capture loop):
 *  - this module owns the Chrome lifecycle: if nothing listens on the CDP
 *    port, a headless instance is spawned for the render and closed after;
 *    a user-managed instance (e.g. run.bat's) is reused and never killed;
 *  - frames are written to workDir/frames/ as JPEG, then a single ffmpeg
 *    `image2` encode runs — a crash never destroys captured work, and
 *    re-encoding never re-captures;
 *  - 30 fps output; capture on the same clock; logs the real capture rate.
 */

export type RenderNewsOptions = {
  script: EpisodeScript;
  captions: CaptionPhrase[];
  events: NewsSceneEvent[];
  audioPath: string;
  audioDurationMs: number;
  workDir: string;
  outputPath: string;
  fps?: number;
  maxDurationSeconds?: number;
  writeReferenceFrames?: boolean;
  onProgress?: (frame: number, total: number) => void;
};

const ART_W = 941;
const ART_H = 1672;
const FPS = 30;
const FRAME_GLOB = "frame-%05d.jpg";
/* News renderer uses its own browser + port. It never touches the GitHub
 * pipeline's 9222 window (or its CHROME_DEBUG_URL): evidence extraction is on
 * 9223 (NEWS_EVIDENCE_PORT), frame capture on 9224 (NEWS_RENDER_PORT). */
const NEWS_CHROME_DEBUG_URL = process.env.NEWS_CHROME_DEBUG_URL ?? `http://127.0.0.1:${process.env.NEWS_RENDER_PORT ?? 9224}`;
const CDP_PORT = Number(new URL(NEWS_CHROME_DEBUG_URL).port || 9224);

async function cdpResponds(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${NEWS_CHROME_DEBUG_URL}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawn a headless Chromium for this render. Returns null if one is already up. */
async function ensureChrome(): Promise<{ spawned: boolean; proc: ChildProcess | null }> {
  if (await cdpResponds()) return { spawned: false, proc: null };
  const candidates = [
    process.env.LAZY_NEWS_CHROME,
    path.join(process.env.LOCALAPPDATA ?? "", "Chromium", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean) as string[];
  const exe = candidates.find(p => fsSync.existsSync(p));
  if (!exe) throw new Error("No Chromium/Chrome/Edge found for the Lazy News renderer. Install one.");

  const profile = path.join(os.tmpdir(), "lazy-news-chrome-profile");
  await fs.mkdir(profile, { recursive: true });
  const proc = spawn(exe, [
    "--headless=new",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore", detached: false, windowsHide: true });
  // wait for the CDP port to come up
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Chromium exited early (code ${proc.exitCode}).`);
    if (await cdpResponds()) return { spawned: true, proc };
    await sleep(250);
  }
  try { proc.kill(); } catch { /* best effort */ }
  throw new Error("Chromium did not open the debugging port within 20s.");
}

export function buildFfmpegArgs(options: {
  fps: number;
  framesDir: string;
  frameStart: number;
  outputPath: string;
  audioPath: string;
  durationSeconds: number;
}): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-start_number", String(options.frameStart),
    "-framerate", String(options.fps),
    "-i", path.join(options.framesDir, FRAME_GLOB),
    "-i", options.audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-vf", "scale=1080:1920:flags=lanczos:out_range=tv,setsar=1,format=yuv420p",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "19",
    "-pix_fmt", "yuv420p",
    "-r", String(options.fps),
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-t", String(options.durationSeconds),
    "-movflags", "+faststart",
    options.outputPath,
  ];
}

export async function renderNewsVideo(options: RenderNewsOptions): Promise<{
  referenceFrames: string[];
  framesDir: string;
  framesKept: boolean;
}> {
  const fps = options.fps ?? FPS;
  const maxDurationSeconds = options.maxDurationSeconds ?? 90;
  const durationSeconds = Math.min(maxDurationSeconds, options.audioDurationMs / 1000);
  const totalFrames = Math.max(1, Math.round(durationSeconds * fps));
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.mkdir(options.workDir, { recursive: true });
  const framesDir = path.join(options.workDir, "frames");
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const assets = loadNewsAssets(process.cwd());
  const html = buildNewsSceneHtml({
    script: options.script,
    assets,
    captions: options.captions,
    events: options.events,
  });

  const chrome = await ensureChrome();
  const { client, targetId } = await openTarget();
  const frameKeys = new Map<number, string>(); // index -> file (set at capture time)
  const referenceFrames: string[] = [];
  const referenceDir = path.join(options.workDir, "visual");
  if (options.writeReferenceFrames !== false) {
    await fs.mkdir(referenceDir, { recursive: true });
  }
  const referenceIndices = new Map<number, number>();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const frame = Math.min(totalFrames - 1, Math.round(fraction * (totalFrames - 1)));
    if (!referenceIndices.has(frame)) referenceIndices.set(frame, Math.round(fraction * 100));
  }

  const startedAt = Date.now();
  let framesDone = 0;

  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await setViewport(client, { width: ART_W, height: ART_H, deviceScaleFactor: 1, mobile: false });
    await client.Page.setDocumentContent({
      frameId: await frameId(client),
      html,
    });
    await evaluate(client, "window.__news.ready(8000)");
    await sleep(150);

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const timeMs = Math.min(options.audioDurationMs, (frame / fps) * 1000);
      const state = sceneStateAt(options.events, timeMs);
      const callout = state.activeCallout;
      const calloutPayload = callout
        ? {
            boardText: callout.boardText ?? "",
            highlightWords: callout.highlightWords ?? [],
            progress: calloutProgress(callout.startMs, callout.endMs, timeMs),
          }
        : null;
      const captionHtml = captionHtmlAt(options.captions, timeMs);

      await evaluate(
        client,
        `(() => {
          window.__news.setBackgroundFocus(${JSON.stringify(state.backgroundFocus)});
          window.__news.setNarrator(${JSON.stringify(state.narrator)}, ${timeMs.toFixed(1)});
          window.__news.setNotes(${JSON.stringify(state.notes)}, ${timeMs.toFixed(1)});
          window.__news.setCallout(${JSON.stringify(calloutPayload)});
          window.__news.setCaption(${JSON.stringify(captionHtml)});
          return 1;
        })()`
      );

      const shot = await client.Page.captureScreenshot({
        format: "jpeg",
        quality: 80,
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      const file = path.join(framesDir, `frame-${String(frame).padStart(5, "0")}.jpg`);
      await fs.writeFile(file, Buffer.from(shot.data, "base64"));
      frameKeys.set(frame, file);
      framesDone = frame + 1;

      if (referenceIndices.has(frame)) {
        const percent = referenceIndices.get(frame)!;
        const dest = path.join(referenceDir, `reference-${percent}pct.jpg`);
        await fs.copyFile(file, dest);
        referenceFrames.push(dest);
      }
      if (frame % 60 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        options.onProgress?.(frame + 1, totalFrames);
        if (frame > 0) {
          console.log(`  frame ${frame}/${totalFrames} (${elapsed.toFixed(1)}s elapsed, ~${(frame / elapsed).toFixed(1)} capture fps)`);
        }
      }
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(`  captured ${totalFrames} frames in ${elapsed.toFixed(1)}s (~${(totalFrames / elapsed).toFixed(1)} fps)`);
  } finally {
    await client.close().catch(() => undefined);
    await closeTarget(targetId).catch(() => undefined);
    if (chrome.spawned && chrome.proc) {
      try { chrome.proc.kill(); } catch { /* best effort */ }
    }
  }

  // --- single encode pass over the frame sequence ---
  const frameFiles = (await fs.readdir(framesDir)).filter(f => f.startsWith("frame-") && f.endsWith(".jpg")).sort();
  if (frameFiles.length !== totalFrames) {
    console.warn(`  WARNING: expected ${totalFrames} frames, found ${frameFiles.length}. Encoding what is present.`);
  }
  const frameStart = 0;
  const ffmpegArgs = buildFfmpegArgs({
    fps,
    framesDir,
    frameStart,
    outputPath: options.outputPath,
    audioPath: options.audioPath,
    durationSeconds: durationSeconds,
  });
  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let ffmpegStderr = "";
  ffmpeg.stderr.on("data", chunk => {
    ffmpegStderr += String(chunk);
    if (ffmpegStderr.length > 16000) ffmpegStderr = ffmpegStderr.slice(-16000);
  });
  const [code] = (await once(ffmpeg, "close")) as [number | null];
  if (code !== 0) {
    await fs.writeFile(path.join(options.workDir, "ffmpeg-stderr.log"), ffmpegStderr);
    throw new Error(`FFmpeg exited with code ${code}\n${ffmpegStderr.slice(-1200)}`);
  }
  console.log(`  encoded ${options.outputPath}`);

  const keepFrames = process.env.NEWS_KEEP_FRAMES === "1";
  if (!keepFrames) {
    await fs.rm(framesDir, { recursive: true, force: true });
  }
  return { referenceFrames, framesDir, framesKept: keepFrames };
}
