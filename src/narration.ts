import type {
  EnrichedRepo,
  FactLedger,
  NarrationAngle,
  NarrationPlan,
  NarrationSegment,
  ScriptValidation,
  SegmentPurpose,
} from "./types.js";
import {
  ESTIMATED_WPM,
  MAX_DURATION_SECONDS,
  MAX_REPEATED_TEMPLATE_USAGE,
  MIN_DURATION_SECONDS,
  TARGET_DURATION_SECONDS,
  TTS_SPEED,
  TTS_VOICE,
} from "./config.js";
import {
  bulletsOf,
  extractInstall,
  factsOfKind,
  narratableFacts,
  parseReadme,
  sectionWithBullets,
} from "./facts.js";
import { buildStory, humaniseRepoName } from "./narration-grammar.js";
import { compileRepoNarration, validateNarration } from "./narration-ir.js";
import { prepareTtsText } from "./tts-text.js";
import type { StorySlot } from "./types.js";

/**
 * Narration generation without an LLM.
 *
 * The script is assembled by `narration-grammar.ts` from a typed fact ledger:
 * a constrained sequence of story slots, each bound to verified fact ids. This
 * module keeps the public API (angle selection, variant memory, validation) and
 * turns the grammar's clauses into timed narration segments.
 *
 * Anything that cannot be traced to a fact is never said. Variation comes from
 * choosing a different structure for the same evidence — never from shuffling
 * synonyms or inventing claims.
 */

/* ------------------------------------------------------------------ */
/* Boilerplate guard                                                   */
/* ------------------------------------------------------------------ */

const BANNED_PHRASES = [
  "game changer",
  "revolutionary",
  "super powerful",
  "you need to check this out",
  "in today's video",
  "in this video",
  "must have",
  "hidden gem",
  "mind blowing",
  "next level",
  "blazing fast",
  "seamlessly",
  "effortlessly",
  "cutting edge",
  "world class",
  "best tool",
  "the best",
  "fastest",
];

