import type { EvidenceRecord, ClaimKind, ContentClass } from "./types.js";
import type { ProposedClaim } from "./ledger.js";

/**
 * Deterministic atomic-claim extraction — the DEFAULT in place of the LLM.
 *
 * Discipline: claims are verbatim from the evidence. We never rewrite meaning,
 * never strengthen it, never invent it. A claim is a sentence that survived a
 * grammar gate (action verb), a boilerplate gate (navigation/ads/tickers) and
 * a length gate. Classification is by keyword grammars only — no model calls.
 *
 * Where the evidence is a complete article (PIB/RBI/ET full text) this is the
 * verifier's raw material. Where it is RSS metadata (title + description) it
 * yields 1-4 thin-but-honest attributed claims.
 */

export type DeterministicClaimOptions = {
  maxClaims?: number;
  minTokens?: number;
  maxTokens?: number;
};

/* ------------------------------------------------------------------ */
/* Sentence splitting                                                  */
/* ------------------------------------------------------------------ */

const PROTECT = /(?:U\.S\.|U\.K\.|Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.|Inc\.|Ltd\.|Co\.|Corp\.|No\.|Jr\.|Sr\.|St\.|Ph\.D\.|a\.m\.|p\.m\.|vs\.|etc\.|e\.g\.|i\.e\.|avg\.|Govt\.|Gen\.|Dept\.|Sect\.|Arts?\.)/g;

