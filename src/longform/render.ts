/**
 * Long-form renderer — hybrid compositor.
 *
 * Strategy (benchmarked, see docs/longform/renderer-benchmark.md):
 *   - Authentic capture files stay static; camera motion = per-frame
 *     crop/scale expressions, not Chromium screenshots.
 *   - Each scene renders to its own bounded segment MP4 (video-only);
 *     completed & unchanged segments are reused across failed runs
 *     (content-hash check).
 *   - Highlights attach to the STATIC end-state of the camera move
 *     (they appear after the push-in settles — by design).
 *   - Segments are joined with the concat demuxer and muxed once with the
 *     pre-mixed episode audio. Peak memory stays independent of episode length.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "canvas";
import { LONGFORM, TOKENS } from "./config.js";
import { buildCameraCropExpr, cropWindow, sampleCamera, type CameraKey } from "./camera.js";

const execFileAsync = promisify(execFile);

export type RenderedSegment = { path: string; frames: number; reused: boolean };

/* ------------------------------------------------------------------ */
/* Overlay asset generation (transparent PNGs)                         */
/* ------------------------------------------------------------------ */

export async function ensureDarkBackground(file: string, width = LONGFORM.width, height = LONGFORM.height): Promise<string> {
  if (fsSync.existsSync(file)) return file;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, TOKENS.background);
  g.addColorStop(0.55, TOKENS.panelSecondary);
  g.addColorStop(1, "#17283A");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  const radial = ctx.createRadialGradient(width / 2, height / 2, height * 0.35, width / 2, height / 2, width * 0.72);
  radial.addColorStop(0, "rgba(0,0,0,0)");
  radial.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, width, height);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canvas.toBuffer("image/png"));
  return file;
}

/** Blurred capture for the opening/reveal background (generated via FFmpeg gblur). */
export async function makeBlurredCaptureBackground(
  overviewImage: string,
  outFile: string,
  sourceRegion: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 1920, height: 1400 }
): Promise<string> {
  if (fsSync.existsSync(outFile)) return outFile;
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", overviewImage,
    "-vf",
    `crop=${Math.max(2, Math.round(sourceRegion.width))}:${Math.max(2, Math.round(sourceRegion.height))}:${Math.round(
      sourceRegion.x
    )}:${Math.round(sourceRegion.y)},scale=1920:1080:flags=lanczos,gblur=sigma=16,drawbox=c=black@0.66:t=fill`,
    "-frames:v", "1",
    outFile,
  ]);
  return outFile;
}

/** Rounded-rectangle highlight overlay (translucent blue + thin border). */
export async function ensureHighlightPng(
  file: string,
  widthPx: number,
  heightPx: number,
  radius = 10
): Promise<string> {
  const w = Math.max(24, Math.round(widthPx));
  const h = Math.max(24, Math.round(heightPx));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(99, 184, 242, 0.20)";
  ctx.strokeStyle = "rgba(99, 184, 242, 0.95)";
  ctx.lineWidth = 3;
  const r = Math.min(radius, w / 4, h / 4);
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, r);
  ctx.fill();
  ctx.stroke();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canvas.toBuffer("image/png"));
  return file;
}

/** Rounded dark callout pill with accent bar and supporting text. */
export async function ensureCalloutPng(
  file: string,
  text: string,
  widthPx = 560
): Promise<{ file: string; width: number; height: number }> {
  const heightPx = 84;
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = "rgba(16, 23, 34, 0.92)";
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 2;
  const r = 16;
  ctx.beginPath();
  ctx.roundRect(1, 1, widthPx - 2, heightPx - 2, r);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#63B8F2";
  ctx.beginPath();
  ctx.roundRect(1, 18, 6, heightPx - 36, 3);
  ctx.fill();
  ctx.fillStyle = "#F5F7FA";
  ctx.font = "700 26px Inter, Roboto, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text.slice(0, 44), 26, heightPx / 2 + 1);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canvas.toBuffer("image/png"));
  return { file, width: widthPx, height: heightPx };
}

