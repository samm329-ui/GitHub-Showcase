import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Double-click launcher for the live preview.
 *
 * Reached only through `Save My Edits.vbs` / `.cmd` in the repo root, which run
 * this file with the console window hidden. It does the one thing a plain
 * shortcut cannot: work out whether the preview server is already up, and if
 * not start it quietly before opening the browser.
 *
 *   - server already running  → just open the preview (idempotent re-clicks)
 *   - server not running      → start it detached + windowless, wait until it
 *                               answers, then open the preview
 *
 * Nothing is printed and nothing is left open: this process exits as soon as
 * the browser has been handed the URL.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SERVER = path.join(HERE, "preview-server.ts");
const FIRST_PORT = Number(process.env.PREVIEW_PORT ?? 5178);
const MAX_PORT_TRIES = 10;
const PORTS = Array.from({ length: MAX_PORT_TRIES + 1 }, (_, i) => FIRST_PORT + i);

const PAGE_PATH = "/tools/preview-live.html";

function pageUrl(port: number): string {
  return `http://127.0.0.1:${port}${PAGE_PATH}`;
}

/** True when a preview server answers `GET /api/config` on this port. */
async function isPreviewServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; config?: unknown };
    return data.ok === true && !!data.config;
  } catch {
    return false;
  }
}

/** The port of a server that is already listening, or null. */
async function findRunningPort(): Promise<number | null> {
  for (const port of PORTS) {
    if (await isPreviewServer(port)) return port;
  }
  return null;
}

function openBrowser(url: string): void {
  // `LAUNCH_NO_OPEN=1` is for automated checks only; the real launcher omits it.
  if (process.env.LAUNCH_NO_OPEN === "1") return;
  const opener =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(opener[0] as string, opener[1] as string[], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}

/** Start the preview server detached and windowless. */
function startServer(): void {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", SERVER],
    {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        // The launcher opens the browser itself, so the server must not.
        PREVIEW_NO_OPEN: "1",
      },
    }
  );
  child.on("error", () => {});
  child.unref();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait for a freshly started server to answer; returns its port or null. */
async function waitForServer(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const port of PORTS) {
      if (await isPreviewServer(port)) return port;
    }
    await sleep(250);
  }
  return null;
}

async function main(): Promise<void> {
  const running = await findRunningPort();
  if (running !== null) {
    openBrowser(pageUrl(running));
    return;
  }

  startServer();
  const port = await waitForServer(20_000);
  if (port !== null) {
    openBrowser(pageUrl(port));
    return;
  }

  // Fall back to the first port so the user still gets a page; if the server
  // needed longer than 20s it will be up by the time they click Save.
  openBrowser(pageUrl(FIRST_PORT));
}

await main();
