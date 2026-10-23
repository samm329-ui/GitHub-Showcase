import type { MeasuredAnchor, VisualAnchor } from "./types.js";
import { CARD_VIEWPORT_HEIGHT, VIEWPORT_PADDING } from "./config.js";

/**
 * Scroll anchors derived from the *measured* page screenshot, never from
 * guessed percentages.
 *
 * `mobile-capture.ts` returns anchor offsets in displayed raster pixels.
 * This module turns them into clamped scroll targets and rejects anchors that
 * are not present. There is no DOM-document fallback here: an anchor either was
 * measured or it is missing.
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
 * clamped to the valid range.
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
  raw: {
    anchor: string | null;
    offsetTop: number;
    offsetHeight: number;
    source?: "captured" | "fallback";
  }[]
): MeasuredAnchor[] {
  const allowed = new Set<VisualAnchor>([
    "repo-header",
    "file-list",
    "readme-intro",
    "install-command",
    "features",
    "license",
    "release",
  ]);
  return raw
    .filter(
      (item): item is {
        anchor: VisualAnchor;
        offsetTop: number;
        offsetHeight: number;
        source?: "captured" | "fallback";
      } =>
        Boolean(
          item.anchor &&
            allowed.has(item.anchor as VisualAnchor) &&
            Number.isFinite(item.offsetTop) &&
            item.offsetTop >= 0 &&
            item.offsetHeight > 0
        )
    )
    .map(item => ({
      anchor: item.anchor,
      offsetTop: item.offsetTop,
      offsetHeight: item.offsetHeight,
      source: item.source ?? "captured",
    }))
    .sort((a, b) => a.offsetTop - b.offsetTop);
}

export { CARD_VIEWPORT_HEIGHT };
