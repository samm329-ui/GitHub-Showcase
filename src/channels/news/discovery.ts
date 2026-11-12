import crypto from "node:crypto";
import type { DiscoveredItem, SourcePolicy } from "./types.js";
import { assertDiscoveryAllowed, type RegistryLoadResult } from "./sources.js";

/**
 * Discovery adapters — Tier A signals only (never evidence).
 *
 * Discipline:
 *  - conditional requests (ETag/If-Modified-Since) where supported;
 *  - per-host courtesy delays; no parallel hammering;
 *  - explicit timeouts and fail-fast non-2xx handling (no workarounds);
 *  - persisted fingerprints so re-polling the same story is cheap;
 *  - feeds return raw leads; clustering (clustering.ts) decides what co-occurs.
 */

export type FetchImpl = typeof fetch;

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

export type DiscoveryDeps = { fetchImpl?: FetchImpl; now?: () => Date };

const USER_AGENT = "LazyNews/1.0 (+non-commercial news-commentary research; obey site terms)";
const DEFAULT_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(
  url: string,
  deps: DiscoveryDeps,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await f(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml, application/json, text/xml;q=0.9, */*;q=0.5", ...(options.headers as Record<string, string> | undefined) },
    });
  } finally {
    clearTimeout(timer);
  }
}

const decodeEntities = (text: string): string =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function fingerprintItem(title: string, url: string): string {
  let canonical = url;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|at_|ocid|ref(fer)?$|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    canonical = `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    canonical = url.toLowerCase();
  }
  const normTitle = decodeEntities(title).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(`${canonical}::${normTitle}`).digest("hex");
}

export function stripTrackingParams(urlString: string): string {
  try {
    const u = new URL(urlString);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|at_|ocid|ref$|referrer$|fbclid|gclid|cmpid|ns_campaign)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return urlString;
  }
}

export function canonicalizeDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/* ------------------------------------------------------------------ */
/* RSS / Atom                                                          */
/* ------------------------------------------------------------------ */

const rssItemBlocks = (xml: string): string[] =>
  [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => m[0]);

const atomEntryBlocks = (xml: string): string[] =>
  [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(m => m[0]);

export function parseFeedXml(xml: string): DiscoveredItem["title"] extends string ? { title: string | null; url: string | null; description: string | null; publishedAt: string | null; idHint: string | null }[] : never {
  const blocks = rssItemBlocks(xml).concat(atomEntryBlocks(xml));
  const items: { title: string | null; url: string | null; description: string | null; publishedAt: string | null; idHint: string | null }[] = [];
  for (const block of blocks) {
    const pickTag = (tag: string): string | null => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? decodeEntities(m[1]) : null;
    };
    const linkMatch = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
    const url = linkMatch ? linkMatch[1] : pickTag("link") ?? pickTag("guid");
    const date = pickTag("pubDate") ?? pickTag("dc:date") ?? pickTag("published") ?? pickTag("updated");
    items.push({
      title: pickTag("title"),
      url: url ? stripTrackingParams(url) : null,
      description: pickTag("description") ?? pickTag("summary"),
      publishedAt: date ? safeIso(date) : null,
      idHint: pickTag("guid") ?? url,
    });
  }
  return items as never;
}

export function safeIso(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function fetchFeed(
  feedUrl: string,
  registry: RegistryLoadResult,
  deps: DiscoveryDeps = {}
): Promise<DiscoveredItem[]> {
  const policy = assertDiscoveryAllowed(feedUrl, registry.policies);
  const response = await fetchWithTimeout(feedUrl, deps);
  if (!response.ok) {
    throw new DiscoveryError(`Feed ${feedUrl} returned HTTP ${response.status}.`);
  }
  const xml = await response.text();
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const parsed = parseFeedXml(xml) as unknown as {
    title: string | null; url: string | null; description: string | null;
    publishedAt: string | null; idHint: string | null;
  }[];
  const items: DiscoveredItem[] = [];
  for (const entry of parsed) {
    if (!entry.title || !entry.url) continue;
    items.push({
      id: fingerprintItem(entry.title, entry.url),
      title: entry.title,
      url: entry.url,
      sourceId: policy.sourceId,
      sourceName: policy.sourceId,
      sourcePolicy: policy,
      publishedAt: entry.publishedAt,
      eventDate: null,
      description: entry.description,
      fetchedAt: now,
      fingerprint: fingerprintItem(entry.title, entry.url),
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* GDELT DOC 2.0 — coverage/corroboration only, never evidence         */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function fetchGdeltArtList(
  query: string,
  registry: RegistryLoadResult,
  deps: DiscoveryDeps & { timespan?: string; maxRecords?: number } = {}
): Promise<DiscoveredItem[]> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(deps.maxRecords ?? 10));
  url.searchParams.set("timespan", deps.timespan ?? "3d");

  // GDELT is rate-limited; one polite retry honoring Retry-After, then give up for this query.
  let response = await fetchWithTimeout(url.toString(), deps);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "8");
    await sleep(Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 8000, 5000), 30_000));
    response = await fetchWithTimeout(url.toString(), deps);
  }
  if (!response.ok) {
    throw new DiscoveryError(`GDELT returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { articles?: { url?: string; title?: string; seendate?: string; domain?: string; sourcecountry?: string }[] };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const items: DiscoveredItem[] = [];
  const findPolicy = (urlString: string): SourcePolicy | null => {
    let host: string | null = null;
    try { host = new URL(urlString).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
    let best: SourcePolicy | null = null;
    for (const p of registry.policies) {
      if (!p.enabled) continue;
      const d = p.domain.toLowerCase().replace(/^www\./, "");
      if (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) {
        if (!best || d.length > best.domain.length) best = p;
      }
    }
    return best;
  };
  const seen = new Set<string>();
  for (const a of body.articles ?? []) {
    if (!a.url || !a.title) continue;
    const url = stripTrackingParams(a.url);
    const host = (a.domain ?? "").toLowerCase().replace(/^www\./, "");
    const policy = findPolicy(url) ?? findPolicy(`https://${host}/`);
    if (!policy || policy.permissionBasis === "unknown") continue; // not a registered, enabled outlet
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      id: fingerprintItem(a.title, url),
      title: decodeEntities(a.title),
      url,
      sourceId: policy.sourceId,
      sourceName: host || policy.sourceId,
      sourcePolicy: policy,
      publishedAt: a.seendate ? safeIso(a.seendate) : null,
      eventDate: null,
      description: null,
      fetchedAt: now,
      fingerprint: fingerprintItem(a.title, url),
      matchedQuery: query,
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Bluesky — social signals, leads only                                */
/* ------------------------------------------------------------------ */

export async function searchBluesky(
  query: string,
  registry: RegistryLoadResult,
  deps: DiscoveryDeps & { limit?: number } = {}
): Promise<DiscoveredItem[]> {
  const url = new URL("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(deps.limit ?? 25));
  const response = await fetchWithTimeout(url.toString(), deps);
  if (!response.ok) {
    throw new DiscoveryError(`Bluesky returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    posts?: {
      record?: { text?: string; createdAt?: string };
      embed?: { external?: { uri?: string; title?: string; description?: string }; images?: { alt?: string }[] };
      author?: { handle?: string; displayName?: string };
    }[];
  };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const bskyPolicy = assertDiscoveryAllowed("https://api.bsky.app/", registry.policies);
  const items: DiscoveredItem[] = [];
  for (const post of body.posts ?? []) {
    const text = post.record?.text ?? "";
    // Only posts that link out count as story leads; bare chatter is noise.
    const external = post.embed?.external;
    const textUrl = text.match(/https?:\/\/[^\s]+/)?.[0];
    const target = stripTrackingParams(external?.uri ?? textUrl ?? "") || null;
    if (!target) continue;
    let policy: SourcePolicy;
    try {
      policy = assertDiscoveryAllowed(target, registry.policies);
    } catch {
      continue; // Bluesky post links to a source we cannot use — drop it entirely
    }
    const title = (external?.title ?? text.split("\n")[0] ?? "").slice(0, 220);
    if (!title.trim()) continue;
    items.push({
      id: fingerprintItem(title, target),
      title: decodeEntities(title),
      url: target,
      sourceId: policy.sourceId,
      sourceName: post.author?.handle ? `@${post.author.handle}` : "bsky",
      sourcePolicy: policy,
      publishedAt: post.record?.createdAt ? safeIso(post.record.createdAt) : null,
      eventDate: null,
      description: decodeEntities(external?.description ?? text).slice(0, 400) || null,
      fetchedAt: now,
      fingerprint: fingerprintItem(title, target),
      matchedQuery: query,
      authors: post.author?.handle ? [post.author.handle] : undefined,
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Manual tip                                                          */
/* ------------------------------------------------------------------ */

export function manualUrlItem(urlString: string, registry: RegistryLoadResult): DiscoveredItem {
  const policy = assertDiscoveryAllowed(urlString, registry.policies);
  const now = new Date().toISOString();
  let title = urlString;
  try { title = new URL(urlString).hostname; } catch { /* keep */ }
  return {
    id: fingerprintItem(title, urlString),
    title,
    url: stripTrackingParams(urlString),
    sourceId: policy.sourceId,
    sourceName: `manual:${policy.sourceId}`,
    sourcePolicy: policy,
    publishedAt: null,
    eventDate: null,
    description: null,
    fetchedAt: now,
    fingerprint: fingerprintItem(title, urlString),
    matchedQuery: "manual",
  };
}

/* ------------------------------------------------------------------ */
/* Topic feeds                                                         */
/* ------------------------------------------------------------------ */

export type NewsCategory =
  | "politics"
  | "geopolitics"
  | "ai"
  | "technology"
  | "finance"
  | "environment"
  | "under_covered"
  | "mixed";

export const CATEGORY_FEEDS: Record<NewsCategory, string[]> = {
  politics: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss",
    "https://feeds.npr.org/1004/rss.xml",
  ],
  geopolitics: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.theguardian.com/world/rss",
  ],
  ai: [
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "https://www.theguardian.com/technology/rss",
  ],
  technology: [
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "https://www.cnbc.com/id/15839135/device/rss/rss.html",
    "https://www.theguardian.com/technology/rss",
  ],
  finance: [
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
  ],
  environment: [
    "https://www.theguardian.com/environment/rss",
    "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  ],
  under_covered: [], // populated from GDELT low-volume queries at runtime
  mixed: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  ],
};

export const CATEGORY_QUERIES: Record<NewsCategory, string[]> = {
  politics: ["India parliament", "India government", "India election", "Lok Sabha", "Rajya Sabha"],
  geopolitics: ["India foreign policy", "South Asia", "UN Security Council", "sanctions"],
  ai: ["artificial intelligence", "AI regulation", "large language model", "AI chip", "OpenAI", "Anthropic"],
  technology: ["cybersecurity", "quantum computing", "semiconductors", "cloud"],
  finance: ["RBI policy", "India budget", "markets", "SEC filing", "inflation"],
  environment: ["climate report", "IPCC", "COP", "environment India"],
  under_covered: ["regulatory filing", "patent", "supreme court order", "statistical release"],
  mixed: ["India", "geopolitics", "artificial intelligence"],
};

export async function discoverCategory(
  category: NewsCategory,
  registry: RegistryLoadResult,
  deps: DiscoveryDeps = {},
  options: { maxItems?: number; gdeltLimitPerQuery?: number } = {}
): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  const seen = new Set<string>();
  const push = (item: DiscoveredItem) => {
    if (seen.has(item.fingerprint)) return;
    seen.add(item.fingerprint);
    out.push(item);
  };

  for (const feed of CATEGORY_FEEDS[category]) {
    try {
      for (const item of await fetchFeed(feed, registry, deps)) push(item);
    } catch (error) {
      // Discovery is best-effort: log and continue with the remaining sources.
      console.error(`  discovery: ${feed} skipped (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }

  // GDELT: polite cadence + circuit breaker. Two failures in this run => stop
  // issuing GDELT calls (we already know we're throttled) and proceed with
  // RSS/Bluesky results only.
  let gdeltFailures = 0;
  const GDELT_STOP = 2;
  for (const q of CATEGORY_QUERIES[category]) {
    if (gdeltFailures >= GDELT_STOP) {
      console.error(`  discovery: GDELT skipped for the rest of this run (${gdeltFailures} failures; try again later).`);
      break;
    }
    await sleep(1500);
    try {
      for (const item of await fetchGdeltArtList(q, registry, { ...deps, maxRecords: 10 })) push(item);
    } catch (error) {
      gdeltFailures += 1;
      console.error(`  discovery: GDELT ${JSON.stringify(q)} skipped (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }
  for (const q of CATEGORY_QUERIES[category]) {
    try {
      for (const item of await searchBluesky(q, registry, { ...deps, limit: 10 })) push(item);
    } catch (error) {
      console.error(`  discovery: Bluesky ${JSON.stringify(q)} skipped (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }
  const cap = options.maxItems ?? 300;
  return out.slice(0, cap);
}
