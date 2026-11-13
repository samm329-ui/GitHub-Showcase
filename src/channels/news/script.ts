import type { EpisodeScript, NewsSegment, FactRecord, EvidenceLedger } from "./types.js";
import { extractNumbers, excerptContains, normalizeComparable, significantTokens } from "./ledger.js";
import { groqChatCompletion, GroqError, type GroqUsage } from "../../groq.js";
import { GROQ_MODEL } from "../../config.js";

/**
 * Script generation — Groq writes ONLY from the approved ledger.
 *
 * Contract (docs §9):
 *  - one central story; English; dry sarcasm; structure hook → happened →
 *    evidence → matters → observation → punchline/takeaway;
 *  - every factual clause references factIds; satire/interpretation carry
 *    `contentClass` tags and never smuggle numbers/names outside the ledger;
 *  - deterministic validators below are the hard gate; the LLM never approves
 *    its own output;
 *  - quotes spoken only if they exist verbatim in the ledger's evidence.
 */

export type ScriptOptions = {
  targetSeconds?: number; // soft pacing target (default 65)
  maxSeconds?: number;    // technical guard (default 90) — not editorial
  log?: (line: string) => void;
  /** Allow one Groq repair retry when the first draft fails the validator. Default true. */
  repair?: boolean;
  /** Balance brief lines from computePerspectiveCoverage — context for framing, never facts. */
  perspectiveBrief?: string[];
};

export class ScriptError extends Error {
  override name = "ScriptError";
}

export type ScriptDraft = {
  plan: EpisodeScript;
  usage: GroqUsage | null;
  raw: string;
};

const LEDGER_FACTS_CAP = 30;

export function serializeLedger(ledger: EvidenceLedger): string {
  const usable = ledger.facts
    .filter(f => f.importance !== "optional" || f.confidence >= 0.8)
    .slice(0, LEDGER_FACTS_CAP);
  const lines: string[] = [];
  for (const fact of usable) {
    if (fact.contentClass === "fact" && fact.status !== "verified" && fact.status !== "attributed") continue;
    lines.push(
      `- id=${fact.id} class=${fact.contentClass} status=${fact.status} kind=${fact.kind} asOf=${fact.asOf ?? "n/a"}` +
        ` evidence=${fact.evidence.length} independence=${fact.independenceCount}` +
        `\n  claim: ${fact.claim}` +
        (fact.safeNarration ? `\n  approved-wording: ${fact.safeNarration}` : "") +
        `\n  evidence: ${fact.evidence.map(e => e.excerpt?.split("\n")[0] ?? "").filter(Boolean).join(" || ").slice(0, 400)}`
    );
  }
  return lines.join("\n");
}

export function buildScriptSystemPrompt(targetSeconds: number): string {
  const words = Math.round(148 * (targetSeconds / 60));
  return [
    "You are a slightly tired, intelligent office commentator recording a vertical 9:16 short about ONE news story.",
    "The piece is sarcastic but every factual claim must come from the ledger you are given — never invent, extend, or strengthen it.",
    "",
    "Voice and structure:",
    "- Sound like a dry, underpaid person who finds the news absurd, not excited, not a bulletin, never a meme rant.",
    "- Structure (in order): hook (sharpest verified point, never clickbait) -> what happened (plain language) -> what the evidence says -> why it matters -> one or two dry observations (never at victims, always at power/absurdity) -> punchline/takeaway.",
    `- Aim around ${words} spoken words. Plain ASCII only. Allowed punctuation: commas, periods, apostrophes, question marks.`,
    "- Short sentences. No sentence over 18 words. At least one sentence under 6 words.",
    "- Never put a URL, handle or date written as digits-only in spoken text without context; dates may be spoken naturally.",
    "",
    "Hard rules (violations fail the run):",
    "1. Every factual sentence MUST cite ledger factIds in its segment's factIds array.",
    "2. Never use a number, date, currency, quantity, name, org, place, title or program identifier that is not in the ledger.",
    "3. Allegations stay allegations ('the FIR alleges...', never 'he did it'). A proposed bill is not an approved bill. An investigation is not a conviction.",
    "4. Quotes spoken verbatim only if the exact quote appears in the ledger evidence; attribute ('according to...').",
    "5. Sarcasm targets power, institutions, policy design, contradictions and absurdity — never victims, patients, children, the dead or vulnerable groups.",
    "6. Do not make a weak claim stronger by sarcasm. If evidence conflicts, say it conflicts.",
    "7. One story. No roundups. No 'meanwhile in other news'.",
    "8. Tag every segment with contentClass: fact | interpretation | satire.",
    "",
    "Output ONLY a JSON object, no prose, no code fences, exactly this shape:",
    "{",
    '  "workingTitle": "story headline (short, declarative)",',
    '  "estimatedDurationSeconds": 65,',
    '  "narration": [{"id":"N001","text":"...","factIds":["F001"],"delivery":"dry_hook|measured_explanation|firm_attribution|dry_observation|punchline","sceneMode":"opening|narration_focus|board_callout|return_to_narration|closing","contentClass":"fact|interpretation|satire"}],',
    '  "callouts": [{"id":"C001","text":"3-8 words, ALL-CAPS-ish emphasis allowed","factIds":["F003"],"highlightWords":["..."],"triggerNarrationId":"N002","priority":"high|medium","reveal":"type_on|marker_reveal"}],',
    '  "sources": ["S001"],',
    '  "editorialNotes": ["what remains uncertain / disputed"]',
    "}",
    "5 to 9 narration segments. 0 to 5 callouts; each must link to factIds or be clearly labelled editorial commentary.",
  ].join("\n");
}

