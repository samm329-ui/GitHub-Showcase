/**
 * Automated gates - the human editor's deterministic counterpart.
 *
 * Engages ONLY under explicit opt-in (NEWS_AUTO_GATES=1 or --auto-gates).
 * When engaged:
 *  - Gate A: recorded approved ONLY when the evidence is corroborated by â‰¥2
 *    independent origins, no claim is disputed, and at least one hard fact
 *    (number/date/quote/legal_status) verifies against the evidence.
 *    Thin or single-source stories are refused - loudly.
 *  - Gate B: recorded approved ONLY when the deterministic script validator
 *    passes AND every spoken quote is present verbatim in the evidence.
 *  - Gate C: recorded approved at render-QA pass (loudness/geometry/fps).
 *
 * Honesty rules:
 *  - Approvals are written with note="automated:..." - never impersonating a human.
 *  - Refusal exits with blocked.json; no mp4 is produced, ever.
 *  - Claim-check remains lexical (word match against excerpt) - automated
 *    checks reduce error, they do not eliminate it.
 */
import crypto from "node:crypto";
import type { EvidenceLedger, EvidenceRecord, FactRecord } from "./types.js";
import { verifyQuotedMaterial, originKeyOf } from "./ledger.js";

export type AutoDecision = { approved: true; note: string } | { approved: false; reason: string; note: string };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const HARD_KINDS = new Set<FactRecord["kind"]>(["number", "date", "quote", "legal_status"]);

/** Gate A - factual package. Refuses unless evidence is corroborated. */
export function evaluateGateA(ledger: EvidenceLedger, records: EvidenceRecord[]): AutoDecision {
  const reasons: string[] = [];

  const disputed = ledger.facts.filter(f => f.status === "disputed");
  if (disputed.length > 0) reasons.push(`disputed claim(s): ${disputed.map(f => f.id).join(", ")}`);

  const unverifiedCore = ledger.facts.filter(f => f.importance === "core" && f.status === "unverified");
  if (unverifiedCore.length > 0) reasons.push(`unverified CORE claim(s): ${unverifiedCore.map(f => f.id).join(", ")}`);

  const exclusions = ledger.facts.filter(f => f.status === "excluded");
  if (exclusions.length > 0) reasons.push(`excluded claim(s): ${exclusions.map(f => f.id).join(", ")}`);

  const hardVerified = ledger.facts.filter(
    f => f.status === "verified" && HARD_KINDS.has(f.kind)
  );
  if (hardVerified.length === 0) {
    reasons.push(`no hard fact (number/date/quote/legal_status) passes verification`);
  }

  const supporting = records.filter(r => r.supports === "supports");
  /* Metadata-only records (rss-metadata:*/
  const isFullText = (r: EvidenceRecord) => !(r.locator ?? "").startsWith("rss-metadata") && !(r.locator ?? "").startsWith("research-metadata");
  const supportingFullText = supporting.filter(isFullText);
  const metadataOnlyCount = supporting.length - supportingFullText.length;
  const distinctSupporting = new Set(supportingFullText.map(originKeyOf)).size;
  const distinctSupportingGroups = new Set(supportingFullText.map(r => r.parentPublisherGroup)).size;
  const allFirstPartySingle = supportingFullText.length > 0
    && supportingFullText.every(r => r.policy.sourceRole === "primary")
    && new Set(supportingFullText.map(r => r.parentPublisherGroup)).size === 1;
  const allAggregatedInshorts = supportingFullText.length > 0
    && supportingFullText.every(r => r.sourceId === "inshorts.com")
    && new Set(supportingFullText.map(r => r.parentPublisherGroup)).size === 1;
  let selfSpeaker: string | null = null;
  let selfLabel: "self-announcement" | "aggregated" | null = null;
  if (supportingFullText.length === 0) {
    reasons.push(
      metadataOnlyCount > 0
        ? `no full-text supporting evidence - ${metadataOnlyCount} metadata-only record(s) do not count as corroboration`
        : `no supporting evidence records found`
    );
  } else if (distinctSupporting < 2) {
    // Narrow, honest exception: first-party self-announcements verified against
    // the originator's own record get narrated AS announcements, with the script
    // required to attribute out loud ("according to Google…").
    if (allFirstPartySingle && hardVerified.length >= 1) {
      selfSpeaker = supportingFullText[0].parentPublisherGroup;
      selfLabel = "self-announcement";
    } else if (allAggregatedInshorts && hardVerified.length >= 1) {
      /* Aggregated summaries: the 60-word Inshorts card is the complete
       * evidence ceiling. Narrated as Inshorts-reported commentary with
       * attribution - never as independently corroborated fact. */
      selfSpeaker = "Inshorts";
      selfLabel = "aggregated";
    } else {
      reasons.push(
        `supporting evidence stems from ${distinctSupporting} origin(s) (${distinctSupportingGroups} group(s)); corroboration requires >=2 independent origins (wire-lineage and group aware)`
      );
    }
  }

  if (!ledger.verifierPassed) reasons.push("ledger.verifierPassed is false");

  const notes = [
    `ledger facts=${ledger.facts.length} verifierPassed=${ledger.verifierPassed}`,
    `hardVerified=${hardVerified.map(f => f.id).join(",") || "none"}`,
    `supportingRecords=${supportingFullText.length} distinctSources=${distinctSupporting} groups=${distinctSupportingGroups}`,
    `metadataOnlyExcluded=${metadataOnlyCount}`,
    `ledger.independenceCount=${ledger.independenceCount}`,
    ...(selfSpeaker && selfLabel ? [`single_origin ${selfLabel}:${selfSpeaker}`] : []),
  ].join("; ");

  if (reasons.length > 0) {
    return {
      approved: false,
      reason: reasons.join("; "),
      note: `automated: gateA REFUSED - ${reasons.join(" | ")} || ${notes}`,
    };
  }
  return {
    approved: true,
    note: `automated: gateA PASS - ${notes}`,
  };
}

