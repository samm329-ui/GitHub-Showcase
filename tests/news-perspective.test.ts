import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { EvidenceRecord, SourcePolicy } from "../src/channels/news/types.js";
import { computePerspectiveCoverage } from "../src/channels/news/perspectives.js";

const outlet = (sourceId: string, perspective: SourcePolicy["perspective"], role: SourcePolicy["sourceRole"] = "independent_reporting"): SourcePolicy => ({
  sourceId,
  domain: sourceId,
  documentTypes: ["article"],
  discoveryAllowed: true,
  metadataAllowed: true,
  fullTextFetchAllowed: false,
  llmProcessingAllowed: false,
  quotationAllowed: false,
  permissionBasis: "discovery_only",
  enabled: true,
  sourceRole: role,
  parentPublisherGroup: sourceId,
  wireOrigin: "none",
  perspective,
  termsCheckedAt: "2026-11-13",
});

const record = (sourceId: string, perspective: SourcePolicy["perspective"], role?: SourcePolicy["sourceRole"]): EvidenceRecord => ({
  sourceId,
  url: `https://${sourceId}/story`,
  publisher: sourceId,
  parentPublisherGroup: sourceId,
  wireOrigin: "none",
  sourceRole: role ?? "independent_reporting",
  policy: outlet(sourceId, perspective, role ?? "independent_reporting"),
  independenceStatus: "unknown",
  excerpt: "example",
  supports: "context_only",
  fetchedAt: new Date().toISOString(),
});

describe("perspective balance — the 'every perspective' check", () => {
  test("primary records alone produce no editorial cover and an explicit warning line", () => {
    const cov = computePerspectiveCoverage([record("pib.gov.in", undefined, "primary")]);
    assert.equal(cov.perspectivesPresent.length, 0);
    assert.equal(cov.singlePerspective, false);
    assert.equal(cov.spectrumComplete, false);
    assert.ok(cov.brief.some(l => l.includes("cannot be performed")));
  });

  test("all independent evidence from one perspective is flagged singlePerspective", () => {
    const cov = computePerspectiveCoverage([
      record("swarajyamag.com", "right"),
      record("foxnews.com", "right"),
    ]);
    assert.equal(cov.singlePerspective, true);
    assert.deepEqual(cov.outletsByPerspective.right, ["foxnews.com", "swarajyamag.com"]);
    assert.ok(cov.brief.some(l => l.toLowerCase().includes("single") || l.includes("one-sided")));
  });

  test("both poles present → spectrum complete, no single-perspective flag", () => {
    const cov = computePerspectiveCoverage([
      record("thewire.in", "left"),
      record("timesofindia.indiatimes.com", "centre"),
      record("swarajyamag.com", "right"),
    ]);
    assert.equal(cov.singlePerspective, false);
    assert.equal(cov.spectrumComplete, true);
    assert.equal(cov.perspectivesPresent.length, 3);
    assert.ok(cov.brief.some(l => l.includes("Both poles")));
  });

  test("fact-check and aggregator roles never count as editorial cover", () => {
    const cov = computePerspectiveCoverage([
      record("altnews.in", undefined, "fact_check"),
      record("api.gdeltproject.org", undefined, "discovery"),
      record("swarajyamag.com", "right"),
    ]);
    assert.deepEqual(cov.perspectivesPresent, ["right"]);
    assert.equal(cov.singlePerspective, true);
  });
});
