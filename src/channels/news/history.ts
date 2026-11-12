import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_DIR } from "../../config.js";

/** Standalone Lazy News database. `NEWS_DB` overrides the default. */
const NEWS_DB_PATH = process.env.NEWS_DB ?? path.join(DB_DIR, "news-history.db");

/**
 * Lazy News persistence — standalone, versioned, transactional.
 *
 * - Lives in its own database (`db/news-history.db`); the GitHub channel's
 *   database (`db/showcase-history.db`) is never opened by this module.
 * - A `schema_migrations` table tracks applied migrations; no blind ALTERs.
 * - The whole migration runs inside one transaction; any failure rolls back.
 * - A timestamped backup of the live DB is written before the first migration.
 */

export type NewsEpisodeStatus =
  | "discovered"
  | "facts_pending"
  | "facts_approved"
  | "script_pending"
  | "script_approved"
  | "rendering"
  | "completed"
  | "failed";

export type NewsEpisodeRow = {
  run_id: string;
  story_id: string;
  canonical_url: string;
  working_title: string;
  category: string;
  status: NewsEpisodeStatus;
  video_path: string | null;
  gate_a_at: string | null;
  gate_b_at: string | null;
  gate_c_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** Baseline user_version of a pristine GitHub DB (0 = never migrated). */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "news-channel-baseline",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS story_candidates (
        story_id TEXT PRIMARY KEY,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        score REAL,
        status TEXT NOT NULL DEFAULT 'discovered',
        fingerprint TEXT NOT NULL,
        cluster_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS story_candidates_fingerprint ON story_candidates(fingerprint);
      CREATE INDEX IF NOT EXISTS story_candidates_status ON story_candidates(status);

      CREATE TABLE IF NOT EXISTS source_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id TEXT NOT NULL,
        url TEXT NOT NULL,
        publisher TEXT,
        parent_publisher_group TEXT,
        wire_origin TEXT,
        source_role TEXT,
        independence_status TEXT,
        supports TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS source_records_story ON source_records(story_id);

      CREATE TABLE IF NOT EXISTS fact_claims (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        kind TEXT,
        status TEXT NOT NULL,
        importance TEXT,
        independence_count INTEGER,
        confidence REAL,
        as_of TEXT
      );
      CREATE INDEX IF NOT EXISTS fact_claims_story ON fact_claims(story_id);

      CREATE TABLE IF NOT EXISTS news_episodes (
        run_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        working_title TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'discovered',
        video_path TEXT,
        gate_a_at TEXT,
        gate_b_at TEXT,
        gate_c_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS news_episodes_story ON news_episodes(story_id);

      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (1, 'news-channel-baseline', datetime('now'));
    `,
  },
  {
    // Fresh standalone Lazy News database: the channel tracks its own runs
    // here (the GitHub database is never opened by this module).
    version: 2,
    name: "news-standalone-pipeline-runs",
    sql: `
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        stage TEXT,
        repository_node_id TEXT,
        output_path TEXT,
        error_json TEXT,
        channel TEXT NOT NULL DEFAULT 'news'
      );

      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (2, 'news-standalone-pipeline-runs', datetime('now'));
    `,
  },
];

function backupDb(dbPath: string): string {
  const backup = dbPath.replace(/\.db$/i, "") + `-pre-news-${Date.now()}.db`;
  fs.copyFileSync(dbPath, backup);
  return backup;
}

export function applyNewsMigrations(db: DatabaseSync, dbPath: string): string[] {
  const applied: string[] = [];
  // Ensure the bookkeeping table exists outside the transaction for a base read.
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
  const row = db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: number | null };
  const current = row?.v ?? 0;

  const pending = MIGRATIONS.filter(m => m.version > current);
  if (pending.length === 0) return applied;

  const backup = backupDb(dbPath);
  applied.push(`backup:${path.basename(backup)}`);

  try {
    db.exec("BEGIN");
    for (const migration of pending) {
      // migration includes bookkeeping insert; if tables already exist it is idempotent enough
      db.exec(migration.sql);
      applied.push(`migration:${migration.version}:${migration.name}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return applied;
}

export class NewsHistory {
  private readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly migrationNotes: string[];

  constructor(dbPath: string = NEWS_DB_PATH) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrationNotes = applyNewsMigrations(this.db, dbPath);
  }

  excludedStoryFingerprints(): Set<string> {
    const rows = this.db
      .prepare("SELECT fingerprint FROM story_candidates WHERE status = 'completed'")
      .all() as { fingerprint: string }[];
    return new Set(rows.map(r => r.fingerprint));
  }

  recordCandidate(storyId: string, url: string, title: string, category: string, fingerprint: string, clusterJson: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO story_candidates(story_id, canonical_url, title, category, fingerprint, cluster_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
         ON CONFLICT(story_id) DO UPDATE SET title=excluded.title, category=excluded.category, updated_at=excluded.updated_at`
      )
      .run(storyId, url, title, category, fingerprint, clusterJson, now, now);
  }

  markEpisodeStatus(runId: string, status: NewsEpisodeStatus, error?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE news_episodes SET status=?, error=?, updated_at=? WHERE run_id=?")
      .run(status, error ?? null, now, runId);
  }

  createEpisode(runId: string, storyId: string, url: string, title: string, category: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO news_episodes(run_id, story_id, canonical_url, working_title, category, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'facts_pending', ?, ?)
         ON CONFLICT(story_id) DO UPDATE SET run_id=excluded.run_id, status='facts_pending', error=NULL, updated_at=excluded.updated_at`
      )
      .run(runId, storyId, url, title, category, now, now);
    this.recordRun(runId, storyId, category);
  }

  private recordRun(runId: string, storyId: string, category: string): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs(run_id, started_at, status, stage, channel)
         VALUES (?, ?, 'running', 'news:facts', 'news')
         ON CONFLICT(run_id) DO NOTHING`
      )
      .run(runId, new Date().toISOString());
    void storyId; void category;
  }

  recordSources(storyId: string, sources: { url: string; publisher: string; group: string; wireOrigin?: string; role: string; independenceStatus: string; supports: string }[]): void {
    const insert = this.db.prepare(
      `INSERT INTO source_records(story_id, url, publisher, parent_publisher_group, wire_origin, source_role, independence_status, supports, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const s of sources) {
        insert.run(storyId, s.url, s.publisher, s.group, s.wireOrigin ?? null, s.role, s.independenceStatus, s.supports, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordFacts(storyId: string, facts: { id: string; claim: string; kind: string; status: string; importance: string; independenceCount: number; confidence: number; asOf?: string }[]): void {
    const insert = this.db.prepare(
      `INSERT INTO fact_claims(id, story_id, claim, kind, status, importance, independence_count, confidence, as_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, confidence=excluded.confidence, importance=excluded.importance`
    );
    this.db.exec("BEGIN");
    try {
      for (const f of facts) {
        insert.run(f.id, storyId, f.claim, f.kind, f.status, f.importance, f.independenceCount, f.confidence, f.asOf ?? null);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}


