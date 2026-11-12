# Lazy News character audit — 2026-11-13

**Scope:** `assets/news/` only. Nothing was modified; generated material lives under `temp/` (gitignored).
**Rule applied throughout:** no flattering reconstruction. Anything that cannot be cleanly
extracted is listed as "manual reconstruction" rather than filled in with invented pixels.

---

## 1. Asset inventory

All files 941 × 1672. Layers carry alpha; originals do not.

| File | Mode/Alphabet | Opaque coverage | Alpha bbox | Content (eyeballed) |
|---|---|---|---|---|
| original/1.png | RGB, opaque composite | — | — | Wall plate + desk + props (no board/character/cutout) |
| original/2.png | RGB | — | — | Bare corkboard + paper (close-up white bg) |
| original/3.png | RGB | — | — | Single red pushpin + drop shadow |
| original/4.png | RGB | — | — | Complete frame WITH sample text ("New AI Chip…") + lower-third caption |
| original/7.png | RGB | — | — | Two sticky notes (source for the left/right note cutouts) |
| original/8.png | RGB | — | — | Character + chair + side books + cup (white bg) — **same content as layers/8.png** |
| original/9.png | RGB | — | — | Laptop alone, white bg |
| layers/1.png | RGBA, full plate | 1.000 | (0,0)-(941,1672) | Background plate (wall with shadow silhouette!) |
| layers/2.png | RGBA | 0.244 | (200,214)-(904,769) | Corkboard + paper cutout |
| layers/3.png | RGBA | 0.003 | (505,256)-(598,365) | Pushpin cutout |
| layers/8.png | RGBA | 0.235 | (18,655)-(941,1455) | **Character + chair + books** |
| layers/9.png | RGBA | 0.089 | (62,1284)-(885,1468) | Laptop cutout |
| layers/note-left.png | RGBA | 0.008 | (579,682)-(725,830) | Left sticky note |
| layers/note-right.png | RGBA | 0.009 | (729,656)-(853,817) | Right sticky note |
| reference/4.png | RGB | — | — | Full frame with sample text (text baked in — NOT for production) |
| reference/composite.png | RGB | — | — | Full composite used in scene |

Key findings:
- **No editable/vector source exists.** Everything is flattened raster. This is a hard ceiling on procedural reuse.
- The composite layer **stacking order is confirmed** visually (see below).
- Original RGB files are consistently white backgrounds and can serve as re-cut donors if someone re-mattes with tolerance matting.
- The background plate contains a **baked character-shaped wall shadow** (left third of wall). It is part of layers/1.png — moving/re-rigging the character without removing that shadow will look wrong. Flagged for the artwork pass.

### Confirmed paint order (verified by re-compositing)
1. `layers/1.png` background
2. `layers/2.png` board
3. `layers/note-left.png` and `layers/note-right.png` notes
4. `layers/3.png` pin
5. `layers/8.png` **character**
6. `layers/9.png` laptop (foreground)

Re-compositing with this order reproduces `reference/composite.png` faithfully (crop checked at
board/character/desk seams). Good news: alpha is clean enough between layers to stack in code.

---

## 2. Meet the character (this is the important part)

The presenter is a seated, bearded man leaning back in a chair, one hand under his chin,
dressed in a grey suit, tie, glasses, phone hair; eyes half-lidded, permanent bored frown behind
a full beard. Seated in front of a laptop. **All facial detail art is painted shading on one
flattened raster.**

Scale of the face: eye centre ≈ (230, 885), glasses rims x ≈ 175–345, y ≈ 790–960.
Mouth (shallow frown) ≈ (235,1010)–(300,1045). Beard mass ≈ (175,960)–(340,1140).
Head top ≈ y 650, chin ≈ y 1115.

## 3. Facial asset specification

Target component set (must be drawn, not algorithm-extracted):

| # | Component | Est. canvas bbox | Art source | Status |
|---|---|---|---|---|
| 1 | head_base (skin + shading, no features) | (130,640)–(480,1130) | manual redraw; keep glasses rim positions | **redraw** |
| 2 | eye_left | (185,855)–(270,915) | manual redraw; iris dark arc visible | **redraw** |
| 3 | eye_right | (245,845)–(330,910) | manual redraw; partially behind glasses | **redraw** |
| 4 | eyelid_left | (180,850)–(275,895) | manual; overlaps rim by ~4px for blink states | **redraw** |
| 5 | eyelid_right | (240,845)–(335,895) | same treatment | **redraw** |
| 6 | brow_left | (175,760)–(300,830) | manual; solid stroke, keep slant | **redraw** |
| 7 | brow_right | (280,740)–(340,805) | manual; bridge overlaps | **redraw** |
| 8 | mouth (varied) | (235,1010)–(300,1045) ≈ 65×35 | **cannot be done honestly**: background beard dominates; redraw beard to reveal | **redraw beard first** |
| 9 | nose | (270,905)–(330,975) | static; keep as part of head_base or separate 1× nose plate | keep as-is |
| 10 | glasses frame | (175,780)–(345,960) | **one** static layer above eyes/lids | separate (static) |
| 11 | cheek shading / blush | none visible separately | painted onto head base — keep together | keep as-is |
| 12 | hair silhouette | (110,640)–(320,920) | static, keep stroke weight; no repaint | keep as-is |

