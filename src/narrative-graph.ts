import type {
  ExplanationEdge,
  ExplanationNode,
  ExplanationPlan,
} from "./explanation-planner.js";
import { estimateNodeDurationMs } from "./explanation-planner.js";
import { PATH_WEIGHTS } from "./config.js";

/**
 * Deterministic bounded narrative search (Pass A).
 *
 * The graph is a small DAG over evidence-backed explanation nodes. `choosePath`
 * walks *edges*, not list positions: every consecutive pair in a candidate
 * path must be joined by a real relationship, so the selected sequence is a
 * connected explanation rather than an arbitrary slice of the node list.
 */

export type NarrativeGraph = {
  nodes: ExplanationNode[];
  edges: ExplanationEdge[];
};

export type PathCandidate = {
  nodeIds: string[];
  totalMs: number;
  score: number;
  valid: boolean;
  reason?: string;
  skipped: string[];
};

export function buildNarrativeGraph(
  nodes: ExplanationNode[],
  edges: ExplanationEdge[]
): NarrativeGraph {
  return { nodes, edges };
}

export function buildNarrativeGraphFromPlan(
  plan: ExplanationPlan
): NarrativeGraph {
  return buildNarrativeGraph(plan.nodes, plan.edges);
}

function requiredNodeIds(nodes: ExplanationNode[]): Set<string> {
  return new Set(nodes.filter(node => node.required).map(node => node.id));
}

function nodeById(graph: NarrativeGraph, id: string) {
  return graph.nodes.find(node => node.id === id) ?? null;
}

function edgeBetween(
  graph: NarrativeGraph,
  from: string,
  to: string
): ExplanationEdge | null {
  return graph.edges.find(edge => edge.from === from && edge.to === to) ?? null;
}

/**
 * Score a candidate path against the graph.
 *
 * Hard constraints first, then style:
 *  - every required node must be present (purpose, mechanism);
 *  - every consecutive pair must have a real edge (connectedness);
 *  - the estimated duration must fit the budget;
 *  - no fact may be claimed by two nodes.
 * Only a path that passes all four is scored; the score rewards node
 * utility plus the strength of the relationships between neighbours, and
 * penalises metadata-heavy sequences.
 */
export function scorePath(
  graph: NarrativeGraph,
  nodeIds: string[],
  budgetMs: number
): PathCandidate {
  const missingRequired = [...requiredNodeIds(graph.nodes)].filter(
    id => !nodeIds.includes(id)
  );
  if (missingRequired.length > 0) {
    return {
      nodeIds,
      totalMs: 0,
      score: Number.NEGATIVE_INFINITY,
      valid: false,
      reason: `missing required role(s): ${missingRequired.join(", ")}`,
      skipped: [],
    };
  }

  for (let index = 1; index < nodeIds.length; index += 1) {
    if (!edgeBetween(graph, nodeIds[index - 1], nodeIds[index])) {
      return {
        nodeIds,
        totalMs: 0,
        score: Number.NEGATIVE_INFINITY,
        valid: false,
        reason: `no edge between ${nodeIds[index - 1]} and ${nodeIds[index]}`,
        skipped: [],
      };
    }
  }

  const usedFactIds = new Set<string>();
  const skipped: string[] = [];
  let totalMs = 0;
  let metadataMs = 0;
  for (const id of nodeIds) {
    const node = nodeById(graph, id);
    if (!node) continue;
    if (node.evidence.some(reference => usedFactIds.has(reference.factId))) {
      skipped.push(id);
      continue;
    }
    const nodeMs = estimateNodeDurationMs(node);
    totalMs += nodeMs;
    if (node.role === "closing" || node.role === "differentiator") {
      metadataMs += nodeMs;
    }
    node.evidence.forEach(reference => usedFactIds.add(reference.factId));
  }
  if (skipped.length > 0) {
    return {
      nodeIds,
      totalMs,
      score: Number.NEGATIVE_INFINITY,
      valid: false,
      reason: `path repeats evidence: ${skipped.join(", ")}`,
      skipped,
    };
  }
  if (totalMs > budgetMs) {
    return {
      nodeIds,
      totalMs,
      score: Number.NEGATIVE_INFINITY,
      valid: false,
      reason: `path duration ${Math.round(totalMs)}ms exceeds budget ${Math.round(budgetMs)}ms`,
      skipped: [],
    };
  }

  let relationBonus = 0;
  for (let index = 1; index < nodeIds.length; index += 1) {
    const edge = edgeBetween(graph, nodeIds[index - 1], nodeIds[index]);
    if (edge) relationBonus += PATH_WEIGHTS.relation * edge.strength;
  }
  const nodeUtility = nodeIds.reduce((sum, id) => {
    const node = nodeById(graph, id);
    return node ? sum + nodeScore(node) : sum;
  }, 0);
  const metadataShare = totalMs > 0 ? metadataMs / totalMs : 0;

  return {
    nodeIds,
    totalMs,
    score: nodeUtility + relationBonus - PATH_WEIGHTS.metadata * metadataShare,
    valid: true,
    skipped: [],
  };
}

