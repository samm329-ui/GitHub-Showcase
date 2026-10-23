import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";
import { MOBILE_PAGE, SCROLL, VIEWPORT_PADDING } from "./config.js";
import type {
  EnrichedRepo,
  MeasuredAnchor,
  MobilePageCapture,
  VisualAnchor,
} from "./types.js";
import {
  closeTarget,
  evaluate,
  navigate,
  openTarget,
  setViewport,
  sleep,
  waitFor,
  type CdpClient,
} from "./cdp.js";
import { sanitizeReadmeHtml } from "./card.js";

/**
 * Real responsive GitHub capture.
 *
 * The source page is loaded in its own top-level Chromium target at a 405 CSS
 * px mobile viewport (device scale factor 2). It is never framed. The full page
 * is captured beyond the viewport, normalized to the 810 px card content width,
 * and its section anchors are stored in that displayed raster coordinate space.
 *
 * Chromium's returned pixel size is treated as unknown until the JPEG has been
 * decoded: the device scale factor is never assumed to equal the returned
 * width. If capture fails for a legitimate reason (network, abuse wall, 404,
 * sign-in), a local mobile-layout fallback built from repository data is
 * captured through the same pipeline and the reason is logged.
 */

export type CapturePageState = {
  title: string;
  href: string;
  bodyText: string;
  cssViewport: { width: number; height: number };
  documentHeightCssPx: number;
  anchors: { anchor: VisualAnchor; offsetTop: number; offsetHeight: number }[];
};

export type FailedPageInput = {
  url: string;
  title: string;
  bodyText: string;
  documentHeightCssPx: number;
  viewportHeightCssPx: number;
};

export type StorySpanInput = {
  anchors: MeasuredAnchor[];
  fullHeightPx: number;
  viewportHeightPx: number;
  durationMs: number;
  referencedAnchors: VisualAnchor[];
  maxStoryViewports?: number;
  minStoryViewports?: number;
  maxPxPerSecond?: number;
  introHoldMs?: number;
  outroHoldMs?: number;
};

