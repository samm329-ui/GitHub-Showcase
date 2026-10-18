import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnrichedRepo, GitHubRelease, Repo, RootEntry } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export type Fixture = {
  repo: Repo;
  readme: string;
  rootFiles: RootEntry[];
  release: GitHubRelease | null;
};

const cache = new Map<string, Record<string, unknown>>();

function loadAll(): Record<string, unknown> {
  if (cache.size === 0) {
    const file = path.join(here, "fixtures", "repositories.json");
    cache.set("all", JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return cache.get("all")!;
}

export function fixture(name: string): Fixture {
  const data = loadAll() as { repositories: Record<string, unknown> };
  const raw = data.repositories[name];
  if (!raw) throw new Error(`Unknown fixture: ${name}`);
  const record = raw as Record<string, unknown>;
  return {
    repo: {
      html_url: "",
      description: null,
      stargazers_count: 0,
      forks_count: 0,
      default_branch: "main",
      license: null,
      updated_at: new Date().toISOString(),
      ...(record as unknown as Repo),
    },
    readme: String(record.readme ?? ""),
    rootFiles: (record.root_files as RootEntry[]) ?? [],
    release: (record.release as GitHubRelease | null) ?? null,
  };
}

/** Build an `EnrichedRepo` from a fixture without touching the network. */
export function enriched(name: string, overrides: Partial<EnrichedRepo> = {}): EnrichedRepo {
  const { repo, readme, rootFiles, release } = fixture(name);
  const [owner, repoName] = repo.full_name.split("/");
  void repo.owner;
  const spdx = repo.license?.spdx_id ?? null;
  const OPEN_SOURCE = new Set([
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "GPL-3.0",
    "AGPL-3.0",
    "MPL-2.0",
    "Unlicense",
  ]);
  return {
    ...repo,
    nodeId: repo.node_id ?? `local:${repo.full_name.toLowerCase()}`,
    owner,
    name: repoName,
    createdAt: repo.created_at ?? repo.updated_at,
    updatedAt: repo.updated_at,
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
    openSourceLicense: spdx && OPEN_SOURCE.has(spdx) ? spdx : null,
    readmeText: readme,
    readmeUrl: `${repo.html_url}#readme`,
    latestRelease: release,
    rootFiles,
    latestCommit: {
      message: "Update the quick start section",
      authorLogin: "maintainer",
      committedAt: repo.pushed_at ?? null,
    },
    sizeKb: repo.size ?? 0,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function fixtureNames(): string[] {
  const data = loadAll() as { repositories: Record<string, unknown> };
  return Object.keys(data.repositories);
}