export function buildScriptUserPrompt(ledger: EvidenceLedger, workingTitle: string, perspectiveBrief?: string[]): string {
  const aggregated = ledger.facts.some(f => (f.evidence ?? []).some(e => e.sourceId === "inshorts.com"));
  const attributionSection = aggregated
    ? [
        "",
        "ATTRIBUTION REQUIRED (Inshorts lane):",
        "- The FIRST or SECOND narration sentence MUST name the source, e.g. 'According to Inshorts…' (or 'Inshorts reports…'). Naming only the underlying outlet is NOT enough — Inshorts must be named.",
        "- EVERY factual claim must be voiced as reported — never as independently verified fact.",
        "- Cite at least TWO distinct ledger factIds across your segments (e.g. a segment whose factIds: [\"F001\",\"F002\"]).",
        "- The evidence is Inshorts' 60-word summary of the outlet's reporting. Credit Inshorts AND name the underlying outlet when the evidence does ('According to Inshorts, citing The Hindu…').",
        "- Do not quote the Inshorts summary verbatim.",
        "",
      ]
    : [];
  const balanceSection =
    perspectiveBrief && perspectiveBrief.length > 0
      ? [
          "",
          "Editorial balance map (framing context only — never a source of facts, never verbatim outlet prose):",
          ...perspectiveBrief.map(line => `- ${line}`),
          "",
          "If the evidence spans perspectives, the script may attribute each side in its own words ('according to…') and state plainly where they disagree. If one perspective is absent, say so — explicitly, in one dry line. Sarcasm targets the absurdity of the situation, never the existence of the other side's view.",
          "",
        ]
      : ["", "Editorial balance map: not computed for this run — keep attribution explicit and flag any framing the ledger cannot support.", ""];
  return [
    `Story: ${workingTitle}`,
    ...balanceSection,
    ...attributionSection,
    "Approved ledger (the ONLY permitted factual inputs):",
    serializeLedger(ledger),
    "",
    "Write the episode now. Remember: English, dry, one story, facts only from the ledger.",
  ].join("\n");
}

