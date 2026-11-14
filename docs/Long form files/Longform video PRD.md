# **GitHub Video Automation — Long-form implementation review**

I've reviewed the complete 632-line Architecture Discovery Audit, including the integration feasibility matrix, persistence architecture, reliability assessment, technical risks and outstanding questions.

My conclusion is that **we should build Long-form as a separate production pipeline inside the existing GitHub Showcase application, reusing the existing production services but introducing a new episode-level orchestration and landscape composition system.**

We should not redesign the existing Short-form system, and we should not use the News pipeline as the foundation for this work.

There are several important findings in the audit that materially change how we should implement this.

# **1. What we actually have today**

## **Existing architecture**

**Project baseline**

Audited

# **532**

Passing automated tests

# **86**

Existing GitHub MP4s

# **85**

Repositories completed in history

# **9**

Completed stored GitHub script records

**Existing technology**

- Node.js 24 / TypeScript / ESM.
- Groq API for script generation.
- Kokoro ONNX for local narration.
- Chromium/CDP for browser capture.
- FFmpeg for video and audio.
- SQLite for persistent history.
- Python tooling for TTS and audio alignment.

Pasted text(20261113-170804).txt

The current application is actually quite well structured for this expansion. We already have separate modules for repository discovery, factual extraction, script generation, voice synthesis, captions, mascot animation, browser capture, audio processing, rendering and QA.

However, there is an important distinction.

**The existing GitHub pipeline does not record a continuous browser video of GitHub.**

It captures a mobile-width repository screenshot once, then renders a separate stationary phone-style card through Chromium, taking screenshots of that composition for individual video frames.

That is different from the screen-recording-style landscape presentation we're planning.

The existing implementation is therefore reusable as a production foundation, but its visual composition approach needs a substantial extension.&#x20;

Pasted text(20261113-170804).txt



## **What we can reuse**

| Existing module       | Long-form use                            |
| --------------------- | ---------------------------------------- |
| `groq.ts`             | Reuse Groq client                        |
| `script-dataset.ts`   | Retrieve stored scripts                  |
| `facts.ts`            | Preserve repository evidence             |
| `voice.ts`            | Continuous narration                     |
| `timeline.ts`         | Timing and animation timeline foundation |
| `caption-overlay.ts`  | Caption logic and styling foundation     |
| `character-motion.ts` | Mascot animation logic                   |
| `mascot-layout.ts`    | Mascot positioning foundation            |
| `cdp.ts`              | Browser automation                       |
| `asset-server.ts`     | Serve production assets                  |
| `sfx.ts`              | Sound-effect mixing foundation           |
| `qa.ts`               | Media validation foundation              |
| `history.ts`          | Reservation and persistence patterns     |

We should reuse these components through their interfaces, not copy entire implementations into a second pipeline.&#x20;

Pasted text(20261113-170804).txt



# **2. Five important problems we must solve first**

## **Problem 1 — The existing dataset is much smaller than the history database**

Critical data-readiness issue

The audit reports:

| Storage                          | Available records |
| -------------------------------- | ----------------- |
| Completed repositories in SQLite | 85                |
| Completed GitHub script records  | 9                 |
| Minimum needed for one episode   | 5                 |
| Remaining after first episode    | 4                 |

This means that we technically have enough stored scripts for one Long-form episode, assuming all five pass validation.

But we do not currently have enough to produce two complete five-repository episodes without obtaining additional eligible records.

The 85 completed repositories cannot automatically be treated as 85 available scripts. The script archive is a separate, best-effort storage mechanism.&#x20;

Pasted text(20261113-170804).txt



**My recommendation:**

Before developing the selector, create a read-only dataset reconciliation operation.

It should examine:

- All nine completed dataset records.
- Their repository IDs.
- Their script integrity.
- Their fact ledger.
- Their repository metadata.
- Whether an associated original script exists in `temp/`.
- Whether historical artifacts can safely reconstruct missing dataset records.

We should not regenerate missing historical scripts blindly.

The outcome should be an exact number of usable, unique repositories.

Going forward, every successfully completed Short-form production should persist a complete, validated dataset record reliably enough for future Long-form production.

## **Problem 2 — The 58-second limitation is everywhere**

Critical rendering issue

The audit identifies several hardcoded restrictions:

- `MAX_DURATION_SECONDS = 58`.
- `render.ts` silently clamps the duration.
- TTS validation rejects longer narration.
- QA expects a maximum of 58 seconds.
- Configuration and preview systems assume portrait geometry.

Increasing one constant will not solve this.

We need independent production profiles:

| Property     | Short-form                 | Long-form                 |
| ------------ | -------------------------- | ------------------------- |
| Aspect ratio | 9:16                       | 16:9                      |
| Resolution   | 1080×1920                  | 1920×1080                 |
| Frame rate   | 30 FPS                     | 30 FPS                    |
| Duration     | Existing 58-second maximum | Approximately 5 minutes   |
| Composition  | Existing card              | New landscape composition |
| Audio        | Existing narration + SFX   | Narration + BGM + SFX     |
| QA           | Existing rules             | Landscape-specific rules  |

