/**
 * Long-form master script — ONE cohesive countdown episode written by Groq.
 *
 * Built from concise per-repository evidence packets distilled from the
 * stored fact ledgers + README excerpts (never the raw README dump), so the
 * model cannot invent claims: every factual segment must cite factIds from
 * the packet.
 *
 * One request; at most ONE bounded repair attempt on validation failure.
 * There is no unbounded retry loop.
 */
import { groqChatCompletion, GroqError } from "../groq.js";
import fs from "node:fs/promises";
import path from "node:path";
import { GROQ_MODEL } from "../config.js";
import { analyzeReadme } from "../github.js";
import type { FactLedger } from "../types.js";
import type { EvidencePacket, MasterScript, MasterSegment } from "./types.js";
import type { DatasetCandidate } from "./types.js";
import { getDatasetRecord } from "../script-dataset.js";

export type MasterScriptResult = {
  script: MasterScript;
  model: string;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  retries: number;
  warnings: string[];
  /** The exact prompts, for audit artifacts. */
  prompt: { system: string; user: string };
  rawCompletion: string;
};

const MAX_FACTS = 7;
const MAX_FACT_CLAIM_CHARS = 150;
const README_EXCERPT_CHARS = 700;
const README_HEADINGS = 10;

export async function buildEvidencePacket(candidate: DatasetCandidate): Promise<EvidencePacket> {
  const record = await getDatasetRecord("github", candidate.recordId);
  if (!record) throw new Error(`dataset record disappeared during selection: ${candidate.recordId}`);
  const enriched = (record.selection as { enriched?: Record<string, unknown> } | undefined)?.enriched ?? {};
  const ledger = record.facts?.ledger as FactLedger | undefined;
  const facts = (ledger?.facts ?? [])
    .filter(f => typeof f.claim === "string" && f.claim.trim().length > 0)
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, MAX_FACTS)
    .map(f => ({
      id: f.id,
      kind: f.kind,
      semantic: f.semantic,
      claim: f.claim.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CLAIM_CHARS),
      confidence: f.confidence,
    }));
  const readmeText = String(enriched.readmeText ?? "");
  const installMatch =
    readmeText.match(/```(?:bash|sh|shell)?\s*\n([^\n]*(?:npm|pnpm|yarn|pip|cargo|go|brew|uv)[^\n]*)\n```/) ??
    readmeText.match(/`((?:npm|pnpm|yarn|pip|cargo|go|brew|uv)[^`\n]{4,120})`/);
  return {
    nodeId: candidate.nodeId,
    fullName: candidate.fullName,
    description: candidate.description,
    stars: candidate.stars,
    forks: candidate.forks,
    primaryLanguage: candidate.primaryLanguage,
    license: candidate.license,
    topics: candidate.topics,
    createdAt: typeof enriched.createdAt === "string" ? enriched.createdAt : null,
    pushedAt: candidate.pushedAt,
    latestRelease: enriched.latestRelease
      ? {
          tag: typeof (enriched.latestRelease as Record<string, unknown>).tag_name === "string"
            ? String((enriched.latestRelease as Record<string, unknown>).tag_name)
            : null,
          name: typeof (enriched.latestRelease as Record<string, unknown>).name === "string"
            ? String((enriched.latestRelease as Record<string, unknown>).name)
            : null,
          publishedAt: typeof (enriched.latestRelease as Record<string, unknown>).published_at === "string"
            ? String((enriched.latestRelease as Record<string, unknown>).published_at)
            : null,
        }
      : null,
    facts,
    readmeExcerpt: readmeText.replace(/\s+/g, " ").trim().slice(0, README_EXCERPT_CHARS),
    readmeHeadings: analyzeReadme(readmeText).headings.slice(0, README_HEADINGS),
    installCommand: installMatch ? installMatch[1].trim().slice(0, 140) : null,
  };
}

function buildSystemPrompt(): string {
  return [
    "You are the head writer of Octavia, a YouTube technology show that reviews five open-source GitHub repositories per episode.",
    "",
    "Write ONE cohesive countdown episode in the exact presentation order you are given (rank 05 first, rank 01 last).",
    "You do NOT write five separate mini-scripts; you write one flowing episode with natural transitions.",
    "",
    "Non-negotiable rules:",
    "- Use ONLY the facts provided for each repository. Never invent stars, performance, benchmarks, users, features, licenses, or compatibility.",
    "- Every factual sentence MUST cite factIds drawn from that repository's packet. Transition/CTA lines may have empty factIds.",
    "- Never speak repository URLs, commands, or file paths character-by-character. Describe them.",
    "- Start each repository section with the repository's actual name (e.g. \"agentes-chat is …\"). Never say \"repository number five\" or any rank.",
    "- Spoken text: plain English, short sentences, contractions, no markdown, no emoji, no URLs. Max 18 words per sentence.",
    "- captionText mirrors spokenText (same words, screen-appropriate spelling).",
    "- Visual variety per section is welcome; keep one editorial voice.",
    "- Spoken narration pace: ~155 words per minute. TOTAL spoken words: 700-900. HARD MINIMUM TOTAL: 600 words (enforced; a short episode will be rejected).",
    "- Every spokenText MUST be at least 25 words long (one or two full sentences).",
    "- Each repository section MUST be at least 125 words (6-8 segments of ~25-30 words). Expand mechanism/use-case detail from the facts — never with hype.",
    "- Each repository section: ~110-150 words and 4-6 segments (identify → explain → demo/feature → optional install → summary).",
    "- The opening and closing are handled separately (you still provide them below).",
    "- Highlight targets: when you write a segment whose visual is a README or source file, you MAY set highlight.targetText to an EXACT sentence fragment copied verbatim from the packet's readmeExcerpt (max 160 chars). Only verbatim fragments. Otherwise set highlight.enabled=false and targetText=null.",
    "- visualTarget.type must be one of: overview | readme-section | install | code-file.",
    "- mascot: enable for at most 2 segments per repository; position cycles bottom-right → bottom-left → right-middle → left-middle; asset is \"point\" (explaining) or \"present\" (introducing).",
    "- OUTPUT ONLY a JSON object, no prose, exactly this shape:",
    "{",
    '  "opening": { "hookSpoken": "Five GitHub projects. One worth your time.", "digInSpoken": "Let\'s dig in." },',
    '  "repositories": [',
    '    { "nodeId": "...", "fullName": "owner/name", "segments": [',
    '      { "purpose": "identify|explain|feature|demo|install|caveat|summary",',
    '        "spokenText": "<one or two full sentences, at least 25 words>", "captionText": "<the same words, screen spelling>",',
    '        "factIds": ["fact-id-1"],',
    '        "visualTarget": { "type": "overview|readme-section|install|code-file", "detail": "short label" },',
    '        "highlight": { "enabled": true, "targetText": "verbatim fragment" },',
    '        "mascot": { "enabled": true, "position": "bottom-right", "asset": "point" } }',
    "    ] }",
    "  ],",
    '  "closing": { "spokenText": "one or two friendly sentences, max 28 words, no new claims" }',
    "}",
    "Repositories MUST appear in the exact order the user message lists them.",
    "",
    "DELIVERABLE CHECK (enforced): 600+ spoken words total; every identify segment literally contains the repository name; closing.spokenText is REQUIRED; do not stop early.",
  ].join("\n");
}

function buildUserPrompt(packets: EvidencePacket[], presentationOrder: string[]): string {
  const payload = {
    presentationOrder,
    repositories: packets.map(p => ({
      nodeId: p.nodeId,
      fullName: p.fullName,
      description: p.description,
      stars: p.stars,
      forks: p.forks,
      primaryLanguage: p.primaryLanguage,
      license: p.license,
      topics: p.topics,
      createdAt: p.createdAt,
      pushedAt: p.pushedAt,
      latestRelease: p.latestRelease,
      readmeHeadings: p.readmeHeadings,
      installCommand: p.installCommand,
      facts: p.facts,
      readmeExcerpt: p.readmeExcerpt,
    })),
  };
  return (
    "Write the episode from these five evidence packets, in the exact listed order.\n\n" +
    JSON.stringify(payload, null, 1)
  );
}

const ALLOWED_PURPOSES = new Set(["identify", "explain", "feature", "demo", "install", "caveat", "summary", "transition", "cta"]);
const ALLOWED_TARGETS = new Set(["overview", "readme-section", "install", "code-file"]);
const ALLOWED_POSITIONS = new Set(["bottom-right", "bottom-left", "right-middle", "left-middle"]);
const ALLOWED_ASSETS = new Set(["point", "present"]);

export type ScriptValidation = { ok: boolean; errors: string[]; warnings: string[] };

export function validateMasterScript(
  raw: unknown,
  packets: EvidencePacket[],
  presentationOrder: string[]
): ScriptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["response is not a JSON object"], warnings };
  const root = raw as Record<string, unknown>;

  const opening = root.opening as Record<string, unknown> | undefined;
  if (!opening || typeof opening !== "object") {
    errors.push("missing opening object");
  } else {
    const hook = String(opening.hookSpoken ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!hook.includes("fivegithubprojectsoneworthyourtime")) {
      errors.push(`hook must be the locked line "Five GitHub projects. One worth your time." (got ${JSON.stringify(opening.hookSpoken)})`);
    }
    const digIn = String(opening.digInSpoken ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!digIn.includes("letsdigin")) {
      warnings.push(`dig-in line was ${JSON.stringify(opening.digInSpoken)} (expected "Let's dig in.")`);
    }
  }

  const repos = Array.isArray(root.repositories) ? (root.repositories as Array<Record<string, unknown>>) : null;
  if (!repos) {
    errors.push("missing repositories array");
    return { ok: false, errors, warnings };
  }
  if (repos.length !== 5) errors.push(`expected 5 repositories, got ${repos.length}`);

  const packetByNode = new Map(packets.map(p => [p.nodeId, p]));
  let totalWords = 0;

  for (const [index, repo] of repos.entries()) {
    const expected = presentationOrder[index];
    const fullName = String(repo.fullName ?? "");
    const nodeId = String(repo.nodeId ?? "");
    if (nodeId !== expected) {
      errors.push(`repository ${index + 1}: nodeId ${nodeId || "<missing>"} does not match the required presentation order (${expected})`);
    }
    if (!packetByNode.has(nodeId)) {
      errors.push(`repository ${index + 1} (${fullName}): nodeId not among the selected candidates`);
      continue;
    }
    const packet = packetByNode.get(nodeId)!;
    const segments = Array.isArray(repo.segments) ? (repo.segments as Array<Record<string, unknown>>) : [];
    if (segments.length < 3) errors.push(`${fullName}: fewer than 3 segments`);
    const packetFactIds = new Set(packet.facts.map(f => f.id));
    const readmeNormalized = packet.readmeExcerpt.toLowerCase().replace(/\s+/g, " ");
    let segWords = 0;
    let hasIdentify = false;
    for (const [segIndex, segment] of segments.entries()) {
      const purpose = String(segment.purpose ?? "");
      if (!ALLOWED_PURPOSES.has(purpose)) errors.push(`${fullName} seg ${segIndex + 1}: bad purpose ${purpose}`);
      if (purpose === "identify") hasIdentify = true;
      const spoken = String(segment.spokenText ?? "").trim();
      const caption = String(segment.captionText ?? "").trim();
      if (!spoken) errors.push(`${fullName} seg ${segIndex + 1}: empty spokenText`);
      if (!caption) warnings.push(`${fullName} seg ${segIndex + 1}: empty captionText`);
      const words = spoken.split(/\s+/).filter(Boolean).length;
      segWords += words;
      totalWords += words;
      const factIds = Array.isArray(segment.factIds) ? segment.factIds.map(String) : [];
      for (const id of factIds) {
        if (!packetFactIds.has(id)) errors.push(`${fullName} seg ${segIndex + 1}: factId ${id} not in packet`);
      }
      const isFactual = !["transition", "cta"].includes(purpose);
      if (isFactual && factIds.length === 0) {
        warnings.push(`${fullName} seg ${segIndex + 1}: factual segment (${purpose}) without factIds`);
      }
      const target = (segment.visualTarget as Record<string, unknown> | undefined) ?? {};
      const targetType = String(target.type ?? "");
      if (!ALLOWED_TARGETS.has(targetType)) errors.push(`${fullName} seg ${segIndex + 1}: bad visualTarget.type ${targetType}`);
      const highlight = (segment.highlight as Record<string, unknown> | undefined) ?? {};
      if (highlight.enabled) {
        const targetText = String(highlight.targetText ?? "").replace(/\s+/g, " ").trim();
        if (!targetText) {
          errors.push(`${fullName} seg ${segIndex + 1}: highlight enabled with empty targetText`);
        } else if (!readmeNormalized.includes(targetText.toLowerCase()) && !packet.facts.some(f => f.claim.toLowerCase().includes(targetText.toLowerCase()))) {
          warnings.push(`${fullName} seg ${segIndex + 1}: highlight targetText not found in evidence — must be dropped or verified at capture`);
        }
      }
      const mascot = (segment.mascot as Record<string, unknown> | undefined) ?? {};
      if (mascot.enabled) {
        if (!ALLOWED_POSITIONS.has(String(mascot.position))) {
          errors.push(`${fullName} seg ${segIndex + 1}: bad mascot position ${String(mascot.position)}`);
        }
        if (!ALLOWED_ASSETS.has(String(mascot.asset))) {
          errors.push(`${fullName} seg ${segIndex + 1}: bad mascot asset ${String(mascot.asset)}`);
        }
      }
    }
    if (!hasIdentify) warnings.push(`${fullName}: no identify segment`);
    if (segWords < 60) warnings.push(`${fullName}: only ${segWords} spoken words for the section`);
    const identifySegment = segments.find(s => String(s.purpose) === "identify");
    const spokenIdentify = identifySegment ? String(identifySegment.spokenText ?? "") : "";
    const normCompare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const repoName = fullName.split("/")[1] ?? "";
    if (repoName && !normCompare(spokenIdentify).includes(normCompare(repoName))) {
      errors.push(`${fullName}: identify segment does not speak the repository name`);
    }
  }

  const closing = root.closing as Record<string, unknown> | undefined;
  if (!closing || typeof closing.spokenText !== "string" || !closing.spokenText.trim()) {
    errors.push("missing closing line");
  } else {
    const words = closing.spokenText.trim().split(/\s+/).filter(Boolean).length;
    if (words > 40) warnings.push(`closing is ${words} words; keep it short`);
    totalWords += words;
  }

  if (totalWords < 420) errors.push(`episode too short (${totalWords} words)`);
  if (totalWords > 1200) errors.push(`episode too long (${totalWords} words)`);
  return { ok: errors.length === 0, errors, warnings };
}

/** Turn raw response into a MasterScript with deterministic pause schedule. */
export function toMasterScript(raw: unknown): MasterScript {
  const root = raw as Record<string, unknown>;
  const opening = root.opening as Record<string, string>;
  const closing = root.closing as Record<string, string>;
  const repositories: MasterScript["repositories"] = [];
  let totalWords = 0;

  for (const [repoIndex, repo] of (root.repositories as Array<Record<string, unknown>>).entries()) {
    const segments: MasterSegment[] = [];
    for (const [segIndex, segment] of (repo.segments as Array<Record<string, unknown>>).entries()) {
      const spoken = String(segment.spokenText ?? "").replace(/\s+/g, " ").trim();
      const words = spoken.split(/\s+/).filter(Boolean).length;
      totalWords += words;
      const purpose = String(segment.purpose) as MasterSegment["purpose"];
      const pauseAfterMs = purpose === "transition" ? 260 : purpose === "summary" ? 320 : 150;
      const highlight = (segment.highlight as Record<string, unknown> | undefined) ?? {};
      const mascot = (segment.mascot as Record<string, unknown> | undefined) ?? {};
      const target = (segment.visualTarget as Record<string, unknown> | undefined) ?? {};
      segments.push({
        id: `r${repoIndex + 1}s${segIndex + 1}`,
        purpose,
        spokenText: spoken,
        captionText: String(segment.captionText ?? spoken).replace(/\s+/g, " ").trim(),
        factIds: Array.isArray(segment.factIds) ? segment.factIds.map(String) : [],
        visualTarget: {
          type: String(target.type ?? "overview") as MasterSegment["visualTarget"]["type"],
          detail: String(target.detail ?? "").slice(0, 80),
        },
        highlight: {
          enabled: Boolean(highlight.enabled),
          targetText: highlight.enabled ? String(highlight.targetText ?? "").trim() : null,
        },
        mascot: {
          enabled: Boolean(mascot.enabled),
          position: (String(mascot.position ?? "bottom-right") as MasterSegment["mascot"]["position"]),
          asset: (String(mascot.asset ?? "point") as MasterSegment["mascot"]["asset"]),
        },
        pauseAfterMs,
      });
    }
    repositories.push({
      nodeId: String(repo.nodeId),
      fullName: String(repo.fullName),
      presentationRank: 5 - repoIndex,
      segments,
    });
  }

  const closingText = String(closing.spokenText ?? "Five projects worth exploring. Thanks for watching, and see you in the next one.").trim();
  totalWords += closingText.split(/\s+/).filter(Boolean).length;

  return {
    opening: {
      hookSpoken: String(opening.hookSpoken ?? "Five GitHub projects. One worth your time.").trim(),
      digInSpoken: String(opening.digInSpoken ?? "Let's dig in.").trim(),
    },
    repositories,
    closing: { spokenText: closingText },
    estimatedWords: totalWords,
  };
}

const EXCERPT_CHARS = 400;
const MINIMAL_FACTS = 3;
const MINIMAL_CLAIM_CHARS = 90;
const MINIMAL_HEADINGS = 5;

/** Evidence packets sized to fit the on_demand envelope (measured ~3.5-4k tokens). */
function shrinkPackets(packets: EvidencePacket[]): EvidencePacket[] {
  return packets.map(p => ({
    ...p,
    facts: p.facts.slice(0, MINIMAL_FACTS).map(f => ({ ...f, claim: f.claim.slice(0, MINIMAL_CLAIM_CHARS) })),
    readmeExcerpt: p.readmeExcerpt.slice(0, EXCERPT_CHARS),
    readmeHeadings: p.readmeHeadings.slice(0, MINIMAL_HEADINGS),
    latestRelease: p.latestRelease,
  }));
}

export async function generateMasterScript(
  packets: EvidencePacket[],
  presentationOrder: string[],
  options: { log?: (line: string) => void; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; artifactsDir?: string } = {}
): Promise<MasterScriptResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const system = buildSystemPrompt();

  // The on_demand tier enforces prompt + max_tokens <= 8000. Evidence packets
  // are deliberately sized to fit that envelope with output headroom; the
  // completion budget scales down to whatever the prompt leaves unused.
  const maxTokensFor = (userPrompt: string): number =>
    Math.max(2600, Math.min(4096, 7900 - Math.ceil((system.length + userPrompt.length) / 3.0)));

  const callWith = (pkts: EvidencePacket[], extraNote?: string) => {
    const userPrompt = buildUserPrompt(pkts, presentationOrder) + (extraNote ? `\n\nCORRECTION REQUIRED:\n${extraNote}` : "");
    return groqChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      {
        model: GROQ_MODEL,
        maxTokens: maxTokensFor(userPrompt),
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        log: line => log(`  ${line}`),
      }
    );
  };

  // Primary path: packets sized to the on_demand envelope (measured ~3.8k tokens).
  const minimalPackets = shrinkPackets(packets);
  let packetsUsed = minimalPackets;
  let completion;
  try {
    completion = await callWith(minimalPackets);
  } catch (error) {
    // Extremely defensive: if even the lean packet overflows, strip everything else.
    if (error instanceof GroqError && error.status === 413) {
      log("  groq: 413 even with lean packets; retrying once more with the absolute minimum...");
      packetsUsed = minimalPackets.map(p => ({ ...p, facts: p.facts.slice(0, 3), readmeExcerpt: "" }));
      completion = await callWith(packetsUsed);
    } else {
      throw error;
    }
  }
  let warnings: string[] = [];
  let parsed: unknown = tryParseJson(completion.content, warnings);
  parsed = sanitizeFactIds(parsed, packets, warnings);
  let validation = validateMasterScript(parsed, packets, presentationOrder);

  // Always dump the artifacts — especially when validation fails (debugging aid).
  if (options.artifactsDir) {
    await fs.mkdir(options.artifactsDir, { recursive: true });
    await fs.writeFile(path.join(options.artifactsDir, "llm-prompt.json"), JSON.stringify({ system, user: buildUserPrompt(packetsUsed, presentationOrder) }, null, 2), "utf8");
    await fs.writeFile(path.join(options.artifactsDir, "llm-response.json"), JSON.stringify({ model: completion.model, usage: completion.usage, retries: completion.retries, content: completion.content }, null, 2), "utf8");
  }

  if (!validation.ok) {
    for (const e of validation.errors) log(`  validation: ${e}`);
    log("  groq: validation failed; one bounded regeneration with error feedback...");
    const feedback = validation.errors.map(e => `- ${e}`).join("\n");
    completion = await callWith(
      minimalPackets,
      "Your previous draft failed validation with these problems:\n" +
        feedback +
        "\nWrite the COMPLETE corrected JSON again. Requirements: 600+ spoken words total, every identify segment literally contains the repository name, closing.spokenText is required."
    );
    packetsUsed = minimalPackets;
    parsed = tryParseJson(completion.content, warnings);
    parsed = sanitizeFactIds(parsed, packets, warnings);
    validation = validateMasterScript(parsed, packets, presentationOrder);
  } else {
    // warnings stays as-is: sanitize warnings + validation warnings, each once.
  }

  if (!validation.ok) {
    throw new GroqError(
      `master script failed validation after one bounded regeneration:\n  - ${validation.errors.join("\n  - ")}`,
      null
    );
  }
  warnings = [...new Set([...warnings, ...validation.warnings])];

  return {
    script: toMasterScript(parsed),
    model: completion.model,
    usage: completion.usage,
    retries: completion.retries,
    warnings,
    prompt: { system, user: buildUserPrompt(packetsUsed, presentationOrder) },
    rawCompletion: completion.content,
  };
}

/**
 * LLMs reliably invent factIds (e.g. the literal string "installCommand" from
 * the packet's installHint field). Rather than fail the whole run, coerce:
 * drop factIds that do not exist in ANY packet, warn, and continue with the
 * remainder. Validation runs after this pass against the sanitized output.
 */
function sanitizeFactIds(
  raw: unknown,
  packets: EvidencePacket[],
  warnings: string[]
): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const validIds = new Set(packets.flatMap(p => p.facts.map(f => f.id)));
  const root = raw as Record<string, unknown>;
  const repos = Array.isArray(root.repositories) ? (root.repositories as Array<Record<string, unknown>>) : [];
  for (const repo of repos) {
    const segments = Array.isArray(repo.segments) ? (repo.segments as Array<Record<string, unknown>>) : [];
    for (const segment of segments) {
      const factIds = Array.isArray(segment.factIds) ? segment.factIds.map(String) : [];
      const kept = factIds.filter(id => validIds.has(id));
      const dropped = factIds.filter(id => !validIds.has(id));
      if (dropped.length) {
        warnings.push(
          `${String(repo.fullName ?? "?")}: dropped unknown factIds ${JSON.stringify(dropped)} (not present in any evidence packet)`
        );
      }
      segment.factIds = kept;
    }
  }
  return raw;
}

function tryParseJson(content: string, warnings: string[]): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    warnings.push("completion was not parseable JSON (treated as invalid)");
    return null;
  }
}