export async function draftScript(
  ledger: EvidenceLedger,
  workingTitle: string,
  options: ScriptOptions = {}
): Promise<ScriptDraft> {
  const target = options.targetSeconds ?? 65;
  const system = buildScriptSystemPrompt(target);
  const user = buildScriptUserPrompt(ledger, workingTitle, options.perspectiveBrief);
  const attempt = async (messages: { role: "system" | "user"; content: string }[]) => {
    const completion = await groqChatCompletion(
      messages,
      { model: GROQ_MODEL, maxTokens: 2200, log: options.log }
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
    } catch {
      throw new ScriptError("Groq returned unparseable JSON for the script.");
    }
    return { plan: normalizeEpisodeScript(parsed as Record<string, unknown>, ledger.storyId), usage: completion.usage, raw: completion.content };
  };

  let draft: ScriptDraft;
  try {
    draft = await attempt([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
  } catch (error) {
    if (error instanceof GroqError) {
      throw new ScriptError(`Groq could not draft the script: ${error.message}`);
    }
    throw error;
  }

  // One repair retry on validator failure before failing loudly.
  const validation = validateNewsScript(draft.plan, ledger);
  if (!validation.ok && options.repair !== false) {
    options.log?.(`  groq: script failed the validator (${validation.errors.length} error(s)); requesting one repair pass…`);
    const repair = await attempt([
      { role: "system", content: system },
      { role: "user", content: user },
      { role: "user", content: [
          "Your draft failed validation with these errors:",
          ...validation.errors.map(e => `- ${e}`),
          "",
          "Fix them by REMOVING or REWORDING ONLY the offending sentences. Do not introduce any new numbers, names, dates or quotes. Re-emit the full JSON.",
        ].join("\n") },
    ]);
    const repaired = validateNewsScript(repair.plan, ledger);
    if (repaired.ok) {
      draft = repair;
      (draft as { repairUsed?: boolean }).repairUsed = true;
    } else {
      const errors = [...validation.errors];
      throw new ScriptError(`Groq could not repair the script after one retry:\n${errors.map(e => `  - ${e}`).join("\n")}`);
    }
  }
  return draft;
}

export function normalizeEpisodeScript(raw: Record<string, unknown>, storyId: string): EpisodeScript {
  const narrationRaw = Array.isArray(raw.narration) ? raw.narration : [];
  const segments: NewsSegment[] = narrationRaw.map((s, i) => {
    const seg = s as Record<string, unknown>;
    const contentClass = (["fact", "interpretation", "satire"] as const).includes(seg.contentClass as never)
      ? (seg.contentClass as NewsSegment["contentClass"])
      : "fact";
    const delivery = (["dry_hook", "measured_explanation", "firm_attribution", "dry_observation", "punchline"] as const).includes(seg.delivery as never)
      ? (seg.delivery as NewsSegment["delivery"])
      : "measured_explanation";
    const sceneMode = (["opening", "narration_focus", "board_callout", "return_to_narration", "closing"] as const).includes(seg.sceneMode as never)
      ? (seg.sceneMode as NewsSegment["sceneMode"])
      : "narration_focus";
    return {
      id: typeof seg.id === "string" ? seg.id : `N${String(i + 1).padStart(3, "0")}`,
      text: String(seg.text ?? "").trim(),
      factIds: Array.isArray(seg.factIds) ? (seg.factIds as unknown[]).map(String) : [],
      delivery,
      sceneMode,
      contentClass,
    };
  }).filter(s => s.text.length > 0);

  const callouts = Array.isArray(raw.callouts) ? (raw.callouts as Record<string, unknown>[]).map((c, i) => ({
    id: typeof c.id === "string" ? c.id : `C${String(i + 1).padStart(3, "0")}`,
    text: String(c.text ?? "").replace(/\n+/g, " ").trim(),
    factIds: Array.isArray(c.factIds) ? (c.factIds as unknown[]).map(String) : [],
    highlightWords: Array.isArray(c.highlightWords) ? (c.highlightWords as unknown[]).map(String).slice(0, 4) : [],
    triggerNarrationId: typeof c.triggerNarrationId === "string" ? c.triggerNarrationId : segments[0]?.id ?? "N001",
    priority: c.priority === "high" ? "high" as const : "medium" as const,
    reveal: c.reveal === "marker_reveal" ? "marker_reveal" as const : "type_on" as const,
  })).filter(c => c.text.length > 0) : [];

  return {
    storyId,
    workingTitle: String(raw.workingTitle ?? "Untitled story").trim().slice(0, 120),
    language: "en",
    tone: "dry_sarcastic",
    estimatedDurationSeconds: Number(raw.estimatedDurationSeconds ?? 65) || 65,
    narration: segments,
    callouts,
    sources: Array.isArray(raw.sources) ? (raw.sources as unknown[]).map(String) : [],
    editorialNotes: Array.isArray(raw.editorialNotes) ? (raw.editorialNotes as unknown[]).map(String) : [],
    gateBApproval: null,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic validation (hard gate)                                 */
/* ------------------------------------------------------------------ */

export type ScriptValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  words: number;
  estimatedSeconds: number;
};

const LEGAL_STATUS_PAIRS: [RegExp, RegExp, string][] = [
  [/\b(proposed|tabled|planned|drafted)\b/i, /\b(passed|approved|enacted|became law)\b/i, "proposed->passed"],
  [/\b(FIR|chargesheet|charged|accused|alleges|allegation)\b/i, /\b(convicted|guilty|sentenced|conviction)\b/i, "allegation->conviction"],
  [/\b(investigat\w+|probe|inquiry)\b/i, /\b(proved|proven|confirmed guilty|found guilty)\b/i, "investigation->proof"],
  [/\b(company claims?|claims? to|reports?|says it achieved)\b/i, /\b(verified benchmark|independently verified|objectively the best|world's most powerful)\b/i, "company claim->verified"],
];

const VICTIM_TARGET_WORDS = /\b(children|child victims?|patients?|hospital deaths?|died in|hostages?|refugees?|survivors?|disabled people|the poor|victims?)\b/i;

/**
 * Proper-noun sequences, sentence-aware: a sentence-initial capitalized word
 * is only taken as part of a name if it is not a common English sentence
 * opener ("So", "There", "Whether"…). Multi-word sequences and interior
 * proper names are checked against the ledger as usual.
 */
const COMMON_OPENERS = new Set([
  "so", "there", "whether", "yes", "no", "what", "when", "where", "while",
  "meanwhile", "still", "yet", "and", "but", "or", "actually", "also", "now",
  "today", "here", "how", "why", "ok", "okay", "anyway", "even", "again",
  "well", "obviously", "clearly", "apparently", "basically", "right", "fine",
  "funny", "yeah", "nope", "honestly", "frankly", "look", "hey", "hit", "gosh",
  "definitely", "totally", "literally", "certainly", "exactly", "sure", "absolutely",
  "probably", "maybe", "perhaps", "inevitably", "crucially", "critically", "importantly",
  "notably", "interestingly", "tellingly", "curiously", "strikingly", "impressively",
  "surprisingly", "understandably", "noticeably", "wildly", "predictably", "of course",
  "seriously", "yikes", "geez", "alas", "odly", "more", "less", "higher", "lower", "fewer",
  "older", "younger", "bigger", "smaller", "cheaper", "dearer", "newer", "fresher",
  "according", "reportedly", "seemingly", "likely", "unsurprisingly",
  "larger", "wider", "deeper", "longer", "shorter", "quicker", "stronger", "weaker",
  "safer", "richer", "poorer", "greater", "fewer", "other", "another", "next", "last",
  "every", "some", "all", "most", "many", "several", "this", "that",
  "such", "these", "those", "it", "its", "they", "them", "each",
  "inshorts", // source attribution the ledger cannot carry but the channel must
]);

function properNounSequences(text: string): string[] {
  const sentences = text.split(/(^|[.!?]\s+)/).filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    const tokens = sentence.trim().split(/\s+/);
    let run: string[] = [];
    let tokenIndex = 0;
    const flush = (): void => {
      if (run.length > 0) {
        const cleaned = run
          .map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9&.]+$/g, ""))
          .filter(w => w.length >= 2 && !/^(The|A|An|In|On|At|Of|To|For|With|After|Before|Over|Under|This|That|It)$/i.test(w))
          .filter((w, i, arr) => !(i === 0 && arr.length > 1 && COMMON_OPENERS.has(w.toLowerCase())));
        if (cleaned.length >= 2) out.push(cleaned.join(" "));
        else if (cleaned.length === 1) {
          const w = cleaned[0];
          if (/[A-Z][a-z]{2,}/.test(w) && !COMMON_OPENERS.has(w.toLowerCase())
              && !/^(Apparently|Whether|So|There|Yes|No|What|When|Where|While|Meanwhile|Still|Yet|And|But|Or|How|Why|This|That|It|They|He|She|We|You|I|According|Reportedly|Seemingly|Likely|Unsurprisingly)$/i.test(w)) {
            out.push(w);
          }
        }
        run = [];
      }
    };
    for (const raw of tokens) {
      const cleaned = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9&.]+$/g, "");
      const isSentenceStart = tokenIndex === 0;
      const isProper = /^[A-Z]/.test(cleaned) && !/^(The|A|An)$/i.test(cleaned);
      const isOpener = isSentenceStart && COMMON_OPENERS.has(cleaned.toLowerCase());
      if (isProper && !isOpener) run.push(raw);
      else flush();
      tokenIndex += 1;
    }
    flush();
  }
  return [...new Set(out)].filter(e => e.length >= 3);
}

