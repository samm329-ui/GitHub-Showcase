import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ALLOW_REVISIT_AFTER_DAYS,
  DB_PATH,
  MAX_ATTEMPTS,
  RESERVATION_TIMEOUT_MINUTES,
} from "./config.js";

/**
 * Persistent repository history.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) so the project gains a real
 * store without adding a native dependency.
 *
 * Guarantees:
 *  - A repository is *reserved* atomically before any expensive work starts, so
 *    two concurrent runs cannot pick the same repository.
 *  - A repository is only marked `completed` after the MP4 passed QA.
 *  - `failed` is distinct from `completed` and is retryable up to
 *    `attemptCount < MAX_ATTEMPTS`.
 *  - `processing` rows older than the reservation timeout are reclaimed.
 */

export type RepositoryStatus =
  | "discovered"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

export type RepositoryRow = {
  node_id: string;
  canonical_full_name: string;
  html_url: string;
  first_seen_at: string;
  last_seen_at: string;
  first_stars: number | null;
  latest_stars: number | null;
  latest_pushed_at: string | null;
  status: RepositoryStatus;
  completed_at: string | null;
  video_path: string | null;
  run_id: string | null;
  reserved_at: string | null;
  last_error_stage: string | null;
  last_error: string | null;
  attempt_count: number;
  script_hash: string | null;
  metadata_json: string | null;
};

export type SnapshotRow = { node_id: string; captured_at: string; stars: number };