The existing Short-form product limit must remain untouched.

Long-form should use actual audio duration and never silently truncate the episode.&#x20;

Pasted text(20261113-170804).txt



## **Problem 3 — Rendering performance could become our biggest bottleneck**

Highest engineering risk

This is the most important technical issue in the entire audit.

At 30 FPS:

\\[ 300 \times 30 = 9,000 \text{ frames} \\]

A five-minute video requires approximately 9,000 output frames.

The existing GitHub renderer takes screenshots through CDP for individual frames. The audit reports that this stage is already the slowest stage, and the capture worker defaults to one because of memory constraints.

The report estimates that a five-minute video could take well over an hour on the audited machine.

We should not accept that as the final production architecture.&#x20;

Pasted text(20261113-170804).txt



**My recommendation: introduce a separate landscape rendering strategy and benchmark it before implementing the complete pipeline.**

I would investigate a hybrid rendering approach:

**Proposed high-performance composition**

**1. Browser capture**

Capture individual real repository screens, README sections and source-file views.

**2. Scene assets**

Store screenshots, highlight coordinates, source metadata and visual targets on disk.

**3. Motion compositor**

Apply zoom, pan, camera movement, mascot animation, highlights and captions.

**4. FFmpeg**

Perform the continuous landscape video encoding and audio mixing.

The central idea is to avoid asking Chromium to take 9,000 screenshots when many of those frames can be generated much more efficiently from captured scene assets.

We should benchmark two or three possible implementations before choosing the final compositor.

This is an architectural decision, not an opportunity to introduce a new framework unnecessarily.

## **Problem 4 — No-repeat selection needs its own permanent database**

The existing `HistoryStore` is designed for individual Short-form repository productions. We should not reuse its `repositories.status = completed` as the Long-form episode ledger.

I recommend a new database:

`db/longform-history.db`

With three primary tables:

| Table                       | Responsibility                                               |
| --------------------------- | ------------------------------------------------------------ |
| `episodes`                  | Every Long-form production and its status                    |
| `episode_repositories`      | The five repositories assigned to each episode, with ranking |
| `longform_repository_usage` | Permanent record of every repository ever selected           |

The most important database constraint is:

```
UNIQUE(repository_node_id)
```

This prevents the same GitHub repository from entering two different Long-form episodes.

### **Selection and reservation transaction**

This is how it should work:

1. Load eligible scripts.
2. Remove repositories already present in the Long-form usage ledger.
3. Evaluate the remaining candidates.
4. Select five.
5. Begin a database transaction.
6. Reserve all five repositories atomically.
7. Commit the episode and its five selections.
8. Begin production.

If two instances of the program start simultaneously, they cannot successfully reserve overlapping repositories.

**Important policy:** A repository becomes permanently consumed when its selection is committed, not when its video successfully renders.

A failed episode therefore cannot release its five repositories back into the candidate pool.

However, the production itself should support resuming the same episode with the same five repositories. Resuming that episode is not creating a new selection.

The reservation ledger should also be backed up. A database that is deleted, lost or replaced cannot guarantee no-repeat behaviour. Since the existing application is local, this guarantee initially applies to the same installation and its preserved database, not automatically across different computers.

Pasted text(20261113-170804).txt

## **Problem 5 — Repository capture and highlighting require new functionality**

The existing implementation has:

- Real mobile repository-page capture.
- README extraction.
- Scroll anchors.
- A timed scroll system.
- Screenshot-based composition.

It does not have:

- Landscape repository-page capture.
- Source-file browsing and capture.
- README-line highlighting.
- Arbitrary camera zoom.
- Arbitrary horizontal camera panning.

These are actual missing features, not just configuration differences.&#x20;

Pasted text(20261113-170804).txt



I recommend an independent `LongFormCapture` module.

Its responsibilities will be:

**Repository capture**

- Open the actual GitHub repository.
- Capture its main page.
- Capture relevant README sections.
- Capture installation and usage instructions where needed.
- Capture interesting source files when relevant.

**Highlight intelligence**

- Identify the exact text discussed in narration.
- Find that text in the captured page.
- Obtain its actual screen coordinates.
- Apply a red marker/highlighter overlay.
- Preserve the association between the highlighted text and its source.

For example:

