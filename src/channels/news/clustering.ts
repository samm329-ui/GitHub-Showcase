import type { DiscoveredItem, ScoredCandidate, StoryCluster, ScoringClass } from "./types.js";
import { clusterIndependence, countOrigins, originKey } from "./sources.js";

/**
 * Deterministic story clustering + transparent scoring.
 *
 * No embeddings, no LLM. Observability is a feature: every merged pair carries
 * rule ids so the human can see WHY items were grouped.
 */

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have he her his i in into is it its of on or she so that the their its this to was with will would not no over after amid before what why how when who new latest breaking updates live says say tells told announce announced announces decision approved approve proposal tabled passed actor over into on at per amid under over below against between during between from into onto upon under above below among throughout`.split(" ")
);

const TOKEN_RE = /[a-z0-9][a-z0-9&'-]{2,}/g;

export function tokenize(text: string): string[] {
  const out = (text.toLowerCase().match(TOKEN_RE) ?? []).filter(t => !STOPWORDS.has(t));
  return [...new Set(out)];
}

/** Lightweight proper-noun-ish tokens: capitalized words + known org markers. */
export function entityTokens(text: string): string[] {
  const words = text.match(/\b[A-Z][A-Za-z0-9&.'-]{1,}\b/g) ?? [];
  const cleaned = words.map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9&]+$/g, "")).filter(w => w.length >= 2 && !/^(The|A|An|In|On|At|Of|To|For|With|After|Before|Over|Under)$/i.test(w));
  return [...new Set(cleaned.map(w => w.toLowerCase()))];
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const timeWindowMs = 72 * 3600 * 1000; // stories within 72h may be the same event

function parseTime(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export type ClusterRule = "title_similarity" | "entity_overlap" | "wire_same_origin" | "time_window";

export function clusterItems(items: DiscoveredItem[]): StoryCluster[] {
  const clusters: StoryCluster[] = [];
  const sorted = items.slice().sort((a, b) => (parseTime(b.publishedAt) ?? 0) - (parseTime(a.publishedAt) ?? 0));

  for (const item of sorted) {
    const tokens = new Set(tokenize(item.title));
    const entities = new Set(entityTokens(item.title + " " + (item.description ?? "")));
    const t = parseTime(item.publishedAt);
    let best: { cluster: StoryCluster; score: number; reasons: ClusterRule[] } | null = null;

    for (const cluster of clusters) {
      const cTokens = new Set(cluster.entityTokens.length ? cluster.entityTokens : tokenize(cluster.canonicalTitle).concat(tokenize(cluster.canonicalTitle)));
      void cTokens;
      const cSet = new Set(tokenize(cluster.canonicalTitle));
      const titleSim = jaccard(tokens, cSet);
      const eA = entities, eB = new Set(cluster.entityTokens);
      let inter = 0;
      for (const e of eA) if (eB.has(e)) inter += 1;
      let rareInter = 0;
      for (const e of eA) if (eB.has(e) && !ULTRA_COMMON.has(e)) rareInter += 1;

      const clusterTimes = cluster.items.map(i => parseTime(i.publishedAt)).filter((x): x is number => x !== null);
      const timeOk = t === null || clusterTimes.length === 0 || clusterTimes.some(ct => Math.abs(ct - t) <= timeWindowMs);

      const itemOrigin = originKey(item.sourcePolicy);
      const sameWire = cluster.items.some(i => originKey(i.sourcePolicy) === itemOrigin && item.sourcePolicy.wireOrigin);

      const reasons: ClusterRule[] = [];
      // A merge needs either a RARE shared entity (Anthropic, Cybercabs, Zelda)
      // or strong title similarity; sharing only ultra-common words (AI, UK,
      // Google, government) is NOT enough — those show up in every tech story.
      if (rareInter >= 1 && titleSim >= 0.15) reasons.push("entity_overlap");
      else if (inter >= 2 && titleSim >= 0.3) reasons.push("title_similarity");
      if (titleSim >= 0.35) reasons.push("title_similarity");
      if (sameWire) reasons.push("wire_same_origin");

      if (reasons.length && timeOk) {
        const score = titleSim * 2 + inter * 1.5 + (sameWire ? 3 : 0);
        if (!best || score > best.score) {
          const cReasons = new Set([...cluster.mergeReasons, ...reasons]);
          best = { cluster: { ...cluster, mergeReasons: [...cReasons] }, score, reasons };
        }
      }
    }

    if (best) {
      best.cluster.items.push(item);
      best.cluster.sourceIds = [...new Set(best.cluster.sourceIds.concat(item.sourceId))];
      best.cluster.entityTokens = [...new Set(best.cluster.entityTokens.concat([...entities]))];
      best.cluster.publishedTimes = [...new Set(best.cluster.publishedTimes.concat(item.publishedAt ?? []))].sort();
      best.cluster.items.sort((a, b) => (parseTime(b.publishedAt) ?? 0) - (parseTime(a.publishedAt) ?? 0));
      best.cluster.independenceCount = countOrigins(best.cluster.items.map(i => i.sourcePolicy));
      best.cluster.independence = clusterIndependence(best.cluster.items.map(i => i.sourcePolicy));
      best.cluster.confidence = Math.min(1, best.cluster.confidence + 0.1);
      // keep the earliest cluster object (mutation via reference in array)
      const index = clusters.indexOf(clusters.find(c => c.clusterId === best!.cluster.clusterId)!);
      clusters[index] = best.cluster;
    } else {
      const t0 = parseTime(item.publishedAt);
      const clusterId = `cluster_${(t0 ? String(Math.floor(t0 / 1000)) : String(Math.abs(hashString(item.title)))).slice(-10)}_${hashString(item.url).toString(16).slice(-6)}`;
      clusters.push({
        clusterId,
        canonicalTitle: item.title,
        items: [item],
        independenceCount: countOrigins([item.sourcePolicy]),
        independence: clusterIndependence([item.sourcePolicy]),
        sourceIds: [item.sourceId],
        publishedTimes: item.publishedAt ? [item.publishedAt] : [],
        category: inferCategory(item.title + " " + (item.description ?? "")),
        entityTokens: [...entities],
        mergeReasons: [],
        confidence: 0.6,
      });
    }
  }
  return clusters;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const ULTRA_COMMON = new Set([
  "ai", "uk", "us", "usa", "eu", "india", "china", "world", "global", "new",
  "first", "last", "google", "microsoft", "apple", "facebook", "trump", "biden",
  "government", "president", "minister", "says", "said", "per", "amid", "over",
  "new", "old", "big", "new", "million", "billion", "percent", "new",
  "year", "years", "time", "after", "before", "report", "reports",
]);

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  ai: ["ai", "artificial intelligence", "llm", "model", "openai", "anthropic", "chip", "gpu", "nvidia"],
  politics: ["parliament", "election", "government", "minister", "bill", "policy", "lok sabha", "rajya sabha", "modi", "prabowo"],
  geopolitics: ["war", "sanction", "troops", "border", "diplomat", "embassy", "conflict", "russia", "ukraine", "china", "taiwan"],
  finance: ["market", "stock", "rbi", "inflation", "gdp", "rupee", "budget", "fed", "earnings", "ipo", "shares", "rate", "yield"],
  environment: ["climate", "emission", "carbon", "flood", "drought", "pollution", "ipcc", "co2", "heat", "renewable"],
  technology: ["software", "app", "cyber", "hack", "data breach", "quantum", "semiconductor", "chip", "cloud", "security", "encryption"],
};

export function inferCategory(text: string): string {
  const t = text.toLowerCase();
  let best = "technology";
  let bestScore = 0;
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = words.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = category; bestScore = score; }
  }
  return bestScore > 0 ? best : "mixed";
}

/* ------------------------------------------------------------------ */
/* Scoring (weights from spec §9.4 — evidence floor is absolute)       */
/* ------------------------------------------------------------------ */

const WEIGHTS = {
  significance: 25,
  indiaRelevance: 20,
  independentCorroboration: 20,
  noveltyFreshness: 15,
  underCoverage: 10,
  publicImpact: 10,
} as const;

export type ScoreInput = {
  /** 1..10 raw analyst-style judgement per dimension, deterministic heuristics below. */
  significance: number;
  publicImpact: number;
  /** True when India is directly affected / directly involved. */
  indiaRelevant: boolean;
};

export function inferSignificance(cluster: StoryCluster): number {
  const t = (cluster.canonicalTitle + " " + cluster.items.map(i => i.description ?? "").join(" ")).toLowerCase();
  let score = 5;
  const high = ["supreme court", "election", "war", "attack", "killed", "dead", "blast", "crash", "ban", "law", "judgment", "verdict", "parliament", "summit", "treaty", "sanction", "order", "ruled", "judgment"];
  const med = ["announced", "report", "investigation", "launch", "approved", "proposed", "investment", "policy", "scheme", "warning"];
  for (const w of high) if (t.includes(w)) score += 1.5;
  for (const w of med) if (t.includes(w)) score += 0.5;
  return Math.max(1, Math.min(10, score));
}

export function inferIndiaRelevance(cluster: StoryCluster): number {
  const t = (cluster.canonicalTitle + " " + cluster.items.map(i => i.description ?? "").join(" ")).toLowerCase();
  const strong = ["india", "modi", "bjp", "congress", "delhi", "mumbai", "rupee", "rbi", "lok sabha", "rajya sabha", "sansad", "parliament", "sc order", "supreme court of india"];
  const weak = ["south asia", "brics", "quad", "indian ocean", "asean", "india-us", "india-china"];
  let score = 3;
  for (const w of strong) if (t.includes(w)) score += 2.5;
  for (const w of weak) if (t.includes(w)) score += 1.5;
  return Math.max(0, Math.min(10, score));
}

export function inferPublicImpact(cluster: StoryCluster): number {
  const t = (cluster.canonicalTitle + " " + cluster.items.map(i => i.description ?? "").join(" ")).toLowerCase();
  let score = 4;
  const high = ["tax", "fuel", "price", "inflation", "jobs", "salary", "wages", "pension", "health", "hospital", "education", "school", "exam", "exam leak", "power", "water", "blackout", "ration", "food", "law", "ban", "restriction", "data", "privacy", "hack", "breach", "fraud"];
  const med = ["investment", "subsidy", "scheme", "service", "tariff", "fee", "fine", "penalty"];
  for (const w of high) if (t.includes(w)) score += 1.2;
  for (const w of med) if (t.includes(w)) score += 0.5;
  return Math.max(1, Math.min(10, score));
}

export function scoreCluster(cluster: StoryCluster): ScoredCandidate {
  const significance = inferSignificance(cluster);
  const indiaRelevance = inferIndiaRelevance(cluster);
  const publicImpact = inferPublicImpact(cluster);
  const indep = Math.min(10, cluster.independenceCount * 4);
  const underCovered = cluster.items.length <= 2 && cluster.independenceCount <= 2;
  const underCoverageScore = underCovered ? 8 : 2;
  const novelty = Math.max(1, Math.min(10, 10 - Math.min(9, Math.max(0, Math.floor((Date.now() - Math.max(0, ...cluster.publishedTimes.map(p => parseTime(p) ?? 0))) / (6 * 3600 * 1000))))));

  const raw = {
    significance,
    indiaRelevance,
    independentCorroboration: indep,
    noveltyFreshness: novelty,
    underCoverage: underCoverageScore,
    publicImpact,
  };

  const score =
    raw.significance * (WEIGHTS.significance / 10) +
    raw.indiaRelevance * (WEIGHTS.indiaRelevance / 10) +
    raw.independentCorroboration * (WEIGHTS.independentCorroboration / 10) +
    raw.noveltyFreshness * (WEIGHTS.noveltyFreshness / 10) +
    raw.underCoverage * (WEIGHTS.underCoverage / 10) +
    raw.publicImpact * (WEIGHTS.publicImpact / 10);

  const evidenceOk = cluster.independenceCount >= 2 || cluster.items.some(i => i.sourcePolicy.sourceRole === "primary");

  const reasons: string[] = [];
  reasons.push(`significance=${significance.toFixed(1)} (${cluster.items.length} item(s), ${cluster.category})`);
  reasons.push(`indiaRelevance=${indiaRelevance.toFixed(1)}`);
  reasons.push(`corroboration=${cluster.independenceCount} origin(s) [${cluster.independence}]`);
  reasons.push(`publicImpact=${publicImpact.toFixed(1)}`);
  reasons.push(underCovered ? "low_coverage_in_monitored_sources" : "broadly covered");

  const editorialState: ScoringClass =
    cluster.independenceCount >= 2 && Date.now() - Math.max(0, ...cluster.publishedTimes.map(p => parseTime(p) ?? 0)) < 6 * 3600 * 1000
      ? "developing"
      : cluster.independenceCount >= 2
        ? "established"
        : cluster.items.length > 0
          ? "developing"
          : "established";

  return {
    cluster,
    score: Math.round(score * 10) / 10,
    breakdown: {
      significance: Math.round(raw.significance * 2.5 * 10) / 10,
      indiaRelevance: Math.round(raw.indiaRelevance * 2 * 10) / 10,
      independentCorroboration: Math.round(raw.independentCorroboration * 2 * 10) / 10,
      noveltyFreshness: Math.round(raw.noveltyFreshness * 1.5 * 10) / 10,
      underCoverage: underCoverageScore,
      publicImpact: Math.round(raw.publicImpact * 1 * 10) / 10,
    },
    reasons,
    underCovered,
    editorialState,
    eligible: evidenceOk,
    eligibilityNote: evidenceOk
      ? null
      : "Insufficient evidence in the monitored corpus (needs >=2 origins or one primary record).",
  };
}

export function rankCandidates(clusters: StoryCluster[]): ScoredCandidate[] {
  return clusters.map(scoreCluster).sort((a, b) => b.score - a.score);
}
