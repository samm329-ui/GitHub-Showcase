# Lazy News — Logical Pipeline, Data Sourcing, Verification, Scripting and Voice Implementation Plan

**Project:** Lazy News / sarcastic news-commentary reel channel  
**Document type:** Agent-ready implementation specification  
**Prepared:** 10 November 2026  
**Architecture rule:** Add a second channel; do not replace, delete, rename destructively, or break the existing GitHub Showcase pipeline.

---

## 0. Executive direction

We already have a working GitHub Repository Showcase video automation pipeline. We are adding a second pipeline for one-story-at-a-time news commentary videos. Both pipelines must remain in the same codebase and be selectable from one `run.bat` launcher.

The news pipeline has two connected but separate systems:

1. **Editorial and logical pipeline:** discover stories, aggregate sources, cluster duplicates, verify claims, choose one story, create a factual ledger, write a sarcastic but accurate script, approve it, generate narration with the existing Kokoro TTS setup, and produce timing data.
2. **Video and editing pipeline:** take the approved narration, captions, story callouts and scene events and render them through the visual system described in `Lazy_News_Automated_Reel_Production_Brief.md`.

The video should feel like a lazy, dryly sarcastic office commentator explaining one real story to the viewer. It should not feel like a conventional news bulletin or a rapid-fire headline roundup. The character's personality creates the humour; the factual content creates the substance.

### Non-negotiable constraints

- No paid APIs, paid subscriptions, paid news feeds or paid TTS services.
- Use existing services and keys only when they are already available at no additional charge. A free tier is optional and must never be treated as unlimited.
- Use TypeScript/Node for the news orchestration and rendering integration. Do not introduce Python or Playwright into this pipeline.
- Keep the current GitHub Showcase pipeline working exactly as it does today.
- Do not let an LLM act as the fact-finder. Source documents and the fact ledger are the evidence; the LLM is a writing assistant.
- One video explains one story. Do not turn this into a multi-story roundup.
- Target roughly one minute, but do not force a fixed duration. Natural completeness and clarity are more important than hitting exactly 60 seconds.
- Every video must pass a human review of the source ledger, script and final render before it is approved for publication.

---

## 1. High-level system architecture

```text
                         ONE run.bat LAUNCHER
                                  |
                   Choose a channel / pipeline
                         /                 \
                        /                   \
          GITHUB SHOWCASE               LAZY NEWS
          existing pipeline             new pipeline
          unchanged                     |
          |                             v
          |                      NEWS DISCOVERY
          |                      RSS / official sources
          |                      GDELT / Bluesky
          |                      manual URL / tip
          |                             |
          |                             v
          |                      STORY CLUSTERING
          |                      dedupe + topic/category
          |                             |
          |                             v
          |                      STORY SELECTION
          |                      relevance + novelty
          |                      under-covered signal
          |                             |
          |                             v
          |                      SOURCE COLLECTION
          |                      primary documents
          |                      independent reports
          |                             |
          |                             v
          |                      CLAIM / FACT LEDGER
          |                      support + conflicts
          |                      dates + source lineage
          |                             |
          |                             v
          |                      HUMAN FACT REVIEW
          |                             |
          |                             v
          |                      SCRIPT GENERATION
          |                      factual narrative + humour
          |                             |
          |                             v
          |                      SCRIPT VERIFICATION
          |                      entity / number / quote checks
          |                             |
          |                             v
          |                      HUMAN SCRIPT APPROVAL
          |                             |
          |                             v
          |                      KOKORO VOICE GENERATION
          |                      waveform + timings
          |                             |
          |                             v
          |                      SCENE / CAPTION MANIFEST
          |                             |
          |                             v
          |                      SHARED RENDER / AUDIO / QA
          |                             |
          |                             v
          |                      HUMAN FINAL APPROVAL
          |                             |
          |                             v
          |                      EXPORT / HISTORY
```

The two channels may reuse shared infrastructure, but their content logic must remain isolated. A GitHub repository showcase must never accidentally enter the news-story code path, and a news story must never be passed to GitHub-specific repository parsing.

### Shared components worth reusing from GitHub Showcase

Reuse existing modules when they already do the job reliably:

- Kokoro TTS adapter and audio file handling.
- FFmpeg export and muxing.
- Existing 9:16 renderer / browser capture / frame composition.
- Subtitle and word-timing pipeline.
- Audio mixing, loudness measurement, SFX handling and ducking.
- Render queue, QA checks, retry handling and SQLite history.
- Existing scene/timeline event handling where it is genuinely generic.
- Existing configuration, logging, output folders and progress display conventions.

Do **not** copy or force-fit GitHub-only functionality such as repository scraping, README rendering, GitHub mobile capture or repository-specific text layouts into the News channel.

### New News-only components

- Source registry and publisher permission policies.
- RSS/Atom source adapters.
- GDELT discovery adapter.
- Bluesky public-post discovery adapter.
- Optional primary-document adapters for Indian government, parliament, court, regulator and global institution sources.
- Story clustering, duplicate detection and coverage scoring.
- Claim-level evidence ledger and source-independence graph.
- Political / geopolitical verification rules.
- News script templates, sarcasm rules and script validator.
- News-specific editorial event manifest for subtitle and noticeboard callouts.
- News episode history and source bibliography.

---

## 2. The one-runner / two-pipeline requirement

The existing `run.bat` must become the single entry point, but the GitHub path must remain the same underneath it.

### Proposed launcher menu

```text
========================================
         VIDEO AUTOMATION STUDIO
========================================

[1] GitHub Repository Showcase
[2] Lazy News Commentary
[0] Exit

Choose pipeline:
```

After the user selects `2`, show News-specific options:

```text
NEWS COMMENTARY

[1] Discover stories
[2] Enter a story URL manually
[3] Open saved / pending stories
[4] Resume an unfinished news episode
[0] Back
```

After choosing discovery, show topic categories:

```text
[1] Indian politics and public policy
[2] Geopolitics and international relations
[3] AI and the AI industry
[4] Technology and science
[5] Under-covered / overlooked developments
[6] Mixed discovery (all enabled categories)
```

Then show these per-episode options:

- Language: English initially; Hindi can be added through a separate voice profile after testing. Do not assume fluent English-Hindi code-switching is automatic.
- Delivery: dry / sarcastic / more serious. Default is dry sarcasm with a serious factual core.
- Length: auto, aiming around 45–75 seconds. Allow a shorter or longer result when the story needs it; never pad with filler.
- Story: choose from the candidate list or enter a URL manually.
- Continue: collect evidence, approve facts, draft, approve script, make voice, preview and render.

### Technical requirement

Use a channel argument internally, for example:

```text
VIDEO_CHANNEL=github
VIDEO_CHANNEL=news
```

or an equivalent typed enum. Keep the old GitHub command behavior intact. The launcher is a selector, not a rewrite of the GitHub pipeline.

### Regression protection

Before editing the launcher, record the existing GitHub flow and run its current smoke test. After every integration phase, test both selections. The GitHub path must continue to produce the same type of output without requiring news-source configuration, a new API key or a News database migration to be manually performed by the user.

---

## 3. News categories and editorial scope

The News pipeline covers five broad categories:

