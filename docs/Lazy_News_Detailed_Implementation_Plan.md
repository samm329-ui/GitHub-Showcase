# Lazy News — Detailed Implementation Plan (FINAL IMPLEMENTATION SPECIFICATION)

**Project:** Lazy News / sarcastic news-commentary reel channel
**Document type:** Agent-ready final implementation specification (supersedes and consolidates `Lazy_News_Logical_Data_Sourcing_and_Scripting_Implementation_Plan.md`, `Lazy_News_Automated_Reel_Production_Brief.md` and the earlier implementation plan)
**Status:** **FINAL IMPLEMENTATION SPECIFICATION** — architecture approved; implement exactly this document.
**Prepared:** 10 November 2026
**Architecture rule:** Add a second channel; do not destructively change the existing GitHub Showcase pipeline.
**Product framing:** This is not "a second video renderer". It is a **second content-intelligence pipeline that shares the existing automation infrastructure** and produces episodes of one show. The news engine must remain **reusable**: sources, LLM and voice are swappable inputs; verification rules, ledger, rendering and QA are the product.

---

## 0. Executive summary

GitHub Repository Showcase works as: discover → ground in evidence → scripted narration → local TTS → timeline → render → QA → history. Lazy News keeps that engine and replaces only what the content domain requires:

1. **Discovery** from permitted news/official sources (RSS, GDELT, Bluesky) — signals, never proof.
2. **Clustering** of outlets covering the same event, with source-lineage tracking so syndicated copies count once.
3. **A claim-level fact ledger** (the only factual authority the script writer may use) built from primary records and independently corroborated reporting.
4. **A sarcastic, factual script** written by Groq under hard deterministic gates — the LLM is a writing assistant, never a fact-finder.
5. **Local Kokoro voice** (auditioned English voices only; English-only delivery) with measured audio as the timing master and a **new word-level forced-alignment stage** for captions and callouts.
6. **The supplied Lazy News office scene** (941×1672 artwork, layers to be masked) animated by narration-driven scene events, rendered through the existing Chromium/FFmpeg pipeline.
7. **Mandatory human approvals** before rendering, layered ON TOP of deterministic QA (never a replacement).

Two channels, one launcher. One story per episode. English only. Non-commercial. No paid APIs, subscriptions or TTS services.

---

## 1. Scope, constraints, non-negotiables

| # | Constraint | Detail |
|---|---|---|
| 1 | Two channels in this repo | `run.bat` selects `[1] GitHub Repository Showcase` (unchanged behaviour) or `[2] Lazy News Commentary`. Common infrastructure is shared; content logic is isolated. |
| 2 | GitHub regression | No destructive GitHub changes. No changes to GitHub-specific business logic. Existing GitHub tests pass. GitHub behaviour and output class remain unchanged. News failures must never affect GitHub runs. (Note: this is *not* a promise of byte-identical `run.bat`/DB; see §13.) |
| 3 | English only | No Hindi voice profile, no code-switching work in this scope. |
| 4 | Non-commercial | The channel is a non-commercial content page. This bounds several source licences (Guardian Developer key, RSS terms). Re-check before any monetisation. |
| 5 | No paid dependencies | Groq free tier, optional Guardian key, all other sources free (official documents, feeds). No paid news APIs, no paid TTS, no paid image/video services. Free quotas are treated as finite, not unlimited. |
| 6 | One story per episode | One central event or development per video. Related background is context, not extra headlines. |
| 7 | One minute, natural length | ~45–75 s normal; 48 s short and 85 s long both legal. 75 s is a soft pacing target; **90 s is a configurable technical safety guard, not an editorial restriction**. Never pad; never force compression. |
| 8 | No LLM as fact-finder | Source documents and the approved ledger are the evidence. Groq formats and writes; deterministic code verifies. |
| 9 | Proof before render | Ledger verified → **human approves the factual package** → script generated and validated → **human approves the script** → render starts. `--dry-run` remains available at each step. |
| 10 | Fail closed | Unknown or false permission = not usable. No 403/paywall/CAPTCHA workarounds. No anti-bot evasion anywhere. |
| 11 | No unsupported facts | Script fails validation = no episode. No silent fallbacks, no invented neighbours of real facts. |
| 12 | Satire discipline | Aim at power, institutions, contradictions, absurdity — never victims. Allegations stay allegations. |
| 13 | Word-level timing | Captions and callouts retime from measured + word-aligned audio. Chunk durations alone are not word-level sync. |

**Explicit non-goals:** multi-story roundups; breaking-news wires as a stand-alone product; Hindi delivery; republication of outlet articles or photographs; any content for a commercial ad account; UIs beyond a launcher/zero-install reports; fully unattended publishing.

---

## 2. What changes vs. what stays

| Area | Decision | Why |
|---|---|---|
| Launcher / menu | Changed, additively | User must select a channel; GitHub flow preserved under option 1. |
| GitHub business logic | **Untouched** | The working pipeline is the product's credibility; touch it only additively. |
| Kokoro TTS | Reused | Already local, already piped into the repo; keep. |
| Groq client | Reused behind provider boundary | Retry/429/timeout discipline is battle-tested; swap provider without touching ledger. |
| Captions/timeline | Reused + extended | Measured-chunk durations stay as fallback; new word alignment becomes authoritative (§12). |
| Render stack | Reused | Chromium CDP frames → FFmpeg encode → 1080×1920 yuv420p faststart; same pattern, new DOM stage. |
| History DB | Extended, versioned | `channel` column + news tables via schema_migrations (§13). |
| Scroll choreography | **Not used** in News v1 | The scene is static with liveness motion; no tall document scrolling. |
| GitHub capture (`mobile-capture.ts`) | **Not used** | No live site capture in this channel; layers + live text only. |
| New named components | News discovery/verification/scripting/scene modules | See §5.4. |

**Deliberate re-interpretation of the two source specs:** the attached docs mandated hard interactive approval *instead of* pipeline progress; this plan grants approval **before rendering** while keeping deterministic QA fully automatic. The `NEWS_INTERACTIVE_REVIEW` bypass is **removed entirely** — Gates A and B are mandatory before rendering under every configuration, and no environment variable can disable them (§15).

---

## 3. Corrections incorporated (architecture + implementation review)

