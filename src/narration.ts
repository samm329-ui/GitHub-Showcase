import type {
  EnrichedRepo,
  Fact,
  FactLedger,
  NarrationAngle,
  NarrationPlan,
  NarrationSegment,
  ScriptValidation,
  SegmentPurpose,
  VisualAnchor,
} from "./types.js";
import {
  ESTIMATED_WPM,
  MAX_DURATION_SECONDS,
  MAX_REPEATED_TEMPLATE_USAGE,
  MIN_DURATION_SECONDS,
  TARGET_DURATION_SECONDS,
} from "./config.js";
import {
  bulletsOf,
  factsOfKind,
  formatCount,
  narratableFacts,
  parseReadme,
  sectionWithBullets,
} from "./facts.js";
import { toSpoken } from "./pronunciation.js";

/**
 * Narration generation without an LLM.
 *
 * The script is assembled from a typed fact ledger using reviewed sentence
 * patterns. Variation comes from *choosing a different pattern* based on the
 * repository's evidence and on recent usage — never from shuffling synonyms.
 * Anything that cannot be traced to a fact is never said.
 */

/* ------------------------------------------------------------------ */
/* Boilerplate guard                                                   */
/* ------------------------------------------------------------------ */

const BANNED_PHRASES = [
  "game changer",
  "revolutionary",
  "super powerful",
  "you need to check this out",
  "in today's video",
  "in this video",
  "must have",
  "hidden gem",
  "mind blowing",
  "next level",
  "blazing fast",
  "seamlessly",
  "effortlessly",
  "cutting edge",
  "world class",
  "best tool",
  "the best",
  "fastest",
];

