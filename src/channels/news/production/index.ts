/** Public surface of the deterministic production engine. */
export * from "./types.js";
export { FPS, CANVAS, framesToSeconds, secondsToFrames, msToFrames, framesToMs, frameMarker, sortEvents, spansOverlap } from "./frame-clock.js";
export type { TimelineEvent } from "./frame-clock.js";
export { linear, step, hold, easeIn, easeOut, easeInOut, spring, cubicBezier, applyEasing } from "./easing.js";
export { validateTrack, validateClip, KeyframeError, evalTrack, evalClip } from "./keyframe-evaluator.js";
export { BUILT_IN_CLIPS, CLIP_ENTER_LEFT, CLIP_SETTLE, CLIP_BLINK, CLIP_IDLE_BREATHING, CLIP_LOOK_AT_BOARD, CLIP_RETURN_VIEWER, CLIP_REACT_SARCASTIC } from "./animation-clip.js";
export { AUDIO_REGISTRY, audioDefinition } from "./audio-registry.js";
export type { AudioEventDef } from "./audio-registry.js";
export { compileTimeline } from "./timeline-compiler.js";
export type { CompiledTimeline } from "./timeline-compiler.js";
export { validateSpec, isSpecValid } from "./production-validator.js";
export type { Finding } from "./production-validator.js";
