import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStore, canonicalFullName } from "../src/history.js";
import { MAX_ATTEMPTS } from "../src/config.js";

function freshStore(): { store: HistoryStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-history-test-"));
  return { store: new HistoryStore(path.join(dir, "history.db")), dir };
}

function seed(store: HistoryStore, nodeId: string, fullName: string) {
  store.upsertRepository({
    nodeId,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    stars: 100,
    pushedAt: new Date().toISOString(),
  });
}

describe("history store", () => {
  test("persists across instances instead of losing state", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    store.completeRepository("N1", "output/one.mp4");
    store.close();

    const reopened = new HistoryStore(path.join(dir, "history.db"));
    assert.equal(reopened.getRepository("N1")?.status, "completed");
    assert.ok(reopened.completedFullNames().includes("acme/one"));
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a completed repository is never selected again", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    store.completeRepository("N1", "output/one.mp4");
    assert.equal(store.reserveRepository("N1", "run-1"), null);
    assert.ok(store.excludedFullNames().has("acme/one"));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a completed repository is excluded by canonical name too", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "Acme/One");
    store.completeRepository("N1", "output/one.mp4");
    assert.equal(canonicalFullName("ACME/ONE"), "acme/one");
    assert.ok(store.excludedFullNames().has("acme/one"));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("only one run can reserve a repository", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    const first = store.reserveRepository("N1", "run-1");
    const second = store.reserveRepository("N1", "run-2");
    assert.ok(first);
    assert.equal(second, null, "the second reservation must fail");
    assert.equal(store.getRepository("N1")?.status, "processing");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("failure is distinct from completion and stays retryable", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    store.reserveRepository("N1", "run-1");
    store.failRepository("N1", "render", new Error("ffmpeg exploded"));

    const row = store.getRepository("N1");
    assert.equal(row?.status, "failed");
    assert.equal(row?.completed_at, null);
    assert.equal(row?.last_error_stage, "render");
    assert.match(row?.last_error ?? "", /ffmpeg exploded/);

    const retry = store.reserveRepository("N1", "run-2");
    assert.ok(retry, "a failed attempt may be retried");
    assert.equal(retry?.attempt_count, 2);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("retries stop at the attempt budget and the repository is excluded", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      assert.ok(store.reserveRepository("N1", `run-${attempt}`));
      store.failRepository("N1", "tts", new Error("nope"));
    }
    assert.equal(store.reserveRepository("N1", "run-final"), null);
    assert.ok(store.excludedFullNames().has("acme/one"));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("stale processing reservations are reclaimed", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    store.reserveRepository("N1", "crashed-run");

    const longAfter = new Date(Date.now() + 60 * 60 * 1000);
    const reclaimed = store.reclaimStaleReservations(longAfter);
    assert.equal(reclaimed, 1);
    assert.equal(store.getRepository("N1")?.status, "failed");
    assert.equal(store.getRepository("N1")?.last_error_stage, "interrupted");
    assert.ok(store.reserveRepository("N1", "fresh-run"));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an API failure never marks a repository complete", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    try {
      throw new Error("GitHub request failed (403)");
    } catch (error) {
      store.failRepository("N1", "discovery", error);
    }
    assert.equal(store.getRepository("N1")?.completed_at, null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("star snapshots are dated and ordered", () => {
    const { store, dir } = freshStore();
    seed(store, "N1", "acme/one");
    store.recordStars("N1", 100, new Date("2026-01-01T00:00:00Z"));
    store.recordStars("N1", 130, new Date("2026-01-08T00:00:00Z"));
    const snapshots = store.snapshotsFor("N1");
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].stars, 100);
    assert.equal(snapshots[0].captured_at, "2026-01-01T00:00:00.000Z");
    assert.equal(snapshots[1].stars, 130);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("run rows record stage and outcome", () => {
    const { store, dir } = freshStore();
    store.startRun("run-1");
    store.setRunStage("run-1", "tts");
    store.finishRun("run-1", "succeeded", { outputPath: "output/x.mp4" });
    const row = store.getRepository("N1");
    assert.equal(row, null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});