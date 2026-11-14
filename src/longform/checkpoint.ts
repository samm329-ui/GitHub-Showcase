/**
 * Crash-safe checkpoints for Long-form production.
 *
 * Each expensive stage stores a fingerprint of its inputs next to its
 * outputs. On resume, a stage is recomputed only when its fingerprint no
 * longer matches — never because the process restarted.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class CheckpointStore {
  constructor(private readonly dir: string) {}

  private fileFor(stage: string): string {
    return path.join(this.dir, "checkpoints", `${stage}.json`);
  }

  async get<T = unknown>(stage: string): Promise<{ fingerprint: string; value: T } | null> {
    try {
      const raw = await fs.readFile(this.fileFor(stage), "utf8");
      const parsed = JSON.parse(raw) as { fingerprint: string; value: T };
      return parsed && typeof parsed.fingerprint === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  async set(stage: string, fingerprint: string, value: unknown): Promise<void> {
    const file = this.fileFor(stage);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ fingerprint, value }, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  async has(stage: string): Promise<boolean> {
    return fsSync.existsSync(this.fileFor(stage));
  }

  async clear(stage?: string): Promise<void> {
    if (stage) {
      await fs.rm(this.fileFor(stage), { force: true });
      return;
    }
    await fs.rm(path.join(this.dir, "checkpoints"), { recursive: true, force: true });
  }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export async function fingerprintFiles(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    try {
      const buf = await fs.readFile(file);
      hash.update(file);
      hash.update(buf);
    } catch {
      hash.update(`${file}:missing`);
    }
  }
  return hash.digest("hex").slice(0, 24);
}