export type RunRow = {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed";
  stage: string | null;
  repository_node_id: string | null;
  output_path: string | null;
  error_json: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  node_id TEXT PRIMARY KEY,
  canonical_full_name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_stars INTEGER,
  latest_stars INTEGER,
  latest_pushed_at TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  completed_at TEXT,
  video_path TEXT,
  run_id TEXT,
  reserved_at TEXT,
  last_error_stage TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  script_hash TEXT,
  metadata_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_full_name_lower
  ON repositories(lower(canonical_full_name));
CREATE TABLE IF NOT EXISTS star_snapshots (
  node_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  stars INTEGER NOT NULL,
  PRIMARY KEY (node_id, captured_at)
);
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  stage TEXT,
  repository_node_id TEXT,
  output_path TEXT,
  error_json TEXT
);
`;

/** node:sqlite is flagged experimental on some Node builds; silence only that. */
let sqliteWarningPatched = false;
function silenceSqliteWarning(): void {
  if (sqliteWarningPatched) return;
  sqliteWarningPatched = true;
  const existing = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", warning => {
    if (String(warning?.message ?? warning).includes("SQLite is an experimental feature")) {
      return;
    }
    for (const listener of existing) listener(warning);
  });
}

export function canonicalFullName(fullName: string): string {
  return fullName.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

export class HistoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    silenceSqliteWarning();
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /* ----------------------------- runs ----------------------------- */

  startRun(runId: string): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (run_id, started_at, status, stage)
         VALUES (?, ?, 'running', 'setup')
         ON CONFLICT(run_id) DO NOTHING`
      )
      .run(runId, new Date().toISOString());
  }

  setRunStage(runId: string, stage: string): void {
    this.db
      .prepare(`UPDATE pipeline_runs SET stage = ? WHERE run_id = ?`)
      .run(stage, runId);
  }

  finishRun(
    runId: string,
    status: "succeeded" | "failed",
    fields: {
      stage?: string;
      repositoryNodeId?: string | null;
      outputPath?: string | null;
      error?: unknown;
    } = {}
  ): void {
    this.db
      .prepare(
        `UPDATE pipeline_runs
            SET finished_at = ?, status = ?, stage = COALESCE(?, stage),
                repository_node_id = COALESCE(?, repository_node_id),
                output_path = COALESCE(?, output_path),
                error_json = COALESCE(?, error_json)
          WHERE run_id = ?`
      )
      .run(
        new Date().toISOString(),
        status,
        fields.stage ?? null,
        fields.repositoryNodeId ?? null,
        fields.outputPath ?? null,
        fields.error === undefined
          ? null
          : JSON.stringify(fields.error, null, 2),
        runId
      );
  }

  /* -------------------------- repositories ------------------------ */

  /**
   * Record that a repository exists. Returns the stored row so callers can
   * inspect the current status without a second query.
   */
  upsertRepository(input: {
    nodeId: string;
    fullName: string;
    htmlUrl: string;
    stars?: number | null;
    pushedAt?: string | null;
    metadata?: unknown;
  }): RepositoryRow {
    const now = new Date().toISOString();
    const canonical = canonicalFullName(input.fullName);
    this.db
      .prepare(
        `INSERT INTO repositories
           (node_id, canonical_full_name, html_url, first_seen_at, last_seen_at,
            first_stars, latest_stars, latest_pushed_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           latest_stars = COALESCE(excluded.latest_stars, repositories.latest_stars),
           latest_pushed_at = COALESCE(excluded.latest_pushed_at, repositories.latest_pushed_at),
           metadata_json = COALESCE(excluded.metadata_json, repositories.metadata_json)`
      )
      .run(
        input.nodeId,
        canonical,
        input.htmlUrl,
        now,
        now,
        input.stars ?? null,
        input.stars ?? null,
        input.pushedAt ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata)
      );
    return this.getRepository(input.nodeId)!;
  }

  getRepository(nodeId: string): RepositoryRow | null {
    const row = this.db
      .prepare(`SELECT * FROM repositories WHERE node_id = ?`)
      .get(nodeId) as RepositoryRow | undefined;
    return row ?? null;
  }

  /** Find by canonical `owner/repo`, independent of the stored node id. */
  getRepositoryByFullName(fullName: string): RepositoryRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM repositories WHERE lower(canonical_full_name) = ?`
      )
      .get(canonicalFullName(fullName)) as RepositoryRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically move a repository into `processing`. Returns `null` when the
   * repository is already completed, already reserved by a live run, or has
   * exhausted its retry budget — which is exactly what "cannot select" means.
   */
  reserveRepository(
    nodeId: string,
    runId: string,
    options: { force?: boolean } = {}
  ): RepositoryRow | null {
    this.reclaimStaleReservations();
    const existing = this.getRepository(nodeId);
    if (!existing) return null;
    if (!options.force) {
      if (existing.status === "completed" && !this.revisitAllowed(existing.completed_at)) {
        return null;
      }
      if (existing.status === "processing") return null;
      if (existing.attempt_count >= MAX_ATTEMPTS) return null;
    }

    const result = this.db
      .prepare(
        `UPDATE repositories
            SET status = 'processing', run_id = ?, reserved_at = ?,
                attempt_count = attempt_count + 1
          WHERE node_id = ?
            AND (status != 'processing' OR ? = 1)
            AND (status != 'completed' OR ? = 1)`
      )
      .run(
        runId,
        new Date().toISOString(),
        nodeId,
        options.force ? 1 : 0,
        options.force || this.revisitAllowed(existing.completed_at) ? 1 : 0
      );
    if (result.changes !== 1) return null;
    return this.getRepository(nodeId);
  }

  private revisitAllowed(completedAt: string | null): boolean {
    if (ALLOW_REVISIT_AFTER_DAYS === null) return false;
    if (!completedAt) return true;
    return Date.now() - Date.parse(completedAt) >= ALLOW_REVISIT_AFTER_DAYS * 86400000;
  }

  completeRepository(nodeId: string, videoPath: string, scriptHash?: string): void {
    this.db
      .prepare(
        `UPDATE repositories
            SET status = 'completed', completed_at = ?, video_path = ?,
                run_id = NULL, reserved_at = NULL, last_error = NULL,
                last_error_stage = NULL, script_hash = ?
          WHERE node_id = ?`
      )
      .run(new Date().toISOString(), videoPath, scriptHash ?? null, nodeId);
  }

  failRepository(nodeId: string, stage: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(
        `UPDATE repositories
            SET status = 'failed', run_id = NULL, reserved_at = NULL,
                last_error_stage = ?, last_error = ?
          WHERE node_id = ?`
      )
      .run(stage, message.slice(0, 2000), nodeId);
  }

  /** Free a reservation without recording a failure (e.g. run aborted). */
  releaseRepository(nodeId: string): void {
    this.db
      .prepare(
        `UPDATE repositories
            SET status = CASE WHEN status = 'processing' THEN 'discovered' ELSE status END,
                run_id = NULL, reserved_at = NULL
          WHERE node_id = ?`
      )
      .run(nodeId);
  }

  /** Mark reservations whose run died as `failed` so they can be retried. */
  reclaimStaleReservations(now = new Date()): number {
    const cutoff = new Date(
      now.getTime() - RESERVATION_TIMEOUT_MINUTES * 60000
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE repositories
            SET status = 'failed',
                last_error_stage = 'interrupted',
                last_error = 'Reservation expired; the owning run never finished.',
                run_id = NULL, reserved_at = NULL
          WHERE status = 'processing'
            AND (reserved_at IS NULL OR reserved_at < ?)`
      )
      .run(cutoff);
    return Number(result.changes);
  }

  /** Canonical full names that must never be auto-selected again. */
  excludedFullNames(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT canonical_full_name, status, attempt_count, completed_at
           FROM repositories`
      )
      .all() as Pick<
      RepositoryRow,
      "canonical_full_name" | "status" | "attempt_count" | "completed_at"
    >[];
    const excluded = new Set<string>();
    for (const row of rows) {
      if (row.status === "processing") {
        excluded.add(row.canonical_full_name);
      } else if (row.status === "completed") {
        if (!this.revisitAllowed(row.completed_at)) {
          excluded.add(row.canonical_full_name);
        }
      } else if (row.status === "failed" && row.attempt_count >= MAX_ATTEMPTS) {
        excluded.add(row.canonical_full_name);
      }
    }
    return excluded;
  }

  /* ------------------------ star snapshots ------------------------ */

  recordStars(nodeId: string, stars: number, capturedAt = new Date()): void {
    const iso = capturedAt.toISOString();
    this.db
      .prepare(
        `INSERT INTO star_snapshots (node_id, captured_at, stars)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id, captured_at) DO UPDATE SET stars = excluded.stars`
      )
      .run(nodeId, iso, stars);
  }

  snapshotsFor(nodeId: string): SnapshotRow[] {
    return this.db
      .prepare(
        `SELECT node_id, captured_at, stars FROM star_snapshots
          WHERE node_id = ? ORDER BY captured_at ASC`
      )
      .all(nodeId) as SnapshotRow[];
  }

  /** Completed repository names, for the legacy `showcase-history.json`. */
  completedFullNames(): string[] {
    const rows = this.db
      .prepare(`SELECT canonical_full_name FROM repositories WHERE status = 'completed'`)
      .all() as { canonical_full_name: string }[];
    return rows.map(row => row.canonical_full_name);
  }
}
