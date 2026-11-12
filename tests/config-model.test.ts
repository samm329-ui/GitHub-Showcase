import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PREVIEW_CONFIG,
  parseVisualOverrides,
  serializeVisualOverrides,
  type PreviewConfig,
} from "../tools/preview/config-writer.js";
import { DEFAULT_VISUAL_OVERRIDES } from "../src/visual-overrides.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(HERE, "..", "tools", "preview", "config-model.js");
const PAGE_PATH = path.join(HERE, "..", "tools", "preview", "preview-live.html");

type BrowserModel = {
  VIEWPORT_WIDTH_PX: number;
  VIEWPORT_HEIGHT_PX: number;
  OVERRIDES_FILENAME: string;
  DEFAULT_PREVIEW_CONFIG: PreviewConfig;
  normalizePreviewConfig(
    input: Record<string, unknown>,
    base: PreviewConfig
  ): PreviewConfig;
  serializeVisualOverrides(config: PreviewConfig): string;
  parseVisualOverrides(text: string): PreviewConfig;
};

async function modelSourceSync(): Promise<string> {
  return fs.readFile(MODEL_PATH, "utf8");
}

function loadBrowserModel(): BrowserModel {
  const source = fsSync.readFileSync(MODEL_PATH, "utf8");
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "config-model.js" });
  return sandbox.ShowcaseConfigModel as unknown as BrowserModel;
}

describe("shared config model", () => {
  test("stays a classic script so file:// can load it from a <script> tag", async () => {
    const source = await modelSourceSync();
    // Chrome/Edge reject ES modules on a file:// page, so the shared model must
    // never gain a top-level `import` / `export` statement.
    assert.equal(
      /^\s*(import|export)\b/m.test(source),
      false,
      "tools/preview/config-model.js must not use ESM syntax"
    );
    // Nor a dynamic import(), which is likewise blocked on file://.
    assert.equal(/\bimport\s*\(/.test(source), false);
  });

  test("publishes its API on a plain global with no module system present", () => {
    const model = loadBrowserModel();
    assert.ok(model, "ShowcaseConfigModel should be published on the global");
    assert.equal(model.VIEWPORT_WIDTH_PX, 1080);
    assert.equal(model.VIEWPORT_HEIGHT_PX, 1920);
    assert.equal(model.OVERRIDES_FILENAME, "visual-overrides.json");
    assert.equal(typeof model.serializeVisualOverrides, "function");
    assert.equal(typeof model.parseVisualOverrides, "function");
    assert.equal(typeof model.normalizePreviewConfig, "function");
  });

  test("the browser default set is byte-identical to the committed composition", () => {
    const model = loadBrowserModel();
    // The browser cannot import src/visual-overrides.ts, so it carries its own
    // copy of the defaults. They must never drift: this deep-compares the two.
    assert.equal(
      JSON.stringify(model.DEFAULT_PREVIEW_CONFIG),
      JSON.stringify(DEFAULT_VISUAL_OVERRIDES)
    );
  });

  test("browser and Node normalize untrusted input the same way", () => {
    const model = loadBrowserModel();
    const input = {
      captionFontSize: "70",
      cardRadius: 44,
      highlightBackground: "#00ff00",
      mascotAsset: "../..\\evil.png",
      cardWidth: 5000,
      nonsense: true,
      captionTop: "not-a-number",
    };
    const browser = model.normalizePreviewConfig(input, model.DEFAULT_PREVIEW_CONFIG);
    // Serialize through the browser copy, then parse through Node: the value
    // must survive the round trip unchanged and sanitized.
    const fileText = model.serializeVisualOverrides(browser);
    const node = parseVisualOverrides(fileText);
    assert.equal(node.captionFontSize, 70);
    assert.equal(node.cardRadius, 44);
    assert.equal(node.highlightBackground, "#00FF00");
    assert.equal(node.mascotAsset, "evil.png");
    assert.equal(node.cardWidth, 1000, "card clamps the same way in both realms");
    assert.equal(node.captionTop, DEFAULT_VISUAL_OVERRIDES.captionTop);
    assert.ok(!("nonsense" in node));
  });

  test("a mascot filename can never smuggle a path out of the folder", () => {
    const model = loadBrowserModel();
    const normalized = model.normalizePreviewConfig(
      { mascotAsset: "../..\\evil.png" },
      model.DEFAULT_PREVIEW_CONFIG
    );
    assert.equal(normalized.mascotAsset, "evil.png");
  });

  test("parseVisualOverrides rejects invalid JSON instead of guessing", () => {
    assert.throws(() => parseVisualOverrides("{not json"));
  });

  test("serialize → parse round-trips the complete composition", () => {
    const tuned = { ...DEFAULT_PREVIEW_CONFIG, captionFontSize: 58, highlightBackground: "#123ABC" };
    const text = serializeVisualOverrides(tuned);
    assert.deepEqual(parseVisualOverrides(text), tuned);
  });

  test("the preview page loads the engine and its inline script parses", async () => {
    const html = await fs.readFile(PAGE_PATH, "utf8");
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
    const html = await fs.readFile(PAGE_PATH, "utf8");
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
