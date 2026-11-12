# assets/

Artwork for the two pipelines, split one folder per pipeline. Nothing lives at
the top level except this map.

## github/ — GitHub Repository Showcase channel

```
github/
├── presenter/
│   ├── character.png        # primary presenter cut-out (default mascot)
│   ├── character-close.png  # medium close-up used at the CTA beat
│   ├── character-source.png # original flat-white artwork the cut-outs are made from
│   └── mascot-custom.png    # whatever the live preview uploaded (overwritten per pick)
├── callout/
│   ├── callout-bubble.png   # default speech-bubble shell (1082×789)
│   └── comic-speech-bubble.png  # alternate sticker shell (1672×941, fallback)
└── sfx/
    ├── mascot-slide-whoosh.wav  # presenter entrance whoosh
    ├── callout-pop.wav          # bubble pop
    ├── *.mp3                    # Pixabay source material (see ATTRIBUTION.md)
    └── ATTRIBUTION.md           # licence notes — verify before redistributing videos
```

## news/ — Lazy News Commentary channel

```
news/
├── original/   # archival 941×1672 scene artwork — never modified
├── layers/     # RGBA cut layers the renderer draws (split by
│               # `tools/python/prep_lazy_news_assets.py`)
└── reference/  # 4.png master reference (used by the prep tool's --validate)
                # and composite.png (the assembled scene for eyeballing)
```

## Rules

- Channel artwork goes under that channel's folder — never at the top level.
- Runtime PNGs are lossless (keep them that way); artwork that must be shared
  by both pipelines goes in a new `shared/` folder, not duplicated per channel.
- The raw Lazy News source zip stays in `News assets/` at the repo root
  (gitignored); `news/original/` is extracted from it, once, and committed.
- Filenames are lowercase-with-hyphens. No spaces.
