import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildFactLedger } from "../src/facts.js";
import {
  buildNarrationPlan,
  findBoilerplate,
  niceRepoName,
  pickVariant,
  selectAngle,
  stableHash,
  validateScript,
  wordCount,
  type PhraseHistory,
} from "../src/narration.js";
import { toSpoken, pronunciationEntries } from "../src/pronunciation.js";
import { composeScript } from "../src/script-composer.js";
import { enriched } from "./helpers.js";
import { ESTIMATED_WPM, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS } from "../src/config.js";
import type { NarrationPlan } from "../src/types.js";

function planFor(
  fixtureName: string,
  overrides: Parameters<typeof buildNarrationPlan>[2] = {},
  repoOverrides = {}
): NarrationPlan {
  const repo = enriched(fixtureName, repoOverrides);
  const ledger = buildFactLedger(repo, {
    previousStars: overrides.attemptCount ? 100 : null,
    previousCapturedAt: overrides.attemptCount
      ? new Date(Date.now() - 7 * 86400000).toISOString()
      : null,
  });
  return buildNarrationPlan(ledger, repo, overrides);
}

describe("script quality", () => {
  test("the script explains the project clearly", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const plan = composeScript(ledger, repo).plan;
    const validation = validateScript(plan, ledger);
    assert.ok(validation.ok, validation.errors.join("; "));
    const displayed = plan.segments.map(s => s.captionText).join(" ");
    const firstTwo = plan.segments.slice(0, 2).map(s => s.captionText).join(" ");
    assert.match(firstTwo, /Rocket CLI/);
    assert.match(displayed, /TypeScript/, "proper nouns must survive");
    assert.ok(
      !/it is A command-line/i.test(displayed),
      "the description must not be glued onto an 'it is' prefix"
    );
  });

  test("every segment cites at least one known fact", () => {
    for (const name of ["high-quality-popular", "useful-underdog", "no-license"]) {
      const repo = enriched(name);
      const ledger = buildFactLedger(repo);
      const plan = buildNarrationPlan(ledger, repo);
      const known = new Set(ledger.facts.map(fact => fact.id));
      for (const segment of plan.segments) {
        assert.ok(segment.factIds.length > 0, `${name}/${segment.id} cites nothing`);
        for (const id of segment.factIds) {
          assert.ok(known.has(id), `${name}/${segment.id} cites unknown ${id}`);
        }
      }
    }
  });

  test("a repository with no license is never called open source", () => {
    const repo = enriched("no-license");
    const ledger = buildFactLedger(repo);
    const plan = composeScript(ledger, repo).plan;
    const text = plan.segments.map(s => s.spokenText).join(" ");
    assert.ok(!/open[- ]source/i.test(text), text);
    const validation = validateScript(plan, ledger);
    assert.ok(validation.ok, validation.errors.join("; "));
  });

  test("trending wording is rejected without snapshots", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const plan = buildNarrationPlan(ledger, repo);
    plan.segments[0].spokenText = "This project is trending right now.";
    plan.segments[0].captionText = "This project is trending right now.";
    const validation = validateScript(plan, ledger);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some(error => /trending/.test(error)));
  });

  test("trending wording is allowed with a dated snapshot", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo, {
      previousStars: 100,
      previousCapturedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    });
    const plan = buildNarrationPlan(ledger, repo);
    plan.segments[0].spokenText = "This project is trending right now.";
    plan.segments[0].captionText = "This project is trending right now.";
    const validation = validateScript(plan, ledger);
    assert.ok(
      !validation.errors.some(error => /trending/.test(error)),
      validation.errors.join("; ")
    );
  });

  test("open source does not imply free hosted services", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const plan = buildNarrationPlan(ledger, repo);
    plan.segments[0].spokenText =
      "It is open source, and all the hosted services are free.";
    plan.segments[0].captionText = plan.segments[0].spokenText;
    const validation = validateScript(plan, ledger);
    assert.ok(validation.errors.some(error => /hosted services are free/.test(error)));
  });

  test("banned filler is detected and rejected", () => {
    assert.deepEqual(findBoilerplate("This is a game changer for teams."), ["game changer"]);
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const plan = buildNarrationPlan(ledger, repo);
    plan.segments[0].spokenText = "This is a revolutionary tool.";
    plan.segments[0].captionText = "This is a revolutionary tool.";
    assert.ok(
      validateScript(plan, ledger).errors.some(error => /filler/.test(error))
    );
  });

  test("the script never repeats a single fact three times", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const plan = buildNarrationPlan(ledger, repo);
    const counts = new Map<string, number>();
    for (const segment of plan.segments) {
      for (const id of segment.factIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      assert.ok(count <= 2, `fact ${id} used ${count} times`);
    }
  });
});

