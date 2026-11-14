/**
 * Read-only dataset reconciliation for Long-form selection.
 *
 * Reads dataset/github/*.json (GitHub channel archive) and evaluates each
 * completed record for usability: identity, ledger, segments, README, and
 * provenance. Never rewrites the dataset; never throws on individual bad
 * records (they are reported with issues instead).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listDatasetRecords, getDatasetRecord } from "../script-dataset.js";
import type { FactLedger } from "../types.js";
import type { DatasetCandidate } from "./types.js";

const DATASET_DIR = process.env.SHOWCASE_DATASET_DIR
  ? path.resolve(process.env.SHOWCASE_DATASET_DIR)
  : path.join(process.cwd(), "dataset");

export type ReconciliationReport = {
  generatedAt: string;
  datasetDir: string;
  channel: "github";
  scanned: number;
  candidates: DatasetCandidate[];
  usable: number;
  shortfall: number;
  /** Node IDs missing from the DB side of the world are not an issue here — this archive is the source of truth for scripts. */
  notes: string[];
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Deterministic 0..100 base quality score. Documented in the TRD. */
export function scoreBase(input: {
  stars: number | null;
  pushedAt: string | null;
  readmeChars: number;
  factCount: number;
  segmentCount: number;
  spokenWords: number;
  licenseKnown: boolean;
  hasAlignment: boolean;
}): number {
  const stars = input.stars ?? 0;
  const factScore = Math.min(20, 4 + input.factCount); // 4 baseline + 1/fact, cap 20
  const readmeScore = Math.max(0, Math.min(30, (Math.log10(Math.max(1, input.readmeChars) / 400) * 12)));
  const richness = Math.max(0, Math.min(10, input.segmentCount * 1.1));
  const starScore = Math.max(0, Math.min(20, (Math.log10(stars + 1) - 1.3) * 8.5));
  const daysSincePush = input.pushedAt ? (Date.now() - Date.parse(input.pushedAt)) / 86_400_000 : 9999;
  const recencyScore = daysSincePush <= 90 ? 10 : daysSincePush <= 180 ? 7 : daysSincePush <= 365 ? 4 : 1;
  const licenseScore = input.licenseKnown ? 5 : 0;
  const measuredScore = input.hasAlignment ? 5 : 0;
  void input.spokenWords;
  return Math.round(
    Math.max(0, Math.min(100, factScore + readmeScore + richness + starScore + recencyScore + licenseScore + measuredScore))
  );
}