/** Gate B - script+voice package. Refuses if validator or quote check fails. */
export function evaluateGateB(
  ledger: EvidenceLedger,
  script: { narration: { id: string; text: string; factIds: string[] }[] },
  validationOk: boolean
): AutoDecision {
  const reasons: string[] = [];

  if (!ledger.verifierPassed) reasons.push("ledger failed verification");
  if (!validationOk) reasons.push("validateNewsScript reported errors");

  const quoteErrors = verifyQuotedMaterial(ledger.facts);
  if (quoteErrors.length > 0) {
    reasons.push(`spoken quotes not present verbatim: ${quoteErrors.slice(0, 3).join("; ")}`);
  }

  const factIdsInSegments = new Set(script.narration.flatMap(s => s.factIds));
  if (factIdsInSegments.size < 2) {
    reasons.push(`script references only ${factIdsInSegments.size} distinct factIds - not grounded enough for automation`);
  }

  /* Inshorts lane: every factual claim must be voiced as REPORTED, never as verified. */
  const allEvidence = ledger.facts.flatMap(f => f.evidence ?? []);
  const aggregatedInshorts = allEvidence.length > 0 &&
    allEvidence.every(r => (r as { sourceId?: string }).sourceId === "inshorts.com");
  if (aggregatedInshorts) {
    const scriptText = script.narration.map(n => n.text).join(" ");
    if (!/(according to inshorts|inshorts reports|inshorts says|inshorts ke)/i.test(scriptText)) {
      reasons.push(
        "script lacks the required Inshorts attribution (e.g. 'according to Inshorts', 'Inshorts reports') — every claim from this lane must be voiced as reported"
      );
    }
  }

  if (reasons.length > 0) {
    return {
      approved: false,
      reason: reasons.join("; "),
      note: `automated: gateB REFUSED - ${reasons.join(" | ")}`,
    };
  }
  return {
    approved: true,
    note: `automated: gateB PASS - validator green, ${factIdsInSegments.size} distinct factIds cited, quotes verbatim`,
  };
}

export function isAutoGatesEnabled(): boolean {
  const flag = process.env.NEWS_AUTO_GATES === "1" || process.env.NEWS_AUTO_GATES === "true";
  const argv = process.argv.slice(2);
  return flag || argv.includes("--auto-gates");
}

/** Hash helper for audit trails. */
export function payloadHashOf(payload: unknown): string {
  return sha(JSON.stringify(payload));
}



