# Long-form dataset reconciliation report

**Date:** 2026-11-14 · **Scope:** read-only audit of `dataset/github/*.json` — the only completed-script archive the Long-form pipeline may select from. `db/showcase-history.db` is deliberately NOT used (it is the Short-form completion ledger, not a script archive).

## Summary

| Measure | Value |
|---|---|
| Index records (`index.jsonl`) | 9 |
| Record files on disk | 9 |
| `phase == "completed"` | 9 |
| Valid, unique, scriptable, **usable** | **9** |
| Needed for one episode | 5 |
| Records still available after the first Long-form episode (today) | **4** — the next episode cannot start until more Short-form videos are produced |
| Shortfall | 0 for one episode; **4 < 5 for any second episode** |

`showcase-history.db` holds 85 `completed` repositories (So the archive is ~10% of what history suggests — documented 2026-11-13 in the architecture audit and reconfirmed now).

## Usable repositories (base-score order)

| Record | node_id | Stars | Language | Topics (sample) | Segments | Words | Facts | README |
|---|---|---|---|---|---|---|---|---|
| open-pencil/open-pencil | R_kgDORaWc5Q | 9,827 | TypeScript | open-source, design-editor, figma-alternative | 5 | 62 | 13 | 13,930 B |
| expo/exact | R_kgDOVfkMyg | 3,314 | Rust | ai-agents, ios, coding-agents | 5 | 82 | 13 | 49,294 B |
| hugo-themes/toha | MDEwOlJlcG9zaXRvcnkyNTQ4MDkyNDk= | 1,250 | HTML | hugo, blog | 6 | 77 | 11 | 9,807 B |
| agentes-chat/agentes-chat | R_kgDOVnleRw | 1,084 | TypeScript | ai-agents, browser-automation | 5 | 60 | 13 | 10,492 B |
| usemoss/moss | R_kgDOP8XNLA | 805 | Python | rag, retrieval, hybrid-search | 6 | 96 | 16 | 16,159 B |
| Ikalus1988/MisakaNet | R_kgDOSP_2Tg | 561 | Python | ai-agents, claude-code-plugin | 6 | 100 | 13 | 21,789 B |
| lmliheng/Adelie | R_kgDOU7LK3g | 161 | TypeScript | agent, llm, multi-agent | 6 | 94 | 17 | 12,584 B |
| EnragedAntelope/comfyui-identity-forge | R_kgDOS-2pcg | 29 | Python | comfyui, character-creator | 7 | 98 | 15 | 24,584 B |
| makralabs/makra | R_kgDOT-L4Gw | 30 | Python | ai, ai-memory, ai-tools | 5 | 79 | 7 | 4,102 B |

All nine verified: stable `node_id` present, fact ledger non-empty, ≥3 segments, `readmeText ≥ 200 B`, selection nodeId == ledger nodeId (checked programmatically), `phase == completed`.

## Deterministic selection (committed for episode lf-c197123c on 2026-11-14)

Diversity-aware greedy pick (penalty: `8 × same primary language + 6 × topic jaccard ≥ 0.25`), then rank by `selectionScore desc, nodeId asc`; presentation order is the reverse (weakest first):

| Rank | Repository | Score |
|---|---|---|
| 5 | Ikalus1988/MisakaNet | 69.0 |
| 4 | hugo-themes/toha | 74.0 |
| 3 | usemoss/moss | 80.0 |
| 2 | open-pencil/open-pencil | 81.0 |
| 1 | expo/exact | 86.0 |

The five are permanently reserved in `db/longform-history.db` (`longform_repository_usage`, unique on `repository_node_id`). A failed episode does not release them; this episode resumes with the same five (verified: `--resume` reuses the reservation).

## Implications

1. One episode is possible today.
2. A second episode is NOT possible until ≥1 more completed GitHub dataset record exists.
3. The pipeline preflights this and reports the exact shortfall; it never silently reuses or fabricates.

## Feed-forward note

Phase-2 dataset writes from the existing pipeline leave `alignment` only as `durationMs`/`sampleRate` (no per-segment timings, no coverage) and omit `script.llm` in all nine records (noted 2026-11-13; unchanged). Long-form does not depend on those fields.
