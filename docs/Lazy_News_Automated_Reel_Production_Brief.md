# Lazy News — Automated Reel Production Brief

## 1. What we are building

Build a reusable animated scene for the sarcastic news-commentary videos. It should feel like a lazy, slightly sarcastic office commentator is telling the viewer what happened.

We are **not** making a traditional TV-news studio, and we are **not** generating a new image for every sentence. We already have the visual scene separated into layers. The video renderer should place those layers in the same positions as the supplied reference frame and animate them carefully over the narration.

The final result should feel like a small illustrated office that comes alive while the commentator speaks. The movement should be restrained and intentional. The voice, subtitles, noticeboard callouts and a few sound effects should work together to keep the viewer interested.

## 2. The visual reference is the source of truth

Use `4.png` as the master composition reference. Files `5.png`, `6.png` and `10.png` are pixel-identical copies of `4.png`; they are not separate design variations.

Do not redesign the layout. Do not invent a new studio, add a globe, add neon lighting, add a show logo, or add episode numbers. Preserve the existing office look, the lazy narrator, the corkboard, the sticky notes, the desk and the grey caption card.

The main visual identity is:

- A slightly shabby, lived-in office with a muted beige wall.
- A wooden corkboard with a clean white paper area for the current headline or important line.
- The sleepy, sarcastic narrator in the chair.
- A pair of small sticky notes that can move very subtly.
- A grey subtitle card near the bottom, with all spoken captions kept inside it.
- Warm, restrained colors and clear contrast. No neon, flashy glow or excessive effects.

## 3. Asset inventory from `Lazy news.zip`

Every file is **941 × 1672 pixels**. Keep that common canvas and coordinate system when preparing the layers. The complete reference frame should be used to check their alignment.

| File | Purpose | How to use it |
|---|---|---|
| `1.png` | Office background | Base layer. It contains the wall, plant and shelf at left, desk and existing office objects. Keep it fixed. |
| `2.png` | Corkboard with blank white paper | Place over the background at the exact reference position. Keep the white paper area; it is part of the board, not background to remove. |
| `3.png` | Red pushpin | Place over the paper at the position shown in the reference. Keep it still. |
| `4.png` | Complete reference frame | Master visual reference. Do not use it as the final video layer. |
| `5.png` | Complete reference frame | Exact duplicate of `4.png`; reference only. |
| `6.png` | Complete reference frame | Exact duplicate of `4.png`; reference only. |
| `7.png` | Two sticky notes | Separate the notes from their white canvas and place them in the reference positions. Animate them gently. |
| `8.png` | Narrator and chair | Main foreground subject. It includes the reclining character/chair and some nearby items at the right edge. Keep the subject's proportions and pose. Check for overlap with objects already present in `1.png`. |
| `9.png` | Grey subtitle card | Extract the grey card as its own layer. There is also a small pin visible near the top of this file; do not accidentally add a duplicate pin if `3.png` is being used. |
| `10.png` | Complete reference frame | Exact duplicate of `4.png`; reference only. |

### Important asset-preparation issue

The files are PNGs, but they are saved in **RGB mode, not RGBA**. In other words, the isolated items do not currently have transparent backgrounds. Files such as `2.png`, `3.png`, `7.png`, `8.png` and `9.png` show white canvas around the object.

Do not simply place those files over the background, or white rectangles will cover the office. Do not use a crude white color-key that removes every white pixel: the noticeboard paper, shirt, highlights and parts of the subtitle card must remain visible.

Create clean alpha masks for each isolated object. Use object-aware masking or careful manual/vector masks where necessary. Preserve antialiased edges and soft shadows. Remove white halos around the cut-outs. Save clean RGBA versions as prepared assets and keep the originals untouched.

Specific masking notes:

- `2.png`: preserve the entire wooden board and the blank white paper inside it. Remove only the white canvas outside the board.
- `3.png`: preserve the red pin and its small shadow. Remove only the white canvas.
- `7.png`: preserve both sticky notes, their clips and their shadows. Remove only the white canvas.
- `8.png`: preserve the narrator, chair and the parts of the nearby objects that belong in the final composition. The character has white shirt details, so a simple white color-key will damage the subject. Compare carefully with `4.png` so objects from the background are not doubled.
- `9.png`: preserve the grey subtitle panel and its border. Remove the white canvas. Check the pin visible near the top and use only one pin in the final composition.