1. **Guardian full-text → Groq: removed.** The free Guardian Developer key permits reading article text via API, but its terms restrict AI processing of content and separate commercial use. Guardian is a discovery/licence-blocked source; its prose never reaches Groq; body text enters the pipeline only with written permission covering this exact use (`GUARDIAN_LLM_ALLOWED=1`, adapter disabled by default, see Open Items §22). Groq receives only our ledger — never raw publisher prose — removing blending risk and quota waste.
2. **BBC extraction: removed as drafted.** BBC requires permission for protected-content reuse and computer analysis; business use of its RSS needs permission. BBC is discovery/link-only until authorised; it never appears as a supporting source in credits unless specifically authorised. No 403/paywall bypass.
3. **Mandatory human approval before rendering, unbypassable.** Gate A (factual package) → Gate B (script + voice) → Gate C (final render; mandatory before publication). No environment variable disables Gates A/B/C. Deterministic validators are the technical floor beneath each human gate — never a substitute, never optional.
4. **Transcript-conditioned forced alignment mandatory.** `tools/align_audio.py` (see §12) aligns the **approved Kokoro transcript** against `narration.wav` with a real forced aligner (WhisperX's alignment stage or Montreal Forced Aligner, evaluated on-machine); Whisper word timestamps (`faster-whisper`, CTranslate2-based — not PyTorch) are fallback only, never the gold standard. Token coverage is necessary but not sufficient — word-boundary accuracy is tested on manually annotated samples before any subtitle animation ships.
5. **Versioned, reversible migrations.** `schema_migrations` table + transaction + timestamped DB backup; no repeated `ALTER TABLE ADD COLUMN`; GitHub regression stated honestly (§13).
6. **Per-source permission policies, not category grants.** §4.3 registers individual `SourcePolicy` entries with explicit `permissionBasis`; unknown ⇒ disabled; terms-check audits expire after 90 days; category-level permissions are banned.
7. **Deterministic vs semantic validation split.** Numbers/dates/currency/names/quotes/legal-status/provenance/FactIDs = deterministic code. Claim-to-evidence semantic assessment, tone, and satire correctness = human editor (Gate B). Groq may flag; it can never approve its own factual claims.
8. **Credits distinguish discovery from evidence.** On-screen credits name only sources that support approved facts (primary records / independent reporting), never discovery-only outlets (§14).

Additional corrections also folded in:

- Explainability **removed** from the numeric score; replaced with public impact (10%). Evidence adequacy is an eligibility floor, not a score weight.
- `independenceStatus` (`independent | syndicated | same_original_source | unknown`) added to every evidence record; unknown independence ⇒ not an independent confirmation.
- Bluesky and GDELT are discovery/verification signals — **never** counted as independent factual sources.
- Three independently persisted packages — **StoryPackage**, **EpisodeScript**, **RenderPackage** — so a pronunciation fix never re-researches and a subtitle-timing fix never re-generates narration (§6.2).
- 941×1672 → 1080×1920 uses **uniform scale + minimal crop/pad** (never non-uniform stretch) (§11.6).
- Asset masking uses **per-asset, inspected component masks** (no brittle global `y≈700` cutoff) (§11.2).
- Implementation order re-prioritised: **P0 permissions → P1 discovery/ledger → approvals → scripting → voice → P3 scene → P4 release**. Effort is an estimate, not a commitment, until permissions and alignment are proven (§18).

---

## 4. Legal, licensing and source-permission model (controls everything)

### 4.1 Core rule

Publicly reachable ≠ licensed, and licensed ≠ under AI processing. Every source in the registry carries an explicit, machine-checkable permission record. **The system fails closed**: unknown/false permission ⇒ content may not enter evidence, and **must never enter the Groq prompt**.

```ts
interface SourcePolicy {                    // one entry per domain + documentType set
  sourceId: string;                        // e.g. "pib.gov.in"
  domain: string;                          // e.g. "pib.gov.in"
  documentTypes: string[];                 // e.g. ["press_release"]
  discoveryAllowed: boolean;               // may appear as a discovery signal
  metadataAllowed: boolean;                // headline/URL/date/publisher may be stored
  fullTextFetchAllowed: boolean;           // fetching article body is permitted
  llmProcessingAllowed: boolean;           // any of this source's text may reach an LLM
  quotationAllowed: boolean;               // short verbatim quotes may be used on-screen/spoken
  permissionBasis:
    | "public_domain"                      // e.g. US federal government works
    | "explicit_license"                   // e.g. CC-BY-SA (Wikimedia) — attribution honoured
    | "written_permission"                 // signed licence/permission on file
    | "terms_reviewed"                     // terms read, understood, compatible — notes required
    | "discovery_only"                     // discovery/metadata licence only; content unusable for evidence
    | "unknown";                           // unreviewed → disabled, always
  licenseUrl?: string;                     // terms/licence reference (required unless discovery_only)
  termsCheckedAt?: string;                 // ISO date of the check — an audit trail, NOT proof of permission
  enabled: boolean;                        // master switch; false ⇒ source is inert
}

type IndependenceStatus = "independent" | "syndicated" | "same_original_source" | "unknown";
```

Rules:

- **Policies are per source, never per category.** Government records, courts, UN releases, newsrooms, arXiv and research portals are NOT blanket-permitted. Each domain × documentType gets its own reviewed entry with an explicit `permissionBasis`. `termsCheckedAt` records when a human reviewed the terms — it is an audit field, not a permission proof.
- **Unknown basis ⇒ `enabled: false`.** Category-level grants are banned by code review and by test: the loader refuses to enable a source whose `permissionBasis` is `unknown`, and refuses `llmProcessingAllowed` unless `fullTextFetchAllowed` is also true.
- `sourceRole` (primary | independent_reporting | discovery | social_signal | fact_check) is a **role, not a licence**; permission is always evaluated separately. `parentPublisherGroup` + `wireOrigin` populate `independenceStatus` automatically; manual override requires the human editor's action.
- `commercialUseAllowed` is deliberately absent until a commercial context exists — when added, it re-reviews every enabled source.

### 4.2 How Groq safely receives material

Groq receives: story metadata (headline/date/category), our own typed ledger (claim, excerpt, attribution, confidence, as-of), length budget and style instructions. It never receives a publisher article body, never a feed description presented as fact, never a syndicated copy count. This makes the pipeline permission-safe by construction and limits quota (one generation + one optional rewrite), per the source spec §15.

### 4.3 Source registry — individually reviewed policy entries (initial)

Every enabled row below is an individual `SourcePolicy` reviewed on its own merits — not a category grant. Each record carries `licenseUrl`; `termsCheckedAt` is an audit field, not proof of permission. Discovery-only entries may feed clustering/shortlist only; their text never enters the ledger or Groq.

| sourceId | Types | discovery | metadata | fullText | LLM | quote | permissionBasis | enabled |
|---|---|---|---|---|---|---|---|---|
| `pib.gov.in` | press_release | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official public records; attribution) | ✓ |
| `rbi.org.in` | notification, speech, release, data | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official public records; attribution) | ✓ |
| `mea.gov.in` | statement, media_briefing | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official records; attribution) | ✓ |
| `sansad.in` | question_answer, bill, debate | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (parliamentary records; attribution) | ✓ |
| `eci.gov.in` | press_release, order, result, schedule | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (election authority records; attribution) | ✓ |
| `sci.gov.in` / `scr.gov.in` | judgment, order | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official court records; attribution) | ✓ |
| `mospi.gov.in` | release, data | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official statistics; attribution) | ✓ |
| `cag.gov.in` | report | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official audit records; attribution) | ✓ |
| `indiabudget.gov.in` | budget_document | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (official records; attribution) | ✓ |
| `prsindia.org` | analysis, explainer | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (analysis, not legal text — label as analysis) | ✓ |
| `un.org` / `ungeneva.org` | press_release, sc_record | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (institutional records within remit; attribution) | ✓ |
| `who.int` / `imf.org` / `worldbank.org` / `iaea.org` / `unhcr.org` | release, report | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (institutional, within remit; attribution) | ✓ |
| `data.sec.gov` / `sec.gov` EDGAR | filing, company_facts | ✓ | ✓ | ✓ | ✓ | ✓ | public_domain (US federal filings; fair-access 10 rps + UA string) | ✓ |
| `arxiv.org` | paper | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (arXiv licence; preprints labelled as preprints) | ✓ |
| `openai.com/news` | company_announcement | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (first-party; announcement ≠ truth) | ✓ |
| `anthropic.com/news` | company_announcement | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (first-party; claim ≠ verified) | ✓ |
| `blog.google` | company_announcement | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (first-party; claim ≠ verified) | ✓ |
| `nvidia.com/newsroom` | company_announcement | ✓ | ✓ | ✓ | ✓ | ✓ | terms_reviewed (first-party; claim ≠ verified) | ✓ |
| `open-platform.theguardian.com` | article | ✓ | ✓ | △ written_permission only | **✗ by default** | △ written_permission only | discovery_only (free non-commercial Developer key, ~500 calls/day, 1 rps; AI-processing restriction on content) | discovery only |
| `bbc.co.uk` / `bbc.com` | article | ✓ | ✓ | ✗ without permission | **✗** | △ short attributed quotes (paraphrase preferred) | discovery_only (permission required for reuse/computer analysis; business RSS use needs permission) | discovery only |
| `ft.com` | article | ✓ | ✓ | ✗ paywalled | ✗ | △ attributed one-liners from visible copy | discovery_only | discovery only |
| `indianexpress.com/rss` | article | ✓ | ✓ | ✗ terms: personal/non-commercial reads | ✗ | ✗ | discovery_only | discovery only |
| `aljazeera.com` | article | ✓ | ✓ | △ pending terms review | **✗** | △ after review | discovery_only | discovery only |
| `npr.org` | article | ✓ | ✓ | △ terms review | **✗** | △ after review | discovery_only | discovery only |
| `cnbc.com` | article | ✓ | ✓ | ✗/△ per feed review | ✗ | △ per feed review | discovery_only | discovery only |
| `gdeltproject.org` (DOC 2.0) | coverage_metadata | ✓ | ✓ (coverage patterns) | n/a (no bodies) | ✗ | ✗ | explicit_license (GDELT open data; attribution in internal + published notes) | discovery only |
| `bsky.app` (public AppView) | post, link | ✓ | ✓ (author/post/link) | n/a | ✗ | ✗ | terms_reviewed (public reads, cache-friendly host; honour 429/backoff) | discovery only |
| `en.wikipedia.org` (Portal:Current_events) | event_index | ✓ | ✓ | △ citation-check fetch | **✗** (excerpt-paraphrase only) | ✓ (CC BY-SA 4.0; attribution) | explicit_license (corroboration index + citation pointers, never republished prose) | discovery + pointer |
| `snopes.com` | fact_check | ✓ | ✓ | △ per terms | ✗ until reviewed | ✓ (rating citation) | terms_reviewed | discovery only |
| `factcheck.org` | fact_check | ✓ | ✓ | △ per terms | ✗ until reviewed | ✓ (rating citation) | terms_reviewed | discovery only |

