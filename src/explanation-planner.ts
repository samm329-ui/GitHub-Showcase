import type { EnrichedRepo, Fact, FactLedger, FactSemantic } from "./types.js";
import { ESTIMATED_WPM } from "./config.js";

/**
 * Evidence-driven explanation planner (Pass A).
 *
 * The planner does not invent narrative content. It selects which verified
 * fact groups are worth explaining, maps them into a stable narrative shape
 * grounded in *semantic roles* — a mechanism node is backed by mechanism
 * evidence, an example node by example evidence — and reports any role that
 * had no usable evidence. The graph search (`narrative-graph.ts`) picks the
 * connected path; the script composer turns that path into sentences.
 *
 * Budget discipline: required roles (purpose, mechanism) are admitted first,
 * then optional roles in explanatory priority order, each only if the running
 * estimate still fits the target duration. A metadata fact (stars, license,
 * activity) is never a node — padding the word budget with metadata is the
 * defect this planner exists to prevent.
 */

export type ExplanationRole =
  | "hook"
  | "problem"
  | "purpose"
  | "mechanism"
  | "example"
  | "benefit"
  | "differentiator"
  | "tradeoff"
  | "installation"
  | "closing";

export type EvidenceRef = {
  factId: string;
  sourceId: string;
  sourceKind: string;
  sourceLocation: string;
};

export type ExplanationNode = {
  id: string;
  role: ExplanationRole;
  proposition: string;
  evidence: EvidenceRef[];
  importance: number;
  novelty: number;
  explanatoryValue: number;
  estimatedWords: number;
  required: boolean;
  visualTargetIds: string[];
};

export type ExplanationEdge = {
  from: string;
  to: string;
  relation:
    | "explains"
    | "demonstrates"
    | "enables"
    | "contrasts"
    | "qualifies"
    | "follows";
  strength: number;
};

export type ExplanationPlan = {
  repositoryNodeId: string;
  fullName: string;
  targetDurationMs: number;
  estimatedDurationMs: number;
  nodes: ExplanationNode[];
  edges: ExplanationEdge[];
  selectedPath: string[];
  omitted: { id: string; reason: string }[];
};

const ROLE_IMPORTANCE: Record<ExplanationRole, number> = {
  hook: 0.4,
  problem: 0.7,
  purpose: 1,
  mechanism: 0.95,
  example: 0.85,
  benefit: 0.7,
  differentiator: 0.45,
  tradeoff: 0.55,
  installation: 0.6,
  closing: 0.35,
};

const ROLE_EXPLANATORY_VALUE: Record<ExplanationRole, number> = {
  hook: 0.45,
  problem: 0.65,
  purpose: 0.95,
  mechanism: 1,
  example: 0.9,
  benefit: 0.65,
  differentiator: 0.45,
  tradeoff: 0.55,
  installation: 0.65,
  closing: 0.3,
};

const ROLE_REQUIRED: Record<ExplanationRole, boolean> = {
  hook: false,
  problem: false,
  purpose: true,
  mechanism: true,
  example: false,
  benefit: false,
  differentiator: false,
  tradeoff: false,
  installation: false,
  closing: false,
};

/** Fallback semantic mapping for facts extracted without an explicit role. */
const KIND_SEMANTIC: Record<string, FactSemantic> = {
  purpose: "purpose",
  problem: "problem",
  feature: "mechanism",
  mechanism: "mechanism",
  workflow: "workflow",
  example: "example",
  use_case: "example",
  outcome: "outcome",
  install: "setup",
  requirement: "limitation",
  limitation: "limitation",
};

export function semanticOf(fact: Fact): FactSemantic {
  return fact.semantic ?? KIND_SEMANTIC[fact.kind] ?? "metadata";
}

/** Weighted node score; the graph search consumes this directly. */
export function scoreNode(node: ExplanationNode): number {
  return (
    0.3 * node.importance +
    0.2 * node.novelty +
    0.3 * node.explanatoryValue +
    0.2 * (node.visualTargetIds.length > 0 ? 1 : 0.3)
  );
}

function evidenceRef(fact: Fact): EvidenceRef {
  return {
    factId: fact.id,
    sourceId: fact.source.kind,
    sourceKind: fact.source.kind,
    sourceLocation: fact.source.location,
  };
}

