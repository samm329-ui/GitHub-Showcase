import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildCaptions,
  buildScrollKeyframes,
  easeInOutCubic,
  enforceMonotonic,
  highlightsFor,
  phraseWeight,
  scrollAt,
  splitPhrases,
  syllableCount,
} from "../src/timeline.js";
import { activeWordAt, captionAt, captionHtml, wrapCaptionText, wordTimings } from "../src/caption-overlay.js";
import { toTimedChunks, type SynthesizedChunk } from "../src/voice.js";
import { toSpoken } from "../src/pronunciation.js";
import type { AudioChunk, NarrationSegment } from "../src/types.js";

function segments(): NarrationSegment[] {
  return [
    {
      id: "seg-01",
      purpose: "identify",
      spokenText: toSpoken("This is Rocket CLI, a command-line tool for TypeScript services."),
      captionText: "This is Rocket CLI, a command-line tool for TypeScript services.",
      factIds: ["purpose:x"],
      visualAnchor: "repo-header",
      emphasis: ["Rocket CLI"],
    },
    {
      id: "seg-02",
      purpose: "install",
      spokenText: toSpoken("To try it, you can install it with npm."),
      captionText: "To try it, you can install it with npm.",
      factIds: ["install:y"],
      visualAnchor: "install-command",
      emphasis: ["npm"],
      pauseAfterMs: 200,
    },
  ];
}

function syntheticChunks(): SynthesizedChunk[] {
  const spoken = segments();
  return spoken.map((segment, index) => ({
    index,
    segmentId: segment.id,
    file: `/tmp/segment-${index + 1}.wav`,
    text: segment.spokenText,
    durationMs: [3000, 2000][index],
    sampleRate: 24000,
    channels: 1,
    startMs: 0,
    endMs: 0,
    hasPhonemeTimings: false,
  }));
}

describe("chunk timing", () => {
  test("measured chunk durations become absolute intervals with pauses", () => {
    const timed = toTimedChunks(syntheticChunks(), segments(), 120);
    assert.equal(timed[0].startMs, 0);
    assert.equal(timed[0].endMs, 3000);
    assert.equal(timed[1].startMs, 3120, "the pause must be inserted between chunks");
    assert.equal(timed[1].endMs, 5120);
  });

  test("a per-segment pause overrides the default", () => {
    const timed = toTimedChunks(syntheticChunks(), segments(), 120);
    // segment 0 has no pauseAfterMs so the default applies
    assert.equal(timed[1].startMs, 3120);
  });

  test("intervals are monotonic and non-overlapping", () => {
    const timed = toTimedChunks(syntheticChunks(), segments());
    for (let index = 1; index < timed.length; index += 1) {
      assert.ok(timed[index].startMs >= timed[index - 1].endMs);
    }
  });
});

describe("caption timing", () => {
  test("captions follow measured audio, not a fixed 30s window", () => {
    const chunks = toTimedChunks(syntheticChunks(), segments());
    const captions = buildCaptions(segments(), chunks);
    assert.ok(captions.length >= 2);
    const last = captions[captions.length - 1];
    assert.ok(last.endMs <= 5200, `captions ran past the audio: ${last.endMs}`);
    assert.ok(captions[0].startMs === 0);
  });

  test("real phoneme timings take priority when available", () => {
    const chunks = toTimedChunks(syntheticChunks(), segments());
    const captions = buildCaptions(segments(), chunks, {
      phonemeTimings: [
        {
          segmentId: "seg-01",
          phrases: splitPhrases(segments()[0].captionText).map((text, index) => ({
            text,
            startMs: 100 + index * 900,
            endMs: 1000 + index * 900,
          })),
        },
      ],
    });
    const first = captions.filter(c => c.segmentId === "seg-01");
    assert.equal(first[0].startMs, 100);
  });

  test("captions never overlap and never run backwards", () => {
    const chunks = toTimedChunks(syntheticChunks(), segments());
    const captions = buildCaptions(segments(), chunks);
    for (let index = 1; index < captions.length; index += 1) {
      assert.ok(
        captions[index].startMs >= captions[index - 1].startMs,
        "captions must be sorted"
      );
      assert.ok(
        captions[index].startMs >= captions[index - 1].endMs,
        "captions must not overlap"
      );
      assert.ok(captions[index].endMs > captions[index].startMs);
    }
  });

  test("enforceMonotonic repairs an out-of-order list", () => {
    const repaired = enforceMonotonic([
      { index: 0, startMs: 0, endMs: 900, text: "a", highlights: [], segmentId: "s" },
      { index: 1, startMs: 300, endMs: 400, text: "b", highlights: [], segmentId: "s" },
    ]);
    assert.ok(repaired[1].startMs >= repaired[0].endMs);
    assert.ok(repaired.every(caption => caption.endMs > caption.startMs));
  });

  test("every caption belongs to a real segment", () => {
    const chunks = toTimedChunks(syntheticChunks(), segments());
    const ids = new Set(segments().map(segment => segment.id));
    for (const caption of buildCaptions(segments(), chunks)) {
      assert.ok(ids.has(caption.segmentId));
    }
  });

  test("a segment with no measured chunk produces no captions", () => {
    const captions = buildCaptions(segments(), []);
    assert.equal(captions.length, 0);
  });
});

