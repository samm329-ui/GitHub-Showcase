import type {
  EnrichedRepo,
  Fact,
  FactLedger,
  NarrationAngle,
  StorySlot,
  VisualAnchor,
} from "./types.js";
import { factsOfKind, narratableFacts } from "./facts.js";
import { toSpoken } from "./pronunciation.js";
import { ESTIMATED_WPM, MAX_REPEATED_TEMPLATE_USAGE } from "./config.js";

/**
 * Constrained story grammar.
 *
 * The script is not free-form prose. It is assembled from a small vocabulary of
 * clause types (hook, identity, value, proof, demo, setup, availability, caveat,
 * cta) whose order is monotonic. Each clause is bound to verified fact ids, so
 * no sentence can exist without evidence.
 *
 * Variation comes from choosing a different *structure* for the same evidence
 * and from rotating clause frames inside each slot. Nothing is randomised: the
 * same repository, attempt and usage history produce the same script.
 */

export type ClauseDraft = {
  /** Stable template id, used for debugging and reproducibility. */
  id: string;
  slot: StorySlot;
  spoken: string;
  caption?: string;
  factIds: string[];
  anchor?: VisualAnchor;
  emphasis?: string[];
  /** Optional clauses are dropped first when the word budget is tight. */
  optional?: boolean;
};

export type StoryContext = {
  repo: EnrichedRepo;
  ledger: FactLedger;
  seed: number;
  allFacts: Fact[];
  purpose: Fact | null;
  features: Fact[];
  useCases: Fact[];
  install: Fact | null;
  license: Fact | null;
  adoption: Fact | null;
  growth: Fact | null;
  activity: Fact | null;
  language: Fact | null;
  requirement: Fact | null;
  release: Fact | null;
};

export type StoryStructure = {
  key: string;
  angle: NarrationAngle;
  slots: StorySlot[];
  build(context: StoryContext): (ClauseDraft | null)[];
};

export type StoryBuildOptions = {
  ledger: FactLedger;
  repo: EnrichedRepo;
  angle: NarrationAngle;
  targetDurationSeconds: number;
  attemptCount?: number;
  seed?: number;
  recentUsage?: Map<string, number>;
};

export type StoryBuildResult = {
  structure: string;
  angle: NarrationAngle;
  clauses: ClauseDraft[];
  score: number;
};

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

export const SLOT_ORDER: StorySlot[] = [
  "hook",
  "identity",
  "value",
  "proof",
  "demo",
  "setup",
  "availability",
  "caveat",
  "cta",
];

const SLOT_RANK = new Map(SLOT_ORDER.map((slot, index) => [slot, index]));

/**
 * A clause may only move forward through the slot order. Repeated demo or
 * proof beats are allowed; going backwards (a second identity after the cta) is
 * not. This is the whole "constrained" part of the grammar.
 */
export function isTransitionAllowed(from: StorySlot, to: StorySlot): boolean {
  return (SLOT_RANK.get(to) ?? 0) >= (SLOT_RANK.get(from) ?? 0);
}

