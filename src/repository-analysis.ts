import type { EnrichedRepo, FactLedger, FactSemantic } from "./types.js";
import { parseReadme, type ParsedReadme } from "./facts.js";
import { EVIDENCE_STRENGTH_FLOOR } from "./config.js";

/**
 * Deterministic project analysis (Pass A).
 *
 * Detects what kind of project this is — and therefore which *operations* it
 * can credibly claim — using manifests, root entries, README structure and
 * documented examples. The rule that keeps this honest: a category signal
 * only ever unlocks operations that are additionally gated on extracted
 * evidence semantics. A `package.json` alone never buys an "import it into
 * your code" claim; an import example in the README does.
 */

export type RepositoryCategory =
  | "cli"
  | "library"
  | "browser-extension"
  | "github-action"
  | "developer-app"
  | "database"
  | "unknown";

/** One operation a category can support, gated on evidence semantics. */
export type CategoryOperation = {
  id: string;
  /** What the operation means, phrased so a composer may quote it. */
  description: string;
  /** At least one of these semantic roles must exist in the ledger. */
  requiresAny: FactSemantic[];
};

export type CategoryAdapter = {
  category: RepositoryCategory;
  /** Returns a detection signal string when this adapter claims the repo. */
  detect(repo: EnrichedRepo, parsed: ParsedReadme): string | null;
  operations: CategoryOperation[];
};

export type RepositoryAnalysis = {
  category: RepositoryCategory;
  /** Why the category was chosen (empty when unknown). */
  signals: string[];
  /** Operations backed by both the category and real evidence. */
  supported: CategoryOperation[];
  /** Operations the category supports in principle, blocked by missing evidence. */
  unsupported: { id: string; reason: string }[];
};

const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "ksh",
  "console",
  "terminal",
  "shellsession",
  "powershell",
  "pwsh",
  "ps1",
  "cmd",
  "batch",
]);

function rootHas(repo: EnrichedRepo, pattern: RegExp): boolean {
  return repo.rootFiles.some(entry => pattern.test(entry.name));
}

function rootDirHas(repo: EnrichedRepo, pattern: RegExp): boolean {
  return repo.rootFiles.some(entry => entry.type === "dir" && pattern.test(entry.name));
}

function topicsMatch(repo: EnrichedRepo, pattern: RegExp): boolean {
  return repo.topics.some(topic => pattern.test(topic));
}

function readmeHas(repo: EnrichedRepo, pattern: RegExp): boolean {
  return pattern.test(repo.readmeText ?? "");
}

