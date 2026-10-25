import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyPreviewConfig,
  normalizePreviewConfig,
  readPreviewConfig,
  type PreviewConfig,
} from "./config-writer.js";

/**
 * Dev server for `tools/preview-live.html`.
 *
 * Why a server at all: browsers cannot write to disk from a `file://` page, so
 * "Save (one click)" has nowhere to go. This tiny zero-dependency server does
 * two things:
 *
 *   - serves the preview page (and the mascot assets) so relative paths work;
 *   - exposes `GET /api/config` and `POST /api/save`, which read and rewrite
 *     the composition tokens in `src/config.ts`, `src/caption-overlay.ts` and
 *     `src/card.ts` through `tools/config-writer.ts`.
 *
 * The page itself never parses or edits TypeScript; it only speaks JSON.
 */

const ROOT = process.cwd();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "preview-live.html");
const FIRST_PORT = Number(process.env.PREVIEW_PORT ?? 5178);
const MAX_PORT_TRIES = 10;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

/** Only these top-level folders may be served as files. */
const STATIC_ROOTS = ["tools", "assets"];

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

function resolveStatic(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const abs = path.resolve(ROOT, `.${decoded}`);
  const allowed = STATIC_ROOTS.some(root => {
    const prefix = path.join(ROOT, root) + path.sep;
    return abs === path.join(ROOT, root) || abs.startsWith(prefix);
  });
  return allowed ? abs : null;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleConfig(res: http.ServerResponse): Promise<void> {
  try {
    sendJson(res, 200, { ok: true, config: await readPreviewConfig(ROOT) });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: (error as Error).message });
  }
}

async function handleSave(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
    const base = await readPreviewConfig(ROOT);
    const config: PreviewConfig = normalizePreviewConfig(parsed, base);
    const result = await applyPreviewConfig(ROOT, config);
    console.log(
      `[preview] saved → ${result.files.length ? result.files.join(", ") : "no file changes"}` +
        (result.fields.length ? ` (${result.fields.join(", ")})` : "")
    );
    sendJson(res, 200, {
      ok: true,
      files: result.files,
      fields: result.fields,
      config,
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: (error as Error).message });
  }
}

async function handleStatic(
  urlPath: string,
  res: http.ServerResponse
): Promise<void> {
  const abs = resolveStatic(urlPath);
  if (!abs) {
    res.writeHead(403, corsHeaders());
    res.end("Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(abs);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      ...corsHeaders(),
    });
    res.end(body);
  } catch {
    res.writeHead(404, corsHeaders());
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const urlPath = url.split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method === "GET" && urlPath === "/api/config") {
    void handleConfig(res);
    return;
  }
  if (req.method === "POST" && urlPath === "/api/save") {
    void handleSave(req, res);
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/") {
    res.writeHead(302, { Location: "/tools/preview-live.html", ...corsHeaders() });
    res.end();
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    void handleStatic(urlPath, res);
    return;
  }
  res.writeHead(405, corsHeaders());
  res.end("Method not allowed");
});

function listen(port: number, attempt = 0): void {
  server.once("error", error => {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < MAX_PORT_TRIES) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error("[preview] failed to start:", (error as Error).message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/tools/preview-live.html`;
    console.log(`[preview] live preview: ${url}`);
    console.log(`[preview] one-click Save writes into src/config.ts, src/caption-overlay.ts, src/card.ts`);
    console.log(`[preview] Ctrl+C to stop`);
    // Best-effort auto-open; never fatal if the platform has no opener.
    if (process.env.PREVIEW_NO_OPEN !== "1") {
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
        });
        child.on("error", () => {});
        child.unref();
      } catch {
        /* ignore */
      }
    }
  });
}

listen(FIRST_PORT);

// Fail loudly if the preview page was moved.
await fs.access(PAGE).catch(() => {
  console.error(`[preview] cannot find ${PAGE}`);
});
