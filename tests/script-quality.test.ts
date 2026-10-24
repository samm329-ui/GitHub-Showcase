import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildFactLedger } from "../src/facts.js";
import { composeScript } from "../src/script-composer.js";
import { evaluateScriptQuality } from "../src/script-quality.js";
import { enriched } from "./helpers.js";
import type { NarrationPlan, NarrationSegment } from "../src/types.js";

function qualityFor(name: string) {
  const repo = enriched(name);
  const ledger = buildFactLedger(repo);
  const plan = composeScript(ledger, repo).plan;
  return { plan, ledger, report: evaluateScriptQuality(plan, ledger) };
}

function segment(overrides: Partial<NarrationSegment>): NarrationSegment {
  return {
    id: "seg-01",
    purpose: "identify",
    spokenText: "Rocket CLI is a tool that ships.",
    captionText: "Rocket CLI is a tool that ships.",
    factIds: ["purpose:x"],
    ...overrides,
  };
}

describe("script quality gate", () => {
  test("the production script passes the quality gate", () => {
    for (const name of ["high-quality-popular", "useful-underdog", "no-license"]) {
      const { report } = qualityFor(name);
      assert.deepEqual(report.hardFailures, [], `${name}: ${report.hardFailures.join("; ")}`);
      assert.equal(report.ok, true);
      assert.ok(report.factsCited > 0);
      assert.ok(report.estimatedSeconds > 0);
    }
  });

  test("ok is gated on hard failures, not on the score", () => {
    const { report } = qualityFor("high-quality-popular");
    // The gate rule itself: the score can be anything, ok tracks hard failures.
    assert.equal(report.ok, report.hardFailures.length === 0);
  });

  test("citing an unknown fact fails the gate", () => {
    const { plan, ledger } = qualityFor("high-quality-popular");
    const tampered: NarrationPlan = {
      ...plan,
      segments: [
        segment({ factIds: ["does-not-exist"] }),
        ...plan.segments.slice(1),
      ],
    };
    const report = evaluateScriptQuality(tampered, ledger);
    assert.equal(report.ok, false);
    assert.ok(report.hardFailures.some(failure => /unknown fact/.test(failure)));
  });

  test("a segment that cites nothing fails the gate", () => {
    const { plan, ledger } = qualityFor("high-quality-popular");
    const tampered: NarrationPlan = {
      ...plan,
      segments: [segment({ factIds: [] }), ...plan.segments.slice(1)],
    };
    const report = evaluateScriptQuality(tampered, ledger);
    assert.equal(report.ok, false);
    assert.ok(report.hardFailures.some(failure => /cites no fact/.test(failure)));
  });

  test("a duplicated sentence fails the gate", () => {
    const { plan, ledger } = qualityFor("high-quality-popular");
    const first = plan.segments[0];
    const tampered: NarrationPlan = {
      ...plan,
      segments: [...plan.segments, { ...first, id: "seg-99" }],
    };
    const report = evaluateScriptQuality(tampered, ledger);
    assert.equal(report.ok, false);
    assert.ok(report.hardFailures.some(failure => /same sentence/.test(failure)));
  });

  test("an empty segment fails the gate", () => {
    const { plan, ledger } = qualityFor("high-quality-popular");
    const tampered: NarrationPlan = {
      ...plan,
      segments: [segment({ spokenText: "   ", captionText: "   " }), ...plan.segments.slice(1)],
    };
    const report = evaluateScriptQuality(tampered, ledger);
    assert.equal(report.ok, false);
    assert.ok(report.hardFailures.some(failure => /empty/.test(failure)));
  });

  test("an over-long script fails the gate", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const long = "This sentence pads the script beyond its budget. ".repeat(80);
    const plan: NarrationPlan = {
      repositoryNodeId: repo.nodeId,
      fullName: repo.full_name,
      angle: "quick-tour",
      angleReason: "synthetic",
      targetDurationSeconds: 20,
      styleVariant: "synthetic",
      voiceId: "am_fenrir",
      speed: 1,
      estimatedWords: 0,
      segments: [segment({ spokenText: long, captionText: long })],
    };
    const report = evaluateScriptQuality(plan, ledger);
    assert.equal(report.ok, false);
    assert.ok(report.hardFailures.some(failure => /exceeds|overshoots/.test(failure)));
  });

  test("metadata takeover fails only while explanatory content exists", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const licenseFact = ledger.facts.find(fact => fact.kind === "license");
    const featureFact = ledger.facts.find(fact => fact.kind === "feature");
    assert.ok(licenseFact && featureFact, "the fixture carries license and feature facts");
    const stars = "This project has four thousand stars and forty forks.";
    const explain = segment({
      id: "seg-02",
      purpose: "explain",
      spokenText: "One command scaffolds a service with linting wired up.",
      captionText: "One command scaffolds a service with linting wired up.",
      factIds: [featureFact!.id],
    });
    const withExplanation: NarrationPlan = {
      repositoryNodeId: repo.nodeId,
      fullName: repo.full_name,
      angle: "quick-tour",
      angleReason: "synthetic",
      targetDurationSeconds: 30,
      styleVariant: "synthetic",
      voiceId: "am_fenrir",
      speed: 1,
      estimatedWords: 0,
      segments: [
        segment({
          purpose: "adoption",
          spokenText: `${stars} ${stars}`,
          captionText: `${stars} ${stars}`,
          factIds: [licenseFact!.id],
        }),
        explain,
      ],
    };
    const dominated = evaluateScriptQuality(withExplanation, ledger);
    assert.equal(dominated.ok, false, "metadata may not crowd out real explanation");
    assert.ok(dominated.hardFailures.some(failure => /metadata/.test(failure)));

    // Without explanatory content it is a thin script, not a takeover.
    const thin: NarrationPlan = {
      ...withExplanation,
      segments: [withExplanation.segments[0]],
    };
    const thinReport = evaluateScriptQuality(thin, ledger);
    assert.deepEqual(thinReport.hardFailures, [], thinReport.hardFailures.join("; "));
    assert.equal(thinReport.ok, true);
    assert.ok(thinReport.warnings.some(warning => /thin script/.test(warning)));
  });
});