| Category | What qualifies | What the script should explain |
|---|---|---|
| Indian politics and public policy | Elections, parliamentary decisions, bills, court decisions, government actions, state policy, public expenditure, political accountability | What happened, which institution or person did what, what the document actually says, what changes for people, and what remains disputed |
| Geopolitics | India and its neighbours, major-power relations, conflict, diplomacy, sanctions, trade disputes, international institutions | Confirmed events, what each party says, what independent evidence exists, and what the likely implications are without pretending forecasts are facts |
| AI news | New models, AI products, research, safety incidents, chip launches, business and regulatory moves | What is actually new, what has been benchmarked or demonstrated, what is only a company claim, and why it matters |
| Technology and science | Cybersecurity, consumer technology, major infrastructure, space, science, energy and engineering | The practical change, the evidence, the limitations and the wider consequence |
| Under-covered / overlooked stories | Material developments with low coverage in the system's monitored source set, or important developments that have lost attention | Why the story matters, why it may have been missed, what evidence supports it and what is still unknown |

### Under-covered stories — important wording rule

The system must not automatically claim that a story was “ignored by the media” or “hidden” merely because GDELT found few articles. GDELT coverage is a measurement of its monitored corpus, not the whole media universe. Use internal labels such as `low_coverage_in_monitored_sources` and human-facing wording such as “a story receiving less attention in the sources we monitor”.

### One episode = one central story

The script can explain context and consequences, but it must keep one central event or development. Related background facts are supporting context, not additional headlines. If two stories only share a broad topic, they must become separate episodes.

---

## 4. Free-first data sourcing strategy

The base system must work without any paid news API or paid key. It should use public feeds, public endpoints and first-party documents. The source registry must classify what each source is permitted to do; **publicly reachable does not automatically mean licensed for automated extraction or republication**.

### Tier A — discovery signals (not proof)

#### A1. RSS and Atom feeds

Use a configurable list of public RSS/Atom feeds. They are useful for detecting newly published items and obtaining a headline, publication date, short description and original article URL.

Initial official-source feed candidates:

- Press Information Bureau (PIB) press releases: `https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=1`
- Reserve Bank of India RSS index: `https://www.rbi.org.in/Scripts/rss.aspx`
- Ministry of External Affairs RSS index: `https://www.mea.gov.in/rss-feeds.htm`
- UN Geneva RSS index: `https://www.ungeneva.org/en/news-media/rss`
- Official company/research feeds where the publisher's own site publishes one, for example OpenAI News (`https://openai.com/news/rss.xml`) and NVIDIA RSS (`https://www.nvidia.com/en-us/about-nvidia/rss/`). Check the source's terms before using a feed for any commercial or automated publishing activity.

RSS is a **discovery layer**. A feed headline is not enough to write a factual sentence. The original publication or primary record must be checked.

#### A2. GDELT DOC 2.0

Use GDELT as a global coverage and article-discovery signal:

- Endpoint family: `https://api.gdeltproject.org/api/v2/doc/doc`
- Use ArticleList mode and JSON output for discovery records.
- Search with topic terms, names, locations and date windows.
- Use the result to find which outlets are covering a subject, when the coverage appeared and whether the story is receiving broad or limited attention.
- GDELT's DOC 2.0 documentation describes a rolling three-month search window and JSON/JSONP support. It is a coverage index, not a complete article-text or source-of-truth API.
- GDELT's open data is useful as a no-key discovery layer; keep the GDELT Project attribution/link in the internal source record and in published source notes when its data is used.

Do not cite GDELT as evidence that a particular event happened. Follow the article links and verify the actual publisher or primary record. The API may throttle or change; use a modest request queue, cache results, inspect rate-limit responses and back off. Do not hammer it with one request per keyword.

#### A3. Bluesky public API

Bluesky is useful for discovering what reporters, researchers, institutions and subject experts are discussing. Use the public AppView host for public reads:

```text
https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=<encoded-query>&limit=...
```

Use the `public.api.bsky.app` host for public use cases. Respect returned rate-limit headers and `429` responses. Bluesky explicitly notes that rate limits can evolve.

Rules:

- A post is a lead, not a verified fact.
- Check whether the author is the original source, a journalist linking to reporting, an organisation, a witness or an anonymous account.
- Follow links to the original document or report.
- A repost, quote-post or many accounts repeating one post do not count as independent corroboration.
- Never treat a Bluesky discussion trend as representative public opinion.

Do not scrape X/Twitter, use Nitter or bypass an API paywall. Bluesky is an optional signal, not a substitute for X access and not a factual authority.

#### A4. Manual URL / user-provided tip

Always keep a manual story input route. It is useful when the user sees an interesting post or an obscure story that the automated sources missed. Manual input still goes through the same evidence and approval gates; a supplied URL does not bypass verification.

### Tier B — primary records and direct evidence

These are the strongest sources for what an institution formally did, published, decided or recorded.

#### India

- PIB: press releases and ministry statements. Useful to establish what a ministry announced or claimed; not independent proof of every claim in that release.
- Digital Sansad: Lok Sabha and Rajya Sabha questions, answers, bills, debates and session material. Parliamentary answers are primary records of what a ministry answered.
- Election Commission of India: election schedules, notifications, results, orders and press releases.
- Supreme Court of India SCR portal and official judgments/orders. For a court story, read the actual judgment/order and distinguish the court's holding from a lawyer's argument or media interpretation.
- Ministry of External Affairs: official statements, media briefings, bilateral documents and press releases.
- RBI: policy statements, notifications, speeches and data releases.
- Ministry of Statistics and Programme Implementation (MoSPI): CPI, PLFS, GDP and other statistical releases.
- CAG reports, official gazettes, budget documents, regulator notices and other original government records where relevant.
- PRS Legislative Research: useful independent legislative analysis and explainers. Treat it as an analytical source, not the legal text itself.

#### Geopolitics and international institutions

- UN press releases, Security Council records, agency reports and official meeting summaries.
- Official foreign ministry and regulator statements from the countries involved.
- Public treaty texts, sanctions registers, court orders, shipping/aviation notices and other original documents where relevant.
- World Bank, IMF, WHO, IAEA, UNHCR and other institutional reports for data within their remit.

#### AI and technology

- Official company newsroom and product/research pages.
- Technical model cards, benchmark cards, release notes, developer documentation and repositories.
- arXiv papers and conference papers for research claims; distinguish a preprint from peer-reviewed work.
- NIST/CISA advisories and other regulator/security advisories for security claims.
- SEC EDGAR and data.sec.gov for U.S. company filings. SEC's `data.sec.gov` APIs do not require an API key; identify the client with a meaningful User-Agent/contact and comply with the SEC fair-access limit (currently no more than 10 requests per second across the user). Use it only for relevant U.S. issuer filings, not as a general news feed.

### Tier C — independent reporting and corroboration

Use independent news organisations and specialist publications to corroborate the event, add context and identify disputed interpretations. Keep a reviewed registry of the actual publisher, parent company, wire-service source, topic expertise and permitted use.

Do not count multiple websites as independent when they are republishing the same AP/Reuters/AFP wire story or a common press release. Record the original wire source and treat all copies as one reporting origin for corroboration.

For each publisher, maintain a `sourcePolicy` entry. Example values:

- `metadata_discovery_only`
- `article_read_allowed`
- `full_text_api_allowed_noncommercial_only`
- `full_text_api_allowed_with_license`
- `primary_document`
- `social_signal_only`
- `blocked_until_terms_review`

### Rights and terms guard — do not skip

- The Guardian's Developer key is explicitly for non-commercial use; its page currently lists up to 500 calls/day and 1 call/second, with article-text access. The same page says commercial use of Guardian journalism requires a commercial key and pricing. Do not make the free developer key a dependency for a commercial channel.
- BBC's terms state that business use of its RSS feeds requires permission and may involve a fee. Do not silently build a commercial ingestion pipeline around BBC RSS or extraction.
- The Indian Express RSS page says its RSS consumption is for personal and non-commercial use, and separately reserves rights in its articles. Do not treat that feed as a free commercial source.
- Similar permission checks must be made for every publisher. A freely accessible webpage is not a blanket licence to scrape full text, republish articles, reuse images, or store entire copyrighted articles.

**Practical default:** the pipeline can discover through public metadata where its terms allow it, then support the reporting process with primary documents and independently sourced facts. Store short evidence excerpts, URLs and metadata rather than archiving/reproducing entire articles. Narration must be original writing. Do not use publisher photographs or video clips unless the licence or permission clearly allows it.

### Not a dependency for v1

- Guardian API: optional only if the channel's use qualifies under the Developer non-commercial terms; no paid tier is assumed.
- NPR API: do not build around a presumed general-purpose NPR API unless a current, official, usable API and its terms are independently confirmed. The plan does not require it.
- Google Fact Check Tools API: optional secondary lookup only. It requires an API key and is not a replacement for original verification. Do not block v1 on it.
- Paid news APIs, premium search APIs, paid AI models, paid TTS, paid image/video services: excluded.

---

## 5. Source registry and polling behaviour

Do not hard-code feed URLs across the codebase. Make a source registry, ideally JSON or TypeScript configuration, with these fields:

```ts
type SourceDefinition = {
  id: string;
  name: string;
  canonicalDomain: string;
  sourceType: "rss" | "atom" | "api" | "primary_page" | "document" | "social";
  categories: string[];
  regions: string[];
  language: string[];
  sourceRole: "primary" | "independent_reporting" | "discovery" | "social_signal" | "fact_check";
  parentPublisherGroup: string;
  wireOrigin?: string;
  sourcePolicy: string;
  pollIntervalMinutes?: number;
  enabled: boolean;
};
```

Implementation rules:

- Poll feeds conservatively, initially every 15–30 minutes for normal feeds; set slower intervals for sources that update less frequently.
- Use `ETag` and `If-Modified-Since` where supported.
- Cache the last successful result and do not fetch the same item repeatedly.
- Use a single per-host queue with timeouts, retry limits, exponential backoff and a clear user-agent.
- Record `publishedAt`, `updatedAt`, `firstSeenAt` and `fetchedAt` separately. Do not confuse publication date with event date.
- Handle time zones explicitly. Store canonical times in UTC and display in the selected local timezone.
- Persist raw feed metadata and normalised records for audit. Do not rely on an in-memory feed list.
- If a source returns 403, 406, 429, CAPTCHA or an access block, do not work around it. Record the failure and use another permitted source or request manual evidence.
- Feed parsing must safely handle malformed XML, missing dates, relative URLs, Unicode and duplicate GUIDs.

---

## 6. Story clustering, deduplication and selection

The pipeline must first identify **events**, not simply collect a list of headlines. One event may generate dozens of similar headlines from different publishers.

### 6.1 Normalise every incoming item

Normalise the title and summary, strip tracking parameters from URLs, canonicalise domains, extract publication timestamps, identify language, and store named entities where available. Keep the original title and URL unchanged in the source record.

### 6.2 Cluster likely duplicates

Use deterministic TypeScript logic first:

- Tokenise and normalise headline text.
- Extract key named entities and locations using a lightweight local library or curated aliases.
- Compare title similarity (token Jaccard / cosine TF-IDF) and named-entity overlap.
- Require temporal proximity and a shared event/entity signal before merging.
- Store a cluster confidence and the source IDs that contributed to it.
- Allow a human to split or merge clusters.

Do not require a paid embeddings API. A local embedding model is not necessary for v1. Keep the algorithm observable: display why two records were clustered.

### 6.3 Candidate scoring

Use a transparent score, not an opaque LLM ranking. Suggested initial weights:

| Signal | Weight | What it means |
|---|---:|---|
| Public significance | 25% | Does the story affect policy, rights, safety, economy, technology or a meaningful group of people? |
| India relevance | 20% | Direct impact on India, Indian institutions, Indian users or Indian interests. |
| Independent corroboration | 20% | Do distinct reporting origins or a primary record support the key event? |
| Novelty / freshness | 15% | Is there a genuine new development, not just another rewrite of an old story? |
| Under-coverage opportunity | 10% | Is there meaningful substance with relatively low coverage in the monitored corpus? |
| Explainability | 10% | Can one story be explained clearly in a short video without stripping away essential nuance? |

The score sorts candidates; it does not automatically decide what the audience should see. The user selects the story. Show the evidence and scoring reasons beside every candidate.

### 6.4 Avoid a popularity-only feed

Rotate categories and include a discovery pass for overlooked developments. Do not use the count of Bluesky posts, GDELT articles or RSS feeds as the only measure of importance. A highly viral rumour may be low-value or false; an important regulatory release may have little social activity.

---

## 7. Verification and the fact ledger

This is the most important logical component. Headlines are signals. A single outlet is not the truth. The script may use only facts that have been entered into the approved fact ledger.

### 7.1 Evidence workflow

1. Select one event cluster.
2. Collect the original source URLs and relevant primary documents.
3. Read each permitted source. If full-text access is not allowed, use the available headline/metadata only as a lead and obtain evidence through another permitted route.
4. Break the story into atomic claims: one sentence should express one checkable proposition.
5. For each claim, record which sources support it, which disagree, whether the source is primary or secondary, and whether the source is independent of the others.
6. Compare numbers, dates, names, quotes, geography and status words exactly.
7. Resolve disagreements by going to the primary record or by explicitly preserving the disagreement in the eventual script.
8. Human editor approves the ledger before the script is drafted.

### 7.2 Source independence rules

A source is independent only when it represents a distinct reporting origin or primary record. These do **not** count as independent sources:

- Multiple publishers copying the same AP/Reuters/AFP wire dispatch.
- Several websites repeating the same ministry press release without independent reporting.
- Many social accounts repeating the same original post.
- An article and its own syndicated mirror.

Store a `parentPublisherGroup` and `wireOrigin` so the verifier can identify these cases.

### 7.3 Minimum verification thresholds

Use claim-level status, not one vague “story verified” flag.