export function splitSentences(text: string): string[] {
  const guarded = text.replace(PROTECT, m => m.replace(/\./g, "·"));
  const parts = guarded.split(/(?<=[.!?]["'”’)]?)\s+(?=[A-Z0-9"“‘'$₹(])/g);
  return parts.map(p => p.replace(/·/g, ".").trim()).filter(p => p.length >= 12 && p.length <= 400);
}

/* ------------------------------------------------------------------ */
/* Gate 1: boilerplate                                                 */
/* ------------------------------------------------------------------ */

const BOILERPLATE_RE = /newsletter|subscribe|click here|read more|read also|also read|also-see|advertisement|sponsored|promo|market snapshot|closing bell|live market|live updates|morning brief|epaper|e-paper|follow us|share this|copy link|comment below|terms of use|privacy policy|cookie policy|all rights reserved|rights reserved|copyright|\d{1,2}:\d{2}\s*(am|pm|ist|est|utc|gmt)|last updated|market screener|stock screener|52-week|with inputs from|with agency|https?:\/\/|www\.|\.gov\b|press release/i;

export function isBoilerplate(sentence: string): boolean {
  return BOILERPLATE_RE.test(sentence);
}

/* ------------------------------------------------------------------ */
/* Gate 2: action-verb significance                                    */
/* ------------------------------------------------------------------ */

const ACTION_VERBS = [
  "announc", "launch", "approv", "rul", "penalt", "lev", "file", "fil", "pass",
  "ban", "block", "clear", "order", "direct", "propos", "withdraw", "introduce",
  "grant", "reject", "accept", "ink", "sign", "strike", "acquir", "invest", "pump",
  "scrap", "drop", "slash", "hike", "raise", "cut", "probe", "investigat", "suspend",
  "arrest", "indict", "fine", "sentenc", "convict", "acquit", "expel", "deny",
  "reject", "confirm", "dismiss", "adjourn", "stay", "appeal", "plea", "file",
  "clear", "greenlight", "green-light", "rollout", "rolls out", "roll-out",
  "inaugur", "unveil", "reveal", "publish", "releas", "issue", "deliver",
  "hold", "chair", "wrap", "conclud", "finalis", "finaliz", "greenlight",
  "compel", "expedite", "urge", "press", "push", "threaten", "warn", "claim",
  "report", "according", "tell", "told", "said", "say", "says", "made", "make", "reportedly", "slam", "decry",
  "moot", "slash", "surpass", "overtake", "overtook", "hit", "surge", "plunge",
  "dip", "jump", "skyrocket", "soar", "fall", "slump", "crash", "rebound",
  "record", "secur", "win", "lose", "beat", "claim", "lead", "govern", "reign",
  "divest", "spawn", "risk", "gap", "retire", "resign", "quit", "boot", "boot",
  "appoint", "name", "nominate", "select", "pick", "install", "step down",
];

export function hasActionVerb(sentence: string): boolean {
  const s = sentence.toLowerCase();
  return ACTION_VERBS.some(v => s.includes(v));
}

/* ------------------------------------------------------------------ */
/* Classification grammars                                             */
/* ------------------------------------------------------------------ */

const MONTH_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(,\s*\d{4})?\b/;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const NUMBER_RE = /\d+(\.\d+)?(\s?(%|percent|crore|lakh|billion|million|trillion|thousand|bn|mn|usd|inr|rs|₹|\$|€|£|rupee|chang)?\b|(\.\d+)?)|\d{1,3}(,\d{3})+(\.\d+)?/i;
const LEGAL_RE = /supreme court|high court|sessions court|district court|tribunal|FIR|chargesheet|charge\s?sheet|verdict|judgment|judge|plea|appeal|stay|adjourn|convict|sentenc|acquit|bail|enacted|passed by|ordinance|notif|act,|amendment|order(ed)?\s+on|stayed|struck down|dismisse|upheld/i;
const ALLEGATION_RE = /alleg|accus|chargesheet|charge\s?sheet|FIR|scam|bribery|fraud|corrupt|cover-?up|coverup|denied|allegedly|accused|denial/i;
const FORECAST_RE = /expected|forecast|projected|likely to|will\s+(be|see|take|make|hit|cover)/i;
const ANALYSIS_RE = /could|might|may\s+|analysis|opinion|explains?|meaning|impact of|why it|what it means/i;
const QUOTE_RE = /["“][^"”]{6,}["”]/;
const SAYS_RE = /\b(said|says|told|announced|added|stated|informed|clarified|confirmed|denied|according to|per\b)\b/i;

export type SentenceClass = {
  kind: ClaimKind;
  contentClass: ContentClass;
  importance: "core" | "supporting" | "optional";
  attribution: string | null;
  quote: string | null;
};

/** Best-effort speaker capture: "…, Finance Minister Nirmala Sitharaman said" */
const SPEAKER_RE = /((?:the\s+|a\s+|an\s+)?(?:[A-Z][A-Za-z.&'-]+(?:\s+[A-Z][A-Za-z.&'-]+){0,4}))\s+(?:,?\s*)?(?:said|told|announced|added|stated|informed|clarified|reportedly said)/i;

export function classifySentence(sentence: string): SentenceClass {
  const hasQuote = QUOTE_RE.test(sentence);
  const isAllegation = ALLEGATION_RE.test(sentence);
  const hasYearOrMonth = YEAR_RE.test(sentence) || MONTH_RE.test(sentence);
  const hasNumber = NUMBER_RE.test(sentence);
  const isLegal = LEGAL_RE.test(sentence);
  const isForecast = FORECAST_RE.test(sentence);
  const isAnalysis = ANALYSIS_RE.test(sentence);
  const speakerMatch = sentence.match(SPEAKER_RE);
  const speaker = speakerMatch?.[1]?.trim() ?? null;

  let kind: ClaimKind = "event";
  if (hasQuote) kind = "quote";
  else if (isAllegation) kind = "claim_by_actor";
  else if (isLegal && /dated|passed|order|struck|stayed|upheld|convict|acquit|sentenc/i.test(sentence) && /court|tribunal|judgment|verdict|bench|judge/i.test(sentence)) kind = "legal_status";
  else if (isLegal) kind = "legal_status";
  else if (hasNumber) kind = "number";
  else if (hasYearOrMonth) kind = "date";
  else if (isForecast) kind = "forecast";
  else if (isAnalysis) kind = "analysis";

  let contentClass: ContentClass = "fact";
  if (isAnalysis || (isForecast && /likely|expected|could|might/i.test(sentence))) contentClass = "interpretation";

  let importance: SentenceClass["importance"] = "supporting";
  if (kind === "quote" || kind === "legal_status" || kind === "number") importance = "core";
  else if (hasNumber || hasYearOrMonth) importance = "core";
  if (sentence.length > 240) importance = importance === "core" ? "supporting" : "optional";

  let attribution: string | null = null;
  if (speaker) attribution = `${speaker.replace(/^the\s+/i, "").trim()} said`;
  else if (SAYS_RE.test(sentence)) attribution = "a source said";
  if (isAllegation && !attribution) attribution = "an official alleged";

  const quoteMatch = sentence.match(QUOTE_RE);
  const quote = quoteMatch ? quoteMatch[0].replace(/^["“]|["”]$/g, "") : null;

  return { kind, contentClass, importance, attribution, quote };
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

const cleanCandidateSentence = (s: string): string =>
  s.replace(/\(\s*with inputs?\s+from[^)]*\)/gi, "")
   .replace(/\s+/g, " ")
   .replace(/[ \t]+$/, "")
   .replace(/^[,\s]+/, "")
   .trim();

export function extractClaimsFromEvidence(
  records: EvidenceRecord[],
  opts: DeterministicClaimOptions = {}
): ProposedClaim[] {
  const maxClaims = opts.maxClaims ?? 12;
  const minTokens = opts.minTokens ?? 6;
  const maxTokens = opts.maxTokens ?? 40;

  const seen = new Set<string>();
  const claims: ProposedClaim[] = [];

  for (const record of records) {
    const text = record.excerpt ?? "";
    const sentences = splitSentences(text);
    for (const rawSentence of sentences) {
      const sentence = cleanCandidateSentence(rawSentence);
      if (!sentence) continue;
      if (isBoilerplate(sentence)) continue;
      const tokens = sentence.split(/\s+/).filter(Boolean);
      if (tokens.length < minTokens || tokens.length > maxTokens) continue;
      if (!hasActionVerb(sentence)) continue;

      const classified = classifySentence(sentence);
      const quoteText = classified.quote
        ? [{ text: classified.quote, sourceId: record.sourceId }]
        : [];

      // dedup identical sentences across the captured evidence set
      const key = sentence.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);

      claims.push({
        claim: sentence,
        kind: classified.kind,
        importance: classified.importance,
        contentClass: classified.contentClass,
        attribution: classified.attribution,
        quotes: quoteText,
      });
    }
  }

  // Keep substantive claims, prefer numbers/quotes/legal/short sentences.
  const rank = (c: ProposedClaim): number =>
    (c.kind === "quote" ? 30 : 0) +
    (c.kind === "legal_status" ? 25 : 0) +
    (/\d/.test(c.claim) ? 20 : 0) +
    (c.importance === "core" ? 10 : c.importance === "supporting" ? 5 : 0) +
    Math.max(0, 15 - c.claim.split(/\s+/).length / 2);

  claims.sort((a, b) => rank(b) - rank(a));
  return claims.slice(0, maxClaims);
}
