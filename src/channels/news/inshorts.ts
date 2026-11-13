/**
 * Inshorts lane — discovery AND evidence in one place.
 *
 * Owner decision (2026-11-13): the Lazy News channel discovers through the
 * Inshorts card feed exclusively (was: Fortress-Reach). This module performs
 * the same wire protocol the retired vamgan/Inshorts-News-API Flask scraper
 * did, reimplemented natively — no Python runtime, no HTML regex fragility
 * beyond one hydration blob:
 *
 *   GET https://www.inshorts.com/en/read/{category}   (browser UA required)
 *   → HTML page with `window.__STATE__ = {...}` hydration blob
 *   → news_list.list[] where each entry holds a news_obj with
 *     title, content, author_name, source_name, source_url,
 *     image_url, created_at (epoch ms), category_names, bottom_headline
 *
 * Hard rules:
 *  - challenge/forbidden/captcha response = HARD STOP (we never bypass; the
 *    run stops and says so);
 *  - nothing enters the pipeline unless inshorts.com is registered with
 *    `enabled: true` in the registry (same fail-closed contract as before);
 *  - stories cite the ORIGINAL outlet when Inshorts embeds it
 *    (source_name/source_url) — never "Inshorts says" as if Inshorts wrote the
 *    original report;
 *  - the 60-word card is editorial Inshorts text: scripts paraphrase, never
 *    dump verbatim; the registry marks terms review as `unknown`.
 */
import crypto from "node:crypto";
import type { DiscoveredItem, SourcePolicy } from "./types.js";
import { assertDiscoveryAllowed, type RegistryLoadResult } from "./sources.js";

export class InshortsError extends Error {
  override name = "InshortsError";
}

const BASE = "https://www.inshorts.com/en/read/";
const TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Maps our editorial categories onto inshorts.com paths (`""` = mixed top feed). */
export const INSHORTS_CATEGORIES: Record<string, string> = {
  politics: "politics",
  national: "national",
  geopolitics: "world",
  ai: "technology",
  technology: "technology",
  finance: "business",
  environment: "science",
  under_covered: "miscellaneous",
  mixed: "",
};

const INSHORTS_SLUGS = [
  "", "national", "business", "sports", "world", "politics", "technology",
  "startup", "entertainment", "miscellaneous", "hatke", "science", "automobile",
];

export function isInshortsCategory(value: string): boolean {
  return INSHORTS_SLUGS.includes(value);
}

/* Challenge markers — a CAPTCHA or block page is a hard stop, never a workaround. */
const HARD_STOP_MARKERS = [
  /just a moment/i, /checking your browser/i, /cf-chl/i, /captcha/i,
  /are you a human/i, /access denied/i, /unusual traffic/i, /403 forbidden/i,
  /enable javascript/i,
];

export type InshortsCard = {
  title: string;
  /** The ~60-word editorial Inshorts summary (NOT to be republished verbatim). */
  content: string;
  author: string | null;
  imageUrl: string | null;
  url: string;
  /** Inshorts' own attribution to the underlying outlet. */
  sourceName: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  bottomHeadline: string | null;
  categoryNames: string[];
  /** Inshorts' internal importance score (their ranking signal, not ours). */
  score: number | null;
};

const stripTags = (s: string): string =>
  s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** Extract news_list.list[] from the page's `window.__STATE__` blob. */
export function parseInshortsState(html: string): InshortsCard[] {
  const match = html.match(/window\.__STATE__\s*=\s*([\s\S]+?)<\/script>/);
  if (!match) return [];
  let state: unknown;
  try {
    state = JSON.parse(match[1].replace(/;\s*$/, ""));
  } catch {
    return [];
  }
  const list = (state as { news_list?: { list?: unknown[] } })?.news_list?.list;
  if (!Array.isArray(list)) return [];

  const cards: InshortsCard[] = [];
  for (const entry of list) {
    const obj = (entry as { news_obj?: Record<string, unknown> })?.news_obj;
    const type = String((entry as { news_type?: string })?.news_type ?? "NEWS");
    if (!obj || type !== "NEWS") continue;
    const content = stripTags(String(obj.content ?? ""));
    const title = stripTags(String(obj.title ?? ""));
    if (!content || content.length < 40 || !title) continue;
    const created = Number(obj.created_at);
    const createdIso = Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null;
    cards.push({
      title,
      content,
      author: typeof obj.author_name === "string" && obj.author_name.trim() ? obj.author_name.trim() : null,
      imageUrl: typeof obj.image_url === "string" ? obj.image_url : null,
      url: `https://www.inshorts.com/en/news/${String(obj.old_hash_id ?? obj.hash_id ?? "")}`,
      sourceName: typeof obj.source_name === "string" && obj.source_name.trim() ? obj.source_name.trim() : null,
      sourceUrl: typeof obj.source_url === "string" && obj.source_url.trim() ? obj.source_url : null,
      publishedAt: createdIso,
      bottomHeadline: typeof obj.bottom_headline === "string" ? obj.bottom_headline.trim() : null,
      categoryNames: Array.isArray(obj.category_names) ? obj.category_names.map(String) : [],
      score: typeof obj.impressive_score === "number" ? obj.impressive_score : null,
    });
  }
  return cards;
}

