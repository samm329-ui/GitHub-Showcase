import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildFactLedger } from "../src/facts.js";
import { composeScript, phraseFor, pauseKindBetween } from "../src/script-composer.js";
import { TTS_PAUSE_POLICY } from "../src/config.js";
import { toSpoken } from "../src/pronunciation.js";
import { enriched } from "./helpers.js";
import type { ExplanationNode } from "../src/explanation-planner.js";

function compose(name: string, overrides = {}, repoOverrides = {}) {
  const repo = enriched(name, repoOverrides);
  const ledger = buildFactLedger(repo);
  return { ...composeScript(ledger, repo, overrides), ledger, repo };
}

describe("script composer", () => {
  test("segments follow the graph's selected path in order", () => {
    const { plan, explanation, ledger } = compose("high-quality-popular", {
      targetDurationSeconds: 35,
    });
    assert.ok(explanation.selectedPath.length > 0, "a path was selected");
    assert.equal(plan.segments.length, explanation.selectedPath.length);
    plan.segments.forEach((segment, index) => {
      assert.equal(
        segment.clauseId,
        `graph.${explanation.selectedPath[index]}`,
        `segment ${segment.id} comes from path node ${explanation.selectedPath[index]}`
      );
      assert.ok(segment.factIds.length > 0, `${segment.id} cites facts`);
      for (const factId of segment.factIds) {
        assert.ok(
          ledger.facts.some(fact => fact.id === factId),
          `${segment.id} cites a real fact`
        );
      }
    });
  });

  test("spoken text is speech-normalised while captions keep spelling", () => {
    const { plan } = compose("high-quality-popular");
    for (const segment of plan.segments) {
      assert.equal(segment.spokenText, toSpoken(segment.captionText));
    }
    const install = plan.segments.find(segment => segment.purpose === "install");
    assert.ok(install, "an installation segment exists");
    assert.match(install!.captionText, /npm/, "captions keep the spelling");
    assert.equal(install!.spokenText, toSpoken(install!.captionText));
  });

  test("'For example,' introduces example evidence and nothing else", () => {
    const { plan, ledger } = compose("high-quality-popular");
    const factById = new Map(ledger.facts.map(fact => [fact.id, fact]));
    for (const segment of plan.segments) {
      const isExamplePhrase = /^For example,/.test(segment.captionText);
      const citesExample = segment.factIds.some(id => {
        const fact = factById.get(id);
        return fact?.semantic === "example" || fact?.semantic === "workflow";
      });
      assert.equal(
        isExamplePhrase,
        citesExample,
        `${segment.id}: "For example" must match the cited evidence`
      );
    }
  });

  test("a leading pronoun problem statement is given its antecedent", () => {
    const { plan } = compose("high-quality-popular");
    const problem = plan.segments.find(segment => segment.purpose === "problem");
    assert.ok(problem, "the fixture has problem evidence");
    assert.ok(
      !/^It\b/.test(problem!.captionText),
      `the problem must not open with a pronoun: ${problem!.captionText}`
    );
    assert.match(problem!.captionText, /^Rocket CLI\b/);
  });

  test("segment pauses follow the shared policy and the last is zero", () => {
    const { plan } = compose("high-quality-popular");
    const segments = plan.segments;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const pause = segments[index].pauseAfterMs;
      assert.ok(
        Object.values(TTS_PAUSE_POLICY).some(
          range => pause >= range.min && pause <= range.max
        ),
        `pause ${pause} on ${segments[index].id} is inside a policy range`
      );
    }
    assert.equal(
      segments[segments.length - 1].pauseAfterMs,
      0,
      "no trailing pause after the final segment"
    );
  });

  test("the pause before an example is the example beat", () => {
    const { plan } = compose("high-quality-popular");
    const exampleIndex = plan.segments.findIndex(
      segment => segment.purpose === "demo"
    );
    assert.ok(exampleIndex > 0, "the example is not the opening");
    assert.equal(
      plan.segments[exampleIndex - 1].pauseAfterMs,
      TTS_PAUSE_POLICY.example.default
    );
    assert.equal(
      pauseKindBetween("mechanism", "example"),
      "example"
    );
  });

  test("purpose phrases attach the project name exactly once", () => {
    const node = (proposition: string): ExplanationNode => ({
      id: "purpose",
      role: "purpose",
      proposition,
      evidence: [],
      importance: 1,
      novelty: 1,
      explanatoryValue: 1,
      estimatedWords: 1,
      required: true,
      visualTargetIds: [],
    });
    assert.equal(
      phraseFor(node("A command-line tool that ships"), "Rocket CLI"),
      "Rocket CLI is a command-line tool that ships."
    );
    assert.equal(
      phraseFor(node("Rocket CLI ships in one step"), "Rocket CLI"),
      "Rocket CLI ships in one step."
    );
  });

  test("a thin repository composes an honest short script with reasons", () => {
    const { plan, omissions, scriptability } = compose("abandoned");
    assert.equal(scriptability.ok, false);
    assert.equal(plan.segments.length, 1);
    assert.equal(plan.segments[0].purpose, "identify");
    assert.ok(omissions.length > 0, "omissions are recorded");
    for (const omission of omissions) {
      assert.ok(omission.reason.trim().length > 0, `${omission.id} has a reason`);
    }
  });

  test("the plan carries the requested target and voice", () => {
    const { plan } = compose("high-quality-popular", {
      targetDurationSeconds: 40,
      voiceId: "am_fenrir",
      speed: 1.05,
    });
    assert.equal(plan.targetDurationSeconds, 40);
    assert.equal(plan.voiceId, "am_fenrir");
    assert.equal(plan.speed, 1.05);
    assert.ok(plan.estimatedWords > 0);
  });
});
