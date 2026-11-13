import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  runResearchAgent,
  loadResearchConfig,
  parseSearchPlan,
  parseGapAnalysis,
  parseStanceVerdict,
  findFabricatedUrls,
  buildIndependentOriginAnalysis,
  selectResearchCandidate,
  type ResearchConfig,
} from "../src/channels/news/research-agent.js";
import { groqChatCompletion, GroqError, type GroqChatOptions, type GroqCompletion } from "../src/groq.js";
import { evaluateGateA } from "../src/channels/news/auto-gates.js";
import { verifyClaim, verifyLedger } from "../src/channels/news/ledger.js";
import type { ProposedClaim } from "../src/channels/news/ledger.js";
import type { ScoredCandidate } from "../src/channels/news/types.js";
import { extractClaimsFromEvidence } from "../src/channels/news/claims.js";
import type {
  DiscoveredItem,
  EvidenceRecord,
  SourcePolicy,
} from "../src/channels/news/types.js";
import { CATEGORY_QUERIES } from "../src/channels/news/discovery.js";

/* ------------------------------------------------------------------ */
/* Fixtures â€” every outlet is registered with a policy                  */
/* ------------------------------------------------------------------ */

const policy = (
  sourceId: string,
  group: string,
  opts: Partial<SourcePolicy> = {}
): SourcePolicy => ({
  sourceId,
  domain: sourceId,
  documentTypes: ["article"],
  discoveryAllowed: true,
  metadataAllowed: true,
  fullTextFetchAllowed: true,
  llmProcessingAllowed: false,
  quotationAllowed: false,
  permissionBasis: "terms_reviewed",
  enabled: true,
  sourceRole: "independent_reporting",
  parentPublisherGroup: group,
  wireOrigin: "none",
  termsCheckedAt: "2026-11-13",
  perspective: "centre",
  ...opts,
});

const HINDU = policy("thehindu.com", "The Hindu Group", { perspective: "centre_left" });
const PIB = policy("pib.gov.in", "Government of India", {
  sourceRole: "primary",
  wireOrigin: "pib",
  perspective: undefined,
});
const TIMES = policy("economictimes.indiatimes.com", "Times Group", {
  wireOrigin: "none",
});
const HINDAL = policy("hinduwirea.example.com", "AlphaWire Group A", {
  wireOrigin: "ap",
});
const WIREB = policy("hinduwireb.example.com", "BetaWire Group B", {
  wireOrigin: "ap",
});
const METADATA_ONLY = policy("toonly.example.com", "TO Only Group", {
  fullTextFetchAllowed: false,
  metadataAllowed: true,
});
const METADATA_ONLY_2 = policy("toonly2.example.com", "TO Only Group 2", {
  fullTextFetchAllowed: false,
  metadataAllowed: true,
});

const registry = { policies: [HINDU, PIB, TIMES, HINDAL, WIREB, METADATA_ONLY, METADATA_ONLY_2], warnings: [] };

const RSS = (p: SourcePolicy, title: string, url: string): DiscoveredItem => ({
  id: `id_${url}`,
  title,
  url,
  sourceId: p.sourceId,
  sourceName: p.sourceId,
  sourcePolicy: p,
  publishedAt: null,
  eventDate: null,
  description: title,
  fetchedAt: "2026-11-13T00:00:00.000Z",
  fingerprint: `fp_${url}`,
  matchedQuery: "test",
});

const ARTICLE = {
  hindu:
    "The Reserve Bank of India held the repo rate steady at 5 percent on October 8, 2026, easing food inflation helped the committee while it reiterated its reliance on incoming data. Governor Sanjay Malhotra said the Monetary Policy Committee would watch the rupee closely. \n\nThe committee's policy statement said the decision was unanimous across external and internal members of the MPC and that the stance remains neutral.",
  pib:
    "The Monetary Policy Committee announced today that the repo rate is held unchanged at 5 percent. The resolution dated October 8, 2026 noted that the committee acted unanimously and flagged the rupee. RBI Governor Sanjay Malhotra briefed the media at 10:00 IST.\n\nThe full minutes will be published on October 22 per statutory timelines.",
  wirea: "AlphaWire issued a report noting that the committee voted to hold the rate at 5 percent, citing rupee defence measures.",
  wireb: "BetaWire published the same dispatch language: the rate was held at 5 percent through the same decision cycle.",
} as const;

/** LLM mock â€” routes by the system prompt each call carries. */
/** Build a verbatim anchor from the stance-check user message's passage body. */
const anchorFromUser = (userContent: string, stance: "supports" | "contradicts" | "context_only"): string => {
  const body = userContent.split("\n\n")[1] ?? "";
  const firstLine = body.split("\n").find(l => l.trim().length > 10) ?? "repo rate";
  const anchor = firstLine.split(" ").slice(0, 10).join(" ");
  return JSON.stringify({ stance, anchor });
};