function visualTargetIds(fact: Fact): string[] {
  if (
    fact.source.kind === "readme-section" ||
    fact.source.kind === "readme-code" ||
    fact.source.kind === "readme-table"
  ) {
    return [fact.source.location];
  }
  if (fact.source.kind === "release") return ["release"];
  return ["repo-header"];
}

function spokenWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** Estimated spoken duration for what will actually be spoken. */
export function estimateNodeDurationMs(
  node: ExplanationNode,
  wpm: number = ESTIMATED_WPM
): number {
  return (node.estimatedWords / wpm) * 60_000;
}

/**
 * A planned idea: one verified claim, stated plainly. The script composer —
 * not the planner — decides how to phrase the sentence around it, so the
 * proposition is the evidence's own spoken form, never a templated prefix
 * glued onto a README bullet.
 */
function makeNode(
  id: string,
  role: ExplanationRole,
  fact: Fact,
  required = ROLE_REQUIRED[role]
): ExplanationNode {
  const proposition = fact.spoken.trim();
  return {
    id,
    role,
    proposition,
    evidence: [evidenceRef(fact)],
    importance: ROLE_IMPORTANCE[role],
    novelty: 1,
    explanatoryValue: ROLE_EXPLANATORY_VALUE[role],
    estimatedWords: spokenWords(proposition),
    required,
    visualTargetIds: visualTargetIds(fact),
  };
}

function bestFact(candidates: Fact[], used: Set<string>): Fact | null {
  // `candidates` arrive already ranked (tier, confidence, README order); the
  // first unused entry wins so the ranking above is not silently discarded.
  return candidates.find(fact => !used.has(fact.id)) ?? null;
}

function withSemantic(ledger: FactLedger, role: FactSemantic): Fact[] {
  return ledger.facts
    .filter(fact => semanticOf(fact) === role)
    .sort(
      (a, b) => b.confidence - a.confidence || lineOf(a) - lineOf(b) || a.id.localeCompare(b.id)
    );
}

/** Provenance line when known; later than any unknown line. */
function lineOf(fact: Fact): number {
  return fact.provenance?.lineStart ?? Number.MAX_SAFE_INTEGER;
}

/** Rank mechanism evidence: dedicated "how it works" prose, then mechanism
 * bullets, then outcome bullets; earlier README placement wins ties. */
function rankMechanisms(ledger: FactLedger): Fact[] {
  const candidates = ledger.facts.filter(fact => {
    const semantic = semanticOf(fact);
    return semantic === "mechanism" || semantic === "outcome";
  });
  return candidates.sort((a, b) => {
    const tier = (fact: Fact) => {
      const semantic = semanticOf(fact);
      if (fact.kind === "mechanism") return 0;
      return semantic === "mechanism" ? 1 : 2;
    };
    return (
      tier(a) - tier(b) ||
      b.confidence - a.confidence ||
      lineOf(a) - lineOf(b) ||
      a.id.localeCompare(b.id)
    );
  });
}

/** Rank example evidence: command tables and documented commands first. */
function rankExamples(ledger: FactLedger): Fact[] {
  const candidates = ledger.facts.filter(fact => {
    const semantic = semanticOf(fact);
    return semantic === "example" || semantic === "workflow";
  });
  return candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      lineOf(a) - lineOf(b) ||
      a.id.localeCompare(b.id)
  );
}

type NodeSpec = {
  id: string;
  role: ExplanationRole;
  candidates: Fact[];
  /** Lower fills the budget first. Required roles bypass the priority. */
  priority: number;
};

/**
 * Build an `ExplanationPlan` from verified evidence.
 *
 * Every node claims exactly one fact, and no fact is claimed twice, so the
 * evidence gate stays explicit. Nodes are admitted in narrative order but only
 * while the running estimate fits the duration budget; roles that never fit
 * (or have no evidence) are recorded in `omitted` with the reason.
 */
