/**
 * Keyframe evaluator — the heart of the deterministic engine.
 *
 * A track is an ordered list of {frame, value, easing?}. The `easing` on a
 * keyframe governs the segment that STARTS there (i.e. the ease into the next
 * key). Between keyframes the value is an interpolation by that easing; hold
 * and step behave as named guard rails. Anything outside [firstKey, lastKey]
 * clamps to the nearest endpoint — no extrapolation, ever.
 */
import type { Keyframe, Track } from "./types.js";
import { applyEasing } from "./easing.js";

export class KeyframeError extends Error {
  override name = "KeyframeError";
}

/** Guard: the clip's keyframes must not overlap or go backwards in time. */
export function validateTrack(track: Track): void {
  if (track.keys.length === 0) throw new KeyframeError(`Track '${track.property}' has no keys`);
  for (let i = 1; i < track.keys.length; i += 1) {
    if (track.keys[i].frame <= track.keys[i - 1].frame) {
      throw new KeyframeError(
        `Track '${track.property}' keys not strictly increasing at index ${i} (frame ${track.keys[i].frame} ≤ ${track.keys[i - 1].frame})`
      );
    }
  }
}

export function validateClip(id: string, tracks: Track[]): void {
  const seen = new Map<string, number>();
  for (const track of tracks) {
    validateTrack(track);
    seen.set(track.property, (seen.get(track.property) ?? 0) + 1);
  }
  for (const [property, count] of seen) {
    if (count > 1) throw new KeyframeError(`Clip '${id}' has duplicate track '${property}'`);
  }
}

/** Interpolated value for the animated property at an absolute frame. */
export function evalTrack(track: Track, frame: number): number {
  validateTrack(track);
  const keys = track.keys;
  if (frame <= keys[0].frame) return keys[0].value;
  if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;
  // Binary search for the segment containing `frame`.
  let lo = 0;
  let hi = keys.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.frame - a.frame;
  const t = span === 0 ? 0 : (frame - a.frame) / span;
  const eased = applyEasing(a.easing, t);
  return a.value + (b.value - a.value) * eased;
}

/** Evaluate every property in `properties` at an absolute frame. */
export function evalClip(tracks: Track[], frame: number, properties: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const track of tracks) {
    if (!properties.includes(track.property)) continue;
    out[track.property] = evalTrack(track, frame);
  }
  return out;
}