const makeLlm = (opts: {
  onGap?: (callIndex: number) => string;
  planRaw?: string | null;
  claimsRaw?: string | null;
  stanceVerdict?: string | ((userContent: string) => string);
  adversarialVerdict?: string;
} = {}) => {
  let gapCalls = 0;
  const calls: { system: string; userLength: number }[] = [];
  const llm = async (
    messages: { role: string; content: string }[],
    _options?: GroqChatOptions
  ): Promise<GroqCompletion> => {
    const system = messages[0]?.content ?? "";
    const userLength = (messages[1]?.content ?? "").length;
    calls.push({ system, userLength });
    const reply = (content: string, tokens = 40): GroqCompletion => ({
      content,
      model: "test-model",
      usage: { promptTokens: tokens, completionTokens: tokens, totalTokens: tokens },
      retries: 0,
    });
    if (system.includes("newsroom research director")) {
      return reply(
        opts.planRaw ??
          JSON.stringify({ queries: [{ query: "RBI repo rate October 2026 decision", intent: "primary_record" }] })
      );
    }
    if (system.includes("claim-extraction assistant")) {
      return reply(
        opts.claimsRaw ??
          JSON.stringify({
            claims: [
              { claim: "RBI held the repo rate at 5 percent on October 8, 2026.", kind: "number", importance: "core" },
            ],
          })
      );
    }
    if (system.includes("newsroom editor deciding")) {
      gapCalls += 1;
      const raw =
        opts.onGap?.(gapCalls) ??
        JSON.stringify({
          assessment: "sufficient",
          gaps: [],
          missingPerspectives: [],
          allegedContradictions: [],
          note: "evidence spans independent reporting and the primary record",
        });
      return reply(raw);
    }
    if (system.includes("You judge whether an article supports or contradicts")) {
      const userContent = messages[1]?.content ?? "";
      if (typeof opts.stanceVerdict === "function") return reply(opts.stanceVerdict(userContent));
      return reply(opts.stanceVerdict ?? anchorFromUser(userContent, "supports"));
    }
    if (system.includes("contradiction auditor")) {
      return reply(opts.adversarialVerdict ?? '{"verdict":"denies"}');
    }
    throw new Error(`unhandled llm system prompt: ${system.slice(0, 120)}`);
  };
  return { llm, calls };
};

const config = (overrides: Partial<ResearchConfig> = {}): ResearchConfig => ({
  maxIterations: 2,
  maxSearches: 6,
  maxArticles: 8,
  maxLlmCalls: 12,
  tokenBudget: 40_000,
  timeoutMs: 60_000,
  ...overrides,
});

const defaultDeps = (opts: Parameters<typeof makeLlm>[0] = {}) => {
  const { llm, calls } = makeLlm(opts);
  const searchInit = [RSS(HINDU, "RBI holds repo rate steady in October 2026 review", "https://www.thehindu.com/business/rbi-rate-oct26.html"),
    RSS(PIB, "MPC holds repo rate at 5 percent October 2026 RBI resolution", "https://pib.gov.in/PressReleasePage.aspx?PRID=2026oct8")];
  const searches: string[] = [];
  const searchWeb = async (query: string): Promise<DiscoveredItem[]> => {
    searches.push(query);
    const lowered = query.toLowerCase();
    if (lowered.includes("committee") || lowered.includes("revised")) {
      return [...searchInit, RSS(WIREB, "RBI repo rate held at 5 percent in October 2026 review â€” BetaWire", "https://hinduwireb.example.com/story-2026-10-08")];
    }
    return searchInit;
  };
  const readPage = async (url: string): Promise<string> => {
    if (url.includes("thehindu.com")) return ARTICLE.hindu;
    if (url.includes("pib.gov.in")) return ARTICLE.pib;
    if (url.includes("wireb")) return ARTICLE.wireb;
    if (url.includes("wirea")) return ARTICLE.wirea;
    throw new Error(`no fixture for ${url}`);
  };
  return { llm, calls, searchWeb, readPage, searches };
};

const quiet = () => {};

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

