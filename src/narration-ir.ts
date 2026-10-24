import type {
  Fact,
  FactLedger,
  NarrationPlan,
  NarrationSegment,
  RepoNarration,
  SegmentPurpose,
  StorySlot,
} from "./types.js";

/**
 * Structured intermediate representation of the narration (Phase 2 gate).
 *
 * The timed plan is compiled down to the content a viewer must take away:
 * what the project is, what it does, how it works and when you would use it.
 * Popularity metadata is kept, but explicitly secondary. The validator runs
 * before TTS so an incomplete script fails the run instead of shipping a
 * video that lists stars without explaining the repository.
 *
 * Truth rule: the compiler only projects clauses that already carry verified
 * fact ids. When the evidence for mechanism or a use case is missing, the
 * claim is omitted (never invented) and validation excuses that section.
 */

/** Stars/forks/license-style metadata may not exceed this share of the words. */
export const MAX_METADATA_WORD_SHARE = 0.35;

export type NarrationCoverage = {
  /** The ledger contains feature evidence, so mechanism must be explained. */
  hasFeatureEvidence: boolean;
  /** The README documents usage/examples, so a use case must be stated. */
  hasUseCaseEvidence: boolean;
  /** Share of narration words spent on stars/forks/license-style metadata. */
  metadataWordShare: number;
  /** Where the use-case text came from, or "none" when evidence is absent. */
  useCaseSource: "use-case-facts" | "none";
};