/** Full-frame transparent PNG for episode titles (name reveal / opening hook / closing brand). */
export async function ensureTitlePng(
  file: string,
  text: string,
  subText: string | null,
  options: { x?: number; nameFontSize?: number } = {}
): Promise<{ file: string; width: number; height: number }> {
  const width = LONGFORM.width;
  const height = LONGFORM.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const x = options.x ?? 100;
  const nameFontSize = options.nameFontSize ?? (text.length > 26 ? 92 : text.length > 18 ? 116 : 148);
  ctx.fillStyle = TOKENS.textPrimary;
  ctx.font = `900 ${nameFontSize}px Inter, Roboto, sans-serif`;
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 4;
  const y = subText ? height / 2 - 20 : height / 2;
  ctx.fillText(text, x, y);
  if (subText) {
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = TOKENS.textSupporting;
    ctx.font = "700 30px Inter, Roboto, sans-serif";
    ctx.fillText(subText.toUpperCase(), x, y + 96);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canvas.toBuffer("image/png"));
  return { file, width, height };
}

/* ------------------------------------------------------------------ */
/* Per-scene filter graph                                               */
/* ------------------------------------------------------------------ */

export type OverlayInput = { label: string; index: number; file: string };

export function buildSceneFilterGraph(input: {
  type: string;
  startMs: number;
  endMs: number;
  viewRect: { x: number; y: number; width: number; height: number } | null;
  cameraKeys: CameraKey[];
  inputImageDims: { width: number; height: number } | null;
  highlights: Array<{ pngLabel: string; x: number; y: number; startMs: number; endMs: number }>;
  overlayInputs: OverlayInput[];
  mascot: { label: string; position: "bottom-right" | "bottom-left" | "right-middle" | "left-middle"; startMs: number; endMs: number; heightPx: number; slideIn: boolean } | null;
  callout: { label: string; startMs: number; endMs: number } | null;
  title: { label: string; appearAtMs: number; disappearAtMs: number } | null;
  subtitlesFilter: string | null;
}): string {
  const parts: string[] = [];
  const totalSec = (input.endMs - input.startMs) / 1000;
  const byLabel = new Map(input.overlayInputs.map(o => [o.label, o]));
  const o = (label: string) => byLabel.get(label)!;

  /* --- Base layer --- */
  if (input.viewRect && input.cameraKeys.length > 0 && input.inputImageDims) {
    const S = Math.max(1, 1400 / input.inputImageDims.height);
    const scaledW = Math.ceil(input.inputImageDims.width * S);
    const scaledH = Math.ceil(input.inputImageDims.height * S);
    if (S > 1) {
      parts.push(`[0:v]scale=${scaledW}:${scaledH}:flags=lanczos[base]`);
    } else {
      parts.push(`[0:v]copy[base]`);
    }
    const vr = {
      x: Math.round(input.viewRect.x * S),
      y: Math.round(input.viewRect.y * S),
      width: Math.round(input.viewRect.width * S),
      height: Math.round(input.viewRect.height * S),
    };
    parts.push(`[base]crop=w=${vr.width}:h=${vr.height}:x=${vr.x}:y=${vr.y}[inset]`);
    // Camera keys: absolute coords → viewRect-relative coords.
    const rel = input.cameraKeys.map(k => ({
      ...k,
      focusX: k.focusX * S - vr.x,
      focusY: k.focusY * S - vr.y,
    }));
    const crop = buildCameraCropExpr(rel, vr.width, vr.height, input.startMs, "easeInOut");
    parts.push(`[inset]crop=w='${crop.w}':h='${crop.h}':x='${crop.x}':y='${crop.y}',scale=1920:1080:flags=lanczos[cam]`);
    parts.push(`[cam]setsar=1[vbase]`);
  } else {
    parts.push(`[0:v]scale=1920:1080:flags=lanczos,setsar=1[vbase]`);
  }

  let current = "vbase";

  /* --- Title --- */
  if (input.title) {
    const t0 = Math.max(0, (input.title.appearAtMs - input.startMs) / 1000);
    const t1 = Math.max(t0 + 0.5, (input.title.disappearAtMs - input.startMs) / 1000);
    const fadeIn = Math.min(0.45, t1 - t0);
    parts.push(`[${o(input.title.label).index}:v]format=rgba,fade=t=in:st=${t0.toFixed(3)}:d=${fadeIn.toFixed(3)}:alpha=1[titlefx]`);
    parts.push(`[${current}][titlefx]overlay=0:0:enable='between(t,${t0.toFixed(3)},${t1.toFixed(3)})'[vtitle]`);
    current = "vtitle";
  }

  /* --- Highlights --- */
  input.highlights.forEach((h, i) => {
    const s = Math.max(0, (h.startMs - input.startMs) / 1000);
    const e = Math.max(s + 0.4, (h.endMs - input.startMs) / 1000);
    parts.push(`[${o(h.pngLabel).index}:v]format=rgba,fade=t=in:st=${s.toFixed(3)}:d=0.18:alpha=1[hl${i}fx]`);
    parts.push(`[${current}][hl${i}fx]overlay=${Math.round(h.x)}:${Math.round(h.y)}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'[vhl${i}]`);
    current = `vhl${i}`;
  });

  /* --- Callout pill --- */
  if (input.callout) {
    const s = Math.max(0, (input.callout.startMs - input.startMs) / 1000);
    const e = Math.max(s + 0.4, (input.callout.endMs - input.startMs) / 1000);
    parts.push(`[${o(input.callout.label).index}:v]format=rgba,fade=t=in:st=${s.toFixed(3)}:d=0.22:alpha=1,fade=t=out:st=${Math.max(0, e - 0.18).toFixed(3)}:d=0.18:alpha=1[calloutfx]`);
    parts.push(`[${current}][calloutfx]overlay=100:648:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'[vcallout]`);
    current = "vcallout";
  }

  /* --- Mascot --- */
  if (input.mascot) {
    const s = Math.max(0, (input.mascot.startMs - input.startMs) / 1000);
    const e = Math.max(s + 0.3, (input.mascot.endMs - input.startMs) / 1000);
    const W = LONGFORM.width;
    const H = LONGFORM.height;
    const margin = 64;
    if (input.mascot.slideIn) {
      // Escort entrance: slide from off-screen right into the right third.
      const xEnd = W - 530;
      parts.push(`[${o(input.mascot.label).index}:v]format=rgba,scale=-1:${input.mascot.heightPx}[mascotsc]`);
      parts.push(
        `[${current}][mascotsc]overlay=x='max(${xEnd},${W + 60}-(${W + 60 - xEnd})*min(1,max(0,(t-${s.toFixed(3)})/0.42)))':y='H-h-24':enable='between(t,${s.toFixed(3)},${totalSec.toFixed(3)})'[vmasc]`
      );
    } else {
      let x = W - Math.round(input.mascot.heightPx * 0.84) - margin;
      let y = H - input.mascot.heightPx - 24;
      if (input.mascot.position === "bottom-left") x = margin;
      if (input.mascot.position === "right-middle") y = Math.round(H * 0.38);
      if (input.mascot.position === "left-middle") { x = margin; y = Math.round(H * 0.38); }
      parts.push(`[${o(input.mascot.label).index}:v]format=rgba,scale=-1:${input.mascot.heightPx},fade=t=in:st=${s.toFixed(3)}:d=0.3:alpha=1,fade=t=out:st=${Math.max(0, e - 0.3).toFixed(3)}:d=0.3:alpha=1[mascotsc]`);
      parts.push(`[${current}][mascotsc]overlay=${x}:${y}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'[vmasc]`);
    }
    current = "vmasc";
  }

  /* --- Closing fade to black --- */
  if (input.type === "closing") {
    parts.push(`[${current}]fade=t=out:st=${Math.max(0, totalSec - 1.15).toFixed(3)}:d=1.15[vfade]`);
    current = "vfade";
  }

  /* --- Subtitles burn (always last) --- */
  if (input.subtitlesFilter) {
    parts.push(`[${current}]${input.subtitlesFilter}[vsub]`);
    current = "vsub";
  }

  parts.push(`[${current}]setsar=1,format=yuv420p[vout]`);
  return parts.join(";");
}

