/**
 * Mascot layout geometry (Visual Composition Pass).
 *
 * The PNG's full rectangle is not the artwork: the source files carry a few
 * transparent padding pixels on every side. Placement therefore derives from
 * the *visible alpha bounds*, not from `image.width`. The constants below were
 * measured once from the shipped assets (alpha channel > 0) and are verified
 * against the real PNGs by `tests/mascot-layout.test.ts`, so the layout can
 * stay pure and deterministic at render time.
 *
 * All functions here are pure: same inputs, same outputs, no frame-order
 * dependency. The renderer can compute the same frame twice and get identical
 * geometry.
 */

export type AlphaBounds = {
  /** Full source-image width in px. */
  srcWidth: number;
  /** Full source-image height in px. */
  srcHeight: number;
  /** Inclusive visible-pixel bounds, in source-image coordinates. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Visible alpha bounds of `assets/character.png` (1284x1182). */
export const CHARACTER_ALPHA_BOUNDS: AlphaBounds = {
  srcWidth: 1284,
  srcHeight: 1182,
  minX: 6,
  minY: 6,
  maxX: 1278,
  maxY: 1176,
};

/** Visible alpha bounds of `assets/character-close.png` (1284x1004). */
export const CHARACTER_CLOSE_ALPHA_BOUNDS: AlphaBounds = {
  srcWidth: 1284,
  srcHeight: 1004,
  minX: 6,
  minY: 6,
  maxX: 1278,
  maxY: 1003,
};

export type MascotPlacementInput = {
  bounds: AlphaBounds;
  /** Rendered width of the full PNG rectangle, in canvas px. */
  renderedWidthPx: number;
  /** Canvas size (the 1080x1920 output). */
  canvasWidth: number;
  canvasHeight: number;
  /** Deliberate off-canvas clip of the *visible* edge, in canvas px. */
  clipRightPx: number;
  clipBottomPx: number;
};

export type MascotPlacement = {
  /** CSS `width` for the `.character` element. */
  widthPx: number;
  /** CSS height the browser will infer from the image ratio. */
  renderedHeightPx: number;
  /** CSS `right` value (negative = the PNG rectangle crosses the edge). */
  rightPx: number;
  /** CSS `bottom` value. */
  bottomPx: number;
  /** Visible artwork size after clipping. */
  visibleWidthPx: number;
  visibleHeightPx: number;
  /** How much *visible* artwork is clipped by each canvas edge. */
  clipRightPx: number;
  clipBottomPx: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Anchor the *visible* artwork to the canvas bottom-right with a deliberate
 * clip beyond each edge. The transparent padding never participates, so no
 * invisible margin shifts the character away from the corner.
 */
export function mascotPlacementCss(input: MascotPlacementInput): MascotPlacement {
  const { bounds, renderedWidthPx, canvasWidth, canvasHeight, clipRightPx, clipBottomPx } = input;
  const scale = renderedWidthPx / bounds.srcWidth;
  const renderedHeightPx = bounds.srcHeight * scale;

  const deadLeftPx = bounds.minX * scale;
  const deadRightPx = (bounds.srcWidth - 1 - bounds.maxX) * scale;
  const deadTopPx = bounds.minY * scale;
  const deadBottomPx = (bounds.srcHeight - 1 - bounds.maxY) * scale;

  // Visible right edge = canvasWidth + clipRightPx  ->  img right edge is the
  // visible edge plus the transparent dead space to its right.
  const rightPx = -(clipRightPx + deadRightPx);
  const bottomPx = -(clipBottomPx + deadBottomPx);

  return {
    widthPx: round2(renderedWidthPx),
    renderedHeightPx,
    rightPx: round2(rightPx),
    bottomPx: round2(bottomPx),
    visibleWidthPx: round2(renderedWidthPx - deadLeftPx - deadRightPx),
    visibleHeightPx: round2(renderedHeightPx - deadTopPx - deadBottomPx),
    // The anchor arithmetic places the visible edges exactly clipRightPx /
    // clipBottomPx beyond the canvas edges, by construction.
    clipRightPx: round2(clipRightPx),
    clipBottomPx: round2(clipBottomPx),
  };
}

export type MascotHeadAnchor = {
  /** Canvas Y of the top of the visible artwork (the hair/head line). */
  headTopY: number;
  /** Canvas X of the centre of the face/glasses region. */
  faceCenterX: number;
};

/** Horizontal centre of the face within the visible artwork (0..1). */
const FACE_X_RATIO = 0.55;

/**
 * Locate the mascot's head on the canvas. Only the top hair line and the face
 * centre are needed, and both derive from the visible bounds plus the exact
 * placement — the same frame always yields the same anchor.
 */
export function mascotHeadAnchor(
  input: MascotPlacementInput,
  placement: MascotPlacement
): MascotHeadAnchor {
  const { bounds, canvasWidth, canvasHeight } = input;
  const imageRightEdge = canvasWidth - placement.rightPx;
  const imageLeftEdge = imageRightEdge - placement.widthPx;
  const visibleLeftEdge = imageLeftEdge + (bounds.minX / bounds.srcWidth) * placement.widthPx;
  const visibleWidth = placement.visibleWidthPx;

  const imageBottomEdge = canvasHeight - placement.bottomPx;
  const imageTopEdge = imageBottomEdge - placement.renderedHeightPx;
  const visibleTopEdge = imageTopEdge + (bounds.minY / bounds.srcHeight) * placement.renderedHeightPx;

  return {
    headTopY: round2(visibleTopEdge),
    faceCenterX: round2(visibleLeftEdge + FACE_X_RATIO * visibleWidth),
  };
}

export type CalloutZone = {
  /** Bottom offset of the caption block, as a fraction of the viewport height. */
  bottomRatio: number;
};

/**
 * Position the caption block so it reads as a callout coming from the
 * mascot's head: the block hangs with its bottom edge a fixed gap above the
 * head-top line. Horizontal margins are safe-area ratios from
 * `CAPTION_OVERLAY`, applied directly in `card.ts`. Deterministic and
 * frame-order independent.
 */
export function speechCalloutZone(options: {
  headTopY: number;
  viewportTopPx: number;
  viewportHeightPx: number;
  /** Gap between the caption block and the head-top line. */
  headGapPx: number;
}): CalloutZone {
  const bottomEdgeY = options.headTopY - options.headGapPx;
  const bottomOffsetPx = options.viewportTopPx + options.viewportHeightPx - bottomEdgeY;
  return {
    bottomRatio: bottomOffsetPx / options.viewportHeightPx,
  };
}