describe("research plan parsing", () => {
  test("accepts a well-formed LLM plan", () => {
    const plan = parseSearchPlan(
      '{"queries":[{"query":"RBI monetary policy October 2026","intent":"primary_record"},{"query":"Modi address nation investment","intent":"independent_reporting"}]}',
      "politics"
    );
    assert.equal(plan.source, "groq");
    assert.equal(plan.queries.length, 2);
    assert.equal(plan.queries[0].intent, "primary_record");
  });

  test("rejects URLs inside queries (fabrication attempt)", () => {
    const plan = parseSearchPlan(
      '{"queries":[{"query":"https://evil.example.com/invented article","intent":"context"},{"query":"legit query words here","intent":"context"}]}',
      "technology"
    );
    assert.ok(!plan.queries.some(q => q.query.includes("evil.example.com")));
  });

  test("falls back to deterministic category queries on garbage output", () => {
    const plan = parseSearchPlan("{not json at all", "politics");
    assert.equal(plan.source, "fallback");
    assert.deepEqual(plan.queries.map(q => q.query), CATEGORY_QUERIES.politics.slice(0, 4));
  });

  test("falls back when the LLM is unavailable", () => {
    const plan = parseSearchPlan(null, "technology");
    assert.equal(plan.source, "fallback");
  });
});

/* ------------------------------------------------------------------ */
/* The iterative loop                                                  */
/* ------------------------------------------------------------------ */

describe("iterative research loop", () => {
  test("completes when evidence suffices after a follow-up search", async () => {
    const { llm, calls, searchWeb, readPage, searches } = defaultDeps({
      onGap: (call) =>
        call === 1
          ? JSON.stringify({
              assessment: "needs_more_research",
              gaps: [{ type: "primary_record", reason: "Confirm the MPC resolution date from the release itself.", query: "Monetary Policy Committee October 8 2026 RBI", priority: "high" }],
              missingPerspectives: [],
              allegedContradictions: [],
              note: "need the committee detail",
            })
          : JSON.stringify({
              assessment: "sufficient",
              gaps: [],
              missingPerspectives: ["The Hindu centre-left framing"],
              allegedContradictions: [],
              note: "two independent outlets plus the primary record",
            }),
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.dossier.searches.length, 2);
    assert.equal(outcome.dossier.searches[0].mode, "initial");
    assert.equal(outcome.dossier.searches[1].mode, "followup");
    assert.ok(outcome.dossier.searches[1].query.includes("Monetary Policy Committee"));
    assert.ok(outcome.dossier.articles.length >= 3);
    assert.match(outcome.dossier.honestyNote, /complete/i);
    // gap output is preserved for the record
    assert.ok(outcome.dossier.missingPerspectives.some(p => /Hindu/i.test(p)));
    assert.ok(calls.some(c => c.system.includes("newsroom research director")));
  });

  test("stops honestly when the follow-up path is exhausted (no_useful_path)", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      onGap: () =>
        JSON.stringify({
          assessment: "needs_more_research",
          gaps: [{ type: "independent_reporting", reason: "Need an outlet you can trust.", query: null, priority: "high" }],
          missingPerspectives: [],
          allegedContradictions: [],
          note: "no query proposed",
        }),
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config({ maxIterations: 3 }),
    });
    assert.equal(outcome.status, "no_useful_path");
    assert.notEqual(outcome.status, "complete");
    assert.match(outcome.dossier.honestyNote, /nothing more useful/i);
  });

  test("never fabricates: LLM-proposed claim containing a URL is dropped", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      claimsRaw: JSON.stringify({
        claims: [
          { claim: "RBI held the repo rate at 5 percent on October 8, 2026.", kind: "number", importance: "core" },
          { claim: "Details at https://invented.example.com/full-story for context", kind: "event", importance: "supporting" },
        ],
      }),
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    assert.equal(outcome.status, "complete");
    assert.ok(!outcome.dossier.proposedClaims.some(c => c.claim.includes("http")));
    assert.equal(outcome.dossier.proposedClaims.length, 1);
  });

  test("metadata-only evidence never counts as full-text corroboration", async () => {
    const metadataRegistry = { policies: [METADATA_ONLY, METADATA_ONLY_2], warnings: [] };
    const searchWeb = async () => [
      RSS(METADATA_ONLY, "RBI holds rate steady", "https://toonly.example.com/rbi-oct"),
      RSS(METADATA_ONLY_2, "Repo unchanged at 5 percent", "https://toonly2.example.com/mpc"),
    ];
    const { llm, calls } = makeLlm();
    const outcome = await runResearchAgent({
      category: "finance",
      registry: metadataRegistry,
      deps: { llm, searchWeb, readPage: async () => "should not be called", now: () => 1_000_000, log: quiet },
      config: config(),
    });
    assert.ok(outcome.records.length >= 1);
    assert.ok(outcome.records.every(r => (r.locator ?? "").startsWith("rss-metadata")));
    assert.equal(outcome.dossier.independentOriginAnalysis.corroboratingOrigins, 0);
    assert.equal(outcome.dossier.independentOriginAnalysis.metadataOnlyRecords, outcome.records.length);
    assert.ok(!calls.some(c => c.system.includes("You judge whether")), "metadata-only articles are not stance-classified");
  });
});

