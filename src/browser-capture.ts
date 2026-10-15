import CDP from "chrome-remote-interface";
import fs from "node:fs/promises";
import path from "node:path";
import { CHROME_DEBUG_URL, CAPTURE_FPS, VIEWPORT } from "./config.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function captureRepository(
  url: string, outputDir: string, durationSeconds: number,
  metadata: { stars: string; license: string; language: string }
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const endpoint = new URL(CHROME_DEBUG_URL);
  const port = Number(endpoint.port || 9222);
  const target = await CDP.New({ host: endpoint.hostname, port });
  const client = await CDP({ target: target.id, host: endpoint.hostname, port });
  const { Page, Runtime, Emulation } = client;

  try {
    await Page.enable();
    await Runtime.enable();
    await Emulation.setDeviceMetricsOverride({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: true
    });
    try { await Emulation.setEmulatedMedia({ media: "screen", colorScheme: "dark" }); } catch { /* older Chromium builds may not support this */ }
    try { await Emulation.setUserAgentOverride({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36", platform: "Android" }); } catch { /* optional */ }
    await Page.navigate({ url });
    await Page.loadEventFired();
    await sleep(2200);

    await Runtime.evaluate({
      expression: `const __style = document.createElement("style");
        __style.textContent = "*{transition:none!important;animation:none!important;}";
        document.head.appendChild(__style);
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(0, 0);
        const banner = document.createElement('div');
        banner.id = 'showcase-banner';
        banner.textContent = ${JSON.stringify(url.replace("https://github.com/", ""))} + '  ★ ' + ${JSON.stringify(metadata.stars)} + '  ·  ' + ${JSON.stringify(metadata.license)};
        Object.assign(banner.style, {
          position:'fixed', top:'14px', left:'12px', right:'12px', zIndex:'2147483647',
          padding:'12px 14px', borderRadius:'12px', background:'rgba(18,18,24,.94)',
          color:'#fff', font:'bold 18px Arial,sans-serif', boxShadow:'0 4px 22px rgba(0,0,0,.35)',
          border:'1px solid rgba(255,255,255,.18)', pointerEvents:'none', overflow:'hidden',
          whiteSpace:'nowrap', textOverflow:'ellipsis'
        });
        document.body.appendChild(banner);
        const watermark = document.createElement('div');
        watermark.textContent = ${JSON.stringify(process.env.SHOWCASE_WATERMARK ?? "GITHUB FINDS")};
        Object.assign(watermark.style, {
          position:'fixed', bottom:'12px', right:'12px', zIndex:'2147483647',
          padding:'6px 9px', borderRadius:'8px', background:'rgba(255,255,255,.72)',
          color:'#1f2937', font:'bold 12px Arial,sans-serif', pointerEvents:'none'
        });
        document.body.appendChild(watermark);`
    });

    const totalFrames = Math.max(1, Math.ceil(durationSeconds * CAPTURE_FPS));
    const progressStep = Math.max(1, Math.ceil(totalFrames / 10));
    for (let i = 0; i < totalFrames; i++) {
      const shot = await Page.captureScreenshot({ format: "jpeg", quality: 84, fromSurface: true });
      await fs.writeFile(
        path.join(outputDir, `frame-${String(i).padStart(5, "0")}.jpg`),
        Buffer.from(shot.data, "base64")
      );
      await Runtime.evaluate({
        expression: `window.scrollBy(0, Math.max(1, (document.documentElement.scrollHeight - window.innerHeight) / ${Math.max(1, totalFrames - 1)}));`
      });
      await sleep(1000 / CAPTURE_FPS);
      if (i % progressStep === 0 || i === totalFrames - 1) {
        const percent = Math.round(((i + 1) / totalFrames) * 100);
        console.log(`Capture progress: ${percent}% (${i + 1}/${totalFrames})`);
      }
    }
  } finally {
    await client.close();
    try { await CDP.Close({ id: target.id, host: endpoint.hostname, port }); } catch { /* target may already be closed */ }
  }
}
