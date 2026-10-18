import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildFactLedger } from "../src/facts.js";
import { buildNarrationPlan, validateScript } from "../src/narration.js";
import { synthesizeSegments, concatChunks, toTimedChunks } from "../src/voice.js";
import { buildCaptions } from "../src/timeline.js";
import { measureCard } from "../src/browser-capture.js";
import { buildScrollKeyframes } from "../src/timeline.js";
import { renderVideo } from "../src/render.js";
import { enriched } from "../tests/helpers.js";

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
plan.segments.forEach(s => console.log(`  [${s.purpose}] ${s.spokenText}`));

const chunks = await synthesizeSegments(plan.segments, path.join(dir, "audio"), {});
const wav = path.join(dir, "narration.wav");
const merged = await concatChunks(chunks, wav);
const timed = toTimedChunks(chunks, plan.segments);
console.log("audio:", merged.durationMs, "ms", merged.sampleRate, "Hz");

const measured = await measureCard(repo);
console.log("document:", measured.documentHeight, "viewport:", measured.viewportHeight);
console.log("anchors:", measured.anchors);
console.log("geometry:", JSON.stringify(measured.geometry));

const captions = buildCaptions(plan.segments, timed, { phonemeTimings: null });
const keys = buildScrollKeyframes({
  segments: plan.segments,
  chunks: timed,
  anchors: measured.anchors,
  documentHeight: measured.documentHeight,
  viewportHeight: measured.viewportHeight,
});
console.log("keyframes:", JSON.stringify(keys));

const out = path.join(dir, "preview.mp4");
await renderVideo({
  repo,
  captions,
  scrollKeyframes: keys,
  audioPath: wav,
  audioDurationMs: merged.durationMs,
  outputPath: out,
  workDir: dir,
  crf: 20,
  onProgress: (f, t) => {
    if (f % 150 === 0) console.log(`  ${f}/${t}`);
  },
});
console.log("video:", out);
await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "default=nw=1", out]);
