import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildFactLedger } from "../src/facts.js";
import { evaluateScriptability } from "../src/scriptability.js";
import { analyzeRepository } from "../src/repository-analysis.js";
import { SCRIPTABILITY } from "../src/config.js";
import { enriched } from "./helpers.js";

function reportFor(name: string, repoOverrides = {}) {
  const repo = enriched(name, repoOverrides);
  const ledger = buildFactLedger(repo);
  return { repo, ledger, report: evaluateScriptability(repo, ledger) };
}

describe("scriptability gate", () => {
  test("documented repositories pass with their score recorded", () => {
    for (const name of ["high-quality-popular", "useful-underdog", "no-license"]) {
      const { report } = reportFor(name);
      assert.equal(report.ok, true, `${name}: ${report.missing.join("; ")}`);
      assert.ok(report.score >= SCRIPTABILITY.threshold, `${name} scores ${report.score}`);
      assert.ok(report.components.purpose > 0, `${name} has purpose evidence`);
      assert.ok(report.components.how > 0, `${name} has mechanism evidence`);
      assert.ok(report.components.example > 0, `${name} has example evidence`);
    }
  });

  test("weak repositories fail with explicit missing evidence", () => {
    for (const name of ["abandoned", "fork", "empty-readme", "badge-only"]) {
      const { report } = reportFor(name);
      assert.equal(report.ok, false, `${name} must fail`);
      assert.ok(
        report.missing.some(reason => /mechanism/.test(reason)),
        `${name} names the missing mechanism evidence`
      );
    }
  });

  test("stars and a license cannot substitute for an explanation", () => {
    const { report } = reportFor("badge-only");
    assert.equal(report.ok, false);
    assert.ok(report.score < SCRIPTABILITY.threshold);
  });

  test("a clear purpose alone is not enough", () => {
    const { report } = reportFor("abandoned");
    assert.ok(report.components.purpose >= 0.5, "purpose alone is recognised");
    assert.equal(report.ok, false, "but purpose alone is not scriptable");
  });

  test("category analysis reports supported and unsupported operations", () => {
    const { repo, ledger } = reportFor("high-quality-popular");
    const analysis = analyzeRepository(repo, ledger);
    assert.equal(analysis.category, "cli");
    assert.ok(analysis.signals.length > 0, "the category carries its reason");
    assert.ok(
      analysis.supported.some(operation => operation.id === "cli.run"),
      "documented commands unlock running the tool"
    );
  });

  test("an operation without evidence stays unsupported, with a reason", () => {
    const { repo, ledger } = reportFor("high-quality-popular", {
      readmeText:
        "# Rocket CLI\n\nA command-line tool that scaffolds TypeScript services " +
        "with linting and tests already wired up.\n\n## Install\n\n" +
        "```bash\nnpm install -g rocket-cli\n```\n",
    });
    const analysis = analyzeRepository(repo, ledger);
    const runOperation = analysis.unsupported.find(op => op.id === "cli.run");
    assert.ok(runOperation, "running it is unsupported without example evidence");
    assert.ok(runOperation!.reason.trim().length > 0);
  });

  test("missing example evidence is recorded as an omission, not a fabrication", () => {
    const { report } = reportFor("high-quality-popular", {
      readmeText:
        "# Rocket CLI\n\nA command-line tool that scaffolds TypeScript services " +
        "with linting and tests already wired up.\n\n" +
        "It exists because setting up a service by hand means editing six config files.\n",
    });
    assert.ok(
      report.omissions.some(omission => /example|use case/.test(omission)),
      `expected an example omission, got: ${report.omissions.join("; ")}`
    );
  });

  test("the report carries the best fact per role for debugging", () => {
    const { report } = reportFor("high-quality-popular");
    assert.ok(report.evidence.purpose, "the purpose fact is recorded");
    assert.ok(report.evidence.mechanism, "the mechanism fact is recorded");
    assert.equal(report.evidence.purpose!.semantic, "purpose");
    assert.ok(
      report.evidence.mechanism!.semantic === "mechanism" ||
        report.evidence.mechanism!.semantic === "outcome"
    );
  });
});
