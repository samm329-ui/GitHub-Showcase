import fs from "node:fs";
import path from "node:path";
import type { EpisodeScript, NewsSceneEvent } from "./types.js";
import type { CaptionPhrase } from "../../types.js";

/**
 * The Lazy News scene as a self-contained HTML stage.
 *
 * 941x1672 native artwork. Layers are <img>s at native coordinates (already
 * RGBA-cut and 1px-feathered). Live text is DOM: paper headline, paper
 * callout, grey-card captions. The background group dim/blur is a CSS filter
 * on the wrapper — narrator and card stay sharp by construction.
 *
 * All animation is driven per-frame by the renderer via window.__news.* —
 * never by in-page timers.
 */

export type NewsSceneAssets = {
  backgroundPng: Buffer;
  boardPng: Buffer;
  pinPng: Buffer;
  noteLeftPng: Buffer;
  noteRightPng: Buffer;
  narratorPng: Buffer;
  cardPng: Buffer;
};

export function loadNewsAssets(root = process.cwd()): NewsSceneAssets {
  const layersDir = path.join(root, "assets", "lazy-news", "layers");
  const read = (f: string): Buffer => {
    const p = path.join(layersDir, f);
    if (!fs.existsSync(p)) {
      throw new Error(`Lazy News layer missing: ${p}. Run tools/prep_lazy_news_assets.py first.`);
    }
    return fs.readFileSync(p);
  };
  void root;
  return {
    backgroundPng: read("1.png"),
    boardPng: read("2.png"),
    pinPng: read("3.png"),
    noteLeftPng: read("note-left.png"),
    noteRightPng: read("note-right.png"),
    narratorPng: read("8.png"),
    cardPng: read("9.png"),
  };
}

const b64 = (buf: Buffer, mime = "image/png"): string =>
  `data:${mime};base64,${buf.toString("base64")}`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Paper safe zones (native artwork coordinates) */
const PAPER = { x: 245, y: 330, w: 530, h: 285 };
const CARD  = { x: 82, y: 1296, w: 780, h: 150 };

export function buildNewsSceneHtml(input: {
  script: EpisodeScript;
  assets: NewsSceneAssets;
  captions: CaptionPhrase[];
  events: NewsSceneEvent[];
}): string {
  const { script, assets } = input;
  const openingHeadline = esc(script.workingTitle);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Lazy News scene</title>
<style>
  :root {
    --paper-ink: #181715;
    --marker: #F7C928;
    --accent-red: #C8102E;
  }
  html, body { margin: 0; padding: 0; width: 941px; height: 1672px; overflow: hidden; background: #B6AC8E; }
  * { box-sizing: border-box; }
  .layer { position: absolute; left: 0; top: 0; width: 941px; height: 1672px; user-select: none; -webkit-user-drag: none; }
  #bg-group { position: absolute; inset: 0; filter: none; transition: filter 350ms ease; }
  #bg-group.dim { filter: brightness(0.85) blur(1.2px); }
  .note { transition: none; }
  #paper-text {
    position: absolute; left: ${PAPER.x}px; top: ${PAPER.y}px; width: ${PAPER.w}px; height: ${PAPER.h}px;
    font-family: "Montserrat ExtraBold Italic", "Inter ExtraBold Italic", "Arial Black", Arial, sans-serif;
    font-weight: 800; font-style: italic; color: var(--paper-ink);
    font-size: 54px; line-height: 1.18; letter-spacing: -0.5px; white-space: pre-wrap;
    padding: 6px 4px; overflow: hidden;
  }
  #paper-text .hl { background: var(--marker); padding: 0 10px 2px; display: inline; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  #paper-text .dim { color: #6b675f; }
  #cap-text {
    position: absolute; left: ${CARD.x}px; top: ${CARD.y}px; width: ${CARD.w}px; height: ${CARD.h}px;
    display: flex; align-items: center; justify-content: center; text-align: center;
    font-family: "Inter ExtraBold Italic", "Montserrat ExtraBold Italic", Arial, sans-serif;
    font-weight: 800; font-style: italic; color: #FFFFFF; font-size: 30px; line-height: 1.3;
    padding: 10px 22px; text-shadow: 0 2px 5px rgba(0,0,0,0.4); overflow: hidden;
  }
  #cap-text .wrap { width: 100%; text-align: center; white-space: normal; overflow-wrap: break-word; }
  #cap-text .hl { color: var(--marker); }
  #cap-text .cur { border-bottom: 5px solid var(--marker); }
  .noshadow { box-shadow: none; }
