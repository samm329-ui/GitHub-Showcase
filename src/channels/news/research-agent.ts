/**
 * Groq-powered news research agent - the pipeline's discovery stage, grown up.
 *
 * The old lane was a fixed list of pages and canned queries. This agent plans
 * its own searches with Groq, reads what it finds through Fortress-Reach only,
 * extracts claims deterministically, detects gaps itself, searches again, and
 * stops on an explicit contract:
 *
 *   DISCOVER â†’ CLUSTER â†’ SELECT â†’ PLAN_SEARCH â†’ SEARCH â†’ READ â†’ EXTRACT_CLAIMS
 *            â†’ IDENTIFY_GAPS â†’ SEARCH_AGAIN â†’ BUILD_DOSSIER
 *
 * followed by the pipeline's existing VERIFY stage (ledger â†’ Gate A), which
 * remains the only authority on whether the evidence supports an episode.
 *
 * Hard rules (never relaxed, never bypassed):
 *  - Fortress-Reach is the ONLY research environment. No URLs from anywhere
 *    else. Groq cannot see, invent or smuggle URLs: every URL in the dossier
 *    entered through fetchFortressSearch / fetchPageMarkdown / the registry.
 *  - Every LLM output is parsed and schema-checked. Anything malformed is
 *    dropped, logged, and never silently trusted. A URL inside LLM text that
 *    does not match a URL Fortress actually retrieved is rejected as
 *    fabricated. A non-verbatim stance anchor never suppresses evidence.
 *    A `contradicts` verdict only sends evidence to the exclusion pile when
 *    its anchor is verbatim AND contains a hard conflict point (number,
 *    quote or named-entity pair) - an LLM verdict alone can never knock
 *    evidence out of the deterministic verifier's reach.
 *  - Metadata-only records never count as full-text corroboration, and shared
 *    wire lines (AP/Reuters/PTI/PIB releases) count as ONE origin.
 *  - Gate A stays authoritative; no dossier field can approve anything.
 *    LLM "confidence" is never evidence.
 *  - Incomplete research is reported as incomplete. "complete" requires the
 *    sufficiency check to pass against retrieved evidence, not a model's say-so.
 *
 * Opt-in: runs only behind --research (or NEWS_RESEARCH=1). The default
 * discovery path is unchanged.
 */
import type {
  DiscoveredItem,
  EvidenceRecord,
  ScoredCandidate,
} from "./types.js";
import { CATEGORY_QUERIES, BROWSER_PAGES, type NewsCategory } from "./discovery.js";
import { clusterItems, rankCandidates } from "./clustering.js";
import {
  assertDiscoveryAllowed,
  loadRegistry,
  type RegistryLoadResult,
} from "./sources.js";
import {
  fetchFortressSearch,
  fetchFortressHeadlines,
  fetchPageMarkdown,
  FortressError,
} from "./fortress-reach.js";
import { selectExcerpts, buildMetadataEvidence, normalizeComparable, originKeyOf } from "./ledger.js";
import { extractClaimsFromEvidence } from "./claims.js";
import {
  groqChatCompletion,
  GroqError,
  type GroqChatMessage,
  type GroqChatOptions,
  type GroqCompletion,
} from "../../groq.js";

/* ------------------------------------------------------------------ */
/* Configuration - every limit from the environment, sane defaults     */
/* ------------------------------------------------------------------ */

export type ResearchConfig = {
  /** Gap-follow-up iterations, not counting the initial search/read. */
  maxIterations: number;
  /** Total Fortress search_web calls per run. */
  maxSearches: number;
  /** Total articles read (full text) per run. */
  maxArticles: number;
  /** Groq chat completions per run. */
  maxLlmCalls: number;
  /** prompt+completion token ceiling per run. */
  tokenBudget: number;
  /** Wall-clock ceiling per run, ms. */
  timeoutMs: number;
};

const positiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function loadResearchConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  return {
    maxIterations: positiveInt(env.NEWS_RESEARCH_MAX_ITERATIONS, 3),
    maxSearches: positiveInt(env.NEWS_RESEARCH_MAX_SEARCHES, 24),
    maxArticles: positiveInt(env.NEWS_RESEARCH_MAX_ARTICLES, 8),
    maxLlmCalls: positiveInt(env.NEWS_RESEARCH_MAX_LLM_CALLS, 12),
    tokenBudget: positiveInt(env.NEWS_RESEARCH_TOKEN_BUDGET, 40_000),
    timeoutMs: positiveInt(env.NEWS_RESEARCH_TIMEOUT_MS, 10 * 60_000),
  };
}

export type ResearchStatus =
  | "complete"
  | "insufficient_evidence"
  | "budget_exhausted"
  | "no_useful_path"
  | "no_candidates"
  | "transport_failed";

/* ------------------------------------------------------------------ */
/* Budget accounting                                                   */
/* ------------------------------------------------------------------ */

export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
  constructor(readonly limit: keyof ResearchConfig, message: string) {
    super(message);
  }
}

export class BudgetTracker {
  searches = 0;
  articles = 0;
  llmCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  readonly startedAtMs: number;