export async function loadCandidates(): Promise<DatasetCandidate[]> {
  const index = await listDatasetRecords("github");
  const candidates: DatasetCandidate[] = [];
  const seenNodeIds = new Set<string>();
  const alignedRecords = new Set<string>();

  for (const entry of index) {
    if (entry.phase !== "completed") continue;
    const record = await getDatasetRecord("github", entry.id);
    if (!record) {
      candidates.push({
        recordId: entry.id,
        nodeId: "",
        fullName: entry.title,
        htmlUrl: entry.subject,
        description: null,
        stars: null,
        forks: null,
        primaryLanguage: null,
        license: null,
        topics: [],
        pushedAt: null,
        readmeChars: 0,
        factCount: 0,
        segmentCount: 0,
        spokenWords: 0,
        estimatedSeconds: null,
        styleVariant: null,
        baseScore: 0,
        issues: ["record unreadable or corrupt (readExisting returned null)"],
      });
      continue;
    }
    const enriched = (record.selection as { enriched?: Record<string, unknown> } | undefined)?.enriched ?? {};
    const ledger = record.facts?.ledger as FactLedger | undefined;
    const nodeId =
      (typeof enriched.nodeId === "string" && enriched.nodeId) ||
      (ledger && typeof ledger.repositoryNodeId === "string" && ledger.repositoryNodeId) ||
      "";
    const fullName =
      (typeof enriched.full_name === "string" && enriched.full_name) || record.title;
    const segments = Array.isArray(record.script?.segments) ? (record.script.segments as Array<Record<string, unknown>>) : [];
    const spokenWords = segments.reduce(
      (sum, s) => sum + String(s?.spokenText ?? "").split(/\s+/).filter(Boolean).length,
      0
    );
    const readmeText = typeof enriched.readmeText === "string" ? enriched.readmeText : "";
    const issues: string[] = [];
    if (!nodeId) issues.push("missing stable node_id");
    if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) issues.push("fullName is not owner/repo");
    if (segments.length < 3) issues.push(`only ${segments.length} script segments`);
    if (spokenWords < 30) issues.push(`only ${spokenWords} spoken words`);
    if (!ledger || !Array.isArray(ledger.facts) || ledger.facts.length === 0) {
      issues.push("empty or missing fact ledger");
    } else if (nodeId && ledger.repositoryNodeId !== nodeId) {
      issues.push("fact ledger nodeId does not match selection nodeId");
    }
    if (readmeText.length < 200) issues.push(`readmeText too small (${readmeText.length} chars)`);
    if (nodeId && seenNodeIds.has(nodeId)) issues.push("duplicate nodeId in dataset");
    if (nodeId) seenNodeIds.add(nodeId);
    if (record.alignment && typeof record.alignment.durationMs === "number" && record.alignment.durationMs > 0) {
      alignedRecords.add(record.id);
    }

    const pushedAt = typeof enriched.pushedAt === "string" ? enriched.pushedAt : null;
    candidates.push({
      recordId: record.id,
      nodeId,
      fullName,
      htmlUrl: typeof enriched.html_url === "string" ? enriched.html_url : record.subject,
      description: typeof enriched.description === "string" ? enriched.description : null,
      stars: num(enriched.stargazers_count),
      forks: num(enriched.forks_count),
      primaryLanguage:
        (typeof enriched.primaryLanguage === "string" && enriched.primaryLanguage) ||
        (typeof enriched.language === "string" ? enriched.language : null),
      license: typeof enriched.licenseSpdxId === "string" ? enriched.licenseSpdxId : null,
      topics: Array.isArray(enriched.topics) ? (enriched.topics as string[]).map(String) : [],
      pushedAt,
      readmeChars: readmeText.length,
      factCount: Array.isArray(ledger?.facts) ? ledger.facts.length : 0,
      segmentCount: segments.length,
      spokenWords,
      estimatedSeconds: num(record.script?.estimatedSeconds),
      styleVariant: typeof record.script?.styleVariant === "string" ? record.script.styleVariant : null,
      baseScore: 0, // filled below
      issues,
    });
  }

  // Score every candidate (deterministic, no randomness).
  for (const candidate of candidates) {
    candidate.baseScore = scoreBase({
      stars: candidate.stars,
      pushedAt: candidate.pushedAt,
      readmeChars: candidate.readmeChars,
      factCount: candidate.factCount,
      segmentCount: candidate.segmentCount,
      spokenWords: candidate.spokenWords,
      licenseKnown: Boolean(candidate.license),
      hasAlignment: alignedRecords.has(candidate.recordId),
    });
  }
  candidates.sort((a, b) => b.baseScore - a.baseScore || a.nodeId.localeCompare(b.nodeId));
  return candidates;
}

/** Full read-only reconciliation report (does not touch the DB or the dataset). */
export async function reconcileDataset(): Promise<ReconciliationReport> {
  const candidates = await loadCandidates();
  const usable = candidates.filter(c => c.issues.length === 0);
  return {
    generatedAt: new Date().toISOString(),
    datasetDir: path.join(DATASET_DIR, "github"),
    channel: "github",
    scanned: candidates.length,
    candidates,
    usable: usable.length,
    shortfall: Math.max(0, 5 - usable.length),
    notes: [
      "source of truth: dataset/github/*.json (completed records only)",
      "showcase-history.db is NOT used for selection — it is the Short-form ledger",
      "node_id is the join key across dataset, ledger, capture and episode records",
      "base score = facts(≤20) + readme(≤30, log-scaled) + segments(≤10) + stars(≤20, log-scaled) + recency(≤10) + license(5) + measured-alignment(5)",
    ],
  };
}
