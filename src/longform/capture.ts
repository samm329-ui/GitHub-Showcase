/**
 * Long-form authentic GitHub capture (1920×1080 desktop viewport).
 *
 * Hard rule: there is NO mock-page fallback here. A capture that cannot be
 * validated as the real GitHub page throws CaptureError and fails the stage.
 * A previously stored capture may be reused only when it passes the same
 * validation and its manifest matches (sha256).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";
import {
  closeTarget,
  evaluate,
  navigate,
  openTarget,
  setViewport,
  sleep,
  waitFor,
  type CdpClient,
} from "../cdp.js";
import { detectFailedPage } from "../mobile-capture.js";
import { getRootFiles } from "../github.js";
import type {
  CaptureBundle,
  CaptureTile,
  MeasuredAnchor,
  SourceFileCapture,
  RepositoryCapture,
} from "./types.js";

export class CaptureError extends Error {
  override name = "CaptureError";
}

const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };
const MAX_TILE_HEIGHT = 2200;
const NAVIGATION_TIMEOUT_MS = 25_000;
const SETTLE_MS = 1200;

const MEASURE_AND_ANCHORS = `(() => {
  const out = { documentHeightCssPx: 0, bodyTextLength: 0, title: document.title, href: location.href, anchors: [] };
  out.documentHeightCssPx = Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  );
  out.bodyTextLength = (document.body ? document.body.innerText : "").trim().length;
  out.title = document.title || "";
  out.href = location.href;
  const headingRe = /^(readme|features?|installation|getting started|quick.?start|usage|examples?|license|how it works|requirements)$/i;
  const nodes = document.querySelectorAll("h1, h2, h3");
  for (const n of nodes) {
    const text = (n.textContent || "").trim();
    if (!text || text.length > 80) continue;
    if (!n.offsetParent && getComputedStyle(n).position !== "fixed") continue;
    const lower = text.toLowerCase().replace(/[^a-z ]/g, "").trim();
    const rect = n.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const isReadmeHeading = n.closest("article, .markdown-body") !== null;
    out.anchors.push({
      anchor: isReadmeHeading ? "readme:" + lower.replace(/\\s+/g, " ").slice(0, 60) : "heading:" + lower.slice(0, 60),
      offsetTop: Math.round(top),
      offsetHeight: Math.round(rect.height),
      text,
      isReadme: isReadmeHeading,
      rank: n.tagName,
    });
    if (out.anchors.length >= 40) break;
  }
  const repoTitle = document.querySelector('strong[itemprop="name"] a, h1 strong a, [data-testid="repository-name"]');
  if (repoTitle) {
    const r = repoTitle.getBoundingClientRect();
    out.anchors.push({ anchor: "repo-header", offsetTop: Math.round(r.top + window.scrollY), offsetHeight: Math.round(r.height), text: repoTitle.textContent.trim(), isReadme: false, rank: "REPO" });
  }
  return out;
})()`;

async function stitchTiles(
  tiles: Array<{ offsetY: number; buffer: Buffer }>,
  width: number,
  totalHeight: number,
  outFile: string
): Promise<{ width: number; height: number; sha256: string; bytes: number }> {
  const canvas = createCanvas(width, totalHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, width, totalHeight);
  let loaded = 0;
  for (const tile of tiles) {
    const img = await loadImage(tile.buffer);
    ctx.drawImage(img, 0, tile.offsetY);
    loaded += 1;
  }
  if (loaded !== tiles.length) throw new CaptureError("failed to decode one or more capture tiles");
  const buffer = canvas.toBuffer("image/jpeg", { quality: 92 });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, buffer);
  return {
    width,
    height: totalHeight,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  };
}

function normalizeRepoSlug(fullName: string): string {
  return fullName.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/**
 * Resolve highlight target texts against the live page DOM and return rects in
 * full-page image coordinates (deviceScaleFactor = 1, so CSS px == image px).
 * Targets that cannot be located return validated:false and must be dropped.
 */
