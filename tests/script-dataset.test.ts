import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  saveDatasetRecord,
  updateDatasetRecord,
  getDatasetRecord,
  listDatasetRecords,
  ScriptDatasetError,
} from "../src/script-dataset.js";

function tempDataset(): string {
  return mkdtempSync(path.join(tmpdir(), "showcase-dataset-"));
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: "owner-repo-abcd1234",
    channel: "github" as const,
    phase: "pending" as const,
    title: "owner/repo",
    subject: "https://github.com/owner/repo",
    runId: "abcd1234",
    script: {
      segments: [{ id: "s1", spokenText: "hello world" }],
      estimatedWords: 100,
    },
    ...overrides,
  };
}

describe("script dataset", () => {
  test("pending → completed ratchets the phase and merges across phases", async () => {
    const dir = tempDataset();
    const first = await saveDatasetRecord(
      base({ facts: { ledger: { claims: 7 } } }),
      dir
    );
    assert.equal(first.phase, "pending");
    assert.equal((first.facts?.ledger as { claims: number }).claims, 7);

    const second = await saveDatasetRecord(
      base({
        phase: "completed",
        alignment: { durationMs: 35420, sampleRate: 24000 },
        output: "output/owner-repo-abcd1234.mp4",
      }),
      dir
    );
    // Earlier-phase fields survive the merge; new fields land.
    assert.equal(second.phase, "completed");
    assert.equal(
      (second.facts?.ledger as { claims: number }).claims,
      7,
      "facts from phase 1 are kept"
    );
    assert.equal(second.alignment?.durationMs, 35420);
    assert.equal(second.output, "output/owner-repo-abcd1234.mp4");
    assert.equal(second.createdAt, first.createdAt, "createdAt is stable across phases");

    // Ratchet: a phase-2 record is never downgraded by a late phase-1 write.
    const third = await saveDatasetRecord(base(), dir);
    assert.equal(third.phase, "completed");
  });

  test("index.jsonl upserts one line per id and stays valid JSONL", async () => {
    const dir = tempDataset();
    await saveDatasetRecord(base(), dir);
    await saveDatasetRecord(base({ phase: "completed" }), dir);
    await saveDatasetRecord(base(), dir);

    const index = readFileSync(path.join(dir, "github", "index.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    assert.equal(index.length, 1, "one line per id, even across phases");
    assert.equal(index[0].id, "owner-repo-abcd1234");
    assert.equal(index[0].phase, "completed");
    assert.equal(index[0].title, "owner/repo");

    const listed = await listDatasetRecords("github", dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "owner-repo-abcd1234");
  });

  test("github and news datasets live in separate folders and indexes", async () => {
    const dir = tempDataset();
    await saveDatasetRecord(base({ channel: "github" }), dir);
    await saveDatasetRecord(
      base({ channel: "news", title: "story headline", subject: "https://example.com/story" }),
      dir
    );

    assert.ok(existsSync(path.join(dir, "github", "owner-repo-abcd1234.json")));
    assert.ok(existsSync(path.join(dir, "news", "owner-repo-abcd1234.json")));

    const github = await listDatasetRecords("github", dir);
    const news = await listDatasetRecords("news", dir);
    assert.equal(github.length, 1);
    assert.equal(news.length, 1);
    assert.equal(news[0].title, "story headline");
    assert.equal(github[0].channel, "github");
    assert.equal(news[0].channel, "news");
  });

  test("a corrupt record is replaced rather than propagated", async () => {
    const dir = tempDataset();
    await saveDatasetRecord(base(), dir);
    const file = path.join(dir, "github", "owner-repo-abcd1234.json");
    writeFileSync(file, "{ not json", "utf8");

    const record = await saveDatasetRecord(base({ phase: "completed" }), dir);
    assert.equal(record.phase, "completed");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.version, 1);
  });

  test("atomic writes leave no temp siblings behind", async () => {
    const dir = tempDataset();
    await saveDatasetRecord(base(), dir);
    await saveDatasetRecord(base({ phase: "completed" }), dir);
    const leftovers = readdirSync(path.join(dir, "github")).filter(
      name => !name.endsWith(".json") && name !== "index.jsonl"
    );
    assert.deepEqual(leftovers, []);
  });

  test("an unsafe id is rejected", async () => {
    const dir = tempDataset();
    await assert.rejects(
      () => saveDatasetRecord(base({ id: "../escape" }), dir),
      ScriptDatasetError
    );
    await assert.rejects(
      () => getDatasetRecord("github", "a/b", dir),
      ScriptDatasetError
    );
  });

  test("listDatasetRecords on a missing dataset returns []", async () => {
    const dir = tempDataset();
    assert.deepEqual(await listDatasetRecords("news", dir), []);
    assert.equal(await getDatasetRecord("news", "nothing-here", dir), null);
  });

  test("updateDatasetRecord throws for an unknown id", async () => {
    const dir = tempDataset();
    await assert.rejects(
      () => updateDatasetRecord("github", "nope-00000000", { output: "x.mp4" }, dir),
      ScriptDatasetError
    );
  });

  test("list returns records oldest-first", async () => {
    const dir = tempDataset();
    const older = new Date("2026-01-01T00:00:00Z").toISOString();
    const newer = new Date("2026-06-01T00:00:00Z").toISOString();
    await saveDatasetRecord(base({ id: "b-b-bbbbbbbb", createdAt: newer }), dir);
    await saveDatasetRecord(base({ id: "a-a-aaaaaaaaaa", createdAt: older }), dir);
    const listed = await listDatasetRecords("github", dir);
    assert.equal(listed[0].id, "a-a-aaaaaaaaaa");
    assert.equal(listed[1].id, "b-b-bbbbbbbb");
  });
});