`1.png` is the full-frame background and should remain opaque. Check its existing dark character-shaped shadow: keep it only if it sits naturally behind the narrator in the final alignment. Do not let it look like a second character or a stray stain.

## 4. Layer order and alignment

Use the complete reference frame (`4.png`) to match the exact size and position of every item. All layer files share the same 941 × 1672 canvas, so preserve their canvas coordinates wherever possible. Do not independently resize or crop each object before checking the composite.

Recommended back-to-front order:

1. `1.png` — fixed office background.
2. `2.png` — corkboard and blank paper.
3. Headline text — editable text rendered on the paper area.
4. `3.png` — red pushpin, if it is not already included in another retained layer.
5. `7.png` — sticky notes.
6. `8.png` — narrator and chair, positioned exactly as in the reference.
7. `9.png` — grey subtitle panel, with any duplicate pin removed.
8. Live subtitle text — rendered inside the grey card.

The reference frame is the alignment authority. If an extracted layer needs a mask, the mask should follow the object's existing outline; do not move or scale the object just to make masking easier. Before animation, render a still composite and compare it against `4.png`. Fix alignment and edge artifacts first.

## 5. The scene has three main visual states

The scene should move between these states smoothly. The changes should be driven by the narration and editorial markers, not by random timers.

### State A — Opening / character entrance

- Start with the office background already visible.
- The main news headline is already on the noticeboard from the opening frame. Do not make viewers wait for the topic.
- Bring the narrator in from off-screen left to the exact resting position shown in the reference.
- Use a smooth ease-out movement, roughly 450–700 ms as a starting point. Add only a tiny settle at the end; no elastic bounce or cartoon overshoot.
- Start the first subtitle when the voice starts. The subtitle must match the spoken words.
- The character should arrive quickly so the first seconds get to the story.

### State B — Normal narration / subtitle focus

This is the default state for most of the video.

- Keep the narrator sharp and at normal brightness.
- Keep the grey subtitle card and its text sharp and readable.
- Slightly darken and softly blur the office background group: wall, shelf, board and sticky notes. The effect should be subtle, not a dramatic transition. A starting range is about 8–15% darkening and 1–2 px blur, adjusted after viewing the render.
- Do not blur or darken the narrator or the subtitle card.
- Keep the original headline visible but less dominant while the narrator explains the story.
- The purpose is to shift attention to the words being spoken without making the office disappear.

### State C — Important line / noticeboard callout

Use this state only when the narration reaches a genuinely important fact, number, quote, reveal or punchline.

- Gradually return the background to its normal brightness and sharpness.
- Bring attention back to the noticeboard.
- Replace the previous board text with one short important line. Reveal it with a neat typing or writing animation, as though someone is adding a note to the paper.
- Keep the text large enough to read on a phone. Use short wording, a strong line break and one restrained highlight (for example, the existing yellow marker style).
- The paper and board stay in place. Only the text changes; do not move the entire board for every callout.
- Hold the completed callout long enough to read, usually around 1.5–2.5 seconds depending on its length and the narration.
- Then return smoothly to State B while narration continues.

Do not turn every sentence into a board callout. The board is for the few moments that deserve emphasis. As a starting editorial guide, use around 3–5 callouts in a 45–60 second reel, but let the story determine the actual number.

## 6. Narrator movement — small movements, not full character animation

The narrator is a static illustration. We are creating the *illusion* that he is alive; we are not trying to make him behave like a fully rigged 3D or 2D character.

Use restrained motion:

- The entrance from the left at the beginning.
- Very small idle/breathing movement while speaking (a few pixels of vertical movement or a tiny scale change).
- An occasional small head or upper-body tilt.
- A subtle lean or settle at selected moments, only if it does not distort the illustration.
- Optional blinking or mouth changes only if clean matching face states can be prepared.

Important: `8.png` is one static image. It does not contain separate mouth, eye, arm or head layers. Do not warp the face or stretch the whole body to fake detailed speech. If mouth movement is required, prepare two or three aligned mouth-state images from the same character artwork and switch them gently using the audio envelope or phoneme/viseme timing. If those states are not available, keep mouth movement out and rely on the small body motion, expression, subtitles and callouts.

The hand supporting the cheek must remain connected to the face. Do not animate the hand independently. Do not make the character gesture with new arms or hands that are not in the artwork.

## 7. Sticky-note movement

The sticky notes should feel as if a faint air current is moving them.

