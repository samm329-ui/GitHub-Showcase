# Database directory

All persistent SQLite history for the two pipelines lives here — nowhere else.
Everything in this folder except this file is **gitignored runtime state** on
the machine that ran the pipelines; it is not committed, and it is not portable
between machines except by copying the files yourself.

| File | Owner | Contains |
| --- | --- | --- |
| `showcase-history.db` | GitHub Repository Showcase (`src/history.ts`, `HistoryStore`) | `repositories`, `star_snapshots`, `pipeline_runs` — the discovery/reservation/retry ledger. This is the file the pipeline refuses to re-use for dedupe. |
| `news-history.db` | Lazy News Commentary (`src/channels/news/history.ts`, `NewsHistory`) | `story_candidates`, `source_records`, `fact_claims`, `news_episodes`, its own `pipeline_runs` — the story lifecycle, evidence provenance and gate trail for each episode. |
| `*-pre-news-*.db` | created automatically before news schema migrations | Timestamped backups; safe to delete once you're confident in the news DB. |
| `*.db-shm`, `*.db-wal` | SQLite write-ahead log sidecars | Do not edit; closed SQLite handles merge them automatically. |

**History layout note:** before this folder existed, both channels shared
`output/showcase-history.db`. The split moved it here unchanged
(`db/showcase-history.db`); the news-specific tables were copied verbatim into
`db/news-history.db`. The old file was left with its news tables intact as an
in situ safety snapshot (the GitHub code never reads it as "news data"), and an
untracked backup was written alongside it before the move (`output/*.pre-split-*`,
gitignored).

Overrides (per channel, rarely needed): `SHOWCASE_DB` / `NEWS_DB` point at a
different file; `SHOWCASE_DB_DIR` relocates the whole folder (both channels).

Backups: copy the `.db` file anywhere while the pipeline is not running and you
have a complete offline backup of a channel's history.
