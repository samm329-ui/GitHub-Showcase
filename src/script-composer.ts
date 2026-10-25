import type {
  CalloutRole,
  EnrichedRepo,
  FactLedger,
  NarrationPlan,
  NarrationSegment,
  SegmentPurpose,
  StorySlot,
  VisualAnchor,
} from "./types.js";
import {
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  TARGET_DURATION_SECONDS,
  TTS_SPEED,
  TTS_VOICE,
  pauseFor,
  type PauseKind,
} from "./config.js";
import {
  planEvidence,
  type ExplanationNode,
  type ExplanationPlan,
  type ExplanationRole,
} from "./explanation-planner.js";
import { planPathWithOmissions } from "./narrative-graph.js";
import { evaluateScriptability, type ScriptabilityReport } from "./scriptability.js";
import { humaniseRepoName } from "./narration-grammar.js";
import { selectAngle, wordCount } from "./narration.js";
import { toSpoken } from "./pronunciation.js";
import { calloutTextFor } from "./callout-overlay.js";

/**
 * Script composer (Pass A): graph path -> sentences.
 *
 * This is the production narrator. It consumes the *selected* path from the
 * narrative graph — a connected, evidence-backed sequence of ideas — and turns
 * each node into one or two natural sentences. Phrasing is contextual:
 * "For example," introduces example evidence and nothing else, "One thing to
 * know:" only wraps an established constraint, and a problem stated as
 * "It exists because ..." is given its antecedent before it is spoken.
 *
 * Truth rules:
 *   - every segment cites exactly the facts behind its node; nothing is
 *     invented, and roles without evidence are recorded as omissions;
 *   - `spokenText` is speech-normalised (`toSpoken`) while `captionText`
 *     keeps the raw wording for the screen;
 *   - `pauseAfterMs` comes from the shared `TTS_PAUSE_POLICY`, so the audio
 *     concat and the visual timeline consume one schedule.
 */

export type ComposeOptions = {
  targetDurationSeconds?: number;
  voiceId?: string;
  speed?: number;
};

export type ComposedScript = {
  /** The single narration plan: validation, quality and TTS all read this. */
  plan: NarrationPlan;
  /** The explanation plan, including the selected path and omission reasons. */
  explanation: ExplanationPlan;
  scriptability: ScriptabilityReport;
  /** Roles dropped for lack of evidence — never fabricated. */
  omissions: { id: string; reason: string }[];
};

/* ------------------------------------------------------------------ */
/* Role mappings                                                       */
/* ------------------------------------------------------------------ */

const SLOT_FOR_ROLE: Record<ExplanationRole, StorySlot> = {
  hook: "hook",
  problem: "hook",
  purpose: "identity",
  mechanism: "value",
  example: "demo",
  benefit: "value",
  differentiator: "value",
  tradeoff: "caveat",
  installation: "setup",
  closing: "cta",
};

const PURPOSE_FOR_ROLE: Record<ExplanationRole, SegmentPurpose> = {
  hook: "identify",
  problem: "problem",
  purpose: "identify",
  mechanism: "explain",
  example: "demo",
  benefit: "benefit",
  differentiator: "explain",
  tradeoff: "caveat",
  installation: "install",
  closing: "cta",
};

/** Map a node's visual target onto the renderer's anchor vocabulary. */
function anchorFor(node: ExplanationNode): VisualAnchor {
  const target = node.visualTargetIds[0] ?? "repo-header";
  if (target === "release") return "release";
  if (target === "file-list") return "file-list";
  if (target.startsWith("readme#")) {
    const section = target.slice("readme#".length);
    if (/install/.test(section)) return "install-command";
    if (/feature/.test(section)) return "features";
    if (/licen/.test(section)) return "license";
    return "readme-intro";
  }
  return "repo-header";
}

/* ------------------------------------------------------------------ */
/* Phrasing                                                            */
/* ------------------------------------------------------------------ */

