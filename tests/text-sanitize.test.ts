import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { normalizeGeneratedText } from "../src/llm-script.js";
import { breakLongTokens, splitPhrases } from "../src/timeline.js";

describe("normalizeGeneratedText", () => {
  test("strips non-breaking hyphens and zero-width characters", () => {
    assert.equal(
      normalizeGeneratedText("sub\u2011agents and \u200Bclusters\u200B"),
      "sub-agents and clusters"
    );
  });

  test("converts fancy quotes to straight quotes", () => {
    assert.equal(normalizeGeneratedText("“it’s” fine"), "\"it's\" fine");
  });

  test("replaces em and en dashes with speakable punctuation", () => {
    assert.equal(normalizeGeneratedText("one\u2014two"), "one, two");
    assert.equal(normalizeGeneratedText("one\u2013two"), "one-two");
  });

  test("strips bare domain-plus-path tokens wholesale", () => {
    const out = normalizeGeneratedText(
      "Install via go install github.com/airiclenz/apogee@latest and run."
    );
    assert.ok(!/github\.com/i.test(out), out);
    assert.equal(out, "Install via go install and run.");
  });

  test("keeps domain-less filenames readable", () => {
    // llama.cpp has no path; it must survive for the normalizer to expand.
    assert.equal(normalizeGeneratedText("served by llama.cpp locally"), "served by llama.cpp locally");
  });

  test("collapses the whitespace left behind by token stripping", () => {
    assert.equal(
      normalizeGeneratedText("start  github.com/a/b/c  end."),
      "start end."
    );
  });
});

describe("breakLongTokens", () => {
  test("inserts zero-width spaces inside tokens longer than 13 chars", () => {
    const broken = breakLongTokens("github.com/airiclenz/apogee");
    assert.ok(broken.includes("\u200B"), "expected a zero-width break point");
    // Removing the breaks must return the original token exactly.
    assert.equal(broken.replace(/\u200B/g, ""), "github.com/airiclenz/apogee");
  });

  test("leaves ordinary words alone", () => {
    assert.equal(breakLongTokens("local LLMs edit code"), "local LLMs edit code");
  });

  test("splitPhrases applies the break to phrases it returns", () => {
    const phrases = splitPhrases(
      "Install it with go install github.com/airiclenz/apogee@latest today please."
    );
    const joined = phrases.join(" ");
    assert.ok(joined.includes("\u200B"));
    assert.equal(joined.replace(/\u200B/g, ""), "Install it with go install github.com/airiclenz/apogee@latest today please.");
  });
});
