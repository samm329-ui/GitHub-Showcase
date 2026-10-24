import type { MeasuredAnchor, VisualAnchor } from "./types.js";

/**
 * Narration-led scroll choreography (Pass B).
 *
 * This is a pure contract layer: it maps a narrative visual target into a
 * document-space scroll position and a bounded transition duration. The
 * renderer still consumes its keyframes, so it never invents a second clock.
 */

export type VisualTarget = {
  id: string;
  narrativeNodeId: string;
  documentY: number;
  height: number;
  preferredFocusY: number;
  priority: number;
};

export type ScrollBeat = {
  targetId: string;
  startMs: number;
  endMs: number;
  targetScrollY: number;
  holdMs: number;
};

const MOVE_START_LEAD_MS = 600;
const MIN_HOLD_MS = 900;
const ALLOWED_MAX_SPEED = 1200; // CSS px/s on the card viewport.

/** Quintic smoothstep: zero velocity/acceleration at both ends. */
export function quinticProgress(u: number): number {
  const clamped = Math.max(0, Math.min(1, u));
  return 6 * clamped ** 5 - 15 * clamped ** 4 + 10 * clamped ** 3;
}

/** Document-space top the viewer should be looking at when the beat lands. */
export function targetScrollPosition(
  anchor: MeasuredAnchor,
  viewportHeight: number,
  documentHeight: number,
  focusRatio = 0.25
): number {
  const focus = anchor.offsetTop;
  const desired = focus - viewportHeight * focusRatio;
  const maxScroll = Math.max(0, documentHeight - viewportHeight);
  return Math.max(0, Math.min(maxScroll, Math.round(desired)));
}

/** Smooth in-bounds interpolation between two scroll positions. */
export function interpolateScroll(fromY: number, toY: number, progress: number): number {
  return fromY + (toY - fromY) * quinticProgress(progress);
}

/** Minimum duration that keeps the peak velocity under `allowedMaxSpeed`. */
export function minimumTransitionMs(distancePx: number, allowedMaxSpeed = ALLOWED_MAX_SPEED): number {
  const safeDistance = Math.abs(distancePx);
  if (safeDistance <= 0) return 0;
  return Math.round((1.875 * safeDistance * 1000) / allowedMaxSpeed);
}

/**
 * Scroll beats derived from the same timeline that the captions and mascot
 * cues use. Anchors are matched to narrative visual targets by semantic ids;
 * anything that cannot be matched is not scrolled to.
 */
export function planScrollBeats(options: {
  anchors: MeasuredAnchor[];
  documentHeight: number;
  viewportHeight: number;
  targetTimes: { anchor: VisualAnchor; startMs: number; endMs: number }[];
  allowedMaxSpeed?: number;
}): ScrollBeat[] {
  const beats: ScrollBeat[] = [];
  const byAnchor = new Map(options.anchors.map(anchor => [anchor.anchor, anchor]));
  const sorted = [...options.targetTimes].sort((a, b) => a.startMs - b.startMs);
  const allowed = options.allowedMaxSpeed ?? ALLOWED_MAX_SPEED;
  let previousEnd = 0;
  let previousY = 0;

  for (const target of sorted) {
    const anchor = byAnchor.get(target.anchor);
    if (!anchor) continue;
    const targetY = targetScrollPosition(anchor, options.viewportHeight, options.documentHeight);
    const transitionMs = minimumTransitionMs(Math.abs(targetY - previousY), allowed);
    const startMs = Math.max(previousEnd, target.startMs - MOVE_START_LEAD_MS);
    const endMs = Math.max(startMs + transitionMs, target.endMs);
    const holdMs = Math.max(MIN_HOLD_MS, endMs - startMs);
    beats.push({
      targetId: target.anchor,
      startMs,
      endMs,
      targetScrollY: targetY,
      holdMs,
    });
    previousEnd = endMs;
    previousY = targetY;
  }
  return beats;
}