| Claim type | Minimum safe treatment |
|---|---|
| Routine event / announcement | Prefer one primary record plus one independent report, or two genuinely independent reputable reports. |
| What an institution announced | The original institutional release can support “the institution announced/said X”. It does not by itself prove every underlying claim is true. |
| Court or parliamentary action | Use the actual judgment, order, bill, debate, question or official record. Use independent reporting for context and consequences. |
| Political accusation / allegation | Attribute it to the speaker. Seek the response from the other party or institution. Never present an allegation as an established fact. |
| Conflict / casualty / fast-changing figure | Require multiple reliable reporting origins or an authoritative primary update; show attribution and as-of time. If figures conflict, state that they differ or omit the number. |
| Forecast / prediction | Label it as a forecast and attribute it. Do not turn it into a factual statement. |
| Viral claim / misinformation | Locate the original claim and a relevant fact-check or primary evidence. Do not rely only on a fact-check headline. |
| Interpretation / analysis | Keep separate from fact. Explain whose interpretation it is, including that it may be the show's analysis. |

If the only available source is one report, the script may use it only with explicit attribution and a single-source label, if the human reviewer decides it is still worth covering. If an essential claim is unsupported or disputed, remove it. Do not invent a connecting fact to make the story sound complete.

### 7.4 Breaking-news delay

For fast-moving stories, start with a 30–60 minute confirmation window where practical. Do not publish a breaking claim just because it appears in one feed. A genuinely urgent official statement may be covered earlier only with careful attribution (for example, “the ministry says…”) and human approval. The system must label the source timestamp and the event timestamp separately.

### 7.5 Fact-ledger schema

```ts
type ClaimStatus = "verified" | "attributed" | "disputed" | "unverified" | "excluded";
type ClaimKind =
  | "event" | "date" | "number" | "quote" | "identity" | "legal_status"
  | "cause" | "effect" | "claim_by_actor" | "forecast" | "analysis";

type EvidenceRecord = {
  sourceId: string;
  url: string;
  publisher: string;
  parentPublisherGroup: string;
  wireOrigin?: string;
  sourceRole: "primary" | "independent_reporting" | "discovery" | "social_signal";
  publishedAt?: string;
  eventDate?: string;
  locator?: string;       // section, paragraph, table, document page, filing item
  excerpt?: string;       // short evidence excerpt only; do not store whole articles
  supports: "supports" | "contradicts" | "context_only";
};

type FactRecord = {
  id: string;
  claim: string;           // one atomic claim
  kind: ClaimKind;
  status: ClaimStatus;
  importance: "core" | "supporting" | "optional";
  evidence: EvidenceRecord[];
  conflictNote?: string;
  safeNarration?: string; // attributed wording approved for narration
  verifiedByHuman: boolean;
};
```

Every material sentence in the script should reference one or more `FactRecord.id` values. Commentary and jokes should be tagged separately so that a factual statement cannot hide inside a joke.

### 7.6 Numeric, name and quote verification

Before a script reaches the voice stage:

- Every number, date, currency, percentage, quantity and ranking must map to a fact-ledger entry.
- Convert number words and numerals to a comparable form during validation (e.g. “twenty-five” and `25`).
- Verify names, offices, titles, places, organisations, model names and legal status against the ledger.
- Exact quotations must match the source text and be attributed. Prefer paraphrase over long direct quotation. Use only short quotations where essential.
- The verifier must reject a script if it contains an unsupported number, a new named entity, an unapproved quote or an overstated legal status.
- If a source says “proposed”, the script must not say “approved”. If an FIR is filed, the script must not say “convicted”. If a company claims a benchmark result, the script must say the company claims/reports it unless independently benchmarked.

An LLM-based entailment pass may flag possible problems, but it cannot overrule the deterministic checks or human evidence review.

---

## 8. Script writing: sarcastic, clear and factual

The script should sound like a slightly tired, intelligent person explaining a ridiculous or consequential event—not an excited TV anchor and not a meme account shouting at the viewer.

### 8.1 Recommended structure

Use this as a flexible outline, not a rigid timer:

1. **Hook (first 2–4 seconds):** Start with the most interesting verified point or a sharp observation. Do not use a misleading clickbait question.
2. **What happened:** State the core event in plain language. Give the date or context where necessary.
3. **What the evidence says:** Explain the key facts and who is making each claim.
4. **Why it matters:** Explain the consequence for citizens, users, institutions, markets or technology.
5. **Sarcastic angle:** Make one or two original, dry observations about the contradiction, incentives, bureaucracy, corporate language or political theatre.
6. **Punchline / takeaway:** Finish with the most memorable but fair line. If there is a genuine open question, leave the viewer with it.

A typical episode may be about 110–160 spoken words, but use the actual audio duration as the final measure. Allow around 45–75 seconds in the normal case. A complex story may be longer; a small but sharp story may be shorter. Never add filler solely to reach one minute.

### 8.2 Humour rules

- Aim sarcasm at powerful decision-makers, institutions, policies, corporate claims, public contradictions and absurd processes.
- Do not make victims, ordinary citizens, vulnerable groups or people suffering harm the punchline.
- Do not make a factual claim more extreme just to make the joke stronger.
- Keep the audience able to tell the difference between verified fact, allegation, inference and the show's opinion.
- Avoid defamatory claims, invented motives, invented quotes and false causal relationships.
- For Indian politics, do not become a campaign advertisement for any party. Apply the same verification and attribution standards regardless of party or ideology.
- For geopolitics, do not repeat propaganda or casualty claims as fact. Attribute each side's claim and show where independent confirmation is available.
- Do not use sarcasm to obscure uncertainty. A careful line can still be funny.

### 8.3 Script format

The script generator must return structured data, not a single unstructured paragraph. Example:

```json
{
  "storyId": "story_2026_00123",
  "workingTitle": "New AI chip launch",
  "language": "en",
  "tone": "dry_sarcastic",
  "estimatedDurationSeconds": 62,
  "narration": [
    {
      "id": "N001",
      "text": "Another company has announced a chip that is going to change everything.",
      "factIds": ["F001"],
      "delivery": "dry_hook",
      "sceneMode": "character_focus"
    },
    {
      "id": "N002",
      "text": "Here is what the announcement actually confirms.",
      "factIds": ["F001", "F002"],
      "delivery": "measured_explanation",
      "sceneMode": "subtitle_focus"
    }
  ],
  "callouts": [
    {
      "id": "C001",
      "text": "A CLAIM IS NOT A BENCHMARK",
      "factIds": ["F003"],
      "highlightWords": ["NOT A BENCHMARK"],
      "triggerNarrationId": "N002",
      "priority": "high"
    }
  ],
  "sources": ["S001", "S002", "S003"],
  "editorialNotes": ["Company result is not independently benchmarked."]
}
```

The script generator must never invent the `factIds`. They are chosen from the approved ledger. It may suggest a callout only when the linked fact supports it.

### 8.4 Script validation gates

- One central story only.
- The first sentence is a clear hook, not a generic greeting.
- Every factual clause has a fact ID.
- Numbers, dates, names, titles and quotes pass the verifier.
- Disputed facts are attributed or removed.
- Jokes are distinguishable from reported facts.
- The script contains no claim stronger than the ledger.
- The story can be understood by someone who has not already read the article.
- No paragraph is needlessly dense; use natural speech, short sentences and explanations of unfamiliar terms.

---

## 9. Human review is mandatory

Do not make this a fully unattended publish pipeline. It can automate the repetitive work, but the user must approve the editorial choices.

### Approval gate A — story and evidence

Show:

