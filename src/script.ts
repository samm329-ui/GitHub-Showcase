import type { EnrichedRepo, FactLedger } from "./types.js";
import { buildFactLedger, narratableFacts } from "./facts.js";
import { buildNarrationPlan, type PhraseHistory } from "./narration.js";

/**
 * Backwards-compatible façade over `facts.ts` + `narration.ts`.
 *
 * The public shapes (`RepoFacts`, `buildRepoFacts`, `makeScript`) are preserved
 * so existing callers keep working, but the guessing is gone: every value now
 * comes from the fact ledger and is omitted rather than invented.
 */

export type RepoFacts = {
  purpose: string;
  install: string;
  hosting: string;
  cost: string;
  license: string;
  stars: string;
  language: string;
  /** Facts that were dropped because no evidence existed. */
  unverified: string[];
};

function plainReadmeText(readme: string | null): string {
  return (readme ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the legacy flat fact record from an enriched repository.
 * Unlike the previous implementation this never invents values: a field that
 * has no supporting fact comes back as an empty string and is listed in
 * `unverified`.
 */
export function buildRepoFactsFromEnriched(repo: EnrichedRepo): RepoFacts {
  const ledger = buildFactLedger(repo);
  return factsFromLedger(repo, ledger);
}

export function factsFromLedger(repo: EnrichedRepo, ledger: FactLedger): RepoFacts {
  const usable = narratableFacts(ledger);
  const ofKind = (kind: string) => usable.filter(item => item.kind === kind);

  const purpose = ofKind("purpose")[0]?.spoken ?? "";
  const installFact = ofKind("install")[0];
  const hostingFact = ofKind("requirement").find(item =>
    /self-hosted|runs? locally|your own machine/i.test(item.claim)
  );
  const costFact = ofKind("requirement").find(item =>
    /pricing|subscription|api key|free/i.test(item.claim)
  );
  const licenseFact = ofKind("license")[0];
  const adoption = ofKind("adoption")[0];
  const language = ofKind("language")[0];

  const unverified: string[] = [];
  if (!purpose) unverified.push("purpose");
  if (!installFact) unverified.push("install");
  if (!hostingFact) unverified.push("hosting");
  if (!costFact) unverified.push("cost");
  if (!licenseFact) unverified.push("license");

  return {
    purpose,
    install: installFact?.spoken ?? "",
    hosting: hostingFact?.spoken ?? "",
    cost: costFact?.spoken ?? "",
    license: licenseFact?.spoken ?? (repo.licenseSpdxId ?? ""),
    stars: adoption?.spoken ?? "",
    language: language?.spoken ?? "",
    unverified,
  };
}

/**
 * Legacy helper: accepts the same `(repo, readme)` arguments as before.
 * The repository is enriched locally (no extra network calls) so historical
 * callers keep compiling and producing the same field names.
 */
export function buildRepoFacts(
  repo: Parameters<typeof toLocalEnriched>[0],
  readme: string
): RepoFacts {
  return buildRepoFactsFromEnriched(toLocalEnriched(repo, readme));
}

function toLocalEnriched(
  repo: import("./types.js").Repo,
  readme: string
): EnrichedRepo {
  const [owner, name] = repo.full_name.split("/");
  const spdx = repo.license?.spdx_id ?? null;
  return {
    ...repo,
    nodeId: repo.node_id ?? `local:${repo.full_name.toLowerCase()}`,
    owner: owner ?? "",
    name: repo.name ?? name ?? "",
    updatedAt: repo.updated_at,
    createdAt: repo.created_at ?? repo.updated_at,
    pushedAt: repo.pushed_at ?? null,
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    fork: Boolean(repo.fork),
    topics: repo.topics ?? [],
    homepage: repo.homepage ?? null,
    languages: {},
    primaryLanguage: repo.language ?? null,
    licenseSpdxId: spdx,
    licenseName: repo.license?.name ?? null,
    openSourceLicense: null,
    readmeText: readme,
    readmeUrl: repo.html_url ? `${repo.html_url}#readme` : null,
    latestRelease: null,
    rootFiles: [],
    latestCommit: null,
    sizeKb: repo.size ?? 0,
    capturedAt: new Date().toISOString(),
  };
}

/** Legacy entry point: returns the narration text as a single string. */
export function makeScript(
  repo: import("./types.js").Repo,
  readme: string,
  recentUsage?: PhraseHistory
): string {
  const enriched = toLocalEnriched(repo, readme);
  const ledger = buildFactLedger(enriched);
  const plan = buildNarrationPlan(ledger, enriched, { recentUsage });
  return plan.segments.map(segment => segment.spokenText).join(" ");
}

/** Re-exported so the ledger can be produced without importing `facts.ts`. */
export { buildFactLedger };
export { plainReadmeText };