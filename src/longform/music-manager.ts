/**
 * Licence gate for Long-form production assets.
 *
 * Every asset the episode uses must be marked `verified` in
 * assets/longform/asset-licenses.json, or the whole production refuses to
 * start — unless LONGFORM_ALLOW_UNVERIFIED_ASSETS=1 is set explicitly
 * (development mode). In development mode the verifier logs a loud warning
 * and the episode's qa report records that the publishing gate was bypassed.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { ALLOW_UNVERIFIED_ASSETS } from "./config.js";

export type AssetLicenseEntry = {
  file: string;
  sha256: string;
  status: "verified" | "unverified" | string;
  role?: string;
};

export type LicenseVerification =
  | { ok: true; verified: number; total: number; devMode: boolean }
  | { ok: false; unverified: string[]; devMode: boolean };

export function verifyUsedAssets(usedAssetFiles: string[]): LicenseVerification {
  const manifestPath = path.join(ROOT, "assets", "longform", "asset-licenses.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    assets: AssetLicenseEntry[];
  };
  const byFile = new Map(manifest.assets.map(a => [a.file.replace(/\\/g, "/"), a]));
  const unverified: string[] = [];
  let verified = 0;
  for (const asset of usedAssetFiles) {
    const normalized = asset.replace(/\\/g, "/").replace(/^.*assets\/longform\//, "");
    const entry = byFile.get(normalized);
    if (!entry || entry.status !== "verified") {
      unverified.push(normalized);
    } else {
      verified += 1;
    }
  }
  if (unverified.length > 0) {
    if (ALLOW_UNVERIFIED_ASSETS) {
      console.warn(
        "\n  *** LONGFORM_ALLOW_UNVERIFIED_ASSETS=1 — DEVELOPMENT MODE ***\n" +
          unverified.map(u => `  - ${u}`).join("\n") +
          "\n  These assets are NOT license-verified. The episode MUST NOT be published until they are verified.\n"
      );
      return { ok: true, verified, total: usedAssetFiles.length, devMode: true };
    }
    return { ok: false, unverified, devMode: false };
  }
  return { ok: true, verified, total: usedAssetFiles.length, devMode: false };
}

/** Every asset file the Long-form pipeline consumes. */
export function productionAssetFiles(): string[] {
  const root = path.join(ROOT, "assets", "longform");
  const collect = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      return /\.(png|wav|mp3|m4a|flac|ogg)$/i.test(entry.name) ? [path.relative(root, full).replace(/\\/g, "/")] : [];
    });
  return collect(root);
}
