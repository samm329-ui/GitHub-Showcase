#!/usr/bin/env node
/**
 * Cross-platform Python runner for npm scripts.
 *
 * npm runs scripts through cmd.exe on Windows and sh elsewhere, and "python"
 * means different things on each OS. This shim resolves an interpreter the
 * same way the pipeline itself does (PYTHON env → repo .venv → python3 →
 * python) and execs the given script with inherited stdio — so `npm run
 * voice:audition` works identically on Windows, Linux and macOS.
 *
 * Usage: node tools/run-python.mjs <repo-relative-script.py> [args…]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , script, ...args] = process.argv;
if (!script) {
  console.error("usage: node tools/run-python.mjs <repo-relative-script.py> [args…]");
  process.exit(2);
}
const root = process.cwd();
const scriptPath = path.join(root, script);
if (!fs.existsSync(scriptPath)) {
  console.error(`no such script: ${scriptPath}`);
  process.exit(2);
}

const candidates = [
  process.env.PYTHON,
  path.join(root, ".venv", "bin", "python"),
  path.join(root, ".venv", "Scripts", "python.exe"),
  "python",
  "python3",
  "py",
].filter(Boolean);

for (const command of candidates) {
  // Run-test the candidate: the Windows Store alias stub `python3.exe` exists
  // on PATH but is not an interpreter (its --version output lacks this line).
  const probe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const banner = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  if (probe.error || probe.status !== 0 || !/Python 3\./.test(banner)) continue;
  const result = spawnSync(command, [scriptPath, ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(`failed to run ${scriptPath} with ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error(
  "No working Python interpreter found (tried PYTHON, .venv, python3, python).\n" +
    "Create the repo environment first:  install/python.sh (Linux/macOS) or install/python.bat (Windows)."
);
process.exit(1);
