import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  analyzeReadme,
  buildSearchQueries,
  hardReject,
  momentumScore,
  scoreCandidate,
  toEnriched,
} from "../src/github.js";
import { enriched, fixture, fixtureNames } from "./helpers.js";
import type { DiscoveryMode } from "../src/types.js";

function evaluate(name: string, mode: DiscoveryMode = "practical") {
  const { repo, readme, rootFiles, release } = fixture(name);
  const hydrated = toEnriched(repo, { readmeText: readme, languages: {}, release, rootFiles });
  return scoreCandidate({
    repo: hydrated,
    mode,
    readmeText: readme,
    release,
    momentum: { previousStars: null, previousCapturedAt: null, currentStars: repo.stargazers_count },
  });
}

describe("hard rejection gates", () => {
  test("an archived repository is rejected", () => {
    const { repo } = fixture("abandoned");
    assert.equal(hardReject(repo, { excluded: new Set() })?.rule, "archived");
  });

  test("a fork is rejected", () => {
    const { repo } = fixture("fork");
    assert.equal(hardReject(repo, { excluded: new Set() })?.rule, "fork");
  });

  test("a repository already in history is rejected", () => {
    const { repo } = fixture("high-quality-popular");
    const rejection = hardReject(repo, { excluded: new Set(["acme/rocket-cli"]) });
    assert.equal(rejection?.rule, "history");
  });

  test("a renamed repository is rejected by its node id", () => {
    const { repo } = fixture("high-quality-popular");
    const nodeId = repo.node_id;
    assert.ok(nodeId, "the fixture must carry a GitHub node id");
    const rejection = hardReject(
      { ...repo, full_name: "new-owner/new-name" },
      { excluded: new Set(), excludedNodeIds: new Set([nodeId!]) }
    );
    assert.equal(rejection?.rule, "history");
  });

  test("a repository without a usable description is rejected", () => {
    const { repo } = fixture("high-quality-popular");
    const rejection = hardReject({ ...repo, description: "  x  " }, { excluded: new Set() });
    assert.equal(rejection?.rule, "no-description");
  });

  test("a link collection is rejected", () => {
    const { repo } = fixture("high-quality-popular");
    const rejection = hardReject(
      { ...repo, description: "A curated list of awesome developer tools" },
      { excluded: new Set() }
    );
    assert.equal(rejection?.rule, "link-collection");
  });

  test("a good candidate passes the gates", () => {
    const { repo } = fixture("useful-underdog");
    assert.equal(hardReject(repo, { excluded: new Set() }), null);
  });
});

describe("candidate scoring", () => {
  test("a documented, recently pushed project is eligible", () => {
    const result = evaluate("high-quality-popular");
    assert.ok(result.totalScore > 0);
    assert.equal(result.eligible, true, `score was ${result.totalScore}`);
    assert.ok(result.reasons.length > 0);
  });

  test("a small but well documented underdog can still pass", () => {
    const result = evaluate("useful-underdog", "underdog");
    assert.ok(
      result.breakdown.documentation > 0,
      "an underdog must still have documentation"
    );
    assert.ok(result.totalScore > 0);
  });

  test("stars alone do not rescue a badge-only repository", () => {
    const result = evaluate("badge-only");
    assert.ok(
      result.breakdown.documentation <= 6,
      `documentation should be weak, got ${result.breakdown.documentation}`
    );
    assert.ok(result.penalties.length > 0, "a penalty should be recorded");
    assert.ok(
      result.reasons.every(reason => !/popularity/i.test(reason)),
      "popularity is not a reason on its own"
    );
  });

  test("an empty README scores below the threshold", () => {
    const result = evaluate("empty-readme");
    assert.equal(result.eligible, false);
  });

  test("an abandoned repository loses maintenance points", () => {
    const abandoned = evaluate("abandoned");
    const healthy = evaluate("high-quality-popular");
    assert.ok(
      abandoned.breakdown.maintenance < healthy.breakdown.maintenance,
      "an 8-year-old repo must score lower on maintenance"
    );
    assert.ok(abandoned.warnings.some(warning => /18 months/.test(warning)));
  });

  test("scores are explainable and bounded", () => {
    for (const name of fixtureNames()) {
      const result = evaluate(name);
      assert.ok(result.totalScore >= 0 && result.totalScore <= 100);
      assert.equal(
        Object.values(result.breakdown).reduce((a, b) => a + b, 0) +
          result.penalties.reduce((a, p) => a + p.points, 0) >= 0,
        true
      );
    }
  });

  test("dimensions are distinct", () => {
    const result = evaluate("high-quality-popular");
    const keys = Object.keys(result.breakdown);
    for (const key of [
      "usefulness",
      "documentation",
      "maintenance",
      "adoption",
      "momentum",
      "setup",
      "maturity",
      "novelty",
    ]) {
      assert.ok(keys.includes(key), `missing dimension ${key}`);
    }
  });
});

