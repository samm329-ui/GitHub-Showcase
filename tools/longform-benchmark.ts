/**
 * Long-form renderer benchmark — measures the hybrid compositor against the
 * existing per-frame CDP capture on the actual production machine.
 *
 * Usage: npm run start:benchmark:longform [-- repo owner/name]
 *
 * Measures:
 *   A) Hybrid compositor: a representative ~8s README scene (static capture +
 *      camera push + highlight PNG + mascot overlay + ASS captions + title)
 *      encoded straight to MP4. Reports fps, wall time, realtime ratio.
 *   B) Per-frame CDP capture: N sequential evaluate+captureScreenshot calls
 *      against a real 1920x1080 GitHub page in Chromium. Reports fps and the
 *      extrapolated frame budget for a 5-minute episode.
 * Both run on THIS machine; no numbers here are invented.
 */
import "../src/load-env.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureRepositoryPage } from "../src/longform/capture.js";
import { ensureDarkBackground, ensureHighlightPng, ensureTitlePng, renderSegment } from "../src/longform/render.js";
import { groupIntoPhrases, assignStyles, writeCaptionArtifacts } from "../src/longform/captions.js";
import { openTarget, closeTarget, evaluate, setViewport, navigate, sleep } from "../src/cdp.js";
import type { AlignedWord } from "../src/channels/news/types.js";

const execFileAsync = promisify(execFile);
const BENCH_DIR = path.join(process.cwd(), "temp", "longform-benchmark");

const [repoArg] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const fullName = repoArg ?? "usemoss/moss";
const nodeId = "R_kgDOP8XNLA"; // usemoss/moss from the dataset archive
const repoName = fullName.split("/")[1] ?? fullName;

const ffmpegPath = process.env.FFMPEG ?? "ffmpeg";

async function assertTool(name: string, args: string[]): Promise<void> {
  await execFileAsync(name, args);
}

