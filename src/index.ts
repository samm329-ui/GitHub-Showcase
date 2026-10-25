import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_CANDIDATES_ENRICHED,
  MAX_CANDIDATES_PER_RUN,
  MIN_SCORE,
  MODE_ROTATION,
  OUTPUT_DIR,
  TARGET_DURATION_SECONDS,
  TEMP_DIR,
  FPS,
  VIEWPORT,
  MASCOT_LAYOUT,
  VOICE_PRESET,
  TTS_SPEED,
  TTS_VOICE,
  TTS_PAUSE_BETWEEN_SEGMENTS_MS,
  CARD_VIEWPORT_HEIGHT,
  CHARACTER_POSE_PNGS,
  CALLOUT_PNG,
} from "./config.js";
import { TOPIC_ROTATION as TOPICS } from "./github.js";
import {
  analyzeReadme,
  clearEnrichmentCache,
  discoverRepos,
  enrichRepo,
  getRepo,
  GitHubApiError,
  hardReject,
  parseRepoArg,
  scoreCandidate,
} from "./github.js";
import { HistoryStore, canonicalFullName } from "./history.js";
import { buildFactLedger } from "./facts.js";
import { composeScript } from "./script-composer.js";
import { evaluateScriptability } from "./scriptability.js";
import { evaluateScriptQuality } from "./script-quality.js";
import { validateScript } from "./narration.js";
import {
  kokoroPaths,
  concatChunks,
  synthesizeSegments,
  toTimedChunks,
} from "./voice.js";
import { buildCaptions, buildScrollKeyframes, scrollCoverage } from "./timeline.js";
import { buildCalloutCues } from "./callout-overlay.js";
import { buildImpactBurstCues } from "./impact-accents.js";
import { captionFitsPanel } from "./caption-overlay.js";
import { measureCard } from "./browser-capture.js";
import { renderVideo } from "./render.js";
import {
  buildContactSheet,
  calloutChecks,
  impactAccentsChecks,
  measureLoudness,
  overlayLayoutChecks,
  soundEventsChecks,
  validateOutput,
} from "./qa.js";
import { mixAudioTracks, scheduleSoundEvents } from "./sfx.js";
import { startAssetServer } from "./asset-server.js";
import {
  buildSpeechEnvelope,
  characterPoseForSlot,
  resolveCharacterAsset,
} from "./character-motion.js";
import type { CharacterPoseAsset } from "./card.js";
import {
  captureMobileRepositoryPage,
  chooseStoryEnd,
  cropMobileCapture,
} from "./mobile-capture.js";
import { writeAssFromCaptions } from "./captions.js";
import type {
  CandidateEvaluation,
  CharacterCue,
  DiscoveryMode,
  EnrichedRepo,
  NarrationPlan,
  StageName,
  Timeline,
  VisualAnchor,
} from "./types.js";
import { scrollBounds } from "./scroll.js";

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

let logSink: string[] = [];
let currentStage: StageName = "setup";

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  logSink.push(line);
  console.log(message);
}

async function flushLog(runDir: string, runId: string): Promise<void> {
  // Never let logging turn a clean failure into a crash.
  try {
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "run.log"),
      `run ${runId}\n${logSink.join("\n")}\n`,
      "utf8"
    );
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* Stage 1: discovery + selection                                      */
/* ------------------------------------------------------------------ */

type Selection = {
  repo: EnrichedRepo;
  evaluation: CandidateEvaluation;
  mode: DiscoveryMode;
};