describe("pause handling", () => {
  test("punctuation adds weight to a phrase", () => {
    const plain = phraseWeight("one two three");
    const withPause = phraseWeight("one, two, three");
    assert.ok(withPause > plain, `${withPause} should exceed ${plain}`);
  });

  test("sentence-ending punctuation adds more weight than a comma", () => {
    assert.ok(phraseWeight("this is the end.") > phraseWeight("this is the end"));
    assert.ok(phraseWeight("this is the end,") > phraseWeight("this is the end"));
  });

  test("syllable estimation is plausible", () => {
    assert.equal(syllableCount("cat"), 1);
    assert.ok(syllableCount("repository") >= 4);
    assert.ok(syllableCount("cli") >= 1);
  });
});

describe("caption presentation", () => {
  test("phrases are readable chunks, not arbitrary four-word groups", () => {
    const phrases = splitPhrases(
      "This is Rocket CLI. It scaffolds a TypeScript service in one command, then deploys it."
    );
    assert.ok(phrases.length >= 2);
    for (const phrase of phrases) {
      assert.ok(phrase.trim().length > 0);
      assert.ok(!phrase.startsWith(" "));
    }
  });

  test("strong clause marks split before a caption can become three lines", () => {
    const phrases = splitPhrases(
      "And: Synchronous CPU-bound work: concurrency does not help."
    );
    assert.deepEqual(phrases, [
      "And: Synchronous CPU-bound work:",
      "concurrency does not help.",
    ]);
    for (const phrase of phrases) {
      assert.ok(
        wrapCaptionText(phrase).length <= 2,
        `phrase needs three rendered lines: ${phrase}`
      );
    }
  });

  test("a short trailing fragment folds into a two-line phrase", () => {
    const phrases = splitPhrases(
      "First: Network or database: the pool size or rate limit of the other side."
    );
    assert.deepEqual(phrases, [
      "First: Network or database:",
      "the pool size or rate limit of the other side.",
    ]);
  });

  test("long captions wrap into at most two lines", () => {
    const lines = wrapCaptionText(
      "Scaffolds a service with linting tests and a deploy target"
    );
    assert.ok(lines.length <= 2, `got ${lines.length} lines`);
  });

  test("wrapping keeps every word", () => {
    const text = "Scaffolds a service with linting tests and a deploy target today";
    const lines = wrapCaptionText(text);
    const rejoined = lines.join(" ").toLowerCase();
    for (const word of text.toLowerCase().split(" ")) {
      assert.ok(rejoined.includes(word), `lost the word "${word}"`);
    }
  });

  test("only emphasised words get the highlight", () => {
    assert.deepEqual(highlightsFor("Install it with npm today", ["npm"]), ["npm"]);
    assert.deepEqual(highlightsFor("Install it with npm today", ["yarn"]), []);
    assert.deepEqual(highlightsFor("Install it with npm today", undefined), []);
  });

  test("highlights match whole words only", () => {
    assert.deepEqual(highlightsFor("The npmrc file", ["npm"]), [], "'npm' must not match inside 'npmrc'");
  });

  test("caption html has no filled word background", () => {
    const captions = buildCaptions(segments(), toTimedChunks(syntheticChunks(), segments()));
    const highlighted = captions.find(caption => caption.highlights.length > 0);
    assert.ok(highlighted);
    const html = captionHtml(highlighted);
    assert.match(html, /<span class="w/);
    assert.ok(!/background/i.test(html), "captions must not draw filled boxes");
  });

  test("the active word follows its measured phrase timing", () => {
    const phrase = {
      index: 0,
      startMs: 1000,
      endMs: 1300,
      text: "Fast sync and sync",
      highlights: [],
      segmentId: "s",
    };
    const timings = wordTimings(phrase);
    assert.equal(timings.length, 4);
    assert.ok(activeWordAt(phrase, 1000));
    assert.equal(activeWordAt(phrase, 999), null);
    const html = captionHtml(phrase, activeWordAt(phrase, 1050));
    assert.match(html, /<span class="w/);
    assert.match(html, /<span class="w active" data-i="0"[^>]*>Fast<\/span>/);
  });

  test("caption html escapes repository text", () => {
    const captions: ReturnType<typeof buildCaptions> = [
      {
        index: 0,
        startMs: 0,
        endMs: 1000,
        text: "<img src=x onerror=alert(1)>",
        highlights: [],
        segmentId: "s",
      },
    ];
    const html = captionHtml(captions[0]);
    assert.ok(!/<img/.test(html));
    assert.match(html, /&lt;img/);
  });

  test("captionAt returns the phrase on screen at a given time", () => {
    const captions = buildCaptions(segments(), toTimedChunks(syntheticChunks(), segments()));
    assert.ok(captionAt(captions, 50));
    assert.equal(captionAt(captions, 99_999), null);
  });
});

describe("scroll keyframes", () => {
  const anchors = [
    { anchor: "repo-header" as const, offsetTop: 0, offsetHeight: 400 },
    { anchor: "file-list" as const, offsetTop: 400, offsetHeight: 500 },
    { anchor: "readme-intro" as const, offsetTop: 900, offsetHeight: 900 },
    { anchor: "install-command" as const, offsetTop: 1800, offsetHeight: 260 },
  ];
  const chunks: AudioChunk[] = toTimedChunks(syntheticChunks(), segments());

  test("keyframes start at the top and only move forward", () => {
    const keys = buildScrollKeyframes({
      segments: segments(),
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
    });
    assert.equal(keys[0].timeMs, 0);
    assert.equal(keys[0].scrollY, 0);
    for (let index = 1; index < keys.length; index += 1) {
      assert.ok(keys[index].timeMs >= keys[index - 1].timeMs);
      assert.ok(keys[index].scrollY >= keys[index - 1].scrollY);
    }
  });

  test("scroll never exceeds the measured document bounds", () => {
    const maxScroll = 2060 - 1310;
    const keys = buildScrollKeyframes({
      segments: segments(),
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
    });
    for (const key of keys) {
      assert.ok(key.scrollY >= 0, `negative scroll ${key.scrollY}`);
      assert.ok(key.scrollY <= maxScroll, `scroll ${key.scrollY} > ${maxScroll}`);
    }
  });

  test("a short document produces a single stationary keyframe", () => {
    const keys = buildScrollKeyframes({
      segments: segments(),
      chunks,
      anchors: [{ anchor: "repo-header", offsetTop: 0, offsetHeight: 200 }],
      documentHeight: 1400,
      viewportHeight: 1310,
    });
    assert.equal(keys.length, 1);
    assert.equal(keys[0].scrollY, 0);
  });

  test("a missing features anchor falls back to the README intro", () => {
    const keys = buildScrollKeyframes({
      segments: [
        { ...segments()[0], visualAnchor: "features" as const },
      ],
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
      durationMs: 60_000,
    });
    const furthest = Math.max(...keys.map(key => key.scrollY));
    assert.ok(furthest >= 750, `features did not reach the README: ${furthest}`);
  });

  test("a landmark hinted earlier than the scroll budget allows arrives late, not halfway", () => {
    // A distant README section (2868px away) whose chunk starts so early that
    // the 190px/s ceiling cannot cover the distance in the scheduled gap. The
    // keyframe must be delayed until the move is achievable and arrive fully,
    // instead of being clipped mid-air by the speed repair.
    const tallAnchors = [
      { anchor: "repo-header" as const, offsetTop: 300, offsetHeight: 400 },
      { anchor: "file-list" as const, offsetTop: 700, offsetHeight: 900 },
      { anchor: "readme-intro" as const, offsetTop: 2900, offsetHeight: 900 },
    ];
    const earlyChunk: AudioChunk = {
      ...(syntheticChunks()[0] as AudioChunk),
      durationMs: 3000,
      startMs: 2000,
      endMs: 5000,
    };
    const keys = buildScrollKeyframes({
      segments: [
        { ...segments()[0], visualAnchor: "features" as const },
      ],
      chunks: [earlyChunk],
      anchors: tallAnchors,
      documentHeight: 4500,
      viewportHeight: 1310,
      durationMs: 65_000,
    });
    // 2900 - 32 padding.
    const target = 2868;
    const last = keys[keys.length - 1];
    assert.equal(last.scrollY, target, "the narrated section must be reached fully");
    // The key time must cover the whole travel from the previous key.
    const previous = keys[keys.length - 2];
    const travel = ((target - previous.scrollY) / 190) * 1000;
    assert.ok(
      last.timeMs >= previous.timeMs + travel - 2,
      `arrival at ${last.timeMs}ms happened earlier than the ${travel.toFixed(0)}ms of travel allows`
    );
    // No key was ever stopped short of its planned landmark.
    for (const key of keys) {
      assert.ok(
        key.scrollY === 0 || key.scrollY === 268 || key.scrollY === 668 ||
          key.scrollY === 1768 || key.scrollY === target,
        `a keyframe sits mid-air at ${key.scrollY}`
      );
    }
  });

  test("an anchor that is not present is never targeted", () => {
    const keys = buildScrollKeyframes({
      segments: [
        { ...segments()[0], visualAnchor: "release" as const },
      ],
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
    });
    assert.ok(
      !keys.some(key => key.anchor === "release"),
      "a missing anchor must never appear as a keyframe target"
    );
    for (const key of keys) {
      assert.ok(key.scrollY >= 0 && key.scrollY <= 750);
    }
  });

  test("interpolation is smooth and ends on the target", () => {
    const keys = buildScrollKeyframes({
      segments: segments(),
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
    });
    assert.ok(keys.length >= 3);
    const moving = keys.filter(key => key.easing === "easeInOut");
    assert.ok(moving.length >= 2);
    const a = scrollAt(keys, keys[1].timeMs);
    const mid = scrollAt(keys, (keys[1].timeMs + keys[2].timeMs) / 2);
    const b = scrollAt(keys, keys[2].timeMs);
    assert.equal(a, keys[1].scrollY);
    assert.equal(b, keys[2].scrollY);
    assert.ok(mid > a && mid < b, `mid ${mid} should sit between ${a} and ${b}`);
  });

  test("sampling before the first and after the last key is clamped", () => {
    const keys = buildScrollKeyframes({
      segments: segments(),
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
    });
    assert.equal(scrollAt(keys, -500), keys[0].scrollY);
    assert.equal(scrollAt(keys, 10_000_000), keys[keys.length - 1].scrollY);
  });

  test("easeInOutCubic starts and ends flat", () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    assert.ok(easeInOutCubic(0.5) > 0.4 && easeInOutCubic(0.5) < 0.6);
    assert.ok(easeInOutCubic(0.25) < easeInOutCubic(0.75));
  });

  test("the opening view is held before the first move", () => {
    const keys = buildScrollKeyframes({
      segments: segments(),
      chunks,
      anchors,
      documentHeight: 2060,
      viewportHeight: 1310,
      introHoldMs: 1200,
    });
    assert.equal(scrollAt(keys, 1000), 0, "the card must be still for the intro hold");
  });
});