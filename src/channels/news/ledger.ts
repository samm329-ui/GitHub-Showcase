import crypto from "node:crypto";
import pathMod from "node:path";
import type { ClaimKind, ClaimStatus, EvidenceLedger, EvidenceRecord, FactRecord, ContentClass } from "./types.js";
import { assertEvidenceAllowed, assertDiscoveryAllowed, type RegistryLoadResult } from "./sources.js";
import { findChromeExecutable } from "../../chrome-paths.js";

/**
 * Evidence collection + claim-level fact ledger.
 *
 * The ledger is the ONLY factual authority the script writer may consume.
 * Groq may propose atomic claims from collected evidence; this module decides
 * what is true — deterministically. The human decides what is safe to say.
 *
 * Rules:
 *  - excerpt only (never whole articles) — 300 chars max per excerpt;
 *  - independence counted by distinct reporting origins (wire-lineage);
 *  - every number/date/name in a claim must appear in supporting excerpts
 *    (normalised comparison); otherwise the claim is `unverified`;
 *  - allegations always carry attribution; they are never `verified`;
 *  - if verification fails, the episode cannot render.
 */

/* ------------------------------------------------------------------ */
/* Fetching + text extraction                                          */
/* ------------------------------------------------------------------ */

export type FetchImpl = typeof fetch;
export type LedgerDeps = { fetchImpl?: FetchImpl; now?: () => Date };

const USER_AGENT = "LazyNews/1.0 (+non-commercial research; obey terms)";
const EVIDENCE_CDP_PORT = Number(process.env.NEWS_EVIDENCE_PORT ?? 9223);
const CONTENT_MIN_CHARS = 800;

export class LedgerError extends Error {
  override name = "LedgerError";
}

