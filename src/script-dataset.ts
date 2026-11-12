/**
 * The script dataset — every narration script both pipelines ever generate,
 * saved as-is with full provenance, separately per channel.
 *
 * Why: temp/<run-*>/ holds the script for one run and is treated as scratch.
 * But a script is reusable content — for compilation videos (twenty repo
 * showcases back-to-back), for re-voicing, for A/B testing styles, for
 * auditing what the model actually said. The dataset makes the script a
 * first-class, indexed, on-disk artifact instead of a transient byproduct.
 *
 * Layout (repo root; override with SHOWCASE_DATASET_DIR):
 *
 *   dataset/
 *   ├── README.md            committed index of the format
 *   ├── github/<id>.json     one record per generated GitHub-channel script
 *   ├── github/index.jsonl   append-only index (one line per record, upserted by id)
 *   ├── news/<id>.json
 *   └── news/index.jsonl
 *
 * `<id>` is `<slug>-<runId>`, identical to the run's temp dir and output
 * filename (e.g. `sindresorhus-p-map-1dbcce98` → `output/sindresorhus-p-map-1dbcce98.mp4`).
 *
 * Two phases per run (upsert by id, so the second write updates the first):
 *   1. `pending`   — the script is final (post-validation/post-approval) but
 *                    audio has not been measured yet.
 *   2. `completed` — measured timeline known (durationMs, coverage, …),
 *                    optionally the output MP4 path.
 * A run that dies before phase 2 leaves a `pending` record; a run whose TTS is
 * never reached leaves nothing (there is no script to save).
 *
 * Writes are atomic (temp sibling + rename). A corrupt existing record is
 * discarded and rewritten rather than poisoning the index. This module is
 * best-effort on purpose: dataset failures are logged, never thrown —
 * persisting is archival, never load-bearing for the pipeline.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export type DatasetChannel = "github" | "news";
export type DatasetPhase = "pending" | "completed";

export type ScriptDatasetRecord = {
  version: 1;
  id: string;
  channel: DatasetChannel;
  phase: DatasetPhase;
  /** Repository full name or story headline. */
  title: string;
  /** Canonical URL: github.com/owner/name or the story URL. */
  subject: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  /** How the run was launched: explicit repo/story or discovery (+mode/topic). */
  invocation?: { kind: "repo" | "discover" | "url"; detail?: string | null };
  /** The script exactly as it will be spoken: every segment, word budget and all. */
  script: {
    /** NarrationPlan segments (GitHub) or NewsSegment lines (news), verbatim. */
    segments: unknown[];
    estimatedWords?: number;
    estimatedSeconds?: number | null;
    styleVariant?: string;
    angle?: string;
    /** LLM model + token usage when the Groq writer was used. */
    llm?: { model: string; usage?: unknown; retries?: number };
  };
  /** GitHub only: the typed fact ledger the script was grounded on. */
  facts?: { ledger?: unknown };
  /** GitHub only: discovery selection detail (mode/score breakdown). */
  selection?: unknown;
  /** Measured audio (filled in at phase 2). */
  alignment?: {
    durationMs: number;
    sampleRate?: number;
    coverage?: number;
    alignmentSource?: string;
  };
  /** Human gates, news only (A = facts, B = script + voice). */
  approvals?: { gateA?: boolean; gateB?: boolean };
  /** Output MP4 path relative to the repo root, when the run produced one. */
  output?: string;
};

export type DatasetIndexEntry = Pick<
  ScriptDatasetRecord,
  "id" | "channel" | "phase" | "title" | "subject" | "createdAt" | "runId" | "output"
>;

export class ScriptDatasetError extends Error {
  override name = "ScriptDatasetError";
}

const root = (override?: string): string =>
  override ?? process.env.SHOWCASE_DATASET_DIR ?? path.join(process.cwd(), "dataset");

const channelDir = (r: string, channel: DatasetChannel): string => path.join(r, channel);

const recordPath = (r: string, channel: DatasetChannel, id: string): string =>
  path.join(channelDir(r, channel), `${id}.json`);

