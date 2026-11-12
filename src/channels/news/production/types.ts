/**
 * Lazy News production — the deterministic contract.
 *
 * This is the IMMUTABLE seam between the editorial pipeline (news research,
 * evidence ledger, human gates, Groq script) and the production engine
 * (layers, animation, camera, sound, render). Below this line nothing reads
 * a newspaper, an LLM, or the network. Everything is derived from this spec.
 *
 * Invariants enforced at build time and by the validator:
 *  - canvas is exactly 1080x1920, 30 fps, t = frame/30;
 *  - all asset references are repo-relative and exist;
 *  - provenance fields are sha256 pins of the approved inputs upstream;
 *  - specs are content-addressable (specHash is stable for identical specs).
 */
import crypto from "node:crypto";

export const SPEC_VERSION = "lazynews-production/1" as const;
export type SpecVersion = typeof SPEC_VERSION;

export const CANVAS = { width: 1080, height: 1920, fps: 30 } as const;

export type LayerRole =
  | "background"
  | "midground"
  | "character"
  | "desk"
  | "board"
  | "paper"
  | "caption"
  | "graphics"
  | "foreground";

export interface LayerDef {
  /** Unique within the spec. */
  id: string;
  role: LayerRole;
  /** Repo-relative path under assets/news/. */
  asset: string;
  /** Painter's algorithm: higher z wins. */
  z: number;
  /** Premultiplied alpha expected? */
  alpha: boolean;
  /** Anchor in canvas pixels (where the asset pivots/locks to). */
  anchorX: number;
  anchorY: number;
  /** Optional diffusely applied per-layer mask (e.g. "focus", "blur"). */
  focus?: "none" | "dim" | "blur";
}

export type EasingName =
  | "linear"
  | "step"
  | "hold"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "spring";

export interface Keyframe {
  /** Absolute frame at which this value is in effect (inclusive). */
  frame: number;
  value: number;
  /** Easing applied to the segment starting AT this keyframe. */
  easing?: EasingName;
}

export interface Track {
  /** e.g. "character.x", "character.rotation", "board.opacity". */
  property: string;
  keys: readonly Keyframe[];
}

export interface AnimationClipDef {
  id: string;
  tracks: Track[];
}

export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface CaptionBlockDef {
  id: string;
  words: CaptionWord[];
  /** Style token consumed by the typography renderer (resolver-owned). */
  style?: string;
}

export type BoardTextKind = "headline" | "verbatim" | "quote" | "number" | "decision" | "conflict";

export interface BoardEventDef {
  id: string;
  frame: number;
  kind: BoardTextKind;
  text: string;
  /** Non-null entries reference provenance, anchoring the card to evidence. */
  refs?: string[];
}

export type AudioEventName =
  | "entrance_whoosh"
  | "chair_settle"
  | "typewriter"
  | "paper_rustle"
  | "marker_swipe"
  | "soft_transition"
  | "dry_sting"
  | "channel_ident";

export interface AudioEventDef {
  id: string;
  name: AudioEventName;
  frame: number;
  gain?: number;
  pan?: number;
  /** Duck narration/music under this event. */
  duck?: boolean;
}

/** Where the mouth shapes came from — recorded for honest QA. */
export type VisemeSource = "phonemes" | "words" | "envelope";

export interface ProductionProvenance {
  ledgerHash: string;
  scriptHash: string;
  audioHash: string;
  alignmentHash: string;
  visemeSource: VisemeSource;
}

export interface ProductionSpec {
  specVersion: SpecVersion;
  episodeId: string;
  canvas: { width: 1080; height: 1920; fps: 30; durationFrames: number };
  layers: LayerDef[];
  clips: AnimationClipDef[];
  captions: CaptionBlockDef[];
  boardEvents: BoardEventDef[];
  audioEvents: AudioEventDef[];
  provenance: ProductionProvenance;
}

export class ProductionSpecError extends Error {
  override name = "ProductionSpecError";
}

/** Canonical JSON for content addressing (must be stable across runs). */
export function canonicalSpecJson(spec: ProductionSpec): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sortKeys(spec));
}

/** Content address of a spec. Identical bytes ⇒ identical hash. */
export function specHash(spec: ProductionSpec): string {
  return crypto.createHash("sha256").update(canonicalSpecJson(spec)).digest("hex");
}
