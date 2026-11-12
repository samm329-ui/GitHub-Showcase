/**
 * Frame clock — exactly one time model for the whole production engine.
 *
 * 30 fps; integer frames; t = frame / fps. Everything (animation tracks,
 * audio events, caption highlights, scene beats) is derived from the same
 * integer frame index. No wall-clock timers, no frame-delta accumulation,
 * no "now".
 */

export const FPS = 30 as const;
export const CANVAS = { width: 1080, height: 1920 } as const;

/** Convert a frame index to seconds (exact for FPS=30: 1/60 subdivisions). */
export function framesToSeconds(frame: number): number {
  return frame / FPS;
}

/** Convert seconds to the nearest frame index. */
export function secondsToFrames(seconds: number): number {
  return Math.round(seconds * FPS);
}

/** Human-readable frame@time marker for manifest/QA logs. */
export function frameMarker(frame: number): string {
  const s = framesToSeconds(frame);
  return `f${frame}@${s.toFixed(4)}s`;
}

export interface TimelineEvent {
  frame: number;
  kind:
    | "clip-keyframe"
    | "caption-begin"
    | "caption-end"
    | "board-enter"
    | "audio"
    | "scene-beat";
  refId: string;
  payload?: Record<string, unknown>;
}

/** Same clock for audio alignment units (alignment arrives in ms). */
export function msToFrames(ms: number): number {
  return Math.round((ms * FPS) / 1000);
}

export function framesToMs(frame: number): number {
  return Math.round((frame * 1000) / FPS);
}

/** Non-decreasing ordering guard for compiled timelines. */
export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  const key = (e: TimelineEvent) =>
    e.frame * 10 + (e.kind === "caption-end" ? 1 : e.kind === "caption-begin" ? 0 : 5);
  return [...events].sort((a, b) => key(a) - key(b));
}

/** Overlap test for two [start, end) frame spans. */
export function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
