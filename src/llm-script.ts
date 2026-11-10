import type {
  CalloutRole,
  EnrichedRepo,
  FactLedger,
  Fact,
  NarrationAngle,
  NarrationPlan,
  NarrationSegment,
  SegmentPurpose,
  StorySlot,
  VisualAnchor,
} from "./types.js";
import {
  ESTIMATED_WPM,
  GROQ_MAX_INPUT_CHARS,
  GROQ_MAX_PROMPT_FACTS,
  GROQ_MAX_TOKENS,
  GROQ_MODEL,
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  TARGET_DURATION_SECONDS,
  TTS_SPEED,
  TTS_VOICE,
  estimatedWordsForSeconds,
  pauseFor,
  type PauseKind,
} from "./config.js";
import { groqChatCompletion, GroqError, type GroqUsage } from "./groq.js";
import { selectAngle, wordCount } from "./narration.js";
import { toSpoken } from "./pronunciation.js";
import { calloutTextFor } from "./callout-overlay.js";
import { matchPriorityCategories } from "./github.js";

/**
 * Groq-written narration (default writer).
 *
 * One chat-completion call receives the repository metadata, the typed fact
 * ledger, a trimmed README excerpt and the target length, and returns the
 * full script as JSON. Everything downstream of `NarrationPlan` — Kokoro,
 * timeline, captions, callouts, render, QA — is untouched.
 *
 * Minimal gates by design (this path replaces — not augments — the old
 * evidence-graph composer):
 *   - the response must parse as JSON with a `segments` array;
 *   - each segment needs non-empty spoken text (missing terminal punctuation
 *     is repaired, not rejected);
 *   - estimated duration must fit the hard ceiling; one "shorten it" retry
 *     is allowed before the run fails;
 *   - no fact-citation requirement, no metadata-share gate, no template
 *     repetition gate. Honesty is enforced by the prompt (facts are provided
 *     verbatim with excerpts), not by post-hoc citation checks.
 *
 * Failure policy: any unrecoverable error throws — the run fails loudly.
 */

export type LlmScriptOptions = {
  targetDurationSeconds?: number;
  voiceId?: string;
  speed?: number;
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type LlmScriptResult = {
  plan: NarrationPlan;
  angle: NarrationAngle;
  angleReason: string;
  model: string;
  usage: GroqUsage | null;
  retries: number;
  /** The exact request payloads, for `llm-prompt.json`. */
  prompt: { system: string; user: string };
  /** The raw completions (first draft and, if any, the shorten retry). */
  completions: { content: string; model: string; usage: GroqUsage | null }[];
  /** Non-fatal issues noticed while sanitising the script. */
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* Prompt construction                                                   */
/* ------------------------------------------------------------------ */

const MAX_EXCERPT_CHARS = 160;

/** Characters GitHub READMEs and LLMs emit that Kokoro cannot pronounce. */
const WEIRD_CHAR_MAP: [RegExp, string][] = [
  [/[\u2010\u2011\u2012\u2013]/g, "-"], // hyphens/en dash
  [/[\u2014\u2015]/g, ", "], // em dash → spoken pause
  [/[\u2018\u2019\u02BC\u0060]/g, "'"], // curly quotes/backtick → straight apostrophe
  [/[\u201C\u201D]/g, "\""], // curly double quotes
  [/\u2026/g, "."], // ellipsis
  [/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, ""], // zero-width chars, BOM, soft hyphen
  [/[\u00A0\u202F\u2007\u1680\u205F]/g, " "], // non-breaking spaces
];

/** A bare domain followed by a path: never speakable, strip it wholesale. */
const BARE_URL_TOKEN = /(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?:\/[^\s)]*)+/g;

/**
 * Normalise model-written text into what Kokoro can pronounce and what a
 * human would caption. Applied to BOTH spoken and caption text: the LLM must
 * never leak smart quotes, non-breaking hyphens, or a domain path into the
 * audio or onto the screen.
 */
export function normalizeGeneratedText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of WEIRD_CHAR_MAP) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(BARE_URL_TOKEN, " ");
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

type PromptFact = {
  kind: Fact["kind"];
  semantic: Fact["semantic"];
  claim: string;
  confidence: number;
  excerpt?: string;
  location: string;
};