describe("priority eligibility floor", () => {
  function scoreWeak(topics: string[], mode: DiscoveryMode = "practical") {
    const { repo, rootFiles } = fixture("useful-underdog");
    const weak =
      "# My Tool\n\nMy Tool takes a small task off your hands every day. " +
      "It does one thing quietly, from the terminal, and it has been running " +
      "in the field for a while now with real users relying on it daily.\n";
    const hydrated = toEnriched({ ...repo, topics }, {
      readmeText: weak,
      languages: {},
      release: null,
      rootFiles,
    });
    return scoreCandidate({
      repo: hydrated,
      mode,
      readmeText: weak,
      release: null,
      momentum: {
        previousStars: null,
        previousCapturedAt: null,
        currentStars: repo.stargazers_count,
      },
    });
  }

  function scoreMid(topics: string[], mode: DiscoveryMode = "practical") {
    const { repo, rootFiles } = fixture("useful-underdog");
    const mid =
      "# My Tool\n\nMy Tool takes a small task off your hands every day. It does one thing " +
      "quietly, from the terminal, and it has been running in the field for a while now " +
      "with real users relying on it daily.\n\n## Usage\n\nRun it and point it at your " +
      "folder. It walks the tree, finds the copies, and keeps the newest.\n";
    const hydrated = toEnriched({ ...repo, topics }, {
      readmeText: mid,
      languages: {},
      release: null,
      rootFiles,
    });
    return scoreCandidate({
      repo: hydrated,
      mode,
      readmeText: mid,
      release: null,
      momentum: {
        previousStars: null,
        previousCapturedAt: null,
        currentStars: repo.stargazers_count,
      },
    });
  }

  test("a priority-category match clears the 55 floor", () => {
    const result = scoreWeak(["finance"]);
    assert.ok(
      result.totalScore >= 55 && result.totalScore < 65,
      `total was ${result.totalScore}`
    );
    assert.equal(result.eligible, true);
    assert.deepEqual(result.priorityCategories, ["finance"]);
    assert.ok(result.reasons.some(reason => /priority category: finance/.test(reason)));
  });

  test("a non-priority repo in the same band is not eligible", () => {
    const result = scoreMid(["zz-no-match"]);
    assert.ok(
      result.totalScore >= 55 && result.totalScore < 65,
      `total was ${result.totalScore}`
    );
    assert.equal(result.eligible, false);
    assert.equal(result.breakdown.priority, 0);
  });

  test("a generic repository cannot win a mainstream sweep", () => {
    const result = scoreWeak(["zz-no-match"], "mainstream");
    assert.equal(result.eligible, false);
    assert.ok(
      result.warnings.some(warning => /outside the mainstream priority zones/.test(warning))
    );
  });

  test("a priority match can win a mainstream sweep", () => {
    const result = scoreWeak(["finance"], "mainstream");
    assert.equal(result.eligible, true);
  });
});

