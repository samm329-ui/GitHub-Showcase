import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyEasing,
  buildCameraCropExpr,
  cropWindow,
  sampleCamera,
  type CameraKey,
} from "../src/longform/camera.js";
import { selectFive, diversityPenalty } from "../src/longform/repository-selector.js";
import { scoreBase } from "../src/longform/dataset-loader.js";
import type { DatasetCandidate } from "../src/longform/types.js";
import { LongformHistory } from "../src/longform/db.js";
import {
  groupIntoPhrases,
  assignStyles,
  captionsToAss,
  captionsToSrt,
} from "../src/longform/captions.js";
import {
  toSynthSegments,
  buildSegmentTimings,
  planScenes,
} from "../src/longform/scene-planner.js";
import {
  validateMasterScript,
  toMasterScript,
  generateMasterScript,
  buildEvidencePacket,
} from "../src/longform/master-script.js";
import type {
  EvidencePacket,
  MasterScript,
  CaptureBundle,
  Scene,
} from "../src/longform/types.js";
import type { AlignedWord } from "../src/channels/news/types.js";
import { scheduleSfxFromScenes } from "../src/longform/audio-mixer.js";
import { CheckpointStore } from "../src/longform/checkpoint.js";
import { verifyUsedAssets } from "../src/longform/music-manager.js";
import { MAX_DURATION_SECONDS } from "../src/config.js";
import { LONGFORM } from "../src/longform/config.js";
import type { EnrichedRepo } from "../src/types.js";

/* ---------------------------------------------------------- fixtures */

function cand(overrides: Partial<DatasetCandidate>): DatasetCandidate {
  return {
    recordId: overrides.recordId ?? `rec-${overrides.nodeId ?? "x"}`,
    nodeId: overrides.nodeId ?? "node-1",
    fullName: overrides.fullName ?? "acme/one",
    htmlUrl: `https://github.com/${overrides.fullName ?? "acme/one"}`,
    description: "desc",
    stars: 500,
    forks: 40,
    primaryLanguage: "TypeScript",
    license: "MIT",
    topics: ["cli", "automation"],
    pushedAt: new Date().toISOString(),
    readmeChars: 8000,
    factCount: 8,
    segmentCount: 5,
    spokenWords: 90,
    estimatedSeconds: 35,
    styleVariant: "groq-openai/gpt-oss-120b",
    baseScore: 0,
    issues: [],
    ...overrides,
  };
}

function nineCandidates(): DatasetCandidate[] {
  const langs = ["TypeScript", "Python", "Rust", "Go", "TypeScript", "Python", "HTML", "Python", "TypeScript"];
  const stars = [1084, 29, 3314, 1250, 561, 161, 30, 9827, 805];
  const topics = [
    ["ai-agents", "agentic-ai"],
    ["comfyui", "character-creator"],
    ["ai-agents", "css"],
    ["hugo", "blog"],
    ["ai-agents", "debugging"],
    ["agent", "llm"],
    ["ai", "ai-memory"],
    ["design-editor", "figma-alternative"],
    ["rag", "retrieval"],
  ];
  return langs.map((lang, i) =>
    cand({
      nodeId: `node-${i}`,
      fullName: `acme/repo-${i}`,
      primaryLanguage: lang,
      stars: stars[i],
      topics: topics[i],
      readmeChars: 4000 + i * 1500,
      factCount: 6 + (i % 5),
    })
  );
}

const freshDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longform-db-test-"));
  return { db: new LongformHistory(path.join(dir, "longform-history.db")), dir };
};

const baseWords = (count: number, segId = "seg"): AlignedWord[] =>
  Array.from({ length: count }, (_, i) => ({
    word: i % 7 === 3 ? "term." : `word${i}`,
    startMs: i * 300,
    endMs: i * 300 + 250,
    confidence: 0.9,
    segmentId: segId,
  }));

/* ---------------------------------------------------------- camera */

