/**
 * Timeline compiler — immutable spec ⇒ deterministic, flat render list.
 *
 * Output order contract (stable sort):
 *   1. caption-begin (frame)   4. audio (frame+half-step)
 *   2. caption-end   (frame+1) 5. scene-beat (frame+quarter-step)
 *   3. board-enter   (frame)   6. clip keyframes folded into scene-graphs later
 */
import { msToFrames, sortEvents, type TimelineEvent } from "./frame-clock.js";
import type { ProductionSpec } from "./types.js";
import { audioDefinition } from "./audio-registry.js";

export interface CompiledTimeline {
  specHash: string;
  episodeId: string;
  durationFrames: number;
  events: TimelineEvent[];
}

/** Flatten the spec into a monotonically-increasing event stream. Pure. */
export function compileTimeline(spec: ProductionSpec, hashFn: (s: ProductionSpec) => string): CompiledTimeline {
  const events: TimelineEvent[] = [];

  for (const clip of spec.clips) {
    // One synthetic scene-beat per clip, ordered where the clip starts.
    const firstFrame = Math.min(...clip.tracks.flatMap(t => t.keys.map(k => k.frame)));
    events.push({ frame: firstFrame, kind: "scene-beat", refId: clip.id, payload: { kind: "clip_start" } });
  }

  for (const block of spec.captions) {
    for (const word of block.words) {
      events.push({ frame: msToFrames(word.startMs), kind: "caption-begin", refId: `${block.id}:${word.word}`, payload: { word: word.word } });
      events.push({ frame: msToFrames(word.endMs) + 1, kind: "caption-end", refId: `${block.id}:${word.word}`, payload: { word: word.word } });
    }
  }

  for (const beat of spec.boardEvents) {
    events.push({ frame: beat.frame, kind: "board-enter", refId: beat.id, payload: { kind: beat.kind, text: beat.text } });
  }

  for (const ev of spec.audioEvents) {
    const def = audioDefinition(ev.name); // validates registration at compile time
    events.push({ frame: ev.frame, kind: "audio", refId: ev.id, payload: { name: def.name, gain: ev.gain ?? def.defaultGain, pan: ev.pan ?? def.defaultPan, duck: ev.duck ?? def.duck } });
  }

  return {
    specHash: hashFn(spec),
    episodeId: spec.episodeId,
    durationFrames: spec.canvas.durationFrames,
    events: sortEvents(events),
  };
}
