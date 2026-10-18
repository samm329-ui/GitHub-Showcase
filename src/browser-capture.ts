import CDP from "chrome-remote-interface";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { CHROME_DEBUG_URL, FPS, MAX_DURATION_SECONDS } from "./config.js";
import type {
  CaptionPhrase,
  EnrichedRepo,
  MeasuredAnchor,
  ScrollKeyframe,
} from "./types.js";
import { buildCardHtml, CARD_VIEWPORT_HEIGHT } from "./card.js";
import { captionHtml } from "./caption-overlay.js";
import { scrollAt } from "./timeline.js";
import { measuredAnchors, scrollBounds } from "./scroll.js";

/**
 * Chromium capture + FFmpeg encode.
 *
 * The card is rendered as real DOM (stage, card, repository view, captions,
 * progress). For each output frame we only change two things: the transform of
 * the inner `.document` (the scroll) and the caption text. The stage, card,
 * border, shadow, browser bar, caption box and progress bar are static, which
 * is exactly the required composition.
 *
 * Frames are piped straight into FFmpeg, so no intermediate frame files are
 * written to disk.
 */

export type CaptureResult = {
  anchors: MeasuredAnchor[];
  documentHeight: number;
  viewportHeight: number;
  geometry: {
    stage: { width: number; height: number };
    card: { left: number; top: number; width: number; height: number };
  };
  /** Debug frames written for visual inspection. */
  referenceFrames: string[];
};

export type RenderCardOptions = {
  repo: EnrichedRepo;
  captions: CaptionPhrase[];
  scrollKeyframes: ScrollKeyframe[];
  durationMs: number;
  outputPath: string;
  audioPath: string;
  workDir: string;
  fps?: number;
  crf?: number;
  preset?: string;
  /** Also render five stills at 0/25/50/75/100% for visual inspection. */
  writeReferenceFrames?: boolean;
  onProgress?: (frame: number, totalFrames: number) => void;
};

type Client = {
  Page: any;
  Runtime: any;
  Emulation: any;
  close(): Promise<void>;
};

async function openClient(): Promise<{ client: Client; targetId: string }> {
  const endpoint = new URL(CHROME_DEBUG_URL);
  const host = endpoint.hostname;
  const port = Number(endpoint.port || 9222);
  const target = await CDP.New({ host, port });
  const client = (await CDP({ target: target.id, host, port })) as Client;
  return { client, targetId: target.id };
}

async function closeClient(targetId: string): Promise<void> {
  try {
    await CDP.Close({ id: targetId, host: new URL(CHROME_DEBUG_URL).hostname, port: Number(new URL(CHROME_DEBUG_URL).port || 9222) });
  } catch {
    /* the target may already be gone */
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function evaluate(client: Client, expression: string): Promise<any> {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(
      `Browser evaluation failed: ${result.exceptionDetails.text ?? "unknown error"}`
    );
  }
  return result?.result?.value;
}

/* ------------------------------------------------------------------ */
/* Measurement-only pass                                               */
/* ------------------------------------------------------------------ */

/**
 * Render the card once, measure the real section offsets and card geometry,
 * then close the page. Called before the timeline is built so scroll targets
 * come from the rendered document.
 */
export async function measureCard(repo: EnrichedRepo): Promise<CaptureResult> {
  const html = buildCardHtml(repo);
  const { client, targetId } = await openClient();
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.Page.setDocumentContent({
      frameId: (await client.Page.getFrameTree()).frameTree.frame.id,
      html,
    });
    await sleep(350);
    const measured = await evaluate(client, "window.__showcase.measure()");
    const geometry = await evaluate(client, "window.__showcase.geometry()");
    return {
      anchors: measuredAnchors(measured.anchors),
      documentHeight: measured.documentHeight,
      viewportHeight: measured.viewportHeight,
      geometry,
      referenceFrames: [],
    };
  } finally {
    await client.close().catch(() => undefined);
    await closeClient(targetId);
  }
}

/* ------------------------------------------------------------------ */
/* Frame render                                                        */
/* ------------------------------------------------------------------ */

function buildFfmpegArgs(options: {
  fps: number;
  outputPath: string;
  audioPath: string;
  durationSeconds: number;
  crf: number;
  preset: string;
}): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "image2pipe",
    "-framerate", String(options.fps),
    "-i", "pipe:0",
    "-i", options.audioPath,
    "-map", "0:v",
    "-map", "1:a",
    // Chromium hands us full-range JPEG; force limited-range BT.709 output so
    // the MP4 is tagged yuv420p rather than the deprecated yuvj420p.
    "-vf", "scale=out_range=tv,format=yuv420p",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-c:v", "libx264",
    "-preset", options.preset,
    "-crf", String(options.crf),
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.0",
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