- Story headline and category.
- Event date and publication dates.
- Candidate relevance score and why it ranked.
- Source list with publishers, source type and links.
- Independence groups (so syndicated duplicates are obvious).
- Fact ledger with statuses and conflicts.
- Missing evidence warning.

Buttons/actions: `Approve story`, `Reject`, `Need more sources`, `Edit fact`, `Hold for update`.

### Approval gate B — script and voice preview

Show:

- Full narration script.
- Fact IDs beside the lines they support.
- Board callout text and highlights.
- Subtitle preview.
- Kokoro voice ID, speed and sample audio.
- Estimated duration.

Buttons/actions: `Approve script`, `Edit script`, `Regenerate wording`, `Regenerate voice`, `Reject`.

### Approval gate C — final render

Show the final MP4 preview, source credits, audio peak/loudness QA, caption overflow QA and any unresolved warnings. The user explicitly approves before publication/export handoff.

---

## 10. Kokoro TTS — voice identity and delivery

The character is a lazy, sarcastic adult office commentator. The voice must feel like a warm, slightly amused male narrator who is mildly inconvenienced by having to explain the news. It must not sound like a dramatic trailer voice, a breaking-news presenter, a cartoon villain or an overly sleepy whisper.

### 10.1 Keep Kokoro local / existing

Use the Kokoro integration already present in the GitHub Showcase project. Do not add a paid TTS provider. Kokoro-82M is an open-weight model with Apache-2.0 model weights; the runtime and its dependencies still need a separate license review before redistribution as a packaged application.

The official voice list includes English male options such as `am_michael`, `am_fenrir`, `bm_george` and `bm_fable`, and Hindi male voices `hm_omega` and `hm_psi`. The published voice list also shows that voice quality and training duration differ; do not pick a voice solely based on its ID or name.

### 10.2 Voice audition before locking the show voice

Create the same 20–25 second audition passage using:

- `am_michael` — first English candidate.
- `am_fenrir` — second English candidate.
- `bm_george` — British English comparison.
- `bm_fable` — another British English comparison.

Use exactly the same text, speed and post-processing for each sample. Compare:

1. Naturalness and clarity.
2. Ability to sound casually amused without overacting.
3. Intelligibility of Indian names, place names, political terms and technology names.
4. Whether the voice is comfortable to listen to for a 60–75 second video.
5. Whether the low-energy delivery still has enough presence on a phone speaker.

Do not assume that one of these voices has an Indian English accent. The current official list names American, British, Hindi and other language voices; it does not list a dedicated English-India voice. If the show needs English narration with a clearly Indian accent, test the available voices honestly and do not disguise an accent mismatch with heavy processing.

For a Hindi episode, separately audition `hm_omega` and `hm_psi` with native Hindi sentences. For Hinglish, do not assume sentence-level or word-level code-switching will be flawless. Test it with the actual vocabulary and names; if the code-switching is poor, keep the narration in one language per episode or use approved sentence-level language chunks with careful joins.

### 10.3 Initial delivery profile

Start with these values and tune by listening to the generated samples:

| Parameter | Initial target | Purpose |
|---|---|---|
| Voice character | Warm, mature, mid/low register, conversational | Fits the lazy caricature without sounding unprofessional |
| Attitude | Dry, understated, mildly amused | Sarcasm comes from timing and wording, not shouting |
| Base speed | `0.96–1.00` | Slightly relaxed but still clear |
| Normal pace | Approximately 140–155 words/minute | Gives the viewer time to understand the story |
| Hook | Approximately 150–165 words/minute when the line is short | Starts with energy without turning into a shout |
| Serious / sensitive facts | Approximately 130–145 words/minute | Keeps numbers, names and context clear |
| Punchline | Slightly slower, with a short pause before it | Lets the joke land |
| Pause before punchline | About 180–300 ms as a starting point | Creates dry comedic timing |
| Sentence break | Natural punctuation and a short pause | Prevents run-on narration |
| Warmth | Natural, close, non-radio-announcer | Avoids harsh or robotic presentation |

These are starting production values, not guaranteed Kokoro controls. Kokoro's core inference exposes a voice and `speed` parameter; do not assume it accepts a natural-language emotion prompt such as “sound sarcastic”. Warmth and sarcasm are produced through voice choice, writing, sentence rhythm, punctuation, pauses, and restrained audio processing.

### 10.4 Do not make every subtitle a TTS chunk

Avoid generating each tiny subtitle independently. Kokoro's voice documentation notes weaker performance on very short utterances and rushing on long utterances. Group the narration into natural paragraph / beat chunks of roughly 100–200 tokens when practical, and avoid giant chunks over about 400 tokens. The exact chunk size should be tested against the existing local implementation.

Generate the audio from the approved script, then align subtitles to the final audio. Do not derive final subtitle timing from estimated reading speed if the existing caption/word-timing system can measure the real audio.

### 10.5 Voice QA

- Listen to the full rendered narration, not just the first sentence.
- Check names, acronyms, numbers, model IDs and place names.
- Use the pronunciation dictionary / phoneme override route if the current Kokoro integration supports it.
- Keep a per-episode pronunciation override file; never silently change the written spelling in the displayed captions.
- Re-generate only the affected narration chunk after a pronunciation correction, then re-run audio alignment.
- Avoid artificial pitch shifting to make the voice “more masculine”. The voice should suit the caricature naturally.
- Store `voiceId`, `speed`, model version, text hash, pronunciation overrides and output audio hash in the episode manifest.

### 10.6 Audio finishing

Reuse the existing audio pipeline. Suggested initial targets for review:

- Keep narration clearly in front of music and sound effects.
- Aim for consistent loudness between episodes; use the existing loudness meter rather than guessing by waveform height.
- As an initial social-video target, audition around `-16 LUFS integrated` and keep true peak at or below `-1 dBTP`; adjust if the current pipeline has an established, tested delivery standard.
- Use gentle compression, not aggressive radio compression.
- Use low-level room tone only if it improves the scene.
- Side-chain/duck sound effects under speech.
- Do not use music or SFX to hide an awkward pause or weak script.

---

## 11. Scene events generated from the script

The renderer must not invent visual events. The script package produces an editorial timeline, and the visual renderer interprets it.

### Scene modes

- `opening`: room is visible; narrator enters from the left and settles; main headline is already visible on the board.
- `narration_focus`: narrator and subtitle card stay sharp; background group becomes slightly dimmer/softer so captions are easy to read.
- `board_callout`: return the environment to normal focus; show a short important fact, number or punchline on the paper with a restrained typing/writing reveal.
- `return_to_narration`: smoothly lower background emphasis again and continue with the next subtitle beat.
- `closing`: finish on a meaningful final line, not an unrelated CTA.

### Important point

A board callout is not required for every paragraph. Use it for only the most important 2–5 moments in a normal one-minute episode, depending on the story. Each callout must have a reason and must be linked to a fact ID or a clearly labelled editorial punchline.

### Example event contract

```ts
type NewsSceneEvent = {
  id: string;
  startMs: number;
  endMs: number;
  mode: "opening" | "narration_focus" | "board_callout" | "return_to_narration" | "closing";
  narrationIds: string[];
  factIds: string[];
  subtitleText?: string;
  boardText?: string;
  highlightWords?: string[];
  boardReveal?: "type_on" | "fade_in" | "marker_reveal";
  backgroundFocus?: "normal" | "dim_soft_blur";
  narratorMotion?: "entrance" | "idle" | "subtle_tilt" | "settle" | "none";
  stickyNoteMotion?: "idle" | "pause" | "small_flutter";
  sfx?: string[];
};
```

