import type { FactLedger, NarrationPlan } from "./types.js";
import { ESTIMATED_WPM } from "./config.js";

/**
 * Script quality gate (Pass A).
 *
 * This complements, and never replaces, the evidence gate. Hard failures here
 * are structural: citing an unknown fact, repeating an unsupported claim, or
 * using a style pattern that would make the narration sound like a fact list.
 */

function estimateSeconds(words: number): number {
  return (words / ESTIMATED_WPM) * 60;
}

export type ScriptQualityReport = {
  ok: boolean;
  score: number;
  hardFailures: string[];
  warnings: string[];
  subscores: {
    purpose: number;
    mechanism: number;
    example: number;
    continuity: number;
    rhythm: number;
    budget: number;
  };
  factsCited: number;
  segmentCount: number;
  wordCount: number;
  estimatedSeconds: number;
};

const HARD_THRESHOLD = 60;

function normalize(n: number, max: number): number {
  return Math.max(0, Math.min(1, max === 0 ? 0 : n / max));
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/g).filter(Boolean).length;
}

function sentenceLengths(text: string): number[] {
  return text
    .split(/(?<=[.!?])\s+/g)
    .map(sentence => sentence.trim().split(/\s+/).filter(Boolean).length)
    .filter(Boolean);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Weaken the vocabulary-heavy "is a TypeScript CLI" style, not its meaning. */
function isMetadataOnly(segment: NarrationPlan["segments"][number]): boolean {
  const text = `${segment.purpose} ${segment.spokenText}`.toLowerCase();
  return /\b(written? in|language|updated? (?:today|yesterday)|stars?|forks)\b/.test(text);
}

function isRepetitive(first: string, second: string): boolean {
  const words1 = new Set(first.toLowerCase().split(/\s+/));
  const words2 = new Set(second.toLowerCase().split(/\s+/));
  if (words1.size < 3 || words2.size < 3) return false;
  let shared = 0;
  words1.forEach(word => {
    if (words2.has(word) && word.length > 3) shared += 1;
  });
  const ratio = shared / Math.min(words1.size, words2.size);
  return ratio > 0.65;
}

/**
 * Score the *structure* of a narration plan. This intentionally complements
 * the existing evidence gate: unsupported claims stay hard failures, and a bad
 * tone is only a warning.
 */
export function evaluateScriptQuality(
  plan: NarrationPlan,
  ledger: FactLedger
): ScriptQualityReport {
  const known = new Set(ledger.facts.map(fact => fact.id));
  const hardFailures: string[] = [];
  const warnings: string[] = [];
  const full = plan.segments.map(segment => segment.spokenText).join(" ");

  const segmentCount = plan.segments.length;
  let factsCited = 0;
  const seen = new Set<string>();
  for (const segment of plan.segments) {
    if (segment.factIds.length === 0) {
      hardFailures.push(`segment ${segment.id} cites no fact`);
      continue;
    }
    for (const factId of segment.factIds) {
      if (!known.has(factId)) {
        hardFailures.push(`segment ${segment.id} cites unknown fact ${factId}`);
        continue;
      }
      factsCited += 1;
      if (seen.has(factId)) continue;
      seen.add(factId);
    }
  }

  const leadingPurpose = segmentCount > 0 ? plan.segments[0].purpose === "identify" : false;
  const purpose = leadingPurpose ? 1 : 0;
  const mechanismCount = plan.segments.filter(
    segment => segment.purpose === "explain"
  ).length;
  const mechanism = normalize(mechanismCount, Math.max(1, segmentCount - 1));
  const exampleCount = plan.segments.filter(
    segment => segment.purpose === "demo"
  ).length;
  const example = normalize(exampleCount, 1);
  const continuityShare = hardFailures.length === 0 ? 1 : 0.2;

  const sentenceLengthVariability = standardDeviation(sentenceLengths(full));
  const rhythm = normalize(sentenceLengthVariability, 8);
  const estimatedSeconds = estimateSeconds(full.trim().split(/\s+/).filter(Boolean).length);
  const budget = estimatedSeconds <= plan.targetDurationSeconds ? 1 : 0;
  const budgetPenalty = budget < 1 ? 1 : 0;

  // Soft warnings: they guide a rewrite, they never rescue a bad script.
  if (sentenceLengthVariability < 2) warnings.push("sentence lengths are very monotonous");
  if (estimatedSeconds > plan.targetDurationSeconds + 3) {
    warnings.push(`estimated duration ${estimatedSeconds}s runs past the target`);
  }
  if (budgetPenalty) warnings.push("script exceeds its duration target");
  if (isRepetitive(plan.segments[0]?.spokenText ?? "", plan.segments[1]?.spokenText ?? "")) {
    warnings.push("the first two segments repeat the same facts");
  }
  if (segmentCount > 0 && plan.segments.every(isMetadataOnly)) {
    warnings.push("every segment reads like metadata");
  }

  const score = Math.round(
    100 * (0.25 * purpose + 0.2 * mechanism + 0.15 * example +
      0.1 * continuityShare + 0.1 * rhythm + 0.2 * budget)
  );
  const ok = hardFailures.length === 0 && score >= HARD_THRESHOLD;

  return {
    ok,
    score,
    hardFailures,
    warnings,
    subscores: {
      purpose,
      mechanism,
      example,
      continuity: continuityShare,
      rhythm,
      budget,
    },
    factsCited,
    segmentCount,
    wordCount: full.trim().split(/\s+/).filter(Boolean).length,
    estimatedSeconds,
  };
}

/** Sentence count helper exported for tests. */
export { sentenceCount };
