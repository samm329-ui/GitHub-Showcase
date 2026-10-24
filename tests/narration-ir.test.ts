import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildFactLedger } from "../src/facts.js";
import { validateScript } from "../src/narration.js";
import { composeScript } from "../src/script-composer.js";
import {
  compileRepoNarration,
  MAX_METADATA_WORD_SHARE,
  validateNarration,
} from "../src/narration-ir.js";
import { enriched, fixtureNames } from "./helpers.js";
import type { Fact, FactLedger, NarrationPlan } from "../src/types.js";

function planFor(
  name: string,
  overrides = {},
  repoOverrides = {}
): { plan: NarrationPlan; ledger: FactLedger } {
  const repo = enriched(name, repoOverrides);
  const ledger = buildFactLedger(repo);
  const plan = composeScript(ledger, repo, overrides).plan;
  return { plan, ledger };
}

/** True when the fact demonstrates a practical use case. */
function demonstratesUseCase(fact: Fact): boolean {
  return (
    fact.kind === "use_case" ||
    fact.semantic === "example" ||
    fact.semantic === "workflow"
  );
}

describe("narration structure", () => {
  test("every fixture compiles a narration that passes the structural gate", () => {
    for (const name of fixtureNames()) {
      const { plan, ledger } = planFor(name);
      const compiled = compileRepoNarration(plan, ledger);
      assert.ok(compiled.script.purpose.trim(), `${name}: purpose is empty`);
      const errors = validateNarration(compiled.script, compiled.coverage);
      assert.deepEqual(
        errors,
        [],
        `${name}: ${errors.join("; ")}`
      );
    }
  });

  test("documented example evidence satisfies the use-case gate", () => {
    const { plan, ledger } = planFor("high-quality-popular");
    const compiled = compileRepoNarration(plan, ledger);
    assert.ok(
      ledger.facts.some(demonstratesUseCase),
      "the fixture must carry example or workflow evidence"
    );
    assert.equal(compiled.coverage.useCaseSource, "use-case-facts");
    assert.ok(compiled.script.useCase.trim().length > 0);
    assert.ok(
      !validateNarration(compiled.script, compiled.coverage).some(error =>
        /use case/.test(error)
      )
    );
  });

  test("evidence for a use case may not be omitted silently", () => {
    // A README whose usage section is real prose gives the ledger use-case
    // evidence. If the compiled script cites none of it, validation must fail
    // instead of skipping the section.
    const repo = enriched("high-quality-popular", {
      readmeText:
        "# Rocket CLI\n\nA command-line tool for TypeScript services.\n\n" +
        "## Usage\n\n" +
        "Run rocket watch to keep every service restarted while you edit files.\n\n" +
        "## Features\n\n- Watches files and restarts services.\n",
    });
    const ledger = buildFactLedger(repo);
    assert.ok(
      ledger.facts.some(demonstratesUseCase),
      "fixture must produce use-case evidence"
    );
    const plan = composeScript(ledger, repo).plan;
    // Simulate a compiler gap: drop every segment that cites use-case evidence.
    const withoutUseCase: NarrationPlan = {
      ...plan,
      segments: plan.segments.filter(segment =>
        segment.factIds.every(id => {
          const fact = ledger.facts.find(candidate => candidate.id === id);
          return !fact || !demonstratesUseCase(fact);
        })
      ),
    };
    const compiled = compileRepoNarration(withoutUseCase, ledger);
    assert.equal(
      compiled.coverage.useCaseSource,
      "none",
      "no surviving segment cites use-case evidence"
    );
    const errors = validateNarration(compiled.script, compiled.coverage);
    assert.ok(
      errors.some(error => /use case/.test(error)),
      "omitting evidenced use-case content must be a validation error"
    );
  });

  test("without feature evidence the mechanism check is excused, not invented", () => {
    const { plan, ledger } = planFor("high-quality-popular", {}, {
      readmeText: "# Rocket CLI\n\nA command-line tool for TypeScript services.\n",
      rootFiles: [],
    });
    const compiled = compileRepoNarration(plan, ledger);
    if (compiled.script.mechanism.trim()) return; // a feature was still extractable
    assert.equal(compiled.coverage.hasFeatureEvidence, false);
    const errors = validateNarration(compiled.script, compiled.coverage);
    assert.ok(
      !errors.some(error => /mechanism/.test(error)),
      "a repository without feature evidence must not fail the run"
    );
  });

  test("the strict spec gate requires every section when coverage is unknown", () => {
    const compiled = compileRepoNarration(planFor("high-quality-popular").plan, buildFactLedger(enriched("high-quality-popular")));
    const blank = { ...compiled.script, mechanism: "", useCase: "" };
    const errors = validateNarration(blank);
    assert.ok(errors.some(error => /mechanism/.test(error)));
    assert.ok(errors.some(error => /use case/.test(error)));
  });

  test("popularity metadata may not exceed its word share when evidence existed", () => {
    for (const name of fixtureNames()) {
      const { plan, ledger } = planFor(name);
      const compiled = compileRepoNarration(plan, ledger);
      const hadSomethingToSay =
        compiled.script.mechanism.trim().length > 0 ||
        compiled.script.useCase.trim().length > 0 ||
        compiled.coverage.hasFeatureEvidence ||
        compiled.coverage.hasUseCaseEvidence;
      if (!hadSomethingToSay) continue; // a thin repo is an honest omission
      assert.ok(
        compiled.coverage.metadataWordShare <= MAX_METADATA_WORD_SHARE,
        `${name}: metadata share ${(compiled.coverage.metadataWordShare * 100).toFixed(0)}%`
      );
    }
  });

  test("a thin repository produces an honest short script, not metadata filler", () => {
    const { plan, ledger } = planFor("abandoned");
    const compiled = compileRepoNarration(plan, ledger);
    // The composer never manufactures metadata segments: with no explanation
    // evidence there is nothing to say, and the script says only that.
    assert.ok(compiled.coverage.metadataWordShare <= MAX_METADATA_WORD_SHARE);
    assert.deepEqual(
      validateNarration(compiled.script, compiled.coverage).filter(error =>
        /metadata|dominates/.test(error)
      ),
      [],
      "no explanation evidence existed, so the thin script must pass"
    );
  });

  test("metadata dominance fails when explanation evidence was available", () => {
    // Synthetic: a script that leans on stars while a use case was knowable.
    const dominance = validateNarration(
      {
        hook: "Meet rocket-cli.",
        purpose: "A command-line tool for TypeScript services.",
        mechanism: "",
        useCase: "Install it with npm and run rocket watch.",
        benefit: "",
      },
      {
        hasFeatureEvidence: false,
        hasUseCaseEvidence: true,
        metadataWordShare: 0.62,
        useCaseSource: "use-case-facts",
      }
    );
    assert.ok(
      dominance.some(error => /dominates/.test(error)),
      "stars may not replace the explanation of evidenced repositories"
    );
  });

  test("the script validator records the structured narration", () => {
    const { plan, ledger } = planFor("high-quality-popular");
    const validation = validateScript(plan, ledger);
    assert.ok(validation.ok, validation.errors.join("; "));
    assert.ok(validation.narrative, "the structured narration must be recorded");
    assert.match(validation.narrative.purpose, /command-line/i);
    assert.ok(validation.narrative.mechanism.length > 0);
  });
});
