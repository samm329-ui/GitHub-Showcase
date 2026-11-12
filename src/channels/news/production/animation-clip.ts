/**
 * Built-in animation clips for the news channel.
 *
 * These are starting points — real tuning happens on the artwork in M1/M2.
 * Everything here is deterministic: tracks in frames, closed easings, no
 * frame-count dependence on any other clip.
 */
import type { AnimationClipDef } from "./types.js";

export const CLIP_ENTER_LEFT: AnimationClipDef = {
  id: "enter_left",
  tracks: [
    { property: "character.x", keys: [
      { frame: 0, value: -650, easing: "easeOut" },
      { frame: 8, value: 70, easing: "easeInOut" },
      { frame: 18, value: 55, easing: "spring" },
    ] },
    { property: "character.rotation", keys: [
      { frame: 0, value: -3, easing: "easeOut" },
      { frame: 8, value: 0 },
    ] },
    { property: "character.scale", keys: [
      { frame: 0, value: 0.96, easing: "easeOut" },
      { frame: 8, value: 1.0 },
    ] },
  ],
};

export const CLIP_SETTLE: AnimationClipDef = {
  id: "settle_idle",
  tracks: [
    { property: "character.scale", keys: [
      { frame: 0, value: 1.0 },
      { frame: 6, value: 1.02, easing: "easeInOut" },
      { frame: 18, value: 1.0 },
    ] },
  ],
};

export const CLIP_BLINK: AnimationClipDef = {
  id: "blink",
  tracks: [
    { property: "eyes.openness", keys: [
      { frame: 0, value: 1 },
      { frame: 2, value: 0.1, easing: "step" },
      { frame: 5, value: 1, easing: "step" },
    ] },
  ],
};

export const CLIP_IDLE_BREATHING: AnimationClipDef = {
  id: "idle_breathing",
  tracks: [
    { property: "body.scaleY", keys: [
      { frame: 0, value: 1.0, easing: "easeInOut" },
      { frame: 45, value: 1.02, easing: "easeInOut" },
      { frame: 90, value: 1.0 },
    ] },
  ],
};

export const CLIP_LOOK_AT_BOARD: AnimationClipDef = {
  id: "look_at_board",
  tracks: [
    { property: "head.yaw", keys: [
      { frame: 0, value: 0, easing: "easeInOut" },
      { frame: 6, value: -14 },
    ] },
    { property: "eyes.gazeX", keys: [
      { frame: 0, value: 0, easing: "easeInOut" },
      { frame: 6, value: -0.45 },
    ] },
  ],
};

export const CLIP_RETURN_VIEWER: AnimationClipDef = {
  id: "return_to_viewer",
  tracks: [
    { property: "head.yaw", keys: [
      { frame: 0, value: -14, easing: "easeInOut" },
      { frame: 6, value: 0 },
    ] },
    { property: "eyes.gazeX", keys: [
      { frame: 0, value: -0.45, easing: "easeInOut" },
      { frame: 6, value: 0 },
    ] },
  ],
};

/** Emphasis for delivery of a sarcastic line (one-shot). */
export const CLIP_REACT_SARCASTIC: AnimationClipDef = {
  id: "react_sarcastic",
  tracks: [
    { property: "eyebrows.left", keys: [
      { frame: 0, value: 0, easing: "easeOut" },
      { frame: 2, value: -0.35 },
      { frame: 10, value: 0 },
    ] },
    { property: "eyebrows.right", keys: [
      { frame: 0, value: 0, easing: "easeOut" },
      { frame: 2, value: 0.35 },
      { frame: 10, value: 0 },
    ] },
  ],
};

export const BUILT_IN_CLIPS: AnimationClipDef[] = [
  CLIP_ENTER_LEFT,
  CLIP_SETTLE,
  CLIP_BLINK,
  CLIP_IDLE_BREATHING,
  CLIP_LOOK_AT_BOARD,
  CLIP_RETURN_VIEWER,
  CLIP_REACT_SARCASTIC,
];