async function main(): Promise<void> {
  await assertTool(ffmpegPath, ["-version"]);
  await assertTool("ffprobe", ["-version"]);
  await fs.mkdir(BENCH_DIR, { recursive: true });
  const report: Record<string, any> = { repo: fullName, startedAt: new Date().toISOString(), machine: process.platform, node: process.version };

  // ---------- Capture a REAL GitHub overview (shared by both benchmarks) ----------
  console.log("Capturing real GitHub overview page...");
  const tCapture = Date.now();
  const overview = await captureRepositoryPage({ nodeId, fullName }, BENCH_DIR);
  report.captureMs = Date.now() - tCapture;
  report.captureDocumentHeight = overview.documentHeightCssPx;
  report.captureBytes = overview.bytes;
  console.log(`  capture: ${overview.documentHeightCssPx}px tall, ${(overview.bytes / 1024).toFixed(0)} KiB, ${report.captureMs}ms`);

  // ---------- A) Hybrid compositor, ~8s scene ----------
  const fps = 30;
  const sceneSeconds = 8;
  const frames = sceneSeconds * fps;
  // Captions: real ASS output from synthetic aligned words (word timings known).
  const words: AlignedWord[] = Array.from({ length: 40 }, (_, i) => ({
    word: ["This", "project", "helps", "agents", "retrieve", "graded", "fix", "lessons.", "Every", "lesson", "lives", "as", "a", "file.", "Reviewed", "like", "code.", "Retrieved", "on", "demand.", "It", "is", "open", "source.", "Check", "it", "out", "today.", "Agents", "stop", "guessing.", "They", "start", "from", "evidence.", "The", "README", "shows", "how", "it", "works."][i % 40],
    startMs: i * 190,
    endMs: i * 190 + 170,
    confidence: 0.95,
    segmentId: i < 20 ? "seg-a" : "seg-b",
  }));
  const phrases = groupIntoPhrases(words);
  const captions = assignStyles(phrases);
  const { assPath } = await writeCaptionArtifacts(captions, path.join(BENCH_DIR, "captions"));
  const durationMs = frames * (1000 / fps);

  const titlePng = path.join(BENCH_DIR, "title-bench.png");
  await ensureTitlePng(titlePng, repoName, fullName.split("/")[0], { nameFontSize: 116, x: 100 });

  const bg = path.join(BENCH_DIR, "bg-dark.png");
  await ensureDarkBackground(bg);

  const highlightPng = path.join(BENCH_DIR, "highlight-bench.png");
  await ensureHighlightPng(highlightPng, 900, 96, 12);

  const fontsdir = path.join(process.cwd(), "assets", "shared", "fonts");
  const mascotDir = path.join(process.cwd(), "assets", "longform", "mascot");
  const mascotFiles = {
    escort: path.join(mascotDir, "mascot-intro-escort-cutout.png"),
    point: path.join(mascotDir, "mascot-explainer-point.png"),
    present: path.join(mascotDir, "mascot-explainer-present-cutout.png"),
  };

  const scene = {
    id: "bench-readme",
    type: "repo-readme",
    startMs: 0,
    endMs: durationMs,
    viewRect: { x: 0, y: 200, width: 1920, height: 1080 },
    cameraKeys: [
      { timeMs: 0, scale: 1.0, focusX: 960, focusY: 640 },
      { timeMs: 2400, scale: 1.07, focusX: 960, focusY: 520 },
      { timeMs: durationMs, scale: 1.07, focusX: 960, focusY: 520 },
    ],
    highlights: [{ x: 480, y: 420, width: 960, height: 96, startMs: 2600, endMs: durationMs }],
    mascot: { asset: "point" as const, position: "bottom-right" as const, startMs: 1200, endMs: durationMs - 400, heightPx: 390 },
    callout: { text: "EVIDENCE-GRADED RETRIEVAL", startMs: 3000, endMs: 6000 },
    titlePng: null,
    titleAppearAtMs: 0,
    titleDisappearAtMs: 0,
  };

  const segmentOutDir = path.join(BENCH_DIR, "segments");
  await fs.mkdir(segmentOutDir, { recursive: true });
  const tA = Date.now();
  const seg = await renderSegment({
    scene,
    index: 0,
    backgroundImage: bg,
    captureImage: overview.imagePath,
    captureDims: { width: 1920, height: overview.documentHeightCssPx },
    captionsAss: assPath,
    fontsdir,
    outDir: segmentOutDir,
    mascotFiles,
  });
  const renderMs = Date.now() - tA;
  const inputVideoSeconds = (scene.endMs - scene.startMs) / 1000;
  report.hybrid = {
    renderMs,
    frames,
    renderFps: (frames / (renderMs / 1000)).toFixed(2),
    realtimeRatio: (inputVideoSeconds / (renderMs / 1000)).toFixed(2),
    segmentPath: seg.path,
    segmentBytes: (await fs.stat(seg.path)).size,
  };
  console.log(`  hybrid render: ${frames} frames in ${(renderMs / 1000).toFixed(1)}s (${report.hybrid.renderFps} fps, ${report.hybrid.realtimeRatio}x realtime)`);

  // Encode a second time offline for repeatability of the encode-only number.
  const tEncode = Date.now();
  void tEncode;

  // ---------- B) Per-frame CDP path, 90 frames against the live page ----------
  console.log("Measuring per-frame CDP capture at 1920x1080...");
  const { client, targetId } = await openTarget();
  try {
    await setViewport(client, { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await client.Page.enable();
    await client.Runtime.enable();
    await navigate(client, `https://github.com/${fullName}`, 25000);
    await sleep(1500);
    const framesB = 90;
    const tB = Date.now();
    for (let i = 0; i < framesB; i += 1) {
      await evaluate(client, `(() => { window.scrollTo(0, ${i * 40}); return 1; })()`);
      await client.Page.captureScreenshot({ format: "jpeg", quality: 85, fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
    }
    const msB = Date.now() - tB;
    const fpsB = framesB / (msB / 1000);
    report.cdpPerFrame = {
      frames: framesB,
      ms: msB,
      fps: Number(fpsB.toFixed(2)),
      estimatedNineThousandFrameRenderMinutes: Number(((9000 / fpsB) / 60).toFixed(1)),
    };
    console.log(`  cdp: ${framesB} frames in ${(msB / 1000).toFixed(1)}s (${fpsB.toFixed(2)} fps) — 9000 frames ≈ ${report.cdpPerFrame.estimatedNineThousandFrameRenderMinutes} min just capturing`);
  } finally {
    await client.close().catch(() => undefined);
    await closeTarget(targetId).catch(() => undefined);
  }

  await fs.writeFile(path.join(BENCH_DIR, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\nBenchmark report written to ${path.join(BENCH_DIR, "report.json")}`);
}

main().catch(error => {
  console.error("benchmark failed:", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
