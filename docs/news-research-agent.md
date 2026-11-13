# Lazy News - Groq-Powered Research Agent

> **Status 2026-11-13:** the Lazy News discovery/evidence lane is now the **Inshorts
> card lane** (see docs/lazy-news.md, "Inshorts lane addendum"). This module remains
> only for the `--research` experiment path and requires the retired Fortress-Reach
> lane (`NEWS_SOURCE=fortress`); it is not part of the default pipeline.

The discovery stage's intelligent replacement. Instead of a fixed page list and canned
queries, the agent plans its own searches with Groq, reads what it finds through
Fortress-Reach (the **only** research environment), extracts claims deterministically,
detects what is missing itself, searches again, and stops on an explicit contract â€” or
tells you it never got there.

```
DISCOVER â†’ CLUSTER â†’ SELECT â†’ PLAN_SEARCH â†’ SEARCH â†’ READ â†’ EXTRACT_CLAIMS
         â†’ IDENTIFY_GAPS â†’ SEARCH_AGAIN â†’ BUILD_DOSSIER
(then the pipeline's existing VERIFY stage â†’ ledger â†’ Gate A)
```

It exists because the old lane's failure mode was invisible: stories died in
metadata-only limbo with no record of why. This one writes down what it tried, what it
found, what it could not corroborate, and why it stopped.

## Usage

```bat
REM full pipeline with research (gates automated as usual for Lazy News)
npm run start:news -- --research --topic politics
npm run start:news -- --research --topic technology --dry-run
```

Research mode is opt-in. The default `--discover` path is untouched.

## What it does

1. **PLAN_SEARCH** â€” Groq (existing `groqChatCompletion` client, shared key/rate-limit
   discipline) proposes 3â€“6 queries plus intent, told **which registered outlets exist**
   so plans land on retrievable sources. Output is schema-checked; garbage falls back to
   the deterministic category queries. URLs inside LLM output are rejected as fabricated.
2. **Browse lane** â€” the reliable Fortress lane: registered front pages and permitted
   full-text sections (The Hindu, ET, blogs) are harvested per category. Headless API
   search (Bing) is kept only as topical supplement, and its hits survive only if they
   match the outlet registry.
3. **CLUSTER â†’ SELECT** â€” existing clustering/ranking, with two research-side guards:
   a category-fitness floor (an off-category blob never beats a relevant story) and a
   degeneracy ceiling (`MAX_COHERENT_CLUSTER = 12`; a 100-item over-merged blob is not a
   story â€” the run says so out loud instead of selecting it).
4. **ITERATE** â€” reads the strongest per-group permitted full-text pages; extracts claims
   (Groq proposes, determinism decides); asks Groq for a **gap analysis** (what's missing,
   what should be searched next, what perspectives are absent); executes follow-up
   searches within budget; repeats. Stops when sufficient, out of useful paths, out of
   budget, or the transport fails â€” and never upgrades a stop into "complete".
5. **BUILD_DOSSIER** â€” `research-dossier.json` is written to the run dir with every
   search executed, every hit (allowed or dropped), articles with passages,
   origin/independence analysis (wire-lineage aware), contradictions surfaced, missing
   perspectives, resource usage, and an honesty note that states plainly what was not
   achieved.

## Independent-origin analysis

`originKeyOf` (shared by the agent and Gate A, in `ledger.ts`):
`wire:<wire>` for real wire services (AP, PTI, PIBâ€¦), `group:<publisher>` otherwise.
Metadata-only records **never** count toward full-text corroboration. Shared wire
reprints count as **one** origin. First-party self-announcements are narratable only
through the existing Gate A exception (verified hard facts + `single_origin
self-announcement:<group>` provenance label), never as independent reporting.

## Safeguards (all deterministic)