[\[bug\]:  Failed to load schema for "src/helpers/backend/backend-schema.json" · Issue #2787 · hoppscotch/hoppscotch · GitHub](https://images.openai.com/static-rsc-4/aLAC4Q0z4AnsQv312dNh2C0NQVPHPdsnUDOLb1GYRpmrULO7Ge_iL70oF-ovIfQvtYRqAczRgz2r2Sg6D72E_CJC-7vFL3WzBuLpedSslfkG6N6KnRtzx1HsPliPuH8HYJJ0Llm7j2yLSMW5k-MBCeMBiFYLdI5Z4Ou7plp0bdQ?purpose=inline)

[github.com](https://github.com/hoppscotch/hoppscotch/issues/2787?utm_source=chatgpt.com)

Example

Conceptual visual reference, not an existing project screenshot

The narrator explains an important feature. The camera zooms into the corresponding README paragraph, and the exact sentence receives a marker effect.

There is one strict rule: the highlighter must never randomly select lines. It must have an exact text or source-line reference. When that reference cannot be found, it should use another valid visual anchor rather than highlight unrelated content.

Also, the current live-capture fallback can produce a locally constructed mock page after GitHub blocks or fails to load. That fallback might be acceptable for an existing Short-form presentation, but it must not silently pass as real repository footage in Long-form production.

For Long-form, a mock capture should fail the authenticity check and be clearly reported.

## **Problem 6 — Captions need better synchronization**

The GitHub channel estimates individual word timing inside measured narration phrases using syllable weighting.

The News channel already has a much better mechanism: forced audio alignment through `tools/python/align_audio.py`, with actual word-level timestamps and alignment coverage validation.

We should reuse this capability instead of introducing a different caption engine.

The proposed process is:

1. Generate the complete narration with Kokoro.
2. Measure the duration of every speech segment.
3. Concatenate the audio into one continuous track.
4. Run forced alignment against the complete narration.
5. Generate word-level caption timestamps.
6. Apply the existing caption visual language using a landscape-specific layout.

This is especially important because errors in approximate timing become more noticeable throughout a five-minute video.

Pasted text(20261113-170804).txt

## **Problem 7 — Music and sound-effect licensing**

The current project has SFX mixing but no background music infrastructure. The provenance of the existing SFX is also not fully verified.

For the new system:

- Create a background-music asset directory.
- Maintain a licence manifest for each track.
- Record source, creator, licence, attribution requirements and asset hash.
- Introduce narration-aware music ducking.
- Support fade-in, continuous background level and fade-out.
- Reuse the existing SFX scheduler where appropriate.
- Verify every SFX licence before publishing.

We should use owned, public-domain or appropriately licensed assets. We should not treat a download labelled "copyright-free" as automatically safe for YouTube.

Pasted text(20261113-170804).txt

# **3. Recommended final architecture**

I recommend this structure for the new production system.

```

github-showcase/
│
├── run.bat
├── run.sh
├── run.command
│
├── src/
│   │
│   ├── index.ts                 # Existing Short-form: unchanged
│   ├── github.ts                # Existing GitHub integration
│   ├── groq.ts                  # Shared Groq client
│   ├── voice.ts                 # Shared Kokoro engine
│   ├── timeline.ts              # Existing timing foundations
│   ├── cdp.ts                   # Shared browser automation
│   ├── sfx.ts                   # Existing SFX foundation
│   │
│   └── longform/
│       │
│       ├── index.ts
│       ├── config.ts
│       ├── types.ts
│       │
│       ├── preflight.ts
│       ├── dataset-loader.ts
│       ├── repository-selector.ts
│       ├── usage-ledger.ts
│       │
│       ├── episode-builder.ts
│       ├── master-script.ts
│       ├── script-validator.ts
│       │
│       ├── scene-planner.ts
│       ├── scene-timeline.ts
│       │
│       ├── capture/
│       │   ├── repository-capture.ts
│       │   ├── readme-capture.ts
│       │   ├── source-file-capture.ts
│       │   ├── highlight-engine.ts
│       │   └── capture-validator.ts
│       │
│       ├── composition/
│       │   ├── landscape-layout.ts
│       │   ├── camera-motion.ts
│       │   ├── mascot-composition.ts
│       │   ├── caption-composition.ts
│       │   ├── countdown-scenes.ts
│       │   └── transition-scenes.ts
│       │
│       ├── audio/
│       │   ├── narration.ts
│       │   ├── alignment.ts
│       │   ├── music-manager.ts
│       │   └── audio-mixer.ts
│       │
│       ├── renderer.ts
│       ├── qa.ts
│       ├── progress.ts
│       └── recovery.ts
│
├── assets/
│   └── longform/
│       ├── mascot/
│       ├── music/
│       ├── sfx/
│       └── licenses.json
│
├── db/
│   ├── showcase-history.db      # Existing
│   ├── news-history.db           # Existing
│   └── longform-history.db       # New
│
├── dataset/
│   └── github/                  # Existing archive reused
│
├── temp/
│   └── longform/
│
└── output/
    └── longform/

```

This is a proposed module layout. We should only introduce a module when it has a real responsibility; we do not need to create empty files for every listed component.

### **Architectural boundaries**

There should be four distinct responsibilities:

| Layer                        | Responsibility                                                 |
| ---------------------------- | -------------------------------------------------------------- |
| Existing GitHub engine       | Repository discovery, facts and Short-form                     |
| Long-form episode engine     | Selection, reservation, script and scene orchestration         |
| Shared production services   | Groq, TTS, CDP, audio utilities and QA foundations             |
| Long-form composition engine | Landscape scenes, camera, mascot, captions and final rendering |

The new entry point should be independent of `src/index.ts`.

This is how we preserve Short-form stability.

# **4. Complete production workflow — from launch to final MP4**

Here is the exact execution sequence I recommend.

## **Long-form autonomous production**

1. **Application launch**

   User selects GitHub Repository Showcase → Long-form Video.
2. **Production preflight**

   Verify Groq configuration, Kokoro models, FFmpeg, Chromium, dataset integrity, storage and mascot assets.
3. **Repository selection**

   Retrieve five valid, unused repository scripts and rank them automatically.
4. **Permanent reservation**

   Atomically register the five repositories in the Long-form usage database.
5. **Master script generation**

   Use Groq to compose one cohesive countdown episode.
6. **Scene planning**

   Map every narration segment to the relevant repository screen, README section, source file, highlight and mascot position.
7. **Narration and alignment**

   Generate continuous Kokoro narration, measure the audio and establish word-level timestamps.
8. **Repository capture**

   Capture the actual pages and selected technical content for all five repositories.
9. **Visual composition**

   Prepare opening, rankings, camera keyframes, marker effects, mascot entrances, captions and transitions.
10. **Audio production**

    Add background music, narration-aware ducking, transitions and SFX.
11. **Rendering**

    Create one continuous 1920×1080 video.
12. **Quality assurance**

    Validate video, audio, captions, scene ordering, repository authenticity and episode duration.
13. **Finalization**

    Save the MP4, episode metadata and report. Update the episode history and wait for a keypress.

## **The actual video storytelling sequence**

This is the visual template I would use for all five repositories.

Opening · approximately 0–5 seconds

[OpenAI lança animais de estimação virtuais no Codex para ajudar programadores | TugaTech](https://images.openai.com/static-rsc-4/kGsscwL7tyrxJ6HyW0cUZXeVN1l8hxusisQVJjc-xgaPO0Fav3iHxgeBJ4yumjW1YdcghjMuG24l23dsLj4xcUEHS5i6leq3WiZwdEk6aLiMh96Kd4FZjhN5i8KE3_wo0X3-Y1g5Czdiq5SYQ9vaJyyHmwcNKTM-TiR7vkfqKu0?purpose=inline)

[tugatech.com.pt](https://tugatech.com.pt/t84701-openai-lanca-animais-de-estimacao-virtuais-no-codex-para-ajudar-programadores?utm_source=chatgpt.com)

**Mascot introduction**

Mascot slides up from below, arrives in the middle of the frame, introduces the episode and exits.

Repository #5

[カウントダウン・グラデーション・５秒の動画｜無料の動画素材サイト「動画AC」](https://images.openai.com/static-rsc-4/VIxATMK_frKY90oO60hoVLj-PGXPVLSd_m30hMwsdeINVoMvCg02KDT02oOhQFEJzG5e0mIFg9gDpdHzjlUAZ9oRdYlZ7BMT0cPhKIXGuy2brf4VifM58Bey_PSMDUyiND5sbgSaJkEvGONDDdhw-zDoXbKNUgKHUNBNiLqCnMc?purpose=inline)

[video-ac.com](https://video-ac.com/video/44829?utm_source=chatgpt.com)

**Ranking introduction**

Show #5 and the repository name.

[Awesome-runbook, the open-source project for runbook curation | by Sungwon Lee | Medium](https://images.openai.com/static-rsc-4/5rqjIuzQHl_g3xn9YxI73Zac606CIHMjcMY1acN1YWFvCCVmXfeOIjefyNcyyKnEdBv5rxfgZwBawgMz60bbv1rJnO2BcK3E445Ppw1NezXxtp7RR5aWQS_GNeKjW8HjRnNxqM67K5O2vLVcakeHnFOq-vLWfWefuL-iCdWJXZs?purpose=inline)

[ssowonny.medium.com](https://ssowonny.medium.com/awesome-runbook-the-open-source-project-for-runbook-curation-fe551d79e7e5?utm_source=chatgpt.com)

**Repository demonstration**

Start the narration and show the actual GitHub page. Use camera zoom and vertical or horizontal pan.

[Link to Specific Line on Github. Highlight line | by Jelani Woods | Medium](https://images.openai.com/static-rsc-4/ov6Rh_JmKswULM6OR4nQelM0ZCLWghKbeBT2J9_QNmp_UcYOdDbMp2t-Qy5jZKjZo1zuiAV58WhAJE1REqGzNuZNqKa7SzGY4z7KipqzZIMxBwHgozBcBUPPqwixreIbxVnbxYVdiZCZbB665uxa4fLu9kRDRL_dWxkn83lJB8U?purpose=inline)

[medium.com](https://medium.com/%40jelaniwoods/link-to-specific-line-on-github-e9bab3d44b18?utm_source=chatgpt.com)

**Important feature**

Highlight the exact README paragraph or code detail being discussed.

[nexiuscontent.blob.core.windows.net](https://nexiuscontent.blob.core.windows.net/public/d047ebea-75b7-a177-aa43-aac9dcfceb51/index.html?utm_source=chatgpt.com)

**Mascot commentary**

Mascot enters from the side, emphasizes the point and exits.

Repositories #4, #3, #2 and #1

**Repeat the storytelling structure**

The layout remains consistent, but the actual screens, highlights, narration and movement adapt to each repository.

**Closing**

Short concluding narration and optional mascot return.

The mascot should be a supporting presenter, not a permanent obstacle covering the repository. Its position should adapt to the composition and the region being highlighted.

The front-facing image you supply will be used as the opening asset. It should not be regenerated into a different character.

# **5. Detailed implementation roadmap**

I would divide development into nine milestones. We should implement and validate each milestone before moving to the next.

The order is deliberate: we address the largest technical risk early, instead of discovering rendering limitations after building everything else.

## **M0 — Baseline and dataset readiness**

Foundation

**Tasks**

- Preserve the current GitHub and News pipeline behaviour.
- Run the existing 532-test suite.
- Run TypeScript checks.
- Inventory all completed dataset records.
- Reconcile dataset records against history and temporary artifacts.
- Validate repository IDs and fact ledgers.
- Determine how many unique repositories are actually usable.

**Acceptance criteria**

- Existing tests still pass.
- No modifications to Short-form production.
- A reliable list of eligible repositories is available.
- The first five selections are possible without duplicates.

**Deliverable:** Dataset readiness report.

## **M1 — Landscape renderer performance experiment**

Highest priority

This should happen before building the full Long-form pipeline.

Build a small technical prototype that demonstrates:

- Actual GitHub repository page in landscape.
- README capture.
- Zoom-in and zoom-out.
- Horizontal and vertical camera movement.
- Text highlighting.
- Mascot placement.
- Animated captions.
- FFmpeg MP4 export.

Compare:

| Rendering approach               | Evaluation                                |
| -------------------------------- | ----------------------------------------- |
| Existing CDP per-frame rendering | Reuse, speed and memory                   |
| Captured images + FFmpeg motion  | Encoding performance and flexibility      |
| Hybrid scene compositor          | Quality, speed and development complexity |

My preferred direction is the hybrid approach, but the benchmark should determine the final choice.

**Acceptance criteria:** A real, playable 16:9 prototype with synchronized audio and visual elements, with measured rendering time, memory consumption and frame rate on the actual production machine.

Do not proceed with the full renderer until we understand this performance profile.

## **M2 — Repository selection and permanent usage ledger**

Data foundation

Implement:

- Dataset retrieval.
- Eligibility validation.
- Repository deduplication.
- Deterministic quality ranking.
- Five-repository episode selection.
- Atomic reservation.
- Permanent no-repeat tracking.
- Episode history.
- Crash-safe reservation persistence.

### **Recommended selection algorithm**

I would avoid completely random selection.

Instead:

1. Filter for completed and valid scripts.
2. Exclude previously used repositories.
3. Evaluate factual completeness and showcase potential.
4. Prefer topic, language and project diversity.
5. Select the best five candidates.
6. Assign countdown rankings, with the strongest candidate at #1.
7. Use a deterministic tie-breaker.

The system should display the five selected repository names in the terminal.

**Acceptance tests:** Restart the application, run two simultaneous selection attempts, simulate a failed episode and verify that no repository is selected again.

## **M3 — Master script generation**

Content engine

Create the new Long-form script composer using the existing Groq client.

I recommend keeping the actual generation grounded in five concise evidence packets created from the stored scripts and fact ledgers.

The new script should be a structured episode rather than five independent `NarrationPlan` objects.

For example:

```
EPISODE
│
├── OPENING
│   └── Mascot introduction
│
├── REPOSITORY #5
│   ├── Introduction
│   ├── Purpose
│   ├── Interesting feature
│   └── Technical explanation
│
├── REPOSITORY #4
│   └── Same narrative structure
│
├── REPOSITORY #3
│   └── Same narrative structure
│
├── REPOSITORY #2
│   └── Same narrative structure
│
├── REPOSITORY #1
│   └── Same narrative structure
│
└── CLOSING
```

### **Script requirements**

Each narration segment must preserve:

- Repository identity.
- Fact IDs.
- Spoken text.
- Caption text.
- Scene target.
- Highlight target, when applicable.
- Mascot cue.
- Segment purpose.

The LLM should produce natural transitions between rankings.

It should also introduce conversational filler words appropriately, without becoming repetitive.

**Duration:** Approximately five minutes, using a soft target of around 4:30–5:15. The TTS-measured duration determines the actual video duration. There must be no forced 58-second or five-minute truncation.

We should use one structured master generation request where possible, with a bounded validation/repair attempt. We should not blindly pass five full README documents into Groq.

The existing `composeLlmScript()` should not simply be stretched beyond its original constraints. It is single-repository and short-duration oriented; `groqChatCompletion()` is the reusable part.&#x20;

Pasted text(20261113-170804).txt



## **M4 — Repository capture and scene planning**

Visual intelligence

Implement the new landscape capture system.

Each repository should have an individual scene manifest.

Illustrative example:

```
{
  "rank": 5,
  "repository": "owner/repository",
  "scenes": [
    {
      "type": "repository-intro",
      "target": "repository-header"
    },
    {
      "type": "readme",
      "target": "readme-introduction"
    },
    {
      "type": "highlight",
      "target": "installation-instructions"
    },
    {
      "type": "source-file",
      "target": "relevant-source-file"
    }
  ]
}
```

The actual scene manifest should include capture dimensions, source URLs, timestamps, selected text, screen coordinates and associated narration segment IDs.

Capture the actual repository pages. For source files, use GitHub's available repository content information to identify relevant files, then open their actual GitHub views.

Do not assume the existing root-file listing contains the full source tree.

**Acceptance criteria:**

- Five repositories captured.
- Each capture associated with the correct repository.
- README targets validated.
- Source files shown only when relevant and verified.
- Highlighter coordinates match actual screen content.
- Failed live capture cannot silently become mock footage.

## **M5 — Landscape visual composition**

Presentation engine

Implement the 16:9 composition and visual behaviours.

| Component       | Required behaviour                 |
| --------------- | ---------------------------------- |
| Opening mascot  | Center, slide upward               |
| Opening timing  | Approximately five seconds maximum |
| Countdown       | #5 through #1                      |
| Browser footage | Actual repository page             |
| Camera          | Zoom, pan and position keyframes   |
| Highlighter     | Exact text or code region          |
| Mascot          | Different screen positions         |
| Captions        | Landscape-specific layout          |
| Transitions     | Short, consistent                  |
| Closing         | Optional mascot return             |

I recommend deterministic camera keyframes.

The LLM can supply the visual target, but the application should calculate actual screen positions, timing and motion. We do not need additional LLM calls to calculate every animation frame.

Also, the same character should remain visually consistent. We will use the supplied front-facing asset for the opening and existing mascot assets for the presentation, with the required positioning and entrance behaviour.

## **M6 — Narration, captions and audio**

Audio production

Reuse Kokoro and the existing audio pipeline.

Implement the following:

- Continuous episode narration.
- Per-segment audio measurements.
- Audio concatenation.
- Word-level alignment.
- Animated captions.
- Background music.
- SFX scheduling.
- Narration-aware ducking.
- Final audio normalization.

For background music, introduce a small library rather than building a music-generation engine.

Use verified licences and retain the licensing information with the assets.

**Acceptance criteria:** No missing speech, no audio truncation, captions aligned with the narration and no music overpowering the voice.

## **M7 — Long-form renderer and export**

Core production

Once the renderer experiment has established the correct approach:

Implement the production rendering pipeline with:

- Scene sequencing.
- Timestamp synchronization.
- Keyframe interpolation.
- Mascot composition.
- Caption composition.
- Highlight overlays.
- Audio mixing.
- Continuous encoding.

Output specification:

| Property        | Value                   |
| --------------- | ----------------------- |
| Resolution      | 1920×1080               |
| Aspect          | 16:9                    |
| Frame rate      | 30 FPS                  |
| Video           | H.264                   |
| Pixel format    | yuv420p                 |
| Audio           | AAC                     |
| Audio frequency | 48 kHz                  |
| Channels        | Stereo                  |
| Container       | MP4                     |
| Duration        | Approximately 5 minutes |

Use a separate Long-form render configuration. The Short-form render configuration remains unchanged.

## **M8 — Terminal progress, QA and recovery**

Production reliability

This milestone brings the whole experience together.

### **Terminal progress**

I want a genuine phase and repository-level production dashboard.

For example:

```
============================================
        LONG-FORM PRODUCTION
============================================

[1/9] PREFLIGHT                  COMPLETE
[2/9] REPOSITORY SELECTION       COMPLETE
[3/9] MASTER SCRIPT              COMPLETE

Selected:
 #5 owner/repo-alpha
 #4 owner/repo-beta
 #3 owner/repo-gamma
 #2 owner/repo-delta
 #1 owner/repo-epsilon

[4/9] NARRATION & ALIGNMENT      RUNNING
      Generating narration...

[5/9] REPOSITORY CAPTURE         WAITING

[6/9] VISUAL COMPOSITION         WAITING

[7/9] AUDIO PRODUCTION           WAITING

[8/9] VIDEO RENDERING            WAITING

[9/9] FINAL QUALITY CHECK       WAITING
```

When repository capture starts:

```
CAPTURING REPOSITORY #5

Repository: owner/repo-alpha

[1/4] Opening GitHub page        COMPLETE
[2/4] Capturing README           COMPLETE
[3/4] Capturing important lines  RUNNING
[4/4] Capturing source files     WAITING

Scenes captured: 4/7
Repository capture: 57%
```

The figures must be based on actual operations completed, not fabricated progress.

### **Recovery**

Unlike the existing GitHub pipeline, which has no automatic resume capability, Long-form should support checkpoints.

For example:

- Repository selection saved.
- Master script saved.
- Narration saved.
- Captures saved.
- Scene composition saved.
- Render progress recorded.
- QA results saved.

A restart should resume the existing episode rather than select five new repositories.

The News pipeline's resume capability can be studied for patterns, but we should build recovery for the new Long-form workflow itself.&#x20;

Pasted text(20261113-170804).txt



## **M9 — Launcher integration and end-to-end testing**

Finally, add the new option to the existing launch experience.

```
============================================
    GITHUB & VIDEO AUTOMATION STUDIO
============================================

[1] GitHub Repository Showcase
[2] News Commentary
[0] Exit

Choose pipeline: 1

GITHUB REPOSITORY SHOWCASE
--------------------------------------------

[1] Short-form Video (9:16)
[2] Long-form Video  (16:9)
[0] Back

Choose format: 2

Starting Long-form production...
```

Update:

- `run.bat`
- `run.sh`
- `run.command` only if required by its current delegation.
- `package.json` scripts.

Keep the existing Short-form command and its execution path unchanged.

At completion, preserve the existing press-any-key behaviour.

# **6. Data contracts we should establish before implementation**

I consider these three structures particularly important.

### **A. Repository selection record**

One record per selected repository:

```
{
  "repositoryNodeId": "stable-github-node-id",
  "fullName": "owner/repository",
  "datasetRecordId": "stored-script-id",
  "episodeId": "episode-id",
  "rank": 5,
  "selectionScore": 0,
  "reservedAt": "ISO-8601 timestamp",
  "usageStatus": "reserved"
}
```

`selectionScore` above is an example field, not a value that should be hardcoded.

### **B. Episode record**

```
{
  "episodeId": "episode-id",
  "status": "script-ready",
  "format": "16:9",
  "resolution": {
    "width": 1920,
    "height": 1080
  },
  "repositoryCount": 5,
  "repositoryIds": [],
  "scriptPath": null,
  "narrationPath": null,
  "sceneManifestPath": null,
  "outputPath": null,
  "createdAt": "ISO-8601 timestamp"
}
```

### **C. Narration and visual segment**

```
{
  "segmentId": "segment-001",
  "repositoryNodeId": "stable-github-node-id",
  "rank": 5,
  "spokenText": "The narration goes here.",
  "captionText": "The narration goes here.",
  "factIds": [],
  "visualTarget": {
    "type": "readme-section",
    "section": "installation"
  },
  "highlight": {
    "enabled": true,
    "targetText": "Exact verified text"
  },
  "mascot": {
    "enabled": true,
    "position": "right",
    "action": "point"
  }
}
```

These contracts will allow the script, audio, recording, captions and animation systems to communicate without coupling everything together.

The exact TypeScript types and database schema should be finalized in the TRD.

# **7. End-to-end acceptance tests**

I would not consider this feature complete merely because it produces an MP4.

These are the production acceptance requirements.

**Long-form acceptance checklist**

0/26

Existing 532-test baseline still passes, with TypeScript checks clean.

Short-form GitHub production remains unchanged.

News Commentary remains unchanged.

Long-form launches from the existing terminal menu on supported operating systems.

Exactly five valid, distinct repositories are selected automatically.

Repository selection is deterministic and quality-based.

Previously selected Long-form repositories cannot be selected again after restarting.

Concurrent episode launches cannot reserve overlapping repositories.

Failed episodes retain their selections and can resume with the same repositories.

Groq creates one cohesive countdown narrative with verified factual grounding.

All five repositories appear in the correct #5 to #1 sequence.

The supplied mascot performs the centered opening animation.

The same mascot appears in different positions during explanations.

Actual GitHub repository and README content is captured.

Important README or source-code lines are highlighted accurately.

Camera movements are synchronized with narration.

Word-level captions are synchronized with the voice.

Background music is licensed and correctly ducked under narration.

SFX are verified and correctly synchronized.

The final video is one continuous 1920×1080 landscape MP4.

The five-minute target is supported without silent duration truncation.

Final audio and video are complete and synchronized.

Terminal progress reflects actual production events.

QA validates visual quality, media integrity and repository authenticity.

Final assets and production metadata are saved.

Terminal waits for a keypress after completion.

Reset checklist

These are feature acceptance requirements, not claims that any implementation is already complete.

# **8. Decisions I recommend locking**

The audit lists 27 outstanding questions. We do not need to turn every one into a lengthy discussion. Most have sensible defaults.

| Decision                  | Recommended resolution                                        |
| ------------------------- | ------------------------------------------------------------- |
| Number of repositories    | Exactly five                                                  |
| Repository source         | Completed stored Short-form scripts                           |
| Repeated repositories     | Never repeat across Long-form episodes                        |
| Short-form interaction    | No cross-mode restriction                                     |
| Repository identification | GitHub `node_id`                                              |
| Selection                 | Deterministic, quality-based and diverse                      |
| Ranking                   | Strongest repository becomes #1                               |
| Failed selection          | Permanently consumed                                          |
| Failed production         | Resume the same episode                                       |
| Script generation         | Existing Groq client, new episode composer                    |
| Voice                     | Existing Kokoro voice                                         |
| Captions                  | Forced word alignment                                         |
| Opening                   | Supplied mascot, centered, maximum approximately five seconds |
| Repository footage        | Actual GitHub content                                         |
| Visual effects            | Zoom, pan, highlights, simple transitions                     |
| Background music          | Verified royalty-free/public-domain/owned assets              |
| Duration                  | Approximately five minutes, no forced cutoff                  |
| Output directory          | `output/longform/`                                            |
| Rendering                 | Optimized landscape compositor                                |
| Persistence               | Separate Long-form SQLite history                             |

Two points need particular attention.

First, the no-repeat rule is for Long-form episodes. Short-form can continue normally. That respects your requirement to protect the existing pipeline.

Second, the episode should be regenerated from the stored repository information, not created by stitching together already-exported Short-form videos. The stored dataset contains scripts and facts, but not the original narration WAVs or capture assets in a reusable permanent media archive. Therefore, Long-form needs its own narration and visual production.

Pasted text(20261113-170804).txt

# **9. Technical risks and how I would control them**

| Risk                        | Mitigation                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Only nine stored scripts    | Inventory and recover eligible historical artifacts; enforce five-record preflight |
| Very slow rendering         | Early renderer prototype and performance benchmarking                              |
| Browser anti-bot responses  | Live-capture validation and no silent mock substitution                            |
| Groq hallucinations         | Fact IDs, provenance and structured validation                                     |
| Caption drift               | Forced alignment                                                                   |
| Duplicate repositories      | Transactional unique constraint                                                    |
| Crashed production          | Durable episode checkpoints                                                        |
| Lost database               | Backup and restore procedure                                                       |
| Invalid highlight locations | Verify target text against captured source                                         |
| Unlicensed music/SFX        | Licence manifest and asset verification                                            |
| Short-form regression       | Independent entry point, configuration and regression tests                        |

A particularly important warning from the audit: the News pipeline contains a tested `production/` keyframe engine, but it is not wired into the News renderer and is designed around portrait dimensions. I would not import that entire system as our Long-form renderer. We can borrow individual mathematical ideas, but the actual landscape production path needs to be validated independently.&#x20;

Pasted text(20261113-170804).txt



# **10. What should happen before the first code change?**

I recommend the following order of documentation and engineering authorization.

1. Completed

   **Stage 1 — Architecture Discovery Audit**

   We now have the factual technical baseline.
2. Next

   **Stage 2 — Product Requirements Document**

   Lock the product behaviour, terminal experience, five-repository selection, no-repeat policy, narration, mascot, scene sequence, motion and audio requirements.
3. **Stage 3 — Technical Requirements Document**

   Define exact modules, TypeScript interfaces, SQLite migrations, episode schema, Groq prompt contract, capture system, compositor, FFmpeg pipeline and QA contracts.
4. **Stage 4 — Implementation and E2E plan**

   Turn the nine milestones into small tasks with prerequisites, file ownership, testing requirements and explicit completion criteria.
5. **Stage 5 — Development**

   Start with data-readiness and the landscape rendering experiment, then implement the remaining milestones.

## **My final assessment**

# **Feasible, with two critical gates**

The existing project has enough reusable infrastructure to avoid building a new automation platform.

The two things that must be proven before full implementation are:

**1. Data readiness:** We need enough valid, uniquely identified repository scripts to support repeated five-repository episodes.

**2. Rendering performance:** We need to demonstrate that the landscape compositor can produce a five-minute video at a practical speed on the actual machine.

Everything else has a fairly clear implementation path using existing infrastructure or targeted additions.

My strongest recommendation is to resist the temptation to start by modifying `src/index.ts`, increasing `MAX_DURATION_SECONDS` globally, or adapting the existing portrait card into a landscape card. Those shortcuts would create unnecessary coupling and potentially destabilize working production.

**The next concrete deliverable should be the PRD, followed by the TRD.** The renderer benchmark and dataset inventory should then be the first two implementation-stage experiments, with no changes to existing Short-form behaviour.

The objective is one reliable additional production mode, not a second application or a rewrite of the first one.