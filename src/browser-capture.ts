const SHOWCASE_CAPTURE_PROF = process.env.SHOWCASE_CAPTURE_PROF === "1";

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { FPS, MASCOT_LAYOUT, MAX_DURATION_SECONDS, VIEWPORT } from "./config.js";
import type {
  CalloutCue,
  CaptionPhrase,
  CharacterCue,
  EnrichedRepo,
  ImpactBurstCue,
  MeasuredAnchor,
  ScrollKeyframe,
  SpeechEnvelope,
} from "./types.js";
import {
  buildCardHtml,
  CARD_VIEWPORT_HEIGHT,
  type CardComposition,
  type CharacterPoseAsset,
} from "./card.js";
import { captionFrameHtml, wordTimings } from "./caption-overlay.js";
import { calloutCueAt, calloutStateAt } from "./callout-overlay.js";
import {
  characterCueAt,
  characterPoseAt,
  speechLevelAt,
} from "./character-motion.js";
import {
  CHARACTER_ALPHA_BOUNDS,
  getMascotFrameGeometry,
  mascotPlacementCss,
} from "./mascot-layout.js";
import { evaluateImpactBurstsAt } from "./impact-accents.js";
import { scrollAt } from "./timeline.js";
import {
  closeTarget,
  evaluate,
  frameId,
  openTarget,
  setViewport,
  sleep,
  type CdpClient,
} from "./cdp.js";

/**
 * Chromium capture + FFmpeg encode.
 *
 * The card is rendered as real DOM: stage, card, one tall page screenshot,
 * caption overlay and an optional character layer. For each output frame only
 * three things change: the transform of `.document`, the caption HTML and the
 * character transform. The stage, card, border, shadow and browser bar are
 * static, which is exactly the required composition. There is no progress UI.
 *
 * Frames are piped straight into FFmpeg, so no intermediate frame files are
 * written to disk.
 */

export type CaptureGeometry = {
  stage: { width: number; height: number };
  card: { left: number; top: number; width: number; height: number };
  caption?: { left: number; top: number; width: number; height: number };
  /** The dark caption panel, present only while a phrase is on screen. */
  captionPanel?: { left: number; top: number; width: number; height: number } | null;
  /** The callout bubble's authored box (present even while hidden). */
  callout?: { left: number; top: number; width: number; height: number };
  character?: { left: number; top: number; width: number; height: number } | null;
  hasProgress?: boolean;
};

export type CaptureResult = {
  anchors: MeasuredAnchor[];
  documentHeight: number;
  viewportHeight: number;
  geometry: CaptureGeometry;
  /** Debug frames written for visual inspection. */
  referenceFrames: string[];
};

export type RenderCardOptions = {
  repo: EnrichedRepo;
  /** Loopback URL of the tall mobile screenshot. Primary visual mode. */
  pageImageUrl?: string | null;
  /** Loopback URL of the transparent character cut-out. */
  characterUrl?: string | null;
  /** Optional named presenter poses (present/point/close). */
  characterPoses?: CharacterPoseAsset[] | null;
  /** Presenter action/framing changes, aligned to narration segments. */
  characterCues?: CharacterCue[] | null;
  captions: CaptionPhrase[];
  /** Narration-driven callout bubble cues. */
  callouts?: CalloutCue[] | null;
  /** Animated comic impact bursts around the mascot. */
  impactBursts?: ImpactBurstCue[] | null;
  /** Loopback URL of the comic speech bubble sticker. */
  calloutImageUrl?: string | null;
  scrollKeyframes: ScrollKeyframe[];
  durationMs: number;
  outputPath: string;
  audioPath: string;
  workDir: string;
  /** 0..1 speech amplitude per low-rate sample; drives the character pose. */
  speechEnvelope?: SpeechEnvelope | null;
  fps?: number;
  crf?: number;
  preset?: string;
  /** Also render five stills at 0/25/50/75/100% for visual inspection. */
  writeReferenceFrames?: boolean;
  onProgress?: (frame: number, totalFrames: number) => void;
};

/* ------------------------------------------------------------------ */
/* Page setup                                                          */
/* ------------------------------------------------------------------ */

function asComposition(input: EnrichedRepo | CardComposition): CardComposition {
  return "repo" in input ? input : { repo: input };
}

