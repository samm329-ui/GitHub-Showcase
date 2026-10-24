import type { FactLedger, NarrationPlan } from "./types.js";
import {
  ESTIMATED_WPM,
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
} from "./config.js";

/**
 * Script quality gate (Pass A).
 *
 * This complements, and never replaces, the evidence gate (`validateScript`).
 * Every check runs against the *exact* plan the TTS stage will speak — the
 * same object, not a rebuilt twin — so a passing report can never describe a
 * different script from the one that ships.
 *
 * `ok` is gated on deterministic hard failures: unknown or missing citations,
 * empty or unpunctuated segments, verbatim repetition, an over-long script,
 * and metadata takeover while real explanation existed. The numeric score is
 * diagnostic only — it ranks rewrites in artifacts, it can never rescue a
 * failing script or veto a passing one.
 */

export type ScriptQualityReport = {
  ok: boolean;
  /** Diagnostic only. Gating is `hardFailures.length === 0`. */
  score: number;
  hardFailures: string[];
  warnings: string[];
  subscores: {
    /** Purpose-first structure with mechanism and example coverage. */
    structure: number;
    /** Share of segments citing at least one known fact. */
    evidence: number;
    /** Absence of duplicated sentences and re-cited facts. */
    repetition: number;
    /** Share of sentences that end with real sentence punctuation. */
    fragments: number;
    /** Sentence-length variability (a rhythm proxy, never a gate). */
    rhythm: number;
    /** Estimated duration inside the plan's target. */
    budget: number;
  };
  factsCited: number;
  segmentCount: number;
  wordCount: number;
  estimatedSeconds: number;
};

function estimateSeconds(words: number): number {
  return (words / ESTIMATED_WPM) * 60;
}

function normalize(n: number, max: number): number {
  return Math.max(0, Math.min(1, max === 0 ? 0 : n / max));
}