/* ------------------------------------------------------------------ */
/* Segment driver                                                       */
/* ------------------------------------------------------------------ */

const fileSha = async (file: string): Promise<string> =>
  createHash("sha256").update(await fs.readFile(file)).digest("hex").slice(0, 16);

export async function renderSegment(options: {
  scene: {
    id: string;
    type: string;
    startMs: number;
    endMs: number;
    viewRect: { x: number; y: number; width: number; height: number } | null;
    cameraKeys: CameraKey[];
    highlights: Array<{ x: number; y: number; width: number; height: number; startMs: number; endMs: number }>;
    mascot: { asset: "escort" | "point" | "present"; position: "bottom-right" | "bottom-left" | "right-middle" | "left-middle"; startMs: number; endMs: number; heightPx: number } | null;
    callout: { text: string; startMs: number; endMs: number } | null;
    titlePng: string | null;
    titleAppearAtMs: number;
    titleDisappearAtMs: number;
  };
  index: number;
  backgroundImage: string;
  captureImage: string | null;
  captureDims: { width: number; height: number } | null;
  captionsAss: string | null;
  fontsdir: string;
  outDir: string;
  mascotFiles: { escort: string; point: string; present: string };
  onLog?: (line: string) => void;
}): Promise<RenderedSegment> {
  const log = options.onLog ?? (() => {});
  const scene = options.scene;
  const outPath = path.join(options.outDir, `segment-${String(options.index + 1).padStart(3, "0")}.mp4`);
  const totalFrames = Math.max(1, Math.round(((scene.endMs - scene.startMs) / 1000) * LONGFORM.fps));

  await fs.mkdir(path.join(options.outDir, "overlays"), { recursive: true });

  const inputs: string[] = [];
  const baseFile = options.captureImage ?? options.backgroundImage;
  inputs.push("-loop", "1", "-framerate", String(LONGFORM.fps), "-i", baseFile);
  const addInput = (file: string) => inputs.push("-loop", "1", "-framerate", String(LONGFORM.fps), "-i", file);

  const overlayInputs: OverlayInput[] = [];
  let nextIndex = 1;
  const addOverlay = (label: string, file: string): OverlayInput => {
    const item = { label, index: nextIndex++, file };
    overlayInputs.push(item);
    addInput(file);
    return item;
  };

  const title = scene.titlePng ? addOverlay("title", scene.titlePng) : null;
  const highlights: Array<OverlayInput & { x: number; y: number; startMs: number; endMs: number }> = [];

  // Pre-scale + viewRect math needed to place highlights at the camera's static end-state.
  const S = options.captureDims ? Math.max(1, 1400 / options.captureDims.height) : 1;
  const scaledDims = options.captureDims
    ? { width: Math.ceil(options.captureDims.width * S), height: Math.ceil(options.captureDims.height * S) }
    : null;
  const scaledViewRect = scene.viewRect && S !== 1
    ? { x: Math.round(scene.viewRect.x * S), y: Math.round(scene.viewRect.y * S), width: Math.round(scene.viewRect.width * S), height: Math.round(scene.viewRect.height * S) }
    : scene.viewRect
      ? { ...scene.viewRect }
      : null;

  // Settle time: last camera keyframe (highlights only appear once the camera stops).
  const lastKeyMs = scene.cameraKeys.length > 0 ? scene.cameraKeys[scene.cameraKeys.length - 1].timeMs : scene.startMs;
  const settleMs = lastKeyMs + 120;

  if (scaledViewRect && scaledDims && scene.cameraKeys.length > 0) {
    const relKeys = scene.cameraKeys.map(k => ({
      ...k,
      focusX: k.focusX * S - scaledViewRect.x,
      focusY: k.focusY * S - scaledViewRect.y,
    }));
    const settle = sampleCamera(relKeys, settleMs, "easeInOut");
    const win = cropWindow(scaledViewRect.width, scaledViewRect.height, settle.scale, settle.focusX, settle.focusY, scaledViewRect.width, scaledViewRect.height);
    for (const [i, h] of scene.highlights.entries()) {
      const hx = h.x * S - scaledViewRect.x;
      const hy = h.y * S - scaledViewRect.y;
      const hw = h.width * S;
      const hh = h.height * S;
      const xOut = Math.round((hx - win.x) * (LONGFORM.width / win.width));
      const yOut = Math.round((hy - win.y) * (LONGFORM.height / win.height));
      const wOut = Math.max(48, Math.round(hw * (LONGFORM.width / win.width)));
      const hOut = Math.max(24, Math.round(hh * (LONGFORM.height / win.height)));
      const pngPath = path.join(options.outDir, "overlays", `${scene.id}-hl-${i}.png`);
      await ensureHighlightPng(pngPath, wOut, hOut);
      highlights.push({ ...addOverlay(`hl${i}`, pngPath), x: xOut, y: yOut, startMs: Math.max(h.startMs, settleMs), endMs: h.endMs });
    }
  } else {
    // Static full-frame scenes (source file): place highlights at 1:1 coords.
    for (const [i, h] of scene.highlights.entries()) {
      const pngPath = path.join(options.outDir, "overlays", `${scene.id}-hl-${i}.png`);
      await ensureHighlightPng(pngPath, h.width, h.height);
      highlights.push({ ...addOverlay(`hl${i}`, pngPath), x: Math.round(h.x), y: Math.round(h.y), startMs: h.startMs, endMs: h.endMs });
    }
  }

  let callout: OverlayInput | null = null;
  if (scene.callout) {
    const pngPath = path.join(options.outDir, "overlays", `${scene.id}-callout.png`);
    const made = await ensureCalloutPng(pngPath, scene.callout.text);
    callout = addOverlay("callout", made.file);
  }

  let mascot: OverlayInput | null = null;
  if (scene.mascot) {
    const file = scene.mascot.asset === "escort" ? options.mascotFiles.escort : scene.mascot.asset === "point" ? options.mascotFiles.point : options.mascotFiles.present;
    mascot = addOverlay("mascot", file);
  }

  const subtitlesFilter = options.captionsAss
    ? `subtitles='${options.captionsAss.replace(/\\/g, "/").replace(/:/g, "\\:")}':fontsdir='${options.fontsdir.replace(/\\/g, "/").replace(/:/g, "\\:")}'`
    : null;

  const filter = buildSceneFilterGraph({
    type: scene.type,
    startMs: scene.startMs,
    endMs: scene.endMs,
    viewRect: scene.viewRect,
    cameraKeys: scene.cameraKeys,
    inputImageDims: options.captureImage ? options.captureDims : null,
    highlights: highlights.map(h => ({ pngLabel: h.label, x: h.x, y: h.y, startMs: h.startMs, endMs: h.endMs })),
    overlayInputs,
    mascot: scene.mascot && mascot
      ? { label: "mascot", position: scene.mascot.position, startMs: scene.mascot.startMs, endMs: scene.mascot.endMs, heightPx: scene.mascot.heightPx, slideIn: scene.type === "opening" }
      : null,
    callout: scene.callout && callout ? { label: "callout", startMs: scene.callout.startMs, endMs: scene.callout.endMs } : null,
    title: title ? { label: "title", appearAtMs: scene.titleAppearAtMs, disappearAtMs: scene.titleDisappearAtMs } : null,
    subtitlesFilter,
  });

  const hash = createHash("sha256");
  hash.update(JSON.stringify({ scene, captions: options.captionsAss ? await fileSha(options.captionsAss) : null }));
  hash.update(await fileSha(baseFile));
  for (const overlay of overlayInputs) hash.update(await fileSha(overlay.file));
  const inputHash = hash.digest("hex").slice(0, 16);
  const hashPath = outPath + ".hash";
  if (fsSync.existsSync(outPath) && fsSync.existsSync(hashPath)) {
    const recorded = (await fs.readFile(hashPath, "utf8")).trim();
    if (recorded === inputHash) {
      log(`    segment ${options.index + 1}: reused (inputs unchanged)`);
      return { path: outPath, frames: totalFrames, reused: true };
    }
  }

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    ...inputs,
    "-t", ((scene.endMs - scene.startMs) / 1000).toFixed(3),
    "-filter_complex", filter,
    "-map", "[vout]",
    "-an",
    "-c:v", "libx264",
    "-preset", LONGFORM.preset,
    "-crf", String(LONGFORM.crf),
    "-pix_fmt", LONGFORM.pixelFormat,
    "-r", String(LONGFORM.fps),
    "-profile:v", LONGFORM.profile,
    "-level", LONGFORM.level,
    outPath,
  ];
  await execFileAsync("ffmpeg", args, { maxBuffer: 128 * 1024 * 1024 });
  await fs.writeFile(hashPath, inputHash, "utf8");
  return { path: outPath, frames: totalFrames, reused: false };
}

