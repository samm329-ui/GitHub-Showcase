/**
 * Deterministic camera keyframe evaluation and FFmpeg crop/scale expression
 * generation. Pure functions — unit-tested without Chromium or FFmpeg.
 */
export type CameraKey = {
  timeMs: number;
  scale: number;
  focusX: number;
  focusY: number;
};
export type Easing = "easeInOut" | "easeOut" | "easeIn" | "linear";

const clipT = (t: number, a: number, b: number): number =>
  Math.min(1, Math.max(0, (t - a) / Math.max(1e-6, b - a)));

/** Ease functions over normalized t in [0,1]. */
export function applyEasing(p: number, easing: Easing): number {
  const t = Math.min(1, Math.max(0, p));
  switch (easing) {
    case "linear":
      return t;
    case "easeIn":
      return t * t * t; // cubic-bezier(0.42, 0, 1, 1)
    case "easeOut":
      return 1 - Math.pow(1 - t, 3); // ease-out
    case "easeInOut":
    default:
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease-in-out cubic
  }
}

/** Interpolate a CameraKey channel list at absolute time timeMs. */
export function sampleCamera(
  keys: CameraKey[],
  timeMs: number,
  easing: Easing = "easeInOut"
): CameraKey {
  if (keys.length === 0) return { timeMs, scale: 1, focusX: 0, focusY: 0 };
  if (timeMs <= keys[0].timeMs) return { ...keys[0], timeMs };
  if (timeMs >= keys[keys.length - 1].timeMs) return { ...keys[keys.length - 1], timeMs };
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (timeMs >= a.timeMs && timeMs <= b.timeMs) {
      const p = applyEasing(clipT(timeMs, a.timeMs, b.timeMs), easing);
      return {
        timeMs,
        scale: a.scale + (b.scale - a.scale) * p,
        focusX: a.focusX + (b.focusX - a.focusX) * p,
        focusY: a.focusY + (b.focusY - a.focusY) * p,
      };
    }
  }
  return { ...keys[keys.length - 1], timeMs };
}

/** x/y window for a given zoom at a focus point. Clamped to image bounds. */
export function cropWindow(
  inW: number,
  inH: number,
  scale: number,
  focusX: number,
  focusY: number,
  baseW = 1920,
  baseH = 1080
): { x: number; y: number; width: number; height: number } {
  const z = Math.max(1, Math.min(2, scale));
  const width = Math.min(inW, baseW / z);
  const height = Math.min(inH, baseH / z);
  const x = Math.min(Math.max(0, focusX - width / 2), inW - width);
  const y = Math.min(Math.max(0, focusY - height / 2), inH - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/* ------------------------------------------------------------------ */
/* FFmpeg expression generation (piecewise, deterministic)              */
/* ------------------------------------------------------------------ */

const f = (n: number): string => {
  const s = n.toFixed(4).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
};

/** Piecewise-lerp expression for one channel of the camera over time (seconds). */
function channelExpr(keys: Array<{ tSec: number; v: number }>, easeName: Easing): string {
  if (keys.length === 0) return "1";
  if (keys.length === 1) return f(keys[0].v);
  const ease =
    easeName === "linear"
      ? "P"
      : easeName === "easeIn"
        ? "pow(P,3)"
        : easeName === "easeOut"
          ? "1-pow(1-P,3)"
          : "if(lt(P,0.5),4*P*P*P,1-pow(-2*P+2,3)/2)";

  // Build nested if(t < t1, seg0, if(t < t2, seg1, … last))
  let expr = f(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i -= 1) {
    const a = keys[i];
    const b = keys[i + 1];
    const P = `min(1,max(0,(t-${f(a.tSec)})/${f(b.tSec - a.tSec)}))`;
    const E = ease.replace(/P/g, `(${P})`);
    const seg = `${f(a.v)}+(${f(b.v)}-(${f(a.v)}))*(${E})`;
    expr = `if(lt(t,${f(b.tSec)}),${seg},${expr})`;
  }
  // Before the first key: hold the first value.
  return `if(lt(t,${f(keys[0].tSec)}),${f(keys[0].v)},${expr})`;
}

/**
 * Build the `crop` filter arguments for one camera move inside a fixed base
 * rectangle (the scene's viewRect). Key focus values must be expressed in
 * *base-rectangle coordinates* (viewRect-origin already subtracted). The
 * following `scale=1920:1080` maps the window back to the output canvas.
 */
export function buildCameraCropExpr(
  keys: CameraKey[],
  baseW: number,
  baseH: number,
  sceneStartMs: number,
  easing: Easing = "easeInOut"
): { w: string; h: string; x: string; y: string } {
  const t = (ms: number) => (ms - sceneStartMs) / 1000;
  const zKeys = keys.map(k => ({ tSec: t(k.timeMs), v: k.scale }));
  const fxKeys = keys.map(k => ({ tSec: t(k.timeMs), v: k.focusX }));
  const fyKeys = keys.map(k => ({ tSec: t(k.timeMs), v: k.focusY }));
  const z = channelExpr(zKeys, easing);
  const fx = channelExpr(fxKeys, easing);
  const fy = channelExpr(fyKeys, easing);
  const w = `${f(baseW)}/(${z})`;
  const h = `${f(baseH)}/(${z})`;
  const x = `min(max(0,(${fx})-(${w})/2),${f(baseW)}-(${w}))`;
  const y = `min(max(0,(${fy})-(${h})/2),${f(baseH)}-(${h}))`;
  return { w, h, x, y };
}