export function planEvidence(
  ledger: FactLedger,
  repo: EnrichedRepo,
  targetDurationMs: number
): ExplanationPlan {
  const used = new Set<string>();
  const omitted: { id: string; reason: string }[] = [];

  const hasExampleEvidence = rankExamples(ledger).length > 0;
  const isRoleRequired = (role: ExplanationRole) => {
    if (role === "example") return hasExampleEvidence;
    return ROLE_REQUIRED[role];
  };

  const specs: NodeSpec[] = [
    {
      id: "problem",
      role: "problem",
      candidates: withSemantic(ledger, "problem"),
      priority: 3,
    },
    {
      id: "purpose",
      role: "purpose",
      candidates: withSemantic(ledger, "purpose"),
      priority: 0,
    },
    {
      id: "mechanism",
      role: "mechanism",
      candidates: rankMechanisms(ledger),
      priority: 0,
    },
    {
      id: "example",
      role: "example",
      candidates: rankExamples(ledger),
      priority: hasExampleEvidence ? 0 : 1,
    },
    {
      id: "benefit",
      role: "benefit",
      candidates: withSemantic(ledger, "outcome"),
      priority: 4,
    },
    {
      id: "tradeoff",
      role: "tradeoff",
      candidates: withSemantic(ledger, "limitation"),
      priority: 5,
    },
    {
      id: "installation",
      role: "installation",
      candidates: withSemantic(ledger, "setup"),
      priority: 2,
    },
  ];

  /* Required roles first, then optional roles by explanatory priority. */
  const ordered = [
    ...specs.filter(spec => isRoleRequired(spec.role)),
    ...specs
      .filter(spec => !isRoleRequired(spec.role))
      .sort((a, b) => a.priority - b.priority),
  ];

  const nodes: ExplanationNode[] = [];
  const admitted = new Set<ExplanationRole>();
  let usedMs = 0;

  for (const spec of ordered) {
    const fact = bestFact(spec.candidates, used);
    if (!fact) {
      omitted.push({
        id: spec.id,
        reason: `the ledger has no ${spec.role} evidence`,
      });
      continue;
    }
    const node = makeNode(spec.id, spec.role, fact, isRoleRequired(spec.role));
    const nodeMs = estimateNodeDurationMs(node);
    if (!isRoleRequired(spec.role) && usedMs + nodeMs > targetDurationMs) {
      omitted.push({
        id: spec.id,
        reason: `a ${spec.role} node does not fit the ${targetDurationMs}ms duration budget`,
      });
      continue;
    }
    nodes.push(node);
    admitted.add(spec.role);
    used.add(fact.id);
    usedMs += nodeMs;
  }

  /* Narrative order, independent of admission priority. */
  const order: ExplanationRole[] = [
    "problem",
    "purpose",
    "mechanism",
    "example",
    "benefit",
    "tradeoff",
    "installation",
  ];
  nodes.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));

  const edges = connectNodes(nodes);
  const totalMs = nodes.reduce((sum, node) => sum + estimateNodeDurationMs(node), 0);

  return {
    repositoryNodeId: ledger.repositoryNodeId,
    fullName: ledger.fullName,
    targetDurationMs,
    estimatedDurationMs: Math.round(totalMs),
    nodes,
    edges,
    selectedPath: [],
    omitted,
  };
}

/**
 * Connect the planned nodes. Every consecutive pair gets an edge, and a
 * skip-one edge lets the graph search drop a middle idea (say, the problem)
 * without disconnecting the path — the selector reasons over relationships,
 * not over list adjacency alone.
 */
function connectNodes(nodes: ExplanationNode[]): ExplanationEdge[] {
  const edges: ExplanationEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1];
    const current = nodes[index];
    const relation = edgeFor(previous.role, current.role);
    edges.push({ from: previous.id, to: current.id, relation, strength: 0.8 });
  }
  for (let index = 0; index + 2 < nodes.length; index += 1) {
    const previous = nodes[index];
    const next = nodes[index + 2];
    edges.push({
      from: previous.id,
      to: next.id,
      relation: "follows",
      strength: 0.6,
    });
  }
  return edges;
}

function edgeFor(
  from: ExplanationRole,
  to: ExplanationRole
): ExplanationEdge["relation"] {
  if (from === "problem" && (to === "purpose" || to === "mechanism")) return "explains";
  if (from === "purpose" && (to === "mechanism" || to === "benefit" || to === "example")) {
    return "explains";
  }
  if (from === "mechanism" && (to === "example" || to === "benefit")) return "demonstrates";
  if (from === "example" && to === "benefit") return "enables";
  if (from === "benefit" && to === "tradeoff") return "qualifies";
  if (from === "tradeoff" && to === "installation") return "follows";
  return "follows";
}
