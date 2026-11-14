/**
 * Long-form pipeline entry point (`npm run start:longform`).
 *
 *   1. PREFLIGHT                 — runtime, assets, licences, dataset readiness
 *   2. DATASET RECONCILIATION    — read-only usability audit
 *   3. REPOSITORY SELECTION      — deterministic pick of five + atomic reservation
 *   4. MASTER SCRIPT             — one cohesive Groq episode, validated
 *   5. NARRATION AND ALIGNMENT   — Kokoro + forced word alignment + captions
 *   6. REPOSITORY CAPTURE        — authentic GitHub capture per repository
 *   7. VISUAL COMPOSITION        — scene manifest, camera, mascot, titles
 *   8. AUDIO PRODUCTION          — BGM ducking + SFX + loudness
 *   9. VIDEO RENDERING           — hybrid compositor, segment reuse
 *   10. FINAL QA                 — media probe, loudness, not-blank, contact sheet
 *   11. FINALIZATION             — artifacts + episode history + keypress hint
 *
 * Flags: --dry-run (no reservation), --resume [episodeId] (reuse latest or named).
 */
import "../load-env.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  OUTPUT_DIR_LONGFORM,
  LONGFORM,
  MASCOT_ASSETS,
  PHASES,
  longformWorkDir,
} from "./config.js";
import { LongformHistory } from "./db.js";
import { reconcileDataset } from "./dataset-loader.js";
import { previewSelection } from "./repository-selector.js";
import { runPreflight } from "./preflight.js";
import { Progress } from "./progress.js";
import { CheckpointStore, fingerprint, fingerprintFiles } from "./checkpoint.js";
import { buildEvidencePacket, generateMasterScript } from "./master-script.js";
import { toSynthSegments, planScenes } from "./scene-planner.js";
import { synthesizeSegments, concatChunks, type SynthesizedChunk } from "../voice.js";
import { alignNarration } from "../channels/news/alignment.js";
import { groupIntoPhrases, assignStyles, writeCaptionArtifacts } from "./captions.js";
import { captureRepositoryBundle } from "./capture.js";
import { ensureDarkBackground, makeBlurredCaptureBackground, ensureTitlePng, renderSegment, concatSegments, muxAudio, burnCaptionsGlobal } from "./render.js";
import { scheduleSfxFromScenes, mixEpisodeAudio } from "./audio-mixer.js";
import { validateLongformOutput } from "./qa.js";
import { probeMedia, measureLoudness } from "../qa.js";
import { verifyUsedAssets, productionAssetFiles } from "./music-manager.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import type { EpisodeRecord } from "./types.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resumeIndex = args.indexOf("--resume");
const resumeEpisodeId = resumeIndex >= 0 ? (args[resumeIndex + 1] && !args[resumeIndex + 1].startsWith("--") ? args[resumeIndex + 1] : null) : null;
const forceFresh = args.includes("--fresh");

const log = (line: string) => console.log(line);
const progress = new Progress();

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const sha256File = async (file: string) => sha256(await fs.readFile(file));

async function main(): Promise<void> {
  progress.header("LONG-FORM PRODUCTION — OCTAVIA");

  const history = new LongformHistory();
  const usedNodeIds = history.usedNodeIds();

  /* ---------------- Resume short-circuit ---------------- */
  let existingEpisode: EpisodeRecord | null = null;
  if (!dryRun && !forceFresh) {
    if (resumeEpisodeId) {
      // Explicit resume: the named episode is reused even if it already
      // completed (used after post-hoc fixes, e.g. a renderer/caption bug).
      existingEpisode = history.getEpisode(resumeEpisodeId);
      if (existingEpisode) {
        log(`Explicit resume of episode ${existingEpisode.episodeId} (status ${existingEpisode.status}) — its reservation is reused.`);
      } else {
        log(`WARNING: --resume ${resumeEpisodeId}: episode not found; starting a fresh episode.`);
      }
    } else {
      existingEpisode = history.findResumableEpisode();
      if (existingEpisode && existingEpisode.status === "completed") existingEpisode = null;
    }
    if (existingEpisode) {
      log(`Resuming episode ${existingEpisode.episodeId} (status ${existingEpisode.status}) with its original five repositories.`);
    }
  }

  const episodeId = existingEpisode?.episodeId ?? `lf-${randomUUID().slice(0, 8)}`;
  const runId = randomUUID().slice(0, 8);
  const workDir = longformWorkDir(episodeId);
  await fs.mkdir(workDir, { recursive: true });
  const checkpoints = new CheckpointStore(workDir);

  const phase = (name: (typeof PHASES)[number]) => ({ index: PHASES.indexOf(name) + 1, name });

  try {
    /* ============ 1. PREFLIGHT ============ */
    progress.phaseStart("PREFLIGHT", phase("PREFLIGHT").index - 1);
    const preflight = await runPreflight(usedNodeIds, new Set(existingEpisode ? history.getEpisodeRepositories(existingEpisode.episodeId).map(r => r.nodeId) : []));
    for (const check of preflight.checks) {
      log(`    ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    if (!preflight.ok) {
      progress.phaseFailed("PREFLIGHT", "see checks above");
      if (!dryRun) history.updateStatus(episodeId, "failed", { errorStage: "PREFLIGHT", error: "preflight failed" });
      process.exitCode = 1;
      return;
    }
    progress.phaseDone("PREFLIGHT", `${preflight.eligibleRepositories} eligible repositories`);

    /* ============ 2. DATASET RECONCILIATION ============ */
    progress.phaseStart("DATASET RECONCILIATION", phase("DATASET RECONCILIATION").index - 1);
    const reconciliation = await reconcileDataset();
    const usable = reconciliation.candidates.filter(
      c => c.issues.length === 0 && c.nodeId && !usedNodeIds.has(c.nodeId)
    );
    await fs.mkdir(path.join(workDir, "reports"), { recursive: true });
    await fs.writeFile(
      path.join(workDir, "reports", "dataset-reconciliation.json"),
      JSON.stringify(reconciliation, null, 2),
      "utf8"
    );
    log(`    scanned ${reconciliation.scanned} completed records; usable: ${usable.length}`);
    if (usable.length < 5 && !existingEpisode) {
      progress.phaseFailed("DATASET RECONCILIATION", `exact shortfall: ${5 - usable.length} repository(ies)`);
      log(`\n  BLOCKED: need 5 usable, unused completed GitHub dataset records; only ${usable.length} exist.`);
      log("  Produce more Short-form videos first (npm run start -- --repo owner/name), then re-run.");
      if (!dryRun) history.updateStatus(episodeId, "failed", { errorStage: "DATASET RECONCILIATION", error: `shortfall ${5 - usable.length}` });
      process.exitCode = 1;
      return;
    }
    progress.phaseDone("DATASET RECONCILIATION", `${usable.length} usable`);

    /* ============ 3. REPOSITORY SELECTION ============ */
    progress.phaseStart("REPOSITORY SELECTION", phase("REPOSITORY SELECTION").index - 1);
    let selection = await previewSelection(usedNodeIds);
    if (existingEpisode) {
      const rows = history.getEpisodeRepositories(episodeId);
      const byFullName = new Map(reconciliation.candidates.map(c => [c.nodeId, c]));
      for (const row of rows) {
        if (!byFullName.has(row.nodeId)) {
          throw new Error(`reserved repository ${row.fullName} (${row.nodeId}) is missing from the eligible dataset — cannot resume; manual intervention required`);
        }
      }
      selection = {
        eligible: usable.length,
        used: usedNodeIds.size,
        shortfall: 0,
        selected: {
          episodeId,
          candidates: usable,
          ranked: rows
            .slice()
            .sort((a, b) => a.rank - b.rank)
            .map(r => ({ ...byFullName.get(r.nodeId)!, selectionScore: r.selectionScore, diversityPenalty: 0 })),
          presentation: rows
            .slice()
            .sort((a, b) => b.rank - a.rank)
            .map(r => ({ ...byFullName.get(r.nodeId)!, rank: r.rank, selectionScore: r.selectionScore })),
        },
      };
      log("    resuming with the reserved repositories:");
      for (const row of selection.selected!.presentation) log(`      rank ${row.rank}  ${row.fullName}  (score ${row.selectionScore.toFixed(1)})`);
    } else if (!dryRun) {
      if (!selection.selected) throw new Error("selection failed unexpectedly after preflight passed");
      const presentation = selection.selected.presentation;
      // Atomic reservation: all five at once, or none.
      history.reserveEpisode({
        episodeId,
        runId,
        repositories: presentation.map(p => ({
          nodeId: p.nodeId,
          fullName: p.fullName,
          datasetRecordId: p.recordId,
          rank: p.rank,
          selectionScore: p.selectionScore,
        })),
        workDir,
      });
      log("    reserved all five repositories atomically:");
      for (const row of presentation) log(`      rank ${row.rank}  ${row.fullName}  (score ${row.selectionScore.toFixed(1)})`);
      log("    (a failed episode does NOT release them)");
    } else {
      log("    dry run — no repositories reserved:");
      for (const row of selection.selected!.presentation) log(`      rank ${row.rank}  ${row.fullName}  (score ${row.selectionScore.toFixed(1)})`);
    }
    progress.phaseDone("REPOSITORY SELECTION", existingEpisode ? "resumed (same five)" : dryRun ? "dry run (nothing reserved)" : "reserved");

    const presentation = selection.selected!.presentation;
    const presentationOrder = presentation.map(p => p.nodeId);

    /* ============ 4. MASTER SCRIPT ============ */
    progress.phaseStart("MASTER SCRIPT", phase("MASTER SCRIPT").index - 1);
    const selectionFingerprint = fingerprint({ order: presentationOrder, scores: presentation.map(p => p.selectionScore) });
    let masterScriptCheckpoint = await checkpoints.get<{
      script: import("./types.js").MasterScript;
      usage: unknown;
      model: string;
      warnings: string[];
    }>("master-script");
    let scriptResult: {
      script: import("./types.js").MasterScript;
      usage: unknown;
      model: string;
      warnings: string[];
    };
    if (masterScriptCheckpoint && masterScriptCheckpoint.fingerprint === selectionFingerprint) {
      scriptResult = masterScriptCheckpoint.value;
      log("    reused master script (inputs unchanged)");
    } else {
      const packets = await Promise.all(presentation.map(p => buildEvidencePacket(p)));
      const snapshotPath = path.join(workDir, "master-script.json");
      // Explicit resume of an already-completed episode: reuse its own verified
      // snapshot instead of regenerating — never acceptable for a fresh episode.
      if (existingEpisode && fsSync.existsSync(snapshotPath)) {
        try {
          const { validateMasterScript } = await import("./master-script.js");
          const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
          const validation = validateMasterScript(snapshot, packets, presentationOrder);
          if (validation.ok) {
            log("    reused master-script.json from the episode workDir (verified snapshot — no Groq call)");
            scriptResult = { script: snapshot, usage: null, model: "snapshot:master-script.json", warnings: ["reused master-script.json from the episode workDir"] };
          } else {
            throw new Error(`snapshot failed validation: ${validation.errors.join("; ")}`);
          }
        } catch (error) {
          log(`    snapshot master-script.json unusable (${error instanceof Error ? error.message : String(error)}); regenerating from Groq instead.`);
          const generated = await generateMasterScript(packets, presentationOrder, { log, artifactsDir: workDir });
          scriptResult = { script: generated.script, usage: generated.usage, model: generated.model, warnings: generated.warnings };
          await fs.writeFile(path.join(workDir, "master-script.json"), JSON.stringify(generated.script, null, 2), "utf8");
        }
      } else {
        const generated = await generateMasterScript(packets, presentationOrder, { log, artifactsDir: workDir });
        scriptResult = { script: generated.script, usage: generated.usage, model: generated.model, warnings: generated.warnings };
        await fs.writeFile(path.join(workDir, "master-script.json"), JSON.stringify(generated.script, null, 2), "utf8");
        const words = generated.script.estimatedWords;
        log(`    Groq ${generated.model} wrote the episode (${words} words)`);
        for (const w of generated.warnings) log(`    warning: ${w}`);
      }
      await checkpoints.set("master-script", selectionFingerprint, scriptResult);
    }
    const script = scriptResult.script;
    const estimatedSeconds = (script.estimatedWords / 155) * 60;
    log(`    estimated duration ≈ ${estimatedSeconds.toFixed(0)}s at 155 wpm`);
    progress.phaseDone("MASTER SCRIPT", `${script.estimatedWords} words`);

    /* ============ 5. NARRATION AND ALIGNMENT ============ */
    progress.phaseStart("NARRATION AND ALIGNMENT", phase("NARRATION AND ALIGNMENT").index - 1);
    const synth = toSynthSegments(script);
    const audioDir = path.join(workDir, "narration");
    await fs.mkdir(audioDir, { recursive: true });
    const synthFingerprint = fingerprint(synth.map(s => s.spokenText));
    const narrationCheckpoint = await checkpoints.get<{ narrationWav: string; durationMs: number; sampleRate: number }>("narration");
    let narrationWav = path.join(audioDir, "narration.wav");
    let audioSeconds: number;
    let sampleRate = 24000;
    if (narrationCheckpoint && narrationCheckpoint.fingerprint === synthFingerprint && fsSync.existsSync(narrationWav)) {
      audioSeconds = narrationCheckpoint.value.durationMs / 1000;
      sampleRate = narrationCheckpoint.value.sampleRate;
      log("    reused narration.wav (inputs unchanged)");
    } else if (existingEpisode && fsSync.existsSync(narrationWav) && fsSync.existsSync(path.join(workDir, "segments.json"))) {
      // Explicit resume of an already-completed episode: trust this episode's
      // own narration if the snapshot's segments match the synthesized list.
      try {
        const snapshotSynth = JSON.parse(await fs.readFile(path.join(workDir, "segments.json"), "utf8")) as Array<{ spokenText?: string }>;
        if (fingerprint(snapshotSynth.map(s => String(s.spokenText ?? ""))) === synthFingerprint) {
          const { probeAudio } = await import("../voice.js");
          const measurement = await probeAudio(narrationWav);
          audioSeconds = measurement.durationMs / 1000;
          sampleRate = measurement.sampleRate;
          log("    reused narration.wav from the episode workDir (verified snapshot — snapshot matches current script)");
        } else {
          throw new Error("segments.json snapshot does not match the current synthesis list");
        }
      } catch (error) {
        log(`    narration snapshot unusable (${error instanceof Error ? error.message : String(error)}); synthesizing again.`);
        const chunks: SynthesizedChunk[] = await synthesizeSegments(synth, path.join(audioDir, "chunks"), {});
        await concatChunks(chunks, narrationWav, 120, synth);
        const { probeAudio } = await import("../voice.js");
        const measurement = await probeAudio(narrationWav);
        audioSeconds = measurement.durationMs / 1000;
        sampleRate = measurement.sampleRate;
        await checkpoints.set("narration", synthFingerprint, { durationMs: measurement.durationMs, sampleRate });
        log(`    measured narration: ${audioSeconds.toFixed(2)}s at ${sampleRate}Hz`);
      }
    } else {
      log(`    synthesizing ${synth.length} chunks (Kokoro am_fenrir @ 1.0)...`);
      const chunks: SynthesizedChunk[] = await synthesizeSegments(synth, path.join(audioDir, "chunks"), {});
      await concatChunks(chunks, narrationWav, 120, synth);
      const { probeAudio } = await import("../voice.js");
      const measurement = await probeAudio(narrationWav);
      audioSeconds = measurement.durationMs / 1000;
      sampleRate = measurement.sampleRate;
      await checkpoints.set("narration", synthFingerprint, { durationMs: measurement.durationMs, sampleRate });
      log(`    measured narration: ${audioSeconds.toFixed(2)}s at ${sampleRate}Hz`);
    }
    if (audioSeconds > 330) {
      log(`    WARNING: narration is ${(audioSeconds / 60).toFixed(1)} min — above the 5:15 soft target; content retained (no truncation)`);
    } else if (audioSeconds < 260) {
      log(`    WARNING: narration is ${(audioSeconds / 60).toFixed(2)} min — below the 4:30 soft target`);
    }
    // Continuous narration health check: duration must be > 60s and not silent.
    await fs.writeFile(path.join(workDir, "segments.json"), JSON.stringify(synth, null, 2), "utf8");
    await fs.writeFile(
      path.join(workDir, "transcript.txt"),
      synth.map(s => s.spokenText).join("\n"),
      "utf8"
    );

    // Forced word alignment on the continuous track.
    const transcriptPath = path.join(workDir, "transcript.txt");
    const alignmentOut = path.join(workDir, "narration-alignment.json");
    const alignmentFingerprint = await fingerprintFiles([narrationWav, transcriptPath]);
    const alignmentCheckpoint = await checkpoints.get<{ wordsPath: string; coverage: number; tokensAligned: number; tokensTotal: number }>("alignment");
    let alignment: { words: import("../channels/news/types.js").AlignedWord[]; coverage: number; tokensAligned: number; tokensTotal: number; alignmentSource: string };
    if (alignmentCheckpoint && alignmentCheckpoint.fingerprint === alignmentFingerprint && fsSync.existsSync(alignmentOut)) {
      const raw = JSON.parse(await fs.readFile(alignmentOut, "utf8")) as typeof alignment;
      alignment = raw;
      log("    reused narration-alignment.json (narration unchanged)");
    } else if (existingEpisode && fsSync.existsSync(alignmentOut)) {
      const raw = JSON.parse(await fs.readFile(alignmentOut, "utf8")) as typeof alignment;
      if (raw.words && raw.words.length > 0) {
        alignment = raw;
        log("    reused narration-alignment.json from the episode workDir (verified snapshot)");
      } else {
        throw new Error("alignment snapshot is empty");
      }
    } else {
      log("    aligning words to the continuous narration (faster-whisper/WhisperX)...");
      const report = await alignNarration(
        { audioPath: narrationWav, spokenTranscriptPath: transcriptPath, segmentsJsonPath: path.join(workDir, "segments.json"), outPath: alignmentOut }
      );
      if (report.coverage < 0.99 && process.env.LONGFORM_ALIGN_DEGRADED !== "1") {
        throw new Error(`word alignment coverage ${(report.coverage * 100).toFixed(2)}% is below the 99% gate (set LONGFORM_ALIGN_DEGRADED=1 to proceed degraded)`);
      }
      if (report.coverage < 0.99) {
        log(`    WARNING: alignment coverage ${(report.coverage * 100).toFixed(2)}% is below the 99% gate — DEGRADED MODE (LONGFORM_ALIGN_DEGRADED=1). `);
        log(`    Monotonicity held (${report.monotonic}); the ${report.tokensTotal - report.tokensAligned} unmatched tokens are interpolated between measured neighbours with confidence 0.25.`);
        log(`    Expected misses are proper nouns and tech tokens (repo names, OS/APIs) that CPU int8 English models cannot decode reliably.`);
      }
      alignment = {
        words: report.words,
        coverage: report.coverage,
        tokensAligned: report.tokensAligned,
        tokensTotal: report.tokensTotal,
        alignmentSource: report.alignmentSource,
      };
      await checkpoints.set("alignment", alignmentFingerprint, { coverage: report.coverage, tokensAligned: report.tokensAligned, tokensTotal: report.tokensTotal, alignmentSource: report.alignmentSource, degraded: report.coverage < 0.99 });
      log(`    alignment: ${(report.coverage * 100).toFixed(1)}% coverage (${report.tokensAligned}/${report.tokensTotal} words), source=${report.alignmentSource}, monotonic=${report.monotonic}`);
    }

    // Captions (kinetic, word-timed).
    const phrases = groupIntoPhrases(alignment.words);
    const captions = assignStyles(phrases);
    const { assPath, srtPath } = await writeCaptionArtifacts(captions, path.join(workDir, "captions"));
    await fs.copyFile(srtPath, path.join(workDir, "captions.srt"));
    log(`    captions: ${captions.length} phrases -> ${path.relative(process.cwd(), assPath)}`);

    if (!dryRun) history.updateStatus(episodeId, "narration-ready", { stage: "NARRATION AND ALIGNMENT" });
    progress.phaseDone("NARRATION AND ALIGNMENT", `${audioSeconds.toFixed(1)}s narration`);

    /* ============ 6. REPOSITORY CAPTURE ============ */
    progress.phaseStart("REPOSITORY CAPTURE", phase("REPOSITORY CAPTURE").index - 1);
    const captures: import("./types.js").CaptureBundle[] = [];
    for (const [i, repo] of presentation.entries()) {
      const rank = repo.rank;
      progress.repoHeader(rank, repo.fullName);
      const highlightTargets = script.repositories
        .find(r => r.nodeId === repo.nodeId)!
        .segments.filter(s => s.highlight.enabled && s.highlight.targetText)
        .map(s => ({ segmentId: s.id, targetText: s.highlight.targetText! }));
      const wantSourceFile = script.repositories
        .find(r => r.nodeId === repo.nodeId)!
        .segments.some(s => s.visualTarget.type === "code-file");
      const bundleFingerprint = fingerprint({ repo: repo.nodeId, highlights: highlightTargets.map(t => t.targetText) });
      const repoCheckpoint = await checkpoints.get<{ overviewPath: string; sourceFilePath: string | null }>(`capture-${repo.nodeId}`);
      const manifestPath = path.join(workDir, "captures", repo.nodeId, "overview.json");
      if (repoCheckpoint && repoCheckpoint.fingerprint === bundleFingerprint && fsSync.existsSync(repoCheckpoint.value.overviewPath)) {
        log("    reused captures (inputs unchanged)");
        const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        captures.push({
          nodeId: repo.nodeId,
          overview: raw,
          sourceFile: repoCheckpoint.value.sourceFilePath && fsSync.existsSync(repoCheckpoint.value.sourceFilePath)
            ? JSON.parse(await fs.readFile(path.join(workDir, "captures", repo.nodeId, "source-file.json"), "utf8"))
            : null,
        });
      } else {
        progress.step("opening GitHub page");
        const bundle = await captureRepositoryBundle(repo, workDir, { wantSourceFile, targetText: null, highlightTargets });
        if (!bundle.overview) throw new Error(`capture failed for ${repo.fullName}`);
        progress.step(`overview captured (${bundle.overview.documentHeightCssPx}px tall)`, "COMPLETE");
        if (bundle.sourceFile) progress.step(`source file captured (${bundle.sourceFile.filePath})`, "COMPLETE");
        const located = bundle.overview.highlights.length;
        const wanted = highlightTargets.length;
        progress.step(`highlights located ${located}/${wanted}`, "COMPLETE");
        for (const w of bundle.overview.warnings) log(`    warning: ${w}`);
        await checkpoints.set(`capture-${repo.nodeId}`, bundleFingerprint, {
          overviewPath: manifestPath,
          sourceFilePath: bundle.sourceFile ? path.join(workDir, "captures", repo.nodeId, "source-file.json") : null,
        });
        captures.push(bundle);
      }
    }

    if (!dryRun) history.updateStatus(episodeId, "capture-ready", { stage: "REPOSITORY CAPTURE" });
    progress.phaseDone("REPOSITORY CAPTURE", `${captures.length} repositories captured`);

    /* ============ 7. VISUAL COMPOSITION ============ */
    progress.phaseStart("VISUAL COMPOSITION", phase("VISUAL COMPOSITION").index - 1);
    // Per-segment timings come from the forced alignment (word.segmentId is
    // assigned by the aligner against the same segments.json).
    const timedChunks = (() => {
      const perSegment = new Map<string, { start: number; end: number }>();
      for (const w of alignment.words) {
        const entry = perSegment.get(String(w.segmentId)) ?? { start: Infinity, end: 0 };
        if (w.startMs < entry.start) entry.start = w.startMs;
        if (w.endMs > entry.end) entry.end = w.endMs;
        perSegment.set(String(w.segmentId), entry);
      }
      return synth.map(seg => {
        const e = perSegment.get(seg.id);
        return {
          id: seg.id,
          startMs: e?.start === Infinity ? 0 : e?.start ?? 0,
          endMs: e?.end ?? 0,
        };
      });
    })();
    // Sanity: the aligner assigns segmentIds from the same segments.json.
    const manifest = await planScenes({
      episodeId,
      script,
      timings: timedChunks.map(t => ({ id: t.id, startMs: t.startMs, endMs: t.endMs })),
      words: alignment.words,
      captures,
      workDir,
    });
    log(`    scene manifest: ${manifest.scenes.length} scenes, total ${(manifest.totalDurationMs / 1000).toFixed(1)}s`);

    // Background plates: dark fallback + blurred repo backgrounds for opening/reveals.
    const darkBg = await ensureDarkBackground(path.join(workDir, "bg-dark.png"));
    for (const [i, scene] of manifest.scenes.entries()) {
      if (scene.type === "repo-reveal" && scene.captureImage) {
        const blur = path.join(workDir, "bg", `blur-${scene.nodeId}.jpg`);
        await makeBlurredCaptureBackground(scene.captureImage, blur, { x: 0, y: 0, width: 1920, height: 1400 });
      }
    }
    void darkBg;

    // Title overlays.
    for (const scene of manifest.scenes) {
      if (scene.type === "repo-reveal" && scene.titleText) {
        scene.titlePng = path.join(workDir, "overlays", `title-${scene.nodeId ?? scene.rank}.png`);
        await ensureTitlePng(scene.titlePng, scene.titleText, scene.titleSubText, { x: 100 });
      }
      if (scene.type === "opening") {
        scene.titlePng = path.join(workDir, "overlays", "title-opening.png");
        await ensureTitlePng(scene.titlePng, "FIVE GITHUB PROJECTS.", "ONE WORTH YOUR TIME.", { x: 100, nameFontSize: 116 });
      }
      if (scene.type === "closing") {
        scene.titlePng = path.join(workDir, "overlays", "title-closing.png");
        await ensureTitlePng(scene.titlePng, "OCTAVIA", "THANKS FOR WATCHING", { x: 100, nameFontSize: 148 });
      }
    }

    if (!dryRun) history.updateStatus(episodeId, "composition-ready", { stage: "VISUAL COMPOSITION" });
    progress.phaseDone("VISUAL COMPOSITION", `${manifest.scenes.length} scenes`);

    /* ============ 8. AUDIO PRODUCTION ============ */
    progress.phaseStart("AUDIO PRODUCTION", phase("AUDIO PRODUCTION").index - 1);
    const sfxEvents = scheduleSfxFromScenes(manifest.scenes);
    log(`    SFX events: ${sfxEvents.map(e => e.role).join(", ") || "none"}`);
    const mixedWav = path.join(workDir, "audio", "episode-mix.wav");
    await fs.mkdir(path.join(workDir, "audio"), { recursive: true });
    const mixed = await mixEpisodeAudio({
      narrationWav,
      durationMs: manifest.totalDurationMs,
      sfxEvents,
      outputWav: mixedWav,
      onLog: log,
    });
    const loudness = await measureLoudness(mixed.mixedWav);
    if (loudness) {
      log(`    mix loudness: ${loudness.integrated.toFixed(1)} LUFS, true peak ${loudness.truePeak.toFixed(1)} dBTP (BGM ${mixed.bgmIncluded ? "included, ducked" : "EXCLUDED — licence gate"})`);
    }
    progress.phaseDone("AUDIO PRODUCTION", mixed.bgmIncluded ? "narration + ducked BGM + SFX" : "narration + SFX (no verified BGM)");

    /* ============ 9. VIDEO RENDERING ============ */
    progress.phaseStart("VIDEO RENDERING", phase("VIDEO RENDERING").index - 1);
    const renderDir = path.join(workDir, "render");
    await fs.mkdir(renderDir, { recursive: true });
    const fontsdir = path.join(process.cwd(), "assets", "shared", "fonts");
    const dimsCache = new Map<string, { width: number; height: number }>();
    const loadDims = async (file: string) => {
      if (!dimsCache.has(file)) {
        const { loadImage } = await import("canvas");
        const img = await loadImage(file);
        dimsCache.set(file, { width: img.width, height: img.height });
      }
      return dimsCache.get(file)!;
    };
    const segmentPaths: string[] = [];
    let reused = 0;
    let frames = 0;
    const renderStart = Date.now();
    for (const [index, scene] of manifest.scenes.entries()) {
      if (scene.type === "repo-reveal" && scene.captureImage) {
        scene.captureImage = path.join(workDir, "bg", `blur-${scene.nodeId}.jpg`);
        scene.viewRect = null;
        scene.cameraKeys = [{ timeMs: scene.startMs, scale: 1, focusX: 960, focusY: 540 }];
      }
      // Source-file scenes render the real blob-view capture; everything else uses the overview.
      const contentImage = scene.sourceFileImage ?? scene.captureImage;
      const baseImage = scene.type === "opening" || scene.type === "closing"
        ? await ensureDarkBackground(path.join(workDir, "bg-dark.png"))
        : scene.type === "repo-reveal" && scene.nodeId
          ? path.join(workDir, "bg", `blur-${scene.nodeId}.jpg`)
          : contentImage;
      const dims = baseImage && scene.type !== "opening" && scene.type !== "closing" && scene.type !== "repo-reveal"
        ? await loadDims(baseImage)
        : null;
      log(`    segment ${index + 1}/${manifest.scenes.length} ${scene.type}${scene.fullName ? ` — ${scene.fullName}` : ""}`);
      const result = await renderSegment({
        scene: {
          id: scene.id,
          type: scene.type,
          startMs: scene.startMs,
          endMs: scene.endMs,
          viewRect: scene.viewRect,
          cameraKeys: scene.cameraKeys,
          highlights: scene.highlights,
          mascot: scene.mascot
            ? {
                asset: scene.mascot.asset,
                position: scene.mascot.position,
                startMs: scene.mascot.startMs,
                endMs: scene.mascot.endMs,
                heightPx: Math.round(scene.mascot.heightRatio * 1080),
              }
            : null,
          callout: scene.callout,
          titlePng: scene.titlePng ?? null,
          titleAppearAtMs: scene.type === "repo-reveal" ? scene.startMs + 120 : scene.startMs,
          titleDisappearAtMs: scene.type === "repo-reveal" ? scene.endMs - 120 : scene.endMs,
        },
        index,
        backgroundImage: await ensureDarkBackground(path.join(workDir, "bg-dark.png")),
        captureImage: baseImage!,
        captureDims: dims,
        captionsAss: null,
        fontsdir,
        outDir: renderDir,
        mascotFiles: {
          escort: MASCOT_ASSETS.escort,
          point: MASCOT_ASSETS.explainerPoint,
          present: MASCOT_ASSETS.explainerPresent,
        },
        onLog: log,
      });
      segmentPaths.push(result.path);
      if (result.reused) reused += 1;
      frames += result.frames;
      progress.renderFrame(frames, manifest.scenes.reduce((sum, s) => sum + Math.round(((s.endMs - s.startMs) / 1000) * LONGFORM.fps), 0));
    }
    const concatVideo = path.join(renderDir, "episode-video.mp4");
    await concatSegments(segmentPaths, path.join(renderDir, "concat-list.txt"), concatVideo);
    // Captions burn globally against the concatenated episode's real PTS.
    const burnedVideo = path.join(renderDir, "episode-burned.mp4");
    log("    burning captions onto the global timeline...");
    await burnCaptionsGlobal(concatVideo, assPath, fontsdir, burnedVideo);
    const renderMs = Date.now() - renderStart;
    log(`    segments: ${segmentPaths.length} (${reused} reused), frames: ${frames}, render ${(renderMs / 1000).toFixed(1)}s`);

    if (!dryRun) history.updateStatus(episodeId, "rendering", { stage: "VIDEO RENDERING" });
    progress.phaseDone("VIDEO RENDERING", `${(renderMs / 1000).toFixed(0)}s wall time`);

    /* ============ 10. FINAL QA ============ */
    progress.phaseStart("FINAL QA", phase("FINAL QA").index - 1);
    const episodeOutDir = path.join(OUTPUT_DIR_LONGFORM, episodeId);
    await fs.mkdir(episodeOutDir, { recursive: true });
    const finalMp4 = path.join(episodeOutDir, "final.mp4");
    const burnedProbe = await probeMedia(burnedVideo);
    // Clamp the episode audio to the video's actual frame-count duration so the
    // streams always end together (32 rounded segments drift ~0.8s at 30fps).
    await muxAudio(burnedVideo, mixed.mixedWav, finalMp4, burnedProbe.durationSeconds);
    const qaReport = await validateLongformOutput(finalMp4, { audioSeconds: burnedProbe.durationSeconds });

    // Contact sheet: 6 evenly-spaced frames from the final episode.
    const contactDir = path.join(episodeOutDir, "contact-sheet");
    await fs.mkdir(contactDir, { recursive: true });
    const contactSheet = await (async () => {
      try {
        const probe = await probeMedia(finalMp4);
        const { createCanvas, loadImage } = await import("canvas");
        const duration = probe.durationSeconds;
        const tiles: { img: Awaited<ReturnType<typeof loadImage>>; at: number }[] = [];
        for (let i = 0; i < 6; i += 1) {
          const at = Math.max(0, Math.min(duration - 1.0, (duration * i) / 5 + 0.5));
          const png = path.join(contactDir, `frame-${i + 1}.png`);
          await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", finalMp4, "-vframes", "1", png]);
          tiles.push({ img: await loadImage(png), at });
        }
        const tileW = 640;
        const tileH = 360;
        const cols = 3;
        const rows = 2;
        const sheet = createCanvas(tileW * cols + 20 * (cols + 1), tileH * rows + 20 * (rows + 1));
        const ctx = sheet.getContext("2d");
        ctx.fillStyle = "#0B0F16";
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        for (const [i, tile] of tiles.entries()) {
          const col = i % cols;
          const row = Math.floor(i / cols);
          ctx.drawImage(tile.img, 20 + col * (tileW + 20), 20 + row * (tileH + 20), tileW, tileH);
        }
        const sheetPath = path.join(contactDir, "contact-sheet.png");
        await fs.writeFile(sheetPath, sheet.toBuffer("image/png"));
        return sheetPath;
      } catch (error) {
        log(`    warning: contact sheet failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    })();
    const qaFile = path.join(episodeOutDir, "qa-report.json");
    const media = await probeMedia(finalMp4).catch(() => null);
    await fs.writeFile(qaFile, JSON.stringify({ ...qaReport, media: undefined, contactSheet }, null, 2), "utf8");
    log(`    media: ${media ? `${media.width}x${media.height} @${media.frameRate.toFixed(2)}fps, ${media.durationSeconds.toFixed(2)}s, ${media.videoCodec}, ${(media.sizeBytes / 1_048_576).toFixed(1)} MiB` : "probe failed"}`);
    for (const check of qaReport.checks) log(`    ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    for (const w of qaReport.warnings) log(`    warning: ${w}`);
    if (!qaReport.ok) {
      progress.phaseFailed("FINAL QA", qaReport.hardFailures.join("; "));
      if (!dryRun) history.updateStatus(episodeId, "failed", { errorStage: "FINAL QA", error: qaReport.hardFailures.join("; ") });
      process.exitCode = 1;
      return;
    }
    progress.phaseDone("FINAL QA");

    /* ============ 11. FINALIZATION ============ */
    progress.phaseStart("FINALIZATION", phase("FINALIZATION").index - 1);
    const usedAssets = productionAssetFiles();
    const license = verifyUsedAssets(usedAssets);
    await fs.copyFile(path.join(workDir, "scene-manifest.json"), path.join(episodeOutDir, "scene-manifest.json")).catch(() => undefined);
    await fs.copyFile(srtPath, path.join(episodeOutDir, "captions.srt")).catch(() => undefined);
    await fs.copyFile(assPath, path.join(episodeOutDir, "captions.ass")).catch(() => undefined);
    const chapters = [
      { title: "Opening", startMs: 0 },
      ...presentation.map(p => {
        const firstSegId = script.repositories.find(r => r.nodeId === p.nodeId)!.segments[0].id;
        const t = timedChunks.find(tc => tc.id === firstSegId);
        return { title: p.fullName, startMs: t?.startMs ?? 0 };
      }),
      { title: "Outro", startMs: timedChunks.find(tc => tc.id === "closing")?.startMs ?? manifest.totalDurationMs },
    ];
    await fs.writeFile(path.join(episodeOutDir, "chapters.json"), JSON.stringify(chapters, null, 2), "utf8");
    await fs.writeFile(
      path.join(episodeOutDir, "episode-metadata.json"),
      JSON.stringify(
        {
          episodeId,
          generatedAt: new Date().toISOString(),
          format: { width: 1920, height: 1080, fps: 30, codec: "h264", pixelFormat: "yuv420p", audio: "aac 48kHz stereo" },
          durationSeconds: (media?.durationSeconds ?? manifest.totalDurationMs / 1000),
          repositories: presentation.map(p => ({ rank: p.rank, fullName: p.fullName, nodeId: p.nodeId, datasetRecordId: p.recordId, selectionScore: p.selectionScore })),
          licenceGate: license.ok && !license.devMode ? "passed" : "BYPASSED-dev-mode (LONGFORM_ALLOW_UNVERIFIED_ASSETS=1)",
          masterScriptModel: scriptResult.model,
          wordCount: script.estimatedWords,
          alignment: {
            source: alignment.alignmentSource,
            tokensAligned: alignment.tokensAligned,
            tokensTotal: alignment.tokensTotal,
            coverage: Number(alignment.coverage.toFixed(4)),
            degraded: alignment.coverage < 0.99,
          },
        },
        null,
        2
      ),
      "utf8"
    );
    const releaseManifestPath = path.join(process.cwd(), "assets", "longform", "asset-licenses.json");
    const usedManifest = JSON.parse(await fs.readFile(releaseManifestPath, "utf8"));
    usedManifest.usedInEpisode = episodeId;
    usedManifest.licenceGate = license.ok && !license.devMode ? "passed" : "BYPASSED-dev-mode";
    await fs.writeFile(path.join(episodeOutDir, "asset-licenses-used.json"), JSON.stringify(usedManifest, null, 2), "utf8");

    if (!dryRun) {
      history.updateStatus(episodeId, "completed", { stage: "FINALIZATION", outputPath: finalMp4 });
      history.markProduced(episodeId);
    }
    await checkpoints.clear();

    progress.phaseDone("FINALIZATION");
    log(`\n  =========================================`);
    log(`  LONG-FORM EPISODE COMPLETE`);
    log(`  Video:     ${finalMp4}`);
    log(`  Artifacts: ${episodeOutDir}`);
    log(`  Episode:   ${episodeId}`);
    log(`  =========================================\n`);
    history.close();
    // Interactive terminals wait for a keypress (launchers call pause as well).
    if (process.stdin.isTTY) {
      log("  Press any key to exit.");
      await new Promise<void>(resolve => {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", () => {
          process.stdin.setRawMode?.(false);
          resolve();
        });
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`\n  FAILED: ${message}`);
    const failedStage = Progress.currentPhase;
    if (!dryRun) {
      try {
        history.updateStatus(episodeId, "failed", { errorStage: failedStage, error: message });
      } catch {
        /* never mask the original failure */
      }
    }
    history.close();
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("\nPipeline crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