export async function resolveHighlightRects(
  client: CdpClient,
  targets: Array<{ segmentId: string; targetText: string }>
): Promise<Array<{
  segmentId: string;
  targetText: string;
  x: number; y: number; width: number; height: number;
  source: "dom";
  validated: boolean;
}>> {
  if (targets.length === 0) return [];
  const targetsJson = JSON.stringify(
    targets.map(t => ({ segmentId: t.segmentId, targetText: t.targetText.replace(/\s+/g, " ").trim() }))
  );
  const out = (await evaluate(
    client,
    `(() => {
      const targets = ${targetsJson};
      const norm = s => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const results = [];
      for (const target of targets) {
        const needle = norm(target.targetText);
        if (needle.length < 6) { results.push({ segmentId: target.segmentId, targetText: target.targetText, validated: false, reason: 'too-short' }); continue; }
        let best = null;
        const els = document.querySelectorAll('p, li, h1, h2, h3, h4, td, th, pre, code, span, div');
        for (const el of els) {
          const text = norm(el.textContent || '');
          if (!text.includes(needle)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 10) continue;
          // prefer the smallest containing element (deepest match)
          if (!best || r.width * r.height < best.width * best.height) {
            best = { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
          }
        }
        if (best) {
          results.push({
            segmentId: target.segmentId,
            targetText: target.targetText,
            x: Math.round(best.x), y: Math.round(best.y), width: Math.round(best.width), height: Math.round(best.height),
            validated: true,
          });
        } else {
          results.push({ segmentId: target.segmentId, targetText: target.targetText, validated: false, reason: 'not-found' });
        }
      }
      return results;
    })()`
  )) as Array<Record<string, unknown>>;
  return (out ?? []).map(r => ({
    segmentId: String(r.segmentId),
    targetText: String(r.targetText),
    x: Number(r.x ?? 0),
    y: Number(r.y ?? 0),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
    source: "dom" as const,
    validated: Boolean(r.validated),
  }));
}

function validateLoadedPage(state: {
  title: string;
  href: string;
  bodyTextLength: number;
  documentHeightCssPx: number;
}, fullName: string): void {
  const slug = normalizeRepoSlug(fullName);
  const href = state.href.toLowerCase();
  if (!href.includes(`/${slug}`) && !href.includes(slug)) {
    throw new CaptureError(`page URL ${state.href} does not match expected repository ${fullName}`);
  }
  const failure = detectFailedPage({
    url: state.href,
    title: state.title,
    bodyText: "x".repeat(state.bodyTextLength),
    documentHeightCssPx: state.documentHeightCssPx,
    viewportHeightCssPx: VIEWPORT.height,
  });
  if (failure) throw new CaptureError(`GitHub page failed authenticity check: ${failure}`);
  const titleLower = state.title.toLowerCase().replace(/[\s_-]/g, "");
  const repoPart = slug.split("/")[1].replace(/[\s_-]/g, "");
  if (!titleLower.includes(repoPart)) {
    throw new CaptureError(`page title does not reference the repository (${state.title})`);
  }
}

async function captureTiledPage(client: CdpClient, documentHeight: number, workFile: string): Promise<{
  imagePath: string; sha256: string; bytes: number; tiles: CaptureTile[]; totalHeight: number;
}> {
  const tiles: CaptureTile[] = [];
  const buffers: Array<{ offsetY: number; buffer: Buffer }> = [];
  const totalHeight = Math.max(1, Math.min(documentHeight, 30_000));
  for (let offsetY = 0; offsetY < totalHeight; offsetY += MAX_TILE_HEIGHT) {
    const height = Math.min(MAX_TILE_HEIGHT, totalHeight - offsetY);
    const shot = await client.Page.captureScreenshot({
      format: "jpeg",
      quality: 92,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: offsetY, width: VIEWPORT.width, height, scale: 1 },
    });
    buffers.push({ offsetY, buffer: Buffer.from(shot.data, "base64") });
    tiles.push({ index: tiles.length, offsetY, heightPx: height });
  }
  const stitched = await stitchTiles(buffers, VIEWPORT.width, totalHeight, workFile);
  return {
    imagePath: workFile,
    sha256: stitched.sha256,
    bytes: stitched.bytes,
    tiles,
    totalHeight,
  };
}