function serializeFacts(ledger: FactLedger, cap: number): PromptFact[] {
  return [...ledger.facts]
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, cap)
    .map(fact => ({
      kind: fact.kind,
      semantic: fact.semantic,
      claim: fact.claim,
      confidence: fact.confidence,
      ...(fact.provenance?.excerpt
        ? { excerpt: fact.provenance.excerpt.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS) }
        : {}),
      location: fact.source.location,
    }));
}

function topLanguages(repo: EnrichedRepo, count = 4): string[] {
  const entries = Object.entries(repo.languages ?? {});
  if (entries.length === 0) {
    return repo.primaryLanguage ? [repo.primaryLanguage] : [];
  }
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([language]) => language);
}

export function buildSystemPrompt(targetSeconds: number): string {
  const words = estimatedWordsForSeconds(targetSeconds);
  return [
    "You are a young, curious developer recording a vertical (9:16) short-form video about one open-source",
    "GitHub repository. A narrator voice reads your script aloud over a screen recording of the repo page.",
    "",
    "Voice and tone:",
    "- Sound like a real engineer talking to a friend, not a press release. Short sentences. Contractions.",
    "  Concrete claims. Natural rhythm with the occasional question.",
    "- Say the repository name ONCE near the opening (and at most one more time later).",
    "- No hype adjectives ('revolutionary', 'game-changing', 'blazingly fast') unless a fact supports them.",
    "",
    "Spoken delivery rules (the TTS engine reads these exact words):",
    "- Plain ASCII only. Allowed punctuation: commas, periods, apostrophes, question marks. Never use emoji,",
    "  em/en dashes, non-breaking hyphens, curly quotes, colons, semicolons, parentheses or slashes.",
    "- Never put a URL, domain or install command path in spokenText or captionText. Say \"install it with",
    "  Go's install command\" — never \"go install github.com/you/repo@latest\".",
    "- Short sentences, one idea each, natural contractions, occasional \"you\" address.",
    "- If a technical acronym is uncommon, spell it out: \"V L L M\", \"M C P\", \"T U I\".",
    "- At least one punchy sentence under 6 words. No sentence over 18 words.",
    "",
    "Structure (in this order, but let the evidence shape the wording):",
    "  1. hook/identity — what this is, in one breath. Lead with the name and the one-line purpose.",
    "  2. explain — how it actually works. Mechanism before metrics, always.",
    "  3. demo — a concrete, practical use case or example from the evidence. What would I actually use this for?",
    "  4. install — how to get started, briefly (name the install command or package, not a character-by-character reading).",
    "  5. caveat (optional) — an honest limitation, only if one exists in the evidence.",
    "  6. cta — where to find it / what to do next.",
    "",
    "Hard honesty rules:",
    "- Use ONLY what is in the facts and README excerpt you are given. Never invent benchmarks, user counts,",
    "  compatibility, or features. If a detail is missing, simply do not mention it.",
    "- Star counts may be mentioned at most once, never in the opening, and only as light context.",
    "- Do not read commands, URLs or markdown aloud character by character. Describe them.",
    "",
    `Length budget: aim for about ${words} spoken words (roughly ${targetSeconds}s at a natural pace).`,
    `Fewer than ${Math.max(55, words - 20)} words is too thin — if you are under that, expand the most`,
    'interesting mechanism or use-case detail from the facts rather than padding with hype.',
    "Going over makes the video fail its hard limit — trim, don't pad.",
    "",
    "OUTPUT FORMAT — respond with ONLY a JSON object, no prose, no code fences, exactly this shape:",
    '{',
    '  "segments": [',
    '    {',
    '      "purpose": "identify" | "problem" | "explain" | "benefit" | "demo" | "install" | "license" | "adoption" | "caveat" | "cta",',
    '      "spokenText": "the sentence(s) the narrator reads — plain spoken English",',
    '      "captionText": "the same words for on-screen captions (correct spelling)",',
    '      "visualAnchor": "repo-header" | "file-list" | "readme-intro" | "install-command" | "features" | "license" | "release",',
    '      "calloutText": "SPECIFIC 3-6 word phrase naming the actual thing — e.g. terminal coding agent, fixes Go tests, go install — never generic filler like what it is or how it works, or null",',
    '      "calloutRole": "purpose" | "mechanism" | "example" | "benefit" | "tradeoff" | "installation" | null,',
    '      "emphasis": ["up-to-3 words captions should highlight"]',
    "    }",
    "  ]",
    '}',
    "Use 5 to 9 segments. Every segment must end with proper sentence punctuation.",
    "Set visualAnchor to the section of the page the narrator is talking about when it is clear,",
    "otherwise use \"repo-header\".",
  ].join("\n");
}