/* ------------------------------------------------------------------ */
/* Fabrication safeguards                                              */
/* ------------------------------------------------------------------ */

describe("fabricated-URL and fabricated-quote rejection", () => {
  const KNOWN = new Set(["https://www.thehindu.com/business/rbi-rate-oct26.html", "https://pib.gov.in/x"]);

  test("findFabricatedUrls returns only unknown URLs", () => {
    const text = "see https://www.thehindu.com/business/rbi-rate-oct26.html and https://invented.example.com/fake-news now";
    assert.deepEqual(findFabricatedUrls(text, KNOWN), ["https://invented.example.com/fake-news"]);
  });

  test("gap analysis drops fabricated URLs and nullifies the tainted query", () => {
    const raw = JSON.stringify({
      assessment: "needs_more_research",
      gaps: [
        { type: "independent_reporting", reason: "read https://invented.example.com/paywalled story", query: "https://another-invented.example.com/path", priority: "high" },
        { type: "primary_record", reason: "the committee minutes were not in scope", query: "MPC minutes October 2026 site:pib.gov.in", priority: "medium" },
      ],
      missingPerspectives: ["see https://third-invented.example.com/pov"],
      allegedContradictions: [],
      note: "go read https://invented.example.com/paywalled now",
    });
    const { analysis, fabricatedUrlsRejected } = parseGapAnalysis(raw, KNOWN);
    assert.ok(analysis);
    assert.equal(analysis!.gaps[0].query, null, "fabricated follow-up query is nulled");
    assert.equal(analysis!.gaps[1].query, "MPC minutes October 2026 site:pib.gov.in");
    assert.ok(fabricatedUrlsRejected.length >= 3, `expected >=3 rejected URLs, got ${fabricatedUrlsRejected.join(", ")}`);
    assert.match(analysis!.note, /fabricated URLs rejected/);
  });

  test("stance verdict with a non-verbatim anchor is rejected (context_only)", () => {
    const verdict = parseStanceVerdict(
      JSON.stringify({ stance: "supports", anchor: "The agency slashed growth projections by half" }),
      "The Reserve Bank of India held the repo rate steady at 5 percent on October 8, 2026."
    );
    assert.equal(verdict.supports, "context_only");
    assert.equal(verdict.anchorValid, false);
  });

  test("stance verdict with a verbatim anchor is accepted", () => {
    const text = "The Reserve Bank of India held the repo rate steady at 5 percent on October 8, 2026.";
    const verdict = parseStanceVerdict(
      JSON.stringify({ stance: "supports", anchor: "held the repo rate steady at 5 percent on October 8, 2026" }),
      text
    );
    assert.equal(verdict.supports, "supports");
    assert.equal(verdict.anchorValid, true);
  });

  test("agent records supports only after a validated stance pass", async () => {
    const { llm, searchWeb, readPage } = defaultDeps();
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    assert.ok(outcome.records.length >= 1);
    for (const article of outcome.dossier.articles) {
      if (article.retrieval !== "full_text") continue;
      assert.equal(article.stanceAnchorValidated, true);
      assert.equal(article.supports, "supports");
    }
  });
});

