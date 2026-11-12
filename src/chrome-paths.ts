/**
 * Cross-platform Chrome/Chromium/Edge discovery.
 *
 * The same executable list is needed by all three Chromium consumers in this
 * repository (the GitHub channel's CDP browser harness, the Lazy News
 * evidence collector, the Lazy News renderer). They used to each carry a
 * Windows-only candidate array that disagreed with the others.
 *
 * Resolution order, identical on every OS:
 *   1. the environment override (`CHROME_BIN`, or `LAZY_NEWS_CHROME` /
 *      `NEWS_CHROME_PATH` where set — see each call site);
 *   2. the well-known install locations for the host OS;
 *   3. a `which`/`where` lookup on PATH (covers package-manager installs).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function existing(paths: string[]): string[] {
  return paths.filter(p => p && fs.existsSync(p));
}

function platformCandidates(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    return existing([
      path.join(localAppData, "Chromium", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  if (platform === "darwin") {
    const home = process.env.HOME ?? "";
    return existing([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      path.join(home, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
      "/usr/local/bin/google-chrome",
      "/usr/local/bin/chromium",
      "/opt/homebrew/bin/google-chrome",
      "/opt/homebrew/bin/chromium",
    ]);
  }
  return existing([
    // Debian/Ubuntu
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/games/chromium-browser",
    "/snap/bin/chromium",
    // Fedora/RHEL
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    // Arch
    "/usr/bin/google-chrome-stable",
    // Microsoft Edge (Linux)
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ]);
}

function onPath(names: string[]): string[] {
  const probe = process.platform === "win32" ? "where" : "which";
  const found: string[] = [];
  for (const name of names) {
    try {
      const result = spawnSync(probe, [name], { encoding: "utf8" });
      if (result.status !== 0) continue;
      for (const line of String(result.stdout).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && fs.existsSync(trimmed)) found.push(trimmed);
      }
    } catch {
      // try the next name
    }
  }
  return found;
}

function pathNames(): string[] {
  if (process.platform === "win32") {
    return ["chrome.exe", "msedge.exe", "chromium.exe"];
  }
  if (process.platform === "darwin") {
    return ["google-chrome", "chromium"];
  }
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "chrome",
  ];
}

/** Resolve the first usable Chrome/Chromium/Edge executable, or `null`. */
export function findChromeExecutable(envOverride?: string): string | null {
  if (envOverride) {
    if (fs.existsSync(envOverride)) return envOverride;
    // If the override looks like a single name (e.g. "chrome"), honour PATH.
    const viaPath = onPath([envOverride]);
    if (viaPath.length > 0) return viaPath[0];
  }
  const wellKnown = platformCandidates(process.platform);
  if (wellKnown.length > 0) return wellKnown[0];
  const viaPath = onPath(pathNames());
  return viaPath[0] ?? null;
}
