# Lazy News scene tuner (placeholder)

This folder is reserved for the **Lazy News** channel's visual tuner — the
news equivalent of `tools/preview/github/` (the GitHub Showcase frame
studio). Nothing is built here yet, on purpose.

Current state of Lazy News visuals: the scene lives in code
(`src/channels/news/scene.ts`) and is tuned with `--skip-audio` fast passes —
not a browser preview. When a browser tuner is built it will:

1. live in this folder (`scene-live.html`),
2. share the engine in `tools/preview/shared/` (`preview-server.ts` /
   `config-model.js` / `config-writer.ts`) rather than re-inventing it,
3. author `news-visual-overrides.json` at the repo root (GitHub stays on
   `visual-overrides.json` — the two files never touch each other),
4. be opened by a `Save Lazy News Frame` launcher in this folder, mirroring
   `tools/preview/github/Save GitHub Frame.*`,
5. change only the rendering path of the news channel — the gates A/B/C
   and the fact ledger stay untouched.

Design decision recorded here: GitHub-frame tuning and news-scene tuning are
siblings under `tools/preview/`, never the same files — someone configuring
the news show must not accidentally re-skin the GitHub showcase (and vice
versa).