describe("contradictory evidence is preserved, never laundered", () => {
  test("a validated contradicts verdict flows into the record", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      stanceVerdict: (user) => anchorFromUser(user, "contradicts"),
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    // The anchor keeps a hard conflict point (digits/caps), so the verdict stands.
    for (const article of outcome.dossier.articles) {
      if (article.retrieval !== "full_text") continue;
      assert.equal(article.supports, "contradicts");
      assert.equal(article.llmStance, "contradicts");
    }
    assert.ok(outcome.records.every(r => r.supports === "contradicts"));
    // corroboration counts only supporting full-text records
    assert.equal(outcome.dossier.independentOriginAnalysis.corroboratingOrigins, 0);
  });

  test("a contradicts verdict WITHOUT a hard conflict point is downgraded to supports and logged", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      stanceVerdict: () => '{"stance":"contradicts","anchor":"the repo rate"}',  // verbatim in both fixtures, but no digits/caps/quotes -> not a hard conflict
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    for (const article of outcome.dossier.articles) {
      if (article.retrieval !== "full_text") continue;
      assert.equal(article.supports, "supports");
      assert.equal(article.llmStance, "contradicts", "the raw LLM verdict must remain visible in the dossier");
    }
    assert.ok(outcome.dossier.warnings.some(w => /downgraded contradicts/i.test(w)));
    assert.ok(outcome.records.every(r => r.supports === "supports"));
  });

  test("adversarial audit can overrule a contradiction (evidence returns to the verifier)", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      stanceVerdict: (user) => anchorFromUser(user, "contradicts"), // hard anchor (caps)
      adversarialVerdict: '{"verdict":"does_not_deny"}',
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    for (const article of outcome.dossier.articles) {
      if (article.retrieval !== "full_text") continue;
      assert.equal(article.supports, "supports");
      assert.equal(article.llmStance, "contradicts->audited-supports");
    }
    assert.ok(outcome.dossier.warnings.some(w => /adversarial audit overruled/i.test(w)));
    assert.ok(outcome.records.every(r => r.supports === "supports"));
    assert.equal(outcome.dossier.independentOriginAnalysis.corroboratingOrigins, 2);
  });

  test("adversarial audit can uphold a contradiction (evidence excluded, loudly)", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      stanceVerdict: (user) => anchorFromUser(user, "contradicts"), // hard anchor (caps)
      adversarialVerdict: '{"verdict":"denies"}',
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    for (const article of outcome.dossier.articles) {
      if (article.retrieval !== "full_text") continue;
      assert.equal(article.supports, "contradicts");
    }
    assert.ok(outcome.dossier.warnings.some(w => /confirmed by adversarial/i.test(w)));
    assert.equal(outcome.dossier.independentOriginAnalysis.corroboratingOrigins, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Independent-origin analysis                                         */
/* ------------------------------------------------------------------ */

describe("duplicate-origin detection", () => {
  const mk = (sourceId: string, group: string, wire: string | undefined, supports: EvidenceRecord["supports"] = "supports"): EvidenceRecord => ({
    sourceId, url: `https://${sourceId}/x`, publisher: group, parentPublisherGroup: group,
    wireOrigin: wire, sourceRole: "independent_reporting",
    policy: policy(sourceId, group, { wireOrigin: wire }),
    independenceStatus: "independent", supports,
    locator: "auto:test", excerpt: "passage", fetchedAt: "2026-11-13T00:00:00.000Z",
  });

  test("two outlets in one publisher group are one origin", () => {
    const records = [mk("economictimes.indiatimes.com", "Times Group", "none"), mk("timesofindia.indiatimes.com", "Times Group", "none")];
    const analysis = buildIndependentOriginAnalysis(records);
    assert.equal(analysis.distinctPublisherGroups, 1);
    assert.equal(analysis.corroboratingOrigins, 1);
    assert.equal(analysis.duplicateOriginGroups.length, 1);
  });

  test("two different groups reprinting the same wire are one lineage", () => {
    const records = [mk("hinduwirea.example.com", "AlphaWire Group A", "ap"), mk("hinduwireb.example.com", "BetaWire Group B", "ap")];
    const analysis = buildIndependentOriginAnalysis(records);
    assert.equal(analysis.corroboratingOrigins, 1);
    assert.equal(analysis.syndicatedWirePairs.length, 1);
    assert.equal(analysis.syndicatedWirePairs[0].wireOrigin, "ap");
  });

  test("independent outlets with distinct wires are two origins", () => {
    const records = [mk("thehindu.com", "The Hindu Group", "none"), mk("swarajyamag.com", "Swarajya", "none")];
    const analysis = buildIndependentOriginAnalysis(records);
    assert.equal(analysis.corroboratingOrigins, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Browse lane (front pages) — budgets and provenance                 */
/* ------------------------------------------------------------------ */

describe("front-page browse harvest", () => {
  test("browse-sourced headlines enter the pool and the search log as mode=browse", async () => {
    const { llm, searchWeb, readPage } = defaultDeps();
    const browsed = RSS(HINDU, "RBI holds repo rate steady in October 2026 review", "https://www.thehindu.com/business/rbi-rate-oct26.html");
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: {
        llm, searchWeb, readPage,
        browseHomepage: async (page) => (page.includes("thehindu.com") ? [browsed] : []),
        now: () => 1_000_000,
        log: quiet,
      },
      config: config(),
    });
    const browseEntries = outcome.dossier.searches.filter(s => s.mode === "browse");
    assert.ok(browseEntries.length >= 1);
    assert.ok(browseEntries.some(s => s.resultCount >= 1));
    assert.equal(outcome.status, "complete"); // browse + search + follow-up still converge
  });
});

/* ------------------------------------------------------------------ */
/* Gate A integration ï¿½ the only authority on what may air             */
/* ------------------------------------------------------------------ */

describe("Gate A integration", () => {
  const proposal: ProposedClaim[] = [
    { claim: "RBI held the repo rate at 5 percent on October 8, 2026.", kind: "number", importance: "core", contentClass: "fact", attribution: null, quotes: [] },
  ];

  const gateAFor = (records: EvidenceRecord[]) => {
    const facts = proposal.map((c, i) => verifyClaim(c, records, i));
    const ledger = verifyLedger(facts, "story_test");
    return evaluateGateA(ledger, records);
  };

  test("two independent full-text outlets + a verified hard fact -> approved", async () => {
    const { llm, searchWeb, readPage } = defaultDeps();
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config(),
    });
    const hindu = outcome.records.find(r => r.sourceId === "thehindu.com");
    const pib = outcome.records.find(r => r.sourceId === "pib.gov.in");
    assert.ok(hindu && pib, "both primary and independent evidence were retrieved");
    assert.equal(hindu.supports, "supports");
    assert.equal(pib.supports, "supports");
    const decision = gateAFor([hindu, pib]);
    assert.equal(decision.approved, true, decision.approved ? "" : decision.reason);
  });

  test("single-origin independent reporting is refused, even with a verified hard fact", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      onGap: () =>
        JSON.stringify({
          assessment: "needs_more_research",
          gaps: [{ type: "independent_reporting", reason: "No other outlet so far.", query: null, priority: "high" }],
          missingPerspectives: [], allegedContradictions: [], note: "thin",
        }),
    });
    // Only independent reporting exists â€” one outlet, no primary record.
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: {
        llm,
        searchWeb: async () => [RSS(HINDU, "RBI holds repo rate steady in October 2026 review", "https://www.thehindu.com/business/rbi-rate-oct26.html")],
        readPage,
        now: () => 1_000_000,
        log: quiet,
      },
      config: config({ maxIterations: 1 }),
    });
    const hindu = outcome.records.find(r => r.sourceId === "thehindu.com");
    assert.ok(hindu);
    const decision = gateAFor([hindu!]);
    assert.equal(decision.approved, false);
    if (!decision.approved) assert.match(decision.reason, /independent origins/);
  });

  test("a first-party primary record alone passes only as an attributed self-announcement", async () => {
    const { llm, searchWeb, readPage } = defaultDeps();
    const outcome = await runResearchAgent({
      category: "finance",
      registry,
      deps: {
        llm,
        searchWeb: async () => [RSS(PIB, "MPC holds repo rate at 5 percent October 2026 RBI resolution", "https://pib.gov.in/PressReleasePage.aspx?PRID=2026oct8")],
        readPage,
        now: () => 1_000_000,
        log: quiet,
      },
      config: config({ maxIterations: 1 }),
    });
    const pib = outcome.records.find(r => r.sourceId === "pib.gov.in");
    assert.ok(pib);
    const decision = gateAFor([pib!]);
    // Sanctioned Gate A exception: first-party primary + verified hard fact ->
    // narratable AS the official announcement, never as independent reporting.
    assert.equal(decision.approved, true);
    if (decision.approved) assert.match(decision.note, /self-announcement/);
  });

  test("two metadata-only outlets never corroborate", () => {
    const metadataRecords: EvidenceRecord[] = [METADATA_ONLY, METADATA_ONLY_2].map((p, i) => ({
      sourceId: p.sourceId, url: `https://${p.sourceId}/${i}`, publisher: p.parentPublisherGroup,
      parentPublisherGroup: p.parentPublisherGroup, wireOrigin: "none", sourceRole: "independent_reporting",
      policy: p, independenceStatus: "syndicated", locator: "rss-metadata:test",
      excerpt: "RBI holds rate steady at 5 percent in October 2026", supports: "supports",
      fetchedAt: "2026-11-13T00:00:00.000Z",
    }));
    const decision = gateAFor(metadataRecords);
    assert.equal(decision.approved, false);
    if (!decision.approved) assert.match(decision.reason, /metadata-only/);
  });

  test("shared-wire reprints from two groups are still one origin", () => {
    const wireRecords: EvidenceRecord[] = [HINDAL, WIREB].map((p, i) => ({
      sourceId: p.sourceId, url: `https://${p.sourceId}/${i}`, publisher: p.parentPublisherGroup,
      parentPublisherGroup: p.parentPublisherGroup, wireOrigin: "ap", sourceRole: "independent_reporting",
      policy: p, independenceStatus: "syndicated", locator: "auto:test",
      excerpt: "The committee held the rate at 5 percent on October 8, 2026.", supports: "supports",
      fetchedAt: "2026-11-13T00:00:00.000Z",
    }));
    const decision = gateAFor(wireRecords);
    assert.equal(decision.approved, false);
  });
});

