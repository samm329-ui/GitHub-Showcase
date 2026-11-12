/**
 * Audio event registry — the only source of event names and their defaults.
 * Deterministic: identical spec ⇒ identical mix, no random gain, no LFO.
 */
import type { AudioEventName } from "./types.js";

export interface AudioEventDef {
  name: AudioEventName;
  asset: string;
  defaultGain: number;
  /** ms */
  defaultDurationMs: number;
  defaultPan: number;
  /** Whether this event ducks the narration. */
  duck: boolean;
}

export const AUDIO_REGISTRY: Record<AudioEventName, AudioEventDef> = {
  entrance_whoosh: { name: "entrance_whoosh", asset: "assets/sfx/entrance-whoosh.wav", defaultGain: 0.65, defaultDurationMs: 380, defaultPan: 0, duck: false },
  chair_settle:    { name: "chair_settle",    asset: "assets/sfx/chair-settle.wav",    defaultGain: 0.8,  defaultDurationMs: 320, defaultPan: 0, duck: false },
  typewriter:      { name: "typewriter",      asset: "assets/sfx/typewriter-short.wav", defaultGain: 0.55, defaultDurationMs: 850, defaultPan: 0.05, duck: false },
  paper_rustle:    { name: "paper_rustle",    asset: "assets/sfx/paper-rustle.wav",    defaultGain: 0.5,  defaultDurationMs: 520, defaultPan: -0.08, duck: false },
  marker_swipe:    { name: "marker_swipe",    asset: "assets/sfx/marker-swipe.wav",    defaultGain: 0.6,  defaultDurationMs: 260, defaultPan: 0,  duck: false },
  soft_transition: { name: "soft_transition", asset: "assets/sfx/soft-transition.wav", defaultGain: 0.45, defaultDurationMs: 420, defaultPan: 0,  duck: true },
  dry_sting:       { name: "dry_sting",       asset: "assets/sfx/dry-comedic-sting.wav", defaultGain: 0.5, defaultDurationMs: 650, defaultPan: 0,  duck: false },
  channel_ident:   { name: "channel_ident",   asset: "assets/sfx/channel-ident.wav",   defaultGain: 0.7,  defaultDurationMs: 900, defaultPan: 0,  duck: false },
};

export function audioDefinition(name: AudioEventName): AudioEventDef {
  const def = AUDIO_REGISTRY[name];
  if (!def) throw new Error(`Unknown audio event '${name}' — register it in AUDIO_REGISTRY first.`);
  return def;
}
