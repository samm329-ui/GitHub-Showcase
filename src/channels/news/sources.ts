import path from "node:path";
import fs from "node:fs";
import type { IndependenceStatus, SourcePolicy, DiscoveredItem } from "./types.js";

/**
 * Lazy News source registry — fail closed.
 *
 * Rules enforced here (see docs/Lazy_News_Detailed_Implementation_Plan.md §4):
 *  - every entry is an individual policy (never a category grant);
 *  - `termsCheckedAt` is an audit trail, not proof — `permissionBasis` governs;
 *  - `unknown` basis ⇒ entry forced `enabled: false` with a load-time warning;
 *  - terms reviews expire after 90 days ⇒ entry degrades to discovery_only;
 *  - `llmProcessingAllowed` requires `fullTextFetchAllowed` + `quotationAllowed`;
 *  - discovery-only entries may feed clustering only — never the ledger, never Groq;
 *  - anything disabled is inert at every call site.
 */

export class SourcePolicyError extends Error {
  override name = "SourcePolicyError";
}

const TERMS_MAX_AGE_DAYS = 90;

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function readRegistryFile(filePath = path.join(process.cwd(), "config", "news-sources.json")): SourcePolicy[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new SourcePolicyError(
      `news-sources registry unreadable or malformed (${filePath}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { sources?: unknown }).sources)) {
    throw new SourcePolicyError("news-sources registry must have a `sources` array.");
  }
  return (raw as { sources: SourcePolicy[] }).sources;
}

export type RegistryLoadResult = {
  policies: SourcePolicy[];
  warnings: string[];
};

export function loadRegistry(filePath = path.join(process.cwd(), "config", "news-sources.json")): RegistryLoadResult {
  const warnings: string[] = [];
  const normalized = readRegistryFile(filePath).map(entry => normalizePolicy(entry, warnings));
  return { policies: normalized, warnings };
}

export function normalizePolicy(original: SourcePolicy, warnings: string[]): SourcePolicy {
  const p: SourcePolicy = { ...original };
  const label = `${p.sourceId || "<unknown>"}`;

  if (!p.sourceId || !p.domain) {
    throw new SourcePolicyError(`Registry entry missing sourceId/domain: ${JSON.stringify(original).slice(0, 120)}`);
  }
  if (!Array.isArray(p.documentTypes) || p.documentTypes.length === 0) {
    throw new SourcePolicyError(`${label}: documentTypes must be a non-empty array.`);
  }
  if (!p.permissionBasis) {
    warnings.push(`${label}: missing permissionBasis — forced disabled (unknown).`);
    p.permissionBasis = "unknown";
  }
  if (p.permissionBasis === "unknown") p.enabled = false;

  // Terms expiry: stale review degrades to discovery-only (never escalates).
  const age = daysSince(p.termsCheckedAt);
  if (age !== null && age > TERMS_MAX_AGE_DAYS && p.enabled && p.permissionBasis !== "discovery_only") {
    warnings.push(`${label}: termsCheckedAt older than ${TERMS_MAX_AGE_DAYS} days — degraded to discovery_only pending re-review.`);
    p.discoveryAllowed = true;
    p.metadataAllowed = true;
    p.fullTextFetchAllowed = false;
    p.llmProcessingAllowed = false;
    p.quotationAllowed = false;
    p.permissionBasis = "discovery_only";
  }
  if (p.permissionBasis === "discovery_only") {
    p.fullTextFetchAllowed = false;
    p.llmProcessingAllowed = false;
    p.quotationAllowed = false;
  }
  if (p.llmProcessingAllowed && !p.fullTextFetchAllowed) {
    warnings.push(`${label}: llmProcessingAllowed requires fullTextFetchAllowed — LLM access removed.`);
    p.llmProcessingAllowed = false;
  }
  if (p.llmProcessingAllowed && !p.quotationAllowed) {
    warnings.push(`${label}: llmProcessingAllowed requires quotationAllowed — LLM access removed.`);
    p.llmProcessingAllowed = false;
  }
  if (p.enabled && p.permissionBasis === "unknown") p.enabled = false;
  return p;
}

const domainOf = (urlString: string): string | null => {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Find the enabled policy for a URL by longest-domain match. */
export function findPolicyForUrl(urlString: string, policies: SourcePolicy[]): SourcePolicy | null {
  const host = domainOf(urlString);
  if (!host) return null;
  let best: SourcePolicy | null = null;
  for (const p of policies) {
    if (!p.enabled) continue;
    const d = p.domain.toLowerCase();
    if (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) {
      if (!best || d.length > best.domain.length) best = p;
    }
  }
  return best;
}

export function assertDiscoveryAllowed(urlString: string, policies: SourcePolicy[]): SourcePolicy {
  const policy = findPolicyForUrl(urlString, policies);
  if (!policy) {
    throw new SourcePolicyError(
      `No enabled policy covers: ${urlString}\n` +
        `  Fix: add the outlet to config/news-sources.json as an individually-reviewed entry ` +
        `(discovery_only for headline-only use, or terms_reviewed/public_domain with fullTextAllow permission), ` +
        `or pass a permitted primary URL as --url / --evidence.`
    );
  }
  if (!policy.discoveryAllowed || !policy.metadataAllowed) {
    throw new SourcePolicyError(`Source out of licence for discovery metadata: ${policy.sourceId}`);
  }
  return policy;
}

export function assertEvidenceAllowed(urlString: string, policies: SourcePolicy[]): SourcePolicy {
  const policy = findPolicyForUrl(urlString, policies);
  if (!policy) {
    throw new SourcePolicyError(`No enabled policy covers: ${urlString}`);
  }
  if (!policy.fullTextFetchAllowed) {
    throw new SourcePolicyError(
      `Source not permitted for evidence extraction: ${policy.sourceId} (permissionBasis=${policy.permissionBasis}). ` +
        `Only primary/institutional/first-party records with explicit permission may feed the ledger.`
    );
  }
  return policy;
}

/* ------------------------------------------------------------------ */
/* Independence                                                        */
/* ------------------------------------------------------------------ */

const WIRE_GROUPS: Record<string, string> = {
  pib: "pib",
  rbi: "rbi",
  mea: "mea",
  sansad: "sansad",
  eci: "eci",
  sci: "sci",
  edgar: "edgar",
  release: "release",
  un: "un",
  ap: "ap",
  reuters: "reuters",
  afp: "afp",
};

export function independenceStatusFor(policy: SourcePolicy): IndependenceStatus {
  // Discovery-tier and social signals are never independent confirmations.
  if (policy.sourceRole === "social_signal") return "unknown";
  if (policy.permissionBasis === "discovery_only") return "unknown";
  if (policy.sourceRole === "discovery") return "unknown";
  // Same wire origin / same parent group ⇒ not independent of each other,
  // but independent OF other groups; classification happens in clustering
  // when counts are computed against a cluster.
  return "independent";
}

/** Wire-lineage key: items sharing both group and (wire) origin are one origin. */
export function originKey(policy: SourcePolicy): string {
  const wire = policy.wireOrigin ? WIRE_GROUPS[policy.wireOrigin] ?? policy.wireOrigin : "none";
  return `${policy.parentPublisherGroup}::${wire}`;
}

/** Counts distinct reporting origins in a set of policies (cluster inputs). */
export function countOrigins(policies: SourcePolicy[]): number {
  const keys = new Set(policies.map(originKey));
  return keys.size;
}

/** Cluster-level independence verdict. */
export function clusterIndependence(policies: SourcePolicy[]): IndependenceStatus {
  const count = countOrigins(policies);
  if (count >= 2) return "independent";
  if (count === 1) {
    const roles = new Set(policies.map(p => p.sourceRole));
    if (roles.size === 1 && roles.has("primary")) return "same_original_source";
    return "syndicated";
  }
  return "unknown";
}

/** Discovery URLs never carry the ledger; this guard is used at build time. */
export function assertItemAllowedAsEvidence(item: DiscoveredItem): void {
  if (!item.sourcePolicy.fullTextFetchAllowed) {
    throw new SourcePolicyError(
      `Headline signal used as evidence: ${item.url} (${item.sourceId}) — discovery-only sources are not evidence.`
    );
  }
}