Use narration audio time as the canonical clock. If TTS duration changes, regenerate the alignment and scene-event timestamps. Do not rely on fixed second marks that drift when a script is edited.

---

## 12. Visual production contract and reference frame

The master reference for the scene is `4.png` / `10.png` in `Lazy news.zip`. Files `5.png` and `6.png` are duplicate composite references. Preserve the original asset layout and visual hierarchy; the logical pipeline may update text, but it must not redesign the master composition.

### Canvas and output

- Master artwork canvas: `941 × 1672` pixels.
- Aspect ratio: approximately 9:16.
- Default final export: `1080 × 1920` pixels.
- Frame rate: 30 fps unless the existing tested GitHub export profile is already using a different stable frame rate; keep the channel profile explicit and do not silently alter GitHub output.
- Video: MP4 / H.264, `yuv420p`, fast-start metadata.
- Audio: AAC, 48 kHz final mix.
- Preserve the master composition's aspect ratio when scaling. The master is 941 × 1672, which differs very slightly from exact 9:16; do not stretch the image non-uniformly. Fit and crop/pad the sub-pixel difference evenly.

### Layer inventory

| Asset | Role | Required treatment |
|---|---|---|
| `1.png` | Full office background | Opaque base layer; retain wall, left shelf/plant, desk and room objects. |
| `2.png` | Noticeboard with blank paper | Extract the board from its white canvas; preserve the white paper inside it. |
| `3.png` | Red pushpin | Extract only pin and natural shadow; preserve exact reference coordinates. |
| `4.png` | Master composite reference | Alignment authority; reference only, do not use as the live final layer. |
| `5.png` | Duplicate composite | Reference only. |
| `6.png` | Duplicate composite | Reference only. |
| `7.png` | Two sticky notes | Extract both notes, clips and shadows; animate very subtly and independently. |
| `8.png` | Narrator and chair | Extract character/chair cleanly; preserve the hand-on-cheek pose and full silhouette. Inspect overlaps with desk-side props already in the base image. |
| `9.png` | Grey subtitle card | Extract the card; remove the white source canvas. Render captions as separate live text. |
| `10.png` | Master composite reference | Duplicate reference; use to check final alignment. |

Important: all original PNGs in the ZIP are RGB files, not RGBA. Do not use a global white color key. It would damage the white shirt, board paper and card. Prepare proper object-aware alpha masks and retain originals unchanged.

### Reference placement map

All items share the same 941 × 1672 source canvas. Keep each asset's native canvas origin and alignment. The values below are visual reference zones to help the agent validate the composite; the actual pixel alignment must be measured from the supplied master images, not re-guessed by eye:

| Element | Approximate zone in master canvas | Notes |
|---|---|---|
| Office background | `x=0..941`, `y=0..1672` | Full-frame fixed background. |
| Corkboard outer frame | `x≈130..890`, `y≈134..745` | Upper-right / upper-middle visual anchor. |
| White headline paper | `x≈170..825`, `y≈295..660` | Main story headline and selected callouts. |
| Red pin | `x≈520..585`, `y≈255..340` | Fixed above paper. Do not duplicate the pin embedded in any other layer. |
| Sticky notes | `x≈575..840`, `y≈650..810` | Small independent motion only. |
| Narrator + chair | `x≈25..915`, `y≈645..1335` | Foreground anchor. Preserve reclining proportions. |
| Subtitle card | `x≈65..875`, `y≈1265..1445` | Keep all live subtitle text inside its inner safe area. |
| Desk / lower table | approximately `y≈1240..1510` | Fixed background furniture; no new props. |

These rough bounds are not instructions to crop the transparent assets to those boxes. Keep the full common canvas so the objects land in the same coordinates. Create a still composite, overlay it against `4.png`, and require a near-pixel match before animating.

### Typography and palette

The master is raster artwork, so it does not contain recoverable font metadata. Use the following as a visual match, not as a claim about the original embedded font:

- Noticeboard headline: heavy bold italic sans-serif, black / near-black, visually close to `Montserrat ExtraBold Italic` or `Inter ExtraBold Italic`.
- Yellow-highlighted headline phrase: same heavy italic face, black text over a warm saturated yellow marker strip.
- Subtitle: bold or semibold italic sans-serif, white, centered, on the grey rounded/trapezoid caption card.
- Supporting sticky-note writing: light, small dark handwriting / neutral sans, not a new headline.

Approximate scene palette from the reference:

| Use | Approximate colour |
|---|---|
| Warm wall | `#B6AC8E` |
| Corkboard / wood midtone | `#95734F` |
| White paper | `#F1EEE5` |
| Headline ink | `#181715` |
| Yellow marker | `#F7C928` |
| Muted charcoal clothing | `#45413D` to `#615B54` |
| Grey subtitle panel | `#8E8F8E` |
| Subtitle text | `#FFFFFF` |
| Warm wood desk | `#A78764` |

Do not introduce neon colors, glowing outlines, a world map, a new studio set or unrelated branding. Contrast should come from the existing character clothing, warm corkboard and clear text hierarchy.

### Instagram-safe text placement

The subtitle card is a designed container and must remain in its chosen position. The live subtitle text must stay inside the card's inner padding and must not overflow. Validate the finished frame against a current Instagram Reels UI preview; keep key words away from the right-side interaction rail and bottom caption/control region. Do not blindly move the whole card upward if the user-approved master composition does not require it. If the caption is too long, split it into natural phrases rather than shrinking it until unreadable.

---

## 13. Timing, movement and attention control

The purpose of movement is to keep the frame alive without turning it into a busy template.

- Character entrance: slide from left to the reference resting position, ease out, tiny settle, then remain mostly still.
- Character idle: very small breathing / upper-body drift only. Do not animate the supporting hand or distort the face/body. Use prepared expression variants only if they can be aligned cleanly.
- Sticky notes: different slow phases, tiny position changes and very small rotation. Pause during important board typing.
- Background focus: when narration is the focus, dim/soften the room and board subtly, not the character or subtitle text. Return to normal during the board callout.
- Board callout: type or marker-reveal a short key line on the paper. The text must remain within the paper. Do not move the whole board.
- Subtitles: show short spoken phrases in sync with the final narration. Use phrase-by-phrase or word-highlight timing; avoid a slow typewriter effect that makes the caption lag behind speech.
- Sound effects: only when the viewer sees a meaningful event—paper pin, marker writing, note flutter, chair movement or a transition. Duck under speech.

Use the existing renderer and timeline where possible. A scene event must reference narration segment IDs and actual audio timing, not just an unrelated animation timer.

---

## 14. Technical contracts and storage

### Proposed folder structure

Adapt to the repository's actual structure after the initial audit. Do not move existing files just to match this example.

