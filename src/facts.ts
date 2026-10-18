import type { EnrichedRepo, Fact, FactKind, FactLedger, Repo } from "./types.js";
import { FACT_CONFIDENCE_THRESHOLD } from "./config.js";

const DAY = 86400000;

function fact(
  repo: EnrichedRepo,
  kind: FactKind,
  claim: string,
  spoken: string,
  confidence: number,
  source: Fact["source"]["kind"],
  location: string
): Fact {
  return {
    id: `${kind}:${location}:${slug(claim).slice(0, 32)}`,
    kind,
    claim,
    spoken,
    source: { kind: source, location, capturedAt: repo.capturedAt },
    confidence: Number(confidence.toFixed(2)),
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sentence(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

/* ------------------------------------------------------------------ */
/* README parsing                                                      */
/* ------------------------------------------------------------------ */

export type ReadmeSection = {
  heading: string;
  level: number;
  body: string;
  codeBlocks: string[];
};

export type ParsedReadme = {
  overview: string;
  sections: ReadmeSection[];
  codeBlocks: string[];
  plainText: string;
  headings: string[];
};

export function parseReadme(readme: string | null): ParsedReadme {
  const text = readme ?? "";
  const lines = text.split(/\r?\n/);
  const sections: ReadmeSection[] = [];
  const codeBlocks: string[] = [];
  let current: ReadmeSection = { heading: "", level: 0, body: "", codeBlocks: [] };
  let inFence = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*```(\w*)\s*$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        continue;
      }
      inFence = false;
      current.codeBlocks.push(fenceMatch[1] ?? "");
      codeBlocks.push(fenceMatch[1] ?? "");
      continue;
    }
    if (inFence) {
      current.body += `${line}\n`;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (current.heading || current.body.trim()) sections.push(current);
      current = {
        heading: heading[2].trim(),
        level: heading[1].length,
        body: "",
        codeBlocks: [],
      };
      continue;
    }
    current.body += `${line}\n`;
  }
  if (current.heading || current.body.trim()) sections.push(current);

  const plainText = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`>#~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    overview: plainText,
    sections,
    codeBlocks,
    plainText,
    headings: sections.filter(s => s.level > 0).map(s => s.heading.toLowerCase()),
  };
}

function sectionMatching(
  parsed: ParsedReadme,
  patterns: RegExp[]
): ReadmeSection | null {
  for (const pattern of patterns) {
    const found = parsed.sections.find(section =>
      pattern.test(section.heading.toLowerCase())
    );
    if (found) return found;
  }
  return null;
}

const NON_FEATURE_HEADINGS =
  /^(install|installation|setup|usage|examples?|how to use|contributing|contribution|license|licence|credits?|acknowledg|table of contents|sponsors?|changelog|roadmap|faq|troubleshooting|testing|development)/;

export function sectionWithBullets(
  parsed: ParsedReadme,
  patterns: RegExp[]
): ReadmeSection | null {
  for (const pattern of patterns) {
    for (const section of parsed.sections) {
      if (!pattern.test(section.heading.toLowerCase())) continue;
      if (bulletsOf(section).length >= 2) return section;
    }
  }
  let best: ReadmeSection | null = null;
  let bestCount = 0;
  for (const section of parsed.sections) {
    if (NON_FEATURE_HEADINGS.test(section.heading.toLowerCase())) continue;
    const count = bulletsOf(section).length;
    if (count > bestCount) {
      best = section;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : null;
}

function firstRealSentence(text: string, minLength = 40): string | null {
  const matches = text.match(/[^.!?\n]+[.!?]?/g) ?? [];
  for (const candidate of matches) {
    const trimmed = sentence(candidate);
    if (trimmed.length >= minLength && /\w/.test(trimmed)) return trimmed;
  }
  return null;
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function bulletsOf(section: ReadmeSection | null): string[] {
  if (!section) return [];
  return section.body
    .split(/\r?\n/)
    .map(line => line.match(/^\s*[-*+]\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(match => stripMarkdown(sentence(match[1])))
    .filter(line => line.length >= 12 && line.length <= 160)
    .filter(
      line =>
        !/\b(visit|see|read|docs|documentation|course|tutorial|guide|learn more|getting started)\b/i.test(
          line
        )
    );
}

/* ------------------------------------------------------------------ */
/* Install commands                                                    */
/* ------------------------------------------------------------------ */

export type InstallInfo = {
  command: string | null;
  spoken: string;
  fact: Fact | null;
};

const PACKAGE_MANAGERS: {
  command: RegExp;
  spoken: string;
  display: string;
}[] = [
  { command: /\bpnpm\s+(?:add|install)(?:\s+\S+){0,10}/i, spoken: "install it with pnpm", display: "pnpm add" },
  { command: /\byarn\s+add(?:\s+\S+){0,10}/i, spoken: "install it with yarn", display: "yarn add" },
  { command: /\bbun\s+add(?:\s+\S+){0,10}/i, spoken: "install it with bun", display: "bun add" },
  { command: /\bnpm\s+(?:install|i)(?:\s+\S+){0,10}/i, spoken: "install it with npm", display: "npm install" },
  { command: /\bnpx\s+create-[\w.-]+(?:\s+\S+){0,10}/i, spoken: "run its project creator with npx", display: "npx create-*" },
  { command: /\bpip3?\s+install(?:\s+\S+){0,10}/i, spoken: "install it with pip", display: "pip install" },
  { command: /\b(?:uv|pipx)\s+(?:tool\s+)?install(?:\s+\S+){0,10}/i, spoken: "install it with that Python tool", display: "uv tool install" },
  { command: /\bcargo\s+install(?:\s+\S+){0,10}/i, spoken: "install it with cargo", display: "cargo install" },
  { command: /\bgo\s+install(?:\s+\S+){0,10}/i, spoken: "install it from source with go", display: "go install" },
  { command: /\bbrew\s+install(?:\s+\S+){0,10}/i, spoken: "install it with homebrew", display: "brew install" },
  { command: /\bapt(?:-get)?\s+install(?:\s+\S+){0,10}/i, spoken: "install it with apt", display: "apt install" },
];

export function extractInstall(
  repo: EnrichedRepo,
  parsed: ParsedReadme
): InstallInfo {
  const section = sectionMatching(parsed, [
    /^(install|installation|setup|getting started|quick ?start)/,
  ]);
  const haystack = `${section?.body ?? ""}\n${parsed.plainText}`;

  for (const manager of PACKAGE_MANAGERS) {
    const match = haystack.match(manager.command);
    if (match) {
      const command = match[0].trim().replace(/[.]$/, "");
      return {
        command,
        spoken: `You can ${manager.spoken}`,
        fact: fact(
          repo,
          "install",
          `The README documents a ${manager.display} setup command: ${command}.`,
          `you can ${manager.spoken}`,
          0.85,
          "readme-code",
          "readme#install"
        ),
      };
    }
  }

  if (/docker compose|docker-compose up|docker run/i.test(haystack)) {
    return {
      command: "docker compose up -d",
      spoken: "you can bring it up with Docker Compose",
      fact: fact(
        repo,
        "install",
        "The README documents a Docker Compose setup.",
        "you can bring it up with Docker Compose",
        0.8,
        "readme-code",
        "readme#docker"
      ),
    };
  }

  if (/git clone/i.test(haystack) && section) {
    return {
      command: "git clone " + repo.html_url.replace("https://github.com/", ""),
      spoken: "you clone the repository and follow its setup steps",
      fact: fact(
        repo,
        "install",
        "The README documents a clone-and-build setup.",
        "you clone the repository and follow its setup steps",
        0.7,
        "readme-section",
        "readme#setup"
      ),
    };
  }

  if (section) {
    // A fenced command inside the setup section is stronger evidence than the
    // mere existence of the section, so quote it verbatim.
    const command = firstCommandIn(section);
    if (command) {
      return {
        command,
        spoken: `The README starts you with ${command}`,
        fact: fact(
          repo,
          "install",
          `The setup section starts with the command: ${command}.`,
          `the README starts you with the command ${command}`,
          0.75,
          "readme-code",
          `readme#${slug(section.heading)}`
        ),
      };
    }
    return {
      command: null,
      spoken: "the README has a setup section that walks you through it",
      fact: fact(
        repo,
        "install",
        "The README contains a setup section.",
        "the README has a setup section that walks you through it",
        0.6,
        "readme-section",
        `readme#${slug(section.heading)}`
      ),
    };
  }

  return { command: null, spoken: "", fact: null };
}

function firstCommandIn(section: ReadmeSection): string | null {
  const fences = section.body.match(/```[\s\S]*?```/g) ?? [];
  for (const block of fences) {
    const lines = block
      .replace(/^\s*```[a-z]*\s*$/i, "")
      .replace(/```\s*$/, "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      // Skip comments, prompts, markdown markers and output blocks.
      if (/^[#$>{*+\-\d]/.test(line)) continue;
      if (/\b(output|result|response|logs?):?\s*$/i.test(line)) continue;
      if (!/^[a-z0-9._/\\-]+\s+\S/i.test(line) && !/^\.\//.test(line)) continue;
      const cleaned = line.replace(/\s{2,}.*$/, "").trim();
      if (cleaned.length >= 4 && cleaned.length <= 90) return cleaned;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Hosting / cost — evidence-gated                                     */
/* ------------------------------------------------------------------ */

function hostingFact(repo: EnrichedRepo, parsed: ParsedReadme): Fact | null {
  const text = parsed.plainText.toLowerCase();
  const selfHosted =
    /\bself[- ]host(ed|ing)?\b/.test(text) ||
    /\bruns? (locally|on your (own )?machine|on[- ]prem(ise)?)\b/.test(text) ||
    /\bwithout (a )?(cloud|server|account)\b/.test(text);
  if (selfHosted) {
    return fact(
      repo,
      "requirement",
      "The README states it can be self-hosted or run locally.",
      "it is built to run on your own machine",
      0.75,
      "readme-section",
      "readme#self-hosting"
    );
  }
  return null;
}

function costFact(repo: EnrichedRepo, parsed: ParsedReadme): Fact | null {
  const text = parsed.plainText.toLowerCase();
  if (/\b(free tier|free plan|completely free|free and open)\b/.test(text)) {
    return fact(
      repo,
      "requirement",
      "The README describes the service as free.",
      "the project describes itself as free to use",
      0.7,
      "readme-section",
      "readme#pricing"
    );
  }
  if (/\b(pricing|paid plan|subscription|billing|per month|free trial|api key)\b/.test(text)) {
    return fact(
      repo,
      "requirement",
      "The README mentions pricing, a subscription, or an API key.",
      "its hosted service may involve a subscription or an API key",
      0.6,
      "readme-section",
      "readme#pricing"
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type BuildFactsOptions = {
  previousStars?: number | null;
  previousCapturedAt?: string | null;
};

export function buildFactLedger(
  repo: EnrichedRepo,
  options: BuildFactsOptions = {}
): FactLedger {
  const parsed = parseReadme(repo.readmeText);
  const facts: Fact[] = [];

  /* --- purpose --------------------------------------------------- */
  const description = repo.description?.trim() ?? "";
  if (description.length >= 12) {
    facts.push(
      fact(
        repo,
        "purpose",
        `The repository describes itself as: ${sentence(description)}.`,
        sentence(description),
        0.95,
        "api-field",
        "repo.description"
      )
    );
  } else {
    const overviewSentence = firstRealSentence(stripMarkdown(parsed.overview), 40);
    if (overviewSentence) {
      facts.push(
        fact(
          repo,
          "purpose",
          `The README overview states: ${overviewSentence}.`,
          sentence(overviewSentence),
          0.7,
          "readme-section",
          "readme#overview"
        )
      );
    }
  }

  /* --- features -------------------------------------------------- */
  const featureSection = sectionWithBullets(parsed, [
    /^(features?|capabilities|highlights|benefits?|why|what'?s inside|use ?cases?|tools?)/,
  ]);
  for (const bullet of bulletsOf(featureSection).slice(0, 4)) {
    facts.push(
      fact(
        repo,
        "feature",
        `README feature bullet: ${bullet}.`,
        bullet,
        0.7,
        "readme-section",
        `readme#${slug(featureSection!.heading)}`
      )
    );
  }

  /* --- usage / examples ----------------------------------------- */
  const usageSection = sectionMatching(parsed, [
    /^(usage|examples?|how to use|basic usage)/,
  ]);
  if (usageSection) {
    const usageSentence = firstRealSentence(stripMarkdown(usageSection.body), 40);
    // Skip navigational sentences: "visit our docs", "see the course". Those
    // are not use cases and would read as filler in the narration.
    if (
      usageSentence &&
      !/\b(visit|see|read|docs|documentation|course|tutorial|guide|learn)\b/i.test(
        usageSentence
      )
    ) {
      facts.push(
        fact(
          repo,
          "use_case",
          `README usage: ${usageSentence}.`,
          sentence(usageSentence),
          0.7,
          "readme-section",
          `readme#${slug(usageSection.heading)}`
        )
      );
    }
  }

  /* --- install --------------------------------------------------- */
  const install = extractInstall(repo, parsed);
  if (install.fact) facts.push(install.fact);

  /* --- license --------------------------------------------------- */
  if (repo.openSourceLicense) {
    facts.push(
      fact(
        repo,
        "license",
        `The GitHub API reports the ${repo.openSourceLicense} license.`,
        `it is released under the ${spdxToWords(repo.openSourceLicense)} license`,
        0.95,
        "api-field",
        "repo.license.spdx_id"
      )
    );
  } else if (repo.licenseSpdxId) {
    facts.push(
      fact(
        repo,
        "license",
        `The GitHub API reports a ${repo.licenseSpdxId} license.`,
        `it lists a ${repo.licenseSpdxId} license, so check the terms before you rely on it`,
        0.8,
        "api-field",
        "repo.license.spdx_id"
      )
    );
  }

  /* --- adoption -------------------------------------------------- */
  facts.push(
    fact(
      repo,
      "adoption",
      `The GitHub API reported ${repo.stargazers_count} stars and ${repo.forks_count} forks at capture time.`,
      `it has about ${formatCount(repo.stargazers_count)} stars on GitHub`,
      0.99,
      "api-field",
      "repo.stargazers_count"
    )
  );

  /* --- momentum (only with dated snapshots) ----------------------- */
  const previousStars = options.previousStars ?? null;
  const previousCapturedAt = options.previousCapturedAt ?? null;
  if (previousStars !== null && previousCapturedAt) {
    const elapsedDays = (Date.now() - Date.parse(previousCapturedAt)) / DAY;
    const delta = repo.stargazers_count - previousStars;
    if (Number.isFinite(elapsedDays) && elapsedDays >= 1 && delta > 0) {
      facts.push(
        fact(
          repo,
          "adoption",
          `Star count moved from ${previousStars} to ${repo.stargazers_count} between ${previousCapturedAt.slice(0, 10)} and ${repo.capturedAt.slice(0, 10)}.`,
          `it gained about ${formatCount(Math.round(delta / elapsedDays))} stars a day over the last ${Math.round(elapsedDays)} days`,
          0.85,
          "star-snapshot",
          `star-snapshots:${previousCapturedAt.slice(0, 10)}`
        )
      );
    }
  }

  /* --- activity --------------------------------------------------- */
  const pushedAt = repo.pushedAt ?? null;
  if (pushedAt) {
    const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(pushedAt)) / DAY));
    if (ageDays < 1) {
      facts.push(
        fact(
          repo,
          "activity",
          "The repository was pushed on the day it was captured.",
          "it was updated today",
          0.95,
          "api-field",
          "repo.pushed_at"
        )
      );
    } else if (ageDays <= 90) {
      facts.push(
        fact(
          repo,
          "activity",
          `The last push was ${ageDays} days before capture.`,
          `it was updated ${describeAge(ageDays)}`,
          0.95,
          "api-field",
          "repo.pushed_at"
        )
      );
    } else if (ageDays <= 545) {
      facts.push(
        fact(
          repo,
          "activity",
          `The last push was ${ageDays} days before capture.`,
          `the last commit landed ${describeAge(ageDays)}`,
          0.85,
          "api-field",
          "repo.pushed_at"
        )
      );
    }
  }

  /* --- release ---------------------------------------------------- */
  if (repo.latestRelease?.tag_name && repo.latestRelease.published_at) {
    const ageDays = Math.max(
      0,
      Math.round((Date.now() - Date.parse(repo.latestRelease.published_at)) / DAY)
    );
    facts.push(
      fact(
        repo,
        "release",
        `The latest GitHub release is ${repo.latestRelease.tag_name}, published ${ageDays} days before capture.`,
        `the latest tagged release is ${repo.latestRelease.tag_name}`,
        0.9,
        "release",
        "releases/latest"
      )
    );
  }

  /* --- requirements / hosting / cost ------------------------------ */
  const hosting = hostingFact(repo, parsed);
  if (hosting) facts.push(hosting);
  const cost = costFact(repo, parsed);
  if (cost) facts.push(cost);

  /* --- language ---------------------------------------------------- */
  if (repo.primaryLanguage) {
    facts.push(
      fact(
        repo,
        "language",
        `The repository's primary language is ${repo.primaryLanguage}.`,
        `it is written in ${repo.primaryLanguage}`,
        0.95,
        "api-field",
        "repo.language"
      )
    );
  }

  return {
    repositoryNodeId: repo.nodeId,
    fullName: repo.full_name,
    capturedAt: repo.capturedAt,
    facts,
  };
}

export function narratableFacts(ledger: FactLedger): Fact[] {
  return ledger.facts.filter(fact => fact.confidence >= FACT_CONFIDENCE_THRESHOLD);
}

export function factsOfKind(ledger: FactLedger, kind: FactKind): Fact[] {
  return narratableFacts(ledger).filter(fact => fact.kind === kind);
}

export function formatCount(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))} thousand`;
  }
  return String(value);
}

function describeAge(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function spdxToWords(spdx: string): string {
  switch (spdx) {
    case "MIT":
      return "MIT";
    case "Apache-2.0":
      return "Apache 2 point 0";
    case "BSD-3-Clause":
      return "three clause BSD";
    case "BSD-2-Clause":
      return "two clause BSD";
    case "GPL-3.0":
      return "GPL three";
    case "AGPL-3.0":
      return "AGPL three";
    case "MPL-2.0":
      return "Mozilla Public License 2 point 0";
    case "Unlicense":
      return "Unlicense";
    default:
      return spdx.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
}

export function unsupportedClaims(
  segments: { spokenText: string; factIds: string[] }[],
  ledger: FactLedger
): string[] {
  const known = new Set(ledger.facts.map(item => item.id));
  const problems: string[] = [];
  for (const segment of segments) {
    if (!segment.factIds.length) {
      problems.push(`segment "${truncate(segment.spokenText)}" cites no fact`);
      continue;
    }
    for (const id of segment.factIds) {
      if (!known.has(id)) {
        problems.push(`segment "${truncate(segment.spokenText)}" cites unknown fact "${id}"`);
      }
    }
  }
  return problems;
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}




