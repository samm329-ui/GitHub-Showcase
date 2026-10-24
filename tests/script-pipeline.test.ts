import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildFactLedger } from "../src/facts.js";
import { composeScript } from "../src/script-composer.js";
import { evaluateScriptability } from "../src/scriptability.js";
import { evaluateScriptQuality } from "../src/script-quality.js";
import { segmentSpokenText, validateScript } from "../src/narration.js";
import { pauseSchedule, toTimedChunks, type SynthesizedChunk } from "../src/voice.js";
import { fixtureNames, enriched } from "./helpers.js";

/**
 * End-to-end regression for the production script pipeline:
 * ledger -> scriptability -> graph path -> composed plan -> both gates -> TTS.
 *
 * The invariant that matters: the plan the quality report describes, the plan
 * the structural validator clears and the plan the TTS stage consumes are the
 * *same object*. A passing report may never describe a different script from
 * the one that ships.
 */

const SCRIPTABLE = ["high-quality-popular", "useful-underdog", "no-license"];

describe("script pipeline", () => {
  test("the quality-evaluated script is the exact script TTS receives", () => {
    for (const name of SCRIPTABLE) {
      const repo = enriched(name);
      const ledger = buildFactLedger(repo);
      const { plan } = composeScript(ledger, repo);

      const validation = validateScript(plan, ledger);
      assert.ok(validation.ok, `${name}: ${validation.errors.join("; ")}`);

      const quality = evaluateScriptQuality(plan, ledger);
      assert.ok(quality.ok, `${name}: ${quality.hardFailures.join("; ")}`);

      // Both gates measured the same words TTS will speak.
      const spoken = plan.segments.map(segment => segment.spokenText).join(" ");
      assert.equal(validation.words, quality.wordCount, `${name}: word counts agree`);
      assert.equal(
        quality.wordCount,
        spoken.split(/\s+/).filter(Boolean).length,
        `${name}: the measured words are the spoken words`
      );

      // Every segment survives the speech-only normalisation TTS applies.
      for (const segment of plan.segments) {
        const speech = segmentSpokenText(segment);
        assert.ok(speech.trim().length > 0, `${name}/${segment.id} speaks`);
      }
    }
  });

  test("the pause schedule handed to audio equals the one handed to the timeline", () => {
    const repo = enriched("high-quality-popular");
    const ledger = buildFactLedger(repo);
    const { plan } = composeScript(ledger, repo);
    const chunks: SynthesizedChunk[] = plan.segments.map((segment, index) => ({
      index,
      segmentId: segment.id,
      file: `/tmp/chunk-${index}.wav`,
      text: segment.spokenText,
      durationMs: 2000,
      sampleRate: 24000,
      channels: 1,
      startMs: 0,
      endMs: 2000,
      hasPhonemeTimings: false,
    }));
    const schedule = pauseSchedule(chunks.length, plan.segments, 120);
    const timed = toTimedChunks(chunks, plan.segments);
    for (let index = 1; index < timed.length; index += 1) {
      assert.equal(
        timed[index].startMs - timed[index - 1].endMs,
        schedule[index],
        `gap before chunk ${index} matches the shared schedule`
      );
    }
    // No trailing silence: the timeline ends where the last chunk ends.
    const last = timed[timed.length - 1];
    assert.equal(
      last.endMs,
      timed.reduce((sum, chunk) => sum + chunk.durationMs, 0) +
        schedule.reduce((sum, pause) => sum + pause, 0)
    );
  });

  test("an unscriptable repository is rejected with explicit reasons", () => {
    for (const name of ["abandoned", "fork", "empty-readme", "badge-only"]) {
      const repo = enriched(name);
      const ledger = buildFactLedger(repo);
      const report = evaluateScriptability(repo, ledger);
      assert.equal(report.ok, false, `${name} must not pass the gate`);
      assert.ok(report.missing.length > 0, `${name} reports what is missing`);
      for (const reason of report.missing) {
        assert.ok(reason.trim().length > 0);
      }
    }
  });

  test("every scriptable fixture produces a validating, quality-passing script", () => {
    for (const name of fixtureNames()) {
      const repo = enriched(name);
      const ledger = buildFactLedger(repo);
      const report = evaluateScriptability(repo, ledger);
      if (!report.ok) continue;
      const { plan } = composeScript(ledger, repo);
      const validation = validateScript(plan, ledger);
      const quality = evaluateScriptQuality(plan, ledger);
      assert.ok(validation.ok, `${name}: ${validation.errors.join("; ")}`);
      assert.ok(quality.ok, `${name}: ${quality.hardFailures.join("; ")}`);
      assert.ok(plan.segments.length >= 3, `${name}: a real explanation has depth`);
    }
  });

  test("every spoken claim is traceable to a cited fact", () => {
    for (const name of SCRIPTABLE) {
      const repo = enriched(name);
      const ledger = buildFactLedger(repo);
      const { plan } = composeScript(ledger, repo);
      const known = new Set(ledger.facts.map(fact => fact.id));
      for (const segment of plan.segments) {
        assert.ok(segment.factIds.length > 0, `${name}/${segment.id} cites something`);
        for (const id of segment.factIds) {
          assert.ok(known.has(id), `${name}/${segment.id} cites ${id}`);
        }
      }
    }
  });
});