function sentence(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compose the spoken sentence for one planned idea.
 *
 * The proposition is the evidence's own spoken form; the lead-in is chosen by
 * the *role* and only ever adds connective tissue, never new claims:
 *
 *   purpose       "Rocket CLI is a ..." when the fact is a noun phrase
 *   problem       a leading "It/This ..." gets the project as its antecedent
 *   example       "For example, ..." — example evidence and nothing else
 *   tradeoff      "One thing to know: ..." — an established constraint
 *   installation  "To get started, ..."
 */
export function phraseFor(node: ExplanationNode, name: string): string {
  const proposition = node.proposition.trim();
  switch (node.role) {
    case "problem": {
      // "It exists because ..." spoken before the project is named has no
      // antecedent. Substitute the name deterministically; the claim itself
      // is untouched.
      const pronoun = proposition.match(/^(it|this)\s+(\w.*)$/i);
      if (pronoun) return sentence(`${name} ${pronoun[2]}`);
      return sentence(proposition);
    }
    case "purpose": {
      if (new RegExp(`^${escapeRegExp(name)}\\b`, "i").test(proposition)) {
        return sentence(proposition);
      }
      if (/^(a|an|the)\b/i.test(proposition)) {
        return sentence(`${name} is ${lowerFirst(proposition)}`);
      }
      return sentence(proposition);
    }
    case "example":
      return sentence(`For example, ${lowerFirst(proposition)}`);
    case "tradeoff":
      return sentence(`One thing to know: ${lowerFirst(proposition)}`);
    case "installation":
      return sentence(`To get started, ${lowerFirst(proposition)}`);
    default:
      return sentence(proposition);
  }
}

/**
 * The pause between two consecutive roles reflects the *boundary*: a beat
 * before a concrete example, a longer one before a limitation, a closing
 * beat before installation.
 */
export function pauseKindBetween(from: ExplanationRole, to: ExplanationRole): PauseKind {
  if (to === "example") return "example";
  if (to === "tradeoff") return "contrast";
  if (to === "installation" || to === "closing") return "closing";
  if (from === to) return "continuation";
  return "newIdea";
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compose the production script for one repository.
 *
 * Never throws for a weak repository: a scriptability failure is reported in
 * `scriptability` (and the caller decides — discovery skips the candidate,
 * manual selection prints the missing-evidence report). A thin but honest
 * repository still composes whatever the evidence supports, with every gap
 * recorded in `omissions`.
 */
export function composeScript(
  ledger: FactLedger,
  repo: EnrichedRepo,
  options: ComposeOptions = {}
): ComposedScript {
  const target = Math.min(
    MAX_DURATION_SECONDS,
    Math.max(
      MIN_DURATION_SECONDS,
      options.targetDurationSeconds ?? TARGET_DURATION_SECONDS
    )
  );

  const scriptability = evaluateScriptability(repo, ledger);
  const raw = planEvidence(ledger, repo, target * 1000);
  const { plan: explanation, selected, omitted } = planPathWithOmissions(raw);

  const name = humaniseRepoName(repo.name);
  const segments: NarrationSegment[] = selected.map((node, index) => {
    const next = selected[index + 1] ?? null;
    const text = phraseFor(node, name);
    // Callout copy is derived from selected evidence after composition:
    // purpose, mechanism, example, benefit/outcome, or key tradeoff.
    // `null` means no faithful short form exists, and no bubble is rendered.
    const calloutRole: CalloutRole | undefined =
      node.role === "purpose" || node.role === "problem"
        ? "purpose"
        : node.role === "mechanism"
        ? "mechanism"
        : node.role === "example"
        ? "example"
        : node.role === "benefit" || node.role === "differentiator"
        ? "benefit"
        : node.role === "tradeoff"
        ? "tradeoff"
        : node.role === "installation"
        ? "installation"
        : undefined;
    const calloutEligible = Boolean(calloutRole);
    const calloutText = calloutEligible
      ? calloutTextFor(node.proposition) ?? calloutTextFor(text)
      : null;
    return {
      id: `seg-${String(index + 1).padStart(2, "0")}`,
      purpose: PURPOSE_FOR_ROLE[node.role],
      spokenText: toSpoken(text),
      captionText: text,
      factIds: node.evidence.map(reference => reference.factId),
      ...(calloutText ? { calloutText, calloutRole, calloutImportance: node.importance } : {}),
      visualAnchor: anchorFor(node),
      // One schedule for audio and timeline: the pause AFTER this segment.
      // The final segment carries an explicit zero — no trailing silence.
      pauseAfterMs: next ? pauseFor(pauseKindBetween(node.role, next.role)) : 0,
      narrativeRole: SLOT_FOR_ROLE[node.role],
      clauseId: `graph.${node.id}`,
    };
  });

  const angle = selectAngle(ledger, repo);
  const plan: NarrationPlan = {
    repositoryNodeId: repo.nodeId,
    fullName: repo.full_name,
    angle: angle.angle,
    angleReason: angle.reason,
    targetDurationSeconds: target,
    styleVariant: "evidence-graph",
    voiceId: options.voiceId ?? TTS_VOICE,
    speed: options.speed ?? TTS_SPEED,
    estimatedWords: wordCount(
      segments.map(segment => segment.spokenText).join(" ")
    ),
    segments,
    structure: "evidence-graph",
  };

  return { plan, explanation, scriptability, omissions: omitted };
}