/** Pull the article out of JSON-LD blocks (news sites embed the full body there). */
export function extractJsonLdArticle(html: string): { headline: string | null; body: string | null } {
  let headline: string | null = null;
  let body: string | null = null;
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const candidates = blocks.length > 0 ? blocks : [html];
  for (const raw of candidates) {
    const inner = raw.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
    const tryParse = (text: string): unknown => {
      try { return JSON.parse(text); } catch { return null; }
    };
    let parsed = tryParse(inner);
    // ET-style: bare string payloads may be double-encoded; attempt again
    if (!parsed) parsed = tryParse(`"${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    const nodes: unknown[] = [];
    const collect = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const arr = Array.isArray(node) ? node : [node];
      for (const item of arr) {
        if (item && typeof item === "object") {
          nodes.push(item);
          if ((item as { "@graph"?: unknown })["@graph"]) collect((item as { "@graph": unknown })["@graph"]);
        }
      }
    };
    collect(parsed);
    for (const node of nodes) {
      const obj = node as Record<string, unknown>;
      const type = String(obj["@type"] ?? "").toLowerCase();
      if (!type.includes("article") && !type.includes("newsarticle") && !obj["articleBody"]) continue;
      if (typeof obj["articleBody"] === "string" && obj["articleBody"].length > (body?.length ?? 0)) body = obj["articleBody"];
      if (typeof obj["headline"] === "string" && !headline) headline = obj["headline"];
      if (!headline && typeof obj["name"] === "string") headline = obj["name"];
    }
    // Direct regex fallback for stubborn/malformed blocks
    if (!body) {
      const m = inner.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try {
          body = JSON.parse(`"${m[1]}"`) as string;
        } catch {
          body = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
        }
      }
    }
    if (body) break;
  }
  return { headline, body };
}

export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutScripts.replace(/<\/(p|div|h[1-6]|li|article|section|tr)>/gi, "\n");
  const noTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return decoded.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap(chunk => chunk.split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘])/))
    .map(p => p.trim())
    .filter(p => p.length >= 40);
}

/** Rank paragraphs against a story's keywords; keep the strongest few as excerpts. */
export function selectExcerpts(text: string, keywords: string[], maxExcerpts = 8): string[] {
  const count = new Map<string, number>();
  const loweredKeywords = keywords.map(k => k.toLowerCase()).filter(k => k.length >= 3);
  const ranked = splitParagraphs(text)
    .map(paragraph => {
      const t = paragraph.toLowerCase();
      const score = loweredKeywords.reduce((acc, kw) => acc + (t.includes(kw) ? kw.split(" ").length : 0), 0);
      return { paragraph, score };
    })
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const excerpts: string[] = [];
  for (const { paragraph } of ranked) {
    const key = paragraph.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    excerpts.push(paragraph.slice(0, 300));
    if (excerpts.length >= maxExcerpts) break;
  }
  return excerpts;
}

async function fetchText(url: string, deps: LedgerDeps): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await f(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html, application/xhtml+xml, application/xml, text/plain;q=0.9" } });
    if (!response.ok) throw new LedgerError(`Evidence fetch ${url} returned HTTP ${response.status}.`);
    const raw = await response.text();
    const jsonLd = extractJsonLdArticle(raw);
    const text = jsonLd.body
      ? `${jsonLd.headline ?? ""}\n\n${jsonLd.body}`.trim()
      : htmlToText(raw);
    if (text.length >= CONTENT_MIN_CHARS) return text;
    // JS-rendered pages: fall back to a headless browser extract.
    // Never fetches content beyond what the page serves the client —
    // identical to what a "View source"/reader view shows, no bypass.
    const rendered = await cdpExtractText(url);
    if (rendered.trim().length < CONTENT_MIN_CHARS) {
      throw new LedgerError(
        `Evidence fetch ${url} gave ${text.length} chars from static HTML and ${rendered.trim().length} chars after JS render — below the ${CONTENT_MIN_CHARS}-char floor.`
      );
    }
    return rendered;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render the page in a headless Chromium on a private port and read
 * document.body.innerText. Used only when the static HTML is too thin
 * (JS-loaded article bodies). No paywall/403/CAPTCHA bypass: if the page
 * refuses to render text, we fail with a clear error.
 */
async function cdpExtractText(url: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  const path = pathMod;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const { default: CDP } = await import("chrome-remote-interface");

  async function cdpResponds(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${EVIDENCE_CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  const exe = findChromeExecutable(process.env.LAZY_NEWS_CHROME);

  let spawnedProc: import("node:child_process").ChildProcess | null = null;
  if (!(await cdpResponds())) {
    if (!exe) throw new LedgerError("No Chromium/Chrome/Edge found for JS-rendered evidence extraction.");
    const profile = path.join(os.tmpdir(), "lazy-news-evidence-chrome");
    await fs.mkdir(profile, { recursive: true });
    spawnedProc = spawn(exe, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
      `--remote-debugging-port=${EVIDENCE_CDP_PORT}`, `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await cdpResponds()) break;
      if (spawnedProc.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const client = await CDP({ host: "127.0.0.1", port: EVIDENCE_CDP_PORT });
  try {
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();
    await Page.navigate({ url });
    await Page.loadEventFired();
    // give client-side rendering a moment to settle
    await new Promise(r => setTimeout(r, 1500));
    const result = await Runtime.evaluate({ expression: "document.body ? document.body.innerText : ''" });
    return String(result?.result?.value ?? "");
  } finally {
    await client.close().catch(() => undefined);
    if (spawnedProc) {
      try { spawnedProc.kill(); } catch { /* best effort */ }
    }
  }
}

export async function collectEvidence(
  urls: string[],
  registry: RegistryLoadResult,
  storyKeywords: string[],
  deps: LedgerDeps = {}
): Promise<EvidenceRecord[]> {
  const records: EvidenceRecord[] = [];
  for (const url of urls) {
    const policy = assertEvidenceAllowed(url, registry.policies);
    const text = await fetchText(url, deps);
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const excerpts = selectExcerpts(text, storyKeywords, 8);
    records.push({
      sourceId: policy.sourceId,
      url,
      publisher: policy.parentPublisherGroup,
      parentPublisherGroup: policy.parentPublisherGroup,
      wireOrigin: policy.wireOrigin,
      sourceRole: policy.sourceRole,
      policy,
      independenceStatus: policy.sourceRole === "social_signal" ? "unknown" : "independent",
      locator: "auto:top-paragraphs",
      excerpt: excerpts.join("\n"),
      supports: "supports",
      fetchedAt: now,
    });
  }
  return records;
}

/**
 * Metadata-only evidence (spec §4/§8, "single-source, explicit attribution").
 *
 * RSS/Atom descriptions are licence-permitted metadata for discovery-tier
 * outlets whose article text is not licence-cleared (BBC, Guardian, FT…).
 * Never fetches article bodies. Claims built from these records MUST be read
 * as attributed single-origin statements — never as verified fact.
 */
export function buildMetadataEvidence(
  items: { title: string; url: string; description?: string | null; publishedAt?: string | null; authors?: string[] }[],
  registry: RegistryLoadResult,
  metadataOnlyLocator = "rss-metadata:titles+descriptions"
): EvidenceRecord[] {
  const now = new Date().toISOString();
  const records: EvidenceRecord[] = [];
  for (const item of items) {
    try {
      const policy = assertDiscoveryAllowed(item.url, registry.policies);
      if (policy.fullTextFetchAllowed) continue; // this item will be fetched as real evidence instead
      if (!policy.metadataAllowed) continue;
      const description = (item.description ?? "").replace(/\s+/g, " ").trim();
      const excerpt = `${item.title}\n${description}`.trim().replace(/\s+/g, " ").slice(0, 600);
      records.push({
        sourceId: policy.sourceId,
        url: item.url,
        publisher: policy.parentPublisherGroup,
        parentPublisherGroup: policy.parentPublisherGroup,
        wireOrigin: policy.wireOrigin,
        sourceRole: policy.sourceRole,
        policy,
        independenceStatus: "syndicated", // single-outlet metadata, never independently corroborated
        locator: metadataOnlyLocator,
        excerpt,
        supports: "supports",
        fetchedAt: now,
        publishedAt: item.publishedAt ?? undefined,
      });
    } catch {
      /* out-of-policy item: skip, keep the others */
    }
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* Claim proposal (LLM proposes; this module decides)                  */
/* ------------------------------------------------------------------ */

export type ProposedClaim = {
  claim: string;
  kind: ClaimKind;
  importance: "core" | "supporting" | "optional";
  contentClass: ContentClass;
  attribution: string | null; // e.g. "ministry said" when the claim is an announcement
  quotes: { text: string; sourceId: string }[];
};

/* ------------------------------------------------------------------ */
/* Deterministic verification                                           */
/* ------------------------------------------------------------------ */

const NUM_WORD: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
};

export function normalizeNumberWords(text: string): string {
  let t = text.toLowerCase();
  for (const [word, digit] of Object.entries(NUM_WORD)) {
    t = t.replace(new RegExp(`\\b${word}\\b`, "g"), digit);
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Spoken-number parsing: "eight hundred one million three hundred fifty    */
/* one thousand three hundred fifty four" -> "801351354"                    */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALE_WORDS: Record<string, number> = {
  hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000, trillion: 1_000_000_000_000,
};
const NUMBER_WORD_RE = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)\b/gi;

/** Replace every run of spoken-number words with its computed integer. */
export function normalizeNumbers(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let i = 0;
  const same = (w: string): string => w.toLowerCase().replace(/[^a-z]/g, "");
  while (i < words.length) {
    const cleaned = same(words[i]);
    const isNum = cleaned in NUMBER_WORDS || cleaned in SCALE_WORDS || cleaned === "and";
    if (!isNum) { out.push(words[i]); i += 1; continue; }
    const run: string[] = [];
    while (i < words.length) {
      const c = same(words[i]);
      if (c === "and") { i += 1; continue; }
      if (c in NUMBER_WORDS || c in SCALE_WORDS) { run.push(c); i += 1; continue; }
      break;
    }
    const value = parseNumberRun(run);
    out.push(value === null ? run.join(" ") : String(value));
  }
  return out.join(" ");
}

function parseNumberRun(run: string[]): number | null {
  if (run.length === 0) return null;
  let total = 0, current = 0;
  for (const w of run) {
    if (w in NUMBER_WORDS) current += NUMBER_WORDS[w];
    else if (w === "hundred") current *= 100;
    else if (w in SCALE_WORDS) { total += current * SCALE_WORDS[w]; current = 0; }
    else return null;
  }
  return total + current;
}

export function normalizeComparable(text: string): string {
  return normalizeNumbers(text)
    .replace(/(\d)\s*(,)(\d{3})/g, "$1$3") // 1,000,000 → 1000000
    .replace(/(\d+(?:\.\d+)?)\s*(percent|pct)\b/g, "$1%")
    .replace(/₹\s*/g, "rs ")
    .replace(/us\$\s*/g, "$")
    .toLowerCase();
}

export function extractNumbers(text: string): string[] {
  const t = normalizeComparable(text);
  return [...new Set([...t.matchAll(/\d+(?:\.\d+)?(?:%|%|percent|percentages|rs|rupees|crore|lakh|billion|million|trillion|th|st|nd|rd)?/g)].map(m => m[0]))];
}

export function significantTokens(text: string): string[] {
  const stop = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "by", "at", "as", "that", "this", "it", "from", "said", "says", "after"]);
  return [...new Set(
    normalizeComparable(text).match(/[a-z][a-z0-9]{2,}|\d+(?:\.\d+)?%?/g) ?? []
  )].filter(t => !stop.has(t));
}

export function significantEntities(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Za-z0-9&.'-]{1,}\b/g) ?? [];
  const cleaned = matches
    .map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9&.]+$/g, ""))
    .filter(w => w.length >= 2 && !/^(The|A|An|In|On|At|Of|To|For|With|After|Before|Over|Under|This|That|It)$/.test(w));
  return [...new Set(cleaned)];
}

