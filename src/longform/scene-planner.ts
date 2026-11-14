/**
 * Scene planner — maps the validated master script + measured narration +
 * captured assets onto a single master clock.
 *
 * Output: SceneManifest (all tracks on one 1920×1080 @30fps clock, ms based).
 * No randomness; every decision is a pure function of inputs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { toTimedChunks, type SynthesizedChunk } from "../voice.js";
import type { NarrationSegment } from "../types.js";
import type { AlignedWord } from "../channels/news/types.js";
import type {
  CameraKey,
  CaptureBundle,
  MasterSegment,
  MasterScript,
  Scene,
  SceneManifest,
} from "./types.js";

/** Map master segments onto the narration engine's segment shape (purpose coercion). */
export function toSynthSegments(script: MasterScript): NarrationSegment[] {
  const purposeMap: Record<string, NarrationSegment["purpose"]> = {
    identify: "identify",
    explain: "explain",
    feature: "explain",
    demo: "demo",
    install: "install",
    caveat: "caveat",
    summary: "benefit",
    transition: "benefit",
    cta: "cta",
  };
  const segments: NarrationSegment[] = [];
  segments.push({
    id: "hook",
    purpose: "identify",
    spokenText: script.opening.hookSpoken,
    captionText: script.opening.hookSpoken,
    factIds: [],
    pauseAfterMs: 420,
  });
  segments.push({
    id: "digin",
    purpose: "cta",
    spokenText: script.opening.digInSpoken,
    captionText: script.opening.digInSpoken,
    factIds: [],
    pauseAfterMs: 650,
  });
  for (const repo of script.repositories) {
    for (const seg of repo.segments) {
      segments.push({
        id: seg.id,
        purpose: purposeMap[seg.purpose] ?? "explain",
        spokenText: seg.spokenText,
        captionText: seg.captionText,
        factIds: seg.factIds,
        pauseAfterMs: seg.pauseAfterMs,
      });
    }
  }
  segments.push({
    id: "closing",
    purpose: "cta",
    spokenText: script.closing.spokenText,
    captionText: script.closing.spokenText,
    factIds: [],
    pauseAfterMs: 0,
  });
  return segments;
}

export type TimedSegment = { id: string; startMs: number; endMs: number };

export function buildSegmentTimings(
  synthSegments: NarrationSegment[],
  chunks: SynthesizedChunk[]
): TimedSegment[] {
  const timed = toTimedChunks(chunks, synthSegments);
  return timed.map(c => ({ id: c.segmentId, startMs: c.startMs, endMs: c.endMs }));
}

export function wordsForSegment(
  words: AlignedWord[],
  segmentStartMs: number,
  segmentEndMs: number
): AlignedWord[] {
  return words.filter(w => w.endMs > segmentStartMs && w.startMs < segmentEndMs + 1);
}

const OVERVIEW_PUSH_MS = 3400;

function overviewCamera(startMs: number, focusY: number): CameraKey[] {
  return [
    { timeMs: startMs, scale: 1.0, focusX: 960, focusY },
    { timeMs: startMs + OVERVIEW_PUSH_MS, scale: 1.08, focusX: 960, focusY },
    { timeMs: startMs + OVERVIEW_PUSH_MS + 1800, scale: 1.08, focusX: 960, focusY },
  ];
}

function readmeCamera(startMs: number, endMs: number, focusX: number, focusY: number): CameraKey[] {
  return [
    { timeMs: startMs, scale: 1.0, focusX, focusY },
    { timeMs: Math.min(endMs, startMs + 2200), scale: 1.07, focusX, focusY },
  ];
}

function codeCamera(startMs: number, endMs: number, focusY: number): CameraKey[] {
  return [
    { timeMs: startMs, scale: 1.0, focusX: 960, focusY },
    { timeMs: Math.min(endMs, startMs + 1800), scale: 1.13, focusX: 960, focusY },
  ];
}

