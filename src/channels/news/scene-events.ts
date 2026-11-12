import type { EpisodeScript, NewsSceneEvent } from "./types.js";

/**
 * Build the scene-event timeline from the measured audio + approved script.
 * Events are derived from the narration clock, never fixed timestamps.
 *
 * Layout (native artwork canvas):
 *   background 1.png      x=0..941     y=0..1672
 *   board 2.png           x=202..901   y=216..766
 *   paper                 x=245..795   y=315..640   (safe text zone)
 *   pin 3.png             x=507..595   y=258..362
 *   note-left.png         left sticky note, x≈575..700 y≈650..765
 *   note-right.png        right sticky note, x≈725..845 y≈640..770
 *   narrator 8.png        x=0..941     y=645..1335
 *   grey card 9.png       x=64..882    y=1286..1465
 *   caption text zone     x=95..850    y=1310..1445
 */

export type NewsSceneBuildInput = {
  script: EpisodeScript;
  timeline: { id: string; startMs: number; endMs: number }[];
  targetMs: number;
};

export function buildNewsSceneEvents(input: NewsSceneBuildInput): NewsSceneEvent[] {
  const { script, timeline, targetMs } = input;
  const events: NewsSceneEvent[] = [];
  const timeOf = (id: string) => timeline.find(t => t.id === id) ?? null;
  const segmentById = new Map(script.narration.map(s => [s.id, s]));

  const first = timeline[0];
  const base = first?.startMs ?? 0;
  void targetMs;

  // Opening: narrator slides in from left; headline is already on the paper.
  events.push({
    id: "ev_opening",
    startMs: 0,
    endMs: base + 700,
    mode: "opening",
    narrationIds: script.narration.slice(0, 1).map(s => s.id),
    factIds: [],
    subtitleText: undefined,
    backgroundFocus: "normal",
    narratorMotion: "entrance",
    stickyNoteMotion: "idle",
    sfx: ["chair_swishe"],
  });

  for (const segment of script.narration) {
    const t = timeOf(segment.id);
    if (!t) continue;
    events.push({
      id: `ev_focus_${segment.id}`,
      startMs: Math.max(0, t.startMs - 80),
      endMs: t.endMs,
      mode: "narration_focus",
      narrationIds: [segment.id],
      factIds: segment.factIds,
      subtitleText: segment.text,
      backgroundFocus: "dim_soft_blur",
      narratorMotion: "idle",
      stickyNoteMotion: "idle",
    });
  }

  // Callouts: short reveal on the paper, tied to their trigger narration id.
  for (const callout of script.callouts) {
    const t = timeOf(callout.triggerNarrationId);
    if (!t) continue;
    const durationMs = Math.min(
      2600,
      Math.max(1500, callout.text.split(/\s+/).length * 320)
    );
    events.push({
      id: `ev_callout_${callout.id}`,
      startMs: Math.max(0, t.startMs + 120),
      endMs: Math.min(t.endMs + 400, t.startMs + 120 + durationMs),
      mode: "board_callout",
      narrationIds: [callout.triggerNarrationId],
      factIds: callout.factIds,
      boardText: callout.text,
      highlightWords: callout.highlightWords,
      boardReveal: callout.reveal,
      backgroundFocus: "normal",
      narratorMotion: "subtle_tilt",
      stickyNoteMotion: "pause",
      sfx: ["pin_tap", "marker_write"],
    });
  }

  const last = script.narration[script.narration.length - 1];
  const lastT = last ? timeOf(last.id) : null;
  const endMs = lastT?.endMs ?? timeline[timeline.length - 1]?.endMs ?? targetMs;
  events.push({
    id: "ev_closing",
    startMs: Math.max(0, endMs - 1200),
    endMs,
    mode: "closing",
    narrationIds: last ? [last.id] : [],
    factIds: last?.factIds ?? [],
    backgroundFocus: "normal",
    narratorMotion: "settle",
    stickyNoteMotion: "idle",
  });

  // Sort by start; board_callout events overlap narration_focus by design.
  events.sort((a, b) => a.startMs - b.startMs);
  void segmentById;
  return events;
}

export function sceneStateAt(events: NewsSceneEvent[], timeMs: number): {
  backgroundFocus: "normal" | "dim_soft_blur";
  activeCallout: NewsSceneEvent | null;
  narrator: "entrance" | "idle" | "subtle_tilt" | "settle";
  notes: "idle" | "pause";
  subtitle: string | null;
} {
  let backgroundFocus: "normal" | "dim_soft_blur" = "normal";
  let activeCallout: NewsSceneEvent | null = null;
  let narrator: "entrance" | "idle" | "subtle_tilt" | "settle" = "idle";
  let notes: "idle" | "pause" = "idle";
  let subtitle: string | null = null;

  for (const event of events) {
    if (timeMs < event.startMs || timeMs >= event.endMs) continue;
    if (event.mode === "opening") {
      narrator = "entrance";
      backgroundFocus = "normal";
      notes = event.stickyNoteMotion === "pause" ? "pause" : "idle";
    }
    if (event.mode === "narration_focus") {
      backgroundFocus = "dim_soft_blur";
      narrator = "idle";
      subtitle = event.subtitleText ?? null;
      notes = "idle";
    }
    if (event.mode === "board_callout") {
      backgroundFocus = "normal";
      activeCallout = event;
      narrator = "subtle_tilt";
      notes = "pause";
      subtitle = null;
    }
    if (event.mode === "closing") {
      backgroundFocus = "normal";
      narrator = "settle";
    }
  }
  return { backgroundFocus, activeCallout, narrator, notes, subtitle };
}
