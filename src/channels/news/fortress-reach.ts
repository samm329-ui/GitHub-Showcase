/**
 * Fortress-Reach bridge — a retrieval backend, nothing more.
 *
 * Talks to a locally running Fortress-Reach MCP server over streamable HTTP
 * (POST /mcp, JSON-RPC 2.0). Two tools are used, both read-only:
 *
 *   read_page   — a page's main text as Markdown (homepage headline harvest)
 *   search_web  — web search results with titles, URLs and summaries
 *
 * Hard rules this module enforces (fail closed, never work around):
 *  - the outlet must already exist in config/news-sources.json with
 *    discoveryAllowed: true (registry check happens before ANY network call);
 *  - a bot-challenge / forbidden / captcha response is a HARD STOP — no
 *    retry, no different tool, no stealth escalation. Callers log and skip;
 *  - nothing fetched here ever reaches the ledger as "evidence": it is a
 *    discovery signal, identical in kind to RSS/GDELT output;
 *  - this module never asks the server to apply, inspect or rotate machine
 *    fingerprints. The server's REACH_APPLY_PROFILE setting is the
 *    operator's choice; the client is indifferent to it, but the honest
 *    configuration is REACH_APPLY_PROFILE=0 (see docs/lazy-news.md).
 *
 * Behaviour is enabled only when REACH_MCP_URL is set (e.g.
 * http://127.0.0.1:8050/mcp). Unset ⇒ zero calls, zero behaviour change.
 */
import crypto from "node:crypto";
import type { DiscoveredItem } from "./types.js";
import { assertDiscoveryAllowed, type RegistryLoadResult } from "./sources.js";

export class FortressError extends Error {
  override name = "FortressError";
}

export type FortressDeps = { fetchImpl?: typeof fetch; now?: () => Date };

const TIMEOUT_MS = 45_000;

/* Site-chrome crumbs that must never enter the candidate pool. */
const BOILERPLATE_PREFIX_RE = /^(title|meta|description|keywords|og|twitter)\s*:/i;
const BRAND_SUFFIX_RE = /\|\s*(the\s+|national\s+)?(times of india|hindustan times|hindustan|the hindu|indian express|india express|fox news|the quint|al jazeera|swarajya|ndtv|bbc[\w ]*|the wire|scroll(\.in)?)\b[\w\s.]*$/i;

/* Substrings that mean "this is a challenge/block page", never an article. */
const HARD_STOP_MARKERS = [
  /just a moment/i,
  /checking your browser/i,
  /cf-chl/i,
  /captcha/i,
  /are you a human/i,
  /access denied/i,
  /unusual traffic/i,
  /403 forbidden/i,
  /enable javascript/i,
];

async function rpc(
  baseUrl: string,
  id: number,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetchImpl(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal,
  });
  if (!response.ok) {
    throw new FortressError(`Fortress-Reach HTTP ${response.status} at ${baseUrl} — is the server running there?`);
  }
  const body = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (body?.error) {
    throw new FortressError(`Fortress-Reach RPC error ${body.error.code}: ${body.error.message}`);
  }
  return body?.result;
}

