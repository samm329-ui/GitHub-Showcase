import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader (no dependency).
 *
 * Reads `<cwd>/.env` once and sets any missing `process.env` entries from it.
 * Existing environment variables always win — a shell-exported value is never
 * overwritten by the file. Lines are `KEY=value`; blank lines and `#` comment
 * lines are ignored; surrounding quotes on values are stripped.
 *
 * This module must be imported BEFORE `src/config.ts` (and anything else that
 * reads `process.env` at module scope) so the file lands in time. In
 * `src/index.ts` it is the first import.
 */

let loaded = false;

export function loadEnvFile(
  cwd: string = process.cwd(),
  options: { force?: boolean } = {}
): void {
  if (loaded && !options.force) return;
  loaded = true;
  const file = path.join(cwd, ".env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // No .env file — perfectly fine, everything may come from the shell.
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    // Strip one pair of surrounding quotes, if any.
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();