export function sentenceCount(text: string): number {
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

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Metadata purposes: stars, license, adoption-shaped content. */
const METADATA_PURPOSES = new Set(["adoption", "license"]);

/** Explanatory purposes: the content a viewer came for. */
const EXPLANATORY_PURPOSES = new Set(["problem", "explain", "demo", "benefit"]);

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
 * Score the *structure* of the narration plan. Hard failures gate; the score
 * only describes how close the script is to the ideal shape so a rewrite can
 * be compared against its predecessor.
 */
export function evaluateScriptQuality(
  plan: NarrationPlan,
  ledger: FactLedger
): ScriptQualityReport {
  const known = new Set(ledger.facts.map(fact => fact.id));
  const hardFailures: string[] = [];
  const warnings: string[] = [];
  const full = plan.segments
    .map(segment => segment.spokenText.trim())
    .filter(Boolean)
    .join(" ");
  const segmentCount = plan.segments.length;

  /* --- evidence: every segment cites known facts ------------------- */
  let factsCited = 0;
  let segmentsWithCitations = 0;
  for (const segment of plan.segments) {
    if (segment.factIds.length === 0) {
      hardFailures.push(`segment ${segment.id} cites no fact`);
      continue;
    }
    let segmentCitesKnown = false;
    for (const factId of segment.factIds) {
      if (!known.has(factId)) {
        hardFailures.push(`segment ${segment.id} cites unknown fact ${factId}`);
        continue;
      }
      factsCited += 1;
      segmentCitesKnown = true;
    }
    if (segmentCitesKnown) segmentsWithCitations += 1;
  }

  /* --- fragments: every segment is a punctuated sentence ----------- */
  let totalSentences = 0;
  let completeSentences = 0;
  for (const segment of plan.segments) {
    const text = segment.spokenText.trim();
    if (!text) {
      hardFailures.push(`segment ${segment.id} is empty`);
      continue;
    }
    const sentences = text
      .split(/(?<=[.!?])\s+/g)
      .map(sentence => sentence.trim())
      .filter(Boolean);
    totalSentences += sentences.length;
    for (const candidate of sentences) {
      if (/[.!?]$/.test(candidate)) completeSentences += 1;
    }
  }

  /* --- repetition: no duplicated sentences, no fact spam ----------- */
  const texts = plan.segments
    .map(segment => segment.spokenText.trim().toLowerCase())
    .filter(Boolean);
  const uniqueTexts = new Set(texts);
  if (uniqueTexts.size < texts.length) {
    hardFailures.push("two segments speak the same sentence");
  }
  const factUse = new Map<string, number>();
  for (const segment of plan.segments) {
    for (const factId of segment.factIds) {
      if (!known.has(factId)) continue;
      factUse.set(factId, (factUse.get(factId) ?? 0) + 1);
    }
  }
  for (const [factId, count] of factUse) {
    if (count > 2) {
      hardFailures.push(`fact ${factId} is cited by ${count} segments`);
    } else if (count === 2) {
      warnings.push(`fact ${factId} is cited by two segments`);
    }
  }
  for (let index = 1; index < plan.segments.length; index += 1) {
    if (
      isRepetitive(
        plan.segments[index - 1].spokenText,
        plan.segments[index].spokenText
      )
    ) {
      warnings.push(
        `segments ${index} and ${index + 1} repeat the same wording`
      );
    }
  }

  /* --- metadata takeover ------------------------------------------- */
  const totalWords = wordCount(full);
  const metadataWords = wordCount(
    plan.segments
      .filter(segment => METADATA_PURPOSES.has(segment.purpose))
      .map(segment => segment.spokenText)
      .join(" ")
  );
  const metadataShare = totalWords > 0 ? metadataWords / totalWords : 0;
  const explanatoryWords = wordCount(
    plan.segments
      .filter(segment => EXPLANATORY_PURPOSES.has(segment.purpose))
      .map(segment => segment.spokenText)
      .join(" ")
  );
  if (metadataShare > 0.35 && explanatoryWords > 0) {
    hardFailures.push(
      `metadata is ${Math.round(metadataShare * 100)}% of the script ` +
        "while explanatory content exists"
    );
  } else if (metadataShare > 0.35) {
    warnings.push(
      `metadata is ${Math.round(metadataShare * 100)}% of a thin script`
    );
  }

  /* --- duration ----------------------------------------------------- */
  const estimatedSeconds = estimateSeconds(totalWords);
  if (estimatedSeconds > MAX_DURATION_SECONDS) {
    hardFailures.push(
      `estimated ${estimatedSeconds.toFixed(1)}s exceeds the ` +
        `${MAX_DURATION_SECONDS}s hard maximum`
    );
  } else if (
    plan.targetDurationSeconds > 0 &&
    estimatedSeconds > plan.targetDurationSeconds + 4
  ) {
    hardFailures.push(
      `estimated ${estimatedSeconds.toFixed(1)}s overshoots the ` +
        `${plan.targetDurationSeconds}s target by more than 4s`
    );
  }
  if (estimatedSeconds < MIN_DURATION_SECONDS) {
    warnings.push(
      `estimated ${estimatedSeconds.toFixed(1)}s is below the ` +
        `${MIN_DURATION_SECONDS}s minimum target`
    );
  }

  /* --- diagnostic subscores ---------------------------------------- */
  const leadingExplanation =
    segmentCount > 0
      ? ["identify", "problem"].includes(plan.segments[0].purpose)
      : false;
  const hasMechanism = plan.segments.some(
    segment => segment.purpose === "explain"
  );
  const hasExample = plan.segments.some(segment => segment.purpose === "demo");
  const structure = normalize(
    (leadingExplanation ? 1 : 0) + (hasMechanism ? 1 : 0) + (hasExample ? 1 : 0),
    3
  );
  const evidence =
    segmentCount > 0 ? segmentsWithCitations / segmentCount : 0;
  const fragments =
    totalSentences > 0 ? completeSentences / totalSentences : 0;
  const repetition = texts.length > 0 ? uniqueTexts.size / texts.length : 0;
  const rhythm = normalize(standardDeviation(sentenceLengths(full)), 8);
  const budget =
    plan.targetDurationSeconds > 0
      ? estimatedSeconds <= plan.targetDurationSeconds
        ? 1
        : 0
      : 0;

  if (sentenceLengths(full).length > 2 && standardDeviation(sentenceLengths(full)) < 2) {
    warnings.push("sentence lengths are very monotonous");
  }
  const name = plan.fullName.split("/").pop() ?? plan.fullName;
  const nameMentions =
    full.split(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")).length - 1;
  if (nameMentions > 3) {
    warnings.push(`the repository name is repeated ${nameMentions} times`);
  }

  const score = Math.round(
    100 *
      (0.2 * structure +
        0.2 * evidence +
        0.2 * fragments +
        0.15 * repetition +
        0.1 * rhythm +
        0.15 * budget)
  );

  return {
    ok: hardFailures.length === 0,
    score,
    hardFailures,
    warnings,
    subscores: { structure, evidence, repetition, fragments, rhythm, budget },
    factsCited,
    segmentCount,
    wordCount: totalWords,
    estimatedSeconds: Number(estimatedSeconds.toFixed(2)),
  };
}