</style>
</head>
<body>
  <!-- background group: wall + board + paper headline + notes + pin (dimmed together in narration_focus) -->
  <div id="bg-group">
    <img class="layer" src="${b64(assets.backgroundPng)}" alt="">
    <img class="layer" src="${b64(assets.boardPng)}" alt="">
    <div id="paper-text">${openingHeadline}</div>
    <img class="layer" src="${b64(assets.pinPng)}" alt="" style="pointer-events:none">
    <img class="layer note" id="note-left" src="${b64(assets.noteLeftPng)}" alt="" style="position:absolute">
    <img class="layer note" id="note-right" src="${b64(assets.noteRightPng)}" alt="" style="position:absolute">
  </div>

  <!-- foreground group: narrator + grey card (never dimmed) -->
  <img class="layer" id="narrator" src="${b64(assets.narratorPng)}" alt="" style="position:absolute">
  <img class="layer" src="${b64(assets.cardPng)}" alt="">
  <div id="cap-text"></div>

<script>
  const paper = document.getElementById('paper-text');
  const capText = document.getElementById('cap-text');
  const narrator = document.getElementById('narrator');
  const bgGroup = document.getElementById('bg-group');
  const noteLeft = document.getElementById('note-left');
  const noteRight = document.getElementById('note-right');
  const openingHtml = paper.innerHTML;

  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  window.__news = {
    ready(timeoutMs) {
      return new Promise(resolve => {
        const t = setTimeout(resolve, Math.min(timeoutMs ?? 8000, 30000));
        const imgs = [...document.images];
        const check = () => imgs.every(i => i.complete) && (clearTimeout(t), resolve(), true);
        imgs.forEach(i => { i.addEventListener('load', check); i.addEventListener('error', check); });
        if (check()) clearTimeout(t);
      });
    },
    setBackgroundFocus(focus) {
      bgGroup.classList.toggle('dim', focus === 'dim_soft_blur');
    },
    setNarrator(state, timeMs) {
      if (state === 'entrance') {
        const t = Math.min(1, timeMs / 600);
        const ease = 1 - Math.pow(1 - t, 3);
        narrator.style.transform = 'translateX(' + ((1 - ease) * -941) + 'px)';
      } else if (state === 'idle') {
        const bob = Math.sin(timeMs / 700) * 4;
        narrator.style.transform = 'translate(0px, ' + bob.toFixed(2) + 'px) rotate(' + (Math.sin(timeMs / 1400) * 0.4).toFixed(3) + 'deg)';
      } else if (state === 'subtle_tilt') {
        const bob = Math.sin(timeMs / 700) * 2;
        narrator.style.transform = 'translate(0px, ' + bob.toFixed(2) + 'px) rotate(-1.4deg)';
      } else if (state === 'settle') {
        narrator.style.transform = 'translate(0px, 0px)';
      } else {
        narrator.style.transform = 'translate(-941px, 0px)';
      }
    },
    setNotes(state, timeMs) {
      if (state === 'pause') { noteLeft.style.transform = 'rotate(0deg)'; noteRight.style.transform = 'rotate(0deg)'; return; }
      const L = Math.sin(timeMs / 1900 + 0.8) * 2.6;
      const R = Math.sin(timeMs / 2600 + 2.1) * 2.6;
      noteLeft.style.transform = 'translate(' + L.toFixed(2) + 'px, ' + (Math.cos(timeMs / 1700) * 1.5).toFixed(2) + 'px) rotate(' + (Math.sin(timeMs / 2100 + 0.5) * 0.6).toFixed(3) + 'deg)';
      noteRight.style.transform = 'translate(' + R.toFixed(2) + 'px, ' + (Math.cos(timeMs / 2300 + 1.4) * 1.5).toFixed(2) + 'px) rotate(' + (Math.sin(timeMs / 2500 + 1.9) * 0.6).toFixed(3) + 'deg)';
    },
    setPaper(headlineHtml) { paper.innerHTML = headlineHtml; },
    setOpeningHeadline() { paper.innerHTML = openingHtml; },
    setCallout(callout) {
      if (!callout) { paper.innerHTML = openingHtml; return; }
      const raw = callout.boardText || '';
      const progress = callout.progress ?? 1;
      const chars = Math.floor(raw.length * progress);
      const shown = raw.slice(0, chars);
      // Highlight the configured subset once the callout is mostly revealed.
      let html = '';
      const words = (Array.isArray(callout.highlightWords) ? callout.highlightWords : []).filter(Boolean)
        .map(w => String(w).toLowerCase());
      if (progress > 0.75 && words.length) {
        let rest = shown, restLower = rest.toLowerCase();
        while (rest.length > 0) {
          let bestIdx = -1, bestWord = null;
          for (const w of words) {
            const idx = restLower.indexOf(w);
            if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestWord = w; }
          }
          if (bestIdx === -1) { html += escapeHtml(rest); rest = ''; restLower = ''; break; }
          html += escapeHtml(rest.slice(0, bestIdx));
          html += '<span class="hl">' + escapeHtml(rest.slice(bestIdx, bestIdx + bestWord.length)) + '</span>';
          rest = rest.slice(bestIdx + bestWord.length);
          restLower = rest.toLowerCase();
        }
      } else {
        html = escapeHtml(shown);
      }
      paper.innerHTML = html;
    },
    setCaption(html) { capText.innerHTML = html ? '<div class="wrap">' + html + '</div>' : ''; },
    setCalloutPaper(text, highlightWords, progress) {
      this.setCallout({ boardText: text, highlightWords, progress });
    },
  };