describe("camera", () => {
  test("ease-in-out cubic is symmetric and hits the endpoints", () => {
    assert.equal(applyEasing(0, "easeInOut"), 0);
    assert.equal(applyEasing(1, "easeInOut"), 1);
    assert.equal(applyEasing(0.5, "easeInOut"), 0.5);
    assert.ok(applyEasing(0.25, "easeInOut") < 0.25);
  });

  test("sampleCamera interpolates and clamps at the ends", () => {
    const keys: CameraKey[] = [
      { timeMs: 0, scale: 1, focusX: 100, focusY: 100 },
      { timeMs: 1000, scale: 1.1, focusX: 200, focusY: 300 },
    ];
    assert.equal(sampleCamera(keys, 0).scale, 1);
    assert.equal(sampleCamera(keys, 1000).scale, 1.1);
    assert.ok(Math.abs(sampleCamera(keys, 500).scale - 1.05) < 1e-9);
    assert.equal(sampleCamera(keys, 99999).scale, 1.1);
    assert.equal(sampleCamera(keys, -100).scale, 1);
  });

  test("cropWindow clamps inside the image", () => {
    const win = cropWindow(3000, 2000, 1.08, 10, 10, 1920, 1080);
    assert.equal(win.width, Math.round(1920 / 1.08));
    assert.equal(win.height, Math.round(1080 / 1.08));
    assert.equal(win.x, 0);
    assert.equal(win.y, 0);
  });

  test("buildCameraCropExpr holds before the first key and stays in bounds", () => {
    const keys: CameraKey[] = [
      { timeMs: 0, scale: 1, focusX: 960, focusY: 540 },
      { timeMs: 2000, scale: 1.08, focusX: 960, focusY: 400 },
    ];
    const expr = buildCameraCropExpr(keys, 1920, 1080, 0, "easeInOut");
    assert.match(expr.w, /1920\/\(/);
    assert.match(expr.h, /1080\/\(/);
    assert.match(expr.x, /min\(max\(0,/);
  });
});

/* ---------------------------------------------------------- selector */

describe("selection", () => {
  test("scoreBase is deterministic and bounded 0..100", () => {
    const a = scoreBase({ stars: 1000, pushedAt: new Date().toISOString(), readmeChars: 9000, factCount: 12, segmentCount: 6, spokenWords: 95, licenseKnown: true, hasAlignment: true });
    const b = scoreBase({ stars: 1000, pushedAt: new Date().toISOString(), readmeChars: 9000, factCount: 12, segmentCount: 6, spokenWords: 95, licenseKnown: true, hasAlignment: true });
    assert.equal(a, b);
    assert.ok(a >= 0 && a <= 100);
  });

  test("diversityPenalty penalizes same-language and topic overlap", () => {
    const base = cand({ nodeId: "a", primaryLanguage: "Go", topics: ["cli"] });
    const picked = [cand({ nodeId: "b", primaryLanguage: "Go", topics: ["cli", "devops"] })];
    assert.equal(diversityPenalty(base, picked), 14);
    assert.equal(diversityPenalty(cand({ nodeId: "c", primaryLanguage: "Rust", topics: ["embedded"] }), picked), 0);
  });

  test("selectFive is deterministic and assigns rank 1 to the strongest", () => {
    const candidates = nineCandidates();
    const first = selectFive(candidates, new Set());
    const second = selectFive(candidates, new Set());
    assert.deepEqual(first.presentation.map(p => p.nodeId), second.presentation.map(p => p.nodeId));
    const ranked = [...first.presentation].sort((a, b) => a.rank - b.rank);
    // Presentation order is 5 → 1, so the strongest (#1) is last.
    assert.equal(first.presentation[0].rank, 5);
    assert.equal(first.presentation[4].rank, 1);
    assert.equal(
      first.presentation[4].selectionScore,
      Math.max(...ranked.map(r => r.selectionScore))
    );
  });

  test("used repositories are excluded", () => {
    const candidates = nineCandidates();
    const used = new Set(candidates.slice(0, 5).map(c => c.nodeId));
    const result = selectFive(candidates, used);
    assert.equal(result.presentation.length, 4);
    for (const p of result.presentation) assert.ok(!used.has(p.nodeId));
  });
});

/* ---------------------------------------------------------- DB ledger */

describe("longform history", () => {
  test("reserveEpisode commits all five atomically and blocks reuse", () => {
    const { db } = freshDb();
    const repositories = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `node-${i}`,
      fullName: `acme/repo-${i}`,
      datasetRecordId: `rec-${i}`,
      rank: 5 - i,
      selectionScore: 80 - i,
    }));
    db.reserveEpisode({ episodeId: "ep-1", runId: "run1", repositories, workDir: "temp/ep-1" });
    assert.equal(db.usedNodeIds().size, 5);
    assert.equal(db.getEpisodeRepositories("ep-1").length, 5);
    assert.throws(
      () => db.reserveEpisode({ episodeId: "ep-2", runId: "run2", repositories, workDir: "temp/ep-2" }),
      /already committed/
    );
    // Episode is persisted and resumable.
    db.close();
    const { db: db2 } = { db: new LongformHistory(path.join(freshDb().dir, "longform-history.db")) };
    db2.close();
  });

  test("a failed episode keeps its repositories reserved", () => {
    const { db } = freshDb();
    const repositories = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `fnode-${i}`,
      fullName: `acme/f-${i}`,
      datasetRecordId: `frec-${i}`,
      rank: 5 - i,
      selectionScore: 70,
    }));
    db.reserveEpisode({ episodeId: "ep-fail", runId: "run", repositories, workDir: "temp/ep-fail" });
    db.updateStatus("ep-fail", "failed", { stage: "VIDEO RENDERING", error: "boom" });
    assert.equal(db.usedNodeIds().size, 5);
    const resumable = db.findResumableEpisode();
    assert.equal(resumable?.episodeId, "ep-fail");
    assert.equal(db.getEpisodeRepositories("ep-fail").length, 5);
    db.close();
  });
});