Rules:

- Without `enabled: true` and a non-`unknown` `permissionBasis`, a source is inert — the registry refuses to load it into discovery.
- Terms reviews recorded in `termsCheckedAt` expire after **90 days**; expired entries degrade to `discovery_only` automatically until re-reviewed.
- Written-permission sources (`written_permission`) ship disabled; enabling requires the permission letter filed under `docs/licenses/` plus licence review notes.
- Government/institutional/first-party entries support **announcement-class claims** ("X said/announced/filed"); independence (two origins) is still required for "X happened/is true" treatment — see §8.3/§8.4.
- Any `llmProcessingAllowed: true` also requires `fullTextFetchAllowed: true` and `quotationAllowed: true` — the loader rejects inconsistent combinations.

### 4.4 Evidence vs announcement vs interpretation (validation classes)

Three different sentences, three different rulebooks — they must never share one validation rule:

| Class | Example | Validation |
|---|---|---|
| Fact | "A ministry approved ₹X for semiconductor PLI on 3 Nov." | Must match a ledger `verified|attributed` claim exactly (number, date, name, action). |
| Interpretation | "This could benefit the tech sector." | Attributed to a source, or labelled as the show's analysis (`analysis`/`forecast` kind — never presented as fact). |
| Satire/commentary | "Apparently the government discovered the future, forty minutes after everyone else." | Tagged as commentary; may not contain a factual claim stronger than the ledger; may not carry a seemingly-verifiable number/name unless from the ledger; aims at power, never victims. |

Hard political rules (English politics scope included):

- FIR ≠ conviction; investigation ≠ proof; allegation ≠ finding; court observation ≠ final judgment; proposed ≠ implemented; a company-reported result is a **company claim**, not a benchmark.
- Allegations must carry the speaker and seek the response from the other side/institution where available.
- The same rules apply regardless of party, ideology or ideology-adjacent region. No campaign ads, no screeds disguised as satire.
- Geopolitics: attribute each side's casualty/claim; where confirmation is absent, say so.
- Uncertainty is never sarcasm-fodder; a careful line can still be funny.

---

## 5. System architecture

### 5.1 One launcher, two pipelines

```
run.bat
 └─ VIDEO_AUTOMATION_STUDIO menu
     ├─ [1] GitHub Repository Showcase   → existing pipeline (behaviour unchanged)
     └─ [2] Lazy News Commentary         → npm run start:news
            ├─ [1] Discover stories      (categories → ranked shortlist → pick one)
            ├─ [2] Enter a story URL     (manual tip → same evidence flow)
            ├─ [3] Pending episodes      (facts awaiting Gate A / script awaiting Gate B)
            └─ [4] Resume episode        (from temp/news/<runId>/)
```

`VIDEO_CHANNEL` resolved once at startup as typed enum (`github | news`). News sub-flow options mirror GitHub: category rotation, dry-run, voice profile, length guard. All text and validation strings live in the News channel; GitHub localization is untouched.

### 5.2 Three independently persisted packages (no re-work on small edits)

```
output/news/<episode-id>/
  source-records.json      # discovered + selected cluster, permissions snapshot, independence
  evidence-ledger.json     # typed claims + evidence + statuses + as-of   ← StoryPackage
  approved-facts.json      # after Gate A: editor-selected facts
  script.json / script.txt # narration + jokes + callouts + factIds       ← EpisodeScript
  gate-approvals.json      # A/B/C records: who/when/what was shown
  narration.wav
  narration-alignment.json # word-level timestamps (§12)
  pronunciation-overrides.json
  scene-events.json        # derived from measured+aligned timeline
  render-manifest.json     # channel, voice, layer hashes, canvas, approvals
  source-credits.json      # credits for SUPPORTING sources only (primary records / independent reporting), never discovery-only outlets; publication dates + attribution preserved
  qa-report.json
  final.mp4                # ← RenderPackage
```

Correct a pronunciation ⇒ regenerate only that chunk + realign, keep research. Adjust subtitle animation or callout styling ⇒ re-render from RenderPackage, no re-research, no re-voice. Swap Groq for another provider ⇒ ledger untouched. Swap the show voice ⇒ manifest changes; nothing above it does. This is what "news-production engine" means concretely.

### 5.3 Data flow

```
RSS/GDELT/Bluesky/manual URL
        │  (Tier A: signals)
        ▼
Story clustering + wire-lineage dedup
        ▼
Ranking (transparent weights, §9.4) → SHORTLIST → human picks ONE story
        ▼
Evidence collection (Tier B/C permitted only) → CLAIM-LEVEL LEDGER
        ▼
Deterministic verifier  ──fail──►  episode blocks (loud, specific reasons)
        ▼
GATE A: human approves factual package (or requests more sources)
        ▼
Groq script (ledger only) → deterministic script validator ──fail──► block
        ▼
GATE B: human approves script (+ callouts/highlights)
        ▼
Kokoro narration (approved voice profile) → measurable chunks
        ▼
WORD-LEVEL FORCED ALIGNMENT (tools/align_audio.py)
        ▼
Scene events + captions from MOVEMENT-EXACT audio timeline
        ▼
News scene render (Chromium CDP) → FFmpeg → QA (incl. ledger-approved flag)
        ▼
GATE C: human previews MP4 → publish manually (channel never auto-posts)
```

### 5.4 Component map

```
src/channels/news/
  discovery/   rss-adapter.ts  gdelt-adapter.ts  bluesky-adapter.ts  manual-url.ts
  sources/     source-registry.ts  source-permissions.ts  source-policy.ts  primary-documents.ts
  clustering/  normalise-item.ts  cluster-stories.ts  score-candidates.ts
  verification/ evidence-collector.ts  source-lineage.ts  fact-ledger.ts  claim-validator.ts
  editorial/   story-selector.ts  script-prompt.ts  script-schema.ts  script-validator.ts  satire-rules.ts
  voice/       news-voice-profile.ts  pronunciation-dictionary.ts  narration-builder.ts
  scene/       scene-event-builder.ts  callout-planner.ts  subtitle-planner.ts  scene.ts
  pipeline.ts
src/shared/     (reusable: tts, captions, audio, render, qa, persistence, history)
config/         news-sources.json  news-source-policies.json  news-categories.json  news-voice-profile.json  news-scene.json
assets/lazy-news/{original,layers,fonts}/    (see §11)
tools/          prep_lazy_news_assets.py  align_audio.py  news-preview.ts  news-preview-live.html
docs/           this file; Lazy_News_Automated_Reel_Production_Brief.md; Lazy_News_Logical_Data_Sourcing_and_Scripting_Implementation_Plan.md
```

---

## 6. Discovery and normalisation (Tier A: signals, never proof)

### 6.1 What each source is for