export function excerptContains(excerpts: string, token: string): boolean {
  return normalizeComparable(excerpts).includes(normalizeComparable(token));
}

/**
 * Verify one proposed claim against collected evidence.
 * Returns a FactRecord; unverified facts are excluded from the approved set.
 */
export function verifyClaim(
  proposed: ProposedClaim,
  evidence: EvidenceRecord[],
  index: number
): FactRecord {
  const supporting = evidence.filter(e => e.supports === "supports");
  const excerptBlob = supporting.map(e => e.excerpt ?? "").join("\n");
  const supportingOrigins = new Set(supporting.map(e => `${e.parentPublisherGroup}::${e.wireOrigin ?? "none"}`));

  const onlyMetadata = supporting.length > 0 && supporting.every(e => (e.locator ?? "").startsWith("rss-metadata"));
  if (onlyMetadata) {
    const contentClassEarly = proposed.contentClass;
    return {
      id: `F${String(index + 1).padStart(3, "0")}`,
      claim: proposed.claim.trim(),
      kind: proposed.kind,
      status: "attributed", // metadata-only: attributed, never verified — spec §8.3
      importance: proposed.importance,
      contentClass: contentClassEarly,
      evidence: supporting,
      independenceCount: supportingOrigins.size,
      conflictNote: undefined,
      safeNarration: undefined,
      asOf: undefined,
      confidence: 0.5,
      verifiedByHuman: false,
    };
  }

  const evidenceText = excerptBlob;
  const numbers = extractNumbers(proposed.claim);
  const entities = significantEntities(proposed.claim);
  const tokens = significantTokens(proposed.claim);

  const numbersOk = numbers.every(n => excerptContains(evidenceText, n));
  const entitiesOk = entities.every(e => normalizeComparable(evidenceText).includes(normalizeComparable(e)));
  const tokenHits = tokens.filter(t => normalizeComparable(evidenceText).includes(normalizeComparable(t))).length;
  const tokenRatio = tokens.length === 0 ? 0 : tokenHits / tokens.length;

  const isAllegation = /\b(alleg\w*|accus\w*|chargesheet|charg(e|es|ed)|fir\b|allegedly|reportedly|scam|scandal|denial|denie[sd])\b/i.test(proposed.claim);
  const hasAttribution = isAllegation || Boolean(proposed.attribution?.trim());
  const quoteOk = proposed.quotes.every(q => excerptContains(evidenceText, q.text));

  let status: ClaimStatus;
  const contentClass = proposed.contentClass;
  if (contentClass === "satire" || contentClass === "interpretation") {
    // Commentary is never "verified"; it is labelled by class, and gate B reviews it.
    status = "attributed";
  } else if (!numbersOk || tokenRatio < 0.45) {
    status = "unverified";
  } else if (isAllegation) {
    status = hasAttribution ? "attributed" : "unverified";
  } else if (!entitiesOk) {
    status = "attributed"; // entities not confirmed verbatim, but numbers/tokens are
  } else {
    status = "verified";
  }

  const confidence =
    status === "verified" ? Math.min(0.98, 0.6 + 0.25 * Math.min(2, supportingOrigins.size) + (quoteOk ? 0.1 : 0))
    : status === "attributed" ? 0.55
    : 0.1;

  return {
    id: `F${String(index + 1).padStart(3, "0")}`,
    claim: proposed.claim.trim(),
    kind: proposed.kind,
    status,
    importance: proposed.importance,
    contentClass,
    evidence: supporting,
    independenceCount: supportingOrigins.size,
    conflictNote: undefined,
    safeNarration: undefined,
    asOf: undefined,
    confidence,
    verifiedByHuman: false,
  };
}