export type StorySpan = {
  startPx: number;
  endPx: number;
  fullHeightPx: number;
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* Pure geometry helpers                                               */
/* ------------------------------------------------------------------ */

/** Map CSS-pixel DOM offsets into displayed screenshot pixels. */
export function scaleAnchorOffsets(
  anchors: { anchor: VisualAnchor; offsetTop: number; offsetHeight: number }[],
  pixelsPerCssPx: number
): MeasuredAnchor[] {
  return anchors
    .filter(
      anchor =>
        Number.isFinite(anchor.offsetTop) &&
        anchor.offsetTop >= 0 &&
        Number.isFinite(anchor.offsetHeight) &&
        anchor.offsetHeight > 0
    )
    .map(anchor => ({
      anchor: anchor.anchor,
      offsetTop: Math.round(anchor.offsetTop * pixelsPerCssPx),
      offsetHeight: Math.round(anchor.offsetHeight * pixelsPerCssPx),
      source: "captured" as const,
    }))
    .sort((a, b) => a.offsetTop - b.offsetTop);
}

/** Preserve aspect ratio while normalizing the raster to the card width. */
export function normalizeRasterSize(
  rawWidth: number,
  rawHeight: number,
  targetWidth: number
): { width: number; height: number; scale: number } {
  const safeWidth = Math.max(1, Math.round(rawWidth));
  const safeHeight = Math.max(1, Math.round(rawHeight));
  const width = Math.max(1, Math.round(targetWidth));
  const scale = width / safeWidth;
  return { width, height: Math.max(1, Math.round(safeHeight * scale)), scale };
}

/**
 * Page validation. A 404, sign-in wall, abuse challenge or empty shell must
 * never be presented as a repository screenshot.
 */
export function detectFailedPage(input: FailedPageInput): string | null {
  const url = input.url.toLowerCase();
  const title = input.title.toLowerCase();
  const body = input.bodyText.toLowerCase();

  if (/\/login|\/session|return_to=|signin|sign-in/.test(url)) {
    return "GitHub redirected to a sign-in page";
  }
  if (
    /(^|\b)(404|page not found|not found)\b/.test(title) ||
    /page not found|there isn't a github pages site here/i.test(body)
  ) {
    return "GitHub returned a 404 page";
  }
  if (/access denied|abuse|unusual traffic|rate limit|whoa there/.test(title + " " + body)) {
    return "GitHub returned an abuse or rate-limit page";
  }
  if (/sign in to github|you must be signed in|create an account to continue/i.test(body)) {
    return "GitHub requires sign-in for this page";
  }
  if (
    input.documentHeightCssPx < input.viewportHeightCssPx * 1.05 ||
    input.bodyText.trim().length < 120
  ) {
    return "The captured page was blank or still loading";
  }
  return null;
}

/**
 * Choose where the visual story ends.
 *
 * The last narrated section plus breathing room wins, but the crop is bounded
 * by the scroll budget (voice duration × permitted speed) and by a conservative
 * number of page viewports. If the install section is farther down than the
 * budget allows, the timeline is shortened instead of racing the scroll.
 */
export function chooseStoryEnd(input: StorySpanInput): StorySpan {
  const maxStoryViewports = input.maxStoryViewports ?? MOBILE_PAGE.maxStoryViewports;
  const minStoryViewports = input.minStoryViewports ?? MOBILE_PAGE.minStoryViewports;
  const maxSpeed = input.maxPxPerSecond ?? SCROLL.maxPxPerSecond;
  const intro = input.introHoldMs ?? SCROLL.introHoldMs;
  const outro = input.outroHoldMs ?? SCROLL.outroHoldMs;

  const fullHeight = Math.max(1, Math.round(input.fullHeightPx));
  const viewport = Math.max(1, Math.round(input.viewportHeightPx));
  const warnings: string[] = [];

  const usableSeconds = Math.max(
    1,
    input.durationMs / 1000 - (intro + outro) / 1000 - 0.6
  );
  const maxTravel = usableSeconds * maxSpeed * 0.92;
  const maxHeightBySpeed = viewport + maxTravel;
  const maxHeightByViewports = viewport * maxStoryViewports;
  const hardMax = Math.max(
    Math.min(viewport, fullHeight),
    Math.min(fullHeight, maxHeightBySpeed, maxHeightByViewports)
  );

  const byName = new Map(input.anchors.map(anchor => [anchor.anchor, anchor]));
  const referenced = input.referencedAnchors
    .map(name => byName.get(name))
    .filter((anchor): anchor is MeasuredAnchor => Boolean(anchor));

  const breathing = Math.max(140, Math.round(viewport * 0.16));

  /*
   * A section anchor usually spans the whole README, so adding its full
   * `offsetHeight` would drag the crop through content the narration never
   * mentions. What matters is that the last narrated section can reach the
   * top of the viewport: start + one viewport, plus a little breathing room.
   */
  const deepestReferencedStart = referenced.reduce(
    (max, anchor) => Math.max(max, anchor.offsetTop),
    0
  );

  const desired =
    referenced.length > 0
      ? deepestReferencedStart + Math.round(viewport * 0.92) + breathing
      : fullHeight;

  if (desired > hardMax) {
    warnings.push(
      `The story span was capped at ${Math.round(hardMax)} px (from ${Math.round(
        desired
      )} px); the last narrated section sits beyond the scroll budget and was not raced.`
    );
  }

  const minimum = Math.min(fullHeight, Math.round(viewport * minStoryViewports));
  const endPx = Math.max(
    Math.min(viewport, fullHeight),
    Math.min(fullHeight, hardMax, Math.max(minimum, desired))
  );

  return {
    startPx: 0,
    endPx: Math.round(endPx),
    fullHeightPx: fullHeight,
    warnings,
  };
}

/** Load the tall image, crop to `storyEndPx`, and save a new JPEG. */
export async function cropMobileCapture(
  capture: MobilePageCapture,
  storyEndPx: number,
  outputPath: string
): Promise<MobilePageCapture> {
  const image = await loadImage(capture.imagePath);
  const end = Math.max(1, Math.min(image.height, Math.round(storyEndPx)));
  const canvas = createCanvas(image.width, end);
  canvas
    .getContext("2d")
    .drawImage(image, 0, 0, image.width, end, 0, 0, image.width, end);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    canvas.toBuffer("image/jpeg", { quality: MOBILE_PAGE.jpegQuality })
  );

  const anchors = capture.anchors
    .filter(anchor => anchor.offsetTop < end)
    .map(anchor => ({
      ...anchor,
      offsetHeight: Math.max(1, Math.min(anchor.offsetHeight, end - anchor.offsetTop)),
    }));

  return {
    ...capture,
    imagePath: outputPath,
    raster: { width: canvas.width, height: end },
    documentHeightCssPx: end / capture.pixelsPerCssPx,
    anchors,
  };
}