/** Slot a segment belongs to, via its grammar role or its purpose fallback. */
const SLOT_FOR_PURPOSE: Record<SegmentPurpose, StorySlot> = {
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

function slotOf(segment: NarrationSegment): StorySlot {
  return segment.narrativeRole ?? SLOT_FOR_PURPOSE[segment.purpose];
}

function joinSegments(segments: NarrationSegment[]): string {
  return segments
    .map(segment => segment.spokenText.trim())
    .filter(text => text.length > 0)
    .join(" ");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function factsCited(
  segment: NarrationSegment,
  factById: Map<string, Fact>
): Fact[] {
  return segment.factIds
    .map(id => factById.get(id))
    .filter((fact): fact is Fact => Boolean(fact));
}

/**
 * Facts that can demonstrate a practical use case: explicit usage prose or a
 * documented example / workflow command. A feature clause that merely *lands*
 * in a demo slot does not qualify — treating demo-shaped placement as proof
 * of a use case was the silent-omission defect this rule exists to prevent.
 */
function demonstratesUseCase(fact: Fact): boolean {
  return (
    fact.kind === "use_case" ||
    fact.semantic === "example" ||
    fact.semantic === "workflow"
  );
}

/**
 * Compile a completed narration plan into the structured script and measure
 * how well the available evidence is covered. `ledger` grounds the looked-up
 * fact kinds; the plan itself supplies all spoken text.
 */
export function compileRepoNarration(
  plan: NarrationPlan,
  ledger: FactLedger
): { script: RepoNarration; coverage: NarrationCoverage } {
  const factById = new Map(ledger.facts.map(fact => [fact.id, fact]));
  const segments = plan.segments;
  const slot = (role: StorySlot) => segments.filter(s => slotOf(s) === role);

  const identitySegments = [...slot("hook"), ...slot("identity")];

  /* Purpose: the identity segment's fact claims, grounded in the ledger. */
  let purpose = "";
  for (const segment of identitySegments) {
    const purposeFact = factsCited(segment, factById).find(
      fact => fact.kind === "purpose"
    );
    if (purposeFact) {
      purpose = sentence(purposeFact.claim);
      break;
    }
  }
  if (!purpose) purpose = firstSentence(joinSegments(identitySegments));

  /* Mechanism: feature-backed value/demo clauses (the "how it works"). */
  const mechanismSegments = [...slot("value"), ...slot("demo")];
  const mechanism = joinSegments(mechanismSegments);

  /* Use case: segments citing use-case evidence — usage prose, a documented
   * example, or a workflow. Placement in a demo slot proves nothing on its
   * own; the cited fact must demonstrate the use. */
  const useCaseSegments = segments.filter(segment =>
    factsCited(segment, factById).some(demonstratesUseCase)
  );
  let useCaseSource: NarrationCoverage["useCaseSource"] = "none";
  let useCase = "";
  if (useCaseSegments.length > 0) {
    useCase = joinSegments(useCaseSegments);
    useCaseSource = "use-case-facts";
  }

  const benefitSegments = slot("value");
  const limitationSegments = slot("caveat");
  const installationSegments = slot("setup");
  const popularitySegments = slot("proof");

  const totalWords = wordCount(joinSegments(segments).replace(/\s+/g, " "));
  const metadataWords = wordCount(
    joinSegments([...popularitySegments, ...slot("availability")])
  );
  const metadataWordShare = totalWords > 0 ? metadataWords / totalWords : 0;

  return {
    script: {
      hook: firstSentence(joinSegments(identitySegments)),
      purpose,
      mechanism,
      useCase,
      benefit: joinSegments(benefitSegments),
      ...(limitationSegments.length > 0
        ? { limitation: joinSegments(limitationSegments) }
        : {}),
      ...(installationSegments.length > 0
        ? { installation: joinSegments(installationSegments) }
        : {}),
      ...(popularitySegments.length > 0
        ? { optionalPopularityFact: joinSegments(popularitySegments) }
        : {}),
    },
    coverage: {
      hasFeatureEvidence:
        mechanismSegments.length > 0 ||
        ledger.facts.some(fact => fact.kind === "feature"),
      hasUseCaseEvidence: ledger.facts.some(demonstratesUseCase),
      metadataWordShare,
      useCaseSource,
    },
  };
}

/**
 * Structural validation gate, run before TTS. With no coverage argument the
 * spec's strict rule applies: purpose, mechanism and use case must exist.
 * Evidence gaps recorded in `coverage` excuse the omissible sections instead
 * of pushing the compiler to invent unsupported claims.
 */
export function validateNarration(
  script: RepoNarration,
  coverage?: NarrationCoverage
): string[] {
  const errors: string[] = [];

  if (!script.purpose.trim()) errors.push("Missing repository purpose");

  if (!script.mechanism.trim()) {
    // Excused only when the repository offers no feature evidence at all.
    if (!coverage || coverage.hasFeatureEvidence) {
      errors.push("Missing explanation of mechanism");
    }
  }

  if (!script.useCase.trim()) {
    // Excused only when the ledger carries no use-case evidence at all. If a
    // usage sentence, a documented example or a workflow exists, omitting it
    // is a bug — the gate must fail rather than skip the section.
    const excused = coverage
      ? coverage.useCaseSource === "none" && !coverage.hasUseCaseEvidence
      : false;
    if (!excused) errors.push("Missing practical use case");
  }

  if (
    coverage &&
    coverage.metadataWordShare > MAX_METADATA_WORD_SHARE
  ) {
    // Dominance is only a failure when real explanation evidence existed that
    // the metadata could crowd out. A repository with no feature, usage or
    // description depth cannot be "explained" — the thin script is an honest
    // omission, not a popularity takeover.
    const hadSomethingToSay =
      script.mechanism.trim().length > 0 ||
      script.useCase.trim().length > 0 ||
      coverage.hasFeatureEvidence ||
      coverage.hasUseCaseEvidence;
    if (hadSomethingToSay) {
      errors.push(
        `Popularity metadata dominates the script: ` +
          `${(coverage.metadataWordShare * 100).toFixed(0)}% of narration words ` +
          `exceed the ${MAX_METADATA_WORD_SHARE * 100}% budget`
      );
    }
  }

  return errors;
}

function sentence(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

/** First sentence of a block of spoken text, normalised to a full sentence. */
function firstSentence(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  const match = cleaned.match(/^(.*?[.!?])(\s|$)/);
  return sentence(match ? match[1] : cleaned);
}