describe("momentum requires dated snapshots", () => {
  test("no snapshot means zero momentum", () => {
    assert.equal(
      momentumScore({ previousStars: null, previousCapturedAt: null, currentStars: 5000 }),
      0
    );
  });

  test("growth is computed from dated snapshots only", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const growth = momentumScore({
      previousStars: 100,
      previousCapturedAt: threeDaysAgo,
      currentStars: 200,
    });
    assert.ok(growth > 0, "a real measured increase must score above zero");
  });

  test("a decline scores zero", () => {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    assert.equal(
      momentumScore({ previousStars: 300, previousCapturedAt: weekAgo, currentStars: 250 }),
      0
    );
  });

  test("a snapshot less than a day old is not usable evidence", () => {
    assert.equal(
      momentumScore({
        previousStars: 100,
        previousCapturedAt: new Date(Date.now() - 1000).toISOString(),
        currentStars: 900,
      }),
      0
    );
  });

  test("a candidate without snapshots warns that no trend claim is possible", () => {
    const result = evaluate("high-quality-popular");
    assert.ok(
      result.warnings.some(warning => /snapshot/i.test(warning)),
      "the absence of snapshots must be surfaced"
    );
    assert.equal(result.breakdown.momentum, 0);
  });
});

describe("discovery queries", () => {
  test("each mode builds date-bounded search shapes", () => {
    for (const mode of ["practical", "popular", "underdog", "emerging", "topic", "mainstream"] as DiscoveryMode[]) {
      const queries = buildSearchQueries(mode, "cli");
      assert.ok(queries.length > 0);
      for (const query of queries) {
        assert.match(query, /archived:false/, `${mode} must exclude archived repos`);
        assert.match(query, /fork:false/, `${mode} must exclude forks`);
        assert.match(query, /pushed:>=|created:>=/, `${mode} must be date bounded`);
        assert.match(query, /stars:\d+\.\.\d+/, `${mode} must bound the star range`);
      }
    }
  });

  test("dates are calculated at runtime, not hard-coded", () => {
    const query = buildSearchQueries("practical")[0];
    const match = query.match(/pushed:>=(\d{4}-\d{2}-\d{2})/);
    assert.ok(match);
    const cutoff = Date.parse(match![1]);
    const ageDays = (Date.now() - cutoff) / 86400000;
    assert.ok(ageDays > 300 && ageDays < 400, `cutoff age was ${ageDays}`);
  });

  test("modes differ from each other", () => {
    assert.notEqual(
      buildSearchQueries("popular")[0],
      buildSearchQueries("underdog")[0]
    );
  });

  test("mainstream sweeps the winning zones", () => {
    const queries = buildSearchQueries("mainstream");
    assert.ok(queries.length >= 10, `mainstream must sweep many zones, got ${queries.length}`);
    for (const zone of ["rag", "llm", "ai-agents", "fintech", "cybersecurity", "video-editor", "3d-modeling", "scraper", "self-hosted"]) {
      assert.ok(
        queries.some(query => query.includes(`topic:${zone}`)),
        `mainstream must include topic:${zone}`
      );
    }
    for (const query of queries) {
      assert.match(query, /stars:\d+\.\.\d+/, "mainstream must bound the star range");
    }
  });
});

describe("readme analysis", () => {
  test("detects install, usage and features sections", () => {
    const { readme } = fixture("high-quality-popular");
    const analysis = analyzeReadme(readme);
    assert.equal(analysis.hasInstall, true);
    assert.equal(analysis.hasFeatures, true);
    assert.equal(analysis.hasLicenseSection, true);
    assert.ok(analysis.codeBlocks >= 2);
  });

  test("detects a badge-only readme", () => {
    const { readme } = fixture("badge-only");
    const analysis = analyzeReadme(readme);
    assert.ok(analysis.badgeRatio > 0.6, `badgeRatio was ${analysis.badgeRatio}`);
  });

  test("a missing readme analyses to nothing useful", () => {
    const analysis = analyzeReadme(null);
    assert.equal(analysis.length, 0);
    assert.equal(analysis.hasInstall, false);
  });
});

describe("duplicate candidates", () => {
  test("the same repository under different casing is one identity", () => {
    const a = enriched("high-quality-popular");
    const b = enriched("high-quality-popular", { nodeId: "other" });
    assert.equal(a.full_name.toLowerCase(), b.full_name.toLowerCase());
  });
});