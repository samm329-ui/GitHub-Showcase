import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { validateNewsScript, normalizeEpisodeScript } from "../src/channels/news/script.js";
import type { EvidenceLedger, FactRecord, EpisodeScript } from "../src/channels/news/types.js";

const fact = (id: string, claim: string, excerpt: string): FactRecord => ({
  id,
  claim,
  kind: "event",
  status: "verified",
  importance: "core",
  contentClass: "fact",
  evidence: [{
    sourceId: "pib.gov.in",
    url: "https://pib.gov.in/release",
    publisher: "Government of India",
    parentPublisherGroup: "Government of India",
    sourceRole: "primary",
    policy: {
      sourceId: "pib.gov.in", domain: "pib.gov.in", documentTypes: ["press_release"],
      discoveryAllowed: true, metadataAllowed: true, fullTextFetchAllowed: true,
      llmProcessingAllowed: true, quotationAllowed: true, permissionBasis: "terms_reviewed",
      enabled: true, sourceRole: "primary", parentPublisherGroup: "Government of India",
    },
    independenceStatus: "independent",
    locator: "para-1",
    excerpt,
    supports: "supports",
    fetchedAt: "2026-11-10T09:00:00Z",
  }],
  independenceCount: 1,
  confidence: 0.9,
  verifiedByHuman: false,
});

const ledger: EvidenceLedger = {
  storyId: "story_test",
  capturedAt: "2026-11-10T09:00:00Z",
  facts: [
    fact("F001", "The government approved a semiconductor scheme with an outlay of Rs 76,000 crore on 3 November 2026.", "The Government approved Rs 76,000 crore for the semiconductor scheme on 3 November 2026."),
    fact("F002", "Information Technology Minister Ashwini Vaishnaw said the scheme will support fabs in Gujarat and Tamil Nadu.", "Ashwini Vaishnaw said the scheme supports fabs in Gujarat and Tamil Nadu."),
  ],
  verifierPassed: true,
  verifierErrors: [],
  verifierWarnings: [],
  independenceCount: 1,
};

const goodScript: EpisodeScript = {
  storyId: "story_test",
  workingTitle: "Centre clears Rs 76,000 crore chip push",
  language: "en",
  tone: "dry_sarcastic",
  estimatedDurationSeconds: 62,
  narration: [
    { id: "N001", text: "The government has approved a semiconductor scheme worth Rs 76,000 crore.", factIds: ["F001"], delivery: "dry_hook", sceneMode: "opening", contentClass: "fact" },
    { id: "N002", text: "Information Technology Minister Ashwini Vaishnaw said the scheme supports fabs in Gujarat and Tamil Nadu.", factIds: ["F002"], delivery: "firm_attribution", sceneMode: "narration_focus", contentClass: "fact" },
    { id: "N003", text: "Apparently semiconductors were discovered by a press release.", factIds: ["F001"], delivery: "dry_observation", sceneMode: "narration_focus", contentClass: "satire" },
    { id: "N004", text: "Whether the scheme actually materializes is the usual open question.", factIds: ["F001"], delivery: "punchline", sceneMode: "closing", contentClass: "satire" },
  ],
  callouts: [
    { id: "C001", text: "76,000 CRORE, ON PAPER", factIds: ["F001"], highlightWords: ["76,000 CRORE"], triggerNarrationId: "N001", priority: "high", reveal: "marker_reveal" },
  ],
  sources: ["S001"],
  editorialNotes: [],
  gateBApproval: null,
};

describe("news script validator — structural gate", () => {
  test("valid script passes", () => {
    const result = validateNewsScript(goodScript, ledger, 90);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.ok(result.words > 20);
  });

  test("number absent from ledger fails", () => {
    const bad = { ...goodScript, narration: [{ ...goodScript.narration[0], text: "The government approved a scheme of Rs 99,000 crore on 3 November 2026." }] };
    const result = validateNewsScript(bad, ledger, 90);
    assert.ok(result.errors.some(e => e.includes("99000")));
  });

  test("entity absent from ledger fails", () => {
    const bad = { ...goodScript, narration: [{ ...goodScript.narration[1], text: "Elon Musk said the scheme supports stakes in Karnataka." }] };
    const result = validateNewsScript(bad, ledger, 90);
    assert.ok(result.errors.some(e => e.includes("Elon Musk")));
  });

  test("allegation must not become conviction", () => {
    const bad = { ...goodScript, narration: [{ ...goodScript.narration[0], text: "The FIR alleges the minister was convicted of fraud on 3 November 2026.", contentClass: "fact" as const, factIds: ["F001"] }] };
    const result = validateNewsScript(bad, ledger, 90);
    assert.ok(result.errors.length > 0, JSON.stringify(result.errors));
  });

  test("proposed becoming approved triggers the legal-status rule", () => {
    const bad = {
      ...goodScript,
      narration: [{ ...goodScript.narration[0], text: "The proposed semiconductor scheme was approved on 3 November 2026.", contentClass: "fact" as const, factIds: ["F001"] }],
    };
    const result = validateNewsScript(bad, ledger, 90);
    assert.ok(result.errors.some(e => e.includes("proposed->passed")));
  });

  test("victims are never the punchline target", () => {
    const bad = {
      ...goodScript,
      narration: [{ ...goodScript.narration[3], text: "Children in the affected villages will simply have to wait longer.", delivery: "punchline" as const }],
    };
    const result = validateNewsScript(bad, ledger, 90);
    assert.ok(result.errors.some(e => e.includes("protected group")));
  });

  test("factIds outside the ledger fail", () => {
    const bad = { ...goodScript, narration: [{ ...goodScript.narration[0], factIds: ["F999"] }] };
    const result = validateNewsScript(bad, ledger, 90);
    assert.ok(result.errors.some(e => e.includes("unknown factId")));
  });

  test("normalization fills missing ids and defaults", () => {
    const raw = { narration: [{ text: "Rs 76,000 crore approved." }] };
    const plan = normalizeEpisodeScript(raw, "story_test");
    assert.equal(plan.narration.length, 1);
    assert.equal(plan.narration[0].id, "N001");
    assert.equal(plan.tone, "dry_sarcastic");
  });
});