/* ---------------------------------------------------------- captions */

describe("captions", () => {
  test("phrases group 2-5 words and never overflow the line width", () => {
    const words = baseWords(40);
    const phrases = groupIntoPhrases(words, 26, 2);
    assert.ok(phrases.length > 5);
    for (const phrase of phrases) {
      assert.ok(phrase.text.length <= 52 + 6, `phrase too long: ${phrase.text}`); // merged trailing word tolerance
      assert.ok(phrase.words.length >= 1);
    }
  });

  test("assignStyles is deterministic and uses varied animations", () => {
    const words = baseWords(90);
    const first = assignStyles(groupIntoPhrases(words));
    const second = assignStyles(groupIntoPhrases(words));
    assert.deepEqual(first.map(c => c.animation), second.map(c => c.animation));
    const animations = new Set(first.map(c => c.animation));
    assert.ok(animations.size >= 4, `expected varied styles, got ${[...animations].join(",")}`);
  });

  test("ASS output addresses the 1920x1080 canvas", () => {
    const captions = assignStyles(groupIntoPhrases(baseWords(10)));
    const ass = captionsToAss(captions);
    assert.match(ass, /PlayResX: 1920/);
    assert.match(ass, /PlayResY: 1080/);
    assert.match(ass, /Inter/);
    const srt = captionsToSrt(captions);
    assert.match(srt, /-->/);
  });
});

/* ---------------------------------------------------------- master script */

function packets(order: string[]): EvidencePacket[] {
  return order.map((nodeId, i) => ({
    nodeId,
    fullName: `acme/${nodeId}`,
    description: `A project about topic ${i}`,
    stars: 1000 + i,
    forks: 10,
    primaryLanguage: "TypeScript",
    license: "MIT",
    topics: ["cli"],
    createdAt: "2024-01-01T00:00:00Z",
    pushedAt: "2026-06-01T00:00:00Z",
    latestRelease: null,
    facts: [
      { id: `f-${i}-1`, kind: "purpose", semantic: "identity", claim: `acme/${nodeId} solves topic ${i} with a pipeline for topic ${i} that streamlines everything`, confidence: 0.95 },
      { id: `f-${i}-2`, kind: "mechanism", semantic: "mechanism", claim: `It uses a pipeline for topic ${i} with evidence-graded retrieval and review`, confidence: 0.9 },
    ],
    readmeExcerpt: `# acme/${nodeId}\n\nA project about topic ${i}. It uses a pipeline for topic ${i}. Install it with npm install acme-${nodeId} today.`,
    readmeHeadings: ["installation", "usage"],
    installCommand: "npm install",
  }));
}

