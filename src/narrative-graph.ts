import type {
  ExplanationEdge,
  ExplanationNode,
  ExplanationPlan,
} from "./explanation-planner.js";
import { estimateNodeDurationMs } from "./explanation-planner.js";

/**
 * Deterministic bounded narrative search (Pass A).
 *
 * The graph is a DAG over the evidence-backed explanation nodes. `choosePath`
 * evaluates a small meanwhile of contiguous paths. It is *not* a graph
 * optimizer over arbitrary cycles, because the evidence and duration budget
 * tolerate a linear explanatory sequence.
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

function requiredRoles(nodes: ExplanationNode[]): Set<string> {
  return new Set(nodes.filter(node => node.required).map(node => node.id));
}

function nodeById(graph: NarrativeGraph, id: string) {
  return graph.nodes.find(node => node.id === id) ?? null;
}

/**
 * Score a contiguous path against the graph. The path must contain every
 * required node and must stay inside the duration budget. Repeating a claim
 * is rejected immediately, before the style score is considered.
 */
export function scorePath(
  graph: NarrativeGraph,
  nodeIds: string[],
  budgetMs: number
): PathCandidate {
  const missingRequired = [...requiredRoles(graph.nodes)].filter(
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

  const usedFactIds = new Set<string>();
  const totalMs = nodeIds.reduce((sum, id) => {
    const node = nodeById(graph, id);
    if (!node) return sum;
    return sum + estimateNodeDurationMs(node);
  }, 0);
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

  let reusable = 0;
  const skipped: string[] = [];
  for (const id of nodeIds) {
    const node = nodeById(graph, id);
    if (!node) continue;
    if (node.evidence.some(reference => usedFactIds.has(reference.factId))) {
      skipped.push(id);
      continue;
    }
    reusable += 1;
    node.evidence.forEach(reference => usedFactIds.add(reference.factId));
  }
  if (reusable < nodeIds.length) {
    return {
      nodeIds,
      totalMs,
      score: Number.NEGATIVE_INFINITY,
      valid: false,
      reason: `path repeats evidence: ${skipped.join(", ")}`,
      skipped,
    };
  }

  const relevance = nodeIds.reduce((sum, id) => {
    const node = nodeById(graph, id);
    if (!node) return sum;
    return sum + nodeScore(graph, id);
  }, 0);

  return {
    nodeIds,
    totalMs,
    score: relevance,
    valid: true,
    skipped: [],
  };
}

/** Weighted, deterministic score for one node within a *path*. */
function nodeScore(graph: NarrativeGraph, nodeId: string): number {
  const node = nodeById(graph, nodeId);
  if (!node) return 0;
  const relation = graph.edges.find(
    edge => edge.from === nodeId || edge.to === nodeId
  );
  const relationBonus = relation ? 0.2 * relation.strength : 0;
  return (
    0.3 * node.importance +
    0.2 * node.novelty +
    0.3 * node.explanatoryValue +
    0.2 * (node.visualTargetIds.length > 0 ? 1 : 0.3) +
    relationBonus
  );
}

/**
 * Pick a contiguous path of evidence-enabled nodes that fits the duration
 * budget. Contiguous paths are enough for the current DAG because the planner
 * already emits nodes in narrative order.
 */
export function choosePath(
  graph: NarrativeGraph,
  budgetMs: number
): PathCandidate {
  const ids = graph.nodes.map(node => node.id);
  if (ids.length === 0) {
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
      reason: "no path satisfied the required roles and duration budget",
      skipped: [],
    },
    score: Number.NEGATIVE_INFINITY,
  };

  for (let start = 0; start < ids.length; start += 1) {
    for (let end = start + 1; end <= ids.length; end += 1) {
      const slice = ids.slice(start, end);
      const candidate = scorePath(graph, slice, budgetMs);
      if (!candidate.valid) continue;
      if (
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.totalMs < best.candidate.totalMs)
      ) {
        best.candidate = candidate;
        best.score = candidate.score;
      }
    }
  }

  return best.candidate;
}

/**
 * Convenience: plan a complete path and expose the discarded nodes. This is
 * what the run artifact should record, so a failing run can be explained.
 */
export function planPathWithOmissions(
  plan: ExplanationPlan
): { plan: ExplanationPlan; selected: ExplanationNode[]; omitted: { id: string; reason: string }[] } {
  const graph = buildNarrativeGraphFromPlan(plan);
  const candidate = choosePath(graph, plan.targetDurationMs);
  const selected = candidate.nodeIds
    .map(id => nodeById(graph, id))
    .filter((node): node is ExplanationNode => Boolean(node));
  const omitted: { id: string; reason: string }[] = [];
  for (const node of graph.nodes) {
    if (!selected.some(selectedNode => selectedNode.id === node.id)) {
      omitted.push({ id: node.id, reason: "not reachable within the duration budget" });
    }
  }
  return { plan: { ...plan, selectedPath: candidate.nodeIds }, selected, omitted };
}