/** Count of command-like lines inside shell-declared code fences. */
function shellCommandCount(parsed: ParsedReadme): number {
  let count = 0;
  for (const section of parsed.sections) {
    section.codeBlocks.forEach((block, index) => {
      const lang = (section.codeLangs?.[index] ?? "").toLowerCase();
      if (!SHELL_LANGS.has(lang)) return;
      for (const raw of block.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^[#$>{*+\-\d]/.test(line)) continue;
        if (!/^[a-z0-9._/\\-]+\s+\S/i.test(line) && !/^\.\//.test(line)) continue;
        count += 1;
      }
    });
  }
  return count;
}

function hasCommandTable(parsed: ParsedReadme): boolean {
  return parsed.tables.some(table => {
    const headerText = table.headers.join(" ").toLowerCase();
    return (
      /\bcommand\b/.test(headerText) ||
      (/\b(what it does|description|purpose)\b/.test(headerText) &&
        /\b(command|flag|option|script|usage|name)\b/.test(headerText))
    );
  });
}

function hasManifest(repo: EnrichedRepo, name: string): boolean {
  return repo.rootFiles.some(entry => entry.type === "file" && entry.name === name);
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/*                                                                     */
/* Order matters: unambiguous manifests first, then structural signals. */
/* ------------------------------------------------------------------ */

const githubActionAdapter: CategoryAdapter = {
  category: "github-action",
  detect(repo, parsed) {
    if (rootHas(repo, /^action\.ya?ml$/)) return "the repository ships an action manifest";
    if (topicsMatch(repo, /github-actions?/)) return "the topics mark it as a GitHub Action";
    if (readmeHas(repo, /\buses:\s*[\w.-]+\/[\w.-]+@/)) {
      return "the README shows a uses: reference";
    }
    void parsed;
    return null;
  },
  operations: [
    {
      id: "action.add",
      description: "adding it as a step in a workflow",
      requiresAny: ["workflow", "example"],
    },
  ],
};

const browserExtensionAdapter: CategoryAdapter = {
  category: "browser-extension",
  detect(repo, parsed) {
    const manifest = hasManifest(repo, "manifest.json");
    const browserSignal =
      topicsMatch(repo, /(browser|chrome|firefox|web)-?extension/) ||
      readmeHas(repo, /(chrome web store|firefox add-?ons|browser extension|edge add-?ons)/);
    if (manifest && browserSignal) return "a browser manifest plus store/browser mentions";
    if (manifest && parsed.headings.some(h => /install/.test(h))) {
      return "a browser manifest in the repository root";
    }
    return null;
  },
  operations: [
    {
      id: "ext.install",
      description: "installing it in the browser",
      requiresAny: ["setup", "example"],
    },
    {
      id: "ext.use",
      description: "using it while you browse",
      requiresAny: ["example", "workflow", "mechanism"],
    },
  ],
};

const databaseAdapter: CategoryAdapter = {
  category: "database",
  detect(repo, parsed) {
    if (rootHas(repo, /\.sql$/) || rootDirHas(repo, /^(migrations?|schema|db)$/)) {
      return "the repository contains schema or migration files";
    }
    if (topicsMatch(repo, /(database|sql|migrations?|postgres|mysql|sqlite|mongodb)/)) {
      return "the topics mark it as a database project";
    }
    if (parsed.headings.some(h => /^(schema|migrations?|data model)/.test(h))) {
      return "the README documents a schema or migrations";
    }
    return null;
  },
  operations: [
    {
      id: "db.apply",
      description: "applying its schema or migrations",
      requiresAny: ["workflow", "example", "mechanism"],
    },
  ],
};

const cliAdapter: CategoryAdapter = {
  category: "cli",
  detect(repo, parsed) {
    if (topicsMatch(repo, /^(cli|command-line|terminal|console)$/)) {
      return "the topics mark it as a command-line tool";
    }
    if (hasCommandTable(parsed) && shellCommandCount(parsed) >= 2) {
      return "the README documents commands and shows shell usage";
    }
    if (
      readmeHas(
        repo,
        /(npm (install|i|add) -g|yarn global add|pnpm add -g|cargo install|go install|pipx? install|brew install|choco install|dotnet tool install|gem install)/
      ) &&
      shellCommandCount(parsed) >= 2
    ) {
      return "the README shows a global install and shell usage";
    }
    return null;
  },
  operations: [
    {
      id: "cli.install",
      description: "installing it from a package manager",
      requiresAny: ["setup"],
    },
    {
      id: "cli.run",
      description: "running its documented commands",
      requiresAny: ["workflow", "example"],
    },
  ],
};

const libraryAdapter: CategoryAdapter = {
  category: "library",
  detect(repo, parsed) {
    if (topicsMatch(repo, /(library|sdk|api-client|package|npm)/)) {
      return "the topics mark it as a library";
    }
    const hasPackageManifest = rootHas(
      repo,
      /^(package\.json|Cargo\.toml|pyproject\.toml|setup\.py|go\.mod|.*\.csproj|Gemfile|composer\.json|pom\.xml|build\.gradle)$/
    );
    const importsCode = parsed.codeBlocks.some(block =>
      /^\s*(import\s+\w|\w+\s*=\s*require\(|from\s+[\w.]+\s+import\s|require\()/.test(block)
    );
    if (hasPackageManifest && importsCode) {
      return "a package manifest plus import examples in the README";
    }
    return null;
  },
  operations: [
    {
      id: "lib.install",
      description: "adding it to your project",
      requiresAny: ["setup"],
    },
    {
      id: "lib.import",
      description: "importing it into your own code",
      requiresAny: ["workflow", "example"],
    },
  ],
};

const developerAppAdapter: CategoryAdapter = {
  category: "developer-app",
  detect(repo, parsed) {
    if (
      (rootHas(repo, /^(docker-compose\.ya?ml|Dockerfile|Procfile)$/ ) &&
        readmeHas(repo, /(docker compose|docker-compose|localhost|127\.0\.0\.1|npm run (dev|start)|pnpm dev|yarn dev)/)) ||
      readmeHas(repo, /(npm run (dev|start)|pnpm dev|yarn dev|localhost:\d+)/)
    ) {
      return "the README documents running it locally";
    }
    if (topicsMatch(repo, /(web-app|dashboard|website|server|saas|frontend|backend)/)) {
      return "the topics mark it as a runnable application";
    }
    return null;
  },
  operations: [
    {
      id: "app.run",
      description: "running it locally",
      requiresAny: ["setup", "workflow"],
    },
    {
      id: "app.use",
      description: "using it once it runs",
      requiresAny: ["example", "workflow", "mechanism"],
    },
  ],
};

/**
 * First non-null detection wins. Unambiguous manifests (action.yml,
 * manifest.json) are checked before usage-structure heuristics so a GitHub
 * Action that also has a package.json is not classified as a library.
 */
const ADAPTERS: CategoryAdapter[] = [
  githubActionAdapter,
  browserExtensionAdapter,
  databaseAdapter,
  cliAdapter,
  libraryAdapter,
  developerAppAdapter,
];

/**
 * Classify the repository and enumerate the operations its evidence supports.
 *
 * An operation is "supported" only when both gates pass: the category adapter
 * claims the project *and* the fact ledger carries at least one of the
 * operation's required semantics above the evidence floor. Unsupported
 * operations are reported with an explicit reason so the planner can record
 * an omission instead of inventing the claim.
 */
export function analyzeRepository(
  repo: EnrichedRepo,
  ledger: FactLedger,
  parsed: ParsedReadme = parseReadme(repo.readmeText)
): RepositoryAnalysis {
  let adapter: CategoryAdapter | null = null;
  let signal = "";
  for (const candidate of ADAPTERS) {
    const detected = candidate.detect(repo, parsed);
    if (detected) {
      adapter = candidate;
      signal = detected;
      break;
    }
  }

  if (!adapter) {
    return { category: "unknown", signals: [], supported: [], unsupported: [] };
  }

  const semantics = new Set(
    ledger.facts
      .filter(fact => fact.confidence >= EVIDENCE_STRENGTH_FLOOR && fact.semantic)
      .map(fact => fact.semantic!)
  );

  const supported: CategoryOperation[] = [];
  const unsupported: { id: string; reason: string }[] = [];
  for (const operation of adapter.operations) {
    const matched = operation.requiresAny.filter(role => semantics.has(role));
    if (matched.length > 0) {
      supported.push(operation);
    } else {
      unsupported.push({
        id: operation.id,
        reason: `no ${operation.requiresAny.join(" or ")} evidence in the ledger`,
      });
    }
  }

  return {
    category: adapter.category,
    signals: [signal],
    supported,
    unsupported,
  };
}
