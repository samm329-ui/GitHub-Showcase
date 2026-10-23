import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildStory,
  chooseStructure,
  createStoryContext,
  isTransitionAllowed,
  SLOT_ORDER,
  structuresForAngle,
  validateSlotSequence,
} from "../src/narration-grammar.js";
import { buildFactLedger } from "../src/facts.js";
import { enriched } from "./helpers.js";
import { findBoilerplate, selectAngle } from "../src/narration.js";

function contextFor(name = "high-quality-popular") {
  const repo = enriched(name);
  const ledger = buildFactLedger(repo);
  return { repo, ledger, context: createStoryContext(ledger, repo, 7) };
}

describe("slot grammar", () => {
  test("slots have one canonical, monotonic order", () => {
    assert.equal(new Set(SLOT_ORDER).size, SLOT_ORDER.length);
    assert.equal(validateSlotSequence(SLOT_ORDER), true);
    assert.equal(isTransitionAllowed("identity", "value"), true);
    assert.equal(isTransitionAllowed("cta", "demo"), false);
    assert.equal(isTransitionAllowed("setup", "identity"), false);
    assert.equal(validateSlotSequence(["identity", "cta", "demo"]), false);
  });
});

describe("structure selection", () => {
  test("every angle has at least one structure", () => {
    for (const angle of [
      "quick-tour",
      "try-it",
      "developer-workflow",
      "under-the-radar",
      "mature-and-popular",
      "trade-off",
      "what-it-does",
    ] as const) {
      assert.ok(structuresForAngle(angle).length > 0, angle);
    }
  });

  test("retries rotate to a different structure", () => {
    const keys = new Set(
      [0, 1, 2, 3, 4, 5].map(attempt => chooseStructure("quick-tour", new Map(), attempt).key)
    );
    assert.ok(keys.size >= 3, `only ${keys.size} structures were selected`);
  });

  test("a structure used twice is skipped when another is available", () => {
    const first = chooseStructure("quick-tour", new Map(), 0);
    const usage = new Map([[first.key, 2]]);
    const second = chooseStructure("quick-tour", usage, 0);
    assert.notEqual(second.key, first.key);
  });
});

describe("story building", () => {
  test("the same evidence and attempt produce an identical story", () => {
    const { repo, ledger } = contextFor();
    const options = {
      ledger,
      repo,
      angle: selectAngle(ledger, repo).angle,
      targetDurationSeconds: 35,
      attemptCount: 1,
      seed: 12345,
    };
    assert.deepEqual(buildStory(options), buildStory(options));
  });

  test("clauses are ordered, cited and free of filler", () => {
    const { repo, ledger } = contextFor();
    const story = buildStory({
      ledger,
      repo,
      angle: "quick-tour",
      targetDurationSeconds: 35,
      attemptCount: 2,
      seed: 1,
    });
    assert.ok(story.clauses.length >= 2);
    assert.equal(
      validateSlotSequence(story.clauses.map(clause => clause.slot)),
      true
    );
    const known = new Set(ledger.facts.map(fact => fact.id));
    for (const clause of story.clauses) {
      assert.ok(clause.factIds.length > 0, `${clause.id} cites nothing`);
      for (const id of clause.factIds) assert.ok(known.has(id), `${clause.id}: ${id}`);
      assert.deepEqual(findBoilerplate(clause.spoken), []);
    }
    assert.ok(story.score > 0 && story.score <= 100);
  });

  test("no fact is spoken more than twice", () => {
    const { repo, ledger } = contextFor();
    for (const attempt of [0, 1, 2]) {
      const story = buildStory({
        ledger,
        repo,
        angle: "quick-tour",
        targetDurationSeconds: 58,
        attemptCount: attempt,
        seed: attempt,
      });
      const counts = new Map<string, number>();
      for (const clause of story.clauses) {
        for (const id of clause.factIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const [id, count] of counts) assert.ok(count <= 2, `${id} used ${count} times`);
    }
  });

  test("spoken text is converted but captions keep correct spelling", () => {
    const repo = enriched("high-quality-popular", { name: "Next.js", full_name: "vercel/Next.js" });
    const ledger = buildFactLedger(repo);
    const story = buildStory({
      ledger,
      repo,
      angle: selectAngle(ledger, repo).angle,
      targetDurationSeconds: 35,
      seed: 3,
    });
    const spoken = story.clauses.map(clause => clause.spoken).join(" ");
    const captions = story.clauses.map(clause => clause.caption).join(" ");
    assert.match(spoken, /Next dot J S/);
    assert.match(captions, /Next\.js/);
  });
});
