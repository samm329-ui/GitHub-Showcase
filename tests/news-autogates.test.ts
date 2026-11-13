import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { evaluateGateA, evaluateGateB } from "../src/channels/news/auto-gates.js";
import type { EvidenceLedger, EvidenceRecord, FactRecord, SourcePolicy } from "../src/channels/news/types.js";

const HASH = "a".repeat(64);
const outlet = (sourceId: string, group: string, role: SourcePolicy["sourceRole"] = "independent_reporting"): SourcePolicy => ({
  sourceId, domain: sourceId, documentTypes: ["article"],
  discoveryAllowed: true, metadataAllowed: true, fullTextFetchAllowed: false,
  llmProcessingAllowed: false, quotationAllowed: false,
  permissionBasis: "discovery_only", enabled: true,
  sourceRole: role, parentPublisherGroup: group, wireOrigin: "none",
  termsCheckedAt: "2026-11-13", perspective: "centre",
});
const record = (sourceId: string, group: string, role?: SourcePolicy["sourceRole"]): EvidenceRecord => ({
  sourceId, url: `https://${sourceId}/x`, publisher: sourceId,
  parentPublisherGroup: group, wireOrigin: "none",
  sourceRole: role ?? "independent_reporting",
  policy: outlet(sourceId, group, role ?? "independent_reporting"),
  independenceStatus: "independent",
  supports: "supports",
  fetchedAt: new Date().toISOString(),
});
const fact = (id: string, status: FactRecord["status"], kind: FactRecord["kind"] = "number", importance: FactRecord["importance"] = "core"): FactRecord => ({
  id, claim: `claim-${id}`, kind, status, importance,
  contentClass: "fact",
  evidence: [],
  independenceCount: 2,
  confidence: 0.9,
  verifiedByHuman: false,
});
const ledger = (facts: FactRecord[]): EvidenceLedger => ({
  storyId: "story_test", capturedAt: new Date().toISOString(),
  facts,
  verifierPassed: facts.every(f => f.status === "verified" || f.status === "attributed"),
  verifierErrors: [], verifierWarnings: [],
  independenceCount: facts.length,
});

describe("automated Gate A — refuses weak evidence, approves strong", () => {
  test("passes when two independent outlets support and a hard fact verifies", () => {
    const records = [record("thehindu.com", "The Hindu Group"), record("swarajyamag.com", "Swarajya")];
    const l = ledger([fact("F1", "verified", "number"), fact("F2", "attributed", "claim_by_actor")]);
    const d = evaluateGateA(l, records);
    assert.equal(d.approved, true, JSON.stringify(d));
  });
  test("approves first-party self-announcement when core facts verify (with loud note)", () => {
    const records = [record("blog.google", "Google", "primary"), record("openai.com", "OpenAI", "primary")];
    // NOTE: records above are not the same group — make a single-origin one for this case:
    records.length = 0;
    records.push(record("blog.google", "Google", "primary"), record("deepmind.google", "Google", "primary"));
    const l = ledger([fact("F1", "verified", "number")]);
    const d = evaluateGateA(l, records);
    assert.equal(d.approved, true, JSON.stringify(d));
    if (d.approved) assert.match(d.note, /self-announcement/);
  });
  test("refuses single-origin evidence even with verified facts", () => {
    const records = [record("timesofindia.indiatimes.com", "Times Group"), record("economictimes.indiatimes.com", "Times Group")];
    const l = ledger([fact("F1", "verified", "number")]);
    const d = evaluateGateA(l, records);
    assert.equal(d.approved, false);
    assert.match(d.reason, /independent origins|syndicated|group\(s\)/);
  });
  test("refuses when a disputed claim exists", () => {
    const records = [record("thehindu.com", "The Hindu Group"), record("swarajyamag.com", "Swarajya")];
    const l = ledger([fact("F1", "verified", "number"), fact("F2", "disputed", "number")]);
    const d = evaluateGateA(l, records);
    assert.equal(d.approved, false);
    assert.match(d.reason, /disputed/);
  });
  test("refuses when no hard fact verifies (only commentary)", () => {
    const records = [record("thehindu.com", "The Hindu Group"), record("swarajyamag.com", "Swarajya")];
    const l = ledger([fact("F1", "verified", "analysis"), fact("F2", "attributed", "claim_by_actor")]);
    const d = evaluateGateA(l, records);
    assert.equal(d.approved, false);
    assert.match(d.reason, /hard fact/);
  });
});
describe("automated Gate B — refuses broken scripts", () => {
  const script = { narration: [{ id: "N001", text: "RBI holds the repo rate.", factIds: ["F1", "F2", "F3"] }] };
  test("passes a validator-green, evidence-cited script", () => {
    const facts = [fact("F1", "verified", "number"), fact("F2", "verified", "date"), fact("F3", "verified", "quote")];
    (facts[0] as { evidence: { excerpt: string }[] }).evidence = [{ excerpt: "RBI holds the repo rate." }];
    (facts[1] as { evidence: { excerpt: string }[] }).evidence = [{ excerpt: "6.5%" }];
    (facts[2] as { evidence: { excerpt: string }[] }).evidence = [{ excerpt: "held steady" }];
    const l = ledger(facts);
    const d = evaluateGateB(l, script, true);
    assert.equal(d.approved, true, JSON.stringify(d));
  });
  test("refuses when validator fails", () => {
    const l = ledger([fact("F1", "verified", "number")]);
    assert.equal(evaluateGateB(l, script, false).approved, false);
  });
});