export async function renderCardVideo(options: RenderCardOptions): Promise<CaptureResult> {
  const fps = options.fps ?? FPS;
  const durationSeconds = Math.min(MAX_DURATION_SECONDS, options.durationMs / 1000);
  const totalFrames = Math.max(1, Math.round(durationSeconds * fps));
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.mkdir(options.workDir, { recursive: true });

  const html = buildCardHtml(options.repo);
  const { client, targetId } = await openClient();

  const ffmpeg: ChildProcessWithoutNullStreams = spawn(
    "ffmpeg",
    buildFfmpegArgs({
      fps,
      outputPath: options.outputPath,
      audioPath: options.audioPath,
      durationSeconds,
      crf: options.crf ?? 19,
      preset: options.preset ?? "medium",
    }),
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );

  let ffmpegStderr = "";
  ffmpeg.stderr.on("data", chunk => {
    ffmpegStderr += String(chunk);
    if (ffmpegStderr.length > 20000) ffmpegStderr = ffmpegStderr.slice(-20000);
  });
  ffmpeg.on("error", error => {
    ffmpegStderr += `\nspawn error: ${String(error)}`;
  });

  const referenceFrames: string[] = [];
  const referenceDir = path.join(options.workDir, "visual");
  if (options.writeReferenceFrames !== false) {
    await fs.mkdir(referenceDir, { recursive: true });
  }

  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.Page.setDocumentContent({
      frameId: (await client.Page.getFrameTree()).frameTree.frame.id,
      html,
    });
    // Let the fonts and layout settle before measuring or capturing.
    await sleep(400);

    const measured = await evaluate(client, "window.__showcase.measure()");
    const geometry = await evaluate(client, "window.__showcase.geometry()");
    const bounds = scrollBounds(measured.documentHeight, measured.viewportHeight);

    const referenceStops = [0, 0.25, 0.5, 0.75, 1];

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const timeMs = (frame / fps) * 1000;
      const scrollY = scrollAt(options.scrollKeyframes, timeMs);
      const caption = captionFor(options.captions, timeMs);

      await evaluate(
        client,
        `(() => {
          window.__showcase.setScroll(${scrollY.toFixed(2)});
          window.__showcase.setCaption(${JSON.stringify(caption ? captionHtml(caption) : "")});
          window.__showcase.setProgress(${(timeMs / Math.max(1, options.durationMs)).toFixed(5)}, ${timeMs.toFixed(1)}, ${options.durationMs.toFixed(1)});
          return 1;
        })()`
      );

      const shot = await client.Page.captureScreenshot({
        format: "jpeg",
        quality: 96,
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      const buffer = Buffer.from(shot.data, "base64");

      if (options.writeReferenceFrames !== false) {
        const stopIndex = referenceStops.findIndex(
          stop => Math.abs(timeMs / options.durationMs - stop) < 1 / (fps * 2)
        );
        if (stopIndex >= 0) {
          const file = path.join(referenceDir, `reference-${Math.round(stopIndex * 25)}pct.jpg`);
          await fs.writeFile(file, buffer);
          referenceFrames.push(file);
        }
      }

      if (!ffmpeg.stdin.write(buffer)) {
        await once(ffmpeg.stdin, "drain");
      }

      options.onProgress?.(frame + 1, totalFrames);
    }

    ffmpeg.stdin.end();
    const [code] = (await once(ffmpeg, "close")) as [number | null];
    if (code !== 0) {
      throw new Error(`FFmpeg exited with code ${code}\n${ffmpegStderr.slice(-2000)}`);
    }

    return {
      anchors: measuredAnchors(measured.anchors),
      documentHeight: measured.documentHeight,
      viewportHeight: measured.viewportHeight,
      geometry,
      referenceFrames,
    };
  } catch (error) {
    ffmpeg.stdin.destroy();
    ffmpeg.kill();
    const detail = await fs
      .writeFile(path.join(options.workDir, "ffmpeg-stderr.log"), ffmpegStderr, "utf8")
      .catch(() => undefined);
    void detail;
    throw new Error(
      `Card render failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await client.close().catch(() => undefined);
    await closeClient(targetId);
  }
}

function captionFor(
  captions: CaptionPhrase[],
  timeMs: number
): CaptionPhrase | null {
  for (const caption of captions) {
    if (timeMs >= caption.startMs && timeMs < caption.endMs) return caption;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Legacy capture of the live GitHub page                              */
/*                                                                     */
/* Kept for `--live-page` debugging only. The showcase card is built from */
/* repository data, not from a screenshot of github.com.                */
/* ------------------------------------------------------------------ */

export async function captureLivePage(
  url: string,
  outputDir: string
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const { client, targetId } = await openClient();
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.Page.navigate({ url });
    await client.Page.loadEventFired();
    await sleep(2500);
    const shot = await client.Page.captureScreenshot({
      format: "jpeg",
      quality: 92,
      fromSurface: true,
    });
    const file = path.join(outputDir, "live-page.jpg");
    await fs.writeFile(file, Buffer.from(shot.data, "base64"));
    return file;
  } finally {
    await client.close().catch(() => undefined);
    await closeClient(targetId);
  }
}

export { CARD_VIEWPORT_HEIGHT };