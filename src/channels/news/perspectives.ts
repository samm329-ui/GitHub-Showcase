/**
 * Editorial-perspective balance — the "every perspective" layer.
 *
 * The whole point of the lazy-news channel is that NO outlet's frame reaches
 * the viewer unchallenged. This module measures which editorial perspectives
 * the collected evidence actually spans, using the `perspective` tag on each
 * outlet in the registry. It never scores an outlet's accuracy and never
 * blocks rendering — it produces a brief the human Gate A reviewer and the
 * script prompt must both see.
 *
 * Scope rules:
 *  - only `sourceRole: "independent_reporting"` outlets carry an editorial
 *    voice; primary records and fact-check desks carry no `perspective` by
 *    design and are excluded from the maths;
 *  - GDELT/Bluesky register links but wrap no editorial line, so they are
 *    excluded here too.
 */
import type { EditorialPerspective, EvidenceRecord } from "./types.js";

export const PERSPECTIVES: readonly EditorialPerspective[] = [
  "left",
  "centre_left",
  "centre",
  "centre_right",
  "right",
] as const;

const LABEL: Record<EditorialPerspective, string> = {
  left: "left-coded",
  centre_left: "centre-left",
  centre: "centre",
  centre_right: "centre-right",
  right: "right-coded",
};

export type PerspectiveCoverage = {
  /** perspective → outlet sourceIds (distinct), independent reporting only. */
  outletsByPerspective: Partial<Record<EditorialPerspective, string[]>>;
  perspectivesPresent: EditorialPerspective[];
  perspectivesMissing: EditorialPerspective[];
  /** Every tagged independent outlet in the evidence shares ONE perspective. */
  singlePerspective: boolean;
  /** Both poles of the spectrum (left|centre_left and centre_right|right) are represented. */
  spectrumComplete: boolean;
  /** Human-readable lines for Gate A artifacts and the Groq prompt. Never outlet prose. */
  brief: string[];
};

/** The perspective tag of an evidence record, or null when the outlet has no editorial voice. */
function perspectiveOf(record: EvidenceRecord): EditorialPerspective | null {
  const policy = record.policy;
  if (policy.sourceRole !== "independent_reporting") return null;
  return policy.perspective ?? null;
}

/** Measure which perspectives the evidence spans. Pure; no I/O, no randomness. */
export function computePerspectiveCoverage(records: EvidenceRecord[]): PerspectiveCoverage {
  const byPerspective = new Map<EditorialPerspective, Set<string>>();
  for (const record of records) {
    const perspective = perspectiveOf(record);
    if (!perspective) continue;
    let bucket = byPerspective.get(perspective);
    if (!bucket) {
      bucket = new Set();
      byPerspective.set(perspective, bucket);
    }
    bucket.add(record.sourceId);
  }

  const perspectivesPresent = PERSPECTIVES.filter(p => byPerspective.has(p));
  const perspectivesMissing = PERSPECTIVES.filter(p => !byPerspective.has(p));
  const outletsByPerspective: Partial<Record<EditorialPerspective, string[]>> = {};
  for (const [perspective, outlets] of byPerspective) {
    outletsByPerspective[perspective] = [...outlets].sort();
  }

  const hasLeftPole = byPerspective.has("left") || byPerspective.has("centre_left");
  const hasRightPole = byPerspective.has("centre_right") || byPerspective.has("right");
  const singlePerspective = perspectivesPresent.length === 1;

  const brief: string[] = [];
  if (perspectivesPresent.length === 0) {
    brief.push("Perspective map: no perspective-tagged independent outlet in evidence — the balance check cannot be performed.");
  } else {
    const rendered = PERSPECTIVES.filter(p => byPerspective.has(p))
      .map(p => `${LABEL[p]}: ${[...byPerspective.get(p)!].sort().join(", ")}`);
    brief.push(`Perspective map (independent reporting only): ${rendered.join(" | ")}`);
  }
  if (singlePerspective) {
    brief.push(
      `Every independent outlet in evidence is ${LABEL[perspectivesPresent[0]]} — the story is one-sided as told. ` +
        "Find at least one outlet from another perspective (or a primary record) before approving Gate A."
    );
  } else if (!hasLeftPole) {
    brief.push("No left-leaning coverage in evidence — present the centre/right framing honestly and name where the left view is absent.");
  } else if (!hasRightPole) {
    brief.push("No right-leaning coverage in evidence — present the centre/left framing honestly and name where the right view is absent.");
  }
  if (hasLeftPole && hasRightPole) {
    brief.push("Both poles present — the script may quote each side's OWN words ('according to…') and state plainly where they disagree.");
  }

  return {
    outletsByPerspective,
    perspectivesPresent,
    perspectivesMissing,
    singlePerspective,
    spectrumComplete: hasLeftPole && hasRightPole,
    brief,
  };
}