| Source | Actual responsibility |
|---|---|
| RSS/Atom | Discover published stories (respecting each feed's permissions). |
| GDELT | Coverage patterns and candidate articles ("which outlets, when, how much") — never a factual citation. |
| Bluesky | Emerging discussions and original links — never an independent factual source. |
| Government records | Verify official actions and statements (announcement ≠ truth). |
| Court & legislative documents | Establish legal and parliamentary records. |
| Company newsrooms | Verify what the company actually announced/claimed. |
| Independent reporting | Context and independent corroboration. |
| Fact-check organisations | Investigate contested claims. |

These roles are **not interchangeable**; the registry encodes the distinction, and the verifier enforces it (a government release supports "the ministry announced X", not "X is true").

### 6.2 Normalisation

Strip tracking parameters; canonicalise domains; store original title/URL untouched; parse dates to UTC (`publishedAt` vs `eventDate` separately — never conflate publication time with event time); language detect; persist raw metadata and normalised records; handle malformed XML, missing dates, relative URLs, Unicode, duplicate GUIDs safely. Sources polled conservatively (15–30 min normal feeds), conditional requests (ETag/If-Modified-Since), per-host queue with timeouts, exponential backoff, clear UA, cached last-success; 403/406/429/CAPTCHA ⇒ record failure, never bypass; throttled GDELT usage; no per-keyword hammering.

### 6.3 Source lineage (independence bookkeeping)

Every record carries `parentPublisherGroup`, `wireOrigin` (`AP | Reuters | AFP | PIB | UN… | none`) and `independenceStatus`. Syndicated copies of one wire dispatch, ministry scripts repeated by outlets, mirrored articles and repost-storms all collapse to one origin. Bluesky/GDELT independence = always `non_independent_signal` for verification purposes.

---

## 7. Clustering and selection

### 7.1 Deterministic clustering

Tokenise/normalise titles; lightweight named-entity extraction (curated aliases); token Jaccard / TF-IDF cosine; require temporal proximity + shared event/entity signal before merging; store cluster confidence + contributing source IDs; expose *why* two records merged; human split/merge supported. No embeddings API, no LLM clustering.

### 7.2 Editorial states (eligibility classes)

| State | Eligibility |
|---|---|
| Breaking news | Not eligible until independently corroborated (30–60 min confirmation window is the initial rule — a floor, **not** proof of accuracy). Urgent official statements may air earlier only with careful attributed wording + Gate A. |
| Developing news | Eligible with explicit as-of timestamp. Figures that change must stay attributed with times. |
| Established news | Eligible for deeper explanation and satire; the sweet spot for this format. |
| Forgotten/under-covered news | Eligible when original facts and present relevance can be established. Reporting that the story is rarely covered uses `low_coverage_in_monitored_sources` wording only. |

### 7.3 Candidate scoring (transparent, evidence-first)

| Signal | Weight |
|---|---:|
| Public significance | 25% |
| India relevance | 20% |
| Independent corroboration | 20% |
| Novelty / freshness | 15% |
| Under-coverage (low_coverage_in_monitored_sources) | 10% |
| Public impact | 10% |

Explainability is deliberately absent — one story must be understandable by any viewer, always (a requirement, not a virtue). **The score ranks; it never qualifies.** A story with inadequate evidence is ineligible regardless of score. Rotation across categories; under-covered discovery pass so the channel is not a trend-copier; Bluesky post-count or article-count never the sole importance measure.

### 7.4 Selection flow

1. Discover (permitted signals) 2. Cluster 3. Rank (weights above, reasons shown) 4. Verify (shortlist evidence shown with the list) 5. **User selects one story** 6. Produce (one story only). Scoring never overrides evidence handles GATE A later.

---

## 8. Evidence collection and the fact ledger (the heart)

### 8.1 Evidence workflow

1. Select cluster → 2. Collect original URLs + primary documents → 3. Read each permitted source (Tier B/C only — Tier A is never evidence) → 4. Decompose into atomic claims → 5. Record supports/contradicts/context per claim with locators → 6. Resolve conflicts via the primary record or preserve them explicitly → 7. **Human editor approves the ledger before scripting (Gate A input).**

### 8.2 Claim record schema (superset of the source spec §7.5)

```ts
type ClaimStatus = "verified" | "attributed" | "disputed" | "unverified" | "excluded";
type ClaimKind = "event" | "date" | "number" | "quote" | "identity" | "legal_status"
               | "cause" | "effect" | "claim_by_actor" | "forecast" | "analysis";

type EvidenceRecord = {
  sourceId: string; url: string; publisher: string;
  parentPublisherGroup: string; wireOrigin?: string;
  sourceRole: "primary" | "independent_reporting" | "discovery" | "social_signal" | "fact_check";
  policy: SourcePolicy;                     // copied snapshot — never infer later
  independenceStatus: IndependenceStatus;
  publishedAt?: string; eventDate?: string;
  locator?: string;                            // section / paragraph / page / filing item
  excerpt?: string;                            // short evidence excerpt ONLY — never archive whole articles
  supports: "supports" | "contradicts" | "context_only";
};

type FactRecord = {
  id: string;
  claim: string;                               // one atomic proposition
  kind: ClaimKind;
  status: ClaimStatus;
  importance: "core" | "supporting" | "optional";
  contentClass: "fact" | "interpretation" | "satire";   // §4.4
  evidence: EvidenceRecord[];
  independenceCount: number;                    // origins that support, not URLs
  conflictNote?: string;
  safeNarration?: string;                       // pre-approved attributed wording
  asOf?: string;                                // when the claim was true
  confidence: number;                            // 0..1, evidence-derived, not vibes
  verifiedByHuman: boolean;
};
```

Retention: store **metadata, URLs, dates, short excerpts, locators** — never whole copyrighted articles. `approved-facts.json` is persisted only after Gate A.

### 8.3 Minimum evidence treatment (claim-kind rules)

- Routine event/announcement — primary record + one independent report, **or** two genuinely independent reputable reports.
- What an institution announced — the institutional record supports "the institution announced/said X"; it does not prove the underlying claim.
- Court/legislative action — the actual judgment/order/bill/debate record; independent reporting for context and consequences.
- Political accusations — attribute to speaker; response sought; never presented as established.
- Conflict/casualty/fast-changing — multiple reporting origins or authoritative primary update; attribution + as-of time; conflicting figures ⇒ state figures differ or omit.
- Forecasts — labelled, attributed forecasts; never statements of fact.
- Viral/misinformation claims — original claim + relevant fact-check **analysis** (Snopes/FactCheck.org) or primary evidence; not the fact-check headline alone.
- Interpretation — separated (`contentClass="interpretation"`), who and whose.

If the only source is one report ⇒ explicit attribution + single-source label, if the human still wants coverage. Unsupported core claim ⇒ remove or block. **No connecting facts are invented for fluency.**

### 8.4 Independence rules (fail closed)

A source counts independent only when it is a distinct reporting origin or a primary record. Never counted: same-wire reprints; same-ministry press-release reprints; many social accounts echoing one post; syndicated mirrors. `independenceCount` drives eligibility thresholds; `same_original_source`/`unknown`/`syndicated` never add to it. The 30–60-minute breaking window is a *start* rule, not an accuracy guarantee.

### 8.5 Verification split: deterministic structural checks vs semantic assessment

Deterministic validation is authoritative for **structural** claims only. Semantic claim-to-evidence assessment is human-owned. Concretely:

| Validation | Authority |
|---|---|
| Numeric, date, currency, percentage, quantity, ranking | Deterministic code (numerals ↔ number-words normalised) |
| Names, offices, titles, places, orgs, model names, legal-status terms | Deterministic code (must match ledger) |
| Exact quotations | Exact/substring source match |
| Legal-status terminology ("proposed" ≠ "approved"; FIR ≠ conviction; benchmark claimed ≠ independently verified) | Deterministic code + attribution vocabulary |
| Fact-ID references, source provenance, independence bookkeeping | Deterministic code |
| Whether a sentence's meaning is faithful to its evidence ("claimed" vs "proved" strength), tone, satire correctness | **Human editor (Gate B)** |
| Editorial approval of the episode | **Human editor (Gate B → Gate C)** |

An LLM entailment pass may **flag** suspect sentences; it can never approve them, never overrule the deterministic checks, and never overrule the human editor. Groq never self-approves any factual claim — the writer and its validator are never the final authority, even separately. A script failing any deterministic structural check is rejected with specific errors; a script passing structure still faces Gate B. Governing asymmetry: an LLM may propose "this looks inconsistent"; only the editor may conclude "this is correct". (The Groq writer produces zero unsupported numbers in accepted runs by construction — that is necessary, not sufficient.)

---

## 9. Script generation ("bored, intelligent, slightly sarcastic")

### 9.1 Identity

Not a bulletin, not a meme rant. A slightly tired, intelligent person explaining something genuinely interesting while visibly annoyed to be working. Humour from writing and understatement, not from voice acting, not from shouting, not from lists of jokes.

### 9.2 Required structure (pacing references, not fixed timestamps)

| # | Segment | ~Allocation |
|---|---|---|
| 1 | Hook — sharpest verified point / sharp observation; never a misleading clickbait question | 0–5 s |
| 2 | What happened — plain-language core event + context/date | 5–18 s |
| 3 | What the evidence says — key facts, who claims what, conflicts preserved | 18–38 s |
| 4 | Why it matters — consequence for citizens/users/institutions/markets/tech | 38–52 s |
| 5 | Sarcastic observation — 1–2 dry hits on contradiction/incentives/bureaucracy/corporate language/politics theatre | 52–65 s |
| 6 | Punchline / takeaway — the most memorable fair line, or the genuine open question | 65–75 s |

~110–170 spoken words typical; audio duration is the real measure; the show may finish at 48 s or run to 85 s when the story earns it. **90 s ceiling is a technical guard configurable in `news-scene.json`; it is not an editorial rule** and never forces padding or compression.

### 9.3 Groq system-prompt rules (satire rules, verbatim intent)

1. Target power, decisions, institutions, contradictions, absurdity.
2. Never victims/ordinary citizens/vulnerable people as the punchline.
3. Never invented quotes or motives.
4. A weak claim may not be dressed up as a strong one by sarcasm.
5. Identical evidentiary standards for every party and ideology.
6. No artificial equivalence where evidence is genuinely unequal; no manufactured both-sidesing when one side is documented worse.
7. Intelligent understatement > loud jokes.
8. One good punchline beats five unnecessary jokes.

### 9.4 Structured output contract

```json
{
  "storyId": "story_2026_00123", "workingTitle": "New AI chip launch",
  "language": "en", "tone": "dry_sarcastic", "estimatedDurationSeconds": 62,
  "narration": [
    { "id": "N001", "text": "...", "factIds": ["F001"], "delivery": "dry_hook",
      "sceneMode": "opening", "contentClass": "fact" }
  ],
  "callouts": [
    { "id": "C001", "text": "A CLAIM IS NOT A BENCHMARK", "factIds": ["F003"],
      "highlightWords": ["NOT A BENCHMARK"], "triggerNarrationId": "N002",
      "priority": "high", "reveal": "type_on" }
  ],
  "sources": ["S001", "S002"],
  "editorialNotes": ["Company benchmark not independently verified."]
}
```

`narration[].contentClass` tags fact vs interpretation vs satire so no factual clause can hide in a joke. Groq may propose a callout only when the linked fact supports it — callouts may not be invented. One central story only.

### 9.5 Deterministic script validators (before any human sees it)

One story; strong first-sentence hook; every factual clause has ≥1 factId; numbers/names/dates/quotes pass §8.5; disputed facts attributed or removed; allegations never stated as findings; commentary excluded from factual word-count checks but counted for tone density; no paragraph over-dense; a fresh viewer can understand the story; nothing stronger than the ledger. Failure ⇒ specific, actionable errors; the run refuses to proceed. **Gate B** (human: script, highlights, callouts, notes) then reviews what already passed mechanics.

### 9.6 Quotas and failure behaviour

One generation + at most one rewrite on Gate B feedback. Deterministic TypeScript does all checks. No silent fallback to paid models; if free quota is insufficient, the episode stops at the ledger and manual scripting is permitted (`--manual-script`); the failure message says exactly what ran out (requests/tokens/day) per Groq's rate-limit headers.

---

## 10. Kokoro voice and pacing (English only)

### 10.1 Voice selection (no locking by name)

Same 25-second passage, identical text, speed, gain, compression:

1. `am_michael` (first English candidate)
2. `bm_george` (British comparison)
3. `am_fenrir`
4. `bm_fable`

Judge: naturalness, amused-not-acting delivery, intelligibility of Indian names/places/AI/political terms, phone-speaker presence over 60–75 s, no radio-gravitas drift. Lock the winner in `config/news-voice-profile.json`, record in render manifest; ship no other voices by default.

### 10.2 Delivery profile (initial, tuned by listening)

| Parameter | Initial |
|---|---|
| Base speed | 0.96–1.00 |
| Normal narration | ~140–155 WPM |
| Serious factual passage | ~130–145 WPM |
| Hook | slightly brighter, still relaxed |
| Punchline | slower + 180–300 ms pause before it |
| Warmth / aggression / exaggeration | moderate / low / none |
| Sarcasm delivery | understated (via writing + rhythm, not prosody sliders — Kokoro exposes voice + `speed` only) |

### 10.3 Chunking and regeneration

Kokoro performs weakly on tiny utterances and rushes long ones — group narration into natural beats (~100–200 tokens; avoid >400), keep the existing repo chunking behaviour, cache by text hash, and **regenerate only the affected chunk on a pronunciation correction** (the existing `pronunciation.ts` already separates spoken vs displayed text; Indian names, regional place names, political terminology, international names, acronyms and AI model identifiers receive per-episode pronunciation override files; captions/spelling never change).

### 10.4 Voice QA checklist

Listen to the *whole* narration; check names/acronyms/numbers/model IDs; track overrides + cache keys + audio hash in the episode manifest; no artificial pitch-shifting; re-check loudness after edits.

---

## 11. Visual scene: the lazy office, alive (English assets only)

### 11.1 Source of truth

`4.png` (with `5.png`, `6.png`, `10.png` as byte-different duplicates) is the **alignment authority**; `1,2,3,7,8,9.png` are layers on a common **941×1672** canvas. All are 8-bit **RGB** (no alpha) — confirmed. `1.png` = opaque office background. Warm muted palette (wall `#B6AC8E`, board wood `#95734F`, paper `#F1EEE5`, ink `#181715`, marker yellow `#F7C928`, card grey `#8E8F8E`, wood desk `#A78764`). No neon, globe, map, episode numbers, invented branding, unrelated scenery — ever.

### 11.2 Asset preparation (`tools/prep_lazy_news_assets.py`, offline tool; Pillow required)

Requirements: keep originals untouched; no global white color-key (would destroy shirt/paper/card edges); **per-asset, inspected component masks** — no globally fixed y-coordinate rules.

- Near-white pixels (`min(R,G,B) ≥ 243`) labelled via connected-components from frame borders ⇒ canvas region; everything else stays object. (Art style uses heavy black outlines, so interior whites of shirt/paper/card are enclosed and survive.)
- **Per-asset component report** printed for review; masks then built per asset with explicit rules:
  - `2.png` (board): drop only border-connected white; keep board + in-board paper + natural board shadow.
  - `3.png` (pin): pin + soft shadow only.
  - `7.png` (notes): both notes + clips + shadows; the two notes must be splittable into two independently movable sprites (`note-left.png`, `note-right.png`) with native-canvas origins.
  - `8.png` (narrator): narrator+chair as one layer; **drop detached cup/books components at the right edge** (they duplicate `1.png`'s props at the same coordinates — ghosting otherwise); hand-on-cheek pose preserved exactly.
  - `9.png` (grey card): drop the embedded pin component (`3.png` is the single pin); keep card, border, trapezoid shape.
  - `1.png`: copied unchanged (opaque); the character-shaped wall shadow is kept — it sits naturally behind the resting narrator.
- Halo control: 1 px mask erosion + ~1.2 px gaussian feather on alpha; white-fringe despill if present.
- Output: `assets/lazy-news/layers/*.RGBA.png` (+ references) — originals never modified; the ZIP stays the archival copy (`assets/lazy-news/original/`).
- **`--validate` mode**: compose 1→2→3→7a→7b→8→9 at native coordinates and pixel-diff against `4.png`; per-region report (only the paper area may differ once headline text is drawn; everything else near-zero delta); alpha-edge checkerboard montage printed.

### 11.3 Layer order and canvas

`1` background → `2` board → live headline text (visible from frame 0 — never make viewers wait) → `3` pin → `7a/7b` notes → `8` narrator → `9` card → live subtitle text. Stage renders at native 941×1672; export to 1080×1920 via **uniform scale with ≤2 px total crop/padding** (aspect ratio 941:1672 vs 9:16 differs by 0.05% — never stretch non-uniformly), 30 fps, H.264/yuv420p, faststart, AAC 48 kHz.

### 11.4 Scene states (narration-driven, never timers)

| Mode | Trigger | What happens |
|---|---|---|
| `opening` | video_start | Room visible; narrator slides in **from the left**, ease-out, ~450–700 ms, tiny settle; headline already on paper; first subtitle starts with voice. |
| `narration_focus` | speech segment | Narrator and card sharp; **background group only** dimmed 8–15% + 1–2 px blur; headline kept visible-but-subordinate; notes idle. |
| `board_callout` | editorial key point | Background restored; short line (3–8 words, ≤2–3 lines) marker/type-on reveal on the paper (`#F7C928` highlight for the key phrase, restrained red accent, ≤1 marker strip); 1.5–2.5 s hold; SFX = soft pin tap / marker write. |
| `return_to_narration` | after callout | Smooth return to narration focus (250–400 ms). |
| `closing` | final line | Land the takeaway/open question; no detached CTA. |

Narrator liveness: entrance once + 3–6 px idle breathing (y ± 0.5° tilt), occasional lean, envelope-linked micro-motion like the GitHub mascot; **no hand/face warp, no invented arms**, no mouth animation in v1 (single static illustration — respects the artwork; mouth-state swap only if you later supply 2–3 aligned states). Sticky notes: different phases, 2–4 px, 0.3–0.8°, paused during board typing. SFX only at real visual events; ducked under speech; never chained onto every subtitle.

### 11.5 Subtitles and callouts (from measured+aligned audio)

Text never baked into PNGs; live DOM text in the grey card and on the paper. Grey card inner padding respected; short phrases; break at natural pauses; phrase-reveal or word-highlight timing — never a slow per-word typewriter; lines that overflow split at natural boundaries (never shrink below phone-readable minimum); Reels safe-zone checked (right action rail + bottom caption bar overlay preview in the editor). Playback ends where aligned audio ends.

### 11.6 Editing tooling (your parity requirement — similar or more than GitHub)

- `npm run preview:news` — renders a **fixture episode** (fake ledger+script+voice sample; zero API calls, zero network) for layout iteration; instant.
- `npm run preview:news:live` (+ `Save My Edits` wrapper convenience, same pattern as the GitHub `Save My Edits.vbs/.cmd`) — local HTML with sliders/toggles: anchor x/y/scale, entrance duration + easing, idle amplitude, notes amplitude/phase/rotation, background dim % and blur px, callout font size/wrap/highlight style, subtitle font size/min-width, SFX gains, Reels safe-zone overlay; **one-click save back to `config/news-scene.json`** (typed, validated by `news-config-model.ts` + `news-config-writer.ts`, unit-tested like the GitHub config model).
- All animation parameters live in `config/news-scene.json` — no hard-coded timings in renderer code. Scene events reference narration segment IDs and aligned timestamps; timers never drive motion.

---

## 12. Audio pipeline and word-level alignment (REQUIRED — not optional)

### 12.1 What the repo already does (and why it is not enough)

Measured per-chunk audio durations (`voice.ts`), captions weighted by syllables + punctuation (`caption-overlay.ts`), Kokoro's `create_timed` returns zero timings (bundled model has no duration predictor), scene events keyed off chunk starts. This gives phrase-level timing — **not** word-level synchronization. Story beats, highlighted words and callout reveals need exact onsets.

### 12.2 New stage: `tools/align_audio.py` (free, local, offline; transcript-conditioned)

The approved script is known *before* alignment — the aligner must consume it, not re-transcribe. Whisper word timestamps are **not** a gold standard; use them only as a documented fallback.

```
Script (approved) → Kokoro chunks (~100–200 tokens) → narration.wav (measured)
        → TRANSCRIPT-CONDITIONED FORCED ALIGNMENT: approved text + audio
           candidate A: WhisperX alignment stage (wav2vec2 phoneme alignment)
           candidate B: Montreal Forced Aligner (acoustic models, English)
           (evaluate both where practical — §12.4)
        → per-word { word, startMs, endMs, probability } + phrase aggregates
        → reconcile against chunk timings (monotonic solve; words must lie
           inside their chunk; unassigned words interpolated by syllable weight)
        → narration-alignment.json (word | phrase | segment maps)
```

- Input: approved `narration.wav` + **approved script text** (the words Kokoro actually spoke, after the spoken-text pronunciation pass — never raw source).
- **Dependency description (corrected):** `faster-whisper` is a CTranslate2-based Whisper runtime — **not PyTorch** (torch is present in the Python environment, but it is not the faster-whisper dependency chain). WhisperX wraps CTranslate2 Whisper **plus** a separate wav2vec2 forced-alignment stage; Montreal Forced Aligner (MFA) needs pre-trained acoustic + pronunciation dictionaries. Both are free/local; both run on CPU in minutes for ~60 s audio.
- Fallback (documented, flagged): `faster-whisper` or whisper.cpp word timestamps, used only if forced alignment fails on a sample — never silently.
- `pip install` line gains the chosen aligner after evaluation (see §12.4); choice and model versions are recorded in render manifest.

### 12.4 Alignment acceptance test (mandatory, before any subtitle animation ships)

Token coverage is necessary, not sufficient. On **three complete narration samples synthesised on the target machine**:

| Metric | Requirement |
|---|---|
| Token coverage | ≥ 99% of script tokens matched |
| Timestamp monotonicity | 100% (non-decreasing start/end within and across chunks) |
| Word-boundary accuracy | Measured against manually annotated samples (report % within ±50 ms; set and record the target at annotation time — do not claim a number before measuring) |
| Chunk-boundary violations | **Zero** |
| Missing words | Explicitly listed in the alignment report (never silently interpolated) |
| Per-word confidence | Stored per word; used for subtitle weighting |

The subtitle/animation stage must not be implemented against this stage until the test passes on all three samples; if it cannot pass, chunk-measured captions remain the documented fallback and the episode ships with that flag in QA.

### 12.3 Loudness and mix

Reuse `sfx.ts` mix + `qa.ts` loudness: target Integrated ≈ **−16 LUFS**, True Peak ≤ **−1 dBTP**, gentle compression, SFX ducked under speech, room-tone optional. Store measured values in `qa-report.json`.

---

## 13. Database, migrations and honest GitHub regression

### 13.1 Versioned, reversible, transactional

- New table `schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)` — applied before any News tables are touched.
- Migration runner executes inside one transaction; failure ⇒ full rollback (GitHub untouched).
- Timestamped DB backup file written before migration (`output/news/backups/showcase-history-<ts>.db`) — automatic, no manual step.
- Additive only: `pipeline_runs` gains `channel TEXT NOT NULL DEFAULT 'github'`; new tables `story_candidates`, `source_records`, `fact_claims`, `editorial_approvals` (episode status, gates A/B/C). Never drop/rename GitHub columns.
- Every migration is reversible (`down`) where practical; restore-from-backup path documented.

### 13.2 GitHub regression guarantee (precise wording)

We guarantee: (1) no destructive GitHub changes; (2) no changes to GitHub business logic (discovery/selection/facts/scripting quality gates/mascot composition semantics); (3) existing GitHub tests (`npm test`) pass unmodified; (4) GitHub output class unchanged — verified by rendering the fixture repository before and after News integration and comparing QA metadata (dimensions, fps, duration, codec, audio streams); (5) any News failure isolation — News configuration/env not loaded on the GitHub path. `run.bat`, `package.json` and shared modules *will* change (menu, scripts, migration runner, alignment hooks); behaviour will not.

---

## 14. QA (news-specific checks layered on the existing suite)

- Captions: every caption phrase bbox fully inside grey card inner padding (DOM-measured); zero overflow; phone-readable sizes.
- Paper: headline/callout text bbox inside paper area; one `#F7C928` strip max; red accent restrained; word wrap deterministic.
- Blur isolation: background group dimmed while narrator+card stay pixel-sharp (sampled-region contrast check).
- Source credit (rule): the on-screen credit names only sources that support the approved facts — primary records or independent reporting — using `Based on reporting by: <outlet> — <date>`, or `Primary source: <agency/document> — <date>` for primary-record-led stories. Discovery-only outlets (BBC, Guardian-as-discovery, FT, Indian Express, Al Jazeera, NPR, CNBC, Wikipedia pointers…) **never appear** as corroborating sources; their URLs may live in `source-records.json` for audit but never on-screen. Credits generated from `source-credits.json` by filtering approved evidence by role (`primary`/`independent_reporting`) — never from the discovery tier. Format enforced inside the Reels safe zone with attribution preserved.
- Evidence contract: `evidence-ledger.json verifier=pass` + Gate A/B approvals recorded **before** frame capture starts (hard pre-render check, like the existing scriptability gate).
- Alignment: ≥99% tokens aligned; monotonicity 100%; zero chunk-boundary violations; missing words explicitly reported; monotonic bounds inside file bounds.
- Audio: loudness/true-peak targets; no clipping; narration fore of ducked SFX.
- Video: 1080×1920, 30 fps, yuv420p, AAC 48 kHz, duration within guard; no freeze/black/duplicate frames; all reference layers present (hash-checked against manifest).
- News episodes export artifacts as in §5.2; GitHub QA unchanged.

---

## 15. Approval model (mandatory, human, pre-render)

| Gate | What you see | Pass condition |
|---|---|---|
| **A — Factual package** | Story headline, event vs publication dates, category, score + reasons, shortlist position, source list with roles + permission state + independence groups, claim ledger with statuses/conflicts/as-of, missing-evidence warnings | You approve facts or request more sources (`Approve story` / `Need more sources` / `Edit fact` / `Reject` / `Hold`). |
| **B — Script & voice** | Full narration with fact IDs per line, callouts + highlights, subtitle preview, voice ID/speed/model, sample audio, duration; jokes visibly tagged as commentary | You approve or edit (`Approve script` / `Edit script` / `Regenerate wording` / `Regenerate voice` / `Reject`). |
| **C — Final render** | MP4 preview, alignment/QA summary, caption overflow check, safe-zone check, source-credit check | You approve before any publication; publishing remains a manual act outside the pipeline. |

Deterministic QA runs **before** each gate as a hard floor; the editor's review is the final editorial authority. No environment variable can soften this:

```ts
// pipeline.ts — mandatory order, under every configuration
if (!ledger.verifierPassed) throw new Error("EVIDENCE_VERIFICATION_FAILED");
if (!approvals.gateA?.approved) throw new Error("FACT_APPROVAL_REQUIRED");
if (!approvals.gateB?.approved) throw new Error("SCRIPT_APPROVAL_REQUIRED");
await renderEpisode();
// Gate C remains the final human review before publication — outside the renderer.
```

`--dry-run` prints A/B reports without producing media at any stage. Gate C is enforced by process and by publishing remaining a manual act — nothing in this repo posts anywhere automatically.

---

## 16. Environment and configuration

`.env.example` gains (all documented, GitHub section untouched):

```
# Lazy News (all optional; sensible defaults)
NEWS_CHANNEL=news                  # explicit channel when running via npm run start:news
NEWS_VOICE=am_michael              # set after Phase 7 audition
NEWS_MAX_SECONDS=90                # technical safety guard only (NOT editorial)
NEWS_DRY_RUN=0                     # 1 = produce reports, no media
GUARDIAN_API_KEY=                  # free non-commercial Developer key
GUARDIAN_LLM_ALLOWED=0             # 1 ONLY after written permission covering AI processing
NEWS_GUARDIAN_V1=0                 # hard disable Guardian adapter in v1 builds
NEWS_ALIGN_MODEL=whisperx          # aligner selection: whisperx | mfa | faster-whisper-fallback
NEWS_LOUDNESS_TARGET=-16           # LUFS integrated
# plus existing GITHUB-side keys, unchanged
```

All News behaviour flows from `config/news-*.json` (typed, zod-style validated loaders, `.env` overrides only where listed), never inline constants in code paths.

---

## 17. Episode artifacts (audit trail)

Per §5.2 bundle, plus `run.log` (GitHub convention), plus `gate-approvals.json` with timestamps and the exact content shown at each gate (or a pointer to evidence-ledger/script hashes) — so any episode can be audited later: which sources, what permissions, what independence, what you approved, what the model did.

---

## 18. Phase plan (re-prioritised) and effort

Effort is an **estimate, not a commitment** — re-baseline after Phase 0 proves permissions and alignment.

| Phase | Work | Acceptance / exit gate |
|---|---|---|
| **P0** | Baseline freeze; branch; GitHub smoke + `npm run check` + `npm test` green; DB backup; **source-permission registry with policy table (§4.3) implemented and failing closed**; alignment spike (`align_audio.py` on one Kokoro sample; accuracy vs known script) | Permissions engine enforces fail-closed in unit tests; alignment ≥99% on fixture; GitHub untouched-baseline documented. |
| **P1** | RSS/GDELT/Bluesky/manual adapters with caching/conditional requests/polling/backoff; normalisation; lineage; deterministic clustering; scoring (§9.4); rotation; shortlist selection (you pick) | Persisting deduplicated candidate list; same-event cluster collapses in tests; **no discovery source enters the ledger**; under-covered story beats celebrity fluff when evidence ties. |
| **P1** | Evidence collector + ledger + deterministic validator (§8) + Gate A report | Every core claim traceable; jokes can't launder numbers; `same_original_source` articles count once; unsupported ⇒ block. |
| **P1** | Approval workflow; Gate A (file + console) → Gate B pre-wire (editorial) | Approving nothing = no render (enforced); `--dry-run` shows evidence report in browser. |
| **P2** | Groq prompt with satire rules + script schema + deterministic validator (§9); one generation + one Gate-B-triggered rewrite; dry-run report | Unsupported claims/numbers/quotes/entities fail with reasons; jokes tagged; one-story invariant enforced. |
| **P2** | Kokoro audition (am_michael, bm_george, am_fenrir, bm_fable); voice locked into `config/news-voice-profile.json`; pronunciation override path tested | One approved voice; affected-chunk regen works; overrides reproducible. |
| **P3** | Asset prep (`prep_lazy_news_assets.py`) + composite validation vs `4.png`; scene builder; background focus group; sticky notes; narrator enter/idle; board callout (type-on/marker); subtitles from alignment; scene events; SFX ducking | Still composite matches reference; callouts & captions sync to word-level timing; text inside bounds; safe zones respected. |
| **P3** | Preview/edit tooling (`npm run preview:news`, live editor, one-click save to `config/news-scene.json`) | Offline fixture renders; editing a slider persists valid config; QA on fixture passes. |
| **P4** | News QA suite; history migration runner; dual-channel `run.bat`; four end-to-end episodes (Indian politics / geopolitics / AI litigation-or-chips / under-covered); GitHub regression render; full docs/README | Both channels ship from one launcher; GitHub QA metadata equal to baseline; episodes audit-ready. |
| **P4** | Optional after ship: mouth-state swap (if aligned art supplied); multi-language profile; long-form cut | Not in v1. |

Rough effort: P0 2 d · P1 6–7 d · P2 3 d · P3 3–4 d · P4 2–3 d ≈ **16–19 working days** including tests and review loops; treat ±30% as honest.

---

## 19. Verification notes (performed 2026-11-10; re-check before each release)

Relative reachability only — not a licence review: BBC world/tech RSS 200; Guardian world/uk RSS 200 and GDELT docs reachable; Al Jazeera RSS 200; NPR 200; CNBC world/tech/finance 200; FT RSS 200 (headline scope); Snopes 200; FactCheck.org 200; Politico 403 (browser-UA only); AFP RSS 403; GDELT DOC 2.0 ArticleList JSON confirmed keyless; Bluesky `searchPosts` confirmed keyless (`api.bsky.app` answered 5 posts from 15:03Z today carrying Reuters/BBC URLs; `public.api.bsky.app` returned 403 to the test client — host configurable, honour 429/backoff either way); Guardian Open Platform requires registration (`test` key ⇒ 401) — free key is non-commercial with call limits; Wikipedia Current Events renders daily human-edited items with per-item outlet citations (2026-11-10 page inspected) and is CC BY-SA (attribution needed if reused on-screen — used internally as corroboration). Source-term changes invalidate §4.3; `termsCheckedAt` exists for exactly this reason.

---

## 20. Acceptance criteria

### Data & sourcing
- [ ] No paid API/subscription; registry has explicit permissions + roles + `termsCheckedAt` + `licenseUrl` for enabled v1 sources; RSS/GDELT/Bluesky are discovery only; duplicates/syndication never counted as corroboration; primary documents attached where relevant.
- [ ] Fail-closed enforced: unknown/false permission source text never reaches Groq (unit-tested).

### Verification & scripting
- [ ] Every factual line maps to ≥1 approved factId; every number/date/name/quote passes the structural verifier; allegations never stated as findings; one story per episode; sarcasm aims at power; `contentClass=satire|interpretation|fact` tags present; structural determinism is demonstrable (numbers/entities/quotes/provenance); semantic claim-to-evidence assessment is human-gated (Gate B); Groq never approves its own claims; human Gate A and Gate B recorded before render; Gate C recorded before publish; on-screen credits name only supporting sources (never discovery-only outlets).

### Audio & voice
- [ ] Existing local Kokoro reused; same-text audition done for the four voices; one `news-voice-profile.json`; base 0.96–1.00; hook brighter; serious passages 130–145 WPM; 180–300 ms punchline pause; captions align to final audio via word-level alignment; loudness/true-peak within target; overrides reproducible; manifest records voice/speed/hashes.

### Video & integration
- [ ] GitHub pipeline behaviour preserved (no destructive changes; tests green; fixture QA equal to baseline).
- [ ] `run.bat` selects channel; master frame is alignment authority; white details survive mask prep; noticeboard text stays on paper; subtitles stay in grey card; background blur affects only the background group; scene events retime with narration; notes/narrator motion subtle and pause during typing; output 1080×1920 H.264/yuv420p/30 fps; Reels safe zones respected; final MP4 human-approved.

---

## 21. Implementation constraints for the agent

1. Do not start with a crawler; registry + permissions engine first (P0).
2. Never RSS headlines/feeds as the script source; signals rank, they don't testify.
3. Never send whole publisher articles to an LLM; the ledger is the only window.
4. Never count syndicated copies as confirmations; check `independenceStatus`.
5. Never let the LLM invent callouts; callouts link to fact IDs or labelled commentary.
6. No new TTS stack; existing Kokoro only; word alignment added beside it (§12), not inside it.
7. Preserve the supplied art; do not redesign the office scene; masks only.
8. Database migrations only via the versioned runner; backup first; additive only.
9. Do not bypass blocks/paywalls; on refusal from a source, use another permitted route or drop the claim.
10. Human gates A/B/C are mandatory on every episode; no unattended publish path.
11. News failure must never break the GitHub channel (isolated code path, isolated env, isolated DB writes; GitHub smoke-runs in P4).
12. Everything observable: why a story ranked, what verifies each fact, why a source is independent, what the model saw, what you approved.

---

## 22. Open items (user decisions; none block P0)

1. Pursue **written Guardian permission** for AI processing (opens optional Guardian evidence adapter behind `GUARDIAN_LLM_ALLOWED=1`)? Otherwise Guardian stays discovery-only indefinitely.
2. Review/approve BBC terms for any richer use, or accept discovery-only permanently?
3. Show/channel name, branding lockup, and whether GitHub channel ever cross-promotes (default: never).
4. Voice lock decision after Phase 7 audition samples.
5. Final approval of `NEWS_MAX_SECONDS` guard value (default 90 s).
6. Mouth-state artwork for v2 (optional): 2–3 aligned mouth shapes if liveness upgrade is wanted later.

---

## 23. References

- BBC — feeds/business-use terms: https://www.bbc.com/usingthebbc/terms-of-use · RSS: https://feeds.bbci.co.uk/news/world/rss.xml
- The Guardian Open Platform — access levels/Developer key: https://open-platform.theguardian.com/access/ · API: https://content.guardianapis.com/search
- GDELT DOC 2.0 — https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ · https://gdeltproject.org/data.html
- Bluesky — API hosts: https://bsky.network/docs/api-directory/ · rate limits: https://bsky.network/docs/rate-limits/ · searchPosts: https://docs.bsky.app/docs/api/app-bsky-feed-get-feed
- Kokoro-82M — model card: https://huggingface.co/hexgrad/Kokoro-82M · voices: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md · inference: https://github.com/hexgrad/kokoro
- Groq rate limits: https://console.groq.com/docs/rate-limits
- SEC EDGAR APIs / fair access: https://www.sec.gov/search-filings/edgar-application-programming-interfaces · https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- Government India: PIB RSS `https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=1` · RBI `https://www.rbi.org.in/Scripts/rss.aspx` · MEA `https://www.mea.gov.in/rss-feeds.htm` · Digital Sansad `https://sansad.in/ls/memberPortal/questions` · ECI `https://www.eci.gov.in/issue-details-page/press-releases` · MoSPI `https://mospi.gov.in/latest-releases`
- Wikipedia Portal:Current events (2026-11-10 inspected): https://en.wikipedia.org/wiki/Portal:Current_events/2026_November_10
- Fact checkers: https://www.snopes.com/feed/ · https://www.factcheck.org/feed/
- Existing internal docs: `Lazy_News_Automated_Reel_Production_Brief.md`, `Lazy_News_Logical_Data_Sourcing_and_Scripting_Implementation_Plan.md`, `docs/GitHub-Showcase-*-Plan.md`, `docs/TODO.md`.

---

## 24. Changelog

**Revision FINAL IMPLEMENTATION SPECIFICATION (2026-11-10)** � architecture review repairs only; no redesign:

1. Source permissions: category-level grants replaced by individual `SourcePolicy` entries per domain � documentType with explicit `permissionBasis` (`public_domain | explicit_license | written_permission | terms_reviewed | discovery_only | unknown`); unknown ? disabled; `termsCheckedAt` is an audit field, not proof; 90-day terms-check expiry degrades to discovery-only; loader rejects `llmProcessingAllowed` without `fullTextFetchAllowed`/`quotationAllowed`.
2. Audio alignment: corrected the dependency description (`faster-whisper` = CTranslate2, not PyTorch); primary path is transcript-conditioned forced alignment of the approved script (WhisperX wav2vec2 alignment or MFA, evaluated on-machine on three samples); Whisper timestamps are documented fallback only; �12.4 defines the acceptance table (=99% coverage, 100% monotonicity, zero chunk-boundary violations, explicit missing-word reporting, per-word confidence) and blocks subtitle animation until it passes.
3. Mandatory approvals: `NEWS_INTERACTIVE_REVIEW` removed; Gate A + Gate B are enforced by code (`FACT_APPROVAL_REQUIRED` / `SCRIPT_APPROVAL_REQUIRED`) under every configuration; Gate C mandatory before publication.
4. Verification duties split: structural determinism (numbers/dates/names/quotes/legal-status/provenance/FactIDs) vs semantic claim-to-evidence/tone/satire (human editor); Groq can flag, never approve; "deterministic final authority" language removed.
5. Source credits: generated from approved evidence by role (primary / independent_reporting only); discovery-only outlets never on-screen; dates + attribution preserved.
6. Text errors fixed: "Russian names�" ? Indian/regional/political/AI-identifier override scope; "Karan's eyes" ? "The editor's review is the final editorial authority."

Architecture preserved: two channels, shared infra, claim-level ledger, three independently persisted packages, GitHub pipeline unchanged in behaviour, mandatory pre-render human approval, offline fixture preview, manual publishing only. Do not redesign this document; implement it.
