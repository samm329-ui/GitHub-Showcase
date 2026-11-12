# Lazy News production engine — decisions and build order

Status legend: `CONFIRMED` (owner decision), `PROPOSED` (recommendation, pending override), `OUT OF SCOPE FOR NOW`.

Everything here is news-channel-only. The GitHub showcase engine is untouched.

## 1. Verdicts

- The research/verification pipeline stays exactly as shipped (Gates A/B/C, claim-level ledger, brand-only Groq).
- Deterministic production engine sits **below** the gates. Nothing in this document may bypass them.
- Two systems, one contract: `NewsProductionSpec` (immutable, hashed) is the only coupling.

## 2. Decisions

| ID | Decision | Status |
|----|----------|--------|
| D1 | Deterministic keyframe engine; `evaluate(clip, t)` with absolute frame time; no physics/integrator | CONFIRMED (design) |
| D2 | One rational clock, 30 fps, t = f/30. All visual+audio events on one clock | CONFIRMED (design) |
| D3 | Character rig: **existing artwork preserved**, refined proportions/folders/animation, never regenerated | CONFIRMED (owner: "Reserving the character and the assets") |
| D4 | Visual identity: **A — Premium editorial office** (vintage newsroom, warm muted palette, cinematic depth, restrained accent) | PROPOSED — owner override pending |
| D5 | Animation intensity: **balanced** (subtle breathing/blink/look-board; expressive only at hooks and punchlines) | PROPOSED — owner override pending |
| D6 | Camera: subtle keyframed editorial push (2–4 % scale) at establish/presenter/board moments, never constant | CONFIRMED (design) |
| D7 | Lip sync: visemes from word/phoneme timings; envelope fallback permitted; `visemeSource` provenance recorded per episode | CONFIRMED (design, with fallback rule) |
| D8 | Board = earned evidence card only (verbatim number / institutional decision / contradiction / conclusion). Not per-sentence | CONFIRMED |
| D9 | Evidence card presentation: primary record / N independent outlets / conflicting statement / unresolved allegation. NOT ideological left↔right | CONFIRMED (owner direction) |
| D10 | Perspective map retired as a *scoring* signal; kept as on-screen flavour only | CONFIRMED (owner direction) |
| D11 | Output 1080×1920 @ 30 fps; yuv420p H.264; −16 LUFS; ≤ −1 dBTP | CONFIRMED (design) |
| D12 | Composition layers: foreground / midground / background with premultiplied alpha; re-cut at 1080×1920 | PROPOSED — owner assets |
| D13 | Sound registry with per-event gain/fades/pan/ducking; one deterministic mixer pass before mux | CONFIRMED (design) |
| D14 | `NewsProductionSpec` v1 with content-hash provenance in every artifact bundle | CONFIRMED (design) |
| D15 | Gates A/B/C immutable; no preview or renderer may reach media before Gate B | CONFIRMED |

## 3. Not built (and why)

- New artwork redraw at 1080×1920 (owner decision: reuse existing character; fresh master set still needs an illustrator or a disciplined remastering pass — this line lists it as an open owner item, not engineering).
- Pixel-diff parity tests against real rendered frames (needs the M5 renderer; not started this phase).
- On-camera approval UI for Gate A/B/C inside preview tools (CLI approvals today; unchanged).
- WhisperX/MFA phoneme path (fallback is word-timings + dictionary today; phoneme MFA upgrade is a later milestone).

## 4. Build order

| Phase | Deliverable | Gate |
|-------|-------------|------|
| M0 (this doc + spec types + engine core + tests) | Deterministic engine compiling clips → frames, all tests green | done |
| M1 | Master artwork remastered to 1080×1920 — owner + artist | acceptance: one premium static composite shown to owner |
| M2 | Character rig: layered body/head/eyes/brows/mouth/arms/chair + `enter_left`, `settle_idle`, `idle_breathing`, `talk_neutral`, `react_*`, `look_at_board` | 5-second test clip accepted by owner |
| M3 | Focus/board transitions: dim/blur background-only, board type-on, marker wipe, accent rule for evidence | internal pass |
| M4 | Captions + word highlight + audio registry + mixer + visemes | internal pass |
| M5 | Deterministic renderer + encoder params + export-parity check | two consecutive renders ⇒ identical bytes (or documented reason why not) |
| M6 | ~49 s complete episode assembled end to end | Gate A/B/C stamp |

## 5. Objective verification (tests that must stay green)

`tests/news-production.test.ts` covers: frame-clock rationals; easing curves; keyframe evaluation (holds, stepped hold, easeInto, clamping); timeline compilation ordering/overlaps; validator rejection (wrong canvas/fps, unknown clip/audio event, caption out of bounds); spec content-hash stability.

Any PR that breaks these regresses the engine, even if the video "looks fine".