/* ------------------------------------------------------------------ */
/* Global caption burn (whole-episode PTS, one pass)                    */
/* ------------------------------------------------------------------ */

/**
 * Burn the episode captions onto the concatenated video. Segments are rendered
 * with their own zero-based clocks during the composition pass, so captions
 * are applied ONCE here against the final global timeline. This preserves the
 * exact alignment measured from the narration instead of per-scene timing.
 */
export async function burnCaptionsGlobal(inputVideo: string, captionsAss: string, fontsdir: string, outVideo: string): Promise<void> {
  const escapedAss = captionsAss.replace(/\\/g, "/").replace(/:/g, "\\:");
  const escapedFontsdir = fontsdir.replace(/\\/g, "/").replace(/:/g, "\\:");
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputVideo,
    "-vf", `subtitles='${escapedAss}':fontsdir='${escapedFontsdir}'`,
    "-c:v", "libx264",
    "-preset", LONGFORM.preset,
    "-crf", String(LONGFORM.crf),
    "-pix_fmt", LONGFORM.pixelFormat,
    "-r", String(LONGFORM.fps),
    "-profile:v", LONGFORM.profile,
    "-level", LONGFORM.level,
    "-an",
    outVideo,
  ], { maxBuffer: 64 * 1024 * 1024 });
}

/* ------------------------------------------------------------------ */
/* Concat + final mux                                                   */
/* ------------------------------------------------------------------ */

export async function concatSegments(segments: string[], listPath: string, outVideo: string): Promise<void> {
  const lines = segments.map(s => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
  await fs.writeFile(listPath, lines.join("\n") + "\n", "utf8");
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    outVideo,
  ]);
}

export async function muxAudio(videoIn: string, audioIn: string, outPath: string, durationSeconds?: number): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", videoIn,
    "-i", audioIn,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", LONGFORM.audio.bitrate,
    "-ar", String(LONGFORM.audio.sampleRate),
    "-ac", String(LONGFORM.audio.channels),
    ...(durationSeconds && durationSeconds > 0 ? ["-t", durationSeconds.toFixed(3)] : []),
    "-movflags", "+faststart",
    outPath,
  ]);
}

export { cropWindow };
