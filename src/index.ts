import fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
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
  TTS_SPEED,
  TTS_VOICE,
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
import { buildNarrationPlan, type PhraseHistory, validateScript } from "./narration.js";
import { concatChunks, synthesizeSegments, toTimedChunks } from "./voice.js";
import { buildCaptions, buildScrollKeyframes } from "./timeline.js";
import { measureCard } from "./browser-capture.js";
import { renderVideo } from "./render.js";
import { validateOutput, measureLoudness } from "./qa.js";
import { writeAssFromCaptions } from "./captions.js";
import type {
  CandidateEvaluation,
  DiscoveryMode,
  EnrichedRepo,
  NarrationPlan,
  StageName,
  Timeline,
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
      : history.reserveRepository(repo.nodeId, runId);
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

    /* ---------------- Stage 3: narration --------------------- */
    currentStage = "narration";
    history.setRunStage(runId, "narration");
    const recentUsage = loadPhraseHistory();
    const plan: NarrationPlan = buildNarrationPlan(ledger, repo, {
      targetDurationSeconds: TARGET_DURATION_SECONDS,
      voiceId: TTS_VOICE,
      speed: TTS_SPEED,
      recentUsage,
      attemptCount: reserved?.attempt_count ?? 0,
    });
    const validation = validateScript(plan, ledger);
    await writeJson(path.join(runDir, "narration.json"), plan);
    for (const warning of validation.warnings) log(`  script warning: ${warning}`);
    if (!validation.ok) {
      throw new Error(`Script validation failed:\n  - ${validation.errors.join("\n  - ")}`);
    }
    log(
      `Stage 3/9: "${plan.styleVariant}" (${plan.angle}) — ` +
        `${plan.segments.length} segments, ${validation.words} words, ` +
        `~${validation.estimatedSeconds.toFixed(1)}s estimated.`
    );
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
    const merged = await concatChunks(synthesized, narrationWav);
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

    /* ---------------- Stage 5: timeline ---------------------- */
    currentStage = "timeline";
    history.setRunStage(runId, "timeline");
    const measured = await measureCard(repo);
    log(
      `Stage 5/9: Rendered card measured — document ${measured.documentHeight}px, ` +
        `viewport ${measured.viewportHeight}px, anchors ${measured.anchors.map(a => a.anchor).join(", ")}.`
    );
    const bounds = scrollBounds(measured.documentHeight, measured.viewportHeight);
    const captions = buildCaptions(plan.segments, timedChunks, { phonemeTimings: null });
    const scrollKeyframes = buildScrollKeyframes({
      segments: plan.segments,
      chunks: timedChunks,
      anchors: measured.anchors,
      documentHeight: measured.documentHeight,
      viewportHeight: measured.viewportHeight,
    });
    const timeline: Timeline = {
      durationMs: merged.durationMs,
      sampleRate: merged.sampleRate,
      chunks: timedChunks,
      captions,
      scroll: scrollKeyframes,
      anchors: measured.anchors,
      documentHeight: measured.documentHeight,
      viewportHeight: measured.viewportHeight,
    };
    await writeJson(path.join(runDir, "timeline.json"), timeline);
    await writeAssFromCaptions(captions, path.join(workDir, "captions.ass"));
    log(
      `  ${captions.length} caption phrases, ${scrollKeyframes.length} scroll keyframes, ` +
        `max scroll ${bounds.maxScroll}px.`
    );

    /* ---------------- Stage 6-7: render + encode ------------- */
    currentStage = "render";
    history.setRunStage(runId, "render");
    const output = path.join(OUTPUT_DIR, `${slug}-${runId}.mp4`);
    outputPath = output;
    log(`Stage 6/9: Rendering ${audioSeconds.toFixed(2)}s of stationary-card frames...`);
    let lastReported = -1;
    const rendered = await renderVideo({
      repo,
      captions,
      scrollKeyframes,
      audioPath: narrationWav,
      audioDurationMs: merged.durationMs,
      outputPath: output,
      workDir: workDir,
      onProgress: (frame, total) => {
        const percent = Math.floor((frame / total) * 100);
        if (percent !== lastReported && percent % 20 === 0) {
          lastReported = percent;
          log(`  ${percent}% (${frame}/${total} frames)`);
        }
      },
    });
    log(`Stage 7/9: Encoded ${rendered.totalFrames} frames to ${path.basename(output)}.`);

    /* ---------------- Stage 8: QA --------------------------- */
    currentStage = "qa";
    history.setRunStage(runId, "qa");
    const report = await validateOutput(output, { expectedAudioSeconds: audioSeconds });
    const loudness = await measureLoudness(output);
    await writeJson(path.join(runDir, "qa.json"), { ...report, loudness });
    for (const check of report.checks) {
      log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    if (loudness) {
      log(`  loudness: ${loudness.integrated.toFixed(1)} LUFS, true peak ${loudness.truePeak.toFixed(1)} dBTP.`);
    }
    if (!report.ok) {
      throw new Error("The rendered video failed QA; the repository was NOT marked complete.");
    }

    /* ---------------- Stage 9: completion -------------------- */
    currentStage = "qa";
    history.completeRepository(repo.nodeId, output, hashScript(plan));
    history.finishRun(runId, "succeeded", {
      stage: "qa",
      repositoryNodeId: repo.nodeId,
      outputPath: output,
    });
    savePhraseHistory(recentUsage, plan.styleVariant);
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

/* ------------------------------------------------------------------ */
/* Style-variant memory                                                */
/* ------------------------------------------------------------------ */

function historyPath(): string {
  return path.join(OUTPUT_DIR, "script-style-history.json");
}

function loadPhraseHistory(): PhraseHistory {
  const usage: PhraseHistory = new Map();
  try {
    const raw = JSON.parse(
      readFileSync(historyPath(), "utf8")
    ) as Record<string, number>;
    for (const [key, value] of Object.entries(raw)) usage.set(key, value);
  } catch {
    // A missing or malformed file just means "no memory yet".
  }
  return usage;
}

function savePhraseHistory(usage: PhraseHistory, styleVariant: string): void {
  usage.set(styleVariant, (usage.get(styleVariant) ?? 0) + 1);
  usage.set("__turn__", (usage.get("__turn__") ?? 0) + 1);
  try {
    writeFileSync(historyPath(), JSON.stringify(Object.fromEntries(usage), null, 2), "utf8");
  } catch {
    // Style memory is best-effort; losing it must not fail a run.
  }
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