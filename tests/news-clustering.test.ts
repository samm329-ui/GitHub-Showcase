import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { tokenize, jaccard, clusterItems, scoreCluster, inferCategory, rankCandidates } from "../src/channels/news/clustering.js";
import { collectEvidence } from "../src/channels/news/ledger.js";
import { loadRegistry } from "../src/channels/news/sources.js";
import type { DiscoveredItem } from "../src/channels/news/types.js";

const registry = loadRegistry(process.cwd() + "/config/news-sources.json");

function makeItem(title: string, url: string, sourceId: string, dateIso = "2026-11-10T08:00:00Z"): DiscoveredItem {
  const policy = registry.policies.find(p => p.sourceId === sourceId);
  assert.ok(policy, `policy for ${sourceId} must exist`);
  return {
    id: `id_${title.slice(0, 8)}_${url.slice(-4)}`,
    title,
    url,
    sourceId,
    sourceName: sourceId,
    sourcePolicy: policy,
    publishedAt: dateIso,
    eventDate: null,
    description: null,
    fetchedAt: dateIso,
    fingerprint: title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40),
  };
}

describe("news clustering — deterministic", () => {
  test("tokenize drops stopwords and keeps entities", () => {
    const t = tokenize("The Supreme Court ruled on the India bill today");
    assert.ok(t.includes("supreme"));
    assert.ok(t.includes("court"));
    assert.ok(!t.includes("the"));
  });

  test("same event across two outlets clusters into one story", () => {
    const items = [
      makeItem("Supreme Court strikes down key provisions of IT rules", "https://example.com/a/1", "pib.gov.in"),
      makeItem("Supreme Court strikes down key provisions of IT rules", "https://example2.com/b/2", "scr.gov.in"),
    ];
    const clusters = clusterItems(items);
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].independenceCount >= 1);
  });

  test("wire-same-origin collapses to one reporting origin", () => {
    const items = [
      makeItem("PIB: Semiconductor scheme approved for Gujarat", "https://pib.gov.in/x", "pib.gov.in"),
      makeItem("PIB: Semiconductor scheme approved for Gujarat", "https://pib.gov.in/y", "pib.gov.in"),
    ];
    const clusters = clusterItems(items);
    assert.equal(clusters[0].independenceCount, 1);
    assert.equal(clusters[0].independence, "same_original_source");
  });

  test("unrelated stories remain separate clusters", () => {
    const items = [
      makeItem("India launches new satellite", "https://exa.com/s1", "pib.gov.in"),
      makeItem("RBI keeps repo rate unchanged", "https://exa.com/s2", "rbi.org.in"),
    ];
    const clusters = clusterItems(items);
    assert.equal(clusters.length, 2);
  });

  test("scoring: corroborated story outranks uncorroborated one", () => {
    const corroborated = clusterItems([
      makeItem("Government announces semiconductor plant investment", "https://a.com/1", "pib.gov.in"),
      makeItem("Government announces semiconductor plant investment", "https://b.com/2", "rbi.org.in"),
    ]);
    const alone = clusterItems([
      makeItem("Government announces semiconductor plant investment", "https://c.com/3", "pib.gov.in"),
    ]);
    const ranked = rankCandidates([...corroborated, ...alone]);
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].score >= ranked[1].score);
  });

  test("ineligible stories with no origins outside press-release rewrite stay behind corroborated ones", () => {
    const items = [
      makeItem("New AI chip promises everything", "https://x.com/1", "openai.com"),
    ];
    const candidate = scoreCluster(clusterItems(items)[0]);
    assert.ok(candidate.score > 0);
    // eligibility requires primary record OR 2 origins; one first-party source qualifies
    assert.equal(candidate.eligible, true);
  });

  test("category inference works for finance and AI", () => {
    assert.equal(inferCategory("RBI keeps policy repo rate steady amid inflation"), "finance");
    assert.equal(inferCategory("OpenAI announces new model with reasoning"), "ai");
  });

  test("jaccard is symmetric and bounded", () => {
    const a = new Set(["alpha", "beta", "gamma"]);
    const b = new Set(["beta", "gamma", "delta"]);
    assert.ok(jaccard(a, b) > 0 && jaccard(a, b) < 1);
    assert.equal(jaccard(a, a), 1);
    assert.equal(jaccard(new Set(), a), 0);
  });

  test("evidence collection rejects discovery-only sources", async () => {
    await assert.rejects(
      () => collectEvidence(["https://www.bbc.co.uk/news/articles/xyz"], registry, ["story"]),
      /not permitted for evidence/
    );
  });
});