/** One tools/call round trip, with the initialize handshake first (server is lenient but deterministic). */
async function callTool(baseUrl: string, name: string, args: Record<string, unknown>, deps: FortressDeps): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    await rpc(baseUrl, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lazy-news", version: "1.0" },
    }, fetchImpl, controller.signal);
    // Notification — server replies "acknowledged"; we do not await a body.
    await rpc(baseUrl, 2, "notifications/initialized", {}, fetchImpl, controller.signal).catch(() => undefined);
    const result = (await rpc(baseUrl, 3, "tools/call", { name, arguments: args }, fetchImpl, controller.signal)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    } | null;
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) {
      throw new FortressError(`Fortress tool '${name}' failed: ${text.slice(0, 200)}`);
    }
    for (const marker of HARD_STOP_MARKERS) {
      if (marker.test(text)) {
        throw new FortressError(
          `hard stop: '${name}' returned what looks like a challenge/forbidden page. Not bypassing — skipping this source.`
        );
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* Self-contained fingerprint (mirrors discovery.ts) to avoid an import cycle. */
function fingerprintItem(title: string, url: string): string {
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
  const normTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(`${canonical}::${normTitle}`).digest("hex");
}

/** Read a page's Markdown; pair each visible headline with its article URL. */
export async function fetchFortressHeadlines(
  baseUrl: string,
  pageUrl: string,
  registry: RegistryLoadResult,
  deps: FortressDeps = {}
): Promise<DiscoveredItem[]> {
  assertDiscoveryAllowed(pageUrl, registry.policies); // registry gate first
  const markdown = await callTool(baseUrl, "read_page", { url: pageUrl }, deps);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const items: DiscoveredItem[] = [];
  for (const { title, url } of parseHeadlineLinks(markdown).slice(0, 40)) {
    let policy;
    try {
      policy = assertDiscoveryAllowed(url, registry.policies);
    } catch {
      continue; // article from an outlet we cannot use — dropped, same discipline as GDELT
    }
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|at_|ocid|ref(fer)?$|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    const canonical = u.toString();
    const id = fingerprintItem(title, canonical);
    items.push({
      id,
      title,
      url: canonical,
      sourceId: policy.sourceId,
      sourceName: policy.sourceId,
      sourcePolicy: policy,
      publishedAt: null,
      eventDate: null,
      description: title,
      fetchedAt: now,
      fingerprint: id,
    });
  }
  return items;
}

/** Read a page's main text as Markdown through Fortress-Reach (hard stops included). */
export async function fetchPageMarkdown(
  baseUrl: string,
  pageUrl: string,
  deps: FortressDeps = {}
): Promise<string> {
  return callTool(baseUrl, "read_page", { url: pageUrl }, deps);
}

/* Site-chrome crumbs that must never enter the candidate pool: page <title>
 * lines ("Title: … | Times of India"), meta tags, and brand-suffixed
 * site titles. Only an actual headline survives. */
export type HeadlineLink = { title: string; url: string };

/**
 * Extract real headline→article-URL pairs from read_page markdown.
 * Hindustan Times / The Quint / etc. render stories as markdown headings whose
 * text is a link:  "### [Headline text](https://outlet/article.html)".
 * Section crumbs ("[india news](…)Updated 43m ago") are not headings and are ignored.
 */
export function parseHeadlineLinks(markdown: string): HeadlineLink[] {
  const seen = new Set<string>();
  const out: HeadlineLink[] = [];
  const linkRe = /^#{1,4}\s*\[([^\]\n]{20,220})\]\((https?:\/\/[^)\s]+)\)/gm;
  for (const match of markdown.matchAll(linkRe)) {
    const title = match[1]
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—]+/, "")
      .trim();
    if (title.length < 20) continue;
    if (/https?:\/\//.test(title)) continue;
    const url = match[2].trim();
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
  }
  // Fallback shape: some pages render headline links without a heading marker
  // but with an image prefix. Accept "[![…]](article-url)" then "[Headline](same-url)" pairs.
  for (const match of markdown.matchAll(/^\[([^\]\n]{20,220})\]\((https?:\/\/[^)\s]+\.html?[^)\s]*)\)/gm)) {
    const title = match[1].replace(/\s+/g, " ").trim();
    const url = match[2].trim();
    if (BOILERPLATE_PREFIX_RE.test(title) || BRAND_SUFFIX_RE.test(title)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
  }
  return out;
}

/** Read a registered homepage and turn its visible headlines into discovery signals. */
/** Run a registered-outlet-only web search and harvest usable links as discovery signals. */
export async function fetchFortressSearch(
  baseUrl: string,
  query: string,
  registry: RegistryLoadResult,
  deps: FortressDeps = {}
): Promise<DiscoveredItem[]> {
  const text = await callTool(baseUrl, "search_web", { query, count: 10 }, deps);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s"')<>]+/g)) {
    urls.add(match[0].replace(/[.,;:]+$/, ""));
  }
  const items: DiscoveredItem[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    let policy;
    try {
      policy = assertDiscoveryAllowed(url, registry.policies);
    } catch {
      continue; // result links out to an unregistered outlet — dropped, same discipline as GDELT
    }
    const line = text.split("\n").find(l => l.includes(url)) ?? "";
    const title =
      line
        .replace(url, "")
        .replace(/^[\s\-–—*•|#:>·]+/, "")
        .replace(/[^\p{L}\p{N} ,.;:!?'’&()+\-–—]/gu, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 180) || url;
    const id = fingerprintItem(title, url);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title,
      url,
      sourceId: policy.sourceId,
      sourceName: policy.sourceId,
      sourcePolicy: policy,
      publishedAt: null,
      eventDate: null,
      description: null,
      fetchedAt: now,
      fingerprint: id,
      matchedQuery: query,
    });
  }
  return items;
}
