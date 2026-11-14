/**
 * Deterministic, quality-based Long-form selection.
 *
 * Steps:
 *   1. eligible = candidates with no issues and nodeId present
 *   2. exclude repositories already committed to ANY Long-form episode
 *   3. greedy diversity-aware pick of exactly five:
 *      penalty(c, picked) = 8 × same primaryLanguage + 6 × shared-topic jaccard ≥ 0.25
 *   4. final selectionScore = baseScore − diversityPenalty (floor 0)
 *   5. rank: sort by (selectionScore desc, nodeId asc) → rank 1 = strongest
 *   6. presentation order: rank 5 first … rank 1 last
 *
 * No randomness anywhere; identical inputs always yield identical selections.
 */
import type { DatasetCandidate } from "./types.js";
import { reconcileDataset } from "./dataset-loader.js";
import type { SelectionResult } from "./types.js";

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map(t => t.toLowerCase()));
  const sb = new Set(b.map(t => t.toLowerCase()));
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}

export function diversityPenalty(
  candidate: DatasetCandidate,
  picked: DatasetCandidate[]
): number {
  let penalty = 0;
  const lang = candidate.primaryLanguage?.toLowerCase() ?? null;
  for (const other of picked) {
    if (lang && other.primaryLanguage && other.primaryLanguage.toLowerCase() === lang) penalty += 8;
    if (jaccard(candidate.topics, other.topics) >= 0.25) penalty += 6;
  }
  return penalty;
}

export function selectFive(
  candidates: DatasetCandidate[],
  usedNodeIds: Set<string>
): SelectionResult {
  const eligible = candidates.filter(c => c.issues.length === 0 && c.nodeId && !usedNodeIds.has(c.nodeId));
  const picked: Array<DatasetCandidate & { diversityPenalty: number }> = [];
  const pool = [...eligible];

  while (picked.length < 5 && pool.length > 0) {
    let best: DatasetCandidate | null = null;
    let bestScore = -Infinity;
    let bestPenalty = 0;
    for (const candidate of pool) {
      const penalty = diversityPenalty(candidate, picked);
      const score = candidate.baseScore - penalty;
      if (
        score > bestScore ||
        (score === bestScore && best !== null && candidate.nodeId < best.nodeId)
      ) {
        best = candidate;
        bestScore = score;
        bestPenalty = penalty;
      }
    }
    if (!best) break;
    picked.push({ ...best, diversityPenalty: bestPenalty });
    pool.splice(pool.indexOf(best), 1);
  }

  // Rank: strongest = #1 (by selection score, nodeId tiebreak).
  const scored = picked.map(p => ({ ...p, selectionScore: Math.max(0, p.baseScore - p.diversityPenalty) }));
  scored.sort((a, b) => b.selectionScore - a.selectionScore || a.nodeId.localeCompare(b.nodeId));
  const ranked = scored.map((p, index) => ({ ...p, rank: index + 1 }));

  // Presentation order: #5 first … #1 last.
  const presentation = [...ranked].reverse().map(({ diversityPenalty: _dp, ...rest }) => rest);

  return {
    episodeId: "",
    candidates: eligible,
    ranked: ranked.map(({ rank: _rank, ...rest }) => rest),
    presentation,
  };
}

export type SelectionDiagnostics = {
  eligible: number;
  used: number;
  selected: SelectionResult | null;
  shortfall: number;
};

/** Load + reconcile + select without writing anything (used by preflight and dry runs). */
export async function previewSelection(usedNodeIds: Set<string>): Promise<SelectionDiagnostics> {
  const report = await reconcileDataset();
  const eligible = report.candidates.filter(
    c => c.issues.length === 0 && c.nodeId && !usedNodeIds.has(c.nodeId)
  );
  if (eligible.length < 5) {
    return { eligible: eligible.length, used: usedNodeIds.size, selected: null, shortfall: 5 - eligible.length };
  }
  const selected = selectFive(report.candidates, usedNodeIds);
  return { eligible: eligible.length, used: usedNodeIds.size, selected, shortfall: 0 };
}