export function findBoilerplate(text: string): string[] {
  const lowered = text.toLowerCase();
  return BANNED_PHRASES.filter(phrase => lowered.includes(phrase));
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function estimateSeconds(words: number): number {
  return (words / ESTIMATED_WPM) * 60;
}

/** Stable 32-bit hash so a repository keeps the same variant across runs. */
export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Pick one index, honouring how recently each template was used. `recentUsage`
 * maps template key -> number of recent runs it appeared in.
 */
export function pickVariant<T>(
  keys: string[],
  recentUsage: Map<string, number>,
  seed: number
): { key: string; index: number } {
  const eligible = keys.filter(
    key => (recentUsage.get(key) ?? 0) < MAX_REPEATED_TEMPLATE_USAGE
  );
  const pool = eligible.length > 0 ? eligible : keys;
  const index = seed % pool.length;
  return { key: pool[index], index };
}

export type PhraseHistory = Map<string, number>;

/* ------------------------------------------------------------------ */
/* Angle selection                                                     */
/* ------------------------------------------------------------------ */

export type AngleDecision = {
  angle: NarrationAngle;
  reason: string;
  templateKeys: string[];
};

export function selectAngle(
  ledger: FactLedger,
  repo: EnrichedRepo
): AngleDecision {
  const features = factsOfKind(ledger, "feature");
  const install = factsOfKind(ledger, "install");
  const useCases = factsOfKind(ledger, "use_case");
  const momentum = ledger.facts.filter(
    fact => fact.source.kind === "star-snapshot"
  );
  const limitations = factsOfKind(ledger, "requirement");

  if (limitations.length >= 1 && features.length >= 2) {
    return {
      angle: "trade-off",
      reason: "the README states a constraint worth mentioning alongside the features",
      templateKeys: ["trade-off.direct", "trade-off.balanced"],
    };
  }
  if (install.length >= 1 && features.length <= 2) {
    return {
      angle: "try-it",
      reason: "a verified setup path exists and the feature list is short",
      templateKeys: ["try-it.setup-first", "try-it.inverse-brief"],
    };
  }
  if (features.length >= 2) {
    return {
      angle: "quick-tour",
      reason: `${features.length} documented features are available to describe`,
      templateKeys: [
        "quick-tour.two-features",
        "quick-tour.tour-from-list",
        "quick-tour.capability",
      ],
    };
  }
  if (momentum.length >= 1 && repo.stargazers_count < 20000) {
    return {
      angle: "under-the-radar",
      reason: "dated star snapshots exist, so measured growth can be stated",
      templateKeys: [
        "under-the-radar.measured-growth",
        "under-the-radar.small-and-moving",
      ],
    };
  }
  if (momentum.length >= 1) {
    return {
      angle: "mature-and-popular",
      reason: "measured growth and meaningful adoption are both available",
      templateKeys: ["mature-popular.context", "mature-popular.first"],
    };
  }
  if (useCases.length >= 1) {
    return {
      angle: "developer-workflow",
      reason: "the README documents a concrete workflow",
      templateKeys: [
        "workflow.instead-of",
        "workflow.placed-in-day",
        "workflow.pipeline",
      ],
    };
  }
  return {
    angle: "what-it-does",
    reason: "only a purpose statement is well supported by the evidence",
    templateKeys: [
      "what-it-does.direct",
      "what-it-does.plain",
      "what-it-does.quiet",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Segment construction                                                */
/* ------------------------------------------------------------------ */

type Draft = {
  purpose: SegmentPurpose;
  spoken: string;
  caption?: string;
  factIds: string[];
  anchor?: VisualAnchor;
  emphasis?: string[];
  pauseAfterMs?: number;
  /** Optional segments are dropped first when the script is too long. */
  optional?: boolean;
};

/** Acronyms that must stay upper-case when a repository name is humanised. */
const ACRONYMS = new Set([
  "cli", "api", "ui", "ux", "sdk", "db", "sql", "gpu", "cpu", "css", "html",
  "json", "jsonl", "url", "urls", "ssh", "tls", "vm", "os", "tts", "llm",
  "http", "https", "xml", "yaml", "yml", "ci", "cd", "ide", "lsp", "orm",
  "rpc", "grpc", "jwt", "sso", "csv", "toml", "gpu", "aws", "gcp", "webgl",
]);

/**
 * Humanise a repository name for speech: "rocket-cli" -> "Rocket CLI".
 * Dots are preserved so "Next.js" is not mangled into "Next JS".
 */
export function niceRepoName(name: string): string {
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

function displayName(repo: EnrichedRepo): string {
  return niceRepoName(repo.name);
}

function owner(repo: EnrichedRepo): string {
  return repo.owner;
}

function withSpoken(text: string): string {
  return toSpoken(text);
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!trimmed) return "";
  // Fact `spoken` values are authored as sentence fragments ("it is released
  // under ..."), so the first letter is lifted when they stand alone.
  const prepared = capitalizeFirst(trimmed);
  return /[.!?]$/.test(prepared) ? prepared : `${prepared}.`;
}

function licenseLine(ledger: FactLedger): Draft | null {
  const license = factsOfKind(ledger, "license");
  if (license.length === 0) return null;
  const fact = license[0];
  return {
    purpose: "license",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    anchor: "license",
    emphasis: [],
    optional: true,
  };
}

function adoptionLine(ledger: FactLedger, seed: number): Draft | null {
  const adoption = factsOfKind(ledger, "adoption");
  const growth = ledger.facts.filter(fact => fact.source.kind === "star-snapshot");
  if (growth.length >= 1) {
    const fact = growth[0];
    return {
      purpose: "adoption",
      spoken: sentence(fact.spoken),
      factIds: [fact.id],
      emphasis: [extractKeyNumber(fact.spoken)],
      optional: true,
    };
  }
  if (adoption.length >= 1) {
    const fact = adoption[0];
    const frames = [
      `Worth knowing: ${fact.spoken}`,
      `For context: ${fact.spoken}`,
      `The GitHub numbers are not nothing either: ${fact.spoken}`,
      `One more thing: ${fact.spoken}`,
    ];
    return {
      purpose: "adoption",
      spoken: sentence(frames[seed % frames.length]),
      factIds: [fact.id],
      emphasis: [extractKeyNumber(fact.spoken)],
      optional: true,
    };
  }
  return null;
}

function activityLine(ledger: FactLedger): Draft | null {
  const activity = factsOfKind(ledger, "activity");
  if (activity.length === 0) return null;
  const fact = activity[0];
  return {
    purpose: "explain",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    optional: true,
  };
}

function installLine(ledger: FactLedger): Draft | null {
  const install = factsOfKind(ledger, "install");
  if (install.length === 0) return null;
  const fact = install[0];
  return {
    purpose: "install",
    spoken: sentence(fact.spoken),
    factIds: [fact.id],
    anchor: "install-command",
    optional: true,
  };
}

function extractKeyNumber(value: string): string {
  const match = value.match(/[\w,.]+\s*(?:thousand|stars|a day)/i);
  return match ? match[0].trim() : "";
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

type TemplateContext = {
  repo: EnrichedRepo;
  ledger: FactLedger;
  facts: Fact[];
  purpose: Fact | null;
  features: Fact[];
  useCases: Fact[];
  seed: number;
};

type Template = {
  key: string;
  build(context: TemplateContext): (Draft | null)[];
};

function identifyDrafts(context: TemplateContext, style: number): Draft[] {
  const { repo, purpose } = context;
  const name = displayName(repo);
  const who = owner(repo);
  const description = trimWords(purpose?.spoken ?? "", 20);

  const frames = [
    `This is ${name} by ${who}`,
    `${who} built ${name}`,
    `Here is ${name}, from ${who}`,
    `Meet ${name} by ${who}`,
  ];
  const lead = frames[style % frames.length];
  // The description is already a full sentence; do not prepend "it is", which
  // would produce "it is A command-line tool that ...".
  return [
    {
      purpose: "identify",
      spoken: sentence(`${lead}. ${description}`),
      factIds: purpose ? [purpose.id] : [],
      anchor: "repo-header",
      emphasis: [name],
    },
  ];
}

const TEMPLATES: Template[] = [
  /* --------------------- what it does ------------------------- */
  {
    key: "what-it-does.direct",
    build(context) {
      return [
        ...identifyDrafts(context, 0),
        ...firstBenefit(context),
        installLine(context.ledger),
        licenseLine(context.ledger),
        ctaDraft(context),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "what-it-does.plain",
    build(context) {
      const drafts: (Draft | null)[] = [];
      const purpose = context.purpose;
      drafts.push({
        purpose: "explain",
        spoken: sentence(
          `${displayName(context.repo)}. ${purpose?.spoken ?? ""}`
        ),
        factIds: purpose ? [purpose.id] : [],
        anchor: "repo-header",
        emphasis: [displayName(context.repo)],
      });
      drafts.push(...firstBenefit(context));
      drafts.push(activityLine(context.ledger));
      drafts.push(installLine(context.ledger));
      drafts.push(licenseLine(context.ledger));
      return drafts.filter((draft): draft is Draft => draft !== null);
    },
  },
  {
    key: "what-it-does.quiet",
    build(context) {
      const drafts: (Draft | null)[] = [];
      const purpose = context.purpose;
      drafts.push({
        purpose: "identify",
        spoken: sentence(`A quiet one: ${displayName(context.repo)}`),
        factIds: purpose ? [purpose.id] : [],
        anchor: "repo-header",
        emphasis: [displayName(context.repo)],
      });
      if (purpose) {
        drafts.push({
          purpose: "explain",
          spoken: sentence(`The short version: ${purpose.spoken}`),
          factIds: [purpose.id],
          anchor: "readme-intro",
        });
      }
      drafts.push(...firstBenefit(context));
      drafts.push(installLine(context.ledger));
      return drafts.filter((draft): draft is Draft => draft !== null);
    },
  },

  /* --------------------- quick tour --------------------------- */
  {
    key: "quick-tour.two-features",
    build(context) {
      const [first, second] = context.features;
      return [
        ...identifyDrafts(context, 1),
        featureDraft(first, "First"),
        featureDraft(second, "Second"),
        installLine(context.ledger),
        ctaDraft(context),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "quick-tour.tour-from-list",
    build(context) {
      const [first, second, third] = context.features;
      return [
        {
          purpose: "identify" as SegmentPurpose,
          spoken: sentence(`Here is what ${displayName(context.repo)} actually gives you`),
          factIds: context.purpose ? [context.purpose.id] : [],
          anchor: "repo-header" as VisualAnchor,
          emphasis: [displayName(context.repo)],
        },
        featureDraft(first, "You get"),
        featureDraft(second, "You also get"),
        ...(third ? [featureDraft(third, "And then there is")] : []),
        activityLine(context.ledger),
        installLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "quick-tour.capability",
    build(context) {
      const [first, second] = context.features;
      return [
        ...identifyDrafts(context, 2),
        {
          purpose: "benefit",
          spoken: sentence(
            `The capability that matters is this: ${first?.spoken ?? "it does one thing well"}`
          ),
          factIds: first ? [first.id] : [],
          anchor: "features",
          optional: true,
        },
        featureDraft(second, "On top of that"),
        adoptionLine(context.ledger, context.seed),
        licenseLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },

  /* --------------------- try it ------------------------------- */
  {
    key: "try-it.setup-first",
    build(context) {
      const [first] = context.features;
      return [
        ...identifyDrafts(context, 0),
        installLine(context.ledger),
        featureDraft(first, "Once it is running"),
        activityLine(context.ledger),
        licenseLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "try-it.inverse-brief",
    build(context) {
      const install = factsOfKind(context.ledger, "install")[0];
      const [first] = context.features;
      return [
        {
          purpose: "identify",
          spoken: sentence(
            `If you want to try ${displayName(context.repo)} quickly, here is the short version`
          ),
          factIds: context.purpose ? [context.purpose.id] : [],
          anchor: "install-command",
        } as Draft,
        install
          ? {
              purpose: "install" as SegmentPurpose,
              spoken: sentence(install.spoken),
              factIds: [install.id],
              anchor: "install-command" as VisualAnchor,
              emphasis: [firstWord(install.spoken)],
            }
          : null,
        featureDraft(first, "It is useful because"),
        licenseLine(context.ledger),
        ctaDraft(context),
      ].filter(Boolean) as Draft[];
    },
  },

  /* --------------------- workflow ----------------------------- */
  {
    key: "workflow.instead-of",
    build(context) {
      const useCase = context.useCases[0];
      const [first] = context.features;
      return [
        ...identifyDrafts(context, 1),
        useCase
          ? {
              purpose: "problem" as SegmentPurpose,
              spoken: sentence(useCase.spoken),
              factIds: [useCase.id],
              anchor: "readme-intro" as VisualAnchor,
            }
          : null,
        featureDraft(first, "And it"),
        installLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "workflow.placed-in-day",
    build(context) {
      const useCase = context.useCases[0];
      const [first] = context.features;
      const [second] = context.features.slice(1);
      return [
        ...identifyDrafts(context, 2),
        useCase
          ? {
              purpose: "problem" as SegmentPurpose,
              spoken: sentence(`From the README: ${useCase.spoken}`),
              factIds: [useCase.id],
              anchor: "readme-intro" as VisualAnchor,
            }
          : null,
        featureDraft(first, "The important part"),
        featureDraft(second, "Then"),
        activityLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "workflow.pipeline",
    build(context) {
      const [first, second] = context.features;
      const useCase = context.useCases[0];
      return [
        ...identifyDrafts(context, 0),
        featureDraft(first, "Step one"),
        featureDraft(second, "Step two"),
        useCase
          ? {
              purpose: "benefit" as SegmentPurpose,
              spoken: sentence(useCase.spoken),
              factIds: [useCase.id],
              anchor: "readme-intro" as VisualAnchor,
              optional: true,
            }
          : null,
        installLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },

  /* --------------------- under the radar ---------------------- */
  {
    key: "under-the-radar.measured-growth",
    build(context) {
      const [first] = context.features;
      return [
        ...identifyDrafts(context, 1),
        adoptionLine(context.ledger, context.seed),
        featureDraft(first, "Meanwhile"),
        installLine(context.ledger),
        licenseLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "under-the-radar.small-and-moving",
    build(context) {
      const [first, second] = context.features;
      const growth = context.ledger.facts.filter(
        fact => fact.source.kind === "star-snapshot"
      );
      return [
        {
          purpose: "identify",
          spoken: sentence(
            `Not the loudest project on GitHub, but ${displayName(context.repo)} earns a look. ${context.purpose?.spoken ?? ""}`
          ),
          factIds: context.purpose ? [context.purpose.id] : [],
          anchor: "repo-header",
          emphasis: [displayName(context.repo)],
        },
        ...(growth[0]
          ? [
              {
                purpose: "adoption" as SegmentPurpose,
                spoken: sentence(growth[0].spoken),
                factIds: [growth[0].id],
                emphasis: [extractKeyNumber(growth[0].spoken)],
              } as Draft,
            ]
          : []),
        featureDraft(first, "What it does"),
        featureDraft(second, "And"),
        installLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },

  /* --------------------- mature & popular --------------------- */
  {
    key: "mature-popular.context",
    build(context) {
      const [first] = context.features;
      return [
        ...identifyDrafts(context, 2),
        featureDraft(first, "The useful part"),
        adoptionLine(context.ledger, context.seed),
        activityLine(context.ledger),
        ctaDraft(context),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "mature-popular.first",
    build(context) {
      const [first, second] = context.features;
      return [
        {
          purpose: "identify",
          spoken: sentence(
            `${displayName(context.repo)} is one of those projects where the popularity is justified. ${context.purpose?.spoken ?? ""}`
          ),
          factIds: context.purpose ? [context.purpose.id] : [],
          anchor: "repo-header",
          emphasis: [displayName(context.repo)],
        },
        featureDraft(first, "Concretely"),
        featureDraft(second, "It also"),
        adoptionLine(context.ledger, context.seed + 1),
        installLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },

  /* --------------------- trade off ---------------------------- */
  {
    key: "trade-off.direct",
    build(context) {
      const [first, second] = context.features;
      const limits = context.facts.filter(fact => fact.kind === "requirement");
      return [
        ...identifyDrafts(context, 0),
        featureDraft(first, "The draw"),
        featureDraft(second, "It also"),
        ...(limits[0]
          ? [
              {
                purpose: "caveat" as SegmentPurpose,
                spoken: sentence(`One caveat worth knowing: ${limits[0].spoken}`),
                factIds: [limits[0].id],
                optional: true,
              } as Draft,
            ]
          : []),
        installLine(context.ledger),
        ctaDraft(context),
      ].filter(Boolean) as Draft[];
    },
  },
  {
    key: "trade-off.balanced",
    build(context) {
      const [first, second] = context.features;
      const limits = context.facts.filter(fact => fact.kind === "requirement");
      return [
        ...identifyDrafts(context, 1),
        featureDraft(first, "What you get"),
        ...(limits[0]
          ? [
              {
                purpose: "caveat" as SegmentPurpose,
                spoken: sentence(`Where it stops: ${limits[0].spoken}`),
                factIds: [limits[0].id],
                optional: true,
              } as Draft,
            ]
          : []),
        featureDraft(second, "Back to the good part"),
        licenseLine(context.ledger),
      ].filter(Boolean) as Draft[];
    },
  },
];

function firstBenefit(context: TemplateContext): Draft[] {
  const [first] = context.features;
  const useCase = context.useCases[0];
  const extra = first ? featureDraft(first, "It also") : null;
  if (useCase) {
    return [
      {
        purpose: "benefit",
        spoken: sentence(useCase.spoken),
        factIds: [useCase.id],
        anchor: "readme-intro",
      },
      ...(extra ? [extra] : []),
    ];
  }
  const lead = first ? featureDraft(first, "What it gives you") : null;
  return lead ? [lead] : [];
}

function featureDraft(feature: Fact | undefined, lead: string): Draft | null {
  if (!feature) return null;
  return {
    purpose: "demo",
    spoken: sentence(`${lead}: ${feature.spoken}`),
    factIds: [feature.id],
    anchor: "features",
  };
}

function ctaDraft(context: TemplateContext): Draft {
  return {
    purpose: "cta",
    spoken: sentence(
      `The README is the place to start if you want the details`
    ),
    factIds: context.purpose ? [context.purpose.id] : [],
    anchor: "repo-header",
    optional: true,
  };
}

function firstWord(value: string): string {
  return value.split(/\s+/)[0] ?? "";
}

/* ------------------------------------------------------------------ */
/* Duration policy                                                     */
/* ------------------------------------------------------------------ */

/**
 * Optional detail segments, in the order they are worth adding when the
 * evidence is thin. Every one of them cites a verified fact.
 */
function topUpDrafts(context: TemplateContext): Draft[] {
  const { ledger } = context;
  const available: Draft[] = [];
  const push = (draft: Draft | null) => {
    if (draft && draft.spoken.trim()) available.push(draft);
  };

  const useCase = factsOfKind(ledger, "use_case")[0];
  if (useCase) {
    push({
      purpose: "explain",
      spoken: sentence(useCase.spoken),
      factIds: [useCase.id],
      anchor: "readme-intro",
      optional: true,
    });
  }
  push(activityLine(ledger));
  const language = factsOfKind(ledger, "language")[0];
  if (language) {
    push({
      purpose: "explain",
      spoken: sentence(language.spoken),
      factIds: [language.id],
      optional: true,
    });
  }
  const release = factsOfKind(ledger, "release")[0];
  if (release) {
    push({
      purpose: "explain",
      spoken: sentence(release.spoken),
      factIds: [release.id],
      anchor: "release",
      optional: true,
    });
  }
  for (const feature of context.features.slice(2, 4)) {
    push(featureDraft(feature, "Also"));
  }
  push(licenseLine(ledger));
  const requirement = factsOfKind(ledger, "requirement")[0];
  if (requirement) {
    push({
      purpose: "caveat",
      spoken: sentence(requirement.spoken),
      factIds: [requirement.id],
      optional: true,
    });
  }
  push(installLine(ledger));
  push(adoptionLine(ledger, context.seed));

  return available;
}

/* ------------------------------------------------------------------ */
/* Plan assembly                                                       */
/* ------------------------------------------------------------------ */

export type BuildNarrationOptions = {
  targetDurationSeconds?: number;
  voiceId?: string;
  speed?: number;
  recentUsage?: PhraseHistory;
  attemptCount?: number;
};

export function buildNarrationPlan(
  ledger: FactLedger,
  repo: EnrichedRepo,
  options: BuildNarrationOptions = {}
): NarrationPlan {
  const target = Math.min(
    MAX_DURATION_SECONDS,
    Math.max(MIN_DURATION_SECONDS, options.targetDurationSeconds ?? TARGET_DURATION_SECONDS)
  );
  const seed =
    stableHash(`${repo.full_name.toLowerCase()}:${options.attemptCount ?? 0}`) +
    (options.recentUsage?.get("__turn__") ?? 0);

  const decision = selectAngle(ledger, repo);
  const { key } = pickVariant(decision.templateKeys, options.recentUsage ?? new Map(), seed);
  const template = TEMPLATES.find(item => item.key === key) ?? TEMPLATES[0];

  const context: TemplateContext = {
    repo,
    ledger,
    facts: narratableFacts(ledger),
    purpose: factsOfKind(ledger, "purpose")[0] ?? null,
    features: factsOfKind(ledger, "feature"),
    useCases: factsOfKind(ledger, "use_case"),
    seed,
  };

  let drafts = template
    .build(context)
    .filter((draft): draft is Draft => Boolean(draft && draft.spoken.trim().length > 0));

  // Duration policy: add verified optional detail while the script is short,
  // then drop the least essential optional segments if it runs long. Prefer
  // omitting a detail over compressing the narration.
  const maxWords = Math.floor((target / 60) * ESTIMATED_WPM);
  const minWords = Math.floor((MIN_DURATION_SECONDS / 60) * ESTIMATED_WPM);

  const used = new Set(drafts.flatMap(draft => draft.factIds));
  const spare = topUpDrafts(context).filter(
    draft => !draft.factIds.some(id => used.has(id))
  );

  let guard = 0;
  while (
    wordCount(drafts.map(draft => draft.spoken).join(" ")) < minWords &&
    spare.length > 0 &&
    guard < 12
  ) {
    guard += 1;
    const addition = spare.shift()!;
    if (addition.factIds.some(id => used.has(id))) continue;
    addition.factIds.forEach(id => used.add(id));
    // Insert before any closing call to action.
    const ctaIndex = drafts.findIndex(draft => draft.purpose === "cta");
    if (ctaIndex >= 0) drafts.splice(ctaIndex, 0, addition);
    else drafts.push(addition);
  }

  guard = 0;
  while (wordCount(drafts.map(draft => draft.spoken).join(" ")) > maxWords && guard < 12) {
    guard += 1;
    const index = findLastOptionalIndex(drafts);
    if (index < 0) break;
    drafts.splice(index, 1);
  }

  const segments: NarrationSegment[] = drafts.map((draft, index) => {
    const caption = draft.caption ?? draft.spoken;
    return {
      id: `seg-${String(index + 1).padStart(2, "0")}`,
      purpose: draft.purpose,
      spokenText: withSpoken(draft.spoken),
      captionText: caption,
      factIds: draft.factIds,
      visualAnchor: draft.anchor,
      pauseAfterMs: draft.pauseAfterMs,
      emphasis: (draft.emphasis ?? []).filter(value => value.trim().length > 0),
    };
  });

  const nextUsage: PhraseHistory = new Map(options.recentUsage ?? []);
  nextUsage.set(key, (nextUsage.get(key) ?? 0) + 1);
  nextUsage.set("__turn__", (nextUsage.get("__turn__") ?? 0) + 1);

  return {
    repositoryNodeId: repo.nodeId,
    fullName: repo.full_name,
    angle: decision.angle,
    angleReason: decision.reason,
    targetDurationSeconds: target,
    styleVariant: key,
    voiceId: options.voiceId ?? "af_heart",
    speed: options.speed ?? 1,
    estimatedWords: wordCount(segments.map(segment => segment.spokenText).join(" ")),
    segments,
  };
}

function findLastOptionalIndex(drafts: Draft[]): number {
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    if (drafts[index].optional) return index;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const SENTENCE_RE = /[^.!?]+[.!?]?/g;

export function validateScript(plan: NarrationPlan, ledger: FactLedger): ScriptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const full = plan.segments.map(segment => segment.spokenText).join(" ");
  const words = wordCount(full);

  const known = new Set(ledger.facts.map(fact => fact.id));
  for (const segment of plan.segments) {
    if (segment.factIds.length === 0) {
      errors.push(`segment ${segment.id} cites no fact`);
    }
    for (const id of segment.factIds) {
      if (!known.has(id)) errors.push(`segment ${segment.id} cites unknown fact ${id}`);
    }
  }

  if (plan.segments.length === 0) errors.push("script is empty");

  const firstTwo = plan.segments.slice(0, 2).map(segment => segment.spokenText).join(" ");
  if (!/[a-z]{3}/i.test(firstTwo)) {
    errors.push("the first two sentences do not explain the project");
  }
  if (wordCount(firstTwo) < 6) {
    errors.push("the opening is too short to explain what the project is");
  }

  for (const phrase of findBoilerplate(full)) {
    errors.push(`banned filler phrase: "${phrase}"`);
  }

  if (/\btrending\b/i.test(full) && !ledger.facts.some(fact => fact.source.kind === "star-snapshot")) {
    errors.push('"trending" may only be used when dated star snapshots exist');
  }
  if (/\bopen[- ]source\b/i.test(full) && !ledger.facts.some(fact => fact.kind === "license")) {
    errors.push('"open source" may only be used when a license fact exists');
  }
  if (
    /\b(all|every|any)\b[^.]{0,60}\b(services?|apis?|hosted|platform|infrastructure)\b[^.]{0,30}\b(are|is|will be)\b[^.]{0,20}\b(free|no[- ]cost|unlimited)\b/i.test(
      full
    )
  ) {
    errors.push("open source code does not imply that hosted services are free");
  }
  if (/\bfree forever\b/i.test(full)) {
    errors.push("an absolute cost claim needs a pricing fact");
  }

  const name = plan.fullName.split("/").pop() ?? plan.fullName;
  const nameMentions = full.split(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi")).length - 1;
  if (nameMentions > 3) {
    warnings.push(`the repository name is repeated ${nameMentions} times`);
  }

  for (const sentenceText of full.match(SENTENCE_RE) ?? []) {
    const count = wordCount(sentenceText);
    if (count > 26) {
      warnings.push(
        `a sentence of ${count} words will be hard to speak: "${trim(sentenceText)}"`
      );
    }
  }

  const estimatedSeconds = estimateSeconds(words);
  if (estimatedSeconds > MAX_DURATION_SECONDS) {
    errors.push(
      `estimated ${estimatedSeconds.toFixed(1)}s exceeds the ${MAX_DURATION_SECONDS}s maximum`
    );
  }
  if (estimatedSeconds < MIN_DURATION_SECONDS) {
    warnings.push(
      `estimated ${estimatedSeconds.toFixed(1)}s is below the ${MIN_DURATION_SECONDS}s minimum target`
    );
  }

  // Do not say the same thing three ways.
  const seen = new Map<string, number>();
  for (const factId of plan.segments.flatMap(segment => segment.factIds)) {
    seen.set(factId, (seen.get(factId) ?? 0) + 1);
  }
  for (const [factId, count] of seen) {
    if (count > 2) warnings.push(`fact ${factId} is used ${count} times`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    words,
    estimatedSeconds,
  };
}

function trim(value: string, max = 60): string {
  return value.length <= max ? value.trim() : `${value.trim().slice(0, max - 1)}…`;
}

function trimWords(value: string, max: number): string {
  const words = value.split(/\\s+/).filter(Boolean);
  if (words.length <= max) return value.trim();
  return `${words.slice(0, max).join(" ").replace(/[,:;]$/, "")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Plain spoken text, used as the TTS input for a single chunk. */
export function segmentSpokenText(segment: NarrationSegment): string {
  return segment.spokenText;
}

/** Convenience: readme-derived detail used by the card renderer. */
export function readmeHighlights(repo: EnrichedRepo): {
  bullets: string[];
  installCommand: string | null;
} {
  const parsed = parseReadme(repo.readmeText);
  return {
    bullets: bulletsOf(
      sectionWithBullets(parsed, [/^(features?|capabilities|highlights|benefits?|why)/])
    ).slice(0, 5),
    installCommand: findCommand(parsed),
  };
}

function findCommand(parsed: ReturnType<typeof parseReadme>): string | null {
  const section = parsed.sections.find(item =>
    /install|setup|getting started|quick ?start|usage/i.test(item.heading)
  );
  const source = section?.body ?? parsed.plainText;
  const match = source.match(/(?:^|\n)\s*(npm|pnpm|yarn|bun|pip3?|cargo|brew|go|docker|uv)\s+[^\n`]{3,90}/i);
  return match ? match[0].trim() : null;
}
