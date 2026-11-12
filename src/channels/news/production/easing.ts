/**
 * Easing curves — pure functions of segment-local progress t ∈ [0, 1].
 *
 * All curves are closed-form. No ODE integration, no frame-delta accumulation.
 * Given identical (t, curve) the result is bit-identical on every machine.
 */
import type { EasingName } from "./types.js";

export function linear(t: number): number { return t; }

/** Hold then jump: value of the earlier keyframe until the next keyframe. */
export function step(t: number): number { return t < 1 ? 0 : 1; }

/** Jump at the start, then hold (inverse of step). */
export function hold(t: number): number { return t <= 0 ? 0 : 1; }

export function easeIn(t: number): number { return t * t; }
export function easeOut(t: number): number { return 1 - (1 - t) * (1 - t); }
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

const CUBIC_EPS = 1e-6;
const NEWTON_MAX_ITER = 50;
const BISECT_MAX_ITER = 60;

/** Canonical cubic-Bézier easing (P0=(0,0), P3=(1,1)); monotonic in x. */
export function cubicBezier(t: number, p1x: number, p1y: number, p2x: number, p2y: number): number {
  const x = (u: number) => {
    const a = 1 - u;
    return 3 * a * a * u * p1x + 3 * a * u * u * p2x + u * u * u;
  };
  const y = (u: number) => {
    const a = 1 - u;
    return 3 * a * a * u * p1y + 3 * a * u * u * p2y + u * u * u;
  };
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let u = t;
  for (let i = 0; i < NEWTON_MAX_ITER; i += 1) {
    const xt = x(u) - t;
    if (Math.abs(xt) < CUBIC_EPS) return y(u);
    const dx = (x(u + 1e-6) - x(u - 1e-6)) / 2e-6;
    if (Math.abs(dx) < CUBIC_EPS) break;
    u = Math.min(1, Math.max(0, u - xt / dx));
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECT_MAX_ITER; i += 1) {
    const mid = (lo + hi) / 2;
    if (x(mid) < t) lo = mid;
    else hi = mid;
  }
  return y((lo + hi) / 2);
}

/**
 * Deterministic "spring-ish" settle — damped sinusoid with FIXED constants
 * (omega = 9, lambda = 4.5). Settles flat by ~1 s. Good for entrance wobble.
 * Not a physics simulation; fully reproducible.
 */
export function spring(t: number): number {
  if (t >= 1) return 1;
  const omega = 9;
  const lambda = 4.5;
  return 1 - (Math.exp(-lambda * Math.min(1, t)) * Math.sin(omega * Math.min(1, t))) / 1.3;
}

export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear,
  step,
  hold,
  easeIn,
  easeOut,
  easeInOut,
  spring: t => Math.min(1, Math.max(0, spring(t))),
};

export function applyEasing(name: EasingName | undefined, t: number): number {
  const fn = (name && EASINGS[name]) ?? linear;
  return fn(Math.min(1, Math.max(0, t)));
}
