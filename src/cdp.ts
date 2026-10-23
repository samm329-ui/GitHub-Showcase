import CDP from "chrome-remote-interface";
import { CHROME_DEBUG_URL } from "./config.js";

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

export async function openTarget(): Promise<{
  client: CdpClient;
  targetId: string;
}> {
  const { host, port } = endpoint();
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
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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
