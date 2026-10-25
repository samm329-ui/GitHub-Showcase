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
      "Install the n p m install command for p map"
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

  test("slashes and dashes do not cause double pronunciations or stutters", () => {
    // Parenthetical route paths with slashes should not repeat the preceding noun
    const opendray = prepareTtsText(
      "A single Go binary on your host serves the web admin (/admin/) and a REST + WebSocket API (/api/v1/)."
    );
    assert.equal(
      opendray,
      "A single Go binary on your host serves the web admin and a rest plus WebSocket A P I."
    );

    // CLI option flags (--version) before version numbers should not stutter "version version"
    const flowery = prepareTtsText(
      "To get started, the README starts you with the command dotnet add package Flowery.NET --version 4.0.0."
    );
    assert.equal(
      flowery,
      "To get started, the read me starts you with the command dotnet add package Flowery.NET version four point zero point zero."
    );

    // Natural version sentences should never say "version version"
    assert.equal(
      prepareTtsText("It is currently version 1.0.0."),
      "It is currently version one point zero point zero."
    );
    assert.equal(
      prepareTtsText("Available in version v2.0."),
      "Available in version two point zero."
    );

    // Identical owner/repo across slash should not stutter
    assert.equal(
      prepareTtsText("Explore Opendray/opendray and pipeshub-ai/pipeshub-ai."),
      "Explore Opendray and pipeshub-ai."
    );

    // Repeated identical acronyms or words across slashes/dashes are deduplicated
    assert.equal(prepareTtsText("API/API and version/version."), "A P I and version.");
    assert.equal(prepareTtsText("Call the API API."), "Call the A P I.");
  });

  test("app symbols like plus and hashtag are properly pronounced", () => {
    // C# and C++
    assert.equal(
      prepareTtsText("Built with C# and C++ for high performance."),
      "Built with C sharp and C plus plus for high performance."
    );

    // Hashtags
    assert.equal(
      prepareTtsText("Trending under #ai and #opensource."),
      "Trending under hashtag ai and hashtag opensource."
    );
    assert.equal(
      prepareTtsText("Tag it with #hashtag."),
      "Tag it with hashtag."
    );

    // Number rank (#1 tool) vs issue numbers (#42)
    assert.equal(
      prepareTtsText("The #1 tool on GitHub, resolving #42."),
      "The number one tool on Git Hub, resolving issue forty two."
    );

    // Plus signs in quantities and combinations
    assert.equal(
      prepareTtsText("Includes 100+ controls with REST + WebSocket support."),
      "Includes one hundred plus controls with rest plus WebSocket support."
    );
  });
});
