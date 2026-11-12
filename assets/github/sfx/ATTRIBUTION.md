# SFX attribution & licensing notes

| File | Used by | Source / licence status |
| --- | --- | --- |
| `mascot-slide-whoosh.wav` | `SFX_CONFIG.mascotEntrance` | Origin not recorded — verify or replace before redistributing videos |
| `callout-pop.wav` | `SFX_CONFIG.calloutPop` | Origin not recorded — verify or replace before redistributing videos |
| `floraphonic-happy-pop-2-185287.mp3` | (unused in code; source material) | Filename indicates Pixabay audio, author `floraphonic` — NOT verified; confirm the licence on pixabay.com before relying on it |
| `oxidvideos-paper-slide-short-478835.mp3` | (unused in code; source material) | Filename indicates Pixabay audio, author `oxidvideos` — NOT verified; confirm the licence on pixabay.com before relying on it |

**Status: needs verification.** These files were committed without recorded
licence checks. Pixabay audio is generally free to use commercially and
non-commercially, usually without attribution — but that has not been
verified for these specific files. Confirm the licence (or replace the
assets) before publishing videos anywhere you cannot take down. If you
replace files, either keep the names referenced in `SFX_CONFIG` or update
`src/config.ts`.

The two MP3s are not referenced by the code today; they are kept as source
material next to the WAVs the pipeline actually plays.
