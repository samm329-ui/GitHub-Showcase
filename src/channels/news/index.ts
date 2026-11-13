import "../../load-env.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  OUTPUT_DIR,
  TEMP_DIR,
  TTS_PAUSE_BETWEEN_SEGMENTS_MS,
} from "../../config.js";
import { groqChatCompletion } from "../../groq.js";
import {
  synthesizeSegments,
  concatChunks,
  toTimedChunks,
} from "../../voice.js";
import type { NarrationSegment } from "../../types.js";
import { validateOutput, measureLoudness } from "../../qa.js";
import { loadRegistry, type RegistryLoadResult } from "./sources.js";
import { discoverCategory, manualUrlItem, CATEGORY_QUERIES, newsLane, type NewsCategory } from "./discovery.js";
import { clusterItems, rankCandidates } from "./clustering.js";
import type { ScoredCandidate } from "./types.js";
import { collectEvidence, verifyClaim, verifyLedger, verifyQuotedMaterial, buildMetadataEvidence, type ProposedClaim } from "./ledger.js";
import { buildInshortsEvidence } from "./inshorts.js";
import { extractClaimsFromEvidence } from "./claims.js";
import {
  draftScript,
  validateNewsScript,
  ScriptError,
} from "./script.js";
import { computePerspectiveCoverage } from "./perspectives.js";
import {
  evaluateGateA,
  evaluateGateB,
  isAutoGatesEnabled,
} from "./auto-gates.js";
import { runResearchAgent } from "./research-agent.js";
import { alignNarration } from "./alignment.js";
import { captionsFromAlignment } from "./captions.js";
import { buildNewsSceneEvents } from "./scene-events.js";
import { buildSourceCredits } from "./credits.js";
import { renderNewsVideo } from "./render-news.js";
import {
  recordGateApproval,
  readApprovalState,
  ApprovalError,
} from "./approvals.js";
import { NewsHistory } from "./history.js";
import type { EpisodeScript, NewsSegment, StoryPackage } from "./types.js";
import type { EvidenceRecord } from "./types.js";

/**
 * Lazy News â€” pipeline entry.
 *
 *   npm run start:news -- --discover [--topic politics] [--dry-run] [--length 65]
 *   npm run start:news -- --url https://pib.gov.in/... --length 65     (evidence + render)
 *   npm run start:news -- --research [--topic politics] [--dry-run]    (Groq-planned iterative research)
 *   npm run start:news -- --approve A|B|C <runDir>                     (record human approval)
 *
 * Stages mirror GITHUB SHOWCASE: discovery â†’ selection â†’ evidence (ledger) â†’
 * narration â†’ TTS â†’ alignment â†’ timeline â†’ render â†’ QA â†’ history.
 * Gates A/B/C are mandatory for human operation; no env var may bypass them.
 * Under explicit opt-in (NEWS_AUTO_GATES=1 or --auto-gates), automated decisions
 * are recorded with approved_by=automated and thin stories are REFUSED â€”
 * never rubber-stamped.
 */

const NEWS_CATEGORIES: NewsCategory[] = [
  "politics", "geopolitics", "ai", "technology", "finance", "environment", "under_covered", "mixed",
];

function args(): string[] {
  return process.argv.slice(2);
}
const hasFlag = (flag: string) => args().includes(flag);
const flagValue = (flag: string): string | null => {
  const i = args().indexOf(flag);
  return i >= 0 ? args()[i + 1] ?? null : null;
};

function log(message: string): void {
  console.log(message);
}

