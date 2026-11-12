import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { extractClaimsFromEvidence, splitSentences, isBoilerplate, hasActionVerb, classifySentence } from "../src/channels/news/claims.js";
import type { EvidenceRecord } from "../src/channels/news/types.js";
import { loadRegistry } from "../src/channels/news/sources.js";

const registry = loadRegistry(process.cwd() + "/config/news-sources.json");
const pibPolicy = registry.policies.find(p => p.sourceId === "pib.gov.in")!;
const bbcPolicy = registry.policies.find(p => p.sourceId === "bbc.co.uk")!;

const makeRecord = (policy: typeof pibPolicy, excerpt: string, sourceId?: string): EvidenceRecord => ({
  sourceId: sourceId ?? policy.sourceId,
  url: `https://${policy.domain}/article`,
  publisher: policy.parentPublisherGroup,
  parentPublisherGroup: policy.parentPublisherGroup,
  wireOrigin: policy.wireOrigin,
  sourceRole: policy.sourceRole,
  policy,
  independenceStatus: "independent",
  locator: "auto:top-paragraphs",
  excerpt,
  supports: "supports",
  fetchedAt: "2026-11-11T00:00:00Z",
});

const ET_TEXT =
  "New Delhi: India and the US are continuing negotiations on the first tranche of their proposed bilateral trade agreement, with a US team visiting New Delhi earlier this month for technical discussions on customs and trade facilitation, a government official said on Tuesday. " +
  "On November 2-3, a two-member track team on customs and trade facilitation was in New Delhi to take forward the technical part of the negotiations, the official said. " +
  "The official said technical discussions on the proposed pact were expected to continue despite President Donald Trump's Republican Party losing majority in both the Senate and the House of Representatives in the US midterm elections. " +
  "The results, as per another official, will not have an impact on trade pact talks. " +
  "Washington has since levied an additional 10% duty on Indian goods under Section 301 probe on alleged forced labour concerns. " +
  "Claims of a cover-up were made by the opposition, though the ministry denied any wrongdoing.";

const BBC_META =
  "Elon Musk says it was to make room for production of its Cybercabs – autonomous taxis without a driver.";

describe("deterministic claim extraction", () => {
  test("splits sentences sanely around abbreviations and quotes", () => {
    const sentences = splitSentences("The U.S. Supreme Court ruled on Tuesday. 'We are working,' he said. Markets jumped 3.5%.");
    assert.equal(sentences.length, 3);
    assert.ok(sentences[0].includes("Supreme Court"));
  });

  test("boilerplate is rejected", () => {
    assert.ok(isBoilerplate("Also read: Union Budget 2026 highlights"));
    assert.ok(isBoilerplate("Click here to subscribe to our newsletter"));
    assert.ok(!isBoilerplate("The government approved Rs 76,000 crore for semiconductor scheme"));
  });

  test("action-verb gate keeps substantive news and drops filler", () => {
    assert.ok(hasActionVerb("The government approved the bill on Tuesday"));
    assert.ok(!hasActionVerb("The capital city is New Delhi"));
  });

  test("extracts the substantive claims from an ET-like article without AI", () => {
    const claims = extractClaimsFromEvidence([makeRecord(pibPolicy, ET_TEXT)]);
    assert.ok(claims.length >= 3 && claims.length <= 12, `expected 3-12 claims, got ${claims.length}`);
    const joined = claims.map(c => c.claim).join(" | ").toLowerCase();
    assert.ok(joined.includes("trade facilitation") || joined.includes("trade agreement"));
    assert.ok(joined.includes("duty") || joined.includes("section 301") || joined.includes("10%"));
    // no claim should be about the website/outlet itself
    assert.ok(!claims.some(c => /epaper|website|http|categorized under|The article is|URL of the|news portal|English Edition|publisher/i.test(c.claim)));
  });

  test("company-keeps-a-quote classification works for attributed claims", () => {
    const result = classifySentence('Elon Musk said it was to make room for production of its Cybercabs.');
    assert.equal(result.kind, "event");
    assert.ok(result.attribution !== null);
  });

  test("allegation sentences keep allegation grammar", () => {
    const result = classifySentence("Claims of a cover-up were made by the opposition, though the ministry denied any wrongdoing.");
    assert.equal(result.kind, "claim_by_actor");
    assert.ok(result.attribution !== null);
  });

  test("quote sentences are tagged as quotes with the verbatim text", () => {
    const result = classifySentence('According to the order, "the Act is struck down forthwith" was the judge wrote.');
    assert.equal(result.kind, "quote");
    assert.ok(result.quote?.includes("the Act is struck down forthwith"));
  });

  test("metadata-only extracts a small number of attributed claims", () => {
    const claims = extractClaimsFromEvidence([makeRecord(bbcPolicy, BBC_META)]);
    assert.ok(claims.length >= 1 && claims.length <= 4, `expected 1-4 metadata claims, got ${claims.length}`);
    assert.ok(claims.every(c => c.attribution !== null), "metadata-only claims must all carry an attribution");
  });

  test("a boilerplate-only excerpt yields zero claims", () => {
    const claims = extractClaimsFromEvidence([makeRecord(pibPolicy, "Also read: latest headlines. Subscribe now. Click here for more. Market snapshot: Nifty up 1%.")]);
    assert.equal(claims.length, 0);
  });

  test("near-duplicate claims collapse across the same record", () => {
    const et2 = ET_TEXT + " New Delhi: India and the US are continuing negotiations on the first tranche of their proposed bilateral trade agreement.";
    const claims = extractClaimsFromEvidence([makeRecord(pibPolicy, et2)]);
    const exact = claims.filter(c => c.claim.startsWith("New Delhi: India and the US"));
    assert.equal(exact.length, 1);
  });
});