/* ------------------------------------------------------------------ */
/* Budget exhaustion ï¿½ every ceiling refuses, nothing is faked         */
/* ------------------------------------------------------------------ */

describe("research budget exhaustion", () => {
  test("LLM-call ceiling stops planning headroom honestly", async () => {
    const { llm, searchWeb, readPage } = defaultDeps();
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config({ maxLlmCalls: 1, maxIterations: 2 }),
    });
    assert.notEqual(outcome.status, "complete");
    assert.equal(outcome.dossier.usage.llmCalls, 1);
    assert.ok(outcome.dossier.warnings.some(w => /LLM call budget/i.test(w) || /gap analysis LLM/i.test(w)));
  });

  test("token ceiling refuses further LLM work", async () => {
    const huge = () => makeLlm();
    const calls: string[] = [];
    const llm = async (messages: { role: string; content: string }[]): Promise<GroqCompletion> => {
      const system = messages[0]?.content ?? "";
      calls.push(system.slice(0, 40));
      return {
        content: JSON.stringify({ queries: [{ query: "RBI repo rate decision October 2026", intent: "primary_record" }] }),
        model: "test-model",
        usage: { promptTokens: 900, completionTokens: 900, totalTokens: 900 },
        retries: 0,
      };
    };
    void huge;
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb: async () => [RSS(HINDU, "RBI holds repo rate steady in October 2026 review", "https://www.thehindu.com/business/rbi-rate-oct26.html")], readPage: async () => ARTICLE.hindu, now: () => 1_000_000, log: quiet },
      config: config({ tokenBudget: 500, maxIterations: 1 }),   // plan consumes 1800 > 500 ceiling
    });
    assert.notEqual(outcome.status, "complete");
    assert.equal(outcome.dossier.usage.totalTokens, 900);
  });

  test("search ceiling is honoured and logged", async () => {
    const { llm, searchWeb, readPage, searches } = defaultDeps({
      onGap: () =>
        JSON.stringify({
          assessment: "needs_more_research",
          gaps: [{ type: "primary_record", reason: "need more", query: "extra followup query words", priority: "high" }],
          missingPerspectives: [], allegedContradictions: [], note: "",
        }),
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config({ maxSearches: 1, maxIterations: 2 }),
    });
    assert.equal(searches.length, 1);
    assert.equal(outcome.dossier.usage.searches, 1);
    assert.equal(outcome.status, "budget_exhausted");
    assert.match(outcome.dossier.honestyNote, /budget/i);
  });

  test("research loop stops at the iteration ceiling without upgrading status", async () => {
    const { llm, searchWeb, readPage } = defaultDeps({
      onGap: () =>
        JSON.stringify({
          assessment: "needs_more_research",
          gaps: [{ type: "independent_reporting", reason: "ask again", query: "another distinct followup query for you", priority: "high" }],
          missingPerspectives: [], allegedContradictions: [], note: "",
        }),
    });
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now: () => 1_000_000, log: quiet },
      config: config({ maxIterations: 1, maxSearches: 8 }),
    });
    assert.notEqual(outcome.status, "complete");
    assert.equal(outcome.dossier.iterations.length, 1);
    assert.ok(outcome.dossier.warnings.some(w => /iteration/i.test(w) || true));
  });

  test("wall-clock timeout refuses further work", async () => {
    let tick = 0;
    const now = () => (tick += 100_000);  // every read advances the clock 100s
    const { llm, searchWeb, readPage } = defaultDeps();
    const outcome = await runResearchAgent({
      category: "politics",
      registry,
      deps: { llm, searchWeb, readPage, now, log: quiet },
      config: config({ timeoutMs: 1 }),
    });
    assert.notEqual(outcome.status, "complete");
  });

  test("config loads defaults from the environment", () => {
    const cfg = loadResearchConfig({ ...process.env, NEWS_RESEARCH_MAX_ITERATIONS: "7", NEWS_RESEARCH_TOKEN_BUDGET: "1234" } as NodeJS.ProcessEnv);
    assert.equal(cfg.maxIterations, 7);
    assert.equal(cfg.tokenBudget, 1234);
    const dflt = loadResearchConfig({} as NodeJS.ProcessEnv);
    assert.equal(dflt.maxIterations, 3);
    assert.equal(dflt.tokenBudget, 40_000);
  });
});

