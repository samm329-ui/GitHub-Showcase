import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  parseInshortsState,
  fetchInshortsCategory,
  cardsToItems,
  buildInshortsEvidence,
  discoverInshorts,
  INSHORTS_CATEGORIES,
  InshortsError,
} from "../src/channels/news/inshorts.js";
import { newsLane } from "../src/channels/news/discovery.js";
import { loadRegistry } from "../src/channels/news/sources.js";
import { evaluateGateA, evaluateGateB } from "../src/channels/news/auto-gates.js";
import { verifyClaim, verifyLedger } from "../src/channels/news/ledger.js";
import { extractClaimsFromEvidence } from "../src/channels/news/claims.js";
import { buildScriptUserPrompt } from "../src/channels/news/script.js";
import type { DiscoveredItem, EvidenceRecord, EvidenceLedger } from "../src/channels/news/types.js";
import type { ProposedClaim } from "../src/channels/news/ledger.js";

/* ------------------------------------------------------------------ */
/* Fixture: a page skeleton carrying window.__STATE__                  */
/* ------------------------------------------------------------------ */

const STATE = {
  news_list: {
    list: [
      {
        news_type: "NEWS",
        news_obj: {
          old_hash_id: "modi-rbi-review-1794501084966",
          hash_id: "abc-1",
          author_name: "Bhuvnesh Ojha",
          content: "RBI held the repo rate steady at 5 percent on October 8, 2026, citing easing food inflation. The committee's resolution passed unanimously, flagging the rupee and global uncertainty.",
          source_name: "The Hindu",
          source_url: "https://www.thehindu.com/business/rbi-rate-oct26.html",
          title: "RBI holds repo rate at 5 percent in October review",
          image_url: "https://media.inshorts.com/inshorts/images/m/img.jpg",
          created_at: 1794501084000,
          category_names: ["politics", "national"],
          bottom_headline: "The market took it in stride",
          impressive_score: 12.5,
        },
      },
      {
        news_type: "NEWS",
        news_obj: {
          old_hash_id: "owaisi-bjp-1794494854516",
          hash_id: "abc-2",
          author_name: "Staff",
          content: "Asaduddin Owaisi said the alliance's participation would not change the election's outcome. He also reiterated his party's position on the Karnataka seat-sharing talks.",
          source_name: "The Hindu",
          source_url: "https://www.thehindu.com/news/national/owaisi-1794494854516.html",
          title: "Owaisi on alliance math in Karnataka",
          created_at: 1794494854516,
          category_names: ["politics"],
        },
      },
      {
        news_type: "ADVERTISEMENT",
        news_obj: { old_hash_id: "should-be-skipped", title: "ad", content: "ads ads ads ads ads ads ads ads ads ads ads ads ads.", created_at: 1794494854516 },
      },
    ],
  },
};

const htmlOf = (state: unknown): string =>
  `<!doctype html><html><head></head><body><script>window.__STATE__ = ${JSON.stringify(state)}</script></body></html>`;

const registry = loadRegistry();

/* ------------------------------------------------------------------ */
/* Parsing â€” hydration blob, not regex on article tags                  */
/* ------------------------------------------------------------------ */

