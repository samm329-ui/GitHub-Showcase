export type Repo = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  updated_at: string;
  default_branch: string;
  license: { key: string; name: string; spdx_id: string | null } | null;
  topics?: string[];
  homepage?: string | null;
  archived?: boolean;
};

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "github-showcase-mvp"
};

export function parseRepoUrl(input: string): string {
  const clean = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = clean.match(/(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (!match) throw new Error("Use a GitHub URL or owner/repository, e.g. https://github.com/owner/repo");
  return match[1];
}

export async function getRepo(fullName: string): Promise<Repo> {
  const response = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (!response.ok) throw new Error(`GitHub repository request failed (${response.status}). Check the repository URL or GitHub's unauthenticated API limit.`);
  return await response.json() as Repo;
}

export async function getReadme(fullName: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers: { ...headers, Accept: "application/vnd.github.raw" }
  });
  if (!response.ok) throw new Error(`Could not fetch README (${response.status}).`);
  return await response.text();
}

export async function discoverRepos(limit = 10): Promise<Repo[]> {
  const cutoff = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  const queries = [
    `stars:10..150 pushed:>${cutoff} fork:false`,
    `stars:151..3000 pushed:>${cutoff} fork:false`
  ];
  const found = new Map<string, Repo>();
  for (const q of queries) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=30`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`GitHub discovery failed (${response.status}).`);
    const data = await response.json() as { items: Repo[] };
    for (const repo of data.items ?? []) {
      if (repo.archived || !repo.description || repo.stargazers_count < 10 || !repo.license) continue;
      if (/(flashloan|mev|arbitrage|crypto|vpn|mirror)/i.test(`${repo.full_name} ${repo.description}`)) continue;
      found.set(repo.full_name, repo);
    }
  }
  return [...found.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

function score(repo: Repo): number {
  const ageDays = Math.max(1, (Date.now() - Date.parse(repo.updated_at)) / 86400000);
  const recency = 1 / Math.sqrt(ageDays);
  const descriptionQuality = Math.min((repo.description ?? "").length / 100, 1);
  const stars = Math.log10(repo.stargazers_count + 1);
  // Heuristic discovery score, not an AI assessment of usefulness.
  return recency * 4 + descriptionQuality + stars * 0.25;
}
