import assert from "node:assert/strict";
import { test, describe } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  findPolicyForUrl,
  loadRegistry,
  normalizePolicy,
  assertEvidenceAllowed,
  assertDiscoveryAllowed,
  clusterIndependence,
  originKey,
  countOrigins,
} from "../src/channels/news/sources.js";
import type { SourcePolicy } from "../src/channels/news/types.js";

const registryPath = path.join(process.cwd(), "config", "news-sources.json");

describe("news source registry — fail closed", () => {
  test("registry loads and every enabled source has explicit non-unknown basis", () => {
    const { policies } = loadRegistry(registryPath);
    assert.ok(policies.length > 20);
    for (const p of policies) {
      if (!p.enabled) continue;
      assert.notEqual(p.permissionBasis, "unknown", `${p.sourceId} enabled with unknown basis`);
      if (p.llmProcessingAllowed) {
        assert.ok(p.fullTextFetchAllowed, `${p.sourceId}: LLM without fullText`);
        assert.ok(p.quotationAllowed, `${p.sourceId}: LLM without quotationAllowed`);
      }
      assert.ok(p.permissionBasis, `${p.sourceId} missing basis`);
    }
  });

  test("government primary sources are permitted for evidence", () => {
    const { policies } = loadRegistry(registryPath);
    const pib = findPolicyForUrl("https://www.pib.gov.in/some-release", policies);
    assert.equal(pib?.sourceId, "pib.gov.in");
    assert.equal(pib?.fullTextFetchAllowed, true);
  });

  test("discovery-only sources (BBC) are not permitted for evidence", () => {
    const { policies } = loadRegistry(registryPath);
    assert.throws(() => assertEvidenceAllowed("https://www.bbc.co.uk/news/articles/abc", policies), /not permitted for evidence/);
    const policy = findPolicyForUrl("https://www.bbc.co.uk/news/world", policies);
    assert.equal(policy?.permissionBasis, "discovery_only");
    assert.equal(assertDiscoveryAllowed("https://www.bbc.co.uk/news/world", policies).sourceId, "bbc.co.uk");
  });

  test("unknown basis forces disabled", () => {
    const warnings: string[] = [];
    const p = normalizePolicy({
      sourceId: "example.com", domain: "example.com", documentTypes: ["article"],
      discoveryAllowed: true, metadataAllowed: true, fullTextFetchAllowed: true,
      llmProcessingAllowed: true, quotationAllowed: true,
      permissionBasis: "unknown", enabled: true,
      sourceRole: "independent_reporting", parentPublisherGroup: "Example", termsCheckedAt: "2026-11-10",
    } as SourcePolicy, warnings);
    assert.equal(p.enabled, false);
  });

  test("stale terms review degrades to discovery_only", () => {
    const warnings: string[] = [];
    const p = normalizePolicy({
      sourceId: "example.com", domain: "example.com", documentTypes: ["article"],
      discoveryAllowed: true, metadataAllowed: true, fullTextFetchAllowed: true,
      llmProcessingAllowed: true, quotationAllowed: true,
      permissionBasis: "terms_reviewed", enabled: true,
      sourceRole: "independent_reporting", parentPublisherGroup: "Example", termsCheckedAt: "2025-01-01",
    } as SourcePolicy, warnings);
    assert.equal(p.permissionBasis, "discovery_only");
    assert.equal(p.llmProcessingAllowed, false);
    assert.equal(p.fullTextFetchAllowed, false);
    assert.ok(warnings.some(w => w.includes("degraded")));
  });

  test("wire-lineage dedups same-origin items", () => {
    const { policies } = loadRegistry(registryPath);
    const pib = policies.find(p => p.sourceId === "pib.gov.in")!;
    const scr = policies.find(p => p.sourceId === "scr.gov.in")!;
    assert.notEqual(originKey(pib), originKey(scr));
    assert.equal(countOrigins([pib, scr, pib]), 2);
  });

  test("two distinct origins cluster as independent", () => {
    const { policies } = loadRegistry(registryPath);
    const pib = policies.find(p => p.sourceId === "pib.gov.in")!;
    const who = policies.find(p => p.sourceId === "who.int")!;
    assert.equal(clusterIndependence([pib, who]), "independent");
  });
});
