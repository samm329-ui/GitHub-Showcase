import crypto from "node:crypto";
import type { DiscoveredItem } from "./types.js";
import { assertDiscoveryAllowed, type RegistryLoadResult } from "./sources.js";
import { fetchFortressHeadlines, fetchFortressSearch } from "./fortress-reach.js";

/**
 * Discovery — one lane, by owner decision: Fortress-Reach.
 *
 * No RSS/Atom feeds, no GDELT API, no Bluesky API, no direct fetch of any
 * kind. Every headline, link and snippet enters the pipeline through a
 * locally running Fortress-Reach MCP server (see fortress-reach.ts). When
 * REACH_MCP_URL is unset, discovery returns nothing and says so loudly —
 * it never silently falls back to an API or a direct request.
 *
 * Discipline (unchanged):
 *  - fail-fast, non-2xx handling is the caller's job — this module logs and
 *    skips; it never works around a refusal;
 *  - per-host courtesy delays; no parallel hammering;
 *  - discovery is Tier A signal only; clustering decides what co-occurs;
 *    nothing here is evidence.
 */

export type FetchImpl = typeof fetch;

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

export type DiscoveryDeps = { fetchImpl?: FetchImpl; now?: () => Date };

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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Topic feeds (search queries fed through the Fortress search lane)   */
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

/* Homepages the browser lane reads — only outlets whose front page answered
 * HTTP 200 with real HTML when probed (2026-11). The browser decides honesty;
 * this list decides coverage. Every perspective sits at the table:
 * centre-left to right-coded, Hindi mainstream via Google News-sourced leads,
 * Indian English and international. */
export const BROWSER_PAGES: Record<NewsCategory, string[]> = {
  politics: [
    "https://timesofindia.indiatimes.com",
    "https://www.hindustantimes.com",
    "https://indianexpress.com",
    "https://www.thehindu.com",
    "https://www.thequint.com",
    "https://swarajyamag.com",
    "https://www.foxnews.com",
    "https://nypost.com",
    "https://www.aljazeera.com",
  ],
  geopolitics: [
    "https://indianexpress.com",
    "https://www.aljazeera.com",
    "https://www.hindustantimes.com",
    "https://www.thehindu.com",
    "https://www.thequint.com",
    "https://timesofindia.indiatimes.com",
    "https://swarajyamag.com",
    "https://www.foxnews.com",
    "https://nypost.com",
  ],
  ai: [
    "https://blog.google/technology/ai/",
    "https://deepmind.google/blog/",
    "https://www.anthropic.com/news",
    "https://mistral.ai/news/",
  ],
  technology: [
    "https://blog.google/technology/ai/",
    "https://deepmind.google/blog/",
    "https://www.thehindu.com",
  ],
  finance: [
    "https://timesofindia.indiatimes.com",
    "https://www.hindustantimes.com",
    "https://indianexpress.com",
    "https://www.thehindu.com",
    "https://swarajyamag.com",
  ],
  environment: [
    "https://www.thehindu.com",
    "https://indianexpress.com",
  ],
  under_covered: [],
  mixed: [
    "https://timesofindia.indiatimes.com",
    "https://www.hindustantimes.com",
    "https://indianexpress.com",
    "https://www.thehindu.com",
    "https://www.thequint.com",
    "https://swarajyamag.com",
    "https://www.foxnews.com",
    "https://nypost.com",
    "https://www.aljazeera.com",
  ],
};

/* ------------------------------------------------------------------ */
/* Browser discovery (Fortress-Reach) — the ONLY discovery lane         */
/* ------------------------------------------------------------------ */

/**
 * Best-effort homepage + search harvest through a locally running
 * Fortress-Reach MCP server. Active only when REACH_MCP_URL is set
 * (e.g. http://127.0.0.1:8050/mcp). Every failure is logged and skipped —
 * this lane can never block discovery, and it cannot reach article bodies.
 */
export async function discoverBrowserHeadlines(
  category: NewsCategory,
  registry: RegistryLoadResult,
  deps: DiscoveryDeps = {}
): Promise<DiscoveredItem[]> {
  const baseUrl = process.env.REACH_MCP_URL;
  if (!baseUrl) {
    console.error(
      "  discovery: REACH_MCP_URL is not set — lazy News discovery is Fortress-only.\n" +
      "  Either pick [2] Lazy News Commentary → [1] from run.bat / run.sh (it starts the server for you),\n" +
      "  or launch it yourself:\n" +
      "    REACH_TUNNEL=0 REACH_PORT=8050 REACH_CDP_PORT=9226 REACH_APPLY_PROFILE=0 vendor/fortress-reach/target/release/reach-server\n" +
      "    $env:REACH_MCP_URL='http://127.0.0.1:8050/mcp'\n" +
      "    npm run start:news -- --topic politics --discover"
    );
    return [];
  }
  const out: DiscoveredItem[] = [];
  const seen = new Set<string>();
  const push = (item: DiscoveredItem) => {
    if (seen.has(item.fingerprint)) return;
    seen.add(item.fingerprint);
    out.push(item);
  };

  for (const page of BROWSER_PAGES[category]) {
    try {
      for (const item of await fetchFortressHeadlines(baseUrl, page, registry, deps)) push(item);
    } catch (error) {
      console.error(`  discovery: browser ${page} skipped (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
    await sleep(1500);
  }
  for (const q of CATEGORY_QUERIES[category].slice(0, 3)) {
    await sleep(1500);
    try {
      for (const item of await fetchFortressSearch(baseUrl, q, registry, deps)) push(item);
    } catch (error) {
      console.error(`  discovery: browser search ${JSON.stringify(q)} skipped (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }
  return out;
}

export async function discoverCategory(
  category: NewsCategory,
  registry: RegistryLoadResult,
  deps: DiscoveryDeps = {},
  options: { maxItems?: number } = {}
): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  const seen = new Set<string>();
  const push = (item: DiscoveredItem) => {
    if (seen.has(item.fingerprint)) return;
    seen.add(item.fingerprint);
    out.push(item);
  };

  for (const item of await discoverBrowserHeadlines(category, registry, deps)) push(item);

  const cap = options.maxItems ?? 300;
  return out.slice(0, cap);
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