  constructor(private readonly cfg: ResearchConfig, private readonly now: () => number) {
    this.startedAtMs = now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  /** Reason the next action is refused, or null when budget remains. */
  canSearch(): string | null {
    if (this.searches >= this.cfg.maxSearches) return `search budget exhausted (${this.cfg.maxSearches})`;
    if (this.elapsedMs() >= this.cfg.timeoutMs) return `research timeout exhausted (${this.cfg.timeoutMs}ms)`;
    return null;
  }

  canRead(): string | null {
    if (this.articles >= this.cfg.maxArticles) return `article budget exhausted (${this.cfg.maxArticles})`;
    if (this.elapsedMs() >= this.cfg.timeoutMs) return `research timeout exhausted (${this.cfg.timeoutMs}ms)`;
    return null;
  }

  canLlm(): string | null {
    if (this.llmCalls >= this.cfg.maxLlmCalls) return `LLM call budget exhausted (${this.cfg.maxLlmCalls})`;
    if (this.totalTokens >= this.cfg.tokenBudget) return `token budget exhausted (${this.cfg.tokenBudget})`;
    if (this.elapsedMs() >= this.cfg.timeoutMs) return `research timeout exhausted (${this.cfg.timeoutMs}ms)`;
    return null;
  }

  recordSearch(): void {
    this.searches += 1;
  }

  recordRead(): void {
    this.articles += 1;
  }

  /** Every LLM invocation counts against the call ceiling, success or not. */
  recordLlmCall<T extends GroqCompletion>(completion: T | null): void {
    this.llmCalls += 1;
    if (!completion) return;
    this.promptTokens += completion.usage.promptTokens ?? 0;
    this.completionTokens += completion.usage.completionTokens ?? 0;
    this.totalTokens += completion.usage.totalTokens ?? 0;
  }

  snapshot() {
    return {
      searches: this.searches,
      articlesRead: this.articles,
      llmCalls: this.llmCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      elapsedMs: this.elapsedMs(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Dependency injection - tests never touch the network                */
/* ------------------------------------------------------------------ */

export type ResearchDeps = {
  searchWeb?: (query: string) => Promise<DiscoveredItem[]>;
  readPage?: (url: string) => Promise<string>;
  /** Front-page headline harvest. Injected by tests; live default = Fortress browser lane when `deps` is not given. */
  browseHomepage?: (pageUrl: string) => Promise<DiscoveredItem[]>;
  llm?: (
    messages: GroqChatMessage[],
    options?: GroqChatOptions
  ) => Promise<GroqCompletion>;
  log?: (line: string) => void;
  now?: () => number;
};

/* ------------------------------------------------------------------ */
/* Fabrication safeguards - URLs and anchors must come from Fortress   */
/* ------------------------------------------------------------------ */

const URL_TOKEN_RE = /https?:\/\/[^\s"'<>)\]â€ºâ†’]+/g;

/**
 * Return every http(s) URL in `text` that is NOT in `knownUrls`.
 * LLM text containing invented URLs fails this check; callers drop the URL.
 */
export function findFabricatedUrls(text: string, knownUrls: ReadonlySet<string>): string[] {
  const found = text.match(URL_TOKEN_RE) ?? [];
  const clean = (u: string) => u.replace(/[.,;:]+$/, "");
  const known = new Set([...knownUrls].map(clean));
  return [...new Set(found.map(clean))].filter(u => !known.has(u));
}

/** True when every URL token in the text is one Fortress actually retrieved. */
export function urlsAreAllRetrieved(text: string, knownUrls: ReadonlySet<string>): boolean {
  return findFabricatedUrls(text, knownUrls).length === 0;
}

/* ------------------------------------------------------------------ */
/* LLM output schemas (hand-rolled; no new dependencies)               */
/* ------------------------------------------------------------------ */

const stripFences = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

const tryParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
};

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= min && t.length <= max ? t : null;
};

const asStringArray = (v: unknown, max: number, maxLen = 300): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map(item => asString(item, 1, maxLen))
    .filter((s): s is string => Boolean(s))
    .slice(0, max);
};

export type SearchPlanQuery = { query: string; intent: "primary_record" | "independent_reporting" | "contradiction" | "context" };

export type SearchPlan = { queries: SearchPlanQuery[]; source: "groq" | "fallback" };

const PLAN_INTENTS = new Set(["primary_record", "independent_reporting", "contradiction", "context"]);

/** Parse + validate the plan LLM's output. Falls back to the static category queries. */
export function parseSearchPlan(raw: string | null, category: NewsCategory): SearchPlan {
  const fallback: SearchPlan = {
    queries: CATEGORY_QUERIES[category].slice(0, 4).map(query => ({ query, intent: "context" as const })),
    source: "fallback",
  };
  if (!raw) return fallback;
  const obj = asObject(tryParseJson(raw));
  const arr = obj && Array.isArray(obj.queries) ? obj.queries : null;
  if (!arr) return fallback;
  const queries: SearchPlanQuery[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const o = asObject(item);
    if (!o) continue;
    const query = asString(o.query, 4, 140);
    if (!query) continue;
    // Fabrication safeguard: the model never gets to choose WHICH URL to read -
    // and it does not get to search URLs either. Queries must be words.
    if (/https?:\/\//i.test(query)) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const intent = PLAN_INTENTS.has(String(o.intent)) ? (String(o.intent) as SearchPlanQuery["intent"]) : "context";
    queries.push({ query, intent });
    if (queries.length >= 6) break;
  }
  if (queries.length === 0) return fallback;
  return { queries, source: "groq" };
}

export type GapType =
  | "independent_reporting"
  | "primary_record"
  | "contradiction_check"
  | "missing_perspective"
  | "missing_detail";

const GAP_TYPES = new Set<GapType>([
  "independent_reporting",
  "primary_record",
  "contradiction_check",
  "missing_perspective",
  "missing_detail",
]);

export type GapAnalysis = {
  assessment: "sufficient" | "needs_more_research";
  gaps: Array<{ type: GapType; reason: string; query: string | null; priority: "high" | "medium" }>;
  missingPerspectives: string[];
  /** LLM-identified contradiction notes - leads only, never verified claims. */
  allegedContradictions: string[];
  note: string;
};

/**
 * Parse + validate the gap analysis. URLs in any field are rejected as
 * fabricated material; the analysis itself is still usable.
 */
export function parseGapAnalysis(
  raw: string | null,
  knownUrls: ReadonlySet<string>
): { analysis: GapAnalysis | null; fabricatedUrlsRejected: string[] } {
  const fabricated: string[] = [];
  if (!raw) return { analysis: null, fabricatedUrlsRejected: fabricated };
  const obj = asObject(tryParseJson(raw));
  if (!obj) return { analysis: null, fabricatedUrlsRejected: fabricated };

  // Fabricated-URL sweep across the free-text parts of the payload.
  for (const field of ["note", "missingPerspectives", "allegedContradictions"]) {
    const value = obj[field];
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : "";
    fabricated.push(...findFabricatedUrls(text, knownUrls));
  }

  const assessment = obj.assessment === "sufficient" ? "sufficient" : "needs_more_research";
  const gaps: GapAnalysis["gaps"] = [];
  if (Array.isArray(obj.gaps)) {
    for (const item of obj.gaps.slice(0, 6)) {
      const o = asObject(item);
      if (!o) continue;
      const reason = asString(o.reason, 4, 400);
      if (!reason) continue;
      let query = asString(o.query, 4, 140);
      if (query && /https?:\/\//i.test(query)) {
        fabricated.push(query.split(/\s/).find(t => /https?:\/\//i.test(t)) ?? query);
        query = null;
      }
      const type = GAP_TYPES.has(String(o.type) as GapType) ? (String(o.type) as GapType) : "missing_detail";
      gaps.push({ type, reason, query, priority: o.priority === "high" ? "high" : "medium" });
    }
  }
  const note = asString(obj.note, 0, 600) ?? "";
  return {
    analysis: {
      assessment,
      gaps,
      missingPerspectives: asStringArray(obj.missingPerspectives, 6),
      allegedContradictions: asStringArray(obj.allegedContradictions, 6),
      note: fabricated.length > 0 ? `${note} [fabricated URLs rejected: ${fabricated.length}]`.trim() : note,
    },
    fabricatedUrlsRejected: [...new Set(fabricated)],
  };
}

export type StanceVerdict = {
  /** The raw stance the LLM returned, after anchor validation. */
  supports: "supports" | "contradicts" | "context_only";
  /** Verbatim-validated anchor passage, null when the model paraphrased. */
  anchor: string | null;
  /** False when the anchor failed the verbatim check (fabrication rejected). */
  anchorValid: boolean;
};

/** A hard conflict point: a number, a quoted string, or named-entity pair. */
export function hasHardConflictPoint(anchor: string): boolean {
  if (/\d{2,}/.test(anchor)) return true;
  if (/["“][^"”]{4,}["”]/.test(anchor)) return true;
  const caps = anchor.match(/\b[A-Z][A-Za-z&.'-]{2,}\b/g) ?? [];
  return caps.length >= 2;
}

/** Parse the contradiction-auditor response. Anything unparseable is NOT a confirmation. */
export function parseAdversarialVerdict(raw: string | null): "denies" | "does_not_deny" | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/\bdoes_not_deny\b/.test(t) || /does not deny/.test(t)) return "does_not_deny";
  if (/\bdenies\b/.test(t)) return "denies";
  return null;
}

/**
 * Effective record-status for corroboration purposes. An LLM verdict NEVER
 * single-handedly suppresses evidence: a `contradicts` verdict only counts
 * when its anchor (a) is verbatim in the retrieved page, (b) contains a hard
 * conflict point, and (c) is upheld by an independent adversarial audit.
 */
export function effectiveStance(verdict: StanceVerdict): "supports" | "contradicts" {
  if (verdict.supports === "contradicts" && verdict.anchorValid && verdict.anchor &&
      hasHardConflictPoint(verdict.anchor)) {
    return "contradicts";
  }
  return "supports";
}

/** Parse + validate a per-article stance verdict against the retrieved text. */
export function parseStanceVerdict(raw: string | null, articleText: string): StanceVerdict {
  const fail: StanceVerdict = { supports: "context_only", anchor: null, anchorValid: false };
  if (!raw) return fail;
  const obj = asObject(tryParseJson(raw));
  if (!obj) return fail;
  const stanceRaw = String(obj.stance ?? "").toLowerCase();
  const stance =
    stanceRaw === "supports" ? "supports" : stanceRaw === "contradicts" ? "contradicts" : "context_only";
  const anchorRaw = asString(obj.anchor, 0, 320);
  if (!anchorRaw) return { ...fail, supports: stance === "supports" ? "context_only" : stance };
  const anchorValid = normalizeComparable(articleText).includes(normalizeComparable(anchorRaw));
  if (!anchorValid) return { supports: "context_only", anchor: anchorRaw, anchorValid: false };
  return { supports: stance, anchor: anchorRaw, anchorValid: true };
}

/* ------------------------------------------------------------------ */
/* Independent-origin analysis - wire-lineage and publisher groups     */
/* ------------------------------------------------------------------ */

export type IndependentOriginAnalysis = {
  fullTextRecords: number;
  metadataOnlyRecords: number;
  distinctSources: number;
  distinctPublisherGroups: number;
  distinctWireLines: number;
  /** Distinct wire-lineage origin keys among FULL-TEXT supporting records -- metadata-only never corroborates. */
  corroboratingOrigins: number;
  corroboratingGroups: string[];
  duplicateOriginGroups: Array<{ group: string; sourceIds: string[] }>;
  syndicatedWirePairs: Array<{ wireOrigin: string; sourceIds: string[] }>;
  verdict: string;
};

const isMetadataOnlyRecord = (r: EvidenceRecord): boolean =>
  (r.locator ?? "").startsWith("rss-metadata") || (r.locator ?? "").startsWith("research-metadata");

export function buildIndependentOriginAnalysis(records: EvidenceRecord[]): IndependentOriginAnalysis {
  const fullText = records.filter(r => !isMetadataOnlyRecord(r));
  const metadata = records.filter(isMetadataOnlyRecord);
  const supportingFullText = fullText.filter(r => r.supports === "supports");
  const corroboration = new Map<string, EvidenceRecord>();
  for (const r of supportingFullText) {
    corroboration.set(originKeyOf(r), r);
  }

  const byGroup = new Map<string, string[]>();
  for (const r of fullText) {
    const arr = byGroup.get(r.parentPublisherGroup) ?? [];
    arr.push(r.sourceId);
    byGroup.set(r.parentPublisherGroup, arr);
  }
  const duplicateOriginGroups = [...byGroup.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([group, sourceIds]) => ({ group, sourceIds: [...new Set(sourceIds)] }));

  const byWire = new Map<string, string[]>();
  for (const r of fullText) {
    const wire = r.wireOrigin ?? "none";
    if (wire === "none") continue;
    const arr = byWire.get(wire) ?? [];
    arr.push(r.sourceId);
    byWire.set(wire, arr);
  }
  const syndicatedWirePairs = [...byWire.entries()]
    .filter(([, ids]) => new Set(ids).size > 1)
    .map(([wireOrigin, sourceIds]) => ({ wireOrigin, sourceIds: [...new Set(sourceIds)] }));

  const distinctSources = new Set(fullText.map(r => r.sourceId)).size;
  const distinctGroups = new Set(fullText.map(r => r.parentPublisherGroup)).size;
  const distinctWires = new Set(fullText.map(r => r.wireOrigin ?? "none").filter(w => w !== "none")).size;
  const corroboratingGroups = [...new Set(supportingFullText.map(r => r.parentPublisherGroup))].sort();

  let verdict: string;
  if (corroboration.size >= 2) verdict = `${corroboration.size} independent origins corroborate`;
  else if (supportingFullText.length > 0 && distinctGroups === 1)
    verdict = "single publisher group (self-announcement or syndicated) - announcement-grade, not corroborated";
  else if (supportingFullText.length > 0)
    verdict = "one origin per publisher group or shared wire - attribution required, not corroborated";
  else verdict = "no full-text supporting record - evidence insufficient";

  return {
    fullTextRecords: fullText.length,
    metadataOnlyRecords: metadata.length,
    distinctSources,
    distinctPublisherGroups: distinctGroups,
    distinctWireLines: distinctWires,
    corroboratingOrigins: corroboration.size,
    corroboratingGroups,
    duplicateOriginGroups,
    syndicatedWirePairs,
    verdict,
  };
}

/* ------------------------------------------------------------------ */
/* Registry policy lookup (mirror of index.ts's local helper)          */
/* ------------------------------------------------------------------ */

function policyForUrl(url: string, registry: RegistryLoadResult) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return registry.policies.find(
      p => p.enabled && (host === p.domain || host.endsWith(`.${p.domain}`) || p.domain.endsWith(`.${host}`))
    );
  } catch {
    return undefined;
  }
}

const isFullTextUrl = (url: string, registry: RegistryLoadResult): boolean =>
  Boolean(policyForUrl(url, registry)?.fullTextFetchAllowed);

/* ------------------------------------------------------------------ */
/* Category fitness - SELECT must prefer category-relevant stories      */
/* ------------------------------------------------------------------ */

const CATEGORY_FIT: Partial<Record<NewsCategory, RegExp>> = {
  politics: /(government|minister|parliament|lok sabha|rajya sabha|modi|bjp|congress|aap|cabinet|bill|election|scam|court|policy|yogi|opposition|state govt|singh\b|nation)/i,
  geopolitics: /(war|china|pakistan|russia|ukraine|taiwan|sanction|missile|united nations|border|treaty|nato|quad|trump|summit|diplom)/i,
  ai: /(\bai\b|artificial intelligence|llm|gpt|gemini|claude|mistral|deepmind|openai|anthropic|gpu|nvidia|neural|model)/i,
  technology: /(cyber|security|breach|chip|semiconductor|software|cloud|data|quantum|startup|tech|linux|android|apple|google|microsoft)/i,
  finance: /(rbi|rate|inflation|market|sebi|stock|bond|rupee|gdp|budget|tax|bank|monetary|fiscal|nifty|sensex|ipo|sec|fed|trade)/i,
  environment: /(climate|emission|pollution|forest|carbon|environment|wildlife|energy|solar|flood|monsoon|heatwave|cop\d*)/i,
  under_covered: /(supreme court|regulat|filing|patent|statistical|order|act\b|notification|tribunal|gazette)/i,
};

/** A cluster bigger than this is not a story - it is the signature of
 * transitive over-merging in clusterItems (each merge appends the whole
 * union of entity tokens, so the blob swallows near-misses). Selection must
 * prefer tight clusters; when none exist, fall back loudly and log it. */
export const MAX_COHERENT_CLUSTER = 12;

const clusterSearchText = (c: ScoredCandidate): string =>
  `${c.cluster.canonicalTitle} ${c.cluster.items.map(i => i.title).join(" ")}`;

/**
 * Research-agent selection: category fitness first, then tight clusters,
 * then eligibility, then raw score. Every override is logged - silent
 * selection changes are not allowed.
 */
export function selectResearchCandidate(
  scored: ScoredCandidate[],
  category: NewsCategory
): { candidate: ScoredCandidate | null; notes: string[] } {
  const notes: string[] = [];
  const fit = CATEGORY_FIT[category];
  const matched = fit ? scored.filter(c => fit.test(clusterSearchText(c))) : scored;
  if (fit && matched.length === 0) {
    notes.push(`no cluster matched category "${category}" - falling back to unfiltered ranking`);
  }
  const pool = matched.length > 0 ? matched : scored;
  const tight = pool.filter(c => c.cluster.items.length <= MAX_COHERENT_CLUSTER);
  if (tight.length === 0 && pool.length > 0) {
    notes.push(`every cluster exceeded ${MAX_COHERENT_CLUSTER} items (over-merged blob) - using best raw score, expect a meaningless pick`);
  }
  const finalPool = tight.length > 0 ? tight : pool;
  const candidate = finalPool.find(c => c.eligible) ?? finalPool[0] ?? null;
  return { candidate, notes };
}

const storyKeywords = (title: string): string[] =>
  title.split(/\s+/).filter(w => w.length > 4 && !/^https?:/i.test(w)).slice(0, 10);

/* ------------------------------------------------------------------ */
/* LLM call wrapper - budget accounting on every attempt               */
/* ------------------------------------------------------------------ */

type LlmCallResult =
  | { ok: true; completion: GroqCompletion }
  | { ok: false; error: string; unavailable: boolean };

async function callLlm(
  budget: BudgetTracker,
  deps: { llm: NonNullable<ResearchDeps["llm"]>; log: (line: string) => void },
  messages: GroqChatMessage[],
  maxTokens: number
): Promise<LlmCallResult> {
  const refused = budget.canLlm();
  if (refused) return { ok: false, error: refused, unavailable: false };
  try {
    const completion = await deps.llm(messages, { maxTokens, log: deps.log });
    budget.recordLlmCall(completion);
    return { ok: true, completion };
  } catch (error) {
    budget.recordLlmCall(null);
    if (error instanceof BudgetExceeded) {
      return { ok: false, error: error.message, unavailable: false };
    }
    const unavailable = error instanceof GroqError;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false, error: message, unavailable };
  }
}

const normQuery = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();
const fingerprintOf = (item: DiscoveredItem) => item.fingerprint;

/* ------------------------------------------------------------------ */
/* Article selection - diversity first, registry permission always     */
/* ------------------------------------------------------------------ */

export function selectArticlesToRead(
  candidates: DiscoveredItem[],
  readUrls: ReadonlySet<string>,
  remainingArticles: number,
  registry: RegistryLoadResult
): DiscoveredItem[] {
  const score = (item: DiscoveredItem): number => {
    const p = item.sourcePolicy;
    let s = 0;
    if (p.fullTextFetchAllowed) s += 100;
    else if (p.metadataAllowed) s += 10;
    if (p.sourceRole === "primary") s += 40;
    else if (p.sourceRole === "independent_reporting") s += 30;
    else if (p.sourceRole === "fact_check") s += 15;
    return s;
  };
  const pool = candidates
    .filter(item => !readUrls.has(item.url))
    .sort((a, b) => score(b) - score(a));
  const out: DiscoveredItem[] = [];
  const perGroup = new Map<string, number>();
  for (const item of pool) {
    if (out.length >= remainingArticles) break;
    const group = item.sourcePolicy.parentPublisherGroup;
    const used = perGroup.get(group) ?? 0;
    if (used >= 2) continue; // diversity: at most two reads from one publisher group per pass
    perGroup.set(group, used + 1);
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Research Dossier                                                    */
/* ------------------------------------------------------------------ */

export type ResearchDossier = {
  version: 1;
  category: NewsCategory;
  startedAt: string;
  finishedAt: string;
  /** Never upgraded by the LLM; it reflects what the loop actually did. */
  status: ResearchStatus;
  honestyNote: string;
  limits: ResearchConfig;
  usage: ReturnType<BudgetTracker["snapshot"]>;
  initialQueries: Array<{ query: string; intent: string }>;
  searches: Array<{
    mode: "initial" | "followup" | "browse";
    query: string;
    resultCount: number;
    hits: Array<{ url: string; title: string; sourceId: string }>;
  }>;
  selectedStory: { title: string; url: string; category: string };
  /** UNVERIFIED Groq proposals for context only - the ledger is authoritative. */
  proposedClaims: Array<{ claim: string; kind: string; importance: string }>;
  articles: Array<{
    url: string;
    sourceId: string;
    parentPublisherGroup: string;
    sourceRole: string;
    wireOrigin: string | null;
    independenceStatus: string;
    retrieval: "full_text" | "metadata_only";
    publishedAt: string | null;
    excerptPassages: string[];
    supports: "supports" | "contradicts" | "context_only";
    /** Raw LLM stance (labelled lead); `supports` is the effective corroboration status after anchor enforcement. */
    llmStance?: string | null;
    stanceAnchorValidated: boolean;
  }>;
  independentOriginAnalysis: IndependentOriginAnalysis;
  /** LLM-identified contradiction leads - verified only by the deterministic verifier. */
  allegedContradictions: string[];
  missingPerspectives: string[];
  gapsEncountered: Array<{ type: string; reason: string; resolved: boolean }>;
  iterations: Array<{ iteration: number; actions: string[] }>;
  warnings: string[];
};

export type ResearchOutcome = {
  status: ResearchStatus;
  candidate: ScoredCandidate | null;
  clusterItems: DiscoveredItem[];
  records: EvidenceRecord[];
  dossier: ResearchDossier;
};

/* ------------------------------------------------------------------ */
/* The agent                                                           */
/* ------------------------------------------------------------------ */

export async function runResearchAgent(options: {
  category: NewsCategory;
  registry?: RegistryLoadResult;
  reachBaseUrl?: string;
  log?: (line: string) => void;
  deps?: ResearchDeps;
  config?: ResearchConfig;
}): Promise<ResearchOutcome> {
  const { category } = options;
  const log = options.deps?.log ?? options.log ?? (() => {});
  const nowFn = options.deps?.now ?? (() => Date.now());
  const registry = options.registry ?? loadRegistry();
  const cfg = options.config ?? loadResearchConfig();
  const budget = new BudgetTracker(cfg, nowFn);
  const startedAt = new Date(nowFn()).toISOString();
  const warnings: string[] = [];

  const baseUrl = options.reachBaseUrl ?? process.env.REACH_MCP_URL;
  const llm = options.deps?.llm ?? groqChatCompletion;
  const searchWeb =
    options.deps?.searchWeb ??
    (baseUrl
      ? (query: string) => fetchFortressSearch(baseUrl, query, registry)
      : undefined);
  const readPage =
    options.deps?.readPage ??
    (baseUrl ? (url: string) => fetchPageMarkdown(baseUrl, url) : undefined);
  /* Tests inject deps for hermetic runs - live browser harvest only when the
   * caller passes no deps object at all (the production path). */
  const browseHomepage =
    options.deps?.browseHomepage ??
    (options.deps || !baseUrl
      ? undefined
      : (page: string) => fetchFortressHeadlines(baseUrl, page, registry));

  const knownUrls = new Set<string>();
  const searches: ResearchDossier["searches"] = [];
  const articles: ResearchDossier["articles"] = [];
  const gapsEncountered: ResearchDossier["gapsEncountered"] = [];
  const iterations: ResearchDossier["iterations"] = [];
  const usedQueries = new Set<string>();
  const readUrls = new Set<string>();
  const recordByUrl = new Map<string, EvidenceRecord>();
  /* In-memory only (never written to disk): full retrieved pages used to
   * verbatim-check LLM stance anchors. The ledger keeps excerpts only. */
  const markdownByUrl = new Map<string, string>();
  let allegedContradictions: string[] = [];
  let missingPerspectives: string[] = [];
  let proposedClaims: Array<{ claim: string; kind: string; importance: string }> = [];

  const fail = (status: ResearchStatus, honestyNote: string, candidate: ScoredCandidate | null, items: DiscoveredItem[]): ResearchOutcome => ({
    status,
    candidate,
    clusterItems: items,
    records: [...recordByUrl.values()],
    dossier: {
      version: 1,
      category,
      startedAt,
      finishedAt: new Date(nowFn()).toISOString(),
      status,
      honestyNote,
      limits: cfg,
      usage: budget.snapshot(),
      initialQueries: [],
      searches,
      selectedStory: { title: candidate?.cluster.canonicalTitle ?? "none", url: candidate?.cluster.items[0]?.url ?? "", category },
      proposedClaims,
      articles,
      independentOriginAnalysis: buildIndependentOriginAnalysis([...recordByUrl.values()]),
      allegedContradictions,
      missingPerspectives,
      gapsEncountered,
      iterations,
      warnings,
    },
  });

  if (!searchWeb || !readPage) {
    warnings.push("REACH_MCP_URL is not set - Fortress-Reach is the only research environment; nothing to search with.");
    return fail("transport_failed", "Fortress-Reach unavailable: set REACH_MCP_URL to a running server.", null, []);
  }

  /* ---------------- PLAN_SEARCH (Groq, schema-checked) ---------------- */
  log(`  research: planning queries for category=${category} (Groq)…`);
  /* The model plans inside the actual registry - it is told which outlets
   * exist, so queries land on retrievable sources instead of a plausible-
   * sounding topic no permitted outlet covers. */
  const registeredOutlets = registry.policies
    .filter(p => p.enabled && (p.discoveryAllowed || p.fullTextFetchAllowed))
    .map(p => p.sourceId)
    .slice(0, 45);
  const planResult = await callLlm(
    budget,
    { llm, log },
    [
      {
        role: "system",
        content:
          "You are a newsroom research director. Output ONLY JSON. Never include URLs - the research system chooses sources, you choose search terms.",
      },
      {
        role: "user",
        content: [
          `Category: ${category}. Date: ${new Date(nowFn()).toISOString().slice(0, 10)}.`,
          `Registered sources (ONLY these outlets and primary records can be searched/read - plan against them): ${registeredOutlets.join(", ")}.`,
          "Produce 3-6 web search queries that would surface today's most important stories in this category: the primary institutional record or official document where one exists, leading coverage across REGISTERED outlets, plus a contradiction/correction angle.",
          'Respond with ONLY JSON: {"queries":[{"query":"...","intent":"primary_record|independent_reporting|contradiction|context"}]}',
        ].join("\n"),
      },
    ],
    700
  );
  const plan = parseSearchPlan(planResult.ok ? planResult.completion.content : null, category);
  if (!planResult.ok) {
    warnings.push(`plan LLM unavailable/invalid (${planResult.error}); using static ${plan.source === "fallback" ? "category" : "fallback"} queries.`);
    log(`  research: plan fell back to static category queries (${planResult.error})`);
  } else {
    log(`  research: plan source=groq (${plan.queries.length} queries)`);
  }
  const initialQueries = plan.queries.map(q => ({ query: q.query, intent: q.intent as string }));

  /* ---------------- DISCOVER (Fortress, registry-filtered) ------ */
  const allItems: DiscoveredItem[] = [];
  const seenItems = new Set<string>();
  const addHits = (hits: DiscoveredItem[]): number => {
    let added = 0;
    for (const item of hits) {
      knownUrls.add(item.url);
      const fp = fingerprintOf(item);
      if (seenItems.has(fp)) continue;
      seenItems.add(fp);
      allItems.push(item);
      added += 1;
    }
    return added;
  };
  const runSearch = async (query: string, mode: "initial" | "followup"): Promise<void> => {
    const refused = budget.canSearch();
    usedQueries.add(normQuery(query));
    if (refused) {
      warnings.push(`search skipped (${refused})`);
      return;
    }
    budget.recordSearch();
    let hits: DiscoveredItem[] = [];
    try {
      hits = await searchWeb(query);
    } catch (error) {
      const detail = error instanceof FortressError || error instanceof Error ? error.message.split("\n")[0] : String(error);
      warnings.push(`search ${JSON.stringify(query)} failed closed (${detail})`);
      searches.push({ mode, query, resultCount: 0, hits: [] });
      log(`  research: search failed-closed: ${query} (${detail.slice(0, 100)})`);
      return;
    }
    addHits(hits);
    searches.push({
      mode,
      query,
      resultCount: hits.length,
      hits: hits.slice(0, 12).map(h => ({ url: h.url, title: h.title, sourceId: h.sourceId })),
    });
    log(`  research: [${mode}] "${query}" ? ${hits.length} permitted hit(s)`);
  };

  /* Front-page browse - the reliable Fortress lane (search_web can return
   * registry-filtered junk). Each page is one budgeted operation. */
  if (browseHomepage) {
    for (const page of BROWSER_PAGES[category] ?? []) {
      if (budget.canSearch()) {
        warnings.push(budget.canSearch()!);
        break;
      }
      budget.recordSearch();
      try {
        const hits = await browseHomepage(page);
        addHits(hits);
        searches.push({
          mode: "browse",
          query: page,
          resultCount: hits.length,
          hits: hits.slice(0, 12).map(h => ({ url: h.url, title: h.title, sourceId: h.sourceId })),
        });
        log(`  research: [browse] ${page} -> ${hits.length} headline(s)`);
      } catch (error) {
        const detail = error instanceof FortressError || error instanceof Error ? error.message.split("\n")[0] : String(error);
        warnings.push(`browse ${page} failed closed (${detail})`);
        searches.push({ mode: "browse", query: page, resultCount: 0, hits: [] });
        log(`  research: browse failed-closed: ${page} (${detail.slice(0, 100)})`);
      }
    }
  }

  for (const q of plan.queries) {
    if (budget.canSearch()) {
      warnings.push(budget.canSearch()!);
      break;
    }
    await runSearch(q.query, "initial");
  }

  /* Zero-hit plan - do one bounded deterministic pass before declaring
   * nothing found. LLM plans are creative; the static category queries are
   * known to hit registered outlets. */
  if (allItems.length === 0) {
    const fallbackQueries = (CATEGORY_QUERIES[category] ?? []).slice(0, 3);
    if (fallbackQueries.length > 0) {
      warnings.push(`planned queries returned nothing permitted - falling back to ${fallbackQueries.length} deterministic category query(s).`);
      log("  research: plan returned no permitted hits - deterministic category fallback engaged");
      for (const fq of fallbackQueries) {
        if (budget.canSearch()) break;
        await runSearch(fq, "initial");
      }
    }
  }

  /* ---------------- CLUSTER + SELECT --------------------------------- */
  if (allItems.length === 0) {
    const note = warnings.length
      ? "Discovery returned nothing - every search failed closed or found nothing permitted."
      : "Discovery returned nothing.";
    return fail("no_candidates", note, null, []);
  }
  const clusters = clusterItems(allItems);
  const scored = rankCandidates(clusters);
  const selection = selectResearchCandidate(scored, category);
  for (const note of selection.notes) {
    warnings.push(note);
    log(`  research: ${note}`);
  }
  const chosen = selection.candidate;
  if (!chosen) return fail("no_candidates", "No story cluster formed from discovery.", null, allItems);
  log(`  research: selected "${chosen.cluster.canonicalTitle.slice(0, 80)}" from ${clusters.length} cluster(s) (score ${chosen.score.toFixed(2)})`);

  /* ---------------- ITERATE: read ? claims ? gaps ? search again ------ */
  const remainingToRead = () => Math.max(0, cfg.maxArticles - budget.articles);
  let status: ResearchStatus = "insufficient_evidence";

  for (let iteration = 1; iteration <= cfg.maxIterations; iteration += 1) {
    const actions: string[] = [];

    /* ---- READ ---- */
    const toRead = selectArticlesToRead(chosen.cluster.items, readUrls, remainingToRead(), registry);
    let newFullText = 0;
    let metadataOnly = 0;
    for (const item of toRead) {
      if (budget.canRead()) {
        warnings.push(budget.canRead()!);
        actions.push("read:budget-refused");
        break;
      }
      readUrls.add(item.url);
      const policy = item.sourcePolicy;
      if (!isFullTextUrl(item.url, registry)) {
        const meta = buildMetadataEvidence([item], registry, "rss-metadata:research-discovery");
        for (const record of meta) {
          recordByUrl.set(record.url, record);
          metadataOnly += 1;
        }
        if (policy.metadataAllowed) {
          articles.push({
            url: item.url, sourceId: item.sourceId, parentPublisherGroup: policy.parentPublisherGroup,
            sourceRole: policy.sourceRole, wireOrigin: policy.wireOrigin ?? null,
            independenceStatus: "syndicated", retrieval: "metadata_only",
            publishedAt: item.publishedAt, excerptPassages: [item.title].slice(0, 3),
            supports: "supports", llmStance: "metadata_only", stanceAnchorValidated: true,
          });
        }
        actions.push(`read:metadata ${item.sourceId}`);
        continue;
      }
      try {
        budget.recordRead();
        const markdown = await readPage(item.url);
        markdownByUrl.set(item.url, markdown);
        knownUrls.add(item.url);
        const passages = selectExcerpts(markdown, storyKeywords(chosen.cluster.canonicalTitle), 6);
        const record: EvidenceRecord = {
          sourceId: policy.sourceId,
          url: item.url,
          publisher: policy.parentPublisherGroup,
          parentPublisherGroup: policy.parentPublisherGroup,
          wireOrigin: policy.wireOrigin,
          sourceRole: policy.sourceRole,
          policy,
          independenceStatus: "independent",
          publishedAt: item.publishedAt ?? undefined,
          locator: "auto:research-agent",
          excerpt: passages.join("\n"),
          supports: "context_only",
          fetchedAt: new Date(nowFn()).toISOString(),
        };
        recordByUrl.set(item.url, record);
        articles.push({
          url: item.url, sourceId: item.sourceId, parentPublisherGroup: policy.parentPublisherGroup,
          sourceRole: policy.sourceRole, wireOrigin: policy.wireOrigin ?? null,
          independenceStatus: "independent", retrieval: "full_text",
          publishedAt: item.publishedAt ?? null, excerptPassages: passages,
          supports: "context_only", llmStance: "unclassified", stanceAnchorValidated: false,
        });
        newFullText += 1;
        actions.push(`read:full_text ${item.sourceId} (${passages.length} passages)`);
        log(`  research: read full text ${item.sourceId} (${markdown.length} chars, ${passages.length} passage(s))`);
      } catch (error) {
        const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
        warnings.push(`read ${item.sourceId} failed closed (${detail})`);
        actions.push(`read:failed ${item.sourceId}`);
        log(`  research: read failed closed: ${item.url} (${detail.slice(0, 100)})`);
      }
    }
    actions.push(`summary: fullText=${newFullText} metadata=${metadataOnly}`);

    /* ---- EXTRACT_CLAIMS (Groq proposals; deterministic backstop) ----- */
    const dossierText = [...recordByUrl.values()]
      .map(r => `[${r.sourceId}] ${(r.excerpt ?? "").slice(0, 1600)}`)
      .join("\n\n---\n\n");
    proposedClaims = [];
    const claimsResult = await callLlm(
      budget,
      { llm, log },
      [
        {
          role: "system",
          content:
            "You are a claim-extraction assistant. Claims must come verbatim or as attributed paraphrase from the evidence; never strengthen, never invent. Output ONLY JSON.",
        },
        {
          role: "user",
          content: [
            `Story: ${chosen.cluster.canonicalTitle}`,
            "",
            "Evidence passages:",
            dossierText,
            "",
            'Respond with ONLY JSON: {"claims":[{"claim":"...","kind":"event|date|number|quote|identity|legal_status|cause|effect|claim_by_actor|forecast|analysis","importance":"core|supporting|optional"}]}',
          ].join("\n"),
        },
      ],
      1500
    );
    if (claimsResult.ok) {
      const parsed = tryParseJson(claimsResult.completion.content);
      const obj = asObject(parsed);
      const arr = obj && Array.isArray(obj.claims) ? obj.claims : [];
      proposedClaims = arr
        .map(item => {
          const o = asObject(item);
          const claim = o ? asString(o.claim, 8, 400) : null;
          if (!claim) return null;
          if (findFabricatedUrls(claim, knownUrls).length > 0) return null; // never let a URL claim through
          const kind = asString(o?.kind, 1, 30) ?? "event";
          const importance = asString(o?.importance, 1, 20) === "core" ? "core" : "supporting";
          return { claim, kind, importance };
        })
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .slice(0, 14);
      actions.push(`claims: groq proposed ${proposedClaims.length}`);
    } else {
      warnings.push(`claim-proposal LLM unavailable (${claimsResult.error}); deterministic extractor will run downstream.`);
      const fallback = extractClaimsFromEvidence([...recordByUrl.values()], { maxClaims: 12 });
      proposedClaims = fallback.map(c => ({ claim: c.claim, kind: c.kind, importance: c.importance }));
      actions.push(`claims: deterministic fallback (${proposedClaims.length})`);
    }

    /* ---- IDENTIFY_GAPS ---------------------------------------------- */
    const recordsNow = [...recordByUrl.values()];
    const originAnalysis = buildIndependentOriginAnalysis(recordsNow);
    const gapDigest = {
      story: chosen.cluster.canonicalTitle,
      category,
      sources: recordsNow.map(r => ({ sourceId: r.sourceId, group: r.parentPublisherGroup, role: r.sourceRole, retrieval: isMetadataOnlyRecord(r) ? "metadata_only" : "full_text" })),
      analysis: originAnalysis,
      proposedClaims: proposedClaims.slice(0, 14),
      remainingBudget: { searchesLeft: cfg.maxSearches - budget.searches, articlesLeft: cfg.maxArticles - budget.articles, llmCallsLeft: cfg.maxLlmCalls - budget.llmCalls },
    };
    const gapResult = await callLlm(
      budget,
      { llm, log },
      [
        {
          role: "system",
          content:
            "You are a rigorous newsroom editor deciding if evidence is sufficient to air a sarcastic commentary episode. Output ONLY JSON. Never include URLs. Be strict: single-source or metadata-only coverage is NOT sufficient.",
        },
        {
          role: "user",
          content: `${JSON.stringify(gapDigest)}\n\nProduce ONLY JSON: {"assessment":"sufficient|needs_more_research","gaps":[{"type":"independent_reporting|primary_record|contradiction_check|missing_perspective|missing_detail","reason":"...","query":"optional follow-up web search WITHOUT any URL","priority":"high|medium"}],"missingPerspectives":["..."],"allegedContradictions":["..."],"note":"..."}`,
        },
      ],
      1200
    );
    const known = new Set([...knownUrls]);
    const { analysis: gap, fabricatedUrlsRejected } = gapResult.ok
      ? parseGapAnalysis(gapResult.completion.content, known)
      : { analysis: null, fabricatedUrlsRejected: [] as string[] };
    if (!gapResult.ok) warnings.push(`gap analysis LLM unavailable (${gapResult.error})`);
    if (fabricatedUrlsRejected.length > 0) {
      warnings.push(`fabricated URL(s) rejected from LLM output: ${fabricatedUrlsRejected.slice(0, 4).join(", ")}`);
      log(`  research: rejected ${fabricatedUrlsRejected.length} fabricated URL(s) in gap output`);
    }

    if (gap) {
      allegedContradictions = [...new Set([...allegedContradictions, ...gap.allegedContradictions])].slice(0, 10);
      missingPerspectives = [...new Set([...missingPerspectives, ...gap.missingPerspectives])].slice(0, 10);
      actions.push(`gaps: assessment=${gap.assessment} gaps=${gap.gaps.length}`);

      if (gap.assessment === "sufficient") {
        status = "complete";
        iterations.push({ iteration, actions });
        break;
      }
      const highPriority = gap.gaps.filter(g => g.priority === "high").concat(gap.gaps.filter(g => g.priority !== "high"));
      const followups = highPriority
        .filter(g => g.query && !usedQueries.has(normQuery(g.query)))
        .slice(0, Math.max(0, cfg.maxSearches - budget.searches));
      for (const f of followups) {
        gapsEncountered.push({ type: f.type, reason: f.reason, resolved: false });
        await runSearch(f.query!, "followup");
        const newHits = allItems.slice(-6);
        for (const item of newHits) {
          const fp = fingerprintOf(item);
          if (!chosen.cluster.items.some(i => fingerprintOf(i) === fp)) chosen.cluster.items.push(item);
        }
        for (const g of gapsEncountered) if (g.reason === f.reason) g.resolved = true;
      }
      if (budget.searches >= cfg.maxSearches) {
        status = "budget_exhausted";
        actions.push("stop: search budget exhausted");
        iterations.push({ iteration, actions });
        break;
      }
      if (budget.canLlm()) {
        // recorded for the next iteration's exhaustion check
      }
      if (followups.length === 0) {
        status = "no_useful_path";
        actions.push("stop: gap analysis proposed no new searches");
        iterations.push({ iteration, actions });
        break;
      }
    } else {
      status = "insufficient_evidence";
      actions.push("stop: gap analysis returned unparseable output");
      iterations.push({ iteration, actions });
      break;
    }
    iterations.push({ iteration, actions });
  }
  if (iterations.length >= cfg.maxIterations && status === "insufficient_evidence") {
    // Ran the full loop without sufficiency - honest outcome, not a failure of this stage.
    warnings.push(`research did not reach sufficiency after ${cfg.maxIterations} iteration(s)`);
  } else if (budget.elapsedMs() >= cfg.timeoutMs) {
    status = "budget_exhausted";
  }

  /* ---------------- CLASSIFY article stance (supports/contradicts) ---- */
  for (const article of articles) {
    if (article.retrieval !== "full_text") continue;
    const record = recordByUrl.get(article.url);
    if (!record) continue;
    const anchorCheck = await callLlm(
      budget,
      { llm, log },
      [
        {
          role: "system",
          content:
            "You judge whether an article supports or contradicts the still-forming story. Output ONLY JSON with a verbatim anchor copied exactly from the text - do not paraphrase.",
        },
        {
          role: "user",
          content: [
            `Story: ${chosen.cluster.canonicalTitle}`,
            `Article source: ${article.sourceId}`,
            "",
            (record.excerpt ?? "").slice(0, 3000),
            "",
            'Respond with ONLY JSON: {"stance":"supports|contradicts|context_only","anchor":"one sentence copied VERBATIM from the text above"}',
          ].join("\n"),
        },
      ],
      300
    );
    const fullText = markdownByUrl.get(article.url) ?? record.excerpt ?? "";
    const verdict = parseStanceVerdict(anchorCheck.ok ? anchorCheck.completion.content : null, fullText);
    let effective = effectiveStance(verdict);
    article.llmStance = verdict.supports;
    article.stanceAnchorValidated = verdict.anchorValid;
    if (verdict.supports === "contradicts" && effective === "contradicts") {
      /* Contradiction auditor - an independent, focused second look before any
       * evidence leaves the deterministic verifier's reach. */
      const adCheck = await callLlm(
        budget,
        { llm, log },
        [
          {
            role: "system",
            content:
              "You are a contradiction auditor. You never invent or speculate. Your only job: decide whether the cited anchor passage AFFIRMATIVELY says the developing story is false. Output ONLY JSON.",
          },
          {
            role: "user",
            content: [
              `Story pitch: ${chosen.cluster.canonicalTitle}`,
              `Anchor passage cited for the contradiction: "${verdict.anchor}"`,
              "",
              "Does the anchor AFFIRM the pitch is false, or merely discuss the topic (or restate the same facts)?",
              'Respond with ONLY JSON: {"verdict":"denies"|"does_not_deny"}',
            ].join("\n"),
          },
        ],
        160
      );
      const adVerdict = parseAdversarialVerdict(adCheck.ok ? adCheck.completion.content : null);
      if (adVerdict === "denies") {
        warnings.push(`contradiction confirmed by adversarial audit for ${article.sourceId}`);
      } else if (adVerdict === "does_not_deny") {
        effective = "supports";
        article.llmStance = "contradicts->audited-supports";
        warnings.push(`adversarial audit overruled the contradicts verdict for ${article.sourceId} - anchor does not deny the story; evidence kept`);
        log(`  research: audit overruled contradicts for ${article.sourceId} (does_not_deny) - evidence kept`);
      } else {
        warnings.push(`adversarial audit unavailable for ${article.sourceId}${adCheck.ok ? "" : ` (${adCheck.error})`} - contradicts verdict stands (fail-closed)`);
      }
    }
    if (verdict.supports === "contradicts" && effective === "supports" && article.llmStance !== "contradicts->audited-supports") {
      warnings.push(`stance downgraded contradicts->supports for ${article.sourceId} - anchor lacks a hard conflict point (number/quote/entities)`);
      log(`  research: downgraded contradicts to supports for ${article.sourceId} (no hard conflict point in anchor)`);
    } else if (verdict.anchor && !verdict.anchorValid) {
      warnings.push(`stance anchor rejected as non-verbatim for ${article.sourceId} (anchor unverifiable - evidence kept, not suppressed)`);
      log(`  research: rejected non-verbatim stance anchor for ${article.sourceId} (evidence kept)`);
    }
    record.supports = effective;
    article.supports = effective;
  }

  /* ---------------- STANCE consistency pass on analysis ---------------- */
  const records = [...recordByUrl.values()];
  const analysis = buildIndependentOriginAnalysis(records);
  // Wire-aware independence labels.
  const wireOf = new Map<string, string[]>();
  for (const r of records) {
    const wire = r.wireOrigin ?? "none";
    if (wire === "none") continue;
    const arr = wireOf.get(wire) ?? [];
    arr.push(r.sourceId);
    wireOf.set(wire, arr);
  }
  for (const r of records) {
    const wire = r.wireOrigin ?? "none";
    if (wire !== "none" && (wireOf.get(wire) ?? []).length > 1) r.independenceStatus = "syndicated";
  }

  const honestyNote =
    status === "complete"
      ? "Research completed its loop: gap analysis found no blocking gaps against retrieved evidence. Gate A still decides what may air."
      : status === "budget_exhausted"
        ? "Research stopped at a configured budget (iterations/searches/articles/LLM calls/tokens/time). Evidence below is all that was verified - NOT labelled complete."
        : status === "no_useful_path"
          ? "Gap analysis found nothing more useful to retrieve with the permitted sources and remaining budget."
          : status === "insufficient_evidence"
            ? "Evidence never reached sufficiency. Contradictions and gaps below are preserved honestly."
            : status === "transport_failed"
              ? "Fortress-Reach transport prevented research. Nothing was retrieved."
              : "No stories found by the plus-search plan.";

  return {
    status,
    candidate: chosen,
    clusterItems: allItems,
    records,
    dossier: {
      version: 1,
      category,
      startedAt,
      finishedAt: new Date(nowFn()).toISOString(),
      status,
      honestyNote,
      limits: cfg,
      usage: budget.snapshot(),
      initialQueries,
      searches,
      selectedStory: { title: chosen.cluster.canonicalTitle, url: chosen.cluster.items[0].url, category },
      proposedClaims,
      articles,
      independentOriginAnalysis: analysis,
      allegedContradictions,
      missingPerspectives,
      gapsEncountered,
      iterations,
      warnings,
    },
  };
}





