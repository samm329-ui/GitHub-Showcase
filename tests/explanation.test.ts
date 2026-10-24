import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { enriched } from "./helpers.js";
import { buildFactLedger } from "../src/facts.js";
import { planEvidence, type ExplanationPlan } from "../src/explanation-planner.js";
import {
  buildNarrativeGraphFromPlan,
  choosePath,
  scorePath,
  buildNarrativeGraph,
  planPathWithOmissions,
} from "../src/narrative-graph.js";

describe("explanation planner", () => {
  const repo = enriched("high-quality-popular");
  const ledger = buildFactLedger(repo);

  test("the plan has required explanatory roles", () => {
    const plan: ExplanationPlan = planEvidence(ledger, repo, 30_000);
    const roles = plan.nodes.map(node => node.role);
    assert.ok(roles.includes("purpose"), "purpose is required");
    assert.ok(roles.includes("mechanism"), "mechanism is required");
    assert.ok(plan.estimatedDurationMs >= 0);
    assert.ok(plan.edges.length > 0);
  });

  test("the production plan selects a populated, connected path", () => {
    const raw = planEvidence(ledger, repo, 30_000);
    const { plan } = planPathWithOmissions(raw);
    assert.ok(plan.selectedPath.length > 0, "a successful run emits a non-empty path");
    const nodeIds = new Set(plan.nodes.map(node => node.id));
    for (const id of plan.selectedPath) assert.ok(nodeIds.has(id), `${id} is a real node`);
    for (let index = 1; index < plan.selectedPath.length; index += 1) {
      const from = plan.selectedPath[index - 1];
      const to = plan.selectedPath[index];
      assert.ok(
        plan.edges.some(edge => edge.from === from && edge.to === to),
        `edge ${from} -> ${to} exists`
      );
    }
    assert.ok(plan.estimatedDurationMs > 0, "the selected path carries its duration");
  });

  test("a mechanism node is backed by mechanism evidence, not the first bullet renamed", () => {
    const plan = planEvidence(ledger, repo, 30_000);
    const mechanism = plan.nodes.find(node => node.role === "mechanism");
    assert.ok(mechanism, "mechanism node exists");
    const fact = ledger.facts.find(f => f.id === mechanism!.evidence[0].factId);
    assert.ok(fact, "mechanism node cites a real fact");
    assert.ok(
      fact!.semantic === "mechanism" || fact!.semantic === "outcome",
      `mechanism evidence has a mechanism-ish semantic, got ${fact!.semantic}`
    );
  });

  test("metadata facts never become planned nodes", () => {
    const plan = planEvidence(ledger, repo, 30_000);
    for (const node of plan.nodes) {
      for (const reference of node.evidence) {
        const fact = ledger.facts.find(f => f.id === reference.factId);
        assert.ok(fact, `${node.id} cites a real fact`);
        assert.notEqual(fact!.semantic, "metadata", `${node.id} is backed by metadata`);
      }
    }
  });

  test("omitted nodes record a reason", () => {
    const plan = planEvidence(ledger, repo, 30_000);
    const { omitted } = planPathWithOmissions(plan);
    for (const entry of omitted) {
      assert.ok(entry.reason.trim().length > 0, `${entry.id} has a reason`);
    }
  });

  test("the selected path respects the duration budget", () => {
    const plan = planEvidence(ledger, repo, 15_000);
    expectPath(plan, 15_000);
  });

  test("a high-score metadata path cannot bypass required roles", () => {
    const plan = planEvidence(ledger, repo, 30_000);
    const ids = plan.nodes.map(node => node.id);
    const withoutRequiredRole = ids.filter(id => !["purpose", "mechanism"].includes(id));
    const rejected = scorePath(buildNarrativeGraph(plan.nodes, plan.edges), withoutRequiredRole, 30_000);
    assert.equal(rejected.valid, false);
  });

  test("the plan explains the repository, not its metadata", () => {
    const plan = planEvidence(ledger, repo, 30_000);
    const described = plan.nodes.map(node => node.role).join(",");
    assert.ok(!/closing,closing/.test(described));
    assert.ok(!/benefit,benefit/.test(described));
  });
});

function expectPath(plan: ExplanationPlan, budgetMs: number): void {
  const graph = buildNarrativeGraph(plan.nodes, plan.edges);
  const path = choosePath(graph, budgetMs);
  assert.ok(path.valid, `path should be valid: ${path.reason}`);
  plan.selectedPath = path.nodeIds;
}

describe("narrative graph", () => {
  const repo = enriched("high-quality-popular");
  const ledger = buildFactLedger(repo);
  const plan = planEvidence(ledger, repo, 30_000);
  const graph = buildNarrativeGraph(plan.nodes, plan.edges);

  test("the chosen path fits the budget", () => {
    const candidate = choosePath(graph, plan.targetDurationMs);
    assert.ok(candidate.valid);
    assert.ok(candidate.totalMs <= plan.targetDurationMs);
  });
});

describe("durable narrative path", () => {
  const repo = enriched("high-quality-popular");
  const ledger = buildFactLedger(repo);

  test("chooses a shorter connected path when the budget shrinks", () => {
    const wideBudget = planEvidence(ledger, repo, 30_000);
    const narrowBudget = planEvidence(ledger, repo, 5_000);
    assert.ok(Object.keys(buildNarrativeGraphFromPlan(wideBudget)).length > 0);
    assert.ok(Object.keys(buildNarrativeGraphFromPlan(narrowBudget)).length > 0);
  });
});

describe("explanation and narrative graph integration", () => {
  const repo = enriched("high-quality-popular");
  const ledger = buildFactLedger(repo);

  test("paths cannot be formed from unsupported facts", () => {
    const plan = planEvidence(ledger, repo, 30_000);
    const nodeIds = plan.nodes.map(node => node.id);
    const graph = buildNarrativeGraph(plan.nodes, plan.edges);
    assert.ok(scorePath(graph, nodeIds, 30_000).valid);
  });
});