</script>
</body>
</html>`;
}

/** Type-on progress 0..1 for a callout at `timeMs`. */
export function calloutProgress(startMs: number, endMs: number, timeMs: number): number {
  if (timeMs <= startMs) return 0;
  const revealMs = Math.max(600, (endMs - startMs) * 0.45);
  const t = Math.max(0, Math.min(1, (timeMs - startMs) / revealMs));
  return t * t * (3 - 2 * t); // smoothstep
}

export function captionHtmlAt(phrases: CaptionPhrase[], timeMs: number): string {
  const phrase = phrases.find(p => timeMs >= p.startMs && timeMs < p.endMs) ?? null;
  if (!phrase) return "";
  const words = phrase.wordTimings ?? phrase.text.split(/\s+/).map((w, _i, arr) => {
    const span = (phrase.endMs - phrase.startMs) / Math.max(1, arr.length);
    const s = phrase.startMs + _i * span;
    return { text: w, startMs: Math.round(s), endMs: Math.round(s + span) };
  });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const highlights = phrase.highlights.map(norm);
  return words.map(w => {
    const isCurrent = timeMs >= w.startMs && timeMs < w.endMs;
    const cls = [
      highlights.some(h => h && (norm(w.text).includes(h) || h.includes(norm(w.text)))) ? "hl" : "",
      isCurrent ? "cur" : "",
    ].filter(Boolean).join(" ");
    return `<span class="${cls}">${esc(w.text)}</span>`;
  }).join(" ");
}
