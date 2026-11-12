import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { NewsHistory } from "../src/channels/news/history.js";

describe("news persistence — versioned, additive, safe", () => {
  test("migrations apply on a pristine DB and are idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "news-db-"));
    const dbPath = path.join(dir, "test.db");
    const h1 = new NewsHistory(dbPath);
    assert.ok(h1.migrationNotes.some(n => n.startsWith("migration:1")));
    h1.close();

    const backup = (await fs.readdir(dir)).filter(f => f.includes("pre-news"));
    assert.ok(backup.length >= 1, "timestamped backup was written");

    const h2 = new NewsHistory(dbPath); // second open: no re-migration
    assert.ok(!h2.migrationNotes.some(n => n.startsWith("migration:")));
    h2.close();
  });

  test("episode lifecycle round-trips", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "news-db-"));
    const dbPath = path.join(dir, "test.db");
    const h = new NewsHistory(dbPath);
    h.recordCandidate("story_x", "https://example.com/x", "Test story", "ai", "fp_x", "{}");
    h.createEpisode("run_1", "story_x", "https://example.com/x", "Test story", "ai");
    h.markEpisodeStatus("run_1", "completed");
    assert.ok(h.excludedStoryFingerprints().size === 0); // only completed candidates are excluded
    h.close();
  });
});