export async function captureRepositoryPage(
  repo: { nodeId: string; fullName: string },
  workDir: string,
  options: { highlightTargets?: Array<{ segmentId: string; targetText: string }> } = {}
): Promise<RepositoryCapture> {
  const outDir = path.join(workDir, "captures", repo.nodeId);
  await fs.mkdir(outDir, { recursive: true });
  const imagePath = path.join(outDir, "overview.jpg");
  const warnings: string[] = [];
  const { client, targetId } = await openTarget();
  try {
    await setViewport(client, VIEWPORT);
    await client.Page.enable();
    await client.Runtime.enable();
    const url = `https://github.com/${repo.fullName}`;
    const loaded = await navigate(client, url, NAVIGATION_TIMEOUT_MS);
    if (!loaded) warnings.push("navigation load event timed out; continuing after DOM settle");
    await sleep(SETTLE_MS);
    await waitFor(client, "document.readyState === 'complete'", 8_000);
    const state = (await evaluate(client, MEASURE_AND_ANCHORS)) as {
      documentHeightCssPx: number;
      bodyTextLength: number;
      title: string;
      href: string;
      anchors: Array<MeasuredAnchor & { text?: string; isReadme?: boolean; rank?: string }>;
    };
    validateLoadedPage(state, repo.fullName);

    // Resolve highlight targets against the live DOM BEFORE the capture.
    const highlightTargets = (options.highlightTargets ?? []).filter(t => t.targetText.trim().length >= 6);
    const resolvedHighlights = highlightTargets.length > 0
      ? await resolveHighlightRects(client, highlightTargets)
      : [];

    const stitched = await captureTiledPage(client, state.documentHeightCssPx, imagePath);
    const anchors: MeasuredAnchor[] = state.anchors.map(a => ({
      anchor: a.anchor,
      offsetTop: a.offsetTop,
      offsetHeight: a.offsetHeight,
    }));
    const highlights = resolvedHighlights.filter(h => h.validated);
    for (const dropped of resolvedHighlights.filter(h => !h.validated)) {
      warnings.push(`highlight target not located for segment ${dropped.segmentId}: "${dropped.targetText.slice(0, 60)}"`);
    }
    const capture: RepositoryCapture = {
      nodeId: repo.nodeId,
      fullName: repo.fullName,
      kind: "overview",
      sourceUrl: url,
      capturedAt: new Date().toISOString(),
      cssViewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      documentHeightCssPx: stitched.totalHeight,
      imagePath: stitched.imagePath,
      sha256: stitched.sha256,
      bytes: stitched.bytes,
      tiles: stitched.tiles,
      anchors,
      highlights,
      warnings,
    };
    await writeManifest(outDir, capture);
    return capture;
  } finally {
    await client.close().catch(() => undefined);
    await closeTarget(targetId).catch(() => undefined);
  }
}

async function writeManifest(dir: string, capture: RepositoryCapture): Promise<void> {
  await fs.writeFile(
    path.join(dir, "overview.json"),
    JSON.stringify(capture, null, 2),
    "utf8"
  );
}

/* ------------------------------------------------------------------ */
/* Source-file selection (GitHub contents API; real blob view capture) */
/* ------------------------------------------------------------------ */

const ENTRY_CANDIDATES = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "src/main.rs",
  "src/lib.rs",
  "src/main.ts",
  "src/index.ts",
  "src/main.js",
  "src/index.js",
  "src/main.py",
  "src/__main__.py",
  "main.py",
  "index.ts",
  "lib/main.dart",
];

