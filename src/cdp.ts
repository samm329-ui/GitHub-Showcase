import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import CDP from "chrome-remote-interface";
import { CHROME_DEBUG_URL } from "./config.js";
import { findChromeExecutable } from "./chrome-paths.js";

/**
 * Thin CDP helpers shared by the mobile capture and the composition renderer.
 * Every target is a top-level tab: nothing relies on iframes or on GitHub
 * allowing itself to be framed.
 */

export type CdpClient = {
  Page: any;
  Runtime: any;
  Emulation: any;
  close(): Promise<void>;
};

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function endpoint(): { host: string; port: number } {
  const url = new URL(CHROME_DEBUG_URL);
  return { host: url.hostname, port: Number(url.port || 9222) };
}

export async function isCdpAvailable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(600),
    });
    return res.ok;
  } catch {
    return false;
  }
}



export async function ensureBrowser(): Promise<void> {
  const { host, port } = endpoint();
  if (await isCdpAvailable(host, port)) return;

  const exe = findChromeExecutable(process.env.CHROME_BIN);
  if (!exe) {
    throw new Error(
      `Chromium browser with remote debugging is not reachable at http://${host}:${port}, ` +
      `and no installed Chrome/Chromium/Edge executable was found.`
    );
  }

  console.warn(
    `[showcase] WARNING: no debuggable Chrome on http://${host}:${port} — ` +
      `launching headless Chromium instead (slower software rendering). ` +
      `Use run.bat (Windows) or run.sh (Linux/macOS), or pass --remote-debugging-port=${port} to a visible Chrome for speed and to see the window.`
  );
  const userDataDir = path.join(os.tmpdir(), "github-showcase-chrome");
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }
  );
  child.on("error", () => {});
  child.unref();

  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await isCdpAvailable(host, port)) return;
    await sleep(200);
  }

  throw new Error(`Started ${exe} but remote debugging port ${port} did not respond within 8 seconds.`);
}

export async function openTarget(): Promise<{
  client: CdpClient;
  targetId: string;
}> {
  const { host, port } = endpoint();
  await ensureBrowser();
  const target = await CDP.New({ host, port });
  const client = (await CDP({ target: target.id, host, port })) as CdpClient;
  return { client, targetId: target.id };
}

export async function closeTarget(targetId: string): Promise<void> {
  const { host, port } = endpoint();
  try {
    await CDP.Close({ id: targetId, host, port });
  } catch {
    /* the target may already be gone */
  }
}

export async function evaluate(client: CdpClient, expression: string): Promise<any> {
  // Race the CDP round trip against a hard timeout. chrome-remote-interface
  // has no default request timeout, so a crashed/disconnected renderer would
  // otherwise hang the pipeline forever with zero output.
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CDP Runtime.evaluate timed out after 30s — the browser likely crashed or the profile is locked.")), 30_000);
      }),
    ]);
    if (result?.exceptionDetails) {
      throw new Error(
        `Browser evaluation failed: ${
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "unknown error"
        }`
      );
    }
    return result?.result?.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function setViewport(
  client: CdpClient,
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
  }
): Promise<void> {
  await client.Emulation.setDeviceMetricsOverride(viewport);
}

/** Poll a boolean expression until it is true or the timeout expires. */
export async function waitFor(
  client: CdpClient,
  expression: string,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(client, expression)) return true;
    } catch {
      /* navigation may be replacing the execution context */
    }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Navigate and wait for `load`, then for `document.readyState === "complete"`.
 * Analytics and long-poll requests are deliberately not awaited.
 */
export async function navigate(
  client: CdpClient,
  url: string,
  timeoutMs: number
): Promise<boolean> {
  const loaded = client.Page.loadEventFired().then(
    () => true,
    () => false
  );
  await client.Page.navigate({ url });
  const result = await Promise.race([
    loaded,
    sleep(timeoutMs).then(() => false),
  ]);
  await waitFor(
    client,
    "document.readyState === 'complete' || document.readyState === 'interactive'",
    Math.min(10_000, timeoutMs)
  );
  return Boolean(result);
}

export async function frameId(client: CdpClient): Promise<string> {
  const tree = await client.Page.getFrameTree();
  return tree.frameTree.frame.id;
}
