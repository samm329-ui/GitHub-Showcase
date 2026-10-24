import type { EnrichedRepo, Fact, FactLedger, FactSemantic } from "./types.js";
import {
  EVIDENCE_STRENGTH_FLOOR,
  MIN_EXAMPLE_EVIDENCE,
  SCRIPTABILITY,
} from "./config.js";
import { analyzeRepository, type RepositoryAnalysis } from "./repository-analysis.js";

/**
 * Scriptability gate (Pass A).
 *
 * Decides — before any planner or TTS work happens — whether the extracted
 * evidence can support an honest explanation:
 *
 *   S = 0.25·P + 0.35·H + 0.25·X + 0.15·D
 *
 *   P  purpose evidence quality
 *   H  evidence for how the project works
 *   X  example or workflow evidence quality
 *   D  diversity of independent supporting sources
 *
 * The score is a ranking aid, not a permission slip: a clear purpose and at
 * least one concrete mechanism are hard requirements regardless of score.
 * Weak candidates (a description plus stars and a license) fail here and are
 * skipped in discovery; for a manually selected repository the report names
 * the missing evidence instead of fabricating a full-length script.
 */

export type ScriptabilityReport = {
  ok: boolean;
  score: number;
  threshold: number;
  components: {
    purpose: number;
    how: number;
    example: number;
    diversity: number;
  };
  /** Hard requirement failures (independent of the score). */
  missing: string[];
  /** Roles omitted for lack of evidence; the composer must record these too. */
  omissions: string[];
  analysis: RepositoryAnalysis;
  /** The best fact per semantic role, for debugging and artifacts. */
  evidence: Record<string, Fact | null>;
};

function factsWithRole(ledger: FactLedger, ...roles: FactSemantic[]): Fact[] {
  return ledger.facts.filter(fact => fact.semantic && roles.includes(fact.semantic));
}

function best(facts: Fact[]): Fact | null {
  let winner: Fact | null = null;
  for (const fact of facts) {
    if (!winner || fact.confidence > winner.confidence) winner = fact;
  }
  return winner;
}

/** Normalized source-kind count: the more independent sources, the better. */
function diversityScore(ledger: FactLedger): number {
  const sources = new Set(
    factsWithRole(
      ledger,
      "purpose",
      "problem",
      "mechanism",
      "workflow",
      "example",
      "outcome",
      "limitation"
    ).map(fact => fact.source.kind)
  );
  // Four independent sources saturate the score (e.g. api-field,
  // readme-section, readme-table, readme-code/source-file).
  return Math.min(1, sources.size / 4);
}

/**
 * Purpose quality: the best purpose evidence, with a small bonus when both
 * the GitHub description and the README introduction agree on the purpose.
 */
function purposeScore(ledger: FactLedger): number {
  const purposeFacts = factsWithRole(ledger, "purpose");
  const top = best(purposeFacts);
  if (!top) return 0;
  const kinds = new Set(purposeFacts.map(fact => fact.source.kind));
  const corroboration = kinds.size > 1 ? 0.05 : 0;
  return Math.min(1, top.confidence + corroboration);
}

/** How-it-works quality: best mechanism/outcome evidence, scaled by depth. */
function howScore(ledger: FactLedger): number {
  const facts = factsWithRole(ledger, "mechanism", "outcome");
  const top = best(facts);
  if (!top) return 0;
  const depth = Math.min(0.15, 0.05 * (facts.length - 1));
  return Math.min(1, top.confidence + depth);
}

/** Example quality: best example/workflow evidence, scaled by depth. */
function exampleScore(ledger: FactLedger): number {
  const facts = factsWithRole(ledger, "example", "workflow");
  const top = best(facts);
  if (!top) return 0;
  const depth = Math.min(0.1, 0.03 * (facts.length - 1));
  return Math.min(1, top.confidence + depth);
}

export function evaluateScriptability(
  repo: EnrichedRepo,
  ledger: FactLedger
): ScriptabilityReport {
  const analysis = analyzeRepository(repo, ledger);

  const purpose = purposeScore(ledger);
  const how = howScore(ledger);
  const example = exampleScore(ledger);
  const diversity = diversityScore(ledger);

  const weights = SCRIPTABILITY.weights;
  const score =
    weights.purpose * purpose +
    weights.how * how +
    weights.example * example +
    weights.diversity * diversity;

  const missing: string[] = [];
  const omissions: string[] = [];

  /* Hard requirements, independent of the score. */
  const purposeFact = best(factsWithRole(ledger, "purpose"));
  if (!purposeFact || purposeFact.confidence < EVIDENCE_STRENGTH_FLOOR) {
    missing.push("no clear purpose evidence");
  }
  const mechanismFacts = factsWithRole(ledger, "mechanism", "outcome").filter(
    fact => fact.confidence >= EVIDENCE_STRENGTH_FLOOR
  );
  if (mechanismFacts.length === 0) {
    missing.push("no concrete mechanism evidence (how the project works)");
  }

  /* Recorded omissions: honest gaps the composer must not paper over. */
  const exampleFacts = factsWithRole(ledger, "example", "workflow");
  const bestExample = best(exampleFacts);
  if (!bestExample) {
    omissions.push("no documented example or workflow; the script omits a use case");
  } else if (bestExample.confidence < MIN_EXAMPLE_EVIDENCE) {
    omissions.push("example evidence is weak; the use case stays implicit");
  }

  const ok = missing.length === 0 && score >= SCRIPTABILITY.threshold;

  return {
    ok,
    score: Number(score.toFixed(3)),
    threshold: SCRIPTABILITY.threshold,
    components: { purpose, how, example, diversity },
    missing,
    omissions,
    analysis,
    evidence: {
      purpose: purposeFact,
      problem: best(factsWithRole(ledger, "problem")),
      mechanism: best(factsWithRole(ledger, "mechanism")),
      example: bestExample,
      setup: best(factsWithRole(ledger, "setup")),
    },
  };
}