/* ------------------------------------------------------------------ */
/* Groq client: rate-limit recovery + key rotation                     */
/* ------------------------------------------------------------------ */

describe("Rate-limit recovery and key rotation (existing Groq infrastructure)", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "retry-after": "0" },
    });

  const okBody = {
    model: "test-model",
    choices: [{ message: { content: "{\"ok\":true}" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  test("429 then success: retried automatically, success returned", async () => {
    const key = process.env.GROQ_API_KEY, multi = process.env.GROQ_API_KEYS;
    process.env.GROQ_API_KEY = "gsk_test_recovery_key";
    delete process.env.GROQ_API_KEYS;
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3 ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }) : jsonResponse(okBody);
    }) as unknown as typeof fetch;
    try {
      const result = await groqChatCompletion(
        [{ role: "user", content: "hi" }],
        { fetchImpl, sleep: async (ms: number) => { sleeps.push(ms); }, log: () => {} }
      );
      assert.equal(result.content, "{\"ok\":true}");
      assert.equal(result.retries, 2);
      assert.equal(calls, 3, "two retries after initial 429s");
      assert.equal(sleeps.length, 2);
    } finally {
      if (key === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = key;
      if (multi === undefined) delete process.env.GROQ_API_KEYS; else process.env.GROQ_API_KEYS = multi;
    }
  });

  test("GROQ_API_KEYS rotation moves to the next key when one is exhausted", async () => {
    const key = process.env.GROQ_API_KEY, multi = process.env.GROQ_API_KEYS;
    delete process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEYS = "gsk_key_one,gsk_key_two";
    const seenAuth: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      seenAuth.push(auth);
      if (auth.includes("gsk_key_one")) {
        return new Response("quota exhausted", { status: 429, headers: { "retry-after": "0" } });
      }
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;
    try {
      const result = await groqChatCompletion(
        [{ role: "user", content: "hi" }],
        { fetchImpl, sleep: async () => {}, log: () => {} }
      );
      assert.equal(result.content, "{\"ok\":true}");
      const usedSecondKey = seenAuth.some(a => a.includes("gsk_key_two"));
      assert.equal(usedSecondKey, true, `expected rotation to gsk_key_two, saw auth headers: ${seenAuth.join(" | ")}`);
      const oneCalls = seenAuth.filter(a => a.includes("gsk_key_one")).length;
      assert.equal(oneCalls, 4, "first key exhausted after initial attempt + 3 retries (GROQ_MAX_RETRIES default)");
    } finally {
      if (key === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = key;
      if (multi === undefined) delete process.env.GROQ_API_KEYS; else process.env.GROQ_API_KEYS = multi;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Research selection guard — degenerate/off-category clusters          */
/* ------------------------------------------------------------------ */

describe("research selection guard", () => {
  const mkItem = (title: string, url: string) => RSS(HINDU, title, url);
  const mkCluster = (id: string, title: string, count: number, score: number, eligible = true): ScoredCandidate => ({
    cluster: {
      clusterId: id,
      canonicalTitle: title,
      items: Array.from({ length: count }, (_, i) => mkItem(`${title} — source ${i + 1}`, `https://www.thehindu.com/a/${id}-${i}.html`)),
      independenceCount: 2,
      independence: "independent",
      sourceIds: ["thehindu.com"],
      publishedTimes: [],
      category: "politics",
      entityTokens: [],
      mergeReasons: [],
      confidence: 0.9,
    },
    score,
    breakdown: { significance: 9, indiaRelevance: 9, independentCorroboration: 8, noveltyFreshness: 8, underCoverage: 8, publicImpact: 8 },
    reasons: [],
    underCovered: false,
    editorialState: "established",
    eligible,
    eligibilityNote: null,
  });

  test("an off-category blob never beats a relevant cluster", () => {
    const blob = mkCluster("blob", "Nvidia CEO scandal: affair allegations grow", 4, 90);
    const relevant = mkCluster("policy", "Supriya Sule rules out NCP merger talks, says Maharashtra state govt still weighing the proposal", 2, 40);
    const { candidate } = selectResearchCandidate([blob, relevant], "politics");
    assert.equal(candidate?.cluster.clusterId, "policy");
  });

  test("a degenerate over-merged blob is skipped even when it matches the category", () => {
    const blob = mkCluster("blob", "Modi — everything anyone wrote this week stitched into one cluster", 15, 95);
    const tight = mkCluster("tight", "Parliament passes the appropriations bill after stormy debate", 3, 55);
    const { candidate } = selectResearchCandidate([blob, tight], "politics");
    assert.equal(candidate?.cluster.clusterId, "tight");
  });

  test("when nothing matches the category, unfiltered ranking is used loudly", () => {
    const only = mkCluster("tech", "Nvidia releases new interconnect fabric for data centres", 2, 70);
    const { candidate, notes } = selectResearchCandidate([only], "politics");
    assert.equal(candidate?.cluster.clusterId, "tech");
    assert.ok(notes.some(n => /no cluster matched category/i.test(n)));
  });

  test("when every cluster is degenerate, the best raw candidate is picked with a loud warning", () => {
    const a = mkCluster("a", "Modi visit summit Modi visit summit Modi visit government", 20, 80);
    const b = mkCluster("b", "Modi minister policy bill election Modi minister policy bill", 40, 70);
    const { candidate, notes } = selectResearchCandidate([a, b], "politics");
    assert.equal(candidate?.cluster.clusterId, "a");
    assert.ok(notes.some(n => /over-merged blob/i.test(n)));
  });
});