/** Weighted, deterministic utility for one node. */
function nodeScore(node: ExplanationNode): number {
  return (
    0.3 * node.importance +
    0.2 * node.novelty +
    0.3 * node.explanatoryValue +
    0.2 * (node.visualTargetIds.length > 0 ? 1 : 0.3)
  );
}

/**
 * Enumerate every simple path in the DAG (bounded: the graph has fewer than a
 * dozen nodes) and keep the highest-scoring valid one. Ties break toward the
 * shorter path, then lexicographically, so the same graph always yields the
 * same path.
 */
export function choosePath(
  graph: NarrativeGraph,
  budgetMs: number
): PathCandidate {
  const starts = graph.nodes
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(node => node.id);
  if (starts.length === 0) {
    return {
      nodeIds: [],
      totalMs: 0,
      score: 0,
      valid: false,
      reason: "the graph has no nodes",
      skipped: [],
    };
  }

  const best: { candidate: PathCandidate; score: number } = {
    candidate: {
      nodeIds: [],
      totalMs: 0,
      score: 0,
      valid: false,
      reason: "no path satisfied the required roles, connectedness and duration budget",
      skipped: [],
    },
    score: Number.NEGATIVE_INFINITY,
  };

  const outgoing = (id: string): string[] =>
    graph.edges
      .filter(edge => edge.from === id)
      .map(edge => edge.to)
      .sort();

  const visit = (path: string[]): void => {
    const candidate = scorePath(graph, path, budgetMs);
    if (
      candidate.valid &&
      (candidate.score > best.score ||
        (candidate.score === best.score && candidate.totalMs < best.candidate.totalMs) ||
        (candidate.score === best.score &&
          candidate.totalMs === best.candidate.totalMs &&
          candidate.nodeIds.join() < best.candidate.nodeIds.join()))
    ) {
      best.candidate = candidate;
      best.score = candidate.score;
    }
    const tail = path[path.length - 1];
    for (const next of outgoing(tail)) {
      if (path.includes(next)) continue;
      visit([...path, next]);
    }
  };

  for (const start of starts) {
    visit([start]);
  }

  return best.candidate;
}

/**
 * Convenience: plan a complete path and expose the discarded nodes. This is
 * what the run artifact records, so a failing run can be explained: the plan
 * carries the selected path and its estimated duration, and every omission —
 * budget, evidence, or lost the search — carries a reason.
 */
export function planPathWithOmissions(plan: ExplanationPlan): {
  plan: ExplanationPlan;
  selected: ExplanationNode[];
  omitted: { id: string; reason: string }[];
} {
  const graph = buildNarrativeGraphFromPlan(plan);
  const candidate = choosePath(graph, plan.targetDurationMs);
  const selected = candidate.nodeIds
    .map(id => nodeById(graph, id))
    .filter((node): node is ExplanationNode => Boolean(node));
  const omitted: { id: string; reason: string }[] = [...plan.omitted];
  for (const node of graph.nodes) {
    if (!selected.some(selectedNode => selectedNode.id === node.id)) {
      omitted.push({
        id: node.id,
        reason: candidate.reason ?? "not selected within the duration budget",
      });
    }
  }
  return {
    plan: {
      ...plan,
      selectedPath: candidate.nodeIds,
      estimatedDurationMs: Math.round(candidate.totalMs),
      omitted,
    },
    selected,
    omitted,
  };
}