- Give each note a slightly different slow movement.
- Use tiny position shifts (roughly 2–4 px) and a very small rotation (roughly 0.3–0.8 degrees) as starting values.
- Let the two notes move at different speeds and phases; they should not swing in sync.
- Use slow, smooth movement with pauses. Avoid constant shaking, fast flapping or large rotation.
- Keep the pin and corkboard fixed.
- Reduce or pause the movement during important headline typing so the viewer can focus.

## 8. Subtitle rules

The grey card is the permanent subtitle container. The subtitle text must stay inside its inner area at all times.

- Use the existing `9.png` card shape and match its position to the reference frame.
- Render text as a separate editable layer; do not bake the narration into the card image.
- Use high-contrast, phone-readable type. Keep the same font style, weight and alignment through the whole episode.
- Show short spoken phrases, not full paragraphs. Prefer one or two lines at a time.
- Break lines at natural pauses. Never let a word, descender or punctuation touch the border.
- Use transcript word timings when available so the captions follow the actual speech.
- Use a quick phrase reveal or word-by-word highlight. A slow letter-by-letter typewriter effect for every subtitle will fall behind the voice and make reading difficult.
- A short fade/slide-in is acceptable, but keep the subtitle panel itself stable. The words should do most of the movement.
- If a line is too long, split it at a natural phrase boundary or reduce the font slightly within a defined minimum. Never allow overflow outside the grey card.
- Keep the card within the Instagram Reels safe region. Check it with a Reels interface overlay so captions, account details and right-side buttons do not cover the words. The supplied reference position is the starting point; make only the smallest upward adjustment needed if the platform UI preview shows a collision.

## 9. Headline and callout text rules

- The main story headline appears on the white paper from the first frame.
- Keep the initial headline short and readable. It should tell viewers what the story is about immediately.
- During the video, update the paper only for important information: a surprising number, a key consequence, a direct quote, a contradiction or the sarcastic punchline.
- Keep each callout short. A useful starting target is 3–8 words, with no more than 2–3 lines.
- Use the existing visual language: dark lettering, yellow marker highlight for the key phrase, and a restrained red underline/accent where useful.
- Do not add extra floating cards, icons, graphs or news photographs unless the story genuinely needs one and the visual is available and verified.
- Keep all text within the white paper. Automatically wrap and measure the text before rendering.

## 10. Background focus and blur implementation

Treat the background as a group so it can be controlled as one unit:

- Background group: office wall, shelf, plant, desk and background objects, corkboard, headline paper and sticky notes.
- Foreground group: narrator and chair.
- Subtitle group: grey card and live subtitle text.

In normal narration mode, apply a subtle darken/blur to the background group only. Keep the narrator and subtitle group unaffected. In callout mode, restore the background group to normal. Use smooth transitions, roughly 250–400 ms as a starting point.

Do not apply blur to the entire finished frame. If the whole frame is blurred, the narrator and subtitles will lose clarity too. If the renderer cannot blur individual layers efficiently, render the background group into its own offscreen layer/surface and apply the effect there.

Avoid strong vignette, large glows, neon edges or heavy color changes. The reference uses a warm, muted office palette; preserve it.

## 11. Sound effects and sound design

Voice is always the most important audio element. Sound effects should make the actions feel physical without becoming noisy.

Use only a few quiet, well-timed sounds:

- A soft chair/cloth movement or gentle swish when the narrator enters.
- A light paper or pin tap when a board callout begins.
- A subtle typing, marker or pencil-writing sound while the new callout is revealed.
- A very quiet paper flutter when sticky notes move, used sparingly.
- A short, soft transition sound when returning between narration and callout focus.
- Optional low room tone underneath the whole scene if it improves the atmosphere.

Do not use loud breaking-news sirens, arcade sounds, aggressive electronic stingers or a sound effect on every subtitle. Lower effects well under the narration and automatically duck them when speech is present. Avoid clipping and keep the voice clear.

Every sound effect must be linked to a real visual event. Do not play random effects just to fill silence.

## 12. Pacing and viewer attention

The video should have a small visual event regularly, but it must not feel busy.

- Start with the topic visible immediately.
- Get the character into position quickly.
- Keep the narrator and subtitles as the main focus during explanation.
- Use the board for important moments, not every sentence.
- Let the board callout land, stay readable, and then return to the narration state.
- Use small motion in the narrator and notes to prevent a static-frame feeling.
- Change visual focus when the meaning of the narration changes, not just because a timer fired.
- Save the strongest or funniest callout for the most important reveal or final punchline.
- Keep visual effects restrained. The joke should come from the writing and the character's deadpan delivery, not from excessive motion.