export function buildUserPrompt(
  repo: EnrichedRepo,
  ledger: FactLedger,
  targetSeconds: number
): string {
  const readme = (repo.readmeText ?? "").replace(/\s+/g, " ").trim();
  const truncatedReadme = readme.slice(0, GROQ_MAX_INPUT_CHARS);
  const priority = matchPriorityCategories(repo).map(category => category.label);
  const payload = {
    repository: {
      fullName: repo.full_name,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      license: repo.licenseSpdxId,
      languages: topLanguages(repo),
      topics: repo.topics ?? [],
      createdAt: repo.createdAt,
      pushedAt: repo.pushedAt,
      latestRelease: repo.latestRelease
        ? {
            tag: repo.latestRelease.tag_name,
            name: repo.latestRelease.name,
            publishedAt: repo.latestRelease.published_at,
          }
        : null,
      priorityCategories: priority,
    },
    facts: serializeFacts(ledger, GROQ_MAX_PROMPT_FACTS),
    readmeExcerpt: {
      text: truncatedReadme,
      truncated: readme.length > truncatedReadme.length,
    },
    length: {
      targetSeconds,
      hardMaxSeconds: MAX_DURATION_SECONDS,
      estimatedWords: estimatedWordsForSeconds(targetSeconds),
    },
  };
  return (
    "Write the narration for this repository. Evidence follows as JSON.\n\n" +
    JSON.stringify(payload, null, 1)
  );
}

/* ------------------------------------------------------------------ */
/* Response handling                                                    */
/* ------------------------------------------------------------------ */

const ALLOWED_PURPOSES = new Set<SegmentPurpose>([
  "identify",
  "problem",
  "explain",
  "benefit",
  "demo",
  "install",
  "license",
  "adoption",
  "caveat",
  "cta",
]);

const ALLOWED_ANCHORS = new Set<VisualAnchor>([
  "repo-header",
  "file-list",
  "readme-intro",
  "install-command",
  "features",
  "license",
  "release",
]);

const ALLOWED_CALLOUT_ROLES = new Set<CalloutRole>([
  "purpose",
  "mechanism",
  "example",
  "benefit",
  "tradeoff",
  "installation",
]);

const PURPOSE_SLOT: Record<SegmentPurpose, StorySlot> = {
  identify: "identity",
  problem: "hook",
  explain: "value",
  benefit: "value",
  demo: "demo",
  install: "setup",
  license: "availability",
  adoption: "proof",
  caveat: "caveat",
  cta: "cta",
};

/**
 * Which ledger kinds ground each segment purpose. Used to attach an audit
 * trail to LLM-written segments: the callout system and QA require
 * `factIds`, so each segment inherits the highest-confidence facts of its
 * role. This is approximate traceability (the model saw the whole ledger),
 * but it keeps the "claims cite facts" invariant visible downstream.
 */
const PURPOSE_KINDS: Record<SegmentPurpose, Fact["kind"][]> = {
  identify: ["purpose"],
  problem: ["problem"],
  explain: ["mechanism", "feature"],
  benefit: ["outcome"],
  demo: ["example", "workflow", "use_case"],
  install: ["install"],
  license: ["license"],
  adoption: ["adoption"],
  caveat: ["limitation", "requirement"],
  cta: ["release"],
};

type RawSegment = {
  purpose?: unknown;
  spokenText?: unknown;
  captionText?: unknown;
  visualAnchor?: unknown;
  calloutText?: unknown;
  calloutRole?: unknown;
  emphasis?: unknown;
};

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function withTerminalPunctuation(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function pauseKindBetweenPurposes(from: SegmentPurpose, to: SegmentPurpose): PauseKind {
  if (to === "demo") return "example";
  if (to === "caveat") return "contrast";
  if (to === "install" || to === "cta") return "closing";
  if (from === to) return "continuation";
  return "newIdea";
}

/**
 * Attach 1–2 unused, highest-confidence ledger facts of the segment's role
 * kind. Unmatched purposes (or an empty ledger tier) leave `factIds` empty —
 * the callout eligibility gate then simply skips the bubble, which is the
 * honest outcome.
 */
function attachFactIds(segments: NarrationSegment[], ledger: FactLedger): void {
  const used = new Set<string>();
  for (const segment of segments) {
    const kinds = PURPOSE_KINDS[segment.purpose];
    if (!kinds) continue;
    const candidates = ledger.facts
      .filter(fact => kinds.includes(fact.kind) && !used.has(fact.id))
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, 2);
    segment.factIds = candidates.map(fact => fact.id);
    for (const fact of candidates) used.add(fact.id);
  }
}

