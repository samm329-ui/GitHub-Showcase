import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Tiny read-only asset server for the render page.
 *
 * A very tall screenshot does not belong in an HTML string as base64: it would
 * duplicate megabytes per frame document and slow CDP down. This server binds
 * only to the loopback interface and only exposes the exact files registered by
 * the current run.
 */

export type AssetServer = {
  origin: string;
  routes: string[];
  close(): Promise<void>;
};

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export async function startAssetServer(
  files: Record<string, string>
): Promise<AssetServer> {
  const registry = new Map<string, string>();
  for (const [route, file] of Object.entries(files)) {
    if (!route.startsWith("/")) throw new Error(`Asset route must start with "/": ${route}`);
    if (route.includes("..") || route.includes("\\")) {
      throw new Error(`Asset route must be a simple path: ${route}`);
    }
    const resolved = path.resolve(file);
    await fs.access(resolved);
    registry.set(route, resolved);
  }

  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";
    const route = url.split("?")[0];
    const file = registry.get(route);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    fs.readFile(file)
      .then(buffer => {
        response.writeHead(200, {
          "content-type": contentType(file),
          "content-length": buffer.length,
          "cache-control": "no-store",
        });
        response.end(buffer);
      })
      .catch(() => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Read error");
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Asset server did not bind to a TCP port.");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    routes: [...registry.keys()],
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