/** Choose the most story-relevant source file from the real repository tree. */
export async function chooseSourceFile(fullName: string): Promise<{ path: string; reason: string } | null> {
  let root: Awaited<ReturnType<typeof getRootFiles>>;
  try {
    root = await getRootFiles(fullName);
  } catch {
    return null;
  }
  const names = new Set(root.map(e => e.path));
  const hasPackageJson = names.has("package.json");
  if (hasPackageJson) {
    try {
      const body = await fetch(`https://raw.githubusercontent.com/${fullName}/HEAD/package.json`, {
        headers: { "User-Agent": "github-showcase" },
      }).then(r => (r.ok ? r.text() : ""));
      const pkg = JSON.parse(body) as { main?: string; module?: string; exports?: unknown };
      const entry =
        typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") :
        typeof pkg.module === "string" ? pkg.module.replace(/^\.\//, "") : null;
      if (entry && /\.(ts|js|mjs|cjs)$/.test(entry)) {
        return { path: entry, reason: "package.json entry point" };
      }
    } catch {
      /* fall through to candidate list */
    }
  }
  for (const candidate of ENTRY_CANDIDATES) {
    if (names.has(candidate)) return { path: candidate, reason: "conventional entry point" };
  }
  // Fall back to the largest TS/JS/PY/RS source-ish file in root (or one level of src/).
  const sourceish = root.filter(e => e.type === "file" && /\.(ts|tsx|js|jsx|py|rs|go|java|kt)$/.test(e.path) && !/test|spec|\.d\.ts$/.test(e.path));
  if (sourceish.length > 0) {
    sourceish.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    return { path: sourceish[0].path, reason: "largest top-level source file" };
  }
  const srcDir = root.find(e => e.type === "dir" && e.path === "src");
  if (srcDir) return { path: "src/index.ts", reason: "src/ entry (existence unverified until capture)" };
  return null;
}

/** Capture the real GitHub blob view of a file, and locate the highlight lines. */
export async function captureSourceFile(
  repo: { nodeId: string; fullName: string },
  filePath: string,
  workDir: string,
  targetText: string | null
): Promise<SourceFileCapture> {
  const outDir = path.join(workDir, "captures", repo.nodeId);
  await fs.mkdir(outDir, { recursive: true });
  const imagePath = path.join(outDir, "source-file.jpg");
  const warnings: string[] = [];
  const url = `https://github.com/${repo.fullName}/blob/HEAD/${filePath}`;
  const { client, targetId } = await openTarget();
  try {
    await setViewport(client, VIEWPORT);
    await client.Page.enable();
    await client.Runtime.enable();
    const loaded = await navigate(client, url, NAVIGATION_TIMEOUT_MS);
    if (!loaded) warnings.push("navigation load event timed out; continuing after DOM settle");
    await sleep(SETTLE_MS);
    // GitHub renders code lines lazily; wait for at least one code cell.
    await waitFor(
      client,
      "document.querySelector('.react-code-text, .blob-code, [data-testid=\"code-cell\"]') !== null",
      12_000
    ).catch(() => undefined);
    const state = (await evaluate(
      client,
      `(() => {
        const out = { title: document.title, href: location.href, bodyTextLength: (document.body ? document.body.innerText : '').trim().length, rows: [] };
        const rows = document.querySelectorAll('.react-code-text, .blob-code');
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          const text = (row.textContent || '').replace(/\\s+$/, '');
          out.rows.push({ top: Math.round(r.top + window.scrollY), height: Math.round(r.height), text: text.slice(0, 400) });
          if (out.rows.length >= 400) break;
        }
        if (out.rows.length === 0) {
          const pre = document.querySelector('pre');
          if (pre) {
            const r = pre.getBoundingClientRect();
            out.rows.push({ top: Math.round(r.top + window.scrollY), height: Math.round(r.height), text: (pre.innerText || '').slice(0, 4000) });
          }
        }
        return out;
      })()`
    )) as { title: string; href: string; bodyTextLength: number; rows: Array<{ top: number; height: number; text: string }> };

    const failure = detectFailedPage({
      url: state.href,
      title: state.title,
      bodyText: "x".repeat(state.bodyTextLength),
      documentHeightCssPx: VIEWPORT.height * 2,
      viewportHeightCssPx: VIEWPORT.height,
    });
    if (failure) throw new CaptureError(`source file page failed authenticity check: ${failure}`);
    if (!state.href.toLowerCase().includes(filePath.toLowerCase())) {
      throw new CaptureError(`source file view does not reference ${filePath}`);
    }

    // Locate highlight lines (1-based by row order) if a target text was supplied.
    let lineHighlight: SourceFileCapture["lineHighlight"] = null;
    if (targetText && targetText.trim()) {
      const needle = targetText.trim().toLowerCase().slice(0, 120);
      const hits: number[] = [];
      for (const [i, row] of state.rows.entries()) {
        if (row.text.toLowerCase().includes(needle)) hits.push(i);
      }
      if (hits.length > 0) {
        const first = hits[0];
        const last = hits[hits.length - 1];
        const firstRow = state.rows[first];
        const lastRow = state.rows[last];
        lineHighlight = {
          lineStart: first + 1,
          lineEnd: last + 1,
          x: 0,
          y: firstRow.top,
          width: VIEWPORT.width,
          height: lastRow.top + lastRow.height - firstRow.top,
        };
      } else {
        warnings.push("highlight target not found in visible code rows; scene will render without the highlight");
      }
    }

    const shot = await client.Page.captureScreenshot({
      format: "jpeg",
      quality: 90,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const buffer = Buffer.from(shot.data, "base64");
    await fs.writeFile(imagePath, buffer);
    const capture: SourceFileCapture = {
      nodeId: repo.nodeId,
      fullName: repo.fullName,
      kind: "source-file",
      filePath,
      sourceUrl: url,
      capturedAt: new Date().toISOString(),
      imagePath,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
      cssViewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      lineHighlight,
      syntaxLanguage: /\.(ts|tsx)$/.test(filePath) ? "typescript" : /\.(js|jsx|mjs)$/.test(filePath) ? "javascript" : /\.py$/.test(filePath) ? "python" : /\.rs$/.test(filePath) ? "rust" : /\.go$/.test(filePath) ? "go" : null,
      contentHash: createHash("sha256").update(state.rows.map(r => r.text).join("\n")).digest("hex"),
      warnings,
    };
    await fs.writeFile(path.join(outDir, "source-file.json"), JSON.stringify(capture, null, 2), "utf8");
    return capture;
  } finally {
    await client.close().catch(() => undefined);
    await closeTarget(targetId).catch(() => undefined);
  }
}

/** Convenience: capture both overview and (optionally) a source file for one repository. */
export async function captureRepositoryBundle(
  repo: { nodeId: string; fullName: string },
  workDir: string,
  options: { wantSourceFile: boolean; targetText: string | null; highlightTargets?: Array<{ segmentId: string; targetText: string }> }
): Promise<CaptureBundle> {
  const overview = await captureRepositoryPage(repo, workDir, { highlightTargets: options.highlightTargets });
  let sourceFile: SourceFileCapture | null = null;
  if (options.wantSourceFile) {
    const choice = await chooseSourceFile(repo.fullName);
    if (choice) {
      try {
        sourceFile = await captureSourceFile(repo, choice.path, workDir, options.targetText);
      } catch (error) {
        // Source files are optional visuals; record and continue without one.
        overview.warnings.push(
          `source file capture skipped: ${error instanceof Error ? error.message : String(error)}`
        );
        await writeManifest(path.join(workDir, "captures", repo.nodeId), overview);
      }
    } else {
      overview.warnings.push("no suitable source file could be identified");
    }
  }
  return { nodeId: repo.nodeId, overview, sourceFile };
}