type SegmentWithTiming = MasterSegment & { startMs: number; endMs: number };

function groupContentSegments(
  segments: SegmentWithTiming[]
): Array<{ type: MasterSegment["visualTarget"]["type"]; detail: string; segments: SegmentWithTiming[] }> {
  const groups: Array<{ type: MasterSegment["visualTarget"]["type"]; detail: string; segments: SegmentWithTiming[] }> = [];
  for (const seg of segments) {
    const type = seg.visualTarget.type;
    const detail = seg.visualTarget.detail;
    const last = groups[groups.length - 1];
    if (last && last.type === type && last.segments.length < 4) {
      last.segments.push(seg);
    } else {
      groups.push({ type, detail, segments: [seg] });
    }
  }
  return groups;
}

const REVEAL_MS = 2400;
const MIN_SCENE_MS = 700;

export async function planScenes(input: {
  episodeId: string;
  script: MasterScript;
  timings: TimedSegment[];
  words: AlignedWord[];
  captures: CaptureBundle[];
  workDir: string;
}): Promise<SceneManifest> {
  const timingById = new Map(input.timings.map(t => [t.id, t]));
  const captureByNode = new Map(input.captures.map(c => [c.nodeId, c]));
  const scenes: Scene[] = [];

  const add = (scene: Omit<Scene, "id" | "index">): Scene => {
    const id = `scene-${String(scenes.length + 1).padStart(3, "0")}`;
    const full: Scene = { ...scene, id, index: scenes.length };
    scenes.push(full);
    return full;
  };

  const hookT = timingById.get("hook")!;
  const digInT = timingById.get("digin")!;
  const closingT = timingById.get("closing")!;
  const openingStart = 0;
  const openingEnd = digInT.endMs;
  const totalNarrationEnd = Math.max(closingT.endMs, ...input.timings.map(t => t.endMs));

  /* ---------- Opening ---------- */
  add({
    type: "opening",
    nodeId: null,
    rank: null,
    fullName: null,
    captureImage: null,
    sourceFileImage: null,
    startMs: openingStart,
    endMs: openingEnd,
    viewRect: null,
    cameraKeys: [
      { timeMs: openingStart, scale: 1.04, focusX: 960, focusY: 540 },
      { timeMs: openingEnd, scale: 1.04, focusX: 960, focusY: 540 },
    ],
    highlights: [],
    mascot: {
      visible: true,
      asset: "escort",
      position: "bottom-right",
      startMs: 100,
      endMs: openingEnd - 250,
      heightRatio: 0.56,
    },
    callout: { text: "LET'S DIG IN", startMs: digInT.startMs - 200, endMs: openingEnd - 120 },
    titleText: "FIVE GITHUB PROJECTS.",
    titleSubText: "ONE WORTH YOUR TIME.",
    titlePng: null,
    captionTrack: "story",
    sfx: [
      { role: "mascot-entry", atMs: 150 },
      { role: "mascot-landing", atMs: 660 },
      { role: "mascot-exit", atMs: openingEnd - 380 },
    ],
  });

  /* ---------- Repositories ---------- */
  for (const repo of input.script.repositories) {
    const bundle = captureByNode.get(repo.nodeId);
    const overview = bundle?.overview ?? null;
    const sourceFile = bundle?.sourceFile ?? null;
    const overviewImage = overview?.imagePath ?? null;

    const repoSegments: SegmentWithTiming[] = repo.segments.map(seg => {
      const timing = timingById.get(seg.id)!;
      return { ...seg, ...timing };
    });
    const firstStart = repoSegments[0].startMs;

    /* Repo typography reveal — overlaps the start of the repo's narration. */
    add({
      type: "repo-reveal",
      nodeId: repo.nodeId,
      rank: repo.presentationRank,
      fullName: repo.fullName,
      captureImage: overviewImage,
      sourceFileImage: null,
      startMs: firstStart,
      endMs: Math.min(firstStart + REVEAL_MS, repoSegments[repoSegments.length - 1].endMs),
      viewRect: null,
      cameraKeys: [{ timeMs: firstStart, scale: 1.06, focusX: 960, focusY: 540 }],
      highlights: [],
      mascot: null,
      callout: null,
      titleText: repo.fullName.split("/")[1] ?? repo.fullName,
      titleSubText: repo.fullName.split("/")[0] ?? null,
      titlePng: null,
      captionTrack: "story",
      sfx: [{ role: "reveal-hit", atMs: firstStart }],
    });

    /* Content scenes: grouped by visual target, starting after the reveal. */
    const revealEnd = firstStart + REVEAL_MS;
    const groups = groupContentSegments(repoSegments);
    let cursor = Math.max(revealEnd, firstStart);
    let mascotUses = 0;
    const MAX_MASCOT = 3;

    for (const group of groups) {
      const segStart = group.segments[0].startMs;
      const segEnd = group.segments[group.segments.length - 1].endMs;
      const sceneStart = Math.max(cursor, segStart - 150);
      const sceneEnd = segEnd + 350;
      if (sceneEnd - sceneStart < MIN_SCENE_MS && groups.indexOf(group) < groups.length - 1) {
        continue; // too short to breathe — merged into the next window
      }
      cursor = sceneEnd;

      const anchor = pickAnchor(overview?.anchors ?? [], group.type, group.detail);
      const imageHeight = overview?.documentHeightCssPx ?? 1080;
      const viewRect =
        group.type === "code-file" && sourceFile
          ? { x: 0, y: 0, width: 1920, height: 1080 }
          : {
              x: 0,
              y: clamp(Math.max(0, (anchor?.offsetTop ?? 140) - 130), 0, Math.max(0, imageHeight - 1080)),
              width: 1920,
              height: 1080,
            };
      const focusY = clamp((anchor?.offsetTop ?? 300) - 60, 200, Math.max(1080, imageHeight));

      const highlights = (overview?.highlights ?? [])
        .filter(h => group.segments.some(s => s.id === h.segmentId))
        .map(h => ({
          x: h.x,
          y: h.y,
          width: h.width,
          height: h.height,
          startMs: sceneStart + 450,
          endMs: sceneEnd - 150,
        }));

      const mascotCue = group.segments.find(s => s.mascot.enabled && mascotUses < MAX_MASCOT);
      let mascot: Scene["mascot"] = null;
      if (mascotCue) {
        mascotUses += 1;
        mascot = {
          visible: true,
          asset: mascotCue.mascot.asset === "present" ? "present" : "point",
          position: mascotCue.mascot.position,
          startMs: mascotCue.startMs - 80,
          endMs: Math.min(mascotCue.endMs + 150, sceneEnd),
          heightRatio: 0.36,
        };
      }

      const calloutSeg = group.segments.find(s => s.highlight.enabled && s.visualTarget.detail.trim().length >= 4);
      const callout = calloutSeg
        ? {
            text: calloutSeg.visualTarget.detail.toUpperCase().slice(0, 48),
            startMs: calloutSeg.startMs + 150,
            endMs: Math.min(calloutSeg.endMs, calloutSeg.startMs + 2600),
          }
        : null;

      const isCode = group.type === "code-file" && sourceFile !== null;
      const isFeature = group.type === "readme-section" && /feature/i.test(group.detail);
      const sfx: Scene["sfx"] = [];
      if (group.type === "overview") sfx.push({ role: "camera-push", atMs: sceneStart + 400 });
      if (isCode) sfx.push({ role: "significant-zoom", atMs: Math.min(sceneStart + 1500, sceneEnd - 200) });
      if (highlights.length > 0) sfx.push({ role: "code-highlight", atMs: highlights[0].startMs });
      if (isFeature) sfx.push({ role: "feature-reveal", atMs: sceneStart + 300 });
      if (callout) sfx.push({ role: "callout-appear", atMs: callout.startMs });

      add({
        type: isCode ? "repo-code" : group.type === "overview" ? "repo-overview" : "repo-readme",
        nodeId: repo.nodeId,
        rank: repo.presentationRank,
        fullName: repo.fullName,
        captureImage: overviewImage,
        sourceFileImage: isCode ? sourceFile.imagePath : null,
        startMs: sceneStart,
        endMs: Math.max(sceneStart + MIN_SCENE_MS, sceneEnd),
        viewRect,
        cameraKeys:
          group.type === "code-file"
            ? codeCamera(sceneStart, sceneEnd, Math.max(360, sourceFile?.lineHighlight?.y ?? 400))
            : group.type === "overview"
              ? overviewCamera(sceneStart, Math.min(focusY, Math.max(300, imageHeight - 400)))
              : readmeCamera(sceneStart, sceneEnd, 960, focusY),
        highlights,
        mascot,
        callout,
        titleText: null,
        titleSubText: null,
        titlePng: null,
        captionTrack: "story",
        sfx,
      });
    }

    /* Stretch the last repo scene to the repo's last segment end if it fell short. */
    const lastRepoScene = [...scenes].reverse().find(s => s.nodeId === repo.nodeId)!;
    const repoLastSegEnd = repoSegments[repoSegments.length - 1].endMs + 350;
    if (lastRepoScene.endMs < repoLastSegEnd) lastRepoScene.endMs = repoLastSegEnd;
  }

  /* ---------- Closing ---------- */
  add({
    type: "closing",
    nodeId: null,
    rank: null,
    fullName: null,
    captureImage: null,
    sourceFileImage: null,
    startMs: closingT.startMs,
    endMs: closingT.endMs + 1200,
    viewRect: null,
    cameraKeys: [{ timeMs: closingT.startMs, scale: 1, focusX: 960, focusY: 540 }],
    highlights: [],
    mascot: {
      visible: true,
      asset: "escort",
      position: "bottom-right",
      startMs: closingT.startMs,
      endMs: closingT.endMs + 900,
      heightRatio: 0.52,
    },
    callout: { text: "THANKS FOR WATCHING", startMs: closingT.startMs + 400, endMs: closingT.endMs + 800 },
    titleText: "OCTAVIA",
    titleSubText: "GITHUB PROJECTS WORTH YOUR TIME",
    titlePng: null,
    captionTrack: "story",
    sfx: [{ role: "outro", atMs: closingT.startMs }],
  });

  const totalDurationMs = scenes[scenes.length - 1].endMs;
  const manifest: SceneManifest = {
    episodeId: input.episodeId,
    scenes,
    totalDurationMs: Math.max(totalDurationMs, totalNarrationEnd + 900),
    generatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.join(input.workDir, "scenes"), { recursive: true });
  await fs.writeFile(path.join(input.workDir, "scene-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickAnchor(
  anchors: Array<{ anchor: string; offsetTop: number; offsetHeight: number }>,
  type: MasterSegment["visualTarget"]["type"],
  detail: string
): { anchor: string; offsetTop: number; offsetHeight: number } | null {
  const hay = detail.toLowerCase();
  const readme = anchors.filter(a => a.anchor.startsWith("readme:"));
  const matchers: Array<[RegExp, RegExp]> = [
    [/install|setup|getting/, /install|setup|getting/],
    [/usage|example|quick/, /usage|example|quick/],
    [/feature|why/, /feature|why|capabilities/],
    [/license/, /license/],
    [/how|mechanism|architecture|design/, /how|works|architecture|design|mechanism/],
  ];
  for (const [detailRe, anchorRe] of matchers) {
    if (detailRe.test(hay)) {
      const hit = readme.find(a => anchorRe.test(a.anchor));
      if (hit) return hit;
    }
  }
  if (type === "overview") return anchors.find(a => a.anchor === "repo-header") ?? null;
  return readme[0] ?? anchors[0] ?? null;
}