export function validateNewsScript(plan: EpisodeScript, ledger: EvidenceLedger, maxSeconds = 90): ScriptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // One story, one shape.
  if (plan.narration.length < 3) errors.push("Fewer than 3 narration segments.");
  if (plan.narration.length > 10) errors.push("More than 10 narration segments — split into one focused story or trim.");

  const ledgerFactIds = new Set(ledger.facts.map(f => f.id));
  const ledgerBlob = ledger.facts
    .map(f => `${f.claim}\n${f.evidence.map(e => e.excerpt ?? "").join("\n")}`)
    .join("\n");
  const ledgerBlobNorm = normalizeComparable(ledgerBlob);
  const ledgerFactNumbers = new Set(ledger.facts.flatMap(f => extractNumbers(f.claim + " " + (f.evidence.map(e => e.excerpt ?? "").join(" ")))));

  // Every factual segment needs at least one valid factId; satire/interp may carry none.
  for (const seg of plan.narration) {
    if (seg.contentClass === "fact") {
      if (seg.factIds.length === 0) {
        errors.push(`${seg.id} (fact) has no factIds.`);
        continue;
      }
      for (const id of seg.factIds) {
        if (!ledgerFactIds.has(id)) errors.push(`${seg.id} references unknown factId ${id}.`);
      }
    }
    // Numbers: every number in the segment must exist in the ledger blob (any factId owner).
    for (const n of extractNumbers(seg.text)) {
      if (!ledgerFactNumbers.has(n) && !excerptContains(ledgerBlob, n)) {
        errors.push(`${seg.id} contains number "${n}" absent from the ledger.`);
      }
    }
    // Entities: proper-name sequences (capitalized tokens), sentence-start aware.
    // Check per-token presence — "President Trump" ⊂ "President Donald Trump",
    // "Bangladesh Vietnam" ⊂ "Bangladesh, Vietnam and Cambodia" — while still
    // failing wholesale invention (no token of the sequence appears).
    for (const entity of properNounSequences(seg.text)) {
      const words = entity.split(" ").map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")).filter(w => w.length >= 2);
      const missingWords = words.filter(w => !ledgerBlobNorm.includes(normalizeComparable(w)));
      if (words.length > 0 && missingWords.length === words.length) {
        errors.push(`${seg.id} names "${entity}", absent from the ledger (missing: ${missingWords.join(", ")}).`);
      }
    }
    // Legal-status wording rules.
    for (const [trigger, banned, rule] of LEGAL_STATUS_PAIRS) {
      if (trigger.test(seg.text) && banned.test(seg.text)) {
        errors.push(`${seg.id} violates the "${rule}" legal-status rule.`);
      }
    }
    // Punchline/observation must never target victims.
    if ((seg.delivery === "punchline" || seg.delivery === "dry_observation") && VICTIM_TARGET_WORDS.test(seg.text)) {
      errors.push(`${seg.id} targets a protected group of people as the joke.`);
    }
    // No URLs/handles aloud.
    if (/https?:\/\/|www\.|@[a-z0-9_]+/i.test(seg.text)) errors.push(`${seg.id} contains a URL or handle.`);
  }

  // Callouts: must reference ledger facts; highlight words subset of callout text.
  for (const callout of plan.callouts) {
    if (callout.factIds.length === 0) {
      errors.push(`${callout.id} callout has no factIds (commentary must be labelled as such in editorialNotes).`);
      continue;
    }
    for (const id of callout.factIds) {
      if (!ledgerFactIds.has(id)) errors.push(`${callout.id} references unknown factId ${id}.`);
    }
    if (callout.highlightWords.length > 3) warnings.push(`${callout.id}: highlight more than 3 words is visually noisy.`);
  }

  // Estimate duration from measured pace (148 wpm) — the audio decides the real timing.
  const words = plan.narration.reduce((acc, s) => acc + s.text.split(/\s+/).filter(Boolean).length, 0);
  const estimatedSeconds = Math.round((words / 148) * 60 * 10) / 10;
  if (estimatedSeconds > maxSeconds) errors.push(`Estimated ${estimatedSeconds}s exceeds the technical guard (${maxSeconds}s).`);

  if (plan.narration.some(s => s.contentClass === "satire") === false && plan.callouts.length === 0) {
    warnings.push("No satire/observation beat and no callouts — consider whether the piece lands its identity.");
  }

  return { ok: errors.length === 0, errors, warnings, words, estimatedSeconds };
}