/* ------------------------------------------------------------------ */
/* In-page measurement                                                 */
/* ------------------------------------------------------------------ */

const MEASURE_SCRIPT = `(() => {
  const pick = (selectors) => {
    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) return element;
      } catch {}
    }
    return null;
  };
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    if (!Number.isFinite(top) || rect.height <= 0) return null;
    return { offsetTop: Math.round(top), offsetHeight: Math.round(rect.height) };
  };
  const heading = (patterns) => {
    const candidates = Array.from(document.querySelectorAll(
      '[data-testid="readme"] h1, [data-testid="readme"] h2, [data-testid="readme"] h3, [data-testid="readme"] h4, article.markdown-body h1, article.markdown-body h2, article.markdown-body h3, article.markdown-body h4, .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, main h1, main h2, main h3'
    ));
    for (const element of candidates) {
      const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (!text) continue;
      if (patterns.some((pattern) => new RegExp(pattern, 'i').test(text))) return element;
    }
    return null;
  };

  const readme = pick([
    '[data-testid="readme"]',
    'article.markdown-body',
    '.markdown-body',
    '#readme',
    'article[itemprop="text"]',
    '[data-anchor="readme-intro"]'
  ]);
  const repoHeader = pick([
    '[data-testid="repository-container-header"]',
    '#repository-container-header',
    '[data-anchor="repo-header"]',
    'main header',
    'main'
  ]);
  const fileList = pick([
    '[aria-labelledby="files"]',
    '[data-testid="tree-finder"]',
    'nav[aria-label="File tree"]',
    'table[aria-labelledby="files"]',
    '[data-anchor="file-list"]',
    '[role="grid"]'
  ]);
  const installHeading = heading(['^install', '^installation', '^quick ?start', '^getting started', '^setup', '^usage', '^how to']);
  const featureHeading = heading(['features?', 'what it does', 'capabilities', 'how it works', 'highlights', 'why ']);
  const licenseHeading = heading(['^licen[cs]e']);
  const licenseLink = pick(['a[href*="/blob/"][href*="LICENSE"]', 'a[href*="/blob/"][href*="LICENSE.md"]', '[data-anchor="license"]']);
  const release = pick([
    '[data-testid="releases-and-packages"]',
    '#releases',
    'a[href$="/releases"]',
    '[data-anchor="release"]'
  ]);

  const anchors = [
    { anchor: 'repo-header', element: repoHeader },
    { anchor: 'file-list', element: fileList },
    { anchor: 'readme-intro', element: readme },
    { anchor: 'install-command', element: installHeading },
    { anchor: 'features', element: featureHeading },
    { anchor: 'license', element: licenseHeading || licenseLink },
    { anchor: 'release', element: release }
  ].map((entry) => {
    const measured = box(entry.element);
    return measured ? { anchor: entry.anchor, ...measured } : null;
  }).filter(Boolean);

  return {
    title: document.title || '',
    href: location.href,
    bodyText: ((document.body && document.body.innerText) || '').slice(0, 6000),
    cssViewport: {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: window.innerHeight
    },
    documentHeightCssPx: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ),
    anchors
  };
})()`;

/** Scroll through the page so lazy images and deferred sections load. */
async function loadLazyContent(client: CdpClient): Promise<void> {
  await evaluate(
    client,
    `(async () => {
      const limit = Math.min(document.documentElement.scrollHeight, ${MOBILE_PAGE.maxCaptureCssHeight});
      const step = Math.max(240, Math.round(window.innerHeight * 0.8));
      for (let y = 0; y < limit; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const pending = Array.from(document.images)
        .filter((image) => !image.complete)
        .slice(0, 40)
        .map((image) => new Promise((resolve) => {
          const done = () => resolve(true);
          image.addEventListener('load', done, { once: true });
          image.addEventListener('error', done, { once: true });
          setTimeout(done, 1500);
        }));
      await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => setTimeout(resolve, 4000))
      ]);
      return true;
    })()`
  );
}