**Visemes will read via beard-edge silhouette motion, not lips.** The mouth shapes must
therefore include a beard deform/overlap variant (open jaw vs closed jaw), not just mouth shapes.

---

## 4. Expression states required (all manual redraw)

Neutral · Blink · Half-lidded (current default, reuse) · Unimpressed · Sarcastic · Surprised · Amused · Serious

Muzzle/mouth shapes: Rest · Open · Wide · Narrow · Closed · Rounded (each as beard-deform variant)
Also required for speech: a "settle frown" and "emphasised frown" within the existing line weight.

Placeholders for the artist pass were generated into `temp/audit-crops/expression-sheet-template.png`
and `temp/audit-crops/mouth-sheet-template.png` (temp only, not committed).

---

## 5. Layer conventions (target)

| Rule | Requirement |
|---|---|
| Transparency | PNG RGBA with real alpha, no baked matte |
| Canvas | 941×1672, identical origin/registration for every component |
| Registration | Anchor coins stored in `registration.json`; eye centre = canonical anchor |
| Halo | No white/grey fringe > 20% alpha on cut line; defringe outside cutters handle 1px |
| Naming | `character_<component>_<state>@2x.png` (e.g. `character_eye_left_blink@2x.png`) |
| Colour | Keep exact existing palette — sample the master for every fill |
| Strokes | Outlines stay dark (#1F262B-ish), no anti-aliased grey halos on colour EDGES |

---

## 6. What CAN be done immediately without artwork

- Keep `layers/8.png` as `character_master` (flat, unchanged) — this is the reference.
- Keep `layers/1.png`, `layers/2.png`, `layers/3.png`, `layers/8.png`, `layers/9.png`, notes — re-compositing order verified.
- Keep `reference/composite.png` as visual sign-off target, **not** as production artwork.
- Re-cut `original/8.png` and `original/2.png` as halo-clean masters if an artist wants re-matting references.

## 7. What must be reported, not silently faked

1. **Eyes/lids/brows/mouth/beard — all manual redraw.** No algorithm can honestly separate painted half-lidded eyes from painted glasses rim, or invent a different mouth under an opaque beard.
2. **Wall shadow on `layers/1.png`** is baked character-shaped — needs removal/redraw for repositioned work.
3. **Glasses bridge** truncates the right brow; any clean cut must reproduce the bridge bridge behind the brow.
4. **No vector source anywhere** — all exports stay raster at 941×1672 or native re-master at 1080×1920.
5. **Sample-text frames** (`original/4.png`, `reference/4.png`) contain baked sample text — they are mockups,
   not deliverable artwork components.

---

## 8. Registration manifest

Written to `assets/news/character/registration.json`. It records:

- canvas size, generation note, layer-identified alpha bboxes (measured),
- estimated face-region bboxes (coarse, marked as estimates),
- extraction feasibility lists (already separated / must be redrawn / static),
- known limitations.

It intentionally does **not** pretend pixel-perfect anchors. Every anchor used by the rig will be
re-derived from the re-drawn artwork (eyelid margins, pupil radius) during the artist pass.

---

## 9. Current deliverables

- [x] Asset inventory (this document)
- [x] Face inspection with measured alpha bboxes and magnified crops
- [x] Facial asset specification (component table with sizes + redraw actions)
- [x] Expression and mouth-shape state lists
- [x] Registration manifest (`assets/news/character/registration.json`)
- [x] Composite preview verified against `reference/composite.png` (layer order confirmed)
- [ ] Expression artwork (placeholder sheets only — real art requires redraw)
- [ ] Mouth artwork (ditto)
- [ ] Character registration preview with redrawn head — waits for artwork
- [ ] Visual approval — waits for artwork

**Next step is an artwork pass (human or commissioned), not animation code.** Per your instruction,
no animation, rig, clips, or controller work is started until the assembled image passes approval.