function sanitizeSegments(
  raw: unknown,
  warnings: string[]
): NarrationSegment[] {
  const source =
    raw && typeof raw === "object" && Array.isArray((raw as { segments?: unknown }).segments)
      ? ((raw as { segments: RawSegment[] }).segments as RawSegment[])
      : null;
  if (!source) {
    throw new GroqError(
      "Groq response JSON does not contain a `segments` array.",
      null
    );
  }
  const segments: NarrationSegment[] = [];
  for (const [index, entry] of source.entries()) {
    const spokenRaw =
      typeof entry.spokenText === "string" ? normalizeGeneratedText(entry.spokenText) : "";
    if (!spokenRaw) {
      warnings.push(`segment ${index + 1} was empty and was dropped`);
      continue;
    }
    const spoken = withTerminalPunctuation(spokenRaw);
    const captionSource =
      typeof entry.captionText === "string" && entry.captionText.trim()
        ? normalizeGeneratedText(entry.captionText)
        : spoken;
    const caption = withTerminalPunctuation(captionSource);
    const purpose =
      typeof entry.purpose === "string" &&
      ALLOWED_PURPOSES.has(entry.purpose as SegmentPurpose)
        ? (entry.purpose as SegmentPurpose)
        : "explain";
    if (purpose !== entry.purpose) {
      warnings.push(`segment ${index + 1} had an unknown purpose; treated as "explain"`);
    }
    const visualAnchor =
      typeof entry.visualAnchor === "string" &&
      ALLOWED_ANCHORS.has(entry.visualAnchor as VisualAnchor)
        ? (entry.visualAnchor as VisualAnchor)
        : "repo-header";
    const calloutRole =
      typeof entry.calloutRole === "string" &&
      ALLOWED_CALLOUT_ROLES.has(entry.calloutRole as CalloutRole)
        ? (entry.calloutRole as CalloutRole)
        : undefined;
    const calloutText =
      typeof entry.calloutText === "string" && entry.calloutText.trim()
        ? entry.calloutText.trim().replace(/\s+/g, " ").slice(0, 80)
        : calloutTextFor(caption) ?? undefined;
    const emphasis = Array.isArray(entry.emphasis)
      ? entry.emphasis
          .filter((word): word is string => typeof word === "string")
          .map(word => word.trim())
          .filter(Boolean)
          .slice(0, 3)
      : undefined;
    segments.push({
      id: `seg-${String(segments.length + 1).padStart(2, "0")}`,
      purpose,
      spokenText: toSpoken(spoken),
      captionText: caption,
      factIds: [],
      visualAnchor,
      ...(calloutText ? { calloutText, ...(calloutRole ? { calloutRole } : {}) } : {}),
      ...(emphasis && emphasis.length > 0 ? { emphasis } : {}),
      narrativeRole: PURPOSE_SLOT[purpose],
      clauseId: `llm.${index + 1}`,
    });
  }
  if (segments.length < 3) {
    throw new GroqError(
      `Groq produced only ${segments.length} usable segment(s); refusing to narrate a stub.`,
      null
    );
  }
  // One schedule for audio and timeline: the pause AFTER this segment.
  for (let index = 0; index < segments.length; index += 1) {
    const next = segments[index + 1];
    segments[index].pauseAfterMs = next
      ? pauseFor(pauseKindBetweenPurposes(segments[index].purpose, next.purpose))
      : 0;
  }
  return segments;
}