describe("script variation", () => {
  test("the same fixture yields several distinct patterns", () => {
    const variants = new Set<string>();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      variants.add(planFor("high-quality-popular", { attemptCount: attempt }).styleVariant);
    }
    assert.ok(variants.size >= 3, `only produced ${variants.size} patterns: ${[...variants]}`);
  });

  test("variants produce genuinely different narration", () => {
    const texts = new Set<string>();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const plan = planFor("high-quality-popular", { attemptCount: attempt });
      texts.add(plan.segments.map(s => s.spokenText).join(" "));
    }
    assert.ok(texts.size >= 3, `only ${texts.size} distinct scripts`);
  });

  test("variation comes from patterns, not random shuffling", () => {
    const first = planFor("high-quality-popular", { attemptCount: 0 });
    const again = planFor("high-quality-popular", { attemptCount: 0 });
    assert.equal(first.styleVariant, again.styleVariant, "the same input must be deterministic");
    assert.equal(
      first.segments.map(s => s.spokenText).join(""),
      again.segments.map(s => s.spokenText).join("")
    );
  });

  test("recently used patterns are avoided", () => {
    const usage: PhraseHistory = new Map();
    const first = planFor("high-quality-popular", { attemptCount: 0 });
    usage.set(first.styleVariant, 2);
    const second = planFor("high-quality-popular", {
      attemptCount: 0,
      recentUsage: usage,
    });
    assert.notEqual(second.styleVariant, first.styleVariant);
  });

  test("pickVariant honours the repetition limit", () => {
    const keys = ["a", "b", "c"];
    const usage = new Map<string, number>([
      ["a", 2],
      ["b", 0],
    ]);
    const picks = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      picks.add(pickVariant(keys, usage, seed).key);
    }
    assert.ok(!picks.has("a"), "an over-used pattern must not be picked");
  });

  test("stableHash is deterministic", () => {
    assert.equal(stableHash("acme/rocket-cli"), stableHash("acme/rocket-cli"));
    assert.notEqual(stableHash("a"), stableHash("b"));
  });
});

