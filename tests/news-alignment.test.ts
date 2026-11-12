import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { toAlignmentReport, confidentCoverage } from "../src/channels/news/alignment.js";

const synthetic = {
  alignmentSource: "faster_whisper_fallback",
  modelVersion: "faster-whisper base.en (CTranslate2)",
  tokensTotal: 10,
  tokensAligned: 9,
  coverage: 0.9,
  monotonic: true,
  chunkBoundaryViolations: 0,
  missingWords: ["chip"],
  words: Array.from({ length: 10 }, (_, i) => ({
    word: `w${i}`, startMs: i * 300, endMs: i * 300 + 250, confidence: i < 8 ? 0.9 : 0.2,
  })),
};

describe("alignment report — parser and invariants", () => {
  test("parses fallback report honestly", () => {
    const report = toAlignmentReport(synthetic);
    assert.equal(report.alignmentSource, "faster_whisper_fallback");
    assert.equal(report.coverage, 0.9);
    assert.equal(report.missingWords[0], "chip");
  });

  test("non-monotonic report is rejected loudly", () => {
    assert.throws(() => toAlignmentReport({ ...synthetic, monotonic: false }), /monotonicity/);
  });

  test("confident coverage blends per-word confidence", () => {
    const report = toAlignmentReport(synthetic);
    const c = confidentCoverage(report);
    assert.ok(c > 0.7 && c < 1);
  });
});