async function selectCandidate(
  history: HistoryStore,
  mode: DiscoveryMode,
  runIndex: number
): Promise<Selection | null> {
  const topic = mode === "topic" ? TOPICS[runIndex % TOPICS.length] : null;
  log(`Stage 1/9: Discovering candidates (mode: ${mode}${topic ? `, topic: ${topic}` : ""})...`);

  const pool = await discoverRepos({ mode, perQuery: 25, topic });
  log(`  ${pool.length} raw results from the search endpoint.`);

  const excluded = history.excludedFullNames();
  const seen = new Set<string>();
  const survivors: CandidateEvaluation[] = [];

  for (const repo of pool.slice(0, MAX_CANDIDATES_PER_RUN)) {
    const key = canonicalFullName(repo.full_name);
    if (seen.has(key)) continue;
    seen.add(key);
    const rejection = hardReject(repo, { excluded });
    if (rejection) {
      log(`  rejected ${repo.full_name}: ${rejection.reason} (${rejection.rule})`);
      continue;
    }
    survivors.push(
      scoreCandidate({
        repo,
        mode,
        readmeText: null,
        release: null,
        momentum: { previousStars: null, previousCapturedAt: null, currentStars: repo.stargazers_count },
      })
    );
  }

  // Cheap gates first, then hydrate only the most promising candidates.
  survivors.sort((a, b) => b.totalScore - a.totalScore);
  const shortlist = survivors.slice(0, MAX_CANDIDATES_ENRICHED);
  log(`  ${survivors.length} passed the hard gates; enriching the top ${shortlist.length}.`);

  const evaluated: CandidateEvaluation[] = [];
  for (const preliminary of shortlist) {
    let enriched: EnrichedRepo;
    try {
      enriched = await enrichRepo(preliminary.repo);
    } catch (error) {
      log(`  could not hydrate ${preliminary.fullName}: ${describe(error)}`);
      continue;
    }
    const analysis = analyzeReadme(enriched.readmeText);
    if (!enriched.readmeText || analysis.length < 120) {
      log(`  rejected ${enriched.full_name}: README has too little usable text.`);
      continue;
    }
    if (hardReject(enriched, { excluded })) {
      log(`  rejected ${enriched.full_name}: failed a gate after hydration.`);
      continue;
    }
    // Scriptability gate: a repository whose README cannot support an honest
    // explanation (no purpose, no concrete mechanism) is skipped here, before
    // any planner or TTS work happens. Manual --repo selections get the same
    // verdict in Stage 3 with the missing-evidence report.
    const scriptability = evaluateScriptability(enriched, buildFactLedger(enriched));
    if (!scriptability.ok) {
      log(
        `  rejected ${enriched.full_name}: not scriptable ` +
          `(${scriptability.missing.join("; ")}).`
      );
      continue;
    }

    const snapshots = history.snapshotsFor(enriched.nodeId);
    const previous = snapshots.length > 0 ? snapshots[0] : null;
    history.upsertRepository({
      nodeId: enriched.nodeId,
      fullName: enriched.full_name,
      htmlUrl: enriched.html_url,
      stars: enriched.stargazers_count,
      pushedAt: enriched.pushedAt,
    });
    history.recordStars(enriched.nodeId, enriched.stargazers_count);

    const scored = scoreCandidate({
      repo: enriched,
      mode,
      readmeText: enriched.readmeText,
      release: enriched.latestRelease,
      momentum: {
        previousStars: previous?.stars ?? null,
        previousCapturedAt: previous?.captured_at ?? null,
        currentStars: enriched.stargazers_count,
      },
    });
    scored.enriched = enriched;
    evaluated.push(scored);
  }

  evaluated.sort((a, b) => b.totalScore - a.totalScore);
  console.log("\nCandidate scores:");
  for (const candidate of evaluated.slice(0, 8)) {
    const flag = candidate.eligible ? "eligible" : "skipped";
    console.log(
      `  ${candidate.totalScore.toString().padStart(3)}  ${candidate.fullName.padEnd(38)} ${flag}` +
        `  ${candidate.breakdown.usefulness}u/${candidate.breakdown.documentation}d/` +
        `${candidate.breakdown.maintenance}m/${candidate.breakdown.adoption}a/${candidate.breakdown.momentum}t`
    );
    if (candidate.reasons.length) console.log(`        why: ${candidate.reasons.join("; ")}`);
    if (candidate.warnings.length) console.log(`        warn: ${candidate.warnings.join("; ")}`);
  }
  console.log("");

  const eligible = evaluated.filter(candidate => candidate.eligible);
  if (eligible.length === 0) {
    log(
      `No candidate reached the ${MIN_SCORE}/100 threshold with usable README evidence. ` +
        "Nothing was selected; run again or pass --repo."
    );
    return null;
  }

  const best = eligible[0];
  if (!best.enriched) throw new Error("Internal error: the winning candidate was not hydrated.");
  return { repo: best.enriched, evaluation: best, mode };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const discoverMode = args.includes("--discover");
  const repoIndex = args.indexOf("--repo");
  const repoArg = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
  const modeArgIndex = args.indexOf("--mode");
  const modeArg = modeArgIndex >= 0 ? (args[modeArgIndex + 1] as DiscoveryMode) : undefined;
  const dryRun = args.includes("--dry-run");

  if (!discoverMode && !repoArg) {
    console.log("Commands:");
    console.log("  npm run start -- --repo https://github.com/owner/repo");
    console.log("  npm run start -- --repo owner/repo");
    console.log("  npm run start -- --discover [--mode practical|popular|underdog|emerging|topic]");
    console.log("  npm run start -- --discover --dry-run   (select and report, do not render)");
    process.exitCode = 1;
    return;
  }

  const runId = randomUUID().slice(0, 8);
  const history = new HistoryStore();
  history.startRun(runId);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(TEMP_DIR, { recursive: true });

  let selection: Selection | null = null;
  let repoNodeId: string | null = null;
  let outputPath: string | null = null;
  let runDir = path.join(TEMP_DIR, runId);

  try {
    log(`Run ${runId} started.`);

    /* ---------------- Stage 1: selection --------------------- */
    if (discoverMode) {
      const runsSeen = history
        .completedFullNames()
        .length;
      const mode = modeArg ?? MODE_ROTATION[runsSeen % MODE_ROTATION.length];
      selection = await selectCandidate(history, mode, runsSeen);
      if (!selection) {
        history.finishRun(runId, "failed", { stage: "discovery", error: "no eligible candidate" });
        await flushLog(runDir, runId);
        process.exitCode = 0;
        return;
      }
    } else {
      const fullName = parseRepoArg(repoArg!);
      const repo = await getRepo(fullName);
      const enriched = await enrichRepo(repo, { force: true });
      history.upsertRepository({
        nodeId: enriched.nodeId,
        fullName: enriched.full_name,
        htmlUrl: enriched.html_url,
        stars: enriched.stargazers_count,
        pushedAt: enriched.pushedAt,
      });
      history.recordStars(enriched.nodeId, enriched.stargazers_count);
      const analysis = analyzeReadme(enriched.readmeText);
      const snapshots = history.snapshotsFor(enriched.nodeId);
      const previous = snapshots.length > 0 ? snapshots[0] : null;
      const evaluation = scoreCandidate({
        repo: enriched,
        mode: modeArg ?? "practical",
        readmeText: enriched.readmeText,
        release: enriched.latestRelease,
        momentum: {
          previousStars: previous?.stars ?? null,
          previousCapturedAt: previous?.captured_at ?? null,
          currentStars: enriched.stargazers_count,
        },
      });
      evaluation.enriched = enriched;
      if (analysis.length < 120) {
        throw new Error(
          `${enriched.full_name} does not have enough README text to explain honestly.`
        );
      }
      selection = { repo: enriched, evaluation, mode: evaluation.mode };
      log(`Stage 1/9: Using ${enriched.full_name} (score ${evaluation.totalScore}/100).`);
    }

    const { repo, evaluation } = selection;
    repoNodeId = repo.nodeId;
    currentStage = "selection";

    /* ---------------- Reservation ----------------------------- */
    // A dry run reports and stops, so it must not consume the retry budget.
    const existing = history.getRepository(repo.nodeId);
    const reserved = dryRun
      ? existing
      : history.reserveRepository(repo.nodeId, runId, { force: !discoverMode });
    if (!dryRun) {
      if (!reserved) {
        throw new Error(
          `${repo.full_name} could not be reserved (status=${existing?.status ?? "unknown"}, ` +
            `attempts=${existing?.attempt_count ?? 0}). Another run may hold it.`
        );
      }
      log(`  reserved ${repo.full_name} for this run.`);
    } else {
      log(`  dry run: ${repo.full_name} is not being reserved.`);
    }

    const slug = `${repo.owner}-${repo.name}`.replace(/[^A-Za-z0-9._-]/g, "-");
    runDir = path.join(TEMP_DIR, `${slug}-${runId}`);
    const workDir = path.join(runDir, "work");
    await fs.mkdir(path.join(workDir, "audio"), { recursive: true });

    await writeJson(path.join(runDir, "repository.json"), repo);
    await writeJson(path.join(runDir, "selection.json"), evaluation);

    /* ---------------- Stage 2: facts ------------------------- */
    currentStage = "facts";
    history.setRunStage(runId, "facts");
    const snapshots = history.snapshotsFor(repo.nodeId);
    const previous = snapshots.length > 0 ? snapshots[0] : null;
    const ledger = buildFactLedger(repo, {
      previousStars: previous?.stars ?? null,
      previousCapturedAt: previous?.captured_at ?? null,
    });
    await writeJson(path.join(runDir, "facts.json"), ledger);
    log(`Stage 2/9: Extracted ${ledger.facts.length} verifiable facts.`);

    /* ---------------- Stage 3: scriptability + composed narration - */
    currentStage = "narration";
    history.setRunStage(runId, "narration");

    // Scriptability gate, again on the *final* ledger (discovery checked a
    // pre-snapshot one). Discovery skips these; a manual --repo selection
    // gets the honest missing-evidence report instead of a fabricated script.
    const scriptability = evaluateScriptability(repo, ledger);
    await writeJson(path.join(runDir, "scriptability.json"), scriptability);
    if (!scriptability.ok) {
      throw new Error(
        `Repository is not scriptable:\n  - ${scriptability.missing.join("\n  - ")}`
      );
    }

    // One composition: the graph path becomes the narration plan exactly once.
    const composed = composeScript(ledger, repo, {
      targetDurationSeconds: TARGET_DURATION_SECONDS,
      voiceId: TTS_VOICE,
      speed: TTS_SPEED,
    });
    const plan: NarrationPlan = composed.plan;
    await writeJson(path.join(runDir, "explanation-plan.json"), composed.explanation);
    await writeJson(path.join(runDir, "narration.json"), plan);

    // Both gates evaluate this same plan — the one TTS will speak below.
    const validation = validateScript(plan, ledger);
    const quality = evaluateScriptQuality(plan, ledger);
    await writeJson(path.join(runDir, "script-quality.json"), quality);
    if (validation.narrative) {
      await writeJson(path.join(runDir, "narration-structure.json"), {
        script: validation.narrative,
      });
    }
    for (const warning of [...validation.warnings, ...quality.warnings]) {
      log(`  script warning: ${warning}`);
    }
    if (!validation.ok) {
      throw new Error(`Script validation failed:\n  - ${validation.errors.join("\n  - ")}`);
    }
    if (!quality.ok) {
      throw new Error(
        `Script quality gate failed:\n  - ${quality.hardFailures.join("\n  - ")}`
      );
    }
    for (const omission of composed.omissions) {
      log(`  omitted ${omission.id}: ${omission.reason}`);
    }
    log(
      `Stage 3/9: "${plan.styleVariant}" (${plan.angle}, attempt ${reserved?.attempt_count ?? 0}) — ` +
        `${plan.segments.length} segments, ${validation.words} words, ` +
        `~${validation.estimatedSeconds.toFixed(1)}s estimated, quality ${quality.score}/100.`
    );
    if (validation.narrative?.useCase) {
      log(`  use case covered via ${plan.angle}; metadata is secondary.`);
    }
    console.log("\nNarration:");
    plan.segments.forEach(segment => console.log(`  [${segment.purpose}] ${segment.spokenText}`));
    console.log("");

    if (dryRun) {
      log("Dry run: stopping before TTS and render.");
      history.finishRun(runId, "failed", { stage: "narration", error: "dry run" });
      await flushLog(runDir, runId);
      return;
    }

    /* ---------------- Stage 4: TTS --------------------------- */
    currentStage = "tts";
    history.setRunStage(runId, "tts");
    const audioDir = path.join(workDir, "audio");
    log(`Stage 4/9: Synthesizing ${plan.segments.length} chunks (voice=${TTS_VOICE}, speed=${TTS_SPEED})...`);
    const synthesized = await synthesizeSegments(plan.segments, audioDir, {
      voice: TTS_VOICE,
      speed: TTS_SPEED,
    });
    const anyPhonemes = synthesized.some(chunk => chunk.hasPhonemeTimings);
    if (!anyPhonemes) {
      log(
        "  the installed Kokoro model exposes no duration predictor, so caption timing " +
          "uses measured chunk durations with syllable and punctuation weighting."
      );
    }
    const narrationWav = path.join(workDir, "narration.wav");
    const merged = await concatChunks(
      synthesized,
      narrationWav,
      TTS_PAUSE_BETWEEN_SEGMENTS_MS,
      plan.segments
    );
    const timedChunks = toTimedChunks(synthesized, plan.segments);
    const audioSeconds = merged.durationMs / 1000;
    log(
      `  measured narration: ${audioSeconds.toFixed(2)}s at ${merged.sampleRate}Hz ` +
        `(target ${plan.targetDurationSeconds}s).`
    );
    if (audioSeconds > 58) {
      throw new Error(
        `Narration is ${audioSeconds.toFixed(1)}s which exceeds the 58s maximum. Shorten the script instead of speeding it up.`
      );
    }
    // Phase 3: record exactly which voice, speed and model produced this audio.
    const kokoro = kokoroPaths();
    await writeJson(path.join(runDir, "render-metadata.json"), {
      voice: { ...VOICE_PRESET },
      kokoro: { model: kokoro.model, voices: kokoro.voices },
      video: {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        fps: FPS,
        codec: "h264/yuv420p",
        audio: "aac 48000Hz stereo",
      },
      mascot: { ...MASCOT_LAYOUT },
    });

    /* ---------------- Stage 5: mobile capture + timeline ----- */
    currentStage = "timeline";
    history.setRunStage(runId, "timeline");

    const speechEnvelope = await buildSpeechEnvelope(narrationWav);
    await writeJson(path.join(runDir, "speech-envelope.json"), speechEnvelope);

    const captureDir = path.join(workDir, "capture");
    log("Stage 5/9: Capturing the public repository at a real mobile viewport...");
    const capture = await captureMobileRepositoryPage(repo, captureDir);
    for (const warning of capture.warnings) log(`  capture warning: ${warning}`);
    log(
      `  ${capture.source} capture: ${capture.raster.width}x${capture.raster.height}px ` +
        `from ${capture.cssViewport.width}x${capture.cssViewport.height} CSS viewports.`
    );

    const referencedAnchors = [
      ...new Set(
        plan.segments
          .map(segment => segment.visualAnchor)
          .filter((anchor): anchor is VisualAnchor => Boolean(anchor))
      ),
    ];
    const storySpan = chooseStoryEnd({
      anchors: capture.anchors,
      fullHeightPx: capture.raster.height,
      viewportHeightPx: CARD_VIEWPORT_HEIGHT,
      durationMs: merged.durationMs,
      referencedAnchors,
    });
    for (const warning of storySpan.warnings) log(`  story warning: ${warning}`);

    const storyImage = path.join(captureDir, "story-page.jpg");
    const storyCapture = await cropMobileCapture(
      capture,
      storySpan.endPx,
      storyImage
    );
    await writeJson(path.join(runDir, "story.json"), {
      startPx: storySpan.startPx,
      endPx: storyCapture.raster.height,
      fullHeightPx: capture.raster.height,
      source: capture.source,
      referencedAnchors,
      warnings: [...storySpan.warnings, ...capture.warnings],
    });

    const poseFiles = (
      Object.entries(CHARACTER_POSE_PNGS) as Array<
        [CharacterPoseAsset["pose"], string | null]
      >
    )
      .map(([pose, configured]) => ({ pose, file: resolveCharacterAsset(configured) }))
      .filter(
        (entry): entry is { pose: CharacterPoseAsset["pose"]; file: string } =>
          Boolean(entry.file)
      );
    const segmentById = new Map(plan.segments.map(segment => [segment.id, segment]));
    const characterCues: CharacterCue[] = timedChunks.map(chunk => ({
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      pose: characterPoseForSlot(segmentById.get(chunk.segmentId)?.narrativeRole),
    }));

    const output = path.join(OUTPUT_DIR, `${slug}-${runId}.mp4`);
    outputPath = output;
    const assetFiles: Record<string, string> = { "/page.jpg": storyImage };
    for (const { pose, file } of poseFiles) {
      assetFiles[`/character-${pose}.png`] = file;
    }
    const calloutAsset = CALLOUT_PNG;
    if (calloutAsset && fsSync.existsSync(calloutAsset)) {
      assetFiles["/bubble.png"] = calloutAsset;
    }
    const assets = await startAssetServer(assetFiles);
    const pageImageUrl = `${assets.origin}/page.jpg`;
    const calloutImageUrl = calloutAsset ? `${assets.origin}/bubble.png` : null;
    const characterPoses: CharacterPoseAsset[] = poseFiles.map(({ pose }) => ({
      pose,
      url: `${assets.origin}/character-${pose}.png`,
    }));
    const characterUrl = characterPoses[0]?.url ?? null;
    log(
      `  assets served on loopback` +
        (characterPoses.length
          ? ` (presenter ${Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width)}px wide, ${
              characterPoses.length
            } pose${characterPoses.length === 1 ? "" : "s"}).`
          : " (no character asset).") +
        (calloutImageUrl ? " [comic speech bubble ready]" : "")
    );

    try {
      const measured = await measureCard({
        repo,
        pageImageUrl,
        characterUrl,
        characterPoses,
        calloutImageUrl,
      });
      log(
        `  rendered card measured: document ${measured.documentHeight}px, ` +
          `viewport ${measured.viewportHeight}px, caption at y=${Math.round(
            measured.geometry.caption?.top ?? 0
          )}px.`
      );

      const bounds = scrollBounds(measured.documentHeight, measured.viewportHeight);
      const captions = buildCaptions(plan.segments, timedChunks, {
        phonemeTimings: null,
      });
      const effectSeed = `${repo.full_name}-${runId}-v1`;
      // Evidence-backed multi-callouts bound to the measured audio timeline
      const callouts = buildCalloutCues(plan.segments, timedChunks, merged.durationMs, {
        seed: effectSeed,
      });
      // Animated comic impact accents around the character
      const impactBursts = buildImpactBurstCues(
        plan.segments,
        timedChunks,
        callouts,
        merged.durationMs,
        { seed: effectSeed }
      );
      // Synchronized sound effect events (mascot slide-whoosh + callout pop)
      const soundEvents = scheduleSoundEvents(callouts, merged.durationMs);
      const mixedAudioWav = path.join(workDir, "narration-sfx.wav");
      const finalAudioPath = await mixAudioTracks({
        narrationPath: narrationWav,
        soundEvents,
        durationMs: merged.durationMs,
        outputPath: mixedAudioWav,
      });
      for (const phrase of captions) {
        if (!captionFitsPanel(phrase.text)) {
          log(`  caption warning: "${phrase.text}" needs more than two lines`);
        }
      }
      const scrollKeyframes = buildScrollKeyframes({
        segments: plan.segments,
        chunks: timedChunks,
        anchors: storyCapture.anchors,
        documentHeight: measured.documentHeight,
        viewportHeight: measured.viewportHeight,
        durationMs: merged.durationMs,
      });
      const timeline: Timeline = {
        durationMs: merged.durationMs,
        sampleRate: merged.sampleRate,
        chunks: timedChunks,
        captions,
        callouts,
        impactBursts,
        soundEvents,
        scroll: scrollKeyframes,
        anchors: storyCapture.anchors,
        documentHeight: measured.documentHeight,
        viewportHeight: measured.viewportHeight,
        story: {
          startPx: storySpan.startPx,
          endPx: storyCapture.raster.height,
          fullHeightPx: capture.raster.height,
          source: capture.source,
        },
      };
      await writeJson(path.join(runDir, "timeline.json"), timeline);
      await writeAssFromCaptions(captions, path.join(workDir, "captions.ass"));
      log(
        `  ${captions.length} caption phrases, ${scrollKeyframes.length} scroll keyframes, ` +
          `max scroll ${bounds.maxScroll}px.`
      );
      log(
        callouts.length > 0
          ? `  ${callouts.length} callout(s): ` +
            callouts
              .map(c => `[${c.role ?? "idea"}] "${c.text}" for ${c.segmentId} at ${c.startMs}-${c.endMs}ms`)
              .join("; ")
          : "  no callout: no segment had a faithful 3-7 word summary."
      );
      log(`  ${impactBursts.length} comic impact burst(s) scheduled.`);
      log(
        soundEvents.length > 0
          ? `  ${soundEvents.length} synchronized sound effect(s) scheduled: ` +
            soundEvents
              .map(s => `${s.kind ?? "sfx"} at ${s.startMs}ms`)
              .join("; ")
          : "  no sound effects scheduled."
      );

      /* ---------------- Stage 6-7: render + encode ------------- */
      currentStage = "render";
      history.setRunStage(runId, "render");
      const estTotalFrames = Math.round(audioSeconds * 30);
      log(
        `Stage 6/9: Rendering ${audioSeconds.toFixed(2)}s video (${estTotalFrames} frames at 30 fps)...`
      );
      let lastReported = -1;
      const renderStartTime = Date.now();
      const rendered = await renderVideo({
        repo,
        pageImageUrl,
        characterUrl,
        characterPoses,
        characterCues,
        speechEnvelope,
        captions,
        callouts,
        impactBursts,
        calloutImageUrl,
        scrollKeyframes,
        audioPath: finalAudioPath,
        audioDurationMs: merged.durationMs,
        outputPath: output,
        workDir,
        onProgress: (frame, total) => {
          const percent = Math.floor((frame / total) * 100);
          if (percent !== lastReported && (percent % 5 === 0 || frame === 1 || frame === total)) {
            lastReported = percent;
            const elapsedSec = (Date.now() - renderStartTime) / 1000;
            const fps = frame > 0 && elapsedSec > 0 ? (frame / elapsedSec).toFixed(1) : "0.0";
            const remaining = total - frame;
            const etaSec = frame > 0 && elapsedSec > 0 ? Math.round(remaining / (frame / elapsedSec)) : 0;
            const etaMin = Math.floor(etaSec / 60);
            const etaRem = etaSec % 60;
            const etaStr = etaMin > 0 ? `${etaMin}m ${etaRem}s` : `${etaRem}s`;
            log(`  ${percent}% (${frame}/${total} frames) - ${fps} fps - ETA: ~${etaStr}`);
          }
        },
      });
      log(
        `Stage 7/9: Encoded ${rendered.totalFrames} frames to ${path.basename(output)}.`
      );

      const contactSheet = await buildContactSheet(
        rendered.referenceFrames,
        path.join(runDir, "contact-sheet.jpg")
      ).catch(() => null);

      /* ---------------- Stage 8: QA --------------------------- */
      currentStage = "qa";
      history.setRunStage(runId, "qa");
      const coverage = scrollCoverage(scrollKeyframes, merged.durationMs);
      const report = await validateOutput(output, {
        expectedAudioSeconds: audioSeconds,
        expectMotion: Math.max(...coverage) - Math.min(...coverage) > 120,
        motionStops: coverage,
      });
      // The callout/caption overlays are part of the composition, so their
      // timing, copy and geometry are QA gates too — not just render options.
      const overlayChecks = [
        ...calloutChecks(callouts, merged.durationMs),
        ...impactAccentsChecks(impactBursts, merged.durationMs),
        ...soundEventsChecks(soundEvents, merged.durationMs),
        ...overlayLayoutChecks(),
      ];
      report.checks.push(...overlayChecks);
      report.ok = report.ok && overlayChecks.every(check => check.ok);
      const loudness = await measureLoudness(output);
      await writeJson(path.join(runDir, "qa.json"), {
        ...report,
        loudness,
        contactSheet,
      });
      for (const check of report.checks) {
        log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
      }
      if (loudness) {
        log(
          `  loudness: ${loudness.integrated.toFixed(1)} LUFS, true peak ${loudness.truePeak.toFixed(1)} dBTP.`
        );
      }
      if (contactSheet) log(`  contact sheet: ${contactSheet}`);
      if (!report.ok) {
        throw new Error(
          "The rendered video failed QA; the repository was NOT marked complete."
        );
      }
    } finally {
      await assets.close();
    }

    /* ---------------- Stage 9: completion -------------------- */
    currentStage = "qa";
    history.completeRepository(repo.nodeId, output, hashScript(plan));
    history.finishRun(runId, "succeeded", {
      stage: "qa",
      repositoryNodeId: repo.nodeId,
      outputPath: output,
    });
    await flushLog(runDir, runId);

    console.log(`\nFinished.`);
    console.log(`Video:     ${output}`);
    console.log(`Artifacts: ${runDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED at stage "${currentStage}": ${message}`);
    if (repoNodeId) history.failRepository(repoNodeId, currentStage, error);
    history.finishRun(runId, "failed", {
      stage: currentStage,
      repositoryNodeId: repoNodeId,
      outputPath,
      error: error instanceof Error ? { message, stack: error.stack } : { message: String(error) },
    });
    await flushLog(runDir, runId);
    console.error("\nPipeline failed:", message);
    if (error instanceof GitHubApiError) {
      console.error(
        "GitHub rate limiting is the most likely cause. Set GITHUB_TOKEN to raise the limit."
      );
    }
    process.exitCode = 1;
  } finally {
    history.close();
    clearEnrichmentCache();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function hashScript(plan: NarrationPlan): string {
  const text = plan.segments.map(segment => segment.spokenText).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

main().catch(error => {
  console.error("\nPipeline crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});