```text
src/
  channels/
    github/                 # existing pipeline; preserve
    news/
      discovery/
        rss-adapter.ts
        gdelt-adapter.ts
        bluesky-adapter.ts
        manual-source.ts
      sources/
        source-registry.ts
        source-policy.ts
        primary-documents.ts
      clustering/
        normalise-item.ts
        cluster-stories.ts
        score-candidates.ts
      verification/
        evidence-collector.ts
        source-lineage.ts
        fact-ledger.ts
        claim-validator.ts
      editorial/
        story-selector.ts
        script-prompt.ts
        script-schema.ts
        script-validator.ts
        satire-rules.ts
      voice/
        news-voice-profile.ts
        pronunciation-dictionary.ts
        narration-builder.ts
      scene/
        scene-event-builder.ts
        callout-planner.ts
        subtitle-planner.ts
      pipeline.ts
  shared/                   # existing generic modules; reuse carefully
    tts/
    captions/
    audio/
    render/
    qa/
    persistence/
config/
  news-sources.json
  news-source-policies.json
  news-categories.json
  news-voice-profile.json
```

### Episode artefact bundle

Every news run should save a reproducible episode folder, for example:

```text
output/news/<episode-id>/
  candidate.json
  source-records.json
  evidence-ledger.json
  approved-facts.json
  script.json
  script.txt
  pronunciation-overrides.json
  narration.wav
  narration-alignment.json
  scene-events.json
  render-manifest.json
  source-credits.json
  qa-report.json
  final.mp4
```

Do not store whole copyrighted article bodies unless a source's licence permits it and retention is necessary. Prefer metadata, URLs, publication dates, short evidence excerpts and exact document locators.

### Example render manifest

```json
{
  "channel": "news",
  "episodeId": "news_2026_00001",
  "storyId": "story_2026_00123",
  "canvas": { "width": 941, "height": 1672 },
  "export": { "width": 1080, "height": 1920, "fps": 30 },
  "voice": { "engine": "kokoro", "voiceId": "am_michael", "speed": 0.98 },
  "assets": {
    "background": "1.png",
    "board": "2.png",
    "pin": "3.png",
    "stickyNotes": "7.png",
    "narrator": "8.png",
    "subtitleCard": "9.png",
    "masterReference": "4.png"
  },
  "sceneEvents": "scene-events.json",
  "captions": "narration-alignment.json",
  "sourceCredits": "source-credits.json",
  "approval": {
    "factsApproved": true,
    "scriptApproved": true,
    "finalRenderApproved": false
  }
}
```

### Database changes

If the existing SQLite history is shared, use additive migrations only:

- Add a `channel` column with a default that preserves existing GitHub rows.
- Add news-specific tables for `story_candidates`, `source_records`, `fact_claims`, `episode_scripts` and `editorial_approvals`, or equivalent typed records.
- Add indexes for story IDs, source IDs, publication times and episode status.
- Never drop, rename destructively or rewrite existing GitHub records.
- Make migration reversible where practical, and back up the database before applying it.

---

## 15. Free-tier model / LLM usage policy

Do not introduce a paid LLM dependency. The news pipeline should still function if no LLM API key is configured: story discovery, clustering, source verification, numeric checks, subtitle layout and rendering are deterministic code; script drafting can be done manually.

If the repository already has a Groq integration and the account currently offers no-cost API usage, it may be reused behind the existing provider router. Do not assume free limits are permanent or unlimited. Groq's official documentation says limits depend on organization, model and rate dimensions (requests, tokens and daily usage); the exact limits are visible in the account console and response headers. The pipeline must read rate-limit headers, throttle requests and handle `429` responses. Do not enable a paid Developer plan or any spend-based route.

Suggested economical call pattern:

- One structured script-generation call using the already-approved fact ledger.
- One optional rewrite call only after user feedback.
- Use deterministic TypeScript validators for numbers, proper nouns, quote checks, source references and schema validation.
- Do not send every fetched article to an LLM. This wastes quota and increases the chance of source blending.
- No LLM-generated citations. Every source ID must already exist in the registry and evidence ledger.

If the existing free quota is unavailable or insufficient, stop at the approved fact ledger and permit manual scripting. The system must not silently fall back to a paid provider.

---

## 16. Suggested implementation phases

### Phase 0 — repository audit and freeze the working GitHub path

- Inspect the actual repository, `run.bat`, current pipeline entry points, shared modules, output structure, SQLite schema, Kokoro setup, caption timing and FFmpeg export.
- Record baseline commands and outputs for a known-good GitHub Showcase job.
- Identify which modules are generic and which are GitHub-specific.
- Create a feature branch for the News channel.
- No refactor of the working GitHub path in this phase.

**Exit gate:** the existing GitHub pipeline still runs unchanged and its current smoke test passes.

### Phase 1 — one launcher, two isolated channels

- Add the channel menu to `run.bat`.
- Wire `[1] GitHub Showcase` to the existing entry point.
- Wire `[2] Lazy News` to a new news entry point.
- Add a minimal news skeleton that can display a manual story URL and save an empty episode workspace.
- Add safe default configuration so the GitHub pipeline does not require News environment variables.

**Exit gate:** both menu choices work; GitHub output remains unchanged.

### Phase 2 — source registry and free discovery adapters

- Implement RSS/Atom parsing with caching, conditional requests and per-host limits.
- Add GDELT article discovery.
- Add Bluesky public search as a social-signal adapter.
- Add manual URL entry.
- Add source permission policy checks.
- Add the initial official-source registry: PIB, RBI, MEA, Digital Sansad, ECI, Supreme Court SCR, MoSPI, UN and selected technology-company primary sources.

**Exit gate:** a News discovery run produces a persistent, deduplicated candidate list with URLs and timestamps, without paid APIs.

### Phase 3 — story clustering and candidate ranking

- Implement deterministic title/entity/time clustering.
- Add source ownership and wire-origin lineage.
- Add candidate scoring with visible reasons.
- Add category filters and under-covered signals.
- Add a human story selection screen.

**Exit gate:** several headlines about the same event appear as one story cluster and the user can select one story.

### Phase 4 — evidence collection and fact ledger

- Add primary-document URL capture.
- Add claim-level fact ledger and evidence locators.
- Add source independence checks.
- Add conflict/status flags.
- Add number, date, entity, quote and legal-status verification.
- Add a human evidence review screen.

**Exit gate:** no script can proceed until the core facts are approved or explicitly marked as attributed/single-source.

### Phase 5 — structured script generation and satire validation

- Add one-story script templates.
- Add the dry-sarcastic style guide.
- Use only approved facts as the LLM context.
- Add script JSON schema and deterministic validators.
- Add callout selection linked to fact IDs.
- Add human script approval and editing.

**Exit gate:** script lines can be traced to facts, and unsupported entities/numbers/quotes fail validation.

### Phase 6 — Kokoro voice profile and narration QA

- Reuse existing Kokoro runtime.
- Produce same-text audition samples for `am_michael`, `am_fenrir`, `bm_george` and `bm_fable`.
- Select one approved English voice profile after listening; create a separate Hindi profile only after native-language testing.
- Add speed, pronunciation overrides and cache keys.
- Generate approved narration and derive word/phrase timing using the existing caption pipeline.

**Exit gate:** the narrator voice is approved, names are pronounced correctly, and final audio timing is available to the scene builder.

### Phase 7 — connect the news script to the visual renderer

