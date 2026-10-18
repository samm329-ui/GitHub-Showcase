import type { MeasuredAnchor, VisualAnchor } from "./types.js";
import { CARD_VIEWPORT_HEIGHT } from "./card.js";
import { VIEWPORT_PADDING } from "./config.js";

/**
 * Scroll anchors derived from the *rendered* document, never from guessed
 * percentages.
 *
 * `captureRepository` returns the measured offsets of every section that the
 * current card actually contains. This module turns them into clamped scroll
 * targets and rejects anchors that are not present.
 */

export type ScrollTarget = {
  anchor: VisualAnchor;
  scrollY: number;
  offsetTop: number;
  offsetHeight: number;
};

export type ScrollBounds = {
  documentHeight: number;
  viewportHeight: number;
  maxScroll: number;
};

export function scrollBounds(
  documentHeight: number,
  viewportHeight: number
): ScrollBounds {
  return {
    documentHeight,
    viewportHeight,
    maxScroll: Math.max(0, documentHeight - viewportHeight),
  };
}

export function clampScroll(value: number, bounds: ScrollBounds): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return bounds.maxScroll;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(bounds.maxScroll, Math.max(0, value));
}

/**
 * Target scroll position that puts a section near the top of the viewport,
 * clamped to the valid range. Sections shorter than the viewport are aligned
 * to their start rather than centred, so their heading stays visible.
 */
export function targetForAnchor(
  anchor: MeasuredAnchor,
  bounds: ScrollBounds,
  padding = VIEWPORT_PADDING
): number {
  if (anchor.offsetHeight <= 0) return clampScroll(0, bounds);
  const desired = anchor.offsetTop - padding;
  return clampScroll(desired, bounds);
}

/**
 * How a short document is handled: if the content barely overflows the
 * viewport there is nothing worth scrolling, so every anchor collapses to a
 * single stable position and the card simply holds.
 */
export function isScrollable(
  bounds: ScrollBounds,
  viewportHeight = bounds.viewportHeight
): boolean {
  // Require at least a fifth of the viewport before scrolling is worthwhile.
  return bounds.maxScroll > Math.max(48, viewportHeight * 0.2);
}

export function measuredAnchors(
  raw: { anchor: string | null; offsetTop: number; offsetHeight: number }[]
): MeasuredAnchor[] {
  return raw
    .filter((item): item is MeasuredAnchor =>
      Boolean(item.anchor && item.offsetHeight > 0)
    )
    .map(item => ({
      anchor: item.anchor as VisualAnchor,
      offsetTop: item.offsetTop,
      offsetHeight: item.offsetHeight,
    }));
}

export { CARD_VIEWPORT_HEIGHT };