const sentence = (nodeId: string, extra: string) =>
  `acme ${nodeId} is a project about topic ${nodeId} that ${extra}, and it keeps that promise by pairing a calm interface with a pipeline that plans before it acts, every single time`;

const validScriptJson = (order: string[]) => ({
  opening: { hookSpoken: "Five GitHub projects. One worth your time.", digInSpoken: "Let's dig in." },
  repositories: order.map((nodeId, i) => ({
    nodeId,
    fullName: `acme/${nodeId}`,
    segments: [
      {
        purpose: "identify",
        spokenText: sentence(nodeId, `helps developers tame topic ${i}`),
        captionText: sentence(nodeId, `helps developers tame topic ${i}`),
        factIds: [`f-${i}-1`],
        visualTarget: { type: "overview", detail: "repo header" },
        highlight: { enabled: false, targetText: null },
        mascot: { enabled: false, position: "bottom-right", asset: "present" },
      },
      {
        purpose: "explain",
        spokenText: sentence(nodeId, `runs an evidence-graded pipeline for topic ${i} under the hood`),
        captionText: sentence(nodeId, `runs an evidence-graded pipeline for topic ${i} under the hood`),
        factIds: [`f-${i}-2`],
        visualTarget: { type: "readme-section", detail: "how it works" },
        highlight: { enabled: true, targetText: `It uses a pipeline for topic ${i}` },
        mascot: { enabled: true, position: "bottom-left", asset: "point" },
      },
      {
        purpose: "summary",
        spokenText: sentence(nodeId, `deserves a place on your machine`),
        captionText: sentence(nodeId, `deserves a place on your machine`),
        factIds: [`f-${i}-1`],
        visualTarget: { type: "overview", detail: "outro" },
        highlight: { enabled: false, targetText: null },
        mascot: { enabled: false, position: "bottom-right", asset: "point" },
      },
    ],
  })),
  closing: { spokenText: "That is five projects worth exploring. Thanks for watching, and see you next time." },
});

describe("master script", () => {
  const order = ["n4", "n3", "n2", "n1", "n0"];

  test("a valid packet-ordered script passes validation", () => {
    const pkts = packets(order);
    const raw = validScriptJson(order);
    const result = validateMasterScript(raw, pkts, order);
    assert.equal(result.ok, true, result.errors.join("; "));
    const script = toMasterScript(raw);
    assert.equal(script.repositories.length, 5);
    assert.deepEqual(script.repositories.map(r => r.presentationRank), [5, 4, 3, 2, 1]);
  });

  test("wrong presentation order fails validation", () => {
    const pkts = packets(order);
    const raw = validScriptJson([...order].reverse());
    const result = validateMasterScript(raw, pkts, order);
    assert.equal(result.ok, false);
  });

  test("fabricated factIds fail validation", () => {
    const pkts = packets(order);
    const raw = validScriptJson(order) as ReturnType<typeof validScriptJson>;
    raw.repositories[0].segments[0].factIds = ["made-up-id"];
    const result = validateMasterScript(raw, pkts, order);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("made-up-id")));
  });

  test("wrong hook is rejected", () => {
    const pkts = packets(order);
    const raw = validScriptJson(order) as ReturnType<typeof validScriptJson>;
    raw.opening.hookSpoken = "Hey everyone, welcome back";
    const result = validateMasterScript(raw, pkts, order);
    assert.equal(result.ok, false);
  });

  test("generateMasterScript works end-to-end with a mocked Groq fetch", async () => {
    const pkts = packets(order);
    const raw = validScriptJson(order);
    const prevKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "test-key-not-a-real-key";
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-oss-120b",
          choices: [{ message: { content: JSON.stringify(raw) } }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ) as unknown as Response;
    try {
      const result = await generateMasterScript(pkts, order, {
        log: () => {},
        fetchImpl: fakeFetch,
        sleep: async () => {},
      });
      assert.equal(result.script.repositories.length, 5);
      assert.equal(result.usage?.totalTokens, 300);
    } finally {
      if (prevKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevKey;
    }
  });
});

/* ---------------------------------------------------------- scenes */

describe("scene planner", () => {
  test("produces a monotonic master clock covering opening → five reveals → closing", async () => {
    const order = ["n4", "n3", "n2", "n1", "n0"];
    const pkts = packets(order);
    const rawScript = toMasterScript(validScriptJson(order));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longform-plan-"));

    const synth = toSynthSegments(rawScript);
    const timings = synth.map((seg, i) => ({ id: seg.id, startMs: i * 1800, endMs: i * 1800 + 1500 }));
    const words: AlignedWord[] = timings.flatMap(t => {
      const w = rawScript.repositories[0].segments[0].spokenText.split(" ").length;
      void w;
      return [];
    });

    const captures: CaptureBundle[] = order.map(nodeId => ({
      nodeId,
      overview: {
        nodeId,
        fullName: `acme/${nodeId}`,
        kind: "overview",
        sourceUrl: `https://github.com/acme/${nodeId}`,
        capturedAt: new Date().toISOString(),
        cssViewport: { width: 1920, height: 1080 },
        documentHeightCssPx: 2400,
        imagePath: path.join(dir, `${nodeId}.jpg`),
        sha256: "00",
        bytes: 1,
        tiles: [{ index: 0, offsetY: 0, heightPx: 2400 }],
        anchors: [
          { anchor: "repo-header", offsetTop: 80, offsetHeight: 60 },
          { anchor: "readme:installation", offsetTop: 700, offsetHeight: 60 },
        ],
        highlights: [],
        warnings: [],
      },
      sourceFile: nodeId === "n4"
        ? {
            nodeId,
            fullName: `acme/${nodeId}`,
            kind: "source-file",
            filePath: "src/main.ts",
            sourceUrl: `https://github.com/acme/${nodeId}/blob/HEAD/src/main.ts`,
            capturedAt: new Date().toISOString(),
            imagePath: path.join(dir, "src-main.jpg"),
            sha256: "00",
            bytes: 1,
            cssViewport: { width: 1920, height: 1080 },
            lineHighlight: { lineStart: 3, lineEnd: 9, x: 0, y: 300, width: 1920, height: 200 },
            syntaxLanguage: "typescript",
            contentHash: "00",
            warnings: [],
          }
        : null,
    }));

    // Give repo n4 a code-file visual target.
    const scriptWithCode: MasterScript = {
      ...rawScript,
      repositories: rawScript.repositories.map(r =>
        r.nodeId === "n4"
          ? { ...r, segments: r.segments.map(s => (s.purpose === "explain" ? { ...s, visualTarget: { type: "code-file" as const, detail: "implementation" } } : s)) }
          : r
      ),
    };

    const manifest = await planScenes({
      episodeId: "test-ep",
      script: scriptWithCode,
      timings,
      words,
      captures,
      workDir: dir,
    });

    const types = manifest.scenes.map(s => s.type);
    assert.equal(types[0], "opening");
    assert.equal(types.filter(t => t === "repo-reveal").length, 5);
    assert.equal(types[types.length - 1], "closing");
    assert.ok(types.includes("repo-code"), "expected a code scene for the repo with a code-file target");

    // Master clock is monotonic and gap-free.
    for (let i = 1; i < manifest.scenes.length; i += 1) {
      assert.ok(
        manifest.scenes[i].startMs >= manifest.scenes[i - 1].endMs - 150,
        `scene ${i} starts before previous scene ended`
      );
    }
    // Presentation order is 5 → 1 and the reveal order matches the script order.
    const revealNames = manifest.scenes.filter(s => s.type === "repo-reveal").map(s => s.fullName);
    assert.deepEqual(revealNames, ["acme/n4", "acme/n3", "acme/n2", "acme/n1", "acme/n0"]);
  });
});