/* ------------------------------------------------------------------ */
/* Screenshot + normalization                                          */
/* ------------------------------------------------------------------ */

function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

async function captureSingle(
  client: CdpClient,
  widthCss: number,
  heightCss: number
): Promise<Buffer> {
  const shot = await client.Page.captureScreenshot({
    format: "jpeg",
    quality: MOBILE_PAGE.jpegQuality,
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: widthCss, height: heightCss, scale: 1 },
  });
  return decodeDataUrl(shot.data);
}

/**
 * Capture the page in vertical tiles when it is too tall for one screenshot.
 * Every tile is stitched in displayed raster space, so the result is one tall
 * image with a single coordinate system.
 */
async function captureTiled(
  client: CdpClient,
  widthCss: number,
  heightCss: number,
  deviceScaleFactor: number
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const tileCssHeight = Math.max(
    400,
    Math.floor(MOBILE_PAGE.tileRasterHeight / Math.max(1, deviceScaleFactor))
  );
  const tiles: { yCss: number; image: Awaited<ReturnType<typeof loadImage>> }[] = [];
  for (let y = 0; y < heightCss; y += tileCssHeight) {
    const tileHeight = Math.min(tileCssHeight, heightCss - y);
    const shot = await client.Page.captureScreenshot({
      format: "jpeg",
      quality: MOBILE_PAGE.jpegQuality,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y, width: widthCss, height: tileHeight, scale: 1 },
    });
    const image = await loadImage(decodeDataUrl(shot.data));
    tiles.push({ yCss: y, image });
  }
  if (tiles.length === 0) throw new Error("Chromium returned no screenshot tiles.");

  const rawWidth = tiles[0].image.width;
  const scale = rawWidth / Math.max(1, widthCss);
  const stitched = createCanvas(rawWidth, Math.max(1, Math.round(heightCss * scale)));
  const ctx = stitched.getContext("2d");
  for (const tile of tiles) {
    ctx.drawImage(tile.image, 0, Math.round(tile.yCss * scale));
  }
  return {
    buffer: stitched.toBuffer("image/jpeg", { quality: MOBILE_PAGE.jpegQuality }),
    width: rawWidth,
    height: stitched.height,
  };
}

function screenshotStats(canvas: ReturnType<typeof createCanvas>): {
  mean: number;
  variance: number;
} {
  const sample = createCanvas(48, 96);
  const ctx = sample.getContext("2d");
  ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
  const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    sum += luma;
    sumSq += luma * luma;
    count += 1;
  }
  const mean = count ? sum / count : 0;
  const variance = count ? Math.max(0, sumSq / count - mean * mean) : 0;
  return { mean, variance };
}