export function findBoilerplate(text: string): string[] {
  const lowered = text.toLowerCase();
  return BANNED_PHRASES.filter(phrase => lowered.includes(phrase));
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function estimateSeconds(words: number): number {
  return (words / ESTIMATED_WPM) * 60;
}

/** Stable 32-bit hash so a repository keeps the same variant across runs. */
export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Pick one index, honouring how recently each template was used. `recentUsage`
 * maps template key -> number of recent runs it appeared in.
 */
export function pickVariant<T>(
  keys: string[],
  recentUsage: Map<string, number>,
  seed: number
): { key: string; index: number } {
  const eligible = keys.filter(
    key => (recentUsage.get(key) ?? 0) < MAX_REPEATED_TEMPLATE_USAGE
  );
  const pool = eligible.length > 0 ? eligible : keys;
  const index = seed % pool.length;
  return { key: pool[index], index };
}

export type PhraseHistory = Map<string, number>;

/** Humanise a repository name for speech: "rocket-cli" -> "Rocket CLI". */
export function niceRepoName(name: string): string {
  return humaniseRepoName(name);
}

/* ------------------------------------------------------------------ */
/* Angle selection                                                     */
/* ------------------------------------------------------------------ */

export type AngleDecision = {
  angle: NarrationAngle;
  reason: string;
  templateKeys: string[];
};

export function selectAngle(
  ledger: FactLedger,
  repo: EnrichedRepo
): AngleDecision {
  const features = factsOfKind(ledger, "feature");
  const install = factsOfKind(ledger, "install");
  const useCases = factsOfKind(ledger, "use_case");
  const momentum = ledger.facts.filter(
    fact => fact.source.kind === "star-snapshot"
  );
  const limitations = factsOfKind(ledger, "requirement");

  if (limitations.length >= 1 && features.length >= 2) {
    return {
      angle: "trade-off",
      reason: "the README states a constraint worth mentioning alongside the features",
      templateKeys: ["trade-off.balanced", "trade-off.direct"],
    };
  }
  if (install.length >= 1 && features.length <= 2) {
    return {
      angle: "try-it",
      reason: "a verified setup path exists and the feature list is short",
      templateKeys: ["try-it.quickstart", "try-it.setup-first"],
    };
  }
  if (features.length >= 2) {
    return {
      angle: "quick-tour",
      reason: `${features.length} documented features are available to describe`,
      templateKeys: [
        "quick-tour.utility-first",
        "quick-tour.feature-tour",
        "quick-tour.problem-solution",
      ],
    };
  }
  if (momentum.length >= 1 && repo.stargazers_count < 20000) {
    return {
      angle: "under-the-radar",
      reason: "dated star snapshots exist, so measured growth can be stated",
      templateKeys: ["underdog.measured", "underdog.quiet"],
    };
  }
  if (momentum.length >= 1) {
    return {
      angle: "mature-and-popular",
      reason: "measured growth and meaningful adoption are both available",
      templateKeys: ["popular.context", "popular.proof"],
    };
  }
  if (useCases.length >= 1) {
    return {
      angle: "developer-workflow",
      reason: "the README documents a concrete workflow",
      templateKeys: ["workflow.pipeline", "workflow.day"],
    };
  }
  return {
    angle: "what-it-does",
    reason: "only a purpose statement is well supported by the evidence",
    templateKeys: ["plain.direct", "plain.quiet", "plain.benefit"],
  };
}

/* ------------------------------------------------------------------ */
/* Plan assembly                                                       */
/* ------------------------------------------------------------------ */

export type BuildNarrationOptions = {
  targetDurationSeconds?: number;
  voiceId?: string;
  speed?: number;
  recentUsage?: PhraseHistory;
  attemptCount?: number;
};

const SLOT_PURPOSES: Record<StorySlot, SegmentPurpose> = {
  hook: "identify",
  identity: "identify",
  value: "explain",
  proof: "adoption",
  demo: "demo",
  setup: "install",
  availability: "license",
  caveat: "caveat",
  cta: "cta",
};

export function buildNarrationPlan(
  ledger: FactLedger,
  repo: EnrichedRepo,
  options: BuildNarrationOptions = {}
): NarrationPlan {
  const target = Math.min(
    MAX_DURATION_SECONDS,
    Math.max(MIN_DURATION_SECONDS, options.targetDurationSeconds ?? TARGET_DURATION_SECONDS)
  );
  const seed =
    stableHash(`${repo.full_name.toLowerCase()}:${options.attemptCount ?? 0}`) +
    (options.recentUsage?.get("__turn__") ?? 0);

  const decision = selectAngle(ledger, repo);
  const story = buildStory({
    ledger,
    repo,
    angle: decision.angle,
    targetDurationSeconds: target,
    attemptCount: options.attemptCount ?? 0,
    seed,
    recentUsage: options.recentUsage ?? new Map(),
  });

  const segments: NarrationSegment[] = story.clauses.map((clause, index) => ({
    id: `seg-${String(index + 1).padStart(2, "0")}`,
    purpose: SLOT_PURPOSES[clause.slot],
    spokenText: clause.spoken,
    captionText: clause.caption ?? clause.spoken,
    factIds: clause.factIds,
    visualAnchor: clause.anchor,
    emphasis: (clause.emphasis ?? []).filter(value => value.trim().length > 0),
    narrativeRole: clause.slot,
    clauseId: clause.id,
  }));

  const nextUsage: PhraseHistory = new Map(options.recentUsage ?? []);
  nextUsage.set(story.structure, (nextUsage.get(story.structure) ?? 0) + 1);
  nextUsage.set("__turn__", (nextUsage.get("__turn__") ?? 0) + 1);

  return {
    repositoryNodeId: repo.nodeId,
    fullName: repo.full_name,
    angle: decision.angle,
    angleReason: decision.reason,
    targetDurationSeconds: target,
    styleVariant: story.structure,
    voiceId: options.voiceId ?? TTS_VOICE,
    speed: options.speed ?? TTS_SPEED,
    estimatedWords: wordCount(segments.map(segment => segment.spokenText).join(" ")),
    segments,
    structure: story.structure,
    scriptScore: story.score,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const SENTENCE_RE = /[^.!?]+[.!?]?/g;

export function validateScript(plan: NarrationPlan, ledger: FactLedger): ScriptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const full = plan.segments.map(segment => segment.spokenText).join(" ");
  const words = wordCount(full);

  const known = new Set(ledger.facts.map(fact => fact.id));
  for (const segment of plan.segments) {
    if (segment.factIds.length === 0) {
      errors.push(`segment ${segment.id} cites no fact`);
    }
    for (const id of segment.factIds) {
      if (!known.has(id)) errors.push(`segment ${segment.id} cites unknown fact ${id}`);
    }
  }

  if (plan.segments.length === 0) errors.push("script is empty");

  const firstTwo = plan.segments.slice(0, 2).map(segment => segment.spokenText).join(" ");
  if (!/[a-z]{3}/i.test(firstTwo)) {
    errors.push("the first two sentences do not explain the project");
  }
  if (wordCount(firstTwo) < 6) {
    errors.push("the opening is too short to explain what the project is");
  }

  for (const phrase of findBoilerplate(full)) {
    errors.push(`banned filler phrase: "${phrase}"`);
  }

  if (/\btrending\b/i.test(full) && !ledger.facts.some(fact => fact.source.kind === "star-snapshot")) {
    errors.push('"trending" may only be used when dated star snapshots exist');
  }
  if (/\bopen[- ]source\b/i.test(full) && !ledger.facts.some(fact => fact.kind === "license")) {
    errors.push('"open source" may only be used when a license fact exists');
  }
  if (
    /\b(all|every|any)\b[^.]{0,60}\b(services?|apis?|hosted|platform|infrastructure)\b[^.]{0,30}\b(are|is|will be)\b[^.]{0,20}\b(free|no[- ]cost|unlimited)\b/i.test(
      full
    )
  ) {
    errors.push("open source code does not imply that hosted services are free");
  }
  if (/\bfree forever\b/i.test(full)) {
    errors.push("an absolute cost claim needs a pricing fact");
  }

  const name = plan.fullName.split("/").pop() ?? plan.fullName;
  const nameMentions = full.split(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi")).length - 1;
  if (nameMentions > 3) {
    warnings.push(`the repository name is repeated ${nameMentions} times`);
  }

  for (const sentenceText of full.match(SENTENCE_RE) ?? []) {
    const count = wordCount(sentenceText);
    if (count > 26) {
      warnings.push(
        `a sentence of ${count} words will be hard to speak: "${trim(sentenceText)}"`
      );
    }
  }

  const estimatedSeconds = estimateSeconds(words);
  if (estimatedSeconds > MAX_DURATION_SECONDS) {
    errors.push(
      `estimated ${estimatedSeconds.toFixed(1)}s exceeds the ${MAX_DURATION_SECONDS}s maximum`
    );
  }
  if (estimatedSeconds < MIN_DURATION_SECONDS) {
    warnings.push(
      `estimated ${estimatedSeconds.toFixed(1)}s is below the ${MIN_DURATION_SECONDS}s minimum target`
    );
  }

  // Do not say the same thing three ways.
  const seen = new Map<string, number>();
  for (const factId of plan.segments.flatMap(segment => segment.factIds)) {
    seen.set(factId, (seen.get(factId) ?? 0) + 1);
  }
  for (const [factId, count] of seen) {
    if (count > 2) warnings.push(`fact ${factId} is used ${count} times`);
  }

  // Phase 2 gate: the script must cover purpose, mechanism and a practical
  // use case; popularity metadata stays secondary. Runs against the same
  // fact ledger, so an unexplained but evidenced repo fails the run.
  const narrative = compileRepoNarration(plan, ledger);
  for (const error of validateNarration(narrative.script, narrative.coverage)) {
    errors.push(`narration structure: ${error}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    words,
    estimatedSeconds,
    narrative: narrative.script,
  };
}

function trim(value: string, max = 60): string {
  return value.length <= max ? value.trim() : `${value.trim().slice(0, max - 1)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Speech-only form of a segment. Display captions must use `captionText`;
 * this value is deliberately safe to hand to Kokoro and may differ in
 * punctuation, acronyms and number formatting.
 */
export function segmentSpokenText(segment: NarrationSegment): string {
  return prepareTtsText(segment.spokenText);
}

/** Convenience: readme-derived detail used by the card renderer. */
export function readmeHighlights(repo: EnrichedRepo): {
  bullets: string[];
  installCommand: string | null;
} {
  const parsed = parseReadme(repo.readmeText);
  return {
    bullets: bulletsOf(
      sectionWithBullets(parsed, [/^(features?|capabilities|highlights|benefits?|why)/])
    ).slice(0, 5),
    // Code fences are stored separately from prose by parseReadme; the
    // install extractor is the one place that knows how to read them.
    installCommand: extractInstall(repo, parsed).command,
  };
}

/** Kept for callers that want the raw narratable fact list. */
export { narratableFacts };
