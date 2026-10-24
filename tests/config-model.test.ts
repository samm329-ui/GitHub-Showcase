import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATHS,
  parsePreviewConfig,
  writePreviewConfig,
  type ConfigSources,
} from "../tools/config-writer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(HERE, "..", "tools", "config-model.js");

async function readSources(): Promise<ConfigSources> {
  const [configTs, captionOverlayTs, cardTs] = await Promise.all([
    fs.readFile(CONFIG_PATHS.configTs, "utf8"),
    fs.readFile(CONFIG_PATHS.captionOverlayTs, "utf8"),
    fs.readFile(CONFIG_PATHS.cardTs, "utf8"),
  ]);
  return { configTs, captionOverlayTs, cardTs };
}

describe("shared config model", () => {
  test("stays a classic script so file:// can load it from a <script> tag", async () => {
    const source = await fs.readFile(MODEL_PATH, "utf8");
    // Chrome/Edge reject ES modules on a file:// page, so the shared model must
    // never gain a top-level `import` / `export` statement.
    assert.equal(
      /^\s*(import|export)\b/m.test(source),
      false,
      "tools/config-model.js must not use ESM syntax"
    );
    // Nor a dynamic import(), which is likewise blocked on file://.
    assert.equal(/\bimport\s*\(/.test(source), false);
  });

  test("publishes its API on a plain global with no module system present", async () => {
    const source = await fs.readFile(MODEL_PATH, "utf8");
    // Simulate a browser classic script: a bare global object, no `module`,
    // no `require`, no `exports`.
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox, { filename: "config-model.js" });

    const model = sandbox.ShowcaseConfigModel as {
      CONFIG_PATHS: ConfigSources;
      VIEWPORT_WIDTH_PX: number;
      writePreviewConfig(s: ConfigSources, c: ReturnType<typeof parsePreviewConfig>): ConfigSources;
      parsePreviewConfig(s: ConfigSources): ReturnType<typeof parsePreviewConfig>;
    } | undefined;

    assert.ok(model, "ShowcaseConfigModel should be published on the global");
    assert.equal(model.VIEWPORT_WIDTH_PX, 1080);
    assert.equal(model.CONFIG_PATHS.configTs, "src/config.ts");
    assert.equal(typeof model.writePreviewConfig, "function");
    assert.equal(typeof model.parsePreviewConfig, "function");
  });

  test("browser and Node paths rewrite the codebase byte-for-byte alike", async () => {
    const source = await fs.readFile(MODEL_PATH, "utf8");
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox, { filename: "config-model.js" });
    const browser = sandbox.ShowcaseConfigModel as {
      writePreviewConfig(s: ConfigSources, c: ReturnType<typeof parsePreviewConfig>): ConfigSources;
    };

    const sources = await readSources();
    const before = parsePreviewConfig(sources);
    const after = { ...before, captionFontSize: 58, highlightBackground: "#123abc" };

    // Serialize before comparing: the sandbox returns objects from another
    // realm, whose prototypes differ, so strict deep-equality would reject
    // otherwise-identical values.
    assert.equal(
      JSON.stringify(browser.writePreviewConfig(sources, after)),
      JSON.stringify(writePreviewConfig(sources, after))
    );
  });

  test("the preview page loads the engine and its inline script parses", async () => {
    const html = await fs.readFile(
      path.join(HERE, "..", "tools", "preview-live.html"),
      "utf8"
    );
    // The page must pull in the classic shared engine before its own script.
    assert.match(html, /<script src="config-model\.js"><\/script>/);

    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(inline.length >= 1, "expected an inline <script> block");
    for (const body of inline) {
      // Parse only — the page touches `document` at runtime, never at parse time.
      assert.doesNotThrow(
        () => new vm.Script(body, { filename: "preview-live.html" }),
        "inline preview script should parse"
      );
    }
  });

  test("the page falls back to the folder when the helper is unreachable", async () => {
    const html = await fs.readFile(
      path.join(HERE, "..", "tools", "preview-live.html"),
      "utf8"
    );
    // Save order: server first, folder second, download last.
    const start = html.indexOf("window.__saveToCodebase = async function");
    assert.ok(start > -1, "could not find the save handler");
    const end = html.indexOf("window.__reloadFromCodebase = async function", start);
    const saveFn = html.slice(start, end > start ? end : undefined);
    const serverAt = saveFn.indexOf("/api/save");
    const folderAt = saveFn.indexOf("await saveViaFolder(config)");
    const downloadAt = saveFn.indexOf("downloadCfg();");
    assert.ok(serverAt > -1 && folderAt > -1 && downloadAt > -1);
    assert.ok(serverAt < folderAt && folderAt < downloadAt);
  });
});
