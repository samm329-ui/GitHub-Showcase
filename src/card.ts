import type { EnrichedRepo } from "./types.js";
import {
  CARD,
  CARD_BG,
  CARD_CAPTION_ZONE,
  CARD_CHROME_HEIGHT,
  CARD_PROGRESS_ZONE,
  STAGE_BG,
  VIEWPORT,
} from "./config.js";
import { CAPTION_STYLE } from "./caption-overlay.js";
import { readmeHighlights } from "./narration.js";
import { formatCount } from "./facts.js";

/**
 * The 9:16 composition.
 *
 * Layering (the important part):
 *
 *   .stage              1080x1920, solid #F2EFE9
 *     .card             810x1668, upright, radius 28, stationary shadow
 *       .chrome         browser bar, static
 *       .viewport       overflow hidden, static box
 *         .document     the ONLY scrolling layer
 *       .caption-zone   static
 *       .progress       static
 *
 * The card, its border, its shadow, the browser bar, the captions and the
 * progress bar never move. Only `.document` is translated, and only inside
 * `.viewport`, so content can never escape the rounded corners.
 */

export const CARD_SHADOW = [
  "0 3px 8px rgba(25,23,20,0.06)",
  "0 14px 30px rgba(25,23,20,0.12)",
  "0 36px 72px rgba(25,23,20,0.18)",
  "0 70px 100px rgba(25,23,20,0.07)",
].join(", ");

export const UI_TOKENS = {
  stageBg: STAGE_BG,
  cardBg: CARD_BG,
  surface2: "#161B22",
  border: "#30363D",
  textPrimary: "#F0F6FC",
  textSecondary: "#8B949E",
  githubBlue: "#58A6FF",
  captionYellow: "#FFD629",
  codeGreen: "#238636",
} as const;

/* ------------------------------------------------------------------ */
/* Sanitization — README text is untrusted input                       */
/* ------------------------------------------------------------------ */

