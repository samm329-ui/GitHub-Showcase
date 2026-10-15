import type { Repo } from "./github.js";

export type RepoFacts = {
  purpose: string;
  install: string;
  hosting: string;
  cost: string;
  license: string;
  stars: string;
  language: string;
};

export function buildRepoFacts(repo: Repo, readme: string): RepoFacts {
  const plain = readme
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const desc = repo.description?.trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g)?.map(s => s.trim()).filter(s => s.length > 24) ?? [];
  const purpose = cleanSentence(desc || sentences[0] || `${repo.full_name} is an open-source developer project`);
  const install = inferInstall(readme);
  const hosting = inferHosting(readme, plain);
  const cost = inferCost(readme, plain);
  const license = repo.license?.spdx_id || repo.license?.name || "No license detected";
  return {
    purpose,
    install,
    hosting,
    cost,
    license,
    stars: repo.stargazers_count.toLocaleString("en-US"),
    language: repo.language || "Not specified"
  };
}

export function makeScript(repo: Repo, readme: string): string {
  const f = buildRepoFacts(repo, readme);
  const hook = makeHook(repo, f.purpose);
  const purpose = trimWords(f.purpose, 16);
  const installLine = f.install;
  const accessLine = `${f.hosting}. ${f.cost}.`;
  const useCase = inferUseCase(repo, readme, f);
  const licenseLine = licenseVoiceLine(f.license);
  const parts = [
    hook,
    `${(repo.full_name.split("/").pop() ?? repo.full_name)} is ${purpose}.`,
    useCase ? `It is useful for ${useCase}.` : "",
    `To get started, ${installLine.charAt(0).toLowerCase() + installLine.slice(1)} ${accessLine}`,
    `${licenseLine} It has ${f.stars} GitHub stars, so it is worth a closer look.`
  ];
  return trimWords(parts.join(" ").replace(/\s+/g, " ").trim(), 45);
}

function makeHook(repo: Repo, purpose: string): string {
  const name = (repo.full_name.split("/").pop() ?? repo.full_name).replace(/[-_]/g, " ");
  const hooks = [
    `Found a tool worth knowing: ${name}.`,
    `This project could save you some serious time: ${name}.`,
    `Before you build this yourself, meet ${name}.`,
    `Here's an open-source project you might have missed: ${name}.`
  ];
  // Stable per-repository hook so repeated runs don't randomly change tone.
  const index = [...repo.full_name].reduce((n, c) => n + c.charCodeAt(0), 0) % hooks.length;
  return hooks[index];
}

function inferInstall(readme: string): string {
  const text = readme.toLowerCase();
  if (/docker compose|docker-compose/.test(text)) return "Run it with Docker Compose.";
  if (/pip install|pip3 install/.test(text)) return "Install it with pip.";
  if (/npm install|pnpm install|yarn install|bun install/.test(text)) return "Install it with the package manager shown in its README.";
  if (/cargo install|cargo build/.test(text)) return "Build or install it with Cargo.";
  if (/go install|go build/.test(text)) return "Build or install it with Go.";
  if (/git clone/.test(text)) return "Clone the repository and follow its setup steps.";
  if (/installation|getting started|quick start|setup/.test(text)) return "Follow the setup instructions in its README.";
  return "Check the README for installation steps.";
}

function inferHosting(readme: string, plain: string): string {
  const t = `${readme}\n${plain}`.toLowerCase();
  if (/self.hosted|self-host|run locally|local install|localhost|on your machine/.test(t)) return "It appears designed for local or self-hosted use";
  if (/hosted api|cloud service|sign up|dashboard|api key|access token/.test(t)) return "It may require a hosted service or credentials";
  return "The hosting model needs checking in the project documentation";
}

function inferCost(readme: string, plain: string): string {
  const t = `${readme}\n${plain}`.toLowerCase();
  if (/pricing|subscription|paid plan|billing|per month|per request/.test(t)) return "Check for paid tiers or usage fees";
  if (/free tier|free plan|open source/.test(t)) return "The code is presented as open source, but external service costs may apply";
  return "Pricing is not clearly established by the README";
}

function licenseVoiceLine(license: string): string {
  if (/^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC)$/i.test(license)) return `It lists the ${license} license.`;
  if (/no license detected/i.test(license)) return "No repository license was detected, so check the usage terms before using it.";
  return `Its listed license is ${license}. Check its terms before using it.`;
}

function inferUseCase(repo: Repo, readme: string, f: RepoFacts): string {
  const text = `${repo.description ?? ""}\n${readme}\n${f.purpose}`.toLowerCase();
  if (/self.hosted|run locally|docker/.test(text)) return "running your own instance where you control the data";
  if (/automat/.test(text)) return "automating repetitive developer or business workflows";
  if (/monito|metrics|observ/.test(text)) return "monitoring services and understanding system behavior";
  if (/cli|command line|terminal/.test(text)) return "command-line workflows and developer tooling";
  if (/web|dashboard|ui/.test(text)) return "building web-based tools and operational dashboards";
  if (/api|sdk|library/.test(text)) return "integrating the project into other applications";
  return "";
}

function cleanSentence(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
}

function trimWords(value: string, max: number): string {
  const words = value.split(/\s+/);
  if (words.length <= max) return value;
  return words.slice(0, max).join(" ").replace(/[,:;]$/, "") + ".";
}
