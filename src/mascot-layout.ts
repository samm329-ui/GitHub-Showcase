import type { ImpactAnchor } from "./types.js";

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
  /** CSS right/bottom offset (negative = extends past canvas edge) or deliberate clip. */
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
 * Anchor the visible artwork to the canvas bottom-right with exact CSS positioning.
 *
 * MASCOT_LAYOUT specifies CSS `offsetX` and `offsetY` as the authored CSS `right` and
 * `bottom` offsets (negative = extends past edge). The transparent PNG padding is
 * taken into account so visible clipping and anchors are strictly aligned with
 * the actual rendered CSS element.
 */
export function mascotPlacementCss(input: MascotPlacementInput): MascotPlacement {
  const { bounds, renderedWidthPx, canvasWidth, canvasHeight, clipRightPx, clipBottomPx } = input;
  const scale = renderedWidthPx / bounds.srcWidth;
  const renderedHeightPx = bounds.srcHeight * scale;

  const deadLeftPx = bounds.minX * scale;
  const deadRightPx = (bounds.srcWidth - 1 - bounds.maxX) * scale;
  const deadTopPx = bounds.minY * scale;
  const deadBottomPx = (bounds.srcHeight - 1 - bounds.maxY) * scale;

  // If clipRightPx is negative or zero, it is the authored CSS `right` offset directly.
  // If positive, it represents the visible edge clip beyond the canvas edge.
  const rightPx = clipRightPx <= 0 ? clipRightPx : -(clipRightPx + deadRightPx);
  const bottomPx = clipBottomPx <= 0 ? clipBottomPx : -(clipBottomPx + deadBottomPx);

  const actualClipRightPx = -(rightPx + deadRightPx);
  const actualClipBottomPx = -(bottomPx + deadBottomPx);

  return {
    widthPx: round2(renderedWidthPx),
    renderedHeightPx: round2(renderedHeightPx),
    rightPx: round2(rightPx),
    bottomPx: round2(bottomPx),
    visibleWidthPx: round2(renderedWidthPx - deadLeftPx - deadRightPx),
    visibleHeightPx: round2(renderedHeightPx - deadTopPx - deadBottomPx),
    clipRightPx: round2(actualClipRightPx),
    clipBottomPx: round2(actualClipBottomPx),
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

/** Normalized anchors on the character artwork (0..1 coordinates in PNG). */
export const MASCOT_NORMALIZED_POINTS = {
  headTop: { x: 0.52, y: 0.005 },
  faceCenter: { x: 0.549, y: 0.22 },
  anchors: {
    "hair-left": { x: 0.28, y: 0.12 },
    "hair-right": { x: 0.72, y: 0.09 },
    "shoulder-left": { x: 0.16, y: 0.55 },
    "shoulder-right": { x: 0.86, y: 0.52 },
    "laptop-edge": { x: 0.48, y: 0.78 },
  } as Record<ImpactAnchor, { x: number; y: number }>,
  protectedFaceRect: { x: 0.42, y: 0.16, width: 0.26, height: 0.26 },
} as const;

/**
 * Locate the mascot's head on the canvas. Only the top hair line and the face
 * centre are needed, and both derive from the visible bounds plus the exact
 * CSS placement — the same frame always yields the same anchor.
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

export type MascotPoseInput = {
  x: number;
  y: number;
  rotationDeg: number;
  scale: number;
  entranceX?: number;
  entranceY?: number;
  entranceScale?: number;
};

export type MascotFrameGeometry = {
  imageRect: { left: number; top: number; width: number; height: number };
  visibleRect: { left: number; top: number; width: number; height: number };
  headAnchor: MascotHeadAnchor;
  transformedHeadAnchor: MascotHeadAnchor;
  impactAnchors: Record<ImpactAnchor, { x: number; y: number }>;
  protectedFaceRect: { left: number; top: number; width: number; height: number };
};

export function transformPoint(
  x: number,
  y: number,
  originX: number,
  originY: number,
  pose?: MascotPoseInput
): { x: number; y: number } {
  if (!pose) return { x, y };
  const rad = (pose.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const scale = pose.scale * (pose.entranceScale ?? 1);
  const dx = x - originX;
  const dy = y - originY;
  const rx = (dx * cos - dy * sin) * scale;
  const ry = (dx * sin + dy * cos) * scale;
  const totalX = pose.x + (pose.entranceX ?? 0);
  const totalY = pose.y + (pose.entranceY ?? 0);
  return {
    x: round2(originX + rx + totalX),
    y: round2(originY + ry + totalY),
  };
}

export function getMascotFrameGeometry(
  input: MascotPlacementInput,
  placement: MascotPlacement,
  pose?: MascotPoseInput
): MascotFrameGeometry {
  const { canvasWidth, canvasHeight, bounds } = input;
  const imageLeft = canvasWidth - placement.rightPx - placement.widthPx;
  const imageTop = canvasHeight - placement.bottomPx - placement.renderedHeightPx;
  const imageRect = {
    left: round2(imageLeft),
    top: round2(imageTop),
    width: round2(placement.widthPx),
    height: round2(placement.renderedHeightPx),
  };

  const scale = placement.widthPx / bounds.srcWidth;
  const deadLeftPx = bounds.minX * scale;
  const deadTopPx = bounds.minY * scale;

  const visibleRect = {
    left: round2(imageLeft + deadLeftPx),
    top: round2(imageTop + deadTopPx),
    width: placement.visibleWidthPx,
    height: placement.visibleHeightPx,
  };

  const baseHead = mascotHeadAnchor(input, placement);

  // CSS transform origin: 50% 100%
  const originX = imageLeft + placement.widthPx * 0.5;
  const originY = imageTop + placement.renderedHeightPx;

  const transformedHeadPoint = transformPoint(baseHead.faceCenterX, baseHead.headTopY, originX, originY, pose);
  const transformedHeadAnchor: MascotHeadAnchor = {
    headTopY: transformedHeadPoint.y,
    faceCenterX: transformedHeadPoint.x,
  };

  const impactAnchors = {} as Record<ImpactAnchor, { x: number; y: number }>;
  for (const [key, pt] of Object.entries(MASCOT_NORMALIZED_POINTS.anchors) as [ImpactAnchor, { x: number; y: number }][]) {
    const rawX = imageLeft + pt.x * placement.widthPx;
    const rawY = imageTop + pt.y * placement.renderedHeightPx;
    impactAnchors[key] = transformPoint(rawX, rawY, originX, originY, pose);
  }

  const faceBox = MASCOT_NORMALIZED_POINTS.protectedFaceRect;
  const faceRawX = imageLeft + faceBox.x * placement.widthPx;
  const faceRawY = imageTop + faceBox.y * placement.renderedHeightPx;
  const faceRawW = faceBox.width * placement.widthPx;
  const faceRawH = faceBox.height * placement.renderedHeightPx;
  const faceTopLeft = transformPoint(faceRawX, faceRawY, originX, originY, pose);

  const effScale = pose ? pose.scale * (pose.entranceScale ?? 1) : 1;
  const protectedFaceRect = {
    left: faceTopLeft.x,
    top: faceTopLeft.y,
    width: round2(faceRawW * effScale),
    height: round2(faceRawH * effScale),
  };

  return {
    imageRect,
    visibleRect,
    headAnchor: baseHead,
    transformedHeadAnchor,
    impactAnchors,
    protectedFaceRect,
  };
}

export type CalloutZone = {
  /** Bottom offset of the caption block, as a fraction of the viewport height. */
  bottomRatio: number;
};

/**
 * Legacy caption-zone helper: places a caption block a fixed gap above the
 * head-top line.
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