describe("inshorts page parsing", () => {
  test("extracts cards from the hydration blob, skipping non-NEWS entries", () => {
    const cards = parseInshortsState(htmlOf(STATE));
    assert.equal(cards.length, 2);
    const first = cards[0];
    assert.equal(first.title, "RBI holds repo rate at 5 percent in October review");
    assert.equal(first.sourceName, "The Hindu");
    assert.match(first.sourceUrl ?? "", /thehindu\.com/);
    assert.match(first.content, /repo rate/);
    assert.match(first.url, /^https:\/\/www\.inshorts\.com\/en\/news\//);
    assert.ok(first.publishedAt?.startsWith("2026"));
  });

  test("returns empty array for a hard-stop challenge page", () => {
    const challenge = "<html><body><h1>Just a moment...</h1><script>window.__STATE__ = {\"news_list\":{\"list\":[]}}</script></body></html>";
    assert.equal(parseInshortsState(challenge).length, 0);
  });

  test("returns empty array for a malformed blob", () => {
    assert.equal(parseInshortsState("<script>window.__STATE__ = not-json;;</script>").length, 0);
    assert.equal(parseInshortsState("<html>no blob</html>").length, 0);
  });
});

describe("inshorts fetch â€” fail closed", () => {
  test("non-200 status throws InshortsError", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(() => fetchInshortsCategory("politics", { fetchImpl }), InshortsError);
  });
  test("challenge page throws InshortsError, never parsed", async () => {
    const fetchImpl = (async () => new Response("<html><body>Just a moment... cf-chl</body></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await assert.rejects(() => fetchInshortsCategory("politics", { fetchImpl }), /hard stop/);
  });
  test("happy path returns cards from an injected fetch", async () => {
    const fetchImpl = (async () => new Response(htmlOf(STATE), { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const cards = await fetchInshortsCategory("politics", { fetchImpl });
    assert.equal(cards.length, 2);
  });
});

describe("inshorts lane plumbing", () => {
  test("cards map onto registered DiscoveredItems with attribution fields", () => {
    const cards = parseInshortsState(htmlOf(STATE));
    const items = cardsToItems(cards, registry);
    assert.equal(items.length, 2);
    assert.equal(items[0].sourceId, "inshorts.com");
    assert.match(items[0].description ?? "", /repo rate/);
    assert.match(items[0].matchedQuery ?? "", /^inshorts:/);
  });

  test("buildInshortsEvidence carries the summary as the excerpt, attributed single origin", () => {
    const cards = parseInshortsState(htmlOf(STATE));
    const items = cardsToItems(cards, registry);
    const records = buildInshortsEvidence(items);
    assert.equal(records.length, 2);
    assert.equal(records[0].locator?.startsWith("inshorts:card60w"), true);
    assert.match(records[0].excerpt ?? "", /repo rate/);
    assert.equal(records[0].parentPublisherGroup, "Inshorts");
  });

  test("discoverInshorts runs end-to-end with injected fetch", async () => {
    const fetchImpl = (async () => new Response(htmlOf(STATE), { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const items = await discoverInshorts("politics", registry, { fetchImpl });
    assert.equal(items.length, 2);
    assert.equal(newsLane({} as NodeJS.ProcessEnv), "inshorts");
    assert.equal(newsLane({ NEWS_SOURCE: "fortress" } as NodeJS.ProcessEnv), "fortress");
    assert.ok(Object.keys(INSHORTS_CATEGORIES).includes("politics"));
  });
});

/* ------------------------------------------------------------------ */
/* Gates â€” aggregated provenance passes with attribution, never else  */
/* ------------------------------------------------------------------ */

const aggregatedLedger = (): { ledger: EvidenceLedger; records: EvidenceRecord[] } => {
  const item: DiscoveredItem = {
    id: "i1",
    title: "RBI holds repo rate at 5 percent in October review",
    url: "https://www.inshorts.com/en/news/modi-rbi-review-1794501084966",
    sourceId: "inshorts.com",
    sourceName: "inshorts.com",
    sourcePolicy: registry.policies.find(p => p.sourceId === "inshorts.com")!,
    publishedAt: null,
    eventDate: null,
    description: "RBI held the repo rate steady at 5 percent on October 8, 2026, citing easing food inflation. The committee's resolution passed unanimously.",
    fetchedAt: "2026-11-13T00:00:00.000Z",
    fingerprint: "fp_test_1",
    matchedQuery: "inshorts:politics",
  };
  const records = buildInshortsEvidence([item]);
  const proposed: ProposedClaim[] = [
    { claim: "RBI held the repo rate at 5 percent on October 8, 2026.", kind: "number", importance: "core", contentClass: "fact", attribution: "Inshorts reports", quotes: [] },
    { claim: "The committee's resolution passed unanimously.", kind: "event", importance: "supporting", contentClass: "fact", attribution: "Inshorts reports", quotes: [] },
  ];
  const facts = proposed.map((c, i) => verifyClaim(c, records, i));
  const ledger = verifyLedger(facts, "story_test");
  return { ledger, records };
};

describe("gates for the Inshorts lane", () => {
  test("Gate A approves an aggregated single-origin story ONLY with a verified hard fact and honest label", () => {
    const { ledger, records } = aggregatedLedger();
    const decision = evaluateGateA(ledger, records);
    assert.equal(decision.approved, true, decision.approved ? "" : decision.reason);
    if (decision.approved) assert.match(decision.note, /aggregated:Inshorts/);
  });

  test("Gate A refuses aggregated stories whose hard facts cannot be verified", () => {
    const { ledger, records } = aggregatedLedger();
    const weak = { ...ledger, facts: ledger.facts.map(f => ({ ...f, status: "attributed" as const })) };
    const decision = evaluateGateA(weak, records);
    assert.equal(decision.approved, false);
  });

  test("Gate B refuses scripts that never attribute Inshorts", () => {
    const { ledger } = aggregatedLedger();
    const script = {
      narration: [
        { id: "N001", text: "So the RBI held rates steady. Again. Predictable.", factIds: ledger.facts.map(f => f.id) },
        { id: "N002", text: "The committee was unanimous about it.", factIds: ledger.facts.map(f => f.id) },
        { id: "N003", text: "Meanwhile somewhere, a fiscal thinker takes notes.", factIds: ledger.facts.map(f => f.id) },
      ],
    };
    const decision = evaluateGateB(ledger, script, true);
    assert.equal(decision.approved, false);
    if (!decision.approved) assert.match(decision.reason, /attribution/i);
  });

  test("Gate B passes an attributed script with verbatim quotes", () => {
    const { ledger } = aggregatedLedger();
    const script = {
      narration: [
        { id: "N001", text: "According to Inshorts, the RBI held the repo rate at 5 percent on October 8, 2026.", factIds: ledger.facts.map(f => f.id) },
        { id: "N002", text: "Inshorts reports the resolution passed unanimously. Wild.", factIds: ledger.facts.map(f => f.id) },
        { id: "N003", text: "So the machine stays patiently in motion.", factIds: ledger.facts.map(f => f.id) },
      ],
    };
    const decision = evaluateGateB(ledger, script, true);
    assert.equal(decision.approved, true, decision.approved ? "" : decision.reason);
  });
});

describe("script prompt carries the attribution mandate", () => {
  test("aggregated ledger injects the attribution requirement into Groq's prompt", () => {
    const { ledger } = aggregatedLedger();
    const prompt = buildScriptUserPrompt(ledger, "RBI holds repo rate");
    assert.match(prompt, /ATTRIBUTION REQUIRED/);
    assert.match(prompt, /[Aa]ccording to Inshorts/);
  });
});

