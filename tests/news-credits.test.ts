import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildSourceCredits } from "../src/channels/news/credits.js";
import type { EvidenceLedger, FactRecord, EvidenceRecord } from "../src/channels/news/types.js";
import type { SourcePolicy } from "../src/channels/news/types.js";

const policy = (id: string, group: string, role: "primary" | "independent_reporting" | "discovery", basis = "terms_reviewed"): SourcePolicy => ({
  sourceId: id,
  domain: id,
  documentTypes: ["press_release"],
  discoveryAllowed: true,
  metadataAllowed: true,
  fullTextFetchAllowed: role !== "discovery" && basis !== "discovery_only",
  llmProcessingAllowed: role !== "discovery" && basis !== "discovery_only",
  quotationAllowed: true,
  permissionBasis: basis === "discovery_only" ? "discovery_only" : "terms_reviewed",
  enabled: true,
  sourceRole: role,
  parentPublisherGroup: group,
});

const evidence = (sourceId: string, group: string, role: "primary" | "independent_reporting" | "discovery"): EvidenceRecord => {
  const policyObj = policy(sourceId, group, role);
  return {
    sourceId,
    url: `https://${sourceId}/item`,
    publisher: group,
    parentPublisherGroup: group,
    sourceRole: role,
    policy: policyObj,
    independenceStatus: "independent",
    supports: "supports",
    fetchedAt: "2026-11-10T09:00:00Z",
    excerpt: "Short excerpt.",
    locator: "p1",
    publishedAt: "2026-11-10T08:00:00Z",
  };
};

const fact = (id: string, evs: EvidenceRecord[]): FactRecord => ({
  id,
  claim: `Claim ${id}`,
  kind: "event",
  status: "verified",
  importance: "core",
  contentClass: "fact",
  evidence: evs,
  independenceCount: new Set(evs.map(e => e.parentPublisherGroup)).size,
  confidence: 0.9,
  verifiedByHuman: false,
});

const ledger = (facts: FactRecord[]): EvidenceLedger => ({
  storyId: "story_test",
  capturedAt: "2026-11-10T09:00:00Z",
  facts,
  verifierPassed: true,
  verifierErrors: [],
  verifierWarnings: [],
  independenceCount: 2,
});

describe("source credits — supporting sources only", () => {
  test("credits name primary records and independent reporting only", () => {
    const ledgerData = ledger([
      fact("F001", [evidence("pib.gov.in", "Government of India", "primary")]),
      fact("F002", [evidence("prsindia.org", "PRS Legislative Research", "independent_reporting")]),
      fact("F003", [evidence("bbc.co.uk", "BBC", "discovery")]),
    ]);
    const credits = buildSourceCredits(ledgerData, "2026-11-10T10:00:00Z");
    const names = credits.credits.map(c => c.name);
    assert.ok(names.some(n => n.includes("Government of India") || n.includes("PIB")));
    assert.ok(names.includes("PRS"));
    assert.ok(!credits.credits.some(c => c.name.includes("BBC")), "BBC must never appear in credits");
  });

  test("discovery-only evidence never yields credits", () => {
    const discovery = evidence("bbc.co.uk", "BBC", "discovery");
    discovery.policy = { ...discovery.policy, permissionBasis: "discovery_only", fullTextFetchAllowed: false, llmProcessingAllowed: false };
    const ledgerData = ledger([fact("F001", [discovery])]);
    const credits = buildSourceCredits(ledgerData, "2026-11-10T10:00:00Z");
    assert.equal(credits.credits.length, 0);
    assert.ok(credits.headline.startsWith("Primary source reporting"));
  });

  test("headline joins supporting source names", () => {
    const ledgerData = ledger([
      fact("F001", [evidence("pib.gov.in", "Government of India", "primary")]),
    ]);
    const credits = buildSourceCredits(ledgerData, "2026-11-10T10:00:00Z");
    assert.match(credits.headline, /Based on reporting by/);
  });
});
