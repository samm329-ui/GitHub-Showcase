/**
 * Cross-platform Python resolution.
 *
 * The pipeline spawns Python for two jobs: Kokoro TTS synthesis and Lazy News
 * alignment. Users install Python through wildly different paths per OS
 * (system python, `python3`, Homebrew, the `py` launcher, a repo-local
 * virtual environment, or the `PYTHON` environment variable). Guessing
 * wrong means a silent `python: command not found` halfway through a run.
 *
 * The resolution order is the same on every OS:
 *   1. `PYTHON` environment variable (explicit override always wins);
 *   2. the repository-local virtual environment created by the installer
 *      (`.venv`, either POSIX or Windows layout);
 *   3. `python3` (Debian/Ubuntu/macOS convention);
 *   4. `python` (Windows default / other distros).
 *
 * The first interpreter that imports the required modules wins. Nothing here
 * installs anything — that is what the install/ scripts are for — but
 * the error tells you exactly that.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";

export type PythonSpec = {
  command: string;
  baseArgs: string[];
  /** Where this candidate came from, for diagnostics. */
  origin: "PYTHON env" | "repo .venv" | "PATH";
};

function candidates(): PythonSpec[] {
  const root = process.cwd();
  const list: PythonSpec[] = [];
  if (process.env.PYTHON) {
    list.push({ command: process.env.PYTHON, baseArgs: [], origin: "PYTHON env" });
  }
  list.push({
    command: path.join(root, ".venv", "bin", "python"),
    baseArgs: [],
    origin: "repo .venv",
  });
  list.push({
    command: path.join(root, ".venv", "Scripts", "python.exe"),
    baseArgs: [],
    origin: "repo .venv",
  });
  list.push({ command: "python", baseArgs: [], origin: "PATH" });
  list.push({ command: "python3", baseArgs: [], origin: "PATH" });
  return list;
}

const cache = new Map<string, PythonSpec>();

function probe(spec: PythonSpec, requiredModules: string[]): boolean {
  const code = requiredModules.length
    ? `import ${requiredModules.join(", ")}`
    : "import sys";
  const result = spawnSync(spec.command, [...spec.baseArgs, "-c", code], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 20_000,
  });
  return result.status === 0;
}

/** Resolve a working Python interpreter, or throw listing every candidate
 *  that was tried and why. */
export function resolvePython(requiredModules: string[] = []): PythonSpec {
  const key = requiredModules.join(",");
  const cached = cache.get(key);
  if (cached) return cached;

  const failures: string[] = [];
  for (const spec of candidates()) {
    try {
      if (probe(spec, requiredModules)) {
        cache.set(key, spec);
        return spec;
      }
      failures.push(`${spec.command} (${spec.origin}): required modules missing`);
    } catch (error) {
      failures.push(`${spec.command} (${spec.origin}): ${(error as Error).message}`);
    }
  }
  throw new Error(
    `No working Python interpreter found for: ${requiredModules.join(", ") || "(any)"}.\n` +
      `Install it with the repo installer: install/python.sh (Linux/macOS) or install/python.bat (Windows).\n` +
      `Or set the PYTHON environment variable to an interpreter that has them.\n` +
      `Tried:\n  - ${failures.join("\n  - ")}`
  );
}