/** Fetch + parse one category page; fail closed on any challenge or non-JSON body. */
export async function fetchInshortsCategory(
  inshortsPath: string,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {}
): Promise<InshortsCard[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${BASE}${inshortsPath}`, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new InshortsError(`inshorts.com read/${inshortsPath} returned HTTP ${response.status} — refusing to work around it.`);
  }
  const html = await response.text();
  for (const marker of HARD_STOP_MARKERS) {
    if (marker.test(html)) {
      throw new InshortsError(`hard stop: read/${inshortsPath} looks like a challenge/block page. Not bypassing — skipping this category.`);
    }
  }
  return parseInshortsState(html);
}

const fingerprintCard = (card: InshortsCard): string =>
  crypto.createHash("sha1").update(`inshorts::${card.url}`).digest("hex");

/**
 * Convert cards → DiscoveredItems bound to the registry. Items must be
 * registry-approved for the inshorts.com outlet or they are dropped.
 */
export function cardsToItems(
  cards: InshortsCard[],
  registry: RegistryLoadResult,
  now: Date = new Date()
): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  for (const card of cards) {
    let policy: SourcePolicy;
    try {
      policy = assertDiscoveryAllowed(card.url, registry.policies);
    } catch {
      continue; // never emit an item for an unregistered outlet
    }
    const description = card.bottomHeadline
      ? `${card.content}\n${card.bottomHeadline}`
      : card.content;
    items.push({
      id: fingerprintCard(card),
      title: card.title,
      url: card.url,
      sourceId: policy.sourceId,
      sourceName: policy.sourceId,
      sourcePolicy: policy,
      publishedAt: card.publishedAt,
      eventDate: null,
      description,
      authors: card.author ? [card.author] : undefined,
      language: "en",
      fetchedAt: now.toISOString(),
      fingerprint: fingerprintCard(card),
      matchedQuery: `inshorts:${card.categoryNames[0] ?? "top"}`,
    });
  }
  return items;
}

/** Category discovery for the registered inshorts lane. Throws InshortsError on hard stops. */
export async function discoverInshorts(
  category: string,
  registry: RegistryLoadResult,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {}
): Promise<DiscoveredItem[]> {
  const path = INSHORTS_CATEGORIES[category] ?? (isInshortsCategory(category) ? category : "");
  const cards = await fetchInshortsCategory(path, deps);
  return cardsToItems(cards, registry, deps.now?.() ?? new Date());
}

/** Pull the ~60-word editorial summary for a registered item (excerpt == evidence). */
export function cardEvidenceExcerpt(item: DiscoveredItem): string {
  return (item.description ?? item.title).slice(0, 600);
}

/* ------------------------------------------------------------------ */
/* Evidence � the card IS the evidence (60-word summary by design)    */
/* ------------------------------------------------------------------ */

/**
 * Build EvidenceRecords for inshorts cards. The 60-word editorial card is the
 * complete evidence ceiling for this lane: no underlying outlet is fetched,
 * ever. Numbers/dates/quotes in claims verify only against this text.
 */
export function buildInshortsEvidence(
  items: DiscoveredItem[],
  now: () => Date = () => new Date()
): import("./types.js").EvidenceRecord[] {
  const records: import("./types.js").EvidenceRecord[] = [];
  for (const item of items) {
    const policy = item.sourcePolicy;
    records.push({
      sourceId: policy.sourceId,
      url: item.url,
      publisher: policy.parentPublisherGroup,
      parentPublisherGroup: policy.parentPublisherGroup,
      wireOrigin: policy.wireOrigin,
      sourceRole: policy.sourceRole,
      policy,
      independenceStatus: "independent",
      publishedAt: item.publishedAt ?? undefined,
      locator: `inshorts:card60w:${policy.sourceId}`,
      excerpt: cardEvidenceExcerpt(item),
      supports: "supports",
      fetchedAt: now().toISOString(),
    });
  }
  return records;
}