/* ------------------------------------------------------------------ */
/* Fallback mobile page                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Local mobile-layout page built only from already-fetched repository data. */
export function buildFallbackMobileHtml(repo: EnrichedRepo): string {
  const readme = repo.readmeText ? sanitizeReadmeHtml(repo.readmeText) : "";
  const files = repo.rootFiles
    .slice(0, 12)
    .map(
      entry =>
        `<li><span class="kind">${entry.type === "dir" ? "dir" : "file"}</span><span>${escapeHtml(
          entry.name
        )}</span></li>`
    )
    .join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(repo.full_name)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; }
  header[data-anchor] { padding: 18px 16px 14px; border-bottom: 1px solid #30363d; }
  .crumb { font-size: 15px; color: #8b949e; }
  .crumb strong { color: #58a6ff; font-weight: 600; }
  .badge { display: inline-block; margin-left: 8px; padding: 1px 8px; border: 1px solid #30363d; border-radius: 999px; font-size: 12px; color: #8b949e; }
  .desc { margin: 10px 0 0; font-size: 15px; color: #e6edf3; }
  .meta { margin-top: 10px; font-size: 13px; color: #8b949e; display: flex; gap: 16px; }
  nav[data-anchor] { padding: 12px 16px; border-bottom: 1px solid #30363d; }
  nav h2 { font-size: 13px; color: #8b949e; margin: 0 0 8px; font-weight: 600; }
  nav ul { list-style: none; margin: 0; padding: 0; }
  nav li { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid #21262d; font-size: 14px; }
  nav li:first-child { border-top: 0; }
  .kind { color: #8b949e; font-size: 12px; width: 30px; flex: 0 0 30px; }
  article[data-anchor] { padding: 16px; }
  .readme-label { font-size: 13px; color: #8b949e; border-bottom: 1px solid #30363d; padding-bottom: 8px; margin-bottom: 14px; }
  article h1, article h2, article h3 { line-height: 1.3; margin: 20px 0 10px; }
  article h1 { font-size: 24px; } article h2 { font-size: 21px; } article h3 { font-size: 18px; }
  article p { margin: 0 0 12px; }
  article ul { margin: 0 0 12px 20px; padding: 0; }
  article li { margin-bottom: 6px; }
  article pre { background: #010409; border: 1px solid #30363d; border-radius: 8px; padding: 12px; overflow: hidden; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  article code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  [data-anchor="release"], [data-anchor="license"] { padding: 16px; border-top: 1px solid #30363d; font-size: 14px; color: #8b949e; }
  [data-anchor="release"] h2, [data-anchor="license"] h2 { font-size: 17px; color: #e6edf3; margin: 0 0 8px; }
</style></head>
<body>
  <header data-anchor="repo-header">
    <div class="crumb">${escapeHtml(repo.owner)} / <strong>${escapeHtml(repo.name)}</strong><span class="badge">Public</span></div>
    <p class="desc">${escapeHtml(repo.description ?? "No description provided.")}</p>
    <div class="meta"><span>Stars ${repo.stargazers_count}</span><span>Forks ${repo.forks_count}</span><span>${escapeHtml(
      repo.primaryLanguage ?? ""
    )}</span></div>
  </header>
  <nav data-anchor="file-list" aria-label="File tree">
    <h2>Files</h2>
    <ul>${files || "<li><span class=\"kind\">file</span><span>README.md</span></li>"}</ul>
  </nav>
  <article data-anchor="readme-intro" class="markdown-body" data-testid="readme">
    <div class="readme-label">README.md</div>
    ${readme || "<p>No README content was returned for this repository.</p>"}
  </article>
  <section data-anchor="release">
    <h2>Releases</h2>
    <p>${escapeHtml(repo.latestRelease?.tag_name ?? "No tagged release")}</p>
  </section>
  <section data-anchor="license">
    <h2>License</h2>
    <p>${escapeHtml(repo.openSourceLicense ?? repo.licenseSpdxId ?? "Not identified")}</p>
  </section>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* Capture orchestration                                               */
/* ------------------------------------------------------------------ */

async function capturePage(
  client: CdpClient,
  options: {
    url?: string;
    html?: string;
    outputDir: string;
    imageName: string;
    source: "live" | "fallback";
    warnings: string[];
  }
): Promise<MobilePageCapture> {
  await setViewport(client, {
    width: MOBILE_PAGE.viewportWidthCss,
    height: MOBILE_PAGE.viewportHeightCss,
    deviceScaleFactor: MOBILE_PAGE.deviceScaleFactor,
    mobile: true,
  });
  await client.Page.enable();
  await client.Runtime.enable();

  if (options.url) {
    const loaded = await navigate(client, options.url, MOBILE_PAGE.navigationTimeoutMs);
    if (!loaded) {
      options.warnings.push("Navigation load event timed out; continuing after the DOM settled.");
    }
  } else if (options.html) {
    const tree = await client.Page.getFrameTree();
    await client.Page.setDocumentContent({ frameId: tree.frameTree.frame.id, html: options.html });
  }

  await sleep(MOBILE_PAGE.settleMs);
  await loadLazyContent(client);
  await waitFor(client, "document.readyState === 'complete'", 4_000);

  const state = (await evaluate(client, MEASURE_SCRIPT)) as CapturePageState;
  const failure =
    options.source === "live"
      ? detectFailedPage({
          url: state.href || options.url || "",
          title: state.title,
          bodyText: state.bodyText,
          documentHeightCssPx: state.documentHeightCssPx,
          viewportHeightCssPx: state.cssViewport.height,
        })
      : null;
  if (failure) throw new Error(failure);

  const widthCss = Math.max(1, Math.round(state.cssViewport.width));
  const heightCss = Math.max(
    1,
    Math.min(MOBILE_PAGE.maxCaptureCssHeight, Math.round(state.documentHeightCssPx))
  );
  if (state.documentHeightCssPx > heightCss) {
    options.warnings.push(
      `Page height ${state.documentHeightCssPx}px was capped at ${heightCss} CSS px for capture.`
    );
  }

  const tiled =
    heightCss * MOBILE_PAGE.deviceScaleFactor > MOBILE_PAGE.tileRasterHeight;
  let raw: { buffer: Buffer; width: number; height: number };
  if (tiled) {
    raw = await captureTiled(client, widthCss, heightCss, MOBILE_PAGE.deviceScaleFactor);
  } else {
    const buffer = await captureSingle(client, widthCss, heightCss);
    const image = await loadImage(buffer);
    raw = { buffer, width: image.width, height: image.height };
  }

  const normalized = normalizeRasterSize(
    raw.width,
    raw.height,
    MOBILE_PAGE.displayWidthPx
  );
  const canvas = createCanvas(normalized.width, normalized.height);
  const ctx = canvas.getContext("2d");
  const rawImage = await loadImage(raw.buffer);
  ctx.drawImage(rawImage, 0, 0, normalized.width, normalized.height);

  const stats = screenshotStats(canvas);
  if (stats.mean < 4 || stats.variance < 12) {
    throw new Error(
      `The screenshot was effectively blank (mean luma ${stats.mean.toFixed(1)}, variance ${stats.variance.toFixed(1)}).`
    );
  }

  const imagePath = path.join(options.outputDir, options.imageName);
  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.writeFile(
    imagePath,
    canvas.toBuffer("image/jpeg", { quality: MOBILE_PAGE.jpegQuality })
  );

  const pixelsPerCssPx = normalized.width / widthCss;
  const anchors = scaleAnchorOffsets(state.anchors, pixelsPerCssPx);

  const capture: MobilePageCapture = {
    imagePath,
    sourceUrl: options.url ?? `local://${options.imageName}`,
    source: options.source,
    cssViewport: { width: widthCss, height: MOBILE_PAGE.viewportHeightCss },
    raster: { width: normalized.width, height: normalized.height },
    rawRaster: { width: raw.width, height: raw.height },
    pixelsPerCssPx,
    documentHeightCssPx: heightCss,
    anchors,
    title: state.title,
    capturedAt: new Date().toISOString(),
    warnings: options.warnings,
  };

  await fs.writeFile(
    path.join(options.outputDir, "mobile-page.json"),
    JSON.stringify({ ...capture, stats }, null, 2),
    "utf8"
  );
  return capture;
}

export async function captureMobileRepositoryPage(
  repo: EnrichedRepo,
  outputDir: string
): Promise<MobilePageCapture> {
  await fs.mkdir(outputDir, { recursive: true });
  const warnings: string[] = [];
  const url = `https://github.com/${repo.full_name}`;

  try {
    const { client, targetId } = await openTarget();
    try {
      return await capturePage(client, {
        url,
        outputDir,
        imageName: "mobile-page-full.jpg",
        source: "live",
        warnings,
      });
    } finally {
      await client.close().catch(() => undefined);
      await closeTarget(targetId);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`Live mobile capture failed: ${reason}. Using the local mobile fallback.`);
    console.warn(`  mobile capture fallback: ${reason}`);

    const { client, targetId } = await openTarget();
    try {
      return await capturePage(client, {
        html: buildFallbackMobileHtml(repo),
        outputDir,
        imageName: "mobile-page-fallback.jpg",
        source: "fallback",
        warnings,
      });
    } finally {
      await client.close().catch(() => undefined);
      await closeTarget(targetId);
    }
  }
}