async function loadCardPage(
  client: CdpClient,
  composition: CardComposition
): Promise<void> {
  await client.Page.enable();
  await client.Runtime.enable();
  await setViewport(client, {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.Page.setDocumentContent({
    frameId: await frameId(client),
    html: buildCardHtml(composition),
  });
  // Wait for fonts and the tall screenshot. The in-page hook resolves on
  // load/error and always times out, so a broken asset cannot hang the render.
  await evaluate(client, "window.__showcase.ready(8000)");
  await sleep(120);
}

/* ------------------------------------------------------------------ */
/* Measurement-only pass                                               */
/* ------------------------------------------------------------------ */

/**
 * Render the card once, measure the real content height and card geometry,
 * then close the page. In primary mode the story anchors come from the mobile
 * capture; this pass verifies what Chromium actually laid out.
 */
export async function measureCard(
  input: EnrichedRepo | CardComposition
): Promise<CaptureResult> {
  const composition = asComposition(input);
  const { client, targetId } = await openTarget();
  try {
    await loadCardPage(client, composition);
    const measured = await evaluate(client, "window.__showcase.measure()");
    const geometry = (await evaluate(client, "window.__showcase.geometry()")) as CaptureGeometry;
    return {
      anchors: [],
      documentHeight: measured.documentHeight,
      viewportHeight: measured.viewportHeight,
      geometry,
      referenceFrames: [],
    };
  } finally {
    await client.close().catch(() => undefined);
    await closeTarget(targetId);
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
  let profEvalMs = 0;
  let profShotMs = 0;
  let profFrames = 0;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.mkdir(options.workDir, { recursive: true });

  const composition: CardComposition = {
    repo: options.repo,
    pageImageUrl: options.pageImageUrl ?? null,
    characterUrl: options.characterUrl ?? null,
    characterPoses: options.characterPoses ?? null,
    calloutImageUrl: options.calloutImageUrl ?? null,
  };
  const { client, targetId } = await openTarget();

  const ffmpeg = spawn(
    "ffmpeg",
    buildFfmpegArgs({
      fps,
      outputPath: options.outputPath,
      audioPath: options.audioPath,
      durationSeconds,
      crf: options.crf ?? 19,
      preset: options.preset ?? "medium",
    }),
    { stdio: ["pipe", "ignore", "pipe"], windowsHide: true }
  );

  let ffmpegStderr = "";
  ffmpeg.stdin.on("error", () => {
    // Prevent unhandled EPIPE if FFmpeg closes before all frames are written
  });
  ffmpeg.stderr.on("data", chunk => {
    ffmpegStderr += String(chunk);
    if (ffmpegStderr.length > 20000) ffmpegStderr = ffmpegStderr.slice(-20000);
  });
  ffmpeg.on("error", error => {
    ffmpegStderr += `\nspawn error: ${String(error)}`;
  });

  const referenceFrames: string[] = [];
  const referenceDir = path.join(options.workDir, "visual");
  const writeReferences = options.writeReferenceFrames !== false;
  if (writeReferences) await fs.mkdir(referenceDir, { recursive: true });

  // Precompute which frame belongs to each 0/25/50/75/100% stop. Computing the
  // set up front avoids the old float-comparison bug that skipped the 100%
  // frame on odd frame counts.
  const referenceIndices = new Map<number, number>();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const frame = Math.min(totalFrames - 1, Math.round(fraction * (totalFrames - 1)));
    if (!referenceIndices.has(frame)) referenceIndices.set(frame, Math.round(fraction * 100));
  }

  try {
    await loadCardPage(client, composition);
    const measured = await evaluate(client, "window.__showcase.measure()");
    const geometry = (await evaluate(client, "window.__showcase.geometry()")) as CaptureGeometry;

    const mascotWidthPx = Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width);
    const placementInput = {
      bounds: CHARACTER_ALPHA_BOUNDS,
      renderedWidthPx: mascotWidthPx,
      canvasWidth: VIEWPORT.width,
      canvasHeight: VIEWPORT.height,
      clipRightPx: MASCOT_LAYOUT.offsetX,
      clipBottomPx: MASCOT_LAYOUT.offsetY,
    };
    const mascotPlacement = mascotPlacementCss(placementInput);

  // Per-frame state is a pure function of timeMs, so frames can be rendered
  // out of order on separate CDP tabs in the same debuggable Chrome, then
  // written to FFmpeg in order (SHOWCASE_CAPTURE_WORKERS, default 3).
  const frameParams = (frame: number) => {
    const timeMs = Math.min(options.durationMs, (frame / fps) * 1000);
    const scrollY = scrollAt(options.scrollKeyframes, timeMs);
    const caption = captionFor(options.captions, timeMs);
    const calloutCue = calloutCueAt(options.callouts ?? [], timeMs);
    const calloutState = calloutStateAt(calloutCue, timeMs);
    const poseName = characterCueAt(options.characterCues ?? [], timeMs);
    const pose = characterPoseAt(
      timeMs,
      speechLevelAt(options.speechEnvelope ?? null, timeMs),
      poseName
    );
    const frameGeo = getMascotFrameGeometry(placementInput, mascotPlacement, pose);
    const activeImpacts = evaluateImpactBurstsAt(
      options.impactBursts ?? [],
      timeMs,
      frameGeo.impactAnchors
    );

    let activeIndex = -1;
    let highlightProgress = 0;
    if (caption) {
      const timings = wordTimings(caption);
      const active = timings.find(t => timeMs >= t.startMs && timeMs < t.endMs);
      if (active) {
        activeIndex = timings.indexOf(active);
        const elapsed = timeMs - active.startMs;
        highlightProgress = Math.max(0, Math.min(1, elapsed / 70));
      }
    }
    return { timeMs, scrollY, caption, calloutState, poseName, pose, activeImpacts, activeIndex, highlightProgress };
  };

  const evalExpr = (p: ReturnType<typeof frameParams>) =>
    `(() => {
      window.__showcase.setScroll(${p.scrollY.toFixed(2)});
      window.__showcase.setCaption(${JSON.stringify(captionFrameHtml(p.caption, p.timeMs))});
      window.__showcase.measureCaption();
      window.__showcase.setCaptionActive(${p.activeIndex}, ${p.highlightProgress.toFixed(4)});
      window.__showcase.setCallout(${JSON.stringify(p.calloutState.cueId)}, ${JSON.stringify(p.calloutState.text)}, ${p.calloutState.opacity}, ${p.calloutState.translateY}, ${p.calloutState.scale}, ${p.calloutState.raysOpacity});
      window.__showcase.setImpactState(${JSON.stringify(p.activeImpacts)});
      window.__showcase.setCharacterPose(${JSON.stringify(p.pose)}, ${JSON.stringify(p.poseName)});
      return 1;
    })()`;

  // Pending frames are bounded so workers can run at most ~16 frames ahead.
  const pending = new Map<number, Buffer>();
  const shardErrors: unknown[] = [];
  let aborted = false;
  let writeCursor = 0;

  // Track FFmpeg stdin backpressure with a persistent listener + a flag.
  // The old pattern (once(stdin, "drain") after every write) could miss the
  // event and hang the pump forever — the bug that froze Stage 6.
  let stdinFull = false;
  ffmpeg.stdin.on("drain", () => { stdinFull = false; });

  const captureShard = async (worker: CdpClient, start: number, end: number) => {
    try {
      for (let frame = start; frame < end; frame += 1) {
        if (aborted) return;
        const p = frameParams(frame);
        const tEval = SHOWCASE_CAPTURE_PROF ? Date.now() : 0;
        await evaluate(worker, evalExpr(p));
        const tShot = SHOWCASE_CAPTURE_PROF ? Date.now() : 0;
        let shotTimer: ReturnType<typeof setTimeout> | undefined;
        const shot = await Promise.race([
          worker.Page.captureScreenshot({
            format: "jpeg",
            quality: 85,
            fromSurface: true,
            captureBeyondViewport: false,
            optimizeForSpeed: true,
          }),
          new Promise<never>((_, reject) => {
            shotTimer = setTimeout(() => reject(new Error("CDP Page.captureScreenshot timed out after 30s — the browser likely crashed or is out of memory.")), 30_000);
          }),
        ]);
        if (shotTimer) clearTimeout(shotTimer);
        const buffer = Buffer.from(shot.data, "base64");
        if (SHOWCASE_CAPTURE_PROF) {
          profEvalMs += tShot - tEval;
          profShotMs += Date.now() - tShot;
          profFrames += 1;
        }
        while (pending.size >= 16 && !aborted) await sleep(4);
        pending.set(frame, buffer);
      }
    } catch (error) {
      shardErrors.push(error);
      aborted = true;
    }
  };

  let pumpError: unknown = null;
  const pump = (async () => {
    try {
    while (writeCursor < totalFrames && !aborted) {
      const buffer = pending.get(writeCursor);
      if (!buffer) { await sleep(4); continue; }
      pending.delete(writeCursor);
      const frame = writeCursor;
      const percent = referenceIndices.get(frame);
      if (writeReferences && percent !== undefined) {
        const file = path.join(referenceDir, `reference-${percent}pct.jpg`);
        await fs.writeFile(file, buffer);
        referenceFrames.push(file);
      }
      while (stdinFull) await sleep(2);
      if (!ffmpeg.stdin.write(buffer)) {
        stdinFull = true;
      }
      options.onProgress?.(frame + 1, totalFrames);
      writeCursor += 1;
    }
    } catch (error) {
      pumpError = error;
      aborted = true;
    }
  })();

  // Parallel tabs re-render the same blur-heavy page per tab, which multiplies
  // memory. This machine starves below ~1 GB free RAM, so default to serial;
  // opt in with SHOWCASE_CAPTURE_WORKERS=2|3|4 on a roomier machine.
  const workers = Math.max(1, Math.min(4, Number(process.env.SHOWCASE_CAPTURE_WORKERS ?? "1") || 1, totalFrames));
  const workerPromises: Promise<void>[] = [];
  const shardEdges = (i: number) => [
    Math.floor((totalFrames * i) / workers),
    Math.floor((totalFrames * (i + 1)) / workers),
  ];
  // Shard 0 reuses the primary tab; the rest get fresh tabs in the same Chrome.
  const extraTabs = await Promise.all(
    Array.from({ length: Math.max(0, workers - 1) }, () => openTarget())
  );
  const workerClients = [{ client, targetId }, ...extraTabs];
  for (const tab of extraTabs) {
    await loadCardPage(tab.client, composition);
  }
  for (let i = 0; i < workers; i += 1) {
    const [start, end] = shardEdges(i);
    workerPromises.push(captureShard(workerClients[i].client, start, end));
  }
  await Promise.all(workerPromises);
  if (pumpError) {
    aborted = true;
    throw pumpError instanceof Error ? pumpError : new Error(String(pumpError));
  }
  if (shardErrors.length > 0) {
    aborted = true;
    await pump.catch(() => {});
    throw shardErrors[0] instanceof Error ? shardErrors[0] : new Error(String(shardErrors[0]));
  }
  await pump;
  await Promise.all(
    extraTabs.map(tab => tab.client.close().catch(() => {}).then(() => closeTarget(tab.targetId).catch(() => {})))
  );

    ffmpeg.stdin.end();
    const [code] = (await once(ffmpeg, "close")) as [number | null];
    if (code !== 0) {
      throw new Error(`FFmpeg exited with code ${code}\n${ffmpegStderr.slice(-2000)}`);
    }
    if (SHOWCASE_CAPTURE_PROF) {
      console.log(
        `[capture-prof] frames=${profFrames} ` +
        `evaluate=${profEvalMs}ms (${(profEvalMs / Math.max(1, profFrames)).toFixed(1)}ms/frame) ` +
        `screenshot=${profShotMs}ms (${(profShotMs / Math.max(1, profFrames)).toFixed(1)}ms/frame)`
      );
    }

    return {
      anchors: [],
      documentHeight: measured.documentHeight,
      viewportHeight: measured.viewportHeight,
      geometry,
      referenceFrames,
    };
  } catch (error) {
    ffmpeg.stdin.destroy();
    ffmpeg.kill();
    await fs
      .writeFile(path.join(options.workDir, "ffmpeg-stderr.log"), ffmpegStderr, "utf8")
      .catch(() => undefined);
    throw new Error(
      `Card render failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await client.close().catch(() => undefined);
    await closeTarget(targetId);
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
/* Legacy capture of the live GitHub page (debugging only)             */
/* ------------------------------------------------------------------ */

export async function captureLivePage(
  url: string,
  outputDir: string
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const { client, targetId } = await openTarget();
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await setViewport(client, {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
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
    await closeTarget(targetId);
  }
}

export { CARD_VIEWPORT_HEIGHT };