describe("angle selection follows the evidence", () => {
  test("a repository with a caveat uses the trade-off angle", () => {
    const repo = enriched("high-quality-popular", {
      readmeText:
        enriched("high-quality-popular").readmeText +
        "\n\nThis tool can be self-hosted on your own machine.\n",
    });
    const ledger = buildFactLedger(repo);
    assert.equal(selectAngle(ledger, repo).angle, "trade-off");
  });

  test("several features produce a quick tour", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    assert.equal(selectAngle(ledger, repo).angle, "quick-tour");
  });

  test("measured growth alone selects the underdog angle", () => {
    const repo = enriched("useful-underdog", {
      readmeText:
        "# Logline\n\nLogline collapses noisy stack traces into one readable line for terminal use.\n",
    });
    const ledger = buildFactLedger(repo, {
      previousStars: 20,
      previousCapturedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    assert.equal(selectAngle(ledger, repo).angle, "under-the-radar");
  });

  test("a purpose-only repository uses the plain angle", () => {
    const repo = enriched("high-quality-popular", {
      readmeText:
        "# Project\n\nThis project formats tabular text files so that columns line up. " +
        "That is the whole idea and it is implemented in a single file.\n",
      description: "A tiny formatter for tabular text files with no dependencies.",
    });
    const ledger = buildFactLedger(repo);
    assert.equal(selectAngle(ledger, repo).angle, "what-it-does");
  });
});

describe("duration policy", () => {
  test("word targets follow the configured duration", () => {
    for (const target of [MIN_DURATION_SECONDS, 30, MAX_DURATION_SECONDS]) {
      const plan = planFor("high-quality-popular", { targetDurationSeconds: target });
      const limit = Math.floor((target / 60) * ESTIMATED_WPM);
      assert.ok(
        wordCount(plan.segments.map(s => s.spokenText).join(" ")) <= limit,
        `target ${target}s produced ${plan.estimatedWords} words (limit ${limit})`
      );
    }
  });

  test("a longer target produces more content when evidence allows", () => {
    const short = planFor("high-quality-popular", { targetDurationSeconds: 20 });
    const long = planFor("high-quality-popular", { targetDurationSeconds: 50 });
    assert.ok(
      long.estimatedWords >= short.estimatedWords,
      `${long.estimatedWords} should be >= ${short.estimatedWords}`
    );
  });

  test("the estimate never exceeds the hard maximum", () => {
    const repo = enriched("high-quality-popular", {
      description:
        "A command-line tool that scaffolds, lints, deploys and monitors TypeScript services.",
      readmeText:
        enriched("high-quality-popular").readmeText +
        "\n\n## More\n\nThis tool can be self-hosted on your own machine.\n",
    });
    const ledger = buildFactLedger(repo, {
      previousStars: 100,
      previousCapturedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    });
    const plan = buildNarrationPlan(ledger, repo, { targetDurationSeconds: 999 });
    assert.equal(plan.targetDurationSeconds, MAX_DURATION_SECONDS);
    const validation = validateScript(plan, ledger);
    assert.ok(
      validation.estimatedSeconds <= MAX_DURATION_SECONDS,
      `estimated ${validation.estimatedSeconds}`
    );
  });

  test("optional detail is dropped before the script gets rushed", () => {
    const long = planFor("high-quality-popular", { targetDurationSeconds: 58 });
    const short = planFor("high-quality-popular", { targetDurationSeconds: 20 });
    assert.ok(long.segments.length >= short.segments.length);
  });
});

describe("pronunciation", () => {
  test("spoken text is rewritten but display text is not", () => {
    assert.equal(toSpoken("Next.js is nice"), "Next dot J S is nice");
    assert.equal(toSpoken("run npm install"), "run n p m install");
  });

  test("substitution is whole-word only", () => {
    assert.equal(toSpoken("Google"), "Google");
    assert.equal(toSpoken("go routines"), "go routines");
    assert.equal(toSpoken("Go routines"), "Go routines");
    assert.equal(toSpoken("cargo"), "cargo", "'cargo' is not the entry 'Cargo'");
  });

  test("the dictionary has no duplicate display keys", () => {
    const seen = new Set<string>();
    for (const entry of pronunciationEntries()) {
      assert.ok(!seen.has(entry.display.toLowerCase()), `duplicate ${entry.display}`);
      seen.add(entry.display.toLowerCase());
    }
  });

  test("spoken and caption text are separate fields in the plan", () => {
    const repo = enriched("high-quality-popular", {
      name: "Next.js",
      full_name: "vercel/Next.js",
    });
    const ledger = buildFactLedger(repo);
    const plan = buildNarrationPlan(ledger, repo);
    const spoken = plan.segments.map(s => s.spokenText).join(" ");
    const captions = plan.segments.map(s => s.captionText).join(" ");
    assert.match(spoken, /Next dot J S/);
    assert.match(captions, /Next\.js/);
    assert.ok(!/Next dot J S/.test(captions), "captions must keep correct spelling");
  });

  test("repository names are humanised for speech", () => {
    assert.equal(niceRepoName("rocket-cli"), "Rocket CLI");
    assert.equal(niceRepoName("my-api"), "My API");
    assert.equal(niceRepoName("Next.js"), "Next.js");
    assert.equal(niceRepoName("tiny_http"), "Tiny HTTP");
  });
});