function parseCompletion(
  content: string,
  warnings: string[],
  ledger: FactLedger
): { segments: NarrationSegment[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(content));
  } catch (error) {
    throw new GroqError(
      `Groq response was not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      null
    );
  }
  const segments = sanitizeSegments(raw, warnings);
  attachFactIds(segments, ledger);
  return { segments };
}

/** Minimal hard ceiling check; target overshoot is a warning only. */
export function estimateSeconds(plan: NarrationPlan): number {
  const words = wordCount(plan.segments.map(segment => segment.spokenText).join(" "));
  return (words / ESTIMATED_WPM) * 60;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                           */
/* ------------------------------------------------------------------ */

export async function composeLlmScript(
  repo: EnrichedRepo,
  ledger: FactLedger,
  options: LlmScriptOptions = {}
): Promise<LlmScriptResult> {
  const requested = options.targetDurationSeconds ?? TARGET_DURATION_SECONDS;
  const target = Math.min(
    MAX_DURATION_SECONDS,
    Math.max(MIN_DURATION_SECONDS, Math.round(requested))
  );
  const system = buildSystemPrompt(target);
  const user = buildUserPrompt(repo, ledger, target);
  const log = options.log ?? ((line: string) => console.error(line));

  const warnings: string[] = [];
  const completions: LlmScriptResult["completions"] = [];
  let totalRetries = 0;

  const first = await groqChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      model: GROQ_MODEL,
      maxTokens: GROQ_MAX_TOKENS,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      log,
    }
  );
  const model = first.model;
  totalRetries += first.retries;
  completions.push({ content: first.content, model: first.model, usage: first.usage });

  let parsed = parseCompletion(first.content, warnings, ledger);
  let plan = buildPlan(repo, parsed.segments, target, model, options);
  // Over the soft budget? One compression pass is allowed (the model tends
  // to overshoot word budgets).
  const overBudget = estimateSeconds(plan) > Math.min(target + 4, MAX_DURATION_SECONDS);

  if (overBudget) {
    // One permitted follow-up: ask the model to compress its own draft.
    log(
      `  groq: estimated ${estimateSeconds(plan).toFixed(1)}s exceeds the ${target}s budget; asking for a shorter rewrite...`
    );
    const second = await groqChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content: first.content },
        {
          role: "user",
          content:
            "That draft is too long. Rewrite it to fit the length budget: keep the structure, " +
            "the honesty rules and the exact JSON contract, but cut the word count by about a third. " +
            "Respond with ONLY the JSON object.",
        },
      ],
      {
        model: GROQ_MODEL,
        maxTokens: GROQ_MAX_TOKENS,
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        log,
      }
    );
    totalRetries += second.retries;
    completions.push({ content: second.content, model: second.model, usage: second.usage });
    parsed = parseCompletion(second.content, warnings, ledger);
    plan = buildPlan(repo, parsed.segments, target, model, options);
    const overHardCap = estimateSeconds(plan) > MAX_DURATION_SECONDS;
    if (overHardCap) {
      throw new GroqError(
        `Groq draft is still over the ${MAX_DURATION_SECONDS}s ceiling after one shorten retry ` +
          `(estimated ${estimateSeconds(plan).toFixed(1)}s). Refusing to ship an over-long video.`,
        null
      );
    }
  }

  const estimated = estimateSeconds(plan);
  if (estimated > target + 4) {
    warnings.push(
      `estimated ${estimated.toFixed(1)}s overshoots the ${target}s target by more than 4s (still under the hard ceiling)`
    );
  }
  if (estimated < MIN_DURATION_SECONDS) {
    warnings.push(
      `estimated ${estimated.toFixed(1)}s is below the ${MIN_DURATION_SECONDS}s minimum target`
    );
  }

  const angle = selectAngle(ledger, repo);
  plan.angle = angle.angle;
  plan.angleReason = `groq-written narration (${model}); ${angle.reason}`;

  const lastUsage = completions.at(-1)?.usage ?? null;
  return {
    plan,
    angle: plan.angle,
    angleReason: plan.angleReason,
    model,
    usage: lastUsage,
    retries: totalRetries,
    prompt: { system, user },
    completions,
    warnings,
  };
}

function buildPlan(
  repo: EnrichedRepo,
  segments: NarrationSegment[],
  target: number,
  model: string,
  options: LlmScriptOptions
): NarrationPlan {
  return {
    repositoryNodeId: repo.nodeId,
    fullName: repo.full_name,
    angle: "what-it-does",
    angleReason: "",
    targetDurationSeconds: target,
    styleVariant: `groq-${model}`,
    voiceId: options.voiceId ?? TTS_VOICE,
    speed: options.speed ?? TTS_SPEED,
    estimatedWords: wordCount(segments.map(segment => segment.spokenText).join(" ")),
    segments,
    structure: "groq-llm",
  };
}