export function sanitizeReadmeHtml(markdown: string): string {
  let text = markdown;
  // Drop anything executable or remotely loaded before anything else.
  text = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed[^>]*>/gi, " ")
    .replace(/<\/?(script|style|iframe|object|embed|link|meta)[^>]*>/gi, " ");

  const blocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, body: string) => {
    const code = escapeHtml(body.replace(/\n+$/, ""));
    blocks.push(
      `<pre class="code" data-lang="${escapeHtml(lang || "text")}"><code>${code}</code></pre>`
    );
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  // Images (remote or otherwise) are removed rather than fetched.
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img[^>]*>/gi, " ");

  text = escapeHtml(text);

  // Links keep their text, never their target.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs and e-mail addresses.
  text = text.replace(/&lt;(?:https?|mailto):[^\s&]+&gt;/gi, "");
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "");

  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) return;
    out.push(`<ul>${listBuffer.map(item => `<li>${item}</li>`).join("")}</ul>`);
    listBuffer = [];
  };

  const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  const isTableDivider = (line: string) =>
    /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(cell => cell.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd();

    // Markdown table: a header row followed by a |---|---| divider.
    if (
      isTableRow(line) &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1])
    ) {
      flushList();
      const header = cells(line);
      index += 2;
      const body: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        body.push(cells(lines[index]));
        index += 1;
      }
      index -= 1;
      out.push(
        `<table class="md-table"><thead><tr>${header
          .map(cell => `<th>${inline(cell)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map(row => `<tr>${header.map((_h, c) => `<td>${inline(row[c] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      continue;
    }

    if (/^\u0000BLOCK\d+\u0000$/.test(line.trim())) {
      flushList();
      out.push(line.trim());
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      listBuffer.push(inline(bullet[1]));
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      listBuffer.push(inline(numbered[1]));
      continue;
    }
    if (line.trim().length === 0) {
      flushList();
      continue;
    }
    if (/^([-*_]\s*){3,}$/.test(line.trim())) {
      flushList();
      out.push("<hr>");
      continue;
    }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();

  const withBlocks = out.join("").replace(/\u0000BLOCK(\d+)\u0000/g, (_m, index) =>
    blocks[Number(index)] ?? ""
  );
  return withBlocks;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** GitHub-style short relative date, computed from the real commit date. */
function relativeDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const days = Math.max(0, Math.round((Date.now() - parsed) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/* ------------------------------------------------------------------ */
/* Document sections                                                   */
/* ------------------------------------------------------------------ */

export type CardSection = { anchor: string; html: string };

export function buildDocument(repo: EnrichedRepo): string {
  const { bullets, installCommand } = readmeHighlights(repo);
  const sections: CardSection[] = [];

  /* --- repo header --------------------------------------------- */
  const tabs = [
    { label: "Code", count: null as number | null, active: true },
    { label: "Issues", count: repo.open_issues_count ?? null, active: false },
    { label: "Pull requests", count: null, active: false },
    { label: "Actions", count: null, active: false },
  ];

  sections.push({
    anchor: "repo-header",
    html: `
      <section class="pad">
        <div class="crumbs">
          <svg viewBox="0 0 16 16" class="i"><path d="M2 5.5 8 1.5l6 4v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>
          <a>${escapeHtml(repo.owner)}</a><span class="sep">/</span><a class="strong">${escapeHtml(repo.name)}</a>
          <span class="badge">Public</span>
        </div>
        ${repo.description ? `<p class="desc">${escapeHtml(truncate(repo.description, 160))}</p>` : ""}
        <div class="meta-row">
          <span class="meta"><svg viewBox="0 0 16 16" class="i"><path d="m8 1.5 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4L3.5 15.3l.9-5L.8 6.8l5-.7z"/></svg>${formatCount(repo.stargazers_count)}</span>
          <span class="meta"><svg viewBox="0 0 16 16" class="i"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5 6v4M5 10c0 1 3 0 5 0" stroke-width="1.4"/></svg>${formatCount(repo.forks_count)}</span>
          ${repo.primaryLanguage ? `<span class="meta"><i class="dot"></i>${escapeHtml(repo.primaryLanguage)}</span>` : ""}
        </div>
        <nav class="tabs">${tabs
          .map(
            tab =>
              `<span class="tab${tab.active ? " active" : ""}">${tab.label}${
                tab.count === null ? "" : `<em>${tab.count}</em>`
              }</span>`
          )
          .join("")}</nav>
      </section>`,
  });

  /* --- file list ------------------------------------------------ */
  const entries = repo.rootFiles.slice(0, 8);
  if (entries.length > 0) {
    const commit = repo.latestCommit;
    sections.push({
      anchor: "file-list",
      html: `
        <section class="pad">
          <div class="bar">
            <span class="crumb">${escapeHtml(repo.name)}</span>
            <span class="commit">${commit ? escapeHtml(truncate(commit.message, 64)) : escapeHtml(`latest commit on ${repo.default_branch}`)}</span>
          </div>
          <ul class="files">
            ${entries
              .map(
                entry => `<li>
                  <svg viewBox="0 0 16 16" class="i ${entry.type === "file" ? "file" : "dir"}">${
                  entry.type === "file"
                    ? '<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3" stroke-width="1.2"/>'
                    : '<path d="M1.5 3.5h5l1.5 2h6.5v8h-13z"/>'
                }</svg>
                  <span class="fname">${escapeHtml(entry.name)}</span>
                  <span class="fmsg">${commit ? escapeHtml(truncate(commit.message, 48)) : ""}</span>
                  <span class="fdate">${
                    commit?.committedAt ? escapeHtml(relativeDate(commit.committedAt)) : ""
                  }</span>
                </li>`
              )
              .join("")}
          </ul>
        </section>`,
    });
  }

  /* --- readme --------------------------------------------------- */
  const readmeHtml = repo.readmeText ? sanitizeReadmeHtml(repo.readmeText) : "";
  const licenseLine = repo.openSourceLicense
    ? `<span class="badge">${escapeHtml(repo.openSourceLicense)} license</span>`
    : repo.licenseSpdxId
      ? `<span class="badge">${escapeHtml(repo.licenseSpdxId)}</span>`
      : `<span class="badge muted">License not detected</span>`;

  sections.push({
    anchor: "readme-intro",
    html: `
      <section class="pad readme">
        <div class="bar">
          <span class="crumb">README.md</span>
          ${licenseLine}
        </div>
        <div class="prose" data-prose>${readmeHtml || "<p>No README content was returned for this repository.</p>"}</div>
      </section>`,
  });

  /* --- install --------------------------------------------------- */
  if (installCommand) {
    sections.push({
      anchor: "install-command",
      html: `
        <section class="pad">
          <div class="bar"><span class="crumb">Quick start</span></div>
          <pre class="code command"><code>${escapeHtml(installCommand)}</code></pre>
        </section>`,
    });
  }

  /* --- features --------------------------------------------------- */
  if (bullets.length > 0) {
    sections.push({
      anchor: "features",
      html: `
        <section class="pad">
          <div class="bar"><span class="crumb">Features</span></div>
          <ul class="checks">${bullets
            .map(item => `<li><svg viewBox="0 0 16 16" class="i tick"><path d="m3 8.5 3.2 3.2L13 4.5" stroke-width="2.2"/></svg><span>${inline(
              truncate(item, 130)
            )}</span></li>`)
            .join("")}</ul>
        </section>`,
    });
  }

  /* --- release / license ----------------------------------------- */
  const tail: string[] = [];
  if (repo.latestRelease?.tag_name) {
    tail.push(
      `<div class="fact"><span class="k">Latest release</span><span class="v">${escapeHtml(
        repo.latestRelease.tag_name
      )}</span></div>`
    );
  }
  tail.push(
    `<div class="fact"><span class="k">License</span><span class="v">${escapeHtml(
      repo.openSourceLicense ?? repo.licenseSpdxId ?? "not identified"
    )}</span></div>`
  );
  tail.push(
    `<div class="fact"><span class="k">Stars</span><span class="v">${formatCount(
      repo.stargazers_count
    )}</span></div>`
  );
  if (repo.topics.length > 0) {
    tail.push(
      `<div class="fact"><span class="k">Topics</span><span class="v">${repo.topics
        .slice(0, 5)
        .map(topic => escapeHtml(topic))
        .join(", ")}</span></div>`
    );
  }
  sections.push({
    anchor: "license",
    html: `<section class="pad"><div class="facts">${tail.join("")}</div></section>`,
  });

  return sections
    .map(section => `<div data-anchor="${section.anchor}">${section.html}</div>`)
    .join("");
}

/* ------------------------------------------------------------------ */
/* Full page                                                           */
/* ------------------------------------------------------------------ */

export function buildCardHtml(repo: EnrichedRepo): string {
  const viewportHeight =
    CARD.height - CARD_CHROME_HEIGHT - CARD_CAPTION_ZONE - CARD_PROGRESS_ZONE;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(repo.full_name)}</title>
<style>
  :root {
    --stage-bg: ${UI_TOKENS.stageBg};
    --card-bg: ${UI_TOKENS.cardBg};
    --surface-2: ${UI_TOKENS.surface2};
    --border: ${UI_TOKENS.border};
    --text-primary: ${UI_TOKENS.textPrimary};
    --text-secondary: ${UI_TOKENS.textSecondary};
    --github-blue: ${UI_TOKENS.githubBlue};
    --caption-yellow: ${UI_TOKENS.captionYellow};
    --caption-font: ${CAPTION_STYLE.fontFamily};
    --mono: ${CAPTION_STYLE.monoFamily};
  }
  * { margin: 0; padding: 0; box-sizing: border-box; transition: none !important; animation: none !important; }
  html, body { width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; overflow: hidden; background: var(--stage-bg); }
  body {
    display: grid; place-items: center;
    font-family: var(--caption-font);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  /* ---- stage: solid, flat, no scenery ---- */
  .stage { position: relative; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; background: var(--stage-bg); }

  /* ---- card: straight on, stationary, shadow never animated ---- */
  .card {
    position: absolute; left: ${CARD.left}px; top: ${CARD.top}px;
    width: ${CARD.width}px; height: ${CARD.height}px;
    background: var(--card-bg);
    border: ${CARD.border};
    border-radius: ${CARD.radius}px;
    box-shadow: ${CARD_SHADOW};
    overflow: hidden;
    display: flex; flex-direction: column;
    color: var(--text-primary);
  }

  /* ---- browser chrome: static ---- */
  .chrome {
    flex: 0 0 ${CARD_CHROME_HEIGHT}px; height: ${CARD_CHROME_HEIGHT}px;
    background: var(--surface-2); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 14px; padding: 0 20px;
  }
  .dots { display: flex; gap: 8px; }
  .dot-light { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; }
  .dot-mid { width: 12px; height: 12px; border-radius: 50%; background: #febc2e; }
  .dot-dark { width: 12px; height: 12px; border-radius: 50%; background: #28c840; }
  .urlbar {
    flex: 1; height: 30px; border-radius: 15px; background: rgba(110,118,129,.28);
    display: flex; align-items: center; gap: 8px; padding: 0 14px;
    color: var(--text-secondary); font-size: 13px; font-weight: 500;
  }
  .urlbar .lock { width: 11px; height: 11px; flex: 0 0 11px; }
  .urlbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- viewport clips the only moving layer ---- */
  .viewport { position: relative; flex: 1 1 auto; height: ${viewportHeight}px; overflow: hidden; background: var(--card-bg); }
  .document { position: absolute; inset: 0 0 auto 0; width: 100%; will-change: transform; }

  .pad { padding: 20px 24px; border-bottom: 1px solid var(--border); }

  .crumbs { display: flex; align-items: center; gap: 7px; font-size: 17px; flex-wrap: wrap; }
  .crumbs a { color: var(--github-blue); text-decoration: none; }
  .crumbs .strong { font-weight: 700; }
  .crumbs .sep { color: var(--text-secondary); }
  .i { width: 15px; height: 15px; fill: currentColor; stroke: currentColor; stroke-width: 1.2; }
  .crumbs .i { color: var(--text-primary); margin-right: 2px; }
  .badge {
    font-size: 12px; font-weight: 600; color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 9px;
  }
  .badge.muted { color: var(--text-secondary); }
  .desc { font-size: 15px; line-height: 1.5; color: var(--text-primary); margin-top: 12px; }
  .meta-row { display: flex; gap: 18px; margin-top: 12px; font-size: 13px; color: var(--text-secondary); }
  .meta { display: inline-flex; align-items: center; gap: 6px; }
  .meta .i { width: 13px; height: 13px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #f1e05a; display: inline-block; }
  .tabs { display: flex; gap: 4px; margin-top: 16px; flex-wrap: wrap; }
  .tab {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 13px; color: var(--text-secondary);
    padding: 6px 11px; border-radius: 999px; border: 1px solid transparent;
  }
  .tab em { font-style: normal; background: rgba(110,118,129,.3); border-radius: 999px; padding: 0 8px; font-size: 11px; }
  .tab.active { color: var(--text-primary); border-color: var(--border); font-weight: 600; }

  .bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .crumb { font-size: 14px; font-weight: 600; }
  .commit, .fdate { font-size: 12px; color: var(--text-secondary); }

  .files { list-style: none; font-size: 14px; }
  .files li { display: flex; align-items: center; gap: 9px; padding: 8px 0; border-top: 1px solid rgba(48,54,61,.55); }
  .files li:first-child { border-top: none; }
  .files .i.file { color: var(--text-secondary); width: 14px; height: 14px; }
  .files .i.dir { color: #58a6ff; width: 14px; height: 14px; }
  .fname { font-family: var(--mono); font-size: 13px; }
  .fmsg { flex: 1; }
  .fdate { margin-left: auto; }

  .prose { font-size: 14px; line-height: 1.55; color: var(--text-primary); }
  .prose h2, .prose h3 { margin: 18px 0 8px; font-size: 19px; line-height: 1.3; }
  .prose h2:first-child, .prose h3:first-child { margin-top: 0; }
  .prose p { margin-bottom: 12px; }
  .prose ul { margin: 0 0 12px 20px; }
  .prose li { margin-bottom: 6px; }
  .prose hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
  .prose table.md-table { border-collapse: collapse; margin: 0 0 14px; width: 100%; }
  .prose table.md-table th, .prose table.md-table td {
    border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top;
  }
  .prose table.md-table th { background: var(--surface-2); font-weight: 600; }
  .prose strong { font-weight: 700; }
  code.inline, .prose code {
    font-family: var(--mono); font-size: 12px; background: rgba(110,118,129,.24);
    border-radius: 4px; padding: 1px 4px;
  }
  pre.code {
    font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
    background: #010409; border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; overflow: hidden; white-space: pre-wrap; word-break: break-word;
  }
  pre.code.command { color: #7ee787; }
  pre.code code { background: none; padding: 0; font-size: inherit; }

  .checks { list-style: none; }
  .checks li { display: flex; gap: 9px; align-items: flex-start; font-size: 14px; line-height: 1.45; margin-bottom: 9px; }
  .i.tick { flex: 0 0 15px; width: 15px; height: 15px; color: #3fb950; fill: none; stroke: #3fb950; margin-top: 2px; }

  .facts { display: grid; gap: 10px; }
  .fact { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; }
  .fact .k { color: var(--text-secondary); }
  .fact .v { color: var(--text-primary); font-weight: 600; text-align: right; }

  /* ---- captions: static box inside the card, no filled word boxes ---- */
  .caption-zone {
    flex: 0 0 ${CARD_CAPTION_ZONE}px; height: ${CARD_CAPTION_ZONE}px;
    display: flex; align-items: center; justify-content: center;
    padding: 0 24px; pointer-events: none; background: var(--card-bg);
  }
  .caption {
    width: 100%; max-width: ${Math.round(CARD.width * CAPTION_STYLE.maxWidthRatio)}px;
    text-align: center; color: ${CAPTION_STYLE.color};
    font-size: ${CAPTION_STYLE.fontSizePx}px; font-weight: ${CAPTION_STYLE.fontWeight};
    line-height: ${CAPTION_STYLE.lineHeight}; letter-spacing: ${CAPTION_STYLE.letterSpacingPx}px;
    text-transform: uppercase; text-shadow: ${CAPTION_STYLE.textShadow};
    text-wrap: balance; overflow-wrap: break-word;
  }
  .caption .hl { color: ${CAPTION_STYLE.highlightColor}; }

  /* ---- progress: static ---- */
  .progress {
    flex: 0 0 ${CARD_PROGRESS_ZONE}px; height: ${CARD_PROGRESS_ZONE}px;
    display: flex; align-items: center; gap: 14px; padding: 0 24px 6px;
    background: var(--card-bg);
  }
  .track { position: relative; flex: 1; height: 5px; border-radius: 999px; background: #484B50; }
  .fill { position: absolute; left: 0; top: 0; height: 100%; border-radius: inherit; background: var(--caption-yellow); width: 0; }
  .thumb {
    position: absolute; top: 50%; left: 0; width: 14px; height: 14px; margin-left: -7px;
    border-radius: 50%; background: #fff; transform: translateY(-50%); left: 0;
  }
  .time { font-size: 12px; color: #fff; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
</style>
</head>
<body>
<div class="stage">
  <article class="card" id="card">
    <header class="chrome">
      <span class="dots"><i class="dot-light"></i><i class="dot-mid"></i><i class="dot-dark"></i></span>
      <span class="urlbar">
        <svg viewBox="0 0 16 16" class="lock" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
        </svg>
        <span>${escapeHtml(repo.html_url.replace(/^https?:\/\//, ""))}</span>
      </span>
    </header>

    <div class="viewport" id="viewport">
      <div class="document" id="document">${buildDocument(repo)}</div>
    </div>

    <div class="caption-zone"><div class="caption" id="caption"></div></div>

    <div class="progress">
      <div class="track"><div class="fill" id="fill"></div><div class="thumb" id="thumb"></div></div>
      <span class="time" id="time">0:00 / 0:00</span>
    </div>
  </article>
</div>
<script>
  // Rendering hooks used by browser-capture.ts. No network access, no eval of
  // repository content: everything below operates on the sanitized DOM.
  window.__showcase = {
    setScroll(y) {
      document.getElementById('document').style.transform =
        'translate3d(0,' + (-y) + 'px,0)';
    },
    setCaption(html) {
      document.getElementById('caption').innerHTML = html || '';
    },
    setProgress(fraction, currentMs, totalMs) {
      const pct = Math.max(0, Math.min(1, fraction)) * 100;
      document.getElementById('fill').style.width = pct + '%';
      document.getElementById('thumb').style.left = pct + '%';
      const fmt = ms => {
        const total = Math.max(0, Math.round(ms / 1000));
        return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
      };
      document.getElementById('time').textContent =
        fmt(currentMs) + ' / ' + fmt(totalMs);
    },
    measure() {
      const doc = document.getElementById('document');
      const viewport = document.getElementById('viewport');
      const anchors = Array.from(document.querySelectorAll('[data-anchor]')).map(node => ({
        anchor: node.getAttribute('data-anchor'),
        offsetTop: node.offsetTop,
        offsetHeight: node.offsetHeight,
      }));
      return {
        anchors,
        documentHeight: doc.offsetHeight,
        viewportHeight: viewport.clientHeight,
        card: {
          left: document.getElementById('card').getBoundingClientRect().left,
          top: document.getElementById('card').getBoundingClientRect().top,
          width: document.getElementById('card').getBoundingClientRect().width,
          height: document.getElementById('card').getBoundingClientRect().height,
        },
      };
    },
    geometry() {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const card = document.getElementById('card').getBoundingClientRect();
      return {
        stage: { width: stage.width, height: stage.height },
        card: {
          left: card.left - stage.left, top: card.top - stage.top,
          width: card.width, height: card.height,
        },
        progress: document.querySelector('.track').getBoundingClientRect().width,
      };
    }
  };
</script>
</body>
</html>`;
}

export const CARD_VIEWPORT_HEIGHT =
  CARD.height - CARD_CHROME_HEIGHT - CARD_CAPTION_ZONE - CARD_PROGRESS_ZONE;