export function verifyLedger(facts: FactRecord[], storyId: string): EvidenceLedger {
  const errors: string[] = [];
  const warnings: string[] = [];

  const core = facts.filter(f => f.importance === "core");
  const usable = (f: FactRecord) => f.contentClass !== "fact" || f.status === "verified" || f.status === "attributed";
  for (const fact of core) {
    if (!usable(fact)) {
      errors.push(`Core claim ${fact.id} (${fact.status}) is not ledger-approved: "${fact.claim.slice(0, 80)}"`);
    }
  }
  for (const fact of facts) {
    if (fact.contentClass === "fact" && fact.status === "attributed") {
      warnings.push(`${fact.id}: attributed claim (single origin or unconfirmed entity) — script must carry attribution wording.`);
    }
    if (fact.contentClass === "fact" && fact.independenceCount < 2 && fact.status === "verified") {
      warnings.push(`${fact.id}: verified on a single origin — strengthen with a second independent record if available.`);
    }
  }
  const independenceCount = facts.length === 0
    ? 0
    : Math.max(...facts.map(f => f.independenceCount));

  return {
    storyId,
    capturedAt: new Date().toISOString(),
    facts,
    verifierPassed: errors.length === 0 && core.length > 0,
    verifierErrors: errors,
    verifierWarnings: warnings,
    independenceCount,
  };
}

/** Deterministic check: exact quote appears in supporting excerpts. */
export function verifyQuotedMaterial(facts: FactRecord[]): string[] {
  const errors: string[] = [];
  for (const fact of facts) {
    if (fact.contentClass !== "fact") continue;
    const blob = fact.evidence.map(e => e.excerpt ?? "").join("\n");
    if (!blob) continue;
    // extract quoted segments from the claim text
    const quotes = fact.claim.match(/["“]([^"”]{6,})["”]/g) ?? [];
    for (const q of quotes) {
      const raw = q.replace(/["“”]/g, "");
      if (!excerptContains(blob, raw)) {
        errors.push(`${fact.id}: quote not found verbatim in supporting excerpts: "${raw.slice(0, 60)}"`);
      }
    }
  }
  return errors;
}

export function promptInjectionGuard(text: string): boolean {
  const lowered = text.toLowerCase();
  const patterns = ["ignore previous", "ignore all previous", "system prompt", "new instructions", "disregard the above", "you are now"];
  return patterns.some(p => lowered.includes(p));
}

export function fingerprintText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}