export function validateSlotSequence(slots: StorySlot[]): boolean {
  for (let index = 1; index < slots.length; index += 1) {
    if (!isTransitionAllowed(slots[index - 1], slots[index])) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

const ACRONYMS = new Set([
  "cli", "api", "ui", "ux", "sdk", "db", "sql", "gpu", "cpu", "css", "html",
  "json", "jsonl", "url", "urls", "ssh", "tls", "vm", "os", "tts", "llm",
  "http", "https", "xml", "yaml", "yml", "ci", "cd", "ide", "lsp", "orm",
  "rpc", "grpc", "jwt", "sso", "csv", "toml", "gpu", "aws", "gcp", "webgl",
]);

export function humaniseRepoName(name: string): string {
  return (
    name
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(token =>
        ACRONYMS.has(token.toLowerCase())
          ? token.toUpperCase()
          : token.charAt(0).toUpperCase() + token.slice(1)
      )
      .join(" ") || name
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!trimmed) return "";
  const prepared = capitalise(trimmed);
  return /[.!?]$/.test(prepared) ? prepared : `${prepared}.`;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function keyNumber(value: string): string {
  const match = value.match(/\d[\d,.]*\s*(?:thousand|million|stars|days?|hours?)?/i);
  return match ? match[0].trim() : "";
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export function createStoryContext(
  ledger: FactLedger,
  repo: EnrichedRepo,
  seed: number
): StoryContext {
  const first = (kind: Parameters<typeof factsOfKind>[1]) => factsOfKind(ledger, kind)[0] ?? null;
  const growth =
    ledger.facts.find(fact => fact.source.kind === "star-snapshot") ?? null;
  return {
    repo,
    ledger,
    seed,
    allFacts: narratableFacts(ledger),
    purpose: first("purpose"),
    features: factsOfKind(ledger, "feature"),
    useCases: factsOfKind(ledger, "use_case"),
    install: first("install"),
    license: first("license"),
    adoption: first("adoption"),
    growth,
    activity: first("activity"),
    language: first("language"),
    requirement: first("requirement"),
    release: first("release"),
  };
}

/* ------------------------------------------------------------------ */
/* Clause builders                                                     */
/* ------------------------------------------------------------------ */

function identity(context: StoryContext, frame: number): ClauseDraft | null {
  const fact = context.purpose ?? context.allFacts[0];
  if (!fact) return null;
  const name = humaniseRepoName(context.repo.name);
  const who = context.repo.owner;
  const leads = [
    `This is ${name}, by ${who}`,
    `${who} built ${name}`,
    `Meet ${name}, from ${who}`,
  ];
  return {
    id: `identity.${frame}`,
    slot: "identity",
    spoken: sentence(`${leads[frame % leads.length]}. ${fact.spoken}`),
    caption: sentence(`${leads[frame % leads.length]}. ${fact.spoken}`),
    factIds: [fact.id],
    anchor: "repo-header",
    emphasis: [name],
  };
}

function featureClause(
  feature: Fact | undefined,
  lead: string,
  slot: StorySlot,
  id: string,
  optional = false
): ClauseDraft | null {
  if (!feature) return null;
  return {
    id,
    slot,
    spoken: sentence(`${lead}: ${feature.spoken}`),
    factIds: [feature.id],
    anchor: "features",
    optional,
  };
}

function useCaseClause(context: StoryContext, lead: string): ClauseDraft | null {
  const fact = context.useCases[0];
  if (!fact) return null;
  return {
    id: "value.use-case",
    slot: "value",
    spoken: sentence(`${lead}: ${fact.spoken}`),
    factIds: [fact.id],
    anchor: "readme-intro",
    optional: true,
  };
}

function installClause(context: StoryContext): ClauseDraft | null {
  const fact = context.install;
  if (!fact) return null;
  return {
    id: "setup.install",
    slot: "setup",
    spoken: sentence(`To try it, ${fact.spoken.replace(/^you can /i, "you can ")}`),
    factIds: [fact.id],
    anchor: "install-command",
    emphasis: ["install"],
    optional: true,
  };
}

function licenseClause(context: StoryContext): ClauseDraft | null {
  const fact = context.license;
  if (!fact) return null;
  return {
    id: "availability.license",
    slot: "availability",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    anchor: "license",
    optional: true,
  };
}

function releaseClause(context: StoryContext): ClauseDraft | null {
  const fact = context.release;
  if (!fact) return null;
  return {
    id: "availability.release",
    slot: "availability",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    anchor: "release",
    optional: true,
  };
}

function adoptionClause(context: StoryContext): ClauseDraft | null {
  const fact = context.growth ?? context.adoption;
  if (!fact) return null;
  const lead = context.growth ? "The numbers are moving" : "For context";
  return {
    id: context.growth ? "proof.growth" : "proof.adoption",
    slot: "proof",
    spoken: sentence(`${lead}: ${fact.spoken}`),
    factIds: [fact.id],
    emphasis: [keyNumber(fact.spoken)].filter(Boolean),
    optional: true,
  };
}

function activityClause(context: StoryContext): ClauseDraft | null {
  const fact = context.activity;
  if (!fact) return null;
  return {
    id: "proof.activity",
    slot: "proof",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    optional: true,
  };
}

function languageClause(context: StoryContext): ClauseDraft | null {
  const fact = context.language;
  if (!fact) return null;
  return {
    id: "proof.language",
    slot: "proof",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    optional: true,
  };
}

function caveatClause(context: StoryContext): ClauseDraft | null {
  const fact = context.requirement;
  if (!fact) return null;
  return {
    id: "caveat.requirement",
    slot: "caveat",
    spoken: sentence(`One thing to know: ${fact.spoken}`),
    factIds: [fact.id],
    optional: true,
  };
}

function ctaClause(context: StoryContext): ClauseDraft | null {
  const fact = context.purpose ?? context.allFacts[0];
  if (!fact) return null;
  return {
    id: "cta.readme",
    slot: "cta",
    spoken: sentence("The README is the place to start if you want the details"),
    factIds: [fact.id],
    optional: true,
  };
}

/* ------------------------------------------------------------------ */
/* Structures                                                          */
/* ------------------------------------------------------------------ */

function compact(items: (ClauseDraft | null)[]): ClauseDraft[] {
  return items.filter((item): item is ClauseDraft => Boolean(item && item.spoken));
}

const STRUCTURES: StoryStructure[] = [
  /* ------------------------- quick tour -------------------------- */
  {
    key: "quick-tour.utility-first",
    angle: "quick-tour",
    slots: ["identity", "value", "demo", "setup", "availability"],
    build(context) {
      return compact([
        identity(context, 0),
        featureClause(context.features[0], "The core of it", "value", "value.core"),
        featureClause(context.features[1], "It also", "demo", "demo.second", true),
        installClause(context),
        licenseClause(context),
      ]);
    },
  },
  {
    key: "quick-tour.feature-tour",
    angle: "quick-tour",
    slots: ["identity", "demo", "demo", "proof", "setup", "cta"],
    build(context) {
      return compact([
        identity(context, 1),
        featureClause(context.features[0], "First", "demo", "demo.first"),
        featureClause(context.features[1], "Then", "demo", "demo.second", true),
        activityClause(context),
        installClause(context),
        ctaClause(context),
      ]);
    },
  },
  {
    key: "quick-tour.problem-solution",
    angle: "quick-tour",
    slots: ["identity", "value", "demo", "proof", "setup", "availability"],
    build(context) {
      return compact([
        identity(context, 2),
        featureClause(context.features[0], "What you get", "value", "value.core"),
        featureClause(context.features[2], "On top of that", "demo", "demo.third", true),
        adoptionClause(context),
        installClause(context),
        licenseClause(context),
      ]);
    },
  },

  /* ------------------------- try it ------------------------------ */
  {
    key: "try-it.quickstart",
    angle: "try-it",
    slots: ["identity", "value", "setup", "demo", "availability"],
    build(context) {
      return compact([
        identity(context, 0),
        featureClause(context.features[0], "The short version", "value", "value.core"),
        installClause(context),
        featureClause(context.features[1], "Once it runs", "demo", "demo.second", true),
        releaseClause(context) ?? licenseClause(context),
      ]);
    },
  },
  {
    key: "try-it.setup-first",
    angle: "try-it",
    slots: ["identity", "setup", "value", "demo", "cta"],
    build(context) {
      return compact([
        identity(context, 2),
        installClause(context),
        featureClause(context.features[0], "What it does", "value", "value.core"),
        featureClause(context.features[1], "And", "demo", "demo.second", true),
        ctaClause(context),
      ]);
    },
  },

  /* ------------------------- workflow ---------------------------- */
  {
    key: "workflow.pipeline",
    angle: "developer-workflow",
    slots: ["identity", "value", "demo", "proof", "setup", "cta"],
    build(context) {
      return compact([
        identity(context, 1),
        featureClause(context.features[0], "Step one", "value", "value.core"),
        featureClause(context.features[1], "Step two", "demo", "demo.second", true),
        useCaseClause(context, "In a real workflow"),
        languageClause(context),
        installClause(context),
        ctaClause(context),
      ]);
    },
  },
  {
    key: "workflow.day",
    angle: "developer-workflow",
    slots: ["identity", "value", "demo", "availability", "cta"],
    build(context) {
      return compact([
        identity(context, 2),
        useCaseClause(context, "Where it fits"),
        featureClause(context.features[0], "Concretely", "demo", "demo.first"),
        licenseClause(context),
        ctaClause(context),
      ]);
    },
  },

  /* ------------------------- underdog ---------------------------- */
  {
    key: "underdog.measured",
    angle: "under-the-radar",
    slots: ["identity", "proof", "value", "setup", "availability"],
    build(context) {
      return compact([
        identity(context, 1),
        adoptionClause(context),
        featureClause(context.features[0], "What it does", "value", "value.core"),
        installClause(context),
        licenseClause(context),
      ]);
    },
  },
  {
    key: "underdog.quiet",
    angle: "under-the-radar",
    slots: ["identity", "value", "proof", "demo", "cta"],
    build(context) {
      return compact([
        identity(context, 2),
        featureClause(context.features[0], "The useful part", "value", "value.core"),
        adoptionClause(context),
        featureClause(context.features[1], "And", "demo", "demo.second", true),
        ctaClause(context),
      ]);
    },
  },

  /* ------------------------- popular ----------------------------- */
  {
    key: "popular.context",
    angle: "mature-and-popular",
    slots: ["identity", "value", "proof", "setup", "cta"],
    build(context) {
      return compact([
        identity(context, 1),
        featureClause(context.features[0], "The useful part", "value", "value.core"),
        adoptionClause(context),
        installClause(context),
        ctaClause(context),
      ]);
    },
  },
  {
    key: "popular.proof",
    angle: "mature-and-popular",
    slots: ["identity", "proof", "demo", "setup", "availability"],
    build(context) {
      return compact([
        identity(context, 0),
        adoptionClause(context),
        featureClause(context.features[1] ?? context.features[0], "Concretely", "demo", "demo.first"),
        installClause(context),
        releaseClause(context) ?? licenseClause(context),
      ]);
    },
  },

  /* ------------------------- trade-off --------------------------- */
  {
    key: "trade-off.balanced",
    angle: "trade-off",
    slots: ["identity", "value", "demo", "caveat", "setup", "cta"],
    build(context) {
      return compact([
        identity(context, 0),
        featureClause(context.features[0], "The draw", "value", "value.core"),
        featureClause(context.features[1], "It also", "demo", "demo.second", true),
        caveatClause(context),
        installClause(context),
        ctaClause(context),
      ]);
    },
  },
  {
    key: "trade-off.direct",
    angle: "trade-off",
    slots: ["identity", "value", "setup", "caveat", "availability"],
    build(context) {
      return compact([
        identity(context, 1),
        featureClause(context.features[0], "What you get", "value", "value.core"),
        installClause(context),
        caveatClause(context),
        licenseClause(context),
      ]);
    },
  },

  /* ------------------------- plain ------------------------------- */
  {
    key: "plain.direct",
    angle: "what-it-does",
    slots: ["identity", "value", "proof", "setup", "availability"],
    build(context) {
      return compact([
        identity(context, 0),
        featureClause(context.features[0], "The short version", "value", "value.core") ??
          useCaseClause(context, "In practice"),
        languageClause(context),
        installClause(context),
        licenseClause(context),
      ]);
    },
  },
  {
    key: "plain.quiet",
    angle: "what-it-does",
    slots: ["identity", "value", "proof", "cta"],
    build(context) {
      return compact([
        identity(context, 2),
        featureClause(context.features[0], "What it gives you", "value", "value.core"),
        activityClause(context),
        ctaClause(context),
      ]);
    },
  },
  {
    key: "plain.benefit",
    angle: "what-it-does",
    slots: ["identity", "value", "demo", "proof", "cta"],
    build(context) {
      return compact([
        identity(context, 1),
        useCaseClause(context, "Where it fits") ??
          featureClause(context.features[0], "The useful part", "value", "value.core"),
        featureClause(context.features[0], "And", "demo", "demo.first", true),
        languageClause(context),
        ctaClause(context),
      ]);
    },
  },
];

export function structuresForAngle(angle: NarrationAngle): StoryStructure[] {
  const matches = STRUCTURES.filter(structure => structure.angle === angle);
  return matches.length > 0
    ? matches
    : STRUCTURES.filter(structure => structure.angle === "what-it-does");
}

/**
 * Rotate through the eligible structures. `attemptCount` guarantees that a
 * retry does not repeat the same shape even when the hash and usage history are
 * unchanged; `recentUsage` still vetoes a template that has been used twice.
 */
export function chooseStructure(
  angle: NarrationAngle,
  recentUsage: Map<string, number> = new Map(),
  attemptCount = 0
): StoryStructure {
  const pool = structuresForAngle(angle);
  const start = Math.max(0, attemptCount) % pool.length;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(start + offset) % pool.length];
    if ((recentUsage.get(candidate.key) ?? 0) < MAX_REPEATED_TEMPLATE_USAGE) {
      return candidate;
    }
  }
  return pool[start];
}

/* ------------------------------------------------------------------ */
/* Budget + top-up                                                     */
/* ------------------------------------------------------------------ */

function uniqueFacts(clauses: ClauseDraft[], seedClauses: ClauseDraft[] = []): Set<string> {
  return new Set([...seedClauses, ...clauses].flatMap(clause => clause.factIds));
}

function optionalPool(context: StoryContext, used: Set<string>): ClauseDraft[] {
  const pool: (ClauseDraft | null)[] = [
    useCaseClause(context, "In practice"),
    ...context.features.map((feature, index) =>
      featureClause(feature, index === 0 ? "Also" : "And", "demo", `demo.extra-${index}`, true)
    ),
    languageClause(context),
    activityClause(context),
    adoptionClause(context),
    releaseClause(context),
    licenseClause(context),
    caveatClause(context),
    installClause(context),
    ctaClause(context),
  ];
  return compact(pool).filter(
    clause =>
      clause.factIds.length > 0 &&
      !clause.factIds.some(id => used.has(id))
  );
}

function sortBySlot(clauses: ClauseDraft[]): ClauseDraft[] {
  return clauses
    .map((clause, index) => ({ clause, index }))
    .sort((a, b) => {
      const rank =
        (SLOT_RANK.get(a.clause.slot) ?? 0) - (SLOT_RANK.get(b.clause.slot) ?? 0);
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map(item => item.clause);
}

function prepareClause(clause: ClauseDraft): ClauseDraft {
  return {
    ...clause,
    caption: clause.caption ?? clause.spoken,
    spoken: toSpoken(clause.spoken),
  };
}

/**
 * Respect the word budget:
 *  - drop optional clauses from the end until the script fits the hard maximum;
 *  - add verified optional detail (new facts only) while it still fits and the
 *    target has room.
 *
 * Clauses are measured after pronunciation substitution, because "CLI" becomes
 * three spoken words and that is what TTS actually receives.
 */
function fitBudget(
  clauses: ClauseDraft[],
  context: StoryContext,
  targetDurationSeconds: number
): ClauseDraft[] {
  const maxWords = Math.floor((targetDurationSeconds / 60) * ESTIMATED_WPM);
  const desired = Math.min(maxWords, Math.max(24, Math.round(maxWords * 0.9)));

  let drafts = clauses.map(prepareClause);
  let guard = 0;
  while (words(drafts.map(clause => clause.spoken).join(" ")) > maxWords && guard < 20) {
    guard += 1;
    const index = findLastOptional(drafts);
    if (index < 0) break;
    drafts.splice(index, 1);
  }

  const used = uniqueFacts(drafts);
  const spare = optionalPool(context, used).map(prepareClause);
  guard = 0;
  while (
    words(drafts.map(clause => clause.spoken).join(" ")) < desired &&
    spare.length > 0 &&
    guard < 20
  ) {
    guard += 1;
    const addition = spare.shift()!;
    const grown = words(
      [...drafts, addition].map(clause => clause.spoken).join(" ")
    );
    if (grown > maxWords) continue;
    if (addition.factIds.some(id => used.has(id))) continue;
    addition.factIds.forEach(id => used.add(id));
    drafts.push(addition);
  }

  return sortBySlot(drafts);
}

function findLastOptional(drafts: ClauseDraft[]): number {
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    if (drafts[index].optional) return index;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

function scoreStory(clauses: ClauseDraft[], targetDurationSeconds: number): number {
  const total = Math.max(1, clauses.length);
  const facts = new Set(clauses.flatMap(clause => clause.factIds));
  const coverage = facts.size / total;
  const specificity =
    clauses.filter(clause => /\d|[A-Z][a-z]+[A-Z]/.test(clause.spoken)).length / total;
  const targetWords = Math.max(1, (targetDurationSeconds / 60) * ESTIMATED_WPM);
  const actual = words(clauses.map(clause => clause.spoken).join(" "));
  const durationFit = Math.max(0, 1 - Math.abs(actual - targetWords) / targetWords);
  const opening = clauses[0]?.slot === "identity" ? 1 : 0;
  const score = 0.45 * coverage + 0.2 * specificity + 0.25 * durationFit + 0.1 * opening;
  return Math.round(score * 100);
}

export function buildStory(options: StoryBuildOptions): StoryBuildResult {
  const seed = options.seed ?? 0;
  const context = createStoryContext(options.ledger, options.repo, seed);
  const structure = chooseStructure(
    options.angle,
    options.recentUsage ?? new Map(),
    options.attemptCount ?? 0
  );

  const built = compact(structure.build(context));
  let clauses = sortBySlot(built);
  if (!validateSlotSequence(clauses.map(clause => clause.slot))) {
    // The builders are authored against the slot order, but a future edit that
    // breaks it must not produce a rambling script.
    clauses = sortBySlot(clauses);
  }
  // A fact may anchor at most two clauses (the opening and the closing call to
  // action normally share the purpose fact); never three.
  const seen = new Map<string, number>();
  clauses = clauses.filter(clause => {
    if (
      clause.factIds.some(id => (seen.get(id) ?? 0) >= 2)
    ) {
      return false;
    }
    clause.factIds.forEach(id => seen.set(id, (seen.get(id) ?? 0) + 1));
    return true;
  });

  clauses = fitBudget(clauses, context, options.targetDurationSeconds);

  return {
    structure: structure.key,
    angle: options.angle,
    clauses,
    score: scoreStory(clauses, options.targetDurationSeconds),
  };
}
