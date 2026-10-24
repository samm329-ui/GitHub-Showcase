import type { EnrichedRepo, Fact, FactLedger } from "./types.js";

/**
 * Evidence-driven explanation planner (Pass A).
 *
 * The planner does not invent narrative content. It only selects which verified
 * fact groups are worth explaining, maps them into a stable narrative shape,
 * and reports any role that had no usable evidence. The graph selection and
 * script composer consume the resulting `ExplanationPlan`.
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

const ROLE_ORDER: ExplanationRole[] = [
  "hook",
  "problem",
  "purpose",
  "mechanism",
  "example",
  "benefit",
  "differentiator",
  "tradeoff",
  "installation",
  "closing",
];

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
  if (fact.source.kind === "readme-section" || fact.source.kind === "readme-code") {
    return [fact.source.location];
  }
  if (fact.source.kind === "release") return ["release"];
  return ["repo-header"];
}

function spokenWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function nodeText(fact: Fact, prefix: string): string {
  const cleaned = fact.spoken.trim();
  return `${prefix} ${cleaned}`;
}

function makeNode(
  id: string,
  role: ExplanationRole,
  facts: Fact[]
): ExplanationNode | null {
  if (facts.length === 0) return null;
  const fact = facts[0];
  const proposition = nodeText(fact, ROLE_PREFIX[role]);
  return {
    id,
    role,
    proposition,
    evidence: [evidenceRef(fact)],
    importance: ROLE_IMPORTANCE[role],
    novelty: 1,
    explanatoryValue: ROLE_EXPLANATORY_VALUE[role],
    estimatedWords: spokenWords(proposition),
    required: ROLE_REQUIRED[role],
    visualTargetIds: visualTargetIds(fact),
  };
}

const ROLE_PREFIX: Record<ExplanationRole, string> = {
  hook: "Meet",
  problem: "It solves",
  purpose: "It is",
  mechanism: "How it works",
  example: "For example",
  benefit: "The benefit",
  differentiator: "This stands out",
  tradeoff: "The trade-off",
  installation: "To get started",
  closing: "Wrap up",
};

function groupByKind(
  ledger: FactLedger
): Map<Fact["kind"], Fact[]> {
  const map = new Map<Fact["kind"], Fact[]>();
  for (const fact of ledger.facts) {
    const bucket = map.get(fact.kind) ?? [];
    bucket.push(fact);
    map.set(fact.kind, bucket);
  }
  return map;
}

/**
 * Build an `ExplanationPlan` from verified evidence.
 * We never project a claim that the ledger itself does not contain; a fact can
 * support multiple nodes, but every duplicate keeps the same `factId`, which
 * makes the evidence gate explicit.
 */
export function planEvidence(
  ledger: FactLedger,
  repo: EnrichedRepo,
  targetDurationMs: number
): ExplanationPlan {
  const byKind = groupByKind(ledger);
  const usedFactIds = new Set<string>();
  const nodes: ExplanationNode[] = [];
  const omitted: { id: string; reason: string }[] = [];
  const usedNodeIds = new Set<string>();

  const push = (node: ExplanationNode): void => {
    if (usedNodeIds.has(node.id)) return;
    if (node.evidence.some(reference => usedFactIds.has(reference.factId))) {
      omitted.push({ id: node.id, reason: "the fact is already claimed by another node" });
      return;
    }
    usedNodeIds.add(node.id);
    nodes.push(node);
    node.evidence.forEach(reference => usedFactIds.add(reference.factId));
  };

  let featureCount = 0;
  const features = byKind.get("feature") ?? [];
  const useCases = byKind.get("use_case") ?? [];
  const installs = byKind.get("install") ?? [];
  const requirements = [...(byKind.get("requirement") ?? []), ...(byKind.get("limitation") ?? [])];
  const licenses = byKind.get("license") ?? [];
  const activity = byKind.get("activity") ?? [];

  const purposes = byKind.get("purpose") ?? [];
  if (purposes.length > 0) {
    const node = makeNode("purpose", "purpose", [purposes[0]]);
    if (node) push(node);
  } else {
    const feature = features[0] ?? null;
    const fallback = feature ?? activity[0] ?? null;
    if (fallback) {
      const node = makeNode("hook", "hook", [fallback]);
      if (node) push(node);
    } else {
      omitted.push({ id: "hook", reason: "the repository has no purpose or feature fact" });
    }
  }

  for (const feature of features) {
    if (featureCount >= 2) break;
    const role = featureCount === 0 ? "mechanism" : "benefit";
    const node = makeNode(
      `${role}-${featureCount + 1}`,
      role,
      [feature]
    );
    if (node) push(node);
    featureCount += 1;
  }
  if (featureCount === 0) {
    omitted.push({ id: "mechanism", reason: "the ledger has no feature evidence" });
  }

  if (useCases.length > 0) {
    const node = makeNode("example", "example", [useCases[0]]);
    if (node) push(node);
  } else {
    omitted.push({ id: "example", reason: "the ledger has no use-case evidence" });
  }

  if (installs.length > 0) {
    const node = makeNode("installation", "installation", [installs[0]]);
    if (node) push(node);
  } else {
    omitted.push({ id: "installation", reason: "the ledger has no install evidence" });
  }

  if (requirements.length > 0) {
    const node = makeNode("tradeoff", "tradeoff", [requirements[0]]);
    if (node) push(node);
  } else {
    omitted.push({ id: "tradeoff", reason: "the ledger has no constraint or licence evidence" });
  }

  if (licenses.length > 0) {
    const node = makeNode("differentiator", "differentiator", [licenses[0]]);
    if (node) push(node);
  } else {
    omitted.push({ id: "differentiator", reason: "the ledger has no licence evidence" });
  }

  if (activity.length > 0) {
    const node = makeNode("closing", "closing", [activity[0]]);
    if (node) push(node);
  } else {
    omitted.push({ id: "closing", reason: "the ledger has no recent-activity evidence" });
  }

  return {
    repositoryNodeId: ledger.repositoryNodeId,
    fullName: ledger.fullName,
    targetDurationMs,
    estimatedDurationMs: 0,
    nodes,
    edges: connectNodes(nodes),
    selectedPath: [],
    omitted,
  };
}

function connectNodes(nodes: ExplanationNode[]): ExplanationEdge[] {
  const edges: ExplanationEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1];
    const current = nodes[index];
    const relation = edgeFor(previous.role, current.role);
    if (!relation) continue;
    edges.push({ from: previous.id, to: current.id, relation, strength: 0.8 });
  }
  return edges;
}

function edgeFor(
  from: ExplanationRole,
  to: ExplanationRole
): ExplanationEdge["relation"] | null {
  if (from === "purpose" && (to === "mechanism" || to === "benefit" || to === "example")) return "explains";
  if (from === "mechanism" && (to === "example" || to === "benefit")) return "demonstrates";
  if (from === "example" && to === "benefit") return "enables";
  if (from === "benefit" && to === "differentiator") return "contrasts";
  if (from === "differentiator" && to === "tradeoff") return "qualifies";
  if (from === "tradeoff" && to === "installation") return "follows";
  if (to === "installation" || to === "closing") return "follows";
  return "follows";
}

/** Estimated spoken duration, ignoring pauses baked into synthesized audio. */
export function estimateNodeDurationMs(node: ExplanationNode, wpm = 165): number {
  return (node.estimatedWords / wpm) * 60_000;
}
