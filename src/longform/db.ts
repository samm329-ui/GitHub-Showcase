/**
 * Long-form history — separate database, never touches showcase-history.db
 * or news-history.db. Provides the permanent no-repeat ledger and
 * episode/reservation transactions.
 *
 * Guarantees (when the DB file is preserved):
 *  - UNIQUE(repository_node_id) on longform_repository_usage — a repository
 *    that was ever committed to an episode can never be selected again.
 *  - Selection + reservation + episode creation happen in ONE transaction,
 *    so two concurrent instances cannot reserve overlapping repositories.
 *  - A failed episode does NOT release its repositories.
 *  - Dry runs / preflight never reserve.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LONGFORM_DB_PATH } from "./config.js";
import type { EpisodeRecord, EpisodeRepositoryRecord, EpisodeStatus } from "./types.js";

const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "longform-baseline",
    sql: `
CREATE TABLE episodes (
  episode_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  stage TEXT,
  format TEXT NOT NULL DEFAULT '16:9',
  width INTEGER NOT NULL DEFAULT 1920,
  height INTEGER NOT NULL DEFAULT 1080,
  fps INTEGER NOT NULL DEFAULT 30,
  repository_count INTEGER NOT NULL DEFAULT 5,
  work_dir TEXT,
  output_path TEXT,
  error TEXT,
  error_stage TEXT,
  artifacts_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX episodes_status ON episodes(status);
CREATE TABLE episode_repositories (
  episode_id TEXT NOT NULL REFERENCES episodes(episode_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  dataset_record_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  selection_score REAL NOT NULL,
  selected_at TEXT NOT NULL,
  usage_status TEXT NOT NULL DEFAULT 'reserved',
  PRIMARY KEY (episode_id, node_id),
  UNIQUE (episode_id, rank)
);
CREATE INDEX episode_repositories_node ON episode_repositories(node_id);
CREATE TABLE longform_repository_usage (
  node_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  first_episode_id TEXT NOT NULL,
  first_used_at TEXT NOT NULL
);
`,
  },
];

export class LongformHistory {
  private db: DatabaseSync;
  private readonly filePath: string;

  constructor(dbPath: string = LONGFORM_DB_PATH) {
    this.filePath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    );
    const applied = new Map(
      (this.db
        .prepare("SELECT version, name FROM schema_migrations")
        .all() as Array<{ version: number; name: string }>).map(row => [row.version, row.name])
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const backup = `${this.filePath}.pre-migrate-${Date.now()}.db`;
      try {
        if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0) {
          fs.copyFileSync(this.filePath, backup);
        }
      } catch {
        /* backup is best-effort */
      }
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /* ---------------- usage ledger ---------------- */

  /** Every repository node_id ever committed to an episode. */
  usedNodeIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT node_id FROM longform_repository_usage")
      .all() as Array<{ node_id: string }>;
    return new Set(rows.map(row => row.node_id));
  }

  isUsed(nodeId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM longform_repository_usage WHERE node_id = ?")
      .get(nodeId) as { x: number } | undefined;
    return Boolean(row);
  }

  /**
   * Atomically reserve five repositories + create the episode + persist the
   * usage rows. Returns false when any repository is no longer available
   * (i.e. another instance committed first); in that case nothing is written.
   */
  reserveEpisode(input: {
    episodeId: string;
    runId: string;
    repositories: Array<{
      nodeId: string;
      fullName: string;
      datasetRecordId: string;
      rank: number;
      selectionScore: number;
    }>;
    workDir: string;
  }): EpisodeRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const repo of input.repositories) {
        const used = this.db
          .prepare("SELECT 1 AS x FROM longform_repository_usage WHERE node_id = ?")
          .get(repo.nodeId) as { x: number } | undefined;
        if (used) {
          throw new Error(`repository ${repo.fullName} (${repo.nodeId}) was already committed to a Long-form episode`);
        }
      }
      this.db
        .prepare(
          `INSERT INTO episodes
             (episode_id, run_id, status, stage, format, width, height, fps, repository_count,
              work_dir, created_at, updated_at)
           VALUES (?, ?, 'selection-committed', 'selection', '16:9', 1920, 1080, 30, ?, ?, ?, ?)`
        )
        .run(input.episodeId, input.runId, input.repositories.length, input.workDir, now, now);
      const insertRepo = this.db.prepare(
        `INSERT INTO episode_repositories
           (episode_id, node_id, full_name, dataset_record_id, rank, selection_score, selected_at, usage_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')`
      );
      const insertUsage = this.db.prepare(
        `INSERT INTO longform_repository_usage (node_id, full_name, first_episode_id, first_used_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const repo of input.repositories) {
        insertRepo.run(input.episodeId, repo.nodeId, repo.fullName, repo.datasetRecordId, repo.rank, repo.selectionScore, now);
        insertUsage.run(repo.nodeId, repo.fullName, input.episodeId, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getEpisode(input.episodeId)!;
  }

  /* ---------------- episodes ---------------- */

  getEpisode(episodeId: string): EpisodeRecord | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE episode_id = ?").get(episodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      episodeId: String(row.episode_id),
      runId: String(row.run_id),
      status: String(row.status) as EpisodeStatus,
      stage: row.stage == null ? null : String(row.stage),
      repositoryCount: Number(row.repository_count),
      workDir: row.work_dir == null ? null : String(row.work_dir),
      outputPath: row.output_path == null ? null : String(row.output_path),
      error: row.error == null ? null : String(row.error),
      errorStage: row.error_stage == null ? null : String(row.error_stage),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
    };
  }

  /** Unfinished episode to resume (latest), if any. */
  findResumableEpisode(): EpisodeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM episodes
         WHERE status NOT IN ('completed')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.getEpisode(String(row.episode_id));
  }

  listEpisodes(limit = 20): EpisodeRecord[] {
    const rows = this.db
      .prepare("SELECT episode_id FROM episodes ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ episode_id: string }>;
    return rows.map(r => this.getEpisode(r.episode_id)!);
  }

  getEpisodeRepositories(episodeId: string): EpisodeRepositoryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM episode_repositories WHERE episode_id = ? ORDER BY rank DESC")
      .all(episodeId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      episodeId: String(row.episode_id),
      nodeId: String(row.node_id),
      fullName: String(row.full_name),
      datasetRecordId: String(row.dataset_record_id),
      rank: Number(row.rank),
      selectionScore: Number(row.selection_score),
      selectedAt: String(row.selected_at),
      usageStatus: String(row.usage_status) as "reserved" | "produced",
    }));
  }

  updateStatus(
    episodeId: string,
    status: EpisodeStatus,
    fields: { stage?: string | null; workDir?: string; outputPath?: string | null; error?: string | null; errorStage?: string | null; artifacts?: unknown } = {}
  ): void {
    const now = new Date().toISOString();
    const finished = status === "completed" || status === "failed" ? now : null;
    this.db
      .prepare(
        `UPDATE episodes SET status = ?, stage = COALESCE(?, stage),
           work_dir = COALESCE(?, work_dir),
           output_path = COALESCE(?, output_path),
           error = ?, error_stage = ?,
           artifacts_json = COALESCE(?, artifacts_json),
           updated_at = ?, finished_at = COALESCE(?, finished_at)
         WHERE episode_id = ?`
      )
      .run(
        status,
        fields.stage ?? null,
        fields.workDir ?? null,
        fields.outputPath ?? null,
        fields.error ?? null,
        fields.errorStage ?? null,
        fields.artifacts === undefined ? null : JSON.stringify(fields.artifacts),
        now,
        finished,
        episodeId
      );
  }

  markProduced(episodeId: string): void {
    this.db
      .prepare("UPDATE episode_repositories SET usage_status = 'produced' WHERE episode_id = ?")
      .run(episodeId);
  }
}
