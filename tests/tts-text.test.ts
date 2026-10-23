import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { prepareTtsText } from "../src/tts-text.js";
import { segmentSpokenText } from "../src/narration.js";
import type { NarrationSegment } from "../src/types.js";

describe("speech text normalisation", () => {
  test("markdown emphasis and link syntax never reach the voice", () => {
    const spoken = prepareTtsText(
      "**Fast, local search** is explained in [the docs](https://example.com/docs)."
    );
    assert.equal(spoken, "Fast, local search is explained in the docs.");
    assert.ok(!/[*[\]()]|https?:/.test(spoken));
  });

  test("fenced and inline code are not read character by character", () => {
    const spoken = prepareTtsText(
      "Install it, then run this:\n\n```bash\nnpm install p-map\n```\n\n" +
        "The entry point is `src/index.ts`."
    );
    assert.ok(!/```|npm install|src\/index|\.ts\b/.test(spoken), spoken);
    assert.match(spoken, /Install it, then run this/);
  });

  test("command syntax is translated into a spoken sentence", () => {
    assert.equal(
      prepareTtsText("Install: npm install p-map"),
      "Install: the n p m install command for p map"
    );
    assert.equal(
      prepareTtsText("Try npx create-next-app"),
      "Try the n p x create next app command"
    );
  });

  test("versions, dates, times and percentages become words", () => {
    const spoken = prepareTtsText(
      "Next.js v1.2.0 shipped on 2026-10-23 at 12:30 and is 50% faster."
    );
    assert.match(spoken, /Next dot J S/);
    assert.match(spoken, /version one point two point zero/);
    assert.match(spoken, /October twenty three, two thousand twenty six/);
    assert.match(spoken, /twelve thirty/);
    assert.match(spoken, /fifty percent/);
    assert.ok(!/[%/]|\d{4}-\d{2}-\d{2}|12:30/.test(spoken));
  });

  test("product names keep their dot instead of becoming sentence breaks", () => {
    assert.equal(prepareTtsText("Next.js is nice."), "Next dot J S is nice.");
    assert.equal(prepareTtsText("Node.js and Vue.js"), "Node dot J S and Vue dot J S");
  });

  test("the pronunciation dictionary is applied last", () => {
    assert.equal(
      prepareTtsText("Use API, CLI, GitHub and C++."),
      "Use A P I, C L I, Git Hub and C plus plus."
    );
    assert.equal(
      prepareTtsText("The README mentions EMFILE."),
      "The read me mentions em file."
    );
  });

  test("captions keep display spelling while speech is normalised", () => {
    const display = "Next.js v1.2.0 is 50% faster.";
    const segment: NarrationSegment = {
      id: "test-segment",
      purpose: "explain",
      spokenText: display,
      captionText: display,
      factIds: [],
    };

    assert.equal(segment.captionText, display);
    const speech = segmentSpokenText(segment);
    assert.match(speech, /Next dot J S/);
    assert.match(speech, /version one point two point zero/);
    assert.match(speech, /fifty percent/);
    assert.ok(!/Next\.js|50%|v1\.2\.0/.test(speech), speech);
  });
});
