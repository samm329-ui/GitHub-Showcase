/**
 * Long-form preflight — validates the runtime, assets and data readiness
 * before any production begins. Failures are explicit; nothing is silently
 * degraded. In dry-run mode no episode is reserved.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LONGFORM_DB_PATH, OUTPUT_DIR_LONGFORM, TEMP_DIR_LONGFORM, MASCOT_ASSETS, MUSIC_BED, SFX } from "./config.js";
import { isCdpAvailable } from "../cdp.js";
import { findChromeExecutable } from "../chrome-paths.js";
import { kokoroPaths } from "../voice.js";
import { resolvePython } from "../python.js";
import { reconcileDataset } from "./dataset-loader.js";
import { verifyUsedAssets, productionAssetFiles } from "./music-manager.js";
import { ALLOW_UNVERIFIED_ASSETS } from "./config.js";

const execFileAsync = promisify(execFile);

export type PreflightReport = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  eligibleRepositories: number;
  usedRepositories: number;
  shortfall: number;
};

const has = (p: string) => fs.existsSync(p);

async function binaryWorks(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args);
    return true;
  } catch {
    return false;
  }
}

export async function runPreflight(
  usedNodeIds: Set<string>,
  resumedNodeIds: Set<string> = new Set()
): Promise<PreflightReport> {
  const checks: PreflightReport["checks"] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // FFmpeg toolchain
  push("ffmpeg", await binaryWorks("ffmpeg", ["-version"]), "ffmpeg -version");
  push("ffprobe", await binaryWorks("ffprobe", ["-version"]), "ffprobe -version");

  // Kokoro + Python
  const kokoro = kokoroPaths();
  push("kokoro-model", has(kokoro.model), kokoro.model);
  push("kokoro-voices", has(kokoro.voices), kokoro.voices);
  let pythonOk = false;
  let pythonDetail = "python not found";
  try {
    pythonDetail = resolvePython(["kokoro_onnx", "soundfile", "numpy"]).command;
    pythonOk = true;
  } catch (error) {
    pythonDetail = (error as Error).message;
  }
  push("python-kokoro", pythonOk, pythonDetail);

  // Groq credentials (existence only — never logged)
  const hasGroqKey = Boolean(process.env.GROQ_API_KEY) || Boolean((process.env.GROQ_API_KEYS ?? "").trim());
  push("groq-key", hasGroqKey, hasGroqKey ? "present" : "GROQ_API_KEY(S) not set");

  // Browser for capture
  let chromeOk = false;
  let chromeDetail = "";
  try {
    const reachable = await isCdpAvailable("127.0.0.1", 9222);
    if (reachable) {
      chromeOk = true;
      chromeDetail = "CDP reachable on 127.0.0.1:9222";
    } else {
      const exe = findChromeExecutable(process.env.CHROME_BIN);
      chromeOk = Boolean(exe);
      chromeDetail = exe ? `will launch headless Chromium (${exe})` : "no debuggable Chrome/Chromium/Edge found";
    }
  } catch (error) {
    chromeDetail = (error as Error).message;
  }
  push("chromium", chromeOk, chromeDetail);

  // Mascot + music + sfx assets
  for (const [role, file] of Object.entries(MASCOT_ASSETS)) {
    push(`mascot-${role}`, has(file), file);
  }
  push("music-bed", has(MUSIC_BED), MUSIC_BED);
  for (const [role, file] of Object.entries(SFX)) {
    push(`sfx-${role}`, has(file), file);
  }

  // Licence gate (development override prints a loud warning elsewhere)
  const license = verifyUsedAssets(productionAssetFiles());
  if (license.ok && license.devMode) {
    push("asset-licences", true, `DEV MODE — ${license.total} assets used without verified licences (LONGFORM_ALLOW_UNVERIFIED_ASSETS=1)`);
  } else if (license.ok) {
    push("asset-licences", true, `${license.total}/${license.total} assets verified`);
  } else {
    push("asset-licences", false, `unverified: ${license.unverified.join(", ")}`);
  }

  // Dataset readiness — for a resumed episode, its own five reserved
  // repositories count as available; for a new episode they don't.
  const reconciliation = await reconcileDataset();
  const usable = reconciliation.candidates.filter(
    c => c.issues.length === 0 && c.nodeId && (!usedNodeIds.has(c.nodeId) || resumedNodeIds.has(c.nodeId))
  );
  const shortfall = Math.max(0, 5 - usable.length);
  push(
    "dataset",
    usable.length >= 5,
    `${usable.length} usable ${resumedNodeIds.size > 0 ? "records (including the 5 reserved in this episode)" : "unused completed records"} (need 5; ${usedNodeIds.size} already used by Long-form)`
  );

  // Storage writability
  try {
    fs.mkdirSync(TEMP_DIR_LONGFORM, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR_LONGFORM, { recursive: true });
    fs.mkdirSync(path.dirname(LONGFORM_DB_PATH), { recursive: true });
    push("storage", true, `${TEMP_DIR_LONGFORM} and ${OUTPUT_DIR_LONGFORM} writable`);
  } catch (error) {
    push("storage", false, (error as Error).message);
  }

  const ok = checks.every(c => c.ok);
  return {
    ok,
    checks,
    eligibleRepositories: usable.length,
    usedRepositories: usedNodeIds.size,
    shortfall,
  };
}
