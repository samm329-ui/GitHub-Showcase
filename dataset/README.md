# Script dataset

Every narration script the two pipelines generate is archived here, exactly as
it was produced, so it can be reused later — compilations, re-voicing, A/B
testing, audit. Separate folders and indexes per pipeline:

```
dataset/
├── github/                  ← GitHub Repository Showcase scripts
│   ├── <id>.json            one record per run
│   └── index.jsonl          append-only index (one line per record, upserted by id)
├── news/                    ← Lazy News Commentary scripts (same format)
├── README.md                ← this file (the only committed file in the folder)
```

`<id>` = `<slug>-<runId>`, the same stem as the run's temp directory and the
MP4 filename (`sindresorhus-p-map-1dbcce98` → `output/sindresorhus-p-map-1dbcce98.mp4`).

## Record format (`version: 1`)

```jsonc
{
  "version": 1,
  "id": "owner-name-a1b2c3d4",
  "channel": "github",        // or "news"
  "phase": "pending",         // → "completed" once measured audio exists
  "title": "owner/name",      // GitHub: repo full name · News: story headline
  "subject": "https://github.com/owner/name",
  "createdAt": "…",
  "updatedAt": "…",
  "runId": "a1b2c3d4",
  "invocation": { "kind": "discover", "detail": "practical" },
  "script": {
    "segments": [ … ],        // GitHub: NarrationPlan segments · News: narration lines
    "estimatedWords": 540,
    "estimatedSeconds": 210,
    "styleVariant": "...",
    "angle": "...",
    "llm": { "model": "…", "usage": { … }, "retries": 0 }   // Groq runs only
  },
  "facts": { "ledger": … },   // GitHub only — the fact ledger the script was grounded in
  "selection": …,             // GitHub only — discovery score breakdown
  "alignment": {              // filled once audio is measured
    "durationMs": 35420,
    "sampleRate": 24000,
    "coverage": 0.99,         // news only
    "alignmentSource": "faster_whisper_fallback"   // news only
  },
  "approvals": { "gateA": true, "gateB": true },  // news only
  "output": "output/news/<slug>-<runId>.mp4"      // relative, present after render
}
```

Phases ratchet forward only (`pending → completed`); the second write of a run
updates the record in place. A run that dies before synthesis leaves
`phase: "pending"`.

`index.jsonl` holds `{id, channel, phase, title, subject, createdAt, runId, output?}`
one per line, ordered by `createdAt`. Upserts rewrite the file atomically.

## Reusing scripts

```bash
npm run scripts:list -- github        # browse the index
npm run scripts:show -- news <id>     # the full record as JSON
```

For a compilation (many showcases back-to-back), read the index, filter by
`phase: "completed"` + whatever criteria, and load each `segments[]` in order
— the segments carry the measured spoken/caption text and per-segment timing
in the same shapes the pipeline consumes.

## Git

`dataset/github/*.json`, `dataset/news/*.json` and the indexes are gitignored:
they are generated output, not source. Only this README is committed; the
format contract lives here so tooling can rely on it without reading history.
Point `SHOWCASE_DATASET_DIR` elsewhere to relocate the folder (useful for a
shared team archive).