A useful rhythm is: hook → explain → emphasize one important fact → explain → punchline/callout → continue or close. Do not force this pattern if the story has a better natural structure.

## 13. Scene event data for automation

Do not hard-code all the movements against fixed video timestamps. Generate a small scene-event timeline from the approved script and the actual narration timings. The script or editorial stage should mark only important moments.

Each event should contain, at minimum:

- Start and end time, or a word/time range from the narration.
- Scene mode: `intro`, `narration` or `callout`.
- Subtitle text and its word/phrase timing.
- Optional board callout text.
- Which words in the callout receive the yellow highlight.
- Optional sound-effect cue.
- Optional character movement cue (normally none or a small idle/tilt).

Example of the intended logic (illustrative only):

```json
[
  {
    "mode": "intro",
    "trigger": "video_start",
    "narrator_motion": "slide_in_from_left"
  },
  {
    "mode": "narration",
    "trigger": "speech_segment",
    "subtitle": "The company says the new chip is faster.",
    "background_focus": "dim_and_soft_blur"
  },
  {
    "mode": "callout",
    "trigger": "editorial_key_point",
    "board_text": "Faster — but at what cost?",
    "highlight_words": ["at what cost"],
    "board_reveal": "type_on",
    "sound_effect": "soft_marker_write"
  }
]
```

The event timeline must follow the final narration. If the voice duration changes, subtitles and visual events must retime to the voice; do not let the board animation or caption timing drift away from the spoken words.

## 14. Suggested implementation order

1. **Prepare the assets.** Create correct alpha masks for the isolated layers. Keep the original files unchanged.
2. **Build a static composite.** Place the prepared layers on the 941 × 1672 canvas. Match `4.png` exactly before adding animation.
3. **Create the three scene states.** Implement intro, normal narration focus and board callout focus.
4. **Add subtitles.** Render text inside the grey card using the actual transcript timings.
5. **Add the narrator's limited motion.** Start with the entrance and subtle idle movement. Only add mouth/eye states if proper aligned artwork is available.
6. **Animate the sticky notes.** Keep the motion gentle and varied.
7. **Add sound effects.** Link them to the entrance, callout reveal and selected transitions.
8. **Run the full quality checks.** Verify positioning, alpha edges, legibility, Instagram safe zones, audio levels and timing.

Keep the current project's existing sourcing, approval, rendering and QA rules. This brief describes the new visual choreography; it is not permission to replace unrelated parts of the existing pipeline or bypass current approval checks.

## 15. Acceptance checklist

The work is complete only when all of these are true:

- [ ] The first static composite matches the supplied complete reference (`4.png`) in layout, scale and positioning.
- [ ] The isolated images have clean transparency; no white rectangles, white halos or damaged white details remain.
- [ ] The background, board, pin, sticky notes, narrator and subtitle card are separate controllable layers.
- [ ] The narrator enters from the left and settles at the exact reference position.
- [ ] The narrator's movements are subtle and do not distort the face, hands or body.
- [ ] Sticky notes move gently and do not distract.
- [ ] The main headline is visible from the beginning.
- [ ] During normal narration, only the background group becomes slightly darker and softer; the narrator and subtitles stay sharp.
- [ ] During an important callout, the background returns to normal and the board text is revealed cleanly.
- [ ] Callouts appear only for genuinely important facts or punchlines, not on every sentence.
- [ ] Subtitles remain completely inside the grey card and stay readable on a phone.
- [ ] Subtitles are synchronized to the final voice track and never fall behind.
- [ ] Subtitle placement is checked against the Instagram Reels interface safe zones.
- [ ] Sound effects are quiet, event-based and never compete with narration.
- [ ] The final render contains no unintended logos, episode numbers, neon effects, extra graphics or unrelated new scenery.
- [ ] The video plays from beginning to end without timing drift, missing layers, flicker or black frames.

## Final instruction to the agent

Build this as a controlled, reusable motion-graphics scene from the supplied layers. Match the reference first, then animate the scene according to the narration and editorial callout markers. Keep the character lazy and expressive, keep the office consistent, keep subtitles inside their grey card, and use the noticeboard only when a story point deserves emphasis. The result should feel alive and professionally edited, but never cluttered or over-animated.