async function writeArtifact(dir: string, name: string, data: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function newsSegmentToNarrationSegment(seg: NewsSegment, index: number): NarrationSegment {
  const purposeMap: Record<NewsSegment["delivery"], NarrationSegment["purpose"]> = {
    dry_hook: "identify",
    measured_explanation: "explain",
    firm_attribution: "caveat",
    dry_observation: "benefit",
    punchline: "cta",
  };
  return {
    id: seg.id,
    purpose: purposeMap[seg.delivery] ?? "explain",
    spokenText: seg.text,
    captionText: seg.text,
    factIds: seg.factIds,
    pauseAfterMs: seg.delivery === "dry_observation" ? 260 : seg.delivery === "punchline" ? 0 : 120,
  };
}

function mapSegments(script: EpisodeScript): NarrationSegment[] {
  return script.narration.map((seg, i) => newsSegmentToNarrationSegment(seg, i));
}

async function main(): Promise<void> {
  const approveArg = flagValue("--approve");
  const runDirArg = flagValue("--run-dir");

  // Approval-only path: record the human's decision, then exit.
  if (approveArg) {
    const runDir = runDirArg ?? path.join(TEMP_DIR, "news-pending");
    const gate = approveArg.toUpperCase();
    if (gate !== "A" && gate !== "B" && gate !== "C") {
      console.error(`--approve expects A, B or C, got "${approveArg}"`);
      process.exit(1);
    }
    const note = flagValue("--note") ?? "approved via CLI";
    const payload = await readPayloadSnapshot(runDir, gate as "A" | "B" | "C");
    const approval = await recordGateApproval(runDir, gate as "A" | "B" | "C", payload, true, note);
    log(`Recorded Gate ${gate} approval (${approval.approvedAt}).`);
    return;
  }

  const discoverMode = hasFlag("--discover") || (!hasFlag("--url") && !hasFlag("--resume") && !hasFlag("--research"));
  const researchMode = hasFlag("--research");
  const dryRun = hasFlag("--dry-run");
  const resumeDir = flagValue("--resume");
  const topicArg = flagValue("--topic");
  const manualUrl = flagValue("--url");
  const evidenceArg = (flagValue("--evidence") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const lengthArg = Number(flagValue("--length") ?? "65");
  const targetSeconds = Number.isFinite(lengthArg) ? Math.max(20, Math.min(90, lengthArg)) : 65;
  const category = (NEWS_CATEGORIES as string[]).includes(topicArg ?? "") ? (topicArg as NewsCategory) : "mixed";
  const AUTO_GATES = isAutoGatesEnabled();
  if (AUTO_GATES) {
    log("NEWS_AUTO_GATES=1 â€” automated gates engaged (opt-in). Thin stories WILL be refused, not narrated.");
  }

  const registry = loadRegistry();
  for (const w of registry.warnings) log(`  permissions: ${w}`);

  const runId = resumeDir
    ? createHash("md5").update(path.resolve(resumeDir)).digest("hex").slice(0, 8)
    : randomUUID().slice(0, 8);
  const slug = manualUrl
    ? hostSlug(manualUrl)
    : resumeDir
      ? path.basename(path.resolve(resumeDir)).replace(/^news-/, "") || "episode"
      : `${category}-${runId.slice(0, 4)}`;
  const runDir = resumeDir ?? path.join(TEMP_DIR, `news-${slug}`);
  await fs.mkdir(runDir, { recursive: true });

  /* ---------------- Stage 1: story selection ---------------- */
  let candidate: ScoredCandidate | null = null;
  let chosenUrl: string;
  let storyTitle: string;
  let storyCategory: string;
  let researchRecords: EvidenceRecord[] | null = null;

  if (resumeDir) {
    const saved = JSON.parse(await fs.readFile(path.join(runDir, "candidate.json"), "utf8")) as {
      url: string; title: string; category: string;
    };
    chosenUrl = saved.url;
    storyTitle = saved.title;
    storyCategory = saved.category;
  } else if (manualUrl) {
    const item = manualUrlItem(manualUrl, registry);
    const clusters = clusterItems([item]);
    const scored = rankCandidates(clusters)[0];
    candidate = scored;
    chosenUrl = item.url;
    storyTitle = item.title;
    storyCategory = scored?.cluster.category ?? category;
  } else if (researchMode) {
    log(`Stage 1: research agent engaged (category: ${category}) â€” Groq plans, Fortress retrieves, determinism verifiesâ€¦`);
    const research = await runResearchAgent({ category, registry, reachBaseUrl: process.env.REACH_MCP_URL, log });
    await writeArtifact(runDir, "research-dossier.json", research.dossier);
    if (research.status === "transport_failed" || research.status === "no_candidates") {
      log(`Research ${research.status === "transport_failed" ? "could not start" : "found nothing"}: ${research.dossier.honestyNote}`);
      await writeArtifact(runDir, "blocked.json", { reason: `research_${research.status}`, detail: research.dossier.honestyNote });
      process.exit(2);
    }
    if (!research.candidate) {
      log("Research produced no selectable story.");
      await writeArtifact(runDir, "blocked.json", { reason: "research_no_candidate" });
      process.exit(2);
    }
    candidate = research.candidate;
    researchRecords = research.records;
    chosenUrl = research.candidate.cluster.items[0].url;
    storyTitle = research.candidate.cluster.canonicalTitle;
    storyCategory = research.candidate.cluster.category;
    const analysis = research.dossier.independentOriginAnalysis;
    log(`  research: status=${research.status} searches=${research.dossier.usage.searches} articlesRead=${research.dossier.usage.articlesRead} llmCalls=${research.dossier.usage.llmCalls} tokens=${research.dossier.usage.totalTokens}`);
    log(`  research: corroborating origins=${analysis.corroboratingOrigins} groups=${analysis.distinctPublisherGroups} metadataOnly=${analysis.metadataOnlyRecords} verdict="${analysis.verdict}"`);
    for (const line of research.dossier.warnings) log(`  research warning: ${line}`);
    for (const gap of research.dossier.gapsEncountered) log(`  research gap (${gap.type}): ${gap.reason.slice(0, 100)}${gap.resolved ? " [searched]" : ""}`);
  } else {
    const lane = newsLane();
    log(`Stage 1: discovering candidates (category: ${category}; lane: ${lane})â€¦`);
    const items = await discoverCategory(category, registry, {}, { maxItems: 250 });
    log(`  ${items.length} discovery signals from the ${lane} lane.`);
    /* Inshorts cards are single stories by design â€” never merge them into one blob.
     * Prefer cards with hard, verifiable numbers/dates over commentary/analysis pieces:
     * the bonus only changes WHO is picked, never WHETHER Gate A passes. */
    const clusters =
      lane === "inshorts" ? items.flatMap(item => clusterItems([item])) : clusterItems(items);
    const exclusion = new Set<string>();
    const scored = rankCandidates(clusters).filter(c => !exclusion.has(c.cluster.clusterId));
    if (lane === "inshorts") {
      /* Headline digits are the cheapest falsifiable hook a commentary video can
       * verify against the 60-word card; analyses without them rarely produce a
       * verifiable core fact. Changes who is picked, never whether Gate A passes. */
      const headlineSignal = (c: ScoredCandidate) => {
        const digits = (c.cluster.canonicalTitle.match(/\d{1,4}/g) ?? []).length;
        return digits >= 2 ? 2 : digits === 1 ? 1 : 0;
      };
      const before = scored[0]?.cluster.canonicalTitle;
      scored.sort((a, b) => headlineSignal(b) - headlineSignal(a) || b.score - a.score);
      if (scored[0] && scored[0].cluster.canonicalTitle !== before) {
        log(`  research: Inshorts ranking preferred a headline with verifiable hard facts over "${before?.slice(0, 60)}"`);
      }
    }
    log(`  ${scored.length} story cluster(s) after dedup.`);
    const eligible = scored.filter(c => c.eligible);
    const best = eligible[0] ?? scored[0] ?? null;
    if (!best) {
      log("Nothing discovered â€” try --topic politics or --url <story URL>.");
      process.exit(2);
    }
    candidate = best;
    chosenUrl = best.cluster.items[0].url;
    storyTitle = best.cluster.canonicalTitle;
    storyCategory = best.cluster.category;
  }
  if (!candidate) {
    // Resume path: rebuild a minimal scored shape from candidate.json if present.
    const fallback = JSON.parse(await fs.readFile(path.join(runDir, "candidate.json"), "utf8")) as { scored: ScoredCandidate };
    candidate = fallback.scored;
  }

  await writeArtifact(runDir, "candidate.json", {
    url: chosenUrl, title: storyTitle, category: storyCategory,
    scored: candidate, capturedAt: new Date().toISOString(),
  });

  /* ---------------- Stage 2: evidence + ledger ---------------- */

  const ledgerPath = path.join(runDir, "evidence-ledger.json");
  let ledger: StoryPackage["ledger"];
  let perspectiveBrief: string[] | undefined;
  let stage2Records: EvidenceRecord[] = [];

  if (resumeDir && fsSync.existsSync(ledgerPath)) {
    ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    // Resume path: reuse the balance brief and records the first run persisted.
    const coveragePath = path.join(runDir, "perspective-coverage.json");
    if (fsSync.existsSync(coveragePath)) {
      try {
        const saved = JSON.parse(await fs.readFile(coveragePath, "utf8")) as { brief?: string[] };
        perspectiveBrief = saved.brief;
      } catch {
        perspectiveBrief = undefined;
      }
    }
    const recordsPath = path.join(runDir, "source-records.json");
    if (fsSync.existsSync(recordsPath)) {
      try {
        stage2Records = JSON.parse(await fs.readFile(recordsPath, "utf8")) as EvidenceRecord[];
      } catch {
        stage2Records = [];
      }
    }
  } else {
    const records: EvidenceRecord[] = [];
    const inshortsCards = (candidate?.cluster.items ?? []).filter(
      item => item.sourcePolicy?.sourceId === "inshorts.com"
    );
    if (inshortsCards.length > 0) {
      log(`Stage 2: evidence = the ${inshortsCards.length} Inshorts card(s) for this story (60-word summary) â€” attributed, single origin, no external fetch.`);
      records.push(...buildInshortsEvidence(inshortsCards));
    } else if (researchRecords) {
      log(`Stage 2: evidence already collected by the research agent (${researchRecords.length} record(s)) â€” not re-fetching.`);
      records.push(...researchRecords);
    } else {
      const clusterItems = candidate?.cluster.items ?? [];
      /* Full-text evidence for outlets that permit it; metadata-only evidence for
       * discovery-tier outlets (never a dead stop when metadata is licensed). */
      const fullTextUrls = new Set<string>(evidenceArg.filter(u => isEvidencePermitted(u, registry)));
      const metadataItems: typeof clusterItems = [];
      for (const item of clusterItems) {
        if (isEvidencePermitted(item.url, registry)) fullTextUrls.add(item.url);
        else metadataItems.push(item);
      }
      const keywords = (storyTitle.split(/\s+/).filter(w => w.length > 4).slice(0, 10)) || [storyTitle];

      if (fullTextUrls.size > 0) {
        log(`Stage 2: collecting evidence from ${fullTextUrls.size} permitted source(s)â€¦`);
        const fetched = await collectEvidence([...fullTextUrls], registry, keywords, {});
        records.push(...fetched);
      }
      const metadata = buildMetadataEvidence(metadataItems, registry);
      if (metadata.length > 0) {
        log(`Stage 2: ${metadata.length} discovery-tier outlet(s) contribute metadata-only evidence (attributed single-source).`);
        records.push(...metadata);
      }
    }
    if (records.length === 0) {
      log(
        "No permitted evidence. The selected story has no usable metadata (out-of-registry outlet or empty description); " +
          "add a reviewed source entry to config/news-sources.json or pass primary-record URLs via --evidence."
      );
      await writeArtifact(runDir, "blocked.json", {
        reason: "missing_permitted_evidence",
        url: chosenUrl,
        hint: "Pass --evidence with primary-record URLs, or add the outlet to config/news-sources.json.",
      });
      process.exit(2);
    }
    stage2Records = records;
    const metadataOnly = records.every(r => (r.locator ?? "").startsWith("rss-metadata"));
    const coverage = computePerspectiveCoverage(records);
    perspectiveBrief = coverage.brief;
    if (!resumeDir) {
      await writeArtifact(runDir, "perspective-coverage.json", coverage);
    }
    for (const line of coverage.brief) log(`  perspectives: ${line}`);
    if (coverage.singlePerspective) {
      log("  âš  SINGLE-PERSPECTIVE evidence â€” the episode would inherit one side's frame. Corroborate across the spectrum before approving Gate A.");
    }
    for (const r of records) log(`  evidence: ${r.sourceId} (${r.locator?.startsWith("rss-metadata") ? "metadata-only" : "full text"})`);

    /* Atomic claims â€” deterministic by default. Groq is used ONLY for the
     * narration script, never for pulling facts out of evidence. The
     * `--assist claims` flag re-enables the LLM proposal path for comparison. */
    let proposed: ProposedClaim[];
    if (hasFlag("--assist") && flagValue("--assist") === "claims") {
      log("Stage 2: proposing atomic claims (Groq, --assist claims)â€¦");
      proposed = await proposeClaims(records.map(r => excerptBundle(r)).join("\n\n---\n\n"), storyTitle, metadataOnly);
    } else {
      log("Stage 2: extracting atomic claims deterministically (no AI in the data path)â€¦");
      proposed = extractClaimsFromEvidence(records, { maxClaims: 12 });
    }
    if (proposed.length === 0) {
      log("No atomic claims extracted â€” the evidence excerpt is too thin to write an episode from. Cannot render.");
      await writeArtifact(runDir, "blocked.json", { reason: "no_claims_extracted", url: chosenUrl });
      process.exit(2);
    }
    log(`  ${proposed.length} candidate claim(s) extracted.`);

    /* Deterministic verification. */
    const facts = proposed.map((claim, i) => verifyClaim(claim, records, i));
    const quoteErrors = verifyQuotedMaterial(facts);
    for (const e of quoteErrors) log(`  quote-check: ${e}`);
    ledger = verifyLedger(facts, `story_${runId}`);
    ledger.verifierErrors.push(...quoteErrors);
    if (quoteErrors.length > 0) ledger.verifierPassed = false;

    const storyPackage: StoryPackage = {
      storyId: `story_${runId}`,
      workingTitle: storyTitle.slice(0, 110),
      category: storyCategory,
      editorialState: candidate?.editorialState ?? "established",
      cluster: candidate!.cluster,
      scored: candidate!,
      sources: records as StoryPackage["sources"],
      ledger,
      gateAApproval: null,
    };
    await writeArtifact(runDir, "evidence-ledger.json", ledger);
    await writeArtifact(runDir, "source-records.json", records);
    await writeArtifact(runDir, "story-package.json", storyPackage);
  }

  log(`Stage 2: ledger facts=${ledger.facts.length} verifierPassed=${ledger.verifierPassed}`);
  for (const err of ledger.verifierErrors) log(`  âœ— ${err}`);
  for (const warn of ledger.verifierWarnings) log(`  ! ${warn}`);
  if (!ledger.verifierPassed) {
    log("EVIDENCE_VERIFICATION_FAILED â€” cannot render. Fix claims/evidence and re-run.");
    process.exit(2);
  }

  /* ---------------- Gate A (mandatory) ---------------- */
  if (AUTO_GATES) {
    const decision = evaluateGateA(ledger, stage2Records);
    if (decision.approved) {
      await recordGateApproval(runDir, "A", {
        facts: ledger.facts.map(f => [f.id, f.status, f.claim]),
        verifierPassed: ledger.verifierPassed,
        records: stage2Records.map(r => ({ sourceId: r.sourceId, url: r.url })),
      }, true, decision.note);
      log(`Gate A: AUTOMATED APPROVAL â€” ${decision.note}`);
    } else {
      log(`GATE_A_REFUSED (auto) â€” ${decision.reason}`);
      log("The episode is closed. No mp4 will be produced â€” the evidence was too thin.");
      await writeArtifact(runDir, "blocked.json", {
        reason: "gate_a_refused",
        gate: "A",
        detail: decision.reason,
        note: decision.note,
      });
      process.exit(2);
    }
  }

  const approvals = await readApprovalState(runDir);
  if (!approvals.gateA?.approved) {
    await writeDryRunReport(runDir, "facts", { candidate, ledger });
    log(
      `\nGate A (factual package) NOT approved. Review ${path.join(runDir, "review-facts.html")}\n` +
        `Then: npm run start:news -- --approve A --run-dir "${runDir}" [--note "â€¦"]\n` +
        `then re-run with --resume "${runDir}".`
    );
    process.exit(3);
  }

  /* ---------------- Stage 3: scripting ---------------- */
  const scriptPath = path.join(runDir, "script.json");
  let script: EpisodeScript;
  if (resumeDir && fsSync.existsSync(scriptPath)) {
    script = JSON.parse(await fs.readFile(scriptPath, "utf8")) as EpisodeScript;
  } else {
    log(`Stage 3: drafting script with Groq (ledger-grounded, target ${targetSeconds}s)â€¦`);
    try {
      const draft = await draftScript(ledger, storyTitle, { targetSeconds, log, perspectiveBrief });
      script = draft.plan;
      await writeArtifact(runDir, "llm-script.json", { script, usage: draft.usage });
    } catch (error) {
      if (error instanceof ScriptError) {
        log(`SCRIPT_DRAFT_FAILED â€” ${error.message}`);
        process.exit(2);
      }
      throw error;
    }
  }

  const validation = validateNewsScript(script, ledger, 90);
  await writeArtifact(runDir, "script-quality.json", validation);
  log(`Stage 3: words=${validation.words} est=${validation.estimatedSeconds}s errors=${validation.errors.length} warnings=${validation.warnings.length}`);
  for (const err of validation.errors) log(`  âœ— ${err}`);
  for (const warn of validation.warnings) log(`  ! ${warn}`);
  if (!validation.ok) process.exit(2);
  await writeArtifact(runDir, "script.json", script);

  /* ---- Script dataset: phase 1 â€” persist the script as drafted ---- */
  try {
    const { saveDatasetRecord } = await import("../../script-dataset.js");
    const gates = await readApprovalState(runDir);
    await saveDatasetRecord({
      id: `${slug}-${runId}`,
      channel: "news",
      phase: "pending",
      title: script.workingTitle,
      subject: chosenUrl,
      runId,
      invocation: {
        kind: manualUrl ? "url" : "discover",
        detail: manualUrl ?? topicArg ?? null,
      },
      script: {
        segments: script.narration,
        estimatedWords: validation.words,
        estimatedSeconds: validation.estimatedSeconds,
      },
      approvals: {
        gateA: gates.gateA?.approved ?? false,
        gateB: gates.gateB?.approved ?? false,
      },
    });
    log(`  dataset: script saved to dataset/news/${slug}-${runId}.json`);
  } catch (error) {
    log(`  dataset: could not save script (${(error as Error).message}) â€” continuing`);
  }

  /* ---------------- Gate B (mandatory) ---------------- */
  if (AUTO_GATES) {
    const decision = evaluateGateB(ledger, script, validation.ok);
    if (decision.approved) {
      await recordGateApproval(runDir, "B", {
        title: script.workingTitle,
        lines: script.narration.map(n => [n.id, n.text]),
      }, true, decision.note);
      log(`Gate B: AUTOMATED APPROVAL â€” ${decision.note}`);
    } else {
      log(`GATE_B_REFUSED (auto) â€” ${decision.reason}`);
      log("The episode is closed. No mp4 will be produced â€” the script failed its automated review.");
      await writeArtifact(runDir, "blocked.json", {
        reason: "gate_b_refused",
        gate: "B",
        detail: decision.reason,
        note: decision.note,
      });
      process.exit(2);
    }
  }

  const approvals2 = await readApprovalState(runDir);
  if (!approvals2.gateB?.approved) {
    await writeDryRunReport(runDir, "script", { script, validation, ledger });
    log(
      `\nGate B (script + voice note) NOT approved. Review ${path.join(runDir, "review-script.html")}\n` +
        `Then: npm run start:news -- --approve B --run-dir "${runDir}" [--note "â€¦"]\n` +
        `then re-run with --resume "${runDir}".`
    );
    process.exit(3);
  }

  /* ---------------- Stage 4: TTS + alignment ---------------- */
  const skipAudio = hasFlag("--skip-audio");
  const newsVoice = process.env.NEWS_VOICE ?? "am_michael";
  const newsSpeed = Number(process.env.NEWS_VOICE_SPEED ?? "0.98");
  const newsLang = process.env.NEWS_LANG ?? "en-us";
  const narrationPath = path.join(runDir, "narration.wav");
  const alignmentPath = path.join(runDir, "narration-alignment.json");
  const alignmentCache = alignmentPath;

  let durationMs: number;
  let alignment: Awaited<ReturnType<typeof alignNarration>>;
  let segmentTimings: { id: string; startMs: number; endMs: number }[];
  let timedChunks: Awaited<ReturnType<typeof toTimedChunks>>;

  const videoReusable = fsSync.existsSync(narrationPath)
    && fsSync.existsSync(alignmentCache)
    && fsSync.existsSync(path.join(runDir, "timed-chunks.json"));
  if (skipAudio && videoReusable) {
    log("Stage 4: reusing narration.wav and narration-alignment.json (--skip-audio).");
    timedChunks = [];
    const segmentsJson = JSON.parse(await fs.readFile(path.join(runDir, "timed-chunks.json"), "utf8")) as typeof timedChunks;
    timedChunks = segmentsJson;
    durationMs = timedChunks.reduce((acc, c) => Math.max(acc, c.endMs), 0) || 49264;
    alignment = JSON.parse(await fs.readFile(alignmentCache, "utf8"));
    segmentTimings = timedChunks.map(c => ({ id: c.segmentId, startMs: c.startMs, endMs: c.endMs }));
  } else {
    log(`Stage 4: synthesizing ${script.narration.length} chunks (voice=${newsVoice}, speed=${newsSpeed})â€¦`);
    const narrationSegments = mapSegments(script);
    const audioDir = path.join(runDir, "audio");
    const chunks = await synthesizeSegments(narrationSegments, audioDir, { voice: newsVoice, speed: newsSpeed, lang: newsLang });
    const measured = await concatChunks(chunks, narrationPath, TTS_PAUSE_BETWEEN_SEGMENTS_MS, narrationSegments);
    timedChunks = toTimedChunks(chunks, narrationSegments, TTS_PAUSE_BETWEEN_SEGMENTS_MS);
    durationMs = timedChunks.reduce((acc, c) => Math.max(acc, c.endMs), 0) || measured.durationMs;
    log(`Stage 4: measured ${measured.durationMs}ms (${(measured.durationMs / 1000).toFixed(1)}s)`);

    // Persist the exact spoken transcript for transcript-conditioned alignment.
    const spokenTranscript = script.narration.map(s => s.text).join(" ");
    await writeArtifact(runDir, "script-spoken.txt", spokenTranscript);
    await writeArtifact(runDir, "segments.json", narrationSegments.map(s => ({ id: s.id, spokenText: s.spokenText })));
    await writeArtifact(runDir, "timed-chunks.json", timedChunks);
    await fs.writeFile(path.join(runDir, "audio-duration.txt"), String(durationMs));

    log("Stage 4: aligning words to narration (transcript-conditioned forced alignment)â€¦");
    alignment = await alignNarration({
      audioPath: narrationPath,
      spokenTranscriptPath: path.join(runDir, "script-spoken.txt"),
      segmentsJsonPath: path.join(runDir, "segments.json"),
      outPath: alignmentPath,
    });
    log(`Stage 4: alignment ${alignment.alignmentSource} coverage=${(alignment.coverage * 100).toFixed(1)}% monotonic=${alignment.monotonic}`);
    segmentTimings = timedChunks.map(c => ({ id: c.segmentId, startMs: c.startMs, endMs: c.endMs }));
    if (!alignment.monotonic) {
      log("ALIGN_MONOTONICITY_FAILED â€” refusing to build captions from unreliable timings.");
      process.exit(2);
    }
    const NEWS_ALIGN_DEGRADED = process.env.NEWS_ALIGN_DEGRADED === "1";
    if (alignment.coverage < 0.99 && !NEWS_ALIGN_DEGRADED) {
      log(`ALIGNMENT_COVERAGE_BELOW_99 (${(alignment.coverage * 100).toFixed(1)}%) â€” refusing to proceed. Set NEWS_ALIGN_DEGRADED=1 to proceed with flagged QA.`);
      process.exit(2);
    }
  }

  /* ---------------- Stage 5: timeline + scene events + credits ---------------- */
  const events = buildNewsSceneEvents({ script, timeline: segmentTimings, targetMs: durationMs });
  const captions = captionsFromAlignment(script, alignment.words, segmentTimings);
  const credits = buildSourceCredits(ledger, new Date().toISOString());
  await writeArtifact(runDir, "scene-events.json", events);
  await writeArtifact(runDir, "captions.json", captions);
  await writeArtifact(runDir, "source-credits.json", credits);

  /* ---- Script dataset: phase 2 â€” measured audio + approvals known ---- */
  try {
    const { saveDatasetRecord } = await import("../../script-dataset.js");
    await saveDatasetRecord({
      id: `${slug}-${runId}`,
      channel: "news",
      phase: "completed",
      title: script.workingTitle,
      subject: chosenUrl,
      runId,
      script: {
        segments: script.narration,
        estimatedWords: validation.words,
        estimatedSeconds: validation.estimatedSeconds,
      },
      alignment: {
        durationMs,
        coverage: alignment.coverage,
        alignmentSource: alignment.alignmentSource,
      },
      approvals: {
        gateA: approvals.gateA?.approved ?? false,
        gateB: approvals2.gateB?.approved ?? false,
      },
    });
  } catch (error) {
    log(`  dataset: could not mark script completed (${(error as Error).message}) â€” continuing`);
  }
  log(`Stage 5: ${events.length} scene events, ${captions.length} caption phrases, credits="${credits.headline}"`);

  /* ---------------- Stage 6: render + encode ---------------- */
  if (dryRun) {
    log("--dry-run set: stopping before render.");
    process.exit(0);
  }
  const outputDir = path.join(OUTPUT_DIR, "news");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${slug}-${runId}.mp4`);
  log(`Stage 6: rendering ${(durationMs / 1000).toFixed(1)}s @30fps â†’ ${path.basename(outputPath)}`);
  const { referenceFrames } = await renderNewsVideo({
    script,
    captions,
    events,
    audioPath: narrationPath,
    audioDurationMs: durationMs,
    workDir: path.join(runDir, "work"),
    outputPath,
    fps: 30,
    maxDurationSeconds: 90,
    onProgress: (frame, total) => {
      if (frame % 60 === 0) log(`  frame ${frame}/${total}`);
    },
  });

  /* ---------------- Stage 7: QA ---------------- */
  const qaReport = await validateOutput(outputPath, {
    expectedWidth: 1080,
    expectedHeight: 1920,
    expectedFps: 30,
    expectedAudioSeconds: Math.round((durationMs / 1000) * 100) / 100,
    maxDurationSeconds: 90,
  });
  let loudness = null;
  try { loudness = await measureLoudness(narrationPath); } catch { /* non-fatal */ }
  const qaNews = {
    ...qaReport,
    newsChecks: {
      verifierPassed: ledger.verifierPassed,
      gateA: approvals.gateA?.approved ?? false,
      gateB: approvals2.gateB?.approved ?? false,
      coverage: alignment.coverage,
      monotonic: alignment.monotonic,
      captions: captions.length,
      creditsHeadline: credits.headline,
      loudness,
    },
  };
  await writeArtifact(runDir, "qa.json", qaNews);
  log(`Stage 7: QA ${qaReport.ok ? "PASS" : "FAIL"} (${qaReport.checks.filter(c => !c.ok).map(c => c.name).join(", ") || "all checks green"})`);
  if (!qaReport.ok) process.exit(2);

  if (AUTO_GATES) {
    await recordGateApproval(runDir, "C", {
      qa: qaReport.checks?.filter(c => !c.ok),
      loudness,
      creditsHeadline: credits.headline,
    }, true, `automated: gateC PASS â€” QA ${qaReport.checks?.filter(c => !c.ok).length ?? 0} failing checks; loudness ${loudness ? "measured" : "n/a"}`);
    log("Gate C: AUTOMATED APPROVAL recorded (render QA passed).");
  }

  /* Script dataset: attach the output artifact to the record */
  try {
    const { updateDatasetRecord } = await import("../../script-dataset.js");
    await updateDatasetRecord("news", `${slug}-${runId}`, {
      output: path.relative(process.cwd(), outputPath),
    });
  } catch {
    /* dataset is archival; never block completion on it */
  }

  /* ---------------- Stage 8: history ---------------- */
  const history = new NewsHistory();
  try {
    history.recordCandidate(
      `story_${runId}`, chosenUrl, storyTitle, storyCategory,
      candidate!.cluster.clusterId, JSON.stringify(candidate!.cluster)
    );
    history.recordSources(`story_${runId}`, ledger.facts[0]?.evidence.map(e => ({
      url: e.url, publisher: e.publisher, group: e.parentPublisherGroup,
      wireOrigin: e.wireOrigin, role: e.sourceRole,
      independenceStatus: e.independenceStatus, supports: e.supports,
    })) ?? []);
    history.recordFacts(`story_${runId}`, ledger.facts.map(f => ({
      id: f.id, claim: f.claim, kind: f.kind, status: f.status,
      importance: f.importance, independenceCount: f.independenceCount,
      confidence: f.confidence, asOf: f.asOf,
    })));
    history.createEpisode(runId, `story_${runId}`, chosenUrl, storyTitle, storyCategory);
    history.markEpisodeStatus(runId, "completed");
  } finally {
    history.close();
  }

  log(`\nDone: ${outputPath}`);
  for (const f of referenceFrames) log(`  reference frame: ${f}`);
  log(`Episode artifacts: ${runDir}`);

  function isEvidencePermitted(url: string, reg: RegistryLoadResult): boolean {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      const match = reg.policies.find(p => p.enabled && (host === p.domain || host.endsWith(`.${p.domain}`) || p.domain.endsWith(`.${host}`)));
      return Boolean(match?.fullTextFetchAllowed);
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function hostSlug(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "story";
  } catch {
    return "story";
  }
}

function excerptBundle(record: { excerpt?: string; publisher: string; sourceId: string; url: string }): string {
  return `[${record.sourceId}] ${record.publisher}\n${record.url}\n${record.excerpt ?? ""}`;
}

async function proposeClaims(evidenceText: string, storyTitle: string, metadataOnly = false): Promise<ProposedClaim[]> {
  const prompt = [
    "Extract 5-12 atomic, checkable claims from the evidence below for the story:",
    `Story: ${storyTitle}`,
    "",
    evidenceText,
    "",
    "Rules: one sentence per claim; allegations marked as allegations; company/authority wording preserved;",
    "FIRST-PARTY COMPANY ANNOUNCEMENTS ARE CLAIMS, NOT FACTS: whenever the source is a company boasting about its own product (speed, power, 'frontier', 'strongest', 'first'), the claim text must itself read as what the company says, e.g. 'Google says Gemini 4 Carbon is its strongest model...', never as independently verified fact;",
    ...(metadataOnly ? [
      "METADATA-ONLY EVIDENCE: the excerpts above are RSS metadata (headlines + one-line descriptions), never article bodies.",
      "Attribute EVERY claim to the outlet itself using 'according to <outlet>' or '<outlet> reports...'. Do NOT invent any number, name, date or quote that is not present in the metadata. Do NOT upgrade announcements to verified facts. If the metadata is thin, produce fewer, safer claims.",
      "NO verbatim quotations in metadata mode. Recast quoted material as attributed paraphrase ('...told BBC it was meant to make room for production of its Cybercabs'), never as a quoted string.",
    ] : []),
    "kind âˆˆ event|date|number|quote|identity|legal_status|cause|effect|claim_by_actor|forecast|analysis;",
    "contentClass âˆˆ fact|interpretation (use 'interpretation' for analysis or forward-looking statements);",
    "importance âˆˆ core|supporting|optional.",
    "DO NOT extract claims about the article itself: no publisher identity/ownership/URL/section/language facts â€” the story is what it SAYS, not its own bibliographic record.",
    "Respond with ONLY JSON: {\"claims\": [{\"claim\": \"...\", \"kind\": \"...\", \"importance\": \"...\", \"contentClass\": \"...\", \"attribution\": null, \"quotes\": []}]}",
  ].join("\n");
  try {
    const completion = await groqChatCompletion(
      [
        { role: "system", content: "You are a meticulous fact-extraction assistant. You output only valid JSON." },
        { role: "user", content: prompt },
      ],
      { maxTokens: 1800, log: (line) => console.log(`  ${line}`) }
    );
    const parsed = JSON.parse(completion.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "")) as { claims?: ProposedClaim[] };
    return (parsed.claims ?? []).slice(0, 14);
  } catch {
    return [];
  }
}

async function readPayloadSnapshot(runDir: string, gate: "A" | "B" | "C"): Promise<unknown> {
  try {
    if (gate === "A") {
      const ledger = JSON.parse(await fs.readFile(path.join(runDir, "evidence-ledger.json"), "utf8"));
      return { facts: ledger.facts.map((f: { id: string; status: string; claim: string }) => [f.id, f.status, f.claim]), verifierPassed: ledger.verifierPassed };
    }
    const script = JSON.parse(await fs.readFile(path.join(runDir, "script.json"), "utf8"));
    return { title: script.workingTitle, lines: script.narration.map((n: { id: string; text: string }) => [n.id, n.text]) };
  } catch {
    return { runDir, note: "payload snapshot unavailable" };
  }
}

async function writeDryRunReport(runDir: string, stage: "facts" | "script", payload: Record<string, unknown>): Promise<void> {
  const html = [
    "<!doctype html><meta charset='utf-8'><title>Lazy News review</title>",
    "<style>body{font-family:Georgia,serif;max-width:880px;margin:2rem auto;padding:0 1rem;background:#f5f2ea;color:#222}",
    "code,pre{background:#eceadf;padding:2px 6px;border-radius:4px}pre{white-space:pre-wrap;padding:12px}",
    "h1{border-bottom:3px solid #111;padding-bottom:8px} .ok{color:#0a6e1e}.bad{color:#a30000}</style>",
    `<h1>Lazy News â€” Gate ${stage === "facts" ? "A (factual package)" : "B (script)"} review</h1>`,
    "<pre>",
    JSON.stringify(payload, null, 2).replace(/</g, "&lt;"),
    "</pre>",
    "<p><em>Approval command: npm run start:news -- --approve ",
    stage === "facts" ? "A" : "B",
    ` --run-dir "${runDir.replace(/"/g, '&quot;')}"</em></p>`,
  ].join("");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, stage === "facts" ? "review-facts.html" : "review-script.html"), html);
}

main().catch(error => {
  if (error instanceof ApprovalError) {
    console.error(`\n${error.message}`);
    process.exit(3);
  }
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});


