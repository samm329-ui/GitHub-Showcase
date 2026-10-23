import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildFactLedger,
  extractInstall,
  factsOfKind,
  narratableFacts,
  parseReadme,
  unsupportedClaims,
} from "../src/facts.js";
import { enriched } from "./helpers.js";

describe("fact extraction", () => {
  test("every fact carries a source and a confidence", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    assert.ok(ledger.facts.length >= 5);
    for (const fact of ledger.facts) {
      assert.ok(fact.source.kind, `${fact.id} has no source kind`);
      assert.ok(fact.source.location, `${fact.id} has no source location`);
      assert.ok(fact.source.capturedAt);
      assert.ok(fact.confidence > 0 && fact.confidence <= 1);
      assert.ok(fact.claim.trim().length > 0);
    }
  });

  test("purpose comes from the description when there is one", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const purpose = factsOfKind(ledger, "purpose")[0];
    assert.ok(purpose);
    assert.equal(purpose.source.kind, "api-field");
    assert.equal(purpose.source.location, "repo.description");
  });

  test("features come from real README bullets, not keywords", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const features = factsOfKind(ledger, "feature");
    assert.ok(features.length >= 3);
    assert.match(features[0].spoken, /scaffold/i);
    assert.ok(features.every(feature => feature.source.location.startsWith("readme#")));
  });

  test("adoption is stated with a capture timestamp", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const adoption = factsOfKind(ledger, "adoption")[0];
    assert.match(adoption.spoken, /stars/i);
    assert.equal(adoption.source.kind, "api-field");
  });
});

describe("unsupported claims are prevented", () => {
  test("no license field means no license fact at all", () => {
    const repo = enriched("no-license");
    const ledger = buildFactLedger(repo);
    assert.equal(factsOfKind(ledger, "license").length, 0);
    const joined = ledger.facts.map(fact => fact.claim.toLowerCase()).join(" ");
    assert.ok(!/open[- ]source/.test(joined), "must not describe it as open source");
  });

  test("a recognised license produces a license fact", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const license = factsOfKind(ledger, "license")[0];
    assert.equal(license.spoken, "it is released under the MIT license");
  });

  test("an unrecognised license is reported with its terms caveat", () => {
    const repo = enriched("high-quality-popular", {
      licenseSpdxId: "SEE LICENSE IN README.md",
      openSourceLicense: null,
    });
    const ledger = buildFactLedger(repo);
    const license = factsOfKind(ledger, "license")[0];
    assert.match(license.spoken, /check the terms/i);
  });

  test("no star snapshots means no momentum fact", () => {
    const repo = enriched("useful-underdog");
    const ledger = buildFactLedger(repo);
    const growth = ledger.facts.filter(fact => fact.source.kind === "star-snapshot");
    assert.equal(growth.length, 0);
  });

  test("star snapshots produce a dated growth fact", () => {
    const repo = enriched("useful-underdog");
    const ledger = buildFactLedger(repo, {
      previousStars: 100,
      previousCapturedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    });
    const growth = ledger.facts.filter(fact => fact.source.kind === "star-snapshot");
    assert.equal(growth.length, 1);
    assert.match(growth[0].spoken, /stars a day/i);
  });

  test("a missing README yields no invented features", () => {
    const repo = enriched("high-quality-popular", { readmeText: null });
    const ledger = buildFactLedger(repo);
    assert.equal(factsOfKind(ledger, "feature").length, 0);
    assert.equal(factsOfKind(ledger, "use_case").length, 0);
  });

  test("fenced code is never narrated as a use case", () => {
    const repo = enriched("high-quality-popular", {
      description: "Maps over promises concurrently",
      readmeText:
        "# p-map\n\nMaps over promises concurrently.\n\n" +
        "## Usage\n\n```js\nimport pMap from 'p-map';\n" +
        "const result = await pMap(items, mapper); //=> array\n```\n",
    });
    const ledger = buildFactLedger(repo);
    const spoken = ledger.facts.map(item => item.spoken).join(" ");
    assert.ok(!/\bimport\b|=>|https?:\/\//.test(spoken), spoken);
    assert.equal(factsOfKind(ledger, "use_case").length, 0);
  });

  test("a related-packages list is not treated as features", () => {
    const repo = enriched("high-quality-popular", {
      description: "Maps over promises concurrently",
      readmeText:
        "# p-map\n\nMaps over promises concurrently.\n\n" +
        "## Related\n\n- p-all - Run async functions concurrently\n" +
        "- p-filter - Filter promises concurrently\n",
    });
    const ledger = buildFactLedger(repo);
    assert.equal(factsOfKind(ledger, "feature").length, 0);
  });

  test("hosting and cost are only claimed with explicit evidence", () => {
    const bare = enriched("high-quality-popular");
    const bareFacts = buildFactLedger(bare);
    const bareRequirements = factsOfKind(bareFacts, "requirement");
    assert.equal(bareRequirements.length, 0, "no README evidence, no requirement claims");

    const hosted = enriched("high-quality-popular", {
      readmeText:
        bare.readmeText +
        "\n\n## Pricing\n\nThere is a free tier and a paid plan billed per month.\n",
    });
    const hostedFacts = buildFactLedger(hosted);
    assert.ok(factsOfKind(hostedFacts, "requirement").length >= 1);
  });

  test("segments that cite nothing are reported as unsupported", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const problems = unsupportedClaims(
      [
        { spokenText: "This is a totally unsupported claim.", factIds: [] },
        { spokenText: "Another one.", factIds: ["does-not-exist"] },
      ],
      ledger
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /cites no fact/);
    assert.match(problems[1], /unknown fact/);
  });
});

describe("install extraction requires a real command", () => {
  test("reads the npm command from the README", () => {
    const repo = enriched("high-quality-popular");
    const parsed = parseReadme(repo.readmeText);
    const info = extractInstall(repo, parsed);
    assert.match(info.command ?? "", /npm install -g rocket-cli/);
    assert.equal(info.spoken, "You can install it with npm");
    assert.ok(info.fact);
  });

  test("reads the cargo command from the README", () => {
    const repo = enriched("useful-underdog");
    const info = extractInstall(repo, parseReadme(repo.readmeText));
    assert.match(info.command ?? "", /cargo install logline/);
  });

  test("the install claim contains only the command, not following prose", () => {
    const repo = enriched("high-quality-popular", {
      description: "Maps over promises concurrently",
      readmeText:
        "# p-map\n\nMaps over promises concurrently.\n\n" +
        "## Install\n\n```bash\nnpm install p-map\n```\n\n" +
        "The package ships prebuilt binaries for every platform.\n",
    });
    const info = extractInstall(repo, parseReadme(repo.readmeText));
    assert.equal(info.command, "npm install p-map");
    assert.ok(info.fact);
    assert.match(info.fact.claim, /npm install p-map\.$/);
    assert.ok(!/prebuilt binaries/.test(info.fact.claim));
  });

  test("a README with no install section produces no install fact", () => {
    const repo = enriched("high-quality-popular", {
      readmeText:
        "# Project\n\nThis project formats tabular text files and has no setup section at all. " +
        "It is described here so the extractor has something to read.\n",
    });
    const info = extractInstall(repo, parseReadme(repo.readmeText));
    assert.equal(info.fact, null);
    assert.equal(info.spoken, "");
  });
});

describe("narratable facts", () => {
  test("low-confidence facts are filtered out", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    assert.ok(narratableFacts(ledger).length <= ledger.facts.length);
    assert.ok(narratableFacts(ledger).every(fact => fact.confidence >= 0.5));
  });
});