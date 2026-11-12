# Configuration reference

All pipeline behaviour is driven by environment variables (there is no second
config file for behaviour) plus one optional presentation file:

| File | Written by | Read at | Purpose |
| --- | --- | --- | --- |
| `.env` | you (gitignored) | entry points & `run.bat` | API tokens and overrides |
| `visual-overrides.json` | the live preview (gitignored, atomic write) | pipeline startup | Presentation tuning (mascot, card, caption, callout, impact) |

`run.bat` and the pipeline entry points load `.env` automatically; a
shell-exported value always wins over the file.

**Precedence for visual values:** environment variable → `visual-overrides.json` → committed default.
Delete `visual-overrides.json` to return to the committed composition. The
file stores the complete composition the preview authored; it is loaded once
at startup, invalid files are ignored with a warning, and the card is always
re-centred on the stage from the stored width/height.

## GitHub Showcase channel & shared engine

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHOWCASE_TARGET_SECONDS` | 35 | Target narration length (`--length` wins when set) |
| `SHOWCASE_FPS` | 30 | Output frame rate |
| `SHOWCASE_TEMP_DIR` | `temp/` | Working directory for run artifacts |
| `SHOWCASE_OUTPUT_DIR` | `output/` | Final MP4 directory |
| SHOWCASE_DB | db/showcase-history.db | SQLite history database (GitHub channel) |
| NEWS_DB | db/news-history.db | SQLite history database (Lazy News channel) |
| SHOWCASE_DB_DIR | db/ | Directory holding both channel databases |
| `SHOWCASE_MIN_SCORE` | 65 | Eligibility threshold for discovery |
| `GROQ_API_KEY` | (none) | **Required** (default writer) Groq API key from console.groq.com |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq chat model (free tier: try `openai/gpt-oss-20b` if you hit 429s) |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Groq API base URL |
| `GROQ_TIMEOUT_MS` | 60000 | Per-request timeout |
| `GROQ_MAX_RETRIES` | 3 | Retries after the initial attempt (429/backoff honoured) |
| `GROQ_MAX_TOKENS` | 3000 | Completion token cap (reasoning + script; the script itself is ~1k) |
| `GROQ_REASONING_EFFORT` | `low` (gpt-oss only) | `medium`/`high`/`off` — `off` removes the field entirely |
| `GROQ_MAX_INPUT_CHARS` | 4500 | README is trimmed to this before the prompt |
| `GROQ_MAX_PROMPT_FACTS` | 30 | Fact-ledger payload cap (highest-confidence first) |
| `SHOWCASE_SCRIPTER` | `llm` | `llm` = Groq writer; `rule` = legacy offline composer |
| `SHOWCASE_SCRIPTABILITY_GATE` | `0` | `1` restores the old hard scriptability skip |
| `KOKORO_VOICE` | `am_fenrir` | Kokoro voice id (locked audition winner, young developer delivery) |
| `KOKORO_SPEED` | `1.0` | Kokoro speed (natural conversational pace) |
| `KOKORO_LANG` | `en-us` | Kokoro language code |
| `KOKORO_MODEL` | `models/kokoro/kokoro-v1.0.int8.onnx` | Kokoro model file |
| `KOKORO_VOICES` | `models/kokoro/voices-v1.0.bin` | Kokoro voices file |
| `SHOWCASE_MASCOT_WIDTH_RATIO` | `0.6306` | Presenter width as a fraction of the 1080 px canvas (681 px) |
| `SHOWCASE_MASCOT_OFFSET_X` | `-60` | Presenter `right` CSS offset (negative extends past the canvas edge) |
| `SHOWCASE_MASCOT_OFFSET_Y` | `462` | Presenter `bottom` offset; part of the Instagram-safe mascot/bubble/caption group (bottom-safe) |
| `SHOWCASE_CAPTION_TOP_PX` | `1388` | Caption panel `top`; same Instagram-safe group as the mascot/bubble |
| `GITHUB_TOKEN` | (none) | Raises the GitHub API rate limit |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | Chrome DevTools endpoint |
| `SHOWCASE_CAPTURE_COLOR_SCHEME` | `dark` | Theme of the captured repository page (`dark`/`light`/`auto`). GitHub renders from the OS color-scheme, so without the pin captures were light on light-mode Linux — which does not sit on the white stage; always dark by default |
| `SHOWCASE_CHARACTER_PNG` | `assets/github/presenter/character.png` | Primary transparent presenter; `none` disables the layer |
| `SHOWCASE_CHARACTER_POINT_PNG` | `assets/github/presenter/character.png` | Optional pointing pose; falls back to the primary cut-out |
| `SHOWCASE_CHARACTER_CLOSE_PNG` | `assets/github/presenter/character-close.png` | Optional medium CTA pose |
| `SHOWCASE_CALLOUT_PNG` | `assets/github/callout/callout-bubble.png` | Speech bubble shell; transparent background with separate copy |
| `SHOWCASE_SFX_MASCOT` | `1` | `0` disables the mascot slide-in entrance sound effect |
| `SHOWCASE_SFX_CALLOUT` | `1` | `0` disables the callout bubble pop sound effect |

The product rule is a hard maximum of 58 seconds.

## Lazy News channel

`NEWS_*` variables are documented with the channel itself, in
[`lazy-news.md`](lazy-news.md) (gates cannot be bypassed by any variable).
`.env.example` shows the common ones inline.
