import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildFactLedger } from "../src/facts.js";
import { buildNarrationPlan, validateScript } from "../src/narration.js";
import { synthesizeSegments, concatChunks, toTimedChunks } from "../src/voice.js";
import { buildCaptions, buildScrollKeyframes } from "../src/timeline.js";
import { measureCard } from "../src/browser-capture.js";
import { renderVideo } from "../src/render.js";
import { startAssetServer } from "../src/asset-server.js";
import { buildSpeechEnvelope, resolveCharacterAsset } from "../src/character-motion.js";
import {
  captureMobileRepositoryPage,
  chooseStoryEnd,
  cropMobileCapture,
} from "../src/mobile-capture.js";
import { CARD_VIEWPORT_HEIGHT, CHARACTER_PNG } from "../src/config.js";
import { enriched } from "../tests/helpers.js";
import type { VisualAnchor } from "../src/types.js";

/**
 * Local preview of the full visual/narration pipeline for one fixture.
 * Requires Chromium with remote debugging on CHROME_DEBUG_URL (default 9222).
 */

const run = promisify(execFile);
const dir = path.join(process.cwd(), "temp", "preview");
await fs.mkdir(dir, { recursive: true });

const repo = enriched("high-quality-popular");
const ledger = buildFactLedger(repo, {
  previousStars: 12000,
  previousCapturedAt: new Date(Date.now() - 9 * 86400000).toISOString(),
});
const plan = buildNarrationPlan(ledger, repo, { targetDurationSeconds: 30 });
const validation = validateScript(plan, ledger);
console.log("angle:", plan.angle, "variant:", plan.styleVariant);
console.log("valid:", validation.ok, validation.errors);
plan.segments.forEach(s => console.log(`  [${s.narrativeRole}/${s.purpose}] ${s.spokenText}`));

const chunks = await synthesizeSegments(plan.segments, path.join(dir, "audio"), {});
const wav = path.join(dir, "narration.wav");
const merged = await concatChunks(chunks, wav);
const timed = toTimedChunks(chunks, plan.segments);
const envelope = await buildSpeechEnvelope(wav);
console.log("audio:", merged.durationMs, "ms", merged.sampleRate, "Hz");

const capture = await captureMobileRepositoryPage(repo, path.join(dir, "capture"));
for (const warning of capture.warnings) console.log("capture warning:", warning);
const referenced = [
  ...new Set(
    plan.segments
      .map(segment => segment.visualAnchor)
      .filter((anchor): anchor is VisualAnchor => Boolean(anchor))
  ),
];
const span = chooseStoryEnd({
  anchors: capture.anchors,
  fullHeightPx: capture.raster.height,
  viewportHeightPx: CARD_VIEWPORT_HEIGHT,
  durationMs: merged.durationMs,
  referencedAnchors: referenced,
});
const story = await cropMobileCapture(
  capture,
  span.endPx,
  path.join(dir, "capture", "story-page.jpg")
);
console.log("capture:", capture.source, capture.raster, "story:", span);

const characterPath = resolveCharacterAsset(CHARACTER_PNG);
const assets = await startAssetServer({
  "/page.jpg": story.imagePath,
  ...(characterPath ? { "/character.png": characterPath } : {}),
});
try {
  const measured = await measureCard({
    repo,
    pageImageUrl: `${assets.origin}/page.jpg`,
    characterUrl: characterPath ? `${assets.origin}/character.png` : null,
  });
  console.log("document:", measured.documentHeight, "viewport:", measured.viewportHeight);
  console.log("geometry:", JSON.stringify(measured.geometry));

  const captions = buildCaptions(plan.segments, timed, { phonemeTimings: null });
  const keys = buildScrollKeyframes({
    segments: plan.segments,
    chunks: timed,
    anchors: story.anchors,
    documentHeight: measured.documentHeight,
    viewportHeight: measured.viewportHeight,
    durationMs: merged.durationMs,
  });
  console.log("keyframes:", JSON.stringify(keys));

  const out = path.join(dir, "preview.mp4");
  await renderVideo({
    repo,
    pageImageUrl: `${assets.origin}/page.jpg`,
    characterUrl: characterPath ? `${assets.origin}/character.png` : null,
    speechEnvelope: envelope,
    captions,
    scrollKeyframes: keys,
    audioPath: wav,
    audioDurationMs: merged.durationMs,
    outputPath: out,
    workDir: dir,
    crf: 20,
    onProgress: (frame, total) => {
      if (frame % 150 === 0) console.log(`  ${frame}/${total}`);
    },
  });
  console.log("video:", out);
  await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "default=nw=1", out]);
} finally {
  await assets.close();
}