- Every URL in the dossier entered through Fortress or is exactly the one you passed via `--url`. Groq never supplies URLs.
- Every LLM JSON payload is schema-validated by hand (no new dependencies). Malformed output is dropped with a log, never "interpreted".
- An LLM verdict alone can never knock evidence out of the verifier: `contradicts` verdicts require a verbatim anchor **with a hard conflict point** (number/quote/named-entity pair) **and** an uphold verdict from an independent adversarial auditor; anything else is degraded, logged, and kept.
- Metadata-only evidence never corroborates; the earlier ledger/gate keeps metadata-only claims attributed-only.
- Gate A remains authoritative. No dossier field approves anything; approvals remain SHA-256-pinned, `approved_by=automated` under `NEWS_AUTO_GATES=1`.
- "complete" means the gap analysis declared sufficiency **against retrieved evidence** â€” not the model's confidence.

## Budgets (all configurable)

| Env var | Default | Meaning |
|---|---|---|
| `NEWS_RESEARCH_MAX_ITERATIONS` | 3 | gap-follow-up rounds after the initial read |
| `NEWS_RESEARCH_MAX_SEARCHES` | 24 | Fortress browse+search operations/run |
| `NEWS_RESEARCH_MAX_ARTICLES` | 8 | pages read in full/run |
| `NEWS_RESEARCH_MAX_LLM_CALLS` | 12 | total Groq completions/run |
| `NEWS_RESEARCH_TOKEN_BUDGET` | 40000 | prompt+completion tokens/run |
| `NEWS_RESEARCH_TIMEOUT_MS` | 600000 | wall-clock ceiling/run |

`GROQ_API_KEYS=k1,k2,â€¦` rotates the active key on 429 (missing from the old single-key
setup; `GROQ_API_KEY` alone unchanged when unset). Every LLM call is accounted in the
dossier (`llmCalls`, token totals); every search/read is logged.

## What to watch in `research-dossier.json`

- `status`: `complete` / `insufficient_evidence` / `no_useful_path` / `budget_exhausted` / `no_candidates` / `transport_failed`. None of these is upgraded retroactively.
- `searches[].mode`: `initial` | `followup` | `browse`.
- `independentOriginAnalysis`: `corroboratingOrigins`, `duplicateOriginGroups`, `syndicatedWirePairs`.
- `articles[].llmStance`: raw LLM verdict; `articles[].supports`: corroboration status after anchor enforcement.
- `warnings`: refused reads, fabricated URLs rejected, audit overrules, budget stops â€” the full skeleton of what did NOT happen.

## Known environment reality (this machine, 2026-11-13)

- `search_web` through Fortress returns Bing-redirect/pseudo-URL noise; the registry filter drops virtually all of it. The **browse lane** is therefore the primary signal source. This is not a bug to paper over â€” it means political full-text corroboration currently depends on registry-listed full-text outlets (ET Times Group, The Hindu, primary records), and much Indian political coverage is metadata-only.
- The release pages that are JS/postback-driven (PIB/RBI/PRS/sansad) render no server-side headings; sansad.in answers with a CAPTCHA (hard-stop, not bypassed).
- The result, honestly: politics runs frequently end in `GATE_A_REFUSED â€” metadata-only record(s) do not count as corroboration` (or `EVIDENCE_VERIFICATION_FAILED`), and no episode is produced. The system is designed to fail that way rather than narrate thin evidence.
- When Fortress is down entirely (`REACH_MCP_URL` unset), `--research` blocks with `research_transport_failed`, exactly like the old lane.

## Files

- `src/channels/news/research-agent.ts` â€” the agent
- `src/channels/news/index.ts` â€” `--research` wiring (Stage 1 replacement only)
- `src/channels/news/auto-gates.ts` â€” Gate A corroboration is full-text-only (metadata never corroborates) and wire-lineage/group aware
- `src/channels/news/ledger.ts` â€” `originKeyOf` (shared lineage key)
- `src/groq.ts` â€” `GROQ_API_KEYS` rotation on 429
- `tests/news-research-agent.test.ts` â€” 34 tests incl. rate-limit recovery, key rotation, fabrication rejection, budget exhaustion, Gate A integration