- Use the already-approved master frame and separated layers.
- Prepare correct RGBA masks without destroying white areas.
- Recreate a static composite and compare against `4.png` / `10.png`.
- Build scene-event JSON from script callouts and narration alignment.
- Connect opening motion, background focus, board typing, subtle sticky-note movement, subtitle reveal and sound cues.
- Reuse existing FFmpeg, audio, caption and QA modules where possible.

**Exit gate:** still composite matches the reference; animated output remains aligned to the spoken audio; text stays within the noticeboard and grey subtitle card.

### Phase 8 — complete QA and dual-pipeline release

- Add source-credit output and an episode audit bundle.
- Add QA for story freshness, evidence approval, script verification, pronunciation, caption overflow, safe-zone position, audio peaks, duration and export integrity.
- Test a complete India politics story, a geopolitics story, an AI story and an overlooked story.
- Test the GitHub Showcase menu path again.
- Confirm that database migration preserves existing history and that the two output channels remain separated.

**Exit gate:** both pipelines work from one `run.bat`; one News episode can be produced end-to-end with no paid API dependency and mandatory human approvals.

---

## 17. Acceptance criteria

### Data and sourcing

- [ ] The pipeline uses no paid news API or paid subscription.
- [ ] Source registry has explicit permissions and source roles.
- [ ] RSS, Bluesky and GDELT are used for discovery, not treated as fact sources.
- [ ] Every story candidate has publication time, event time if known, original URLs and source identity.
- [ ] Duplicate/syndicated articles are not counted as independent sources.
- [ ] Primary documents are attached where appropriate.
- [ ] Under-covered scoring is clearly labelled as a monitored-corpus signal.

### Verification and scripting

- [ ] Every factual script line maps to one or more approved fact IDs.
- [ ] Every number, date, named entity and quote passes verification.
- [ ] Disputed facts are qualified or removed.
- [ ] Allegations are not written as findings or convictions.
- [ ] Satire targets decisions, power or absurdity—not victims.
- [ ] One episode covers one central story.
- [ ] Human approval is required before voice and render stages.

### Kokoro and audio

- [ ] Existing local Kokoro runtime is reused.
- [ ] English voice auditions have been compared with identical test text.
- [ ] A single approved show voice profile is stored in config.
- [ ] Pace is conversational and dry, not rushed or artificially sleepy.
- [ ] Pronunciation overrides are tracked and reproducible.
- [ ] Captions align to final generated audio, not estimated script duration.
- [ ] Final mix passes loudness and true-peak checks.

### Video and integration

- [ ] Existing GitHub Showcase still runs.
- [ ] `run.bat` offers both channels.
- [ ] The master frame is the alignment authority.
- [ ] White objects survive alpha-mask preparation.
- [ ] Noticeboard text stays on the paper.
- [ ] Subtitle text stays inside the grey card.
- [ ] Background focus effects do not blur narrator or subtitles.
- [ ] Scene events retime when narration duration changes.
- [ ] Final render is previewed and manually approved before publication.

---

## 18. Important implementation decisions for the agent

1. **Do not start by coding a large autonomous news crawler.** Start with the small source registry and a modest number of high-value feeds.
2. **Do not use RSS headlines as the script source.** They are leads only.
3. **Do not send a stack of articles directly to Groq and ask it to decide the truth.** Build the evidence ledger first.
4. **Do not count duplicated wire stories as multiple confirmations.** Track source lineage.
5. **Do not let the LLM invent visual callouts.** Callouts must link to approved facts or clearly labelled commentary.
6. **Do not build a new TTS stack.** Reuse Kokoro and the existing audio pipeline.
7. **Do not redesign the visual scene while implementing the logical pipeline.** Use the supplied master frame and the separate layers.
8. **Do not break or delete the GitHub Showcase pipeline.** Keep both channels independently selectable from one launcher.
9. **Do not publish automatically.** Human review is part of the product design, not an optional final step.
10. **Keep the implementation observable.** The user should be able to see why a story was selected, what verifies each fact, why a source counts as independent, why the script says what it says, and which voice/render settings were used.

---

## 19. Current reference links and verification notes

The following pages were checked while preparing this plan. API limits and terms can change; re-check before implementation and keep policies in configuration rather than hard-coding assumptions.

### Public discovery and data

- [Bluesky API hosts and authentication](https://bsky.network/docs/api-directory/) — recommends the public AppView hostname for public reads.
- [Bluesky rate limits](https://bsky.network/docs/rate-limits/) — limits can evolve; observe response headers and 429 responses.
- [Bluesky `searchPosts` API reference](https://docs.bsky.app/docs/api/app-bsky-feed-get-feed) — public API reference and host details.
- [GDELT DOC 2.0 API documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) — ArticleList, JSON output, language coverage and rolling search window.
- [GDELT data and APIs](https://gdeltproject.org/data.html) — overview of data and API access.
- [PIB RSS feeds](https://www.pib.gov.in/ViewRss.aspx?lang=1&reg=1) — official Government of India press-release feed listing.
- [RBI RSS index](https://www.rbi.org.in/Scripts/rss.aspx) — official release, notification, speech and publication feeds.
- [MEA RSS index](https://www.mea.gov.in/rss-feeds.htm) — official foreign ministry feed index.
- [UN Geneva RSS](https://www.ungeneva.org/en/news-media/rss) — official UN press releases and meeting-summary feeds.
- [Digital Sansad questions and answers](https://sansad.in/ls/memberPortal/questions) — official parliamentary question/answer records.
- [Election Commission of India press releases](https://www.eci.gov.in/issue-details-page/press-releases) — official election authority releases.
- [MoSPI latest releases](https://mospi.gov.in/latest-releases) — official statistical releases.
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) and [fair-access rules](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) — data APIs do not require keys; scripted access must comply with the User-Agent and request-rate rules.

### Voice

- [Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M) — open-weight model, Apache-2.0 model licence and model overview.
- [Kokoro voice inventory](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) — current listed voices, language families and quality/training-duration notes.
- [Kokoro inference repository](https://github.com/hexgrad/kokoro) — usage, language codes, voice selection, 24 kHz output and `speed` parameter examples.

### LLM quota handling and source-use terms

- [Groq rate-limit documentation](https://console.groq.com/docs/rate-limits) — limits vary by organisation/model and should be read dynamically.
- [Guardian Open Platform access levels](https://open-platform.theguardian.com/access/) — free Developer access is non-commercial; commercial use has a separate paid access level.
- [BBC digital-services terms](https://www.bbc.com/usingthebbc/terms-of-use) — business RSS use requires permission.
- [Indian Express RSS terms](https://indianexpress.com/rss/) — states RSS use is personal and non-commercial.
- [Google Fact Check Tools API](https://developers.google.com/fact-check/tools/api/reference/rest) — optional API requiring an API key; not a core dependency.

---

## Final instruction to the implementation agent

Treat this document as the specification for a second channel, not a replacement project. First inspect the working GitHub Showcase repository and map the reusable modules. Then implement the News channel in isolated folders, add the menu to the existing `run.bat`, and preserve current GitHub behavior. Start with source discovery and a human-reviewed fact ledger; only after the logical pipeline is dependable should the team connect it to the visual scene and render a complete episode.