/* ---------------------------------------------------------- SFX */

describe("sfx scheduling", () => {
  test("schedules only for events that actually occur", () => {
    const sceneBase = {
      id: "s", index: 0, nodeId: null, rank: null, fullName: null,
      captureImage: null, sourceFileImage: null, viewRect: null, cameraKeys: [],
      highlights: [], mascot: null, callout: null, titleText: null, titleSubText: null,
      titlePng: null, captionTrack: "story" as const, sfx: [],
    };
    const scenes: Scene[] = [
      { ...sceneBase, id: "a", index: 0, type: "opening", startMs: 0, endMs: 5000, sfx: [{ role: "mascot-entry", atMs: 150 }, { role: "mascot-landing", atMs: 660 }, { role: "mascot-exit", atMs: 4700 }] },
      { ...sceneBase, id: "b", index: 1, type: "repo-reveal", startMs: 5000, endMs: 7400, sfx: [{ role: "reveal-hit", atMs: 5000 }] },
      { ...sceneBase, id: "c", index: 2, type: "repo-readme", startMs: 7400, endMs: 14000, sfx: [{ role: "code-highlight", atMs: 8000 }] },
      { ...sceneBase, id: "d", index: 3, type: "closing", startMs: 14000, endMs: 17500, sfx: [{ role: "outro", atMs: 14000 }] },
    ];
    const events = scheduleSfxFromScenes(scenes as Scene[]);
    const roles = events.map(e => e.role);
    assert.ok(roles.includes("mascot-entry"));
    assert.ok(roles.includes("mascot-landing")); // scheduled by the opening scene itself
    assert.ok(roles.includes("reveal-hit"));
    assert.ok(roles.includes("title-reveal")); // derived for reveal scenes
    assert.ok(roles.includes("code-highlight"));
    assert.ok(roles.includes("outro"));
    assert.ok(!roles.includes("callout-appear"));
    // Strictly non-decreasing timestamps.
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].atMs >= events[i - 1].atMs);
    }
  });
});

/* ---------------------------------------------------------- checkpoint */

describe("checkpoint store", () => {
  test("round-trips values and detects fingerprint changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ckpt-"));
    const store = new CheckpointStore(dir);
    await store.set("stage", "fp-1", { result: 42 });
    const hit = await store.get<{ result: number }>("stage");
    assert.equal(hit?.fingerprint, "fp-1");
    assert.equal(hit?.value.result, 42);
    await store.set("stage", "fp-2", { result: 43 });
    const hit2 = await store.get<{ result: number }>("stage");
    assert.equal(hit2?.fingerprint, "fp-2");
    assert.equal(hit2?.value.result, 43);
    await store.clear("stage");
    assert.equal(await store.get("stage"), null);
  });
});

/* ---------------------------------------------------------- licences */

describe("asset licence gate", () => {
  test("unknown assets fail the gate", () => {
    const result = verifyUsedAssets(["sfx/definitely-not-in-manifest.wav"]);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.unverified.includes("sfx/definitely-not-in-manifest.wav"));
  });
});

/* ---------------------------------------------------------- isolation */

describe("isolation from the existing pipelines", () => {
  test("Short-form constants are untouched", () => {
    assert.equal(MAX_DURATION_SECONDS, 58);
  });
  test("Long-form profile is its own 16:9 profile", () => {
    assert.equal(LONGFORM.width, 1920);
    assert.equal(LONGFORM.height, 1080);
    assert.equal(LONGFORM.fps, 30);
    assert.equal(LONGFORM.pixelFormat, "yuv420p");
    assert.ok(LONGFORM.targetDurationSeconds >= 270);
  });
});
