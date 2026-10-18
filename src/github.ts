import type {
  CandidateEvaluation,
  DiscoveryMode,
  EnrichedRepo,
  GitHubRelease,
  LatestCommit,
  Repo,
  RootEntry,
  ScoreBreakdown,
  ScoreDimension,
} from "./types.js";
import { MIN_SCORE } from "./config.js";

/* ------------------------------------------------------------------ */
/* Licenses                                                            */
/* ------------------------------------------------------------------ */

/** Licenses that genuinely justify the words "open source". */
const OPEN_SOURCE_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "MPL-2.0",
  "Unlicense",
  "CC0-1.0",
  "BSL-1.0",
  "Zlib",
  "Artistic-2.0",
  "EPL-2.0",
]);

const BLOCKED_TOPIC = new Set([
  "phishing",
  "malware",
  "ransomware",
  "keylogger",
  "ddos",
  "spam",
  "crypto-stealer",
  "clickbait",
]);

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const USER_AGENT = "github-showcase";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

async function githubFetch(url: string, raw = false): Promise<string> {
  const headers = authHeaders();
  if (raw) headers.Accept = "application/vnd.github.raw";
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = Number(response.headers.get("retry-after") ?? "0");
    throw new GitHubApiError(
      `GitHub request failed (${response.status}) for ${url}` +
        (response.status === 403 || response.status === 429
          ? `; rate-limit remaining=${remaining ?? "?"} reset=${reset ? new Date(reset * 1000).toISOString() : "?"}`
          : ""),
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    );
  }
  return response.text();
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Escape an `owner/repo` path for the REST API. The slash must stay literal:
 * GitHub answers 404 for `owner%2Frepo`.
 */