const indexPath = (r: string, channel: DatasetChannel): string =>
  path.join(channelDir(r, channel), "index.jsonl");

/** Reject ids that escape the channel folder (defence in depth for CLI callers). */
function assertSafeId(id: string): void {
  if (!id || /[/\\]|[.]{2,}/.test(id)) {
    throw new ScriptDatasetError(`unsafe dataset id: ${JSON.stringify(id)}`);
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
  try {
    if (fsSync.existsSync(temp)) await fs.unlink(temp);
  } catch {
    /* stale temp files are harmless */
  }
}

async function readExisting(file: string): Promise<ScriptDatasetRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as ScriptDatasetRecord;
    if (parsed?.version === 1 && parsed.id === path.basename(file, ".json")) return parsed;
    return null;
  } catch {
    return null; // corrupt record: start fresh, the index gets rewritten from it
  }
}

/** Create or update a record (upsert by id; phase transitions pending → completed). */
export async function saveDatasetRecord(
  input: Omit<ScriptDatasetRecord, "version" | "createdAt" | "updatedAt"> &
    Partial<Pick<ScriptDatasetRecord, "createdAt">>,
  datasetDirOverride?: string
): Promise<ScriptDatasetRecord> {
  const dir = root(datasetDirOverride);
  assertSafeId(input.id);
  const channel = input.channel;
  await fs.mkdir(channelDir(dir, channel), { recursive: true });

  const now = new Date().toISOString();
  const existing = await readExisting(recordPath(dir, channel, input.id));
  const record: ScriptDatasetRecord = {
    ...existing, // keep fields the later phase doesn't re-supply (e.g. facts)
    ...input,
    version: 1,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
    // Phase can only ratchet forward; a completed record never goes back to pending.
    phase:
      existing?.phase === "completed" && input.phase === "pending"
        ? existing.phase
        : input.phase,
  } as ScriptDatasetRecord;

  const file = recordPath(dir, channel, input.id);
  await atomicWrite(file, JSON.stringify(record, null, 2));
  await upsertIndex(dir, record);
  return record;
}

/** Merge a patch into an existing record (keeps everything not in the patch). */
export async function updateDatasetRecord(
  channel: DatasetChannel,
  id: string,
  patch: Partial<ScriptDatasetRecord>,
  datasetDirOverride?: string
): Promise<ScriptDatasetRecord> {
  assertSafeId(id);
  const dir = root(datasetDirOverride);
  const existing = await readExisting(recordPath(dir, channel, id));
  if (!existing) {
    throw new ScriptDatasetError(`no dataset record for ${channel}/${id}`);
  }
  return saveDatasetRecord({ ...existing, ...patch, id, channel }, dir);
}

/** Read a record back; `null` when absent/corrupt. */
export async function getDatasetRecord(
  channel: DatasetChannel,
  id: string,
  datasetDirOverride?: string
): Promise<ScriptDatasetRecord | null> {
  assertSafeId(id);
  return readExisting(recordPath(root(datasetDirOverride), channel, id));
}

/** Every record's index line, newest last. */
export async function listDatasetRecords(
  channel: DatasetChannel,
  datasetDirOverride?: string
): Promise<DatasetIndexEntry[]> {
  const file = indexPath(root(datasetDirOverride), channel);
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as DatasetIndexEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

async function upsertIndex(dir: string, record: ScriptDatasetRecord): Promise<void> {
  const file = indexPath(dir, record.channel);
  let entries: DatasetIndexEntry[] = [];
  try {
    const text = await fs.readFile(file, "utf8");
    entries = text
      .split("\n")
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as DatasetIndexEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      entries = []; // corrupt index is rewritten from the live records
    }
  }
  const entry: DatasetIndexEntry = {
    id: record.id,
    channel: record.channel,
    phase: record.phase,
    title: record.title,
    subject: record.subject,
    createdAt: record.createdAt,
    runId: record.runId,
    ...(record.output ? { output: record.output } : {}),
  };
  const index = entries.filter(e => e.id !== record.id);
  index.push(entry);
  index.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await atomicWrite(file, index.map(e => JSON.stringify(e)).join("\n") + "\n");
}