function encodeOwnerRepo(fullName: string): string {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error(`Not a valid owner/repository: ${fullName}`);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function parseRepoUrl(input: string): string {
  const clean = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = clean.match(
    /(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/
  );
  if (!match) {
    throw new Error(
      "Use a GitHub URL or owner/repository, e.g. https://github.com/owner/repo"
    );
  }
  return match[1];
}

export function parseRepoArg(input: string): string {
  // Accept the many shapes people paste.
  const match = input.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/
  );
  if (match) return `${match[1]}/${match[2]}`;
  return parseRepoUrl(input);
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (Date.now() - parsed) / 86400000);
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

export async function getRepo(fullName: string): Promise<Repo> {
  const body = await githubFetch(
    `https://api.github.com/repos/${encodeOwnerRepo(fullName)}`
  );
  return JSON.parse(body) as Repo;
}

/** Fetch the README. Returns `null` instead of throwing when absent. */
export async function getReadme(fullName: string): Promise<string | null> {
  try {
    return await githubFetch(
      `https://api.github.com/repos/${encodeOwnerRepo(fullName)}/readme`,
      true
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

async function getLanguages(fullName: string): Promise<Record<string, number>> {
  try {
    return JSON.parse(
      await githubFetch(
        `https://api.github.com/repos/${encodeOwnerRepo(fullName)}/languages`
      )
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

async function getLatestRelease(fullName: string): Promise<GitHubRelease | null> {
  try {
    const body = await githubFetch(
      `https://api.github.com/repos/${encodeOwnerRepo(fullName)}/releases/latest`
    );
    return JSON.parse(body) as GitHubRelease;
  } catch {
    return null;
  }
}

/** Latest commit on the default branch, for the card's file list. */
export async function getLatestCommit(fullName: string): Promise<LatestCommit | null> {
  try {
    const body = await githubFetch(
      `https://api.github.com/repos/${encodeOwnerRepo(fullName)}/commits?per_page=1`
    );
    const commits = JSON.parse(body) as {
      commit?: {
        message?: string;
        author?: { date?: string };
      };
      author?: { login?: string } | null;
    }[];
    const first = Array.isArray(commits) ? commits[0] : undefined;
    if (!first?.commit?.message) return null;
    return {
      message: first.commit.message.split("\n")[0].trim(),
      authorLogin: first.author?.login ?? null,
      committedAt: first.commit.author?.date ?? null,
    };
  } catch {
    return null;
  }
}

/** Top-level entries of the default branch, for the card's file list. */
export async function getRootFiles(fullName: string): Promise<RootEntry[]> {
  try {
    const body = await githubFetch(
      `https://api.github.com/repos/${encodeOwnerRepo(fullName)}/contents/`
    );
    const entries = JSON.parse(body) as RootEntry[];
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(entry => entry && typeof entry.name === "string")
      .map(entry => ({
        name: entry.name,
        path: entry.path,
        type: (entry.type ?? "file") as RootEntry["type"],
        size: entry.size,
      }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Discovery queries                                                   */
/* ------------------------------------------------------------------ */

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Search shapes per mode. Dates are computed at runtime — these are templates,
 * not fixed strings.
 */
export function buildSearchQueries(
  mode: DiscoveryMode,
  topic?: string | null
): string[] {
  const topicFilter = topic ? ` topic:${topic}` : "";
  switch (mode) {
    case "practical":
      return [
        `stars:100..20000 pushed:>=${isoDaysAgo(365)} archived:false fork:false${topicFilter}`,
        `stars:50..5000 pushed:>=${isoDaysAgo(90)} archived:false fork:false${topicFilter}`,
      ];
    case "popular":
      return [
        `stars:500..50000 pushed:>=${isoDaysAgo(180)} archived:false fork:false${topicFilter}`,
        `stars:2000..120000 pushed:>=${isoDaysAgo(365)} archived:false fork:false${topicFilter}`,
      ];
    case "underdog":
      return [
        `stars:15..800 pushed:>=${isoDaysAgo(120)} archived:false fork:false${topicFilter}`,
        `stars:5..2500 created:>=${isoDaysAgo(180)} archived:false fork:false${topicFilter}`,
      ];
    case "emerging":
      return [
        `stars:10..6000 created:>=${isoDaysAgo(180)} pushed:>=${isoDaysAgo(30)} archived:false fork:false${topicFilter}`,
        `stars:30..3000 pushed:>=${isoDaysAgo(21)} archived:false fork:false${topicFilter}`,
      ];
    case "topic":
      return [
        `stars:50..20000 pushed:>=${isoDaysAgo(180)} archived:false fork:false${topicFilter}`,
      ];
    default:
      return [
        `stars:50..20000 pushed:>=${isoDaysAgo(180)} archived:false fork:false${topicFilter}`,
      ];
  }
}

export const TOPIC_ROTATION = [
  "developer-tools",
  "cli",
  "automation",
  "self-hosted",
  "testing",
  "productivity",
  "security",
  "database",
  "observability",
  "static-site-generator",
];

export async function discoverRepos(options: {
  mode: DiscoveryMode;
  perQuery?: number;
  topic?: string | null;
  fetchImpl?: typeof githubFetch;
}): Promise<Repo[]> {
  const perQuery = options.perQuery ?? 25;
  const fetchImpl = options.fetchImpl ?? githubFetch;
  const queries = buildSearchQueries(options.mode, options.topic ?? null);
  const found = new Map<string, Repo>();

  for (const query of queries) {
    const url =
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}` +
      `&sort=updated&order=desc&per_page=${perQuery}`;
    let body: string;
    try {
      body = await fetchImpl(url);
    } catch (error) {
      // A failed search must not kill the run when other queries succeeded.
      if (found.size === 0) throw error;
      continue;
    }
    let items: Repo[] = [];
    try {
      items = (JSON.parse(body) as { items?: Repo[] }).items ?? [];
    } catch {
      continue;
    }
    for (const repo of items) {
      if (!repo?.full_name) continue;
      const key = repo.full_name.toLowerCase();
      if (!found.has(key)) found.set(key, repo);
    }
  }

  return [...found.values()];
}

/* ------------------------------------------------------------------ */
/* Hard rejection gates                                                */
/* ------------------------------------------------------------------ */

export type Rejection = { rule: string; reason: string };

export function hardReject(
  repo: Repo,
  context: { excluded: Set<string> }
): Rejection | null {
  const fullName = repo.full_name.toLowerCase();
  if (repo.archived) return { rule: "archived", reason: "repository is archived" };
  if (repo.disabled) return { rule: "disabled", reason: "repository is disabled" };
  if (repo.fork) return { rule: "fork", reason: "repository is a fork" };
  if (context.excluded.has(fullName)) {
    return {
      rule: "history",
      reason:
        "repository is already completed, reserved, or out of retry budget",
    };
  }
  if (!repo.html_url || !repo.full_name.includes("/")) {
    return { rule: "identity", reason: "canonical identity could not be resolved" };
  }
  if (!repo.description || repo.description.trim().length < 12) {
    return { rule: "no-description", reason: "no meaningful description" };
  }
  const topics = (repo.topics ?? []).map(topic => topic.toLowerCase());
  if (topics.some(topic => BLOCKED_TOPIC.has(topic))) {
    return { rule: "blocked-topic", reason: "topic is on the block list" };
  }
  if (
    /^\s*(?:an?\s+)?(?:awesome|curated|list of|collection of|comprehensive (?:list|collection)|resources for)\b/i.test(
      repo.description
    )
  ) {
    return {
      rule: "link-collection",
      reason: "link collection rather than a project with its own use",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export type MomentumInput = {
  /** Earliest dated snapshot, if any. */
  previousStars: number | null;
  previousCapturedAt: string | null;
  currentStars: number;
};

export type ScoreInput = {
  repo: Repo;
  mode: DiscoveryMode;
  readmeText: string | null;
  release: GitHubRelease | null;
  momentum: MomentumInput;
};

const README_SECTION_PATTERN =
  /^(#{1,6})\s+(.+?)\s*$/gm;

export type ReadmeAnalysis = {
  length: number;
  headings: string[];
  hasInstall: boolean;
  hasUsage: boolean;
  hasFeatures: boolean;
  hasLicenseSection: boolean;
  hasExamples: boolean;
  badgeRatio: number;
  codeBlocks: number;
};

export function analyzeReadme(readme: string | null): ReadmeAnalysis {
  const text = readme ?? "";
  const headings: string[] = [];
  for (const match of text.matchAll(README_SECTION_PATTERN)) {
    headings.push(match[2].trim().toLowerCase());
  }
  const lowered = text.toLowerCase();
  const images = text.match(/!\[[^\]]*\]\([^)]*\)/g)?.length ?? 0;
  const badges = text.match(/!\[[^\]]*\]\([^)]*(?:badge|shields\.io|badgen)[^)]*\)/gi)?.length ?? 0;
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return {
    length: prose.length,
    headings,
    hasInstall: /(^|\n)\s*#{1,6}\s*(install|installation|setup|getting started|quick ?start|usage)/.test(
      lowered
    ),
    hasUsage: /(^|\n)\s*#{1,6}\s*(usage|examples?|how to use)/.test(lowered),
    hasFeatures: /(^|\n)\s*#{1,6}\s*(features?|why|capabilities|highlights)/.test(
      lowered
    ),
    hasLicenseSection: /(^|\n)\s*#{1,6}\s*(license|licence|licensing)/.test(lowered),
    hasExamples: /```/.test(text) || /\bexample/i.test(prose),
    badgeRatio: images > 0 ? badges / images : 0,
    codeBlocks: (text.match(/```/g)?.length ?? 0) / 2,
  };
}

function usefulnessScore(repo: Repo, readme: ReadmeAnalysis): number {
  const description = (repo.description ?? "").trim();
  let score = 0;
  if (description.length >= 20) score += 6;
  if (description.length >= 50) score += 4;
  if (/^(a|an|the)\b/i.test(description)) score += 4;
  if (/\b(you|your)\b/i.test(description)) score += 3;
  if (readme.hasUsage || readme.hasFeatures) score += 3;
  return Math.min(20, score);
}

function documentationScore(readme: ReadmeAnalysis, hasReadme: boolean): number {
  if (!hasReadme) return 0;
  let score = 4;
  if (readme.length >= 400) score += 4;
  if (readme.length >= 1200) score += 3;
  if (readme.hasUsage || readme.hasExamples) score += 2;
  if (readme.headings.length >= 3) score += 2;
  score -= readme.badgeRatio > 0.6 ? 3 : 0;
  return Math.max(0, Math.min(15, score));
}

function maintenanceScore(repo: Repo): { score: number; warning?: string } {
  const pushed = daysSince(repo.pushed_at ?? repo.updated_at);
  if (pushed === null) return { score: 3 };
  let score: number;
  if (pushed <= 30) score = 15;
  else if (pushed <= 90) score = 13;
  else if (pushed <= 180) score = 11;
  else if (pushed <= 365) score = 8;
  else if (pushed <= 545) score = 4;
  else score = 1;
  const warning = pushed > 545 ? "no push in over 18 months" : undefined;
  return { score, warning };
}

function adoptionScore(repo: Repo): number {
  // Age-adjusted: a 2-month-old project with 400 stars is more interesting
  // than a 9-year-old project with 400 stars, but raw popularity still counts.
  const ageDays = daysSince(repo.created_at) ?? 365;
  const starsPerDay = repo.stargazers_count / Math.max(30, ageDays);
  let score = 0;
  score += Math.min(5, Math.log10(repo.stargazers_count + 1) * 1.6);
  score += Math.min(3, Math.log10(starsPerDay * 30 + 1) * 1.5);
  score += Math.min(2, Math.log10(repo.forks_count + 1) * 0.9);
  return Math.max(0, Math.min(10, score));
}

/**
 * Momentum is only scored from *dated* snapshots. Without history the score is
 * zero, which is what keeps "trending" out of the narration.
 */
export function momentumScore(input: MomentumInput): number {
  const { previousStars, previousCapturedAt, currentStars } = input;
  if (previousStars === null || !previousCapturedAt) return 0;
  const elapsedDays = (Date.now() - Date.parse(previousCapturedAt)) / 86400000;
  if (!Number.isFinite(elapsedDays) || elapsedDays < 1) return 0;
  const delta = currentStars - previousStars;
  if (delta <= 0) return 0;
  const perDay = delta / elapsedDays;
  return Math.max(0, Math.min(10, Math.log10(1 + perDay * 30) * 3));
}

function setupScore(readme: ReadmeAnalysis, repo: Repo): number {
  let score = 0;
  if (readme.hasInstall) score += 6;
  if (/```(?:bash|sh|shell|console|powershell)/.test(repo.description ?? "") || readme.codeBlocks > 0) {
    score += 2;
  }
  if (/\b(docker|npm|pnpm|yarn|pip|cargo|go install|brew|apt|nix)\b/i.test(
    (readme.headings.join(" ") || "")
  )) {
    score += 2;
  }
  if (readme.hasUsage) score += 1;
  return Math.max(0, Math.min(10, score));
}

function maturityScore(repo: Repo, release: GitHubRelease | null): {
  score: number;
  warning?: string;
} {
  let score = 0;
  if (release?.published_at) {
    const age = daysSince(release.published_at);
    score += age !== null && age <= 365 ? 5 : 3;
  }
  if (repo.forks_count >= 5) score += 2;
  if (repo.stargazers_count >= 100) score += 2;
  if ((repo.topics ?? []).length >= 2) score += 1;
  const warning = release ? undefined : "no GitHub release found";
  return { score: Math.min(10, score), warning };
}

function noveltyScore(repo: Repo, mode: DiscoveryMode): number {
  const description = (repo.description ?? "").toLowerCase();
  let score = 4;
  if (mode === "underdog") score += 3;
  if (mode === "emerging") score += 2;
  if (/\b(without|no longer|instead of|alternative|first|only)\b/.test(description)) {
    score += 2;
  }
  if ((repo.topics ?? []).length >= 3) score += 1;
  return Math.min(10, score);
}

export function scoreCandidate(input: ScoreInput): CandidateEvaluation {
  const { repo, mode, readmeText, release, momentum } = input;
  const readme = analyzeReadme(readmeText);
  const maintenance = maintenanceScore(repo);
  const maturity = maturityScore(repo, release);

  const breakdown: ScoreBreakdown = {
    usefulness: usefulnessScore(repo, readme),
    documentation: documentationScore(readme, Boolean(readmeText)),
    maintenance: maintenance.score,
    adoption: adoptionScore(repo),
    momentum: momentumScore(momentum),
    setup: setupScore(readme, repo),
    maturity: maturity.score,
    novelty: noveltyScore(repo, mode),
  };

  const reasons: string[] = [];
  const warnings: string[] = [];
  const penalties: { reason: string; points: number }[] = [];

  const readmeAge = daysSince(repo.pushed_at ?? repo.updated_at);
  if (readmeAge !== null && readmeAge > 545) {
    const points = -20;
    penalties.push({ reason: "last push over 18 months ago", points });
  }
  if (readme.badgeRatio > 0.6 && readme.length < 400) {
    penalties.push({ reason: "README is mostly badges", points: -10 });
  }
  const claimsTool = /\b(app|tool|cli|service|platform|server|framework|library|sdk)\b/i.test(
    repo.description ?? ""
  );
  if (claimsTool && !readme.hasInstall && readme.length < 800) {
    penalties.push({ reason: "no verifiable quickstart for a tool", points: -8 });
  }
  if ((repo.size ?? 0) > 0 && (repo.size ?? 0) < 30 && readme.codeBlocks === 0) {
    penalties.push({ reason: "thin repository with no examples", points: -12 });
  }

  let total =
    Object.values(breakdown).reduce((sum, value) => sum + value, 0) +
    penalties.reduce((sum, penalty) => sum + penalty.points, 0);
  total = Math.max(0, Math.min(100, Math.round(total)));

  if ((repo.description ?? "").length >= 30) {
    reasons.push("description states a concrete outcome");
  }
  if (readme.hasInstall) reasons.push("README has an explicit setup section");
  if (readme.hasUsage || readme.hasExamples) {
    reasons.push("README contains usage or examples");
  }
  if (maintenance.score >= 11) reasons.push("pushed within the last 6 months");
  if (breakdown.adoption >= 6) reasons.push("adoption is meaningful for its age");
  if (breakdown.momentum > 0) {
    reasons.push(
      `star growth measured from a dated snapshot (+${breakdown.momentum.toFixed(1)} momentum)`
    );
  } else {
    warnings.push("no star-history snapshot yet, so no trend claim is possible");
  }
  if (maintenance.warning) warnings.push(maintenance.warning);
  if (maturity.warning) warnings.push(maturity.warning);
  if (!repo.license?.spdx_id) {
    warnings.push("license not identified by the API; will not be called open source");
  }

  const eligible =
    total >= MIN_SCORE &&
    breakdown.usefulness > 0 &&
    breakdown.documentation > 0;

  return {
    repo,
    fullName: repo.full_name,
    mode,
    eligible,
    totalScore: total,
    breakdown,
    penalties,
    reasons,
    warnings,
    enriched: null,
  };
}

/* ------------------------------------------------------------------ */
/* Hydration                                                           */
/* ------------------------------------------------------------------ */

const enrichmentCache = new Map<string, { at: number; value: EnrichedRepo }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function clearEnrichmentCache(): void {
  enrichmentCache.clear();
}

export function toEnriched(repo: Repo, extras: {
  readmeText: string | null;
  languages: Record<string, number>;
  release: GitHubRelease | null;
  rootFiles?: RootEntry[];
  latestCommit?: LatestCommit | null;
}): EnrichedRepo {
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
    languages: extras.languages,
    primaryLanguage: repo.language ?? null,
    licenseSpdxId: spdx,
    licenseName: repo.license?.name ?? null,
    openSourceLicense: spdx && OPEN_SOURCE_LICENSES.has(spdx) ? spdx : null,
    readmeText: extras.readmeText,
    readmeUrl: repo.html_url ? `${repo.html_url}#readme` : null,
    latestRelease: extras.release,
    rootFiles: extras.rootFiles ?? [],
    latestCommit: extras.latestCommit ?? null,
    sizeKb: repo.size ?? 0,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Hydrate with README / languages / release. Cached per canonical identity so
 * repeated runs in one session do not re-request the same repository.
 */
export async function enrichRepo(
  repo: Repo,
  options: { force?: boolean; now?: number } = {}
): Promise<EnrichedRepo> {
  const key = repo.full_name.toLowerCase();
  const now = options.now ?? Date.now();
  const cached = enrichmentCache.get(key);
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const [readmeText, languages, release, rootFiles, latestCommit] = await Promise.all([
    getReadme(repo.full_name),
    getLanguages(repo.full_name),
    getLatestRelease(repo.full_name),
    getRootFiles(repo.full_name),
    getLatestCommit(repo.full_name),
  ]);
  const value = toEnriched(repo, {
    readmeText,
    languages,
    release,
    rootFiles,
    latestCommit,
  });
  enrichmentCache.set(key, { at: now, value });
  return value;
}

export function isOpenSource(repo: EnrichedRepo): boolean {
  return repo.openSourceLicense !== null;
}