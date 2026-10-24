import type {
  EnrichedRepo,
  Fact,
  FactKind,
  FactLedger,
  FactProvenance,
  FactSemantic,
  Repo,
} from "./types.js";
import { FACT_CONFIDENCE_THRESHOLD } from "./config.js";

const DAY = 86400000;

/**
 * What each fact kind *does* by default when the extractor does not say
 * otherwise. `feature` bullets describe how the project works (mechanism),
 * `use_case` prose is an example, and stars/license/language are metadata.
 */
const DEFAULT_SEMANTIC: Record<FactKind, FactSemantic> = {
  purpose: "purpose",
  problem: "problem",
  feature: "mechanism",
  mechanism: "mechanism",
  workflow: "workflow",
  example: "example",
  use_case: "example",
  outcome: "outcome",
  install: "setup",
  license: "metadata",
  adoption: "metadata",
  activity: "metadata",
  requirement: "limitation",
  limitation: "limitation",
  release: "metadata",
  language: "metadata",
};

type FactExtras = {
  semantic?: FactSemantic;
  /** Verbatim excerpt that supports the claim. */
  exact?: string;
  lineStart?: number;
  lineEnd?: number;
  /** Deterministic extraction rule that produced the fact. */
  rule?: string;
};

function fact(
  repo: EnrichedRepo,
  kind: FactKind,
  claim: string,
  spoken: string,
  confidence: number,
  source: Fact["source"]["kind"],
  location: string,
  extras: FactExtras = {}
): Fact {
  const provenance: FactProvenance = {
    path: source === "api-field" ? "GitHub API" : "README.md",
    rule: extras.rule ?? kind,
    ...(extras.exact ? { excerpt: extras.exact } : {}),
    ...(extras.lineStart !== undefined ? { lineStart: extras.lineStart } : {}),
    ...(extras.lineEnd !== undefined ? { lineEnd: extras.lineEnd } : {}),
  };
  return {
    id: `${kind}:${location}:${slug(claim).slice(0, 32)}`,
    kind,
    semantic: extras.semantic ?? DEFAULT_SEMANTIC[kind],
    claim,
    spoken,
    source: { kind: source, location, capturedAt: repo.capturedAt },
    provenance,
    confidence: Number(confidence.toFixed(2)),
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sentence(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

/* ------------------------------------------------------------------ */
/* README parsing                                                      */
/* ------------------------------------------------------------------ */

export type ReadmeSection = {
  heading: string;
  level: number;
  /** Prose only. Fenced code is kept separate so it is never narrated. */
  body: string;
  /** Raw fenced-code contents, without the fence markers. */
  codeBlocks: string[];
  /** Fence language of each `codeBlocks` entry ("" when none was declared). */
  codeLangs?: string[];
  /** 1-based inclusive line range of the section in the source document. */
  lineStart: number;
  lineEnd: number;
};

/** A prose paragraph with its section and exact source lines. */
export type ReadmeParagraph = {
  text: string;
  heading: string;
  level: number;
  lineStart: number;
  lineEnd: number;
};

/** A Markdown table with its header row and section. */
export type ReadmeTable = {
  headers: string[];
  rows: string[][];
  heading: string;
  lineStart: number;
};

export type ParsedReadme = {
  /**
   * Introduction only: the prose before the first level-2 heading (the
   * preamble and the document title body). This is deliberately *not* the whole
   * flattened README, so a purpose fallback can never pick a sentence from a
   * later, unrelated section.
   */
  overview: string;
  sections: ReadmeSection[];
  codeBlocks: string[];
  plainText: string;
  headings: string[];
  /** Narratable prose paragraphs, in document order. */
  paragraphs: ReadmeParagraph[];
  /** Markdown tables, in document order (command tables included). */
  tables: ReadmeTable[];
};

const BULLET_RE = /^\s*[-*+]\s+/;
const ORDERED_RE = /^\s*\d+[.)]\s+/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/;

/** Parse consecutive Markdown table lines starting at `startIndex`. */
function parseTableRows(
  lines: string[],
  startIndex: number
): { rows: string[][]; endIndex: number } {
  const rows: string[][] = [];
  let index = startIndex;
  while (index < lines.length && TABLE_RE.test(lines[index])) {
    if (!TABLE_SEP_RE.test(lines[index])) {
      rows.push(
        lines[index]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map(cell => stripMarkdown(cell.trim()))
      );
    }
    index += 1;
  }
  return { rows, endIndex: index - 1 };
}

export function parseReadme(readme: string | null): ParsedReadme {
  const text = readme ?? "";
  const lines = text.split(/\r?\n/);
  const sections: ReadmeSection[] = [];
  const codeBlocks: string[] = [];
  const paragraphs: ReadmeParagraph[] = [];
  const tables: ReadmeTable[] = [];

  let current: ReadmeSection = {
    heading: "",
    level: 0,
    body: "",
    codeBlocks: [],
    codeLangs: [],
    lineStart: 1,
    lineEnd: 1,
  };
  let inFence = false;
  let fenceLines: string[] = [];
  let fenceLang = "";

  let paragraph: string[] = [];
  let paragraphStart = 1;
  const flushParagraph = (endLine: number): void => {
    const raw = paragraph.join(" ").trim();
    const startLine = paragraphStart;
    paragraph = [];
    if (!raw) return;
    const plain = stripMarkdown(raw);
    if (!plain) return;
    paragraphs.push({
      text: plain,
      heading: current.heading,
      level: current.level,
      lineStart: startLine,
      lineEnd: Math.max(startLine, endLine),
    });
  };

  const closeSection = (endLine: number): void => {
    current.lineEnd = Math.max(current.lineStart, endLine);
    if (current.heading || current.body.trim() || current.codeBlocks.length) {
      sections.push(current);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    const fenceMatch = line.match(/^\s*```(\w*)\s*$/);
    if (fenceMatch) {
      flushParagraph(lineNumber - 1);
      if (!inFence) {
        inFence = true;
        fenceLines = [];
        fenceLang = (fenceMatch[1] ?? "").toLowerCase();
        continue;
      }
      inFence = false;
      const block = fenceLines.join("\n").trim();
      if (block) {
        current.codeBlocks.push(block);
        current.codeLangs!.push(fenceLang);
        codeBlocks.push(block);
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph(lineNumber - 1);
      closeSection(lineNumber - 1);
      current = {
        heading: heading[2].trim(),
        level: heading[1].length,
        body: "",
        codeBlocks: [],
        codeLangs: [],
        lineStart: lineNumber,
        lineEnd: lineNumber,
      };
      continue;
    }

    if (TABLE_RE.test(line)) {
      flushParagraph(lineNumber - 1);
      const table = parseTableRows(lines, index);
      if (table.rows.length >= 2) {
        tables.push({
          headers: table.rows[0],
          rows: table.rows.slice(1),
          heading: current.heading,
          lineStart: lineNumber,
        });
      }
      for (let cursor = index; cursor <= table.endIndex; cursor += 1) {
        current.body += `${lines[cursor]}\n`;
      }
      index = table.endIndex;
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      flushParagraph(lineNumber - 1);
      current.body += `${line}\n`;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(lineNumber - 1);
      current.body += `${line}\n`;
      continue;
    }

    if (paragraph.length === 0) paragraphStart = lineNumber;
    paragraph.push(line.trim());
    current.body += `${line}\n`;
  }

  if (inFence && fenceLines.length) {
    // An unclosed fence is still real code; keep it out of the prose.
    current.codeBlocks.push(fenceLines.join("\n").trim());
    current.codeLangs!.push(fenceLang);
    codeBlocks.push(fenceLines.join("\n").trim());
  }
  flushParagraph(lines.length);
  closeSection(lines.length);

  const plainText = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`>#~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // The overview is the introduction: paragraphs that live before the first
  // level-2 heading (preamble + document title). Never later sections.
  const overview = paragraphs
    .filter(item => item.level < 2)
    .map(item => item.text)
    .join(" ")
    .trim();

  return {
    overview,
    sections,
    codeBlocks,
    plainText,
    headings: sections.filter(s => s.level > 0).map(s => s.heading.toLowerCase()),
    paragraphs,
    tables,
  };
}

function sectionMatching(
  parsed: ParsedReadme,
  patterns: RegExp[]
): ReadmeSection | null {
  for (const pattern of patterns) {
    const found = parsed.sections.find(section =>
      pattern.test(section.heading.toLowerCase())
    );
    if (found) return found;
  }
  return null;
}

const NON_FEATURE_HEADINGS =
  /^(install|installation|setup|usage|examples?|how to use|api|commands?|configuration|options?|contributing|contribution|license|licence|credits?|acknowledg|table of contents|sponsors?|backers?|changelog|roadmap|faq|troubleshooting|testing|development|related|see also|similar|alternatives|ecosystem|packages?|siblings?|companions?|other projects?|more projects?)/;

/**
 * Code, command lines, URLs and raw markup are evidence, but they are not
 * sentences. Keeping them out of spoken clauses is what stops a README from
 * turning into "import foo from 'bar'; const ..." narration.
 */
export function looksLikeCode(
  value: string,
  options: { allowFilePairs?: boolean } = {}
): boolean {
  const text = value.trim();
  if (!text) return true;
  if (/=>|https?:\/\/|[;{}]|\/\/|<\/?[a-z][^>]*>/i.test(text)) return true;
  if (/\b(?:const|let|var|function|return|import|export|class|interface|await|async|console\.log)\b/.test(text)) {
    return true;
  }
  if (/\w+\([^)]*\)/.test(text)) return true;
  // "tool input.csv" is a file listing when it comes from program output, but
  // the canonical CLI invocation when it comes from a shell fence — the
  // workflow/example extractors read those with `allowFilePairs`.
  if (!options.allowFilePairs && /^[a-z0-9._/-]+\s+[a-z0-9._/-]+$/i.test(text) && /[./\\]/.test(text)) {
    return true;
  }
  return false;
}

/** True when a README line can be read aloud as natural prose. */
export function isNarratableProse(value: string): boolean {
  const text = value.trim();
  if (text.length < 12 || text.length > 220) return false;
  if (looksLikeCode(text)) return false;
  // Require a sentence-like word count; fragments such as "Fast. Small." are
  // still allowed, but not symbol soup or table fragments.
  const words = text.split(/\s+/).filter(word => /[A-Za-z]{2,}/.test(word));
  return words.length >= 3;
}

export function sectionWithBullets(
  parsed: ParsedReadme,
  patterns: RegExp[]
): ReadmeSection | null {
  for (const pattern of patterns) {
    for (const section of parsed.sections) {
      if (!pattern.test(section.heading.toLowerCase())) continue;
      if (bulletsOf(section).length >= 2) return section;
    }
  }
  let best: ReadmeSection | null = null;
  let bestCount = 0;
  for (const section of parsed.sections) {
    if (NON_FEATURE_HEADINGS.test(section.heading.toLowerCase())) continue;
    const count = bulletsOf(section).length;
    if (count > bestCount) {
      best = section;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : null;
}

function firstRealSentence(text: string, minLength = 40): string | null {
  const matches = text.match(/[^.!?\n]+[.!?]?/g) ?? [];
  for (const candidate of matches) {
    const trimmed = sentence(candidate);
    if (trimmed.length >= minLength && /\w/.test(trimmed)) return trimmed;
  }
  return null;
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function bulletEntriesOf(
  section: ReadmeSection | null
): { text: string; line: number }[] {
  if (!section) return [];
  const entries: { text: string; line: number }[] = [];
  section.body.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*[-*+]\s+(.*)$/);
    if (!match) return;
    const text = stripMarkdown(sentence(match[1]));
    if (text.length < 12 || text.length > 160) return;
    if (!isNarratableProse(text)) return;
    if (
      /\b(visit|see|read|docs|documentation|course|tutorial|guide|learn more|getting started)\b/i.test(
        text
      )
    ) {
      return;
    }
    entries.push({ text, line: section.lineStart + index + 1 });
  });
  return entries;
}

export function bulletsOf(section: ReadmeSection | null): string[] {
  return bulletEntriesOf(section).map(entry => entry.text);
}

/* ------------------------------------------------------------------ */
/* Semantic evidence: problem, mechanism, workflow, examples           */
/* ------------------------------------------------------------------ */

const PROBLEM_HEADING_RE =
  /^(why|the problem|problem|motivation|background|rationale|pain points?)/;
const MECHANISM_HEADING_RE =
  /^(how (it|does it|it'?s) works?|how .* works|how it'?s built|architecture|internals?|design|under the hood|the approach|implementation)/;
const WORKFLOW_HEADING_RE =
  /^(quick ?start|getting started|first steps|workflow|how to use|usage|examples?|basic usage|commands?)/;

/** Sentences of a paragraph, markdown-stripped and without trailing punctuation. */
function cleanSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]?/g) ?? [])
    .map(part => stripMarkdown(part).trim().replace(/[.!?]+$/, "").trim())
    .filter(part => part.length >= 12);
}

/** Paragraphs whose source lines fall inside a section. */
function paragraphsIn(parsed: ParsedReadme, section: ReadmeSection): ReadmeParagraph[] {
  return parsed.paragraphs.filter(
    paragraph =>
      paragraph.lineStart >= section.lineStart && paragraph.lineStart <= section.lineEnd
  );
}

/** Ordered-list ("1. ...") steps inside a section. */
function orderedStepsOf(section: ReadmeSection): { text: string; line: number }[] {
  const steps: { text: string; line: number }[] = [];
  section.body.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!match) return;
    const text = stripMarkdown(sentence(match[1]));
    if (!isNarratableProse(text) && !/\w/.test(text)) return;
    steps.push({ text, line: section.lineStart + index + 1 });
  });
  return steps;
}

/** Fence languages that plausibly contain runnable shell commands. */
const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "ksh",
  "console",
  "terminal",
  "shellsession",
  "powershell",
  "pwsh",
  "ps1",
  "cmd",
  "batch",
]);

/**
 * Every command-like line in a section's fenced code blocks (not output/code).
 *
 * With `shellOnly`, only fences explicitly declared as a shell language are
 * read. Undeclared fences frequently hold program *output* (an error dump, a
 * log excerpt), and an output line can look exactly like a command — so
 * workflow extraction, which treats every hit as a runnable step, must not
 * consume them. `firstCommandIn` keeps the permissive view for install
 * detection, where a wrong guess is still reviewed by the surrounding rules.
 */
function commandsIn(section: ReadmeSection | null, shellOnly = false): string[] {
  if (!section) return [];
  const found: string[] = [];
  section.codeBlocks.forEach((block, blockIndex) => {
    if (shellOnly) {
      const lang = (section.codeLangs?.[blockIndex] ?? "").toLowerCase();
      if (!SHELL_LANGS.has(lang)) return;
    }
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^[#$>{*+\-\d]/.test(line)) continue;
      if (/\b(output|result|response|logs?):?\s*$/i.test(line)) continue;
      if (!/^[a-z0-9._/\\-]+\s+\S/i.test(line) && !/^\.\//.test(line)) continue;
      if (looksLikeCode(line, { allowFilePairs: shellOnly })) continue;
      const cleaned = line.replace(/\s{2,}.*$/, "").trim();
      if (cleaned.length >= 4 && cleaned.length <= 90) found.push(cleaned);
    }
  });
  return found;
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/**
 * Bullets describe either how the project works (mechanism) or what you get
 * from it (outcome). The distinction drives the narrative role, not the text.
 */
const OUTCOME_BULLET_RE =
  /^(works? with|no |without |keeps?|stays?|config(uration)? (lives?|in)|dry[- ]run|single file|reduces?|avoids?|saves?|lets? you|so you|you can|any )/i;

function classifyBulletSemantic(text: string): FactSemantic {
  return OUTCOME_BULLET_RE.test(text.trim()) ? "outcome" : "mechanism";
}

/**
 * The problem the project exists to solve. Only prose that actually frames a
 * problem is used — a "Why" section, or an introduction sentence that talks
 * about what people do *without* the tool.
 */
export function extractProblem(repo: EnrichedRepo, parsed: ParsedReadme): Fact[] {
  const ranked: ReadmeParagraph[] = [];
  for (const section of parsed.sections) {
    const heading = section.heading.toLowerCase().trim();
    const isWhy = PROBLEM_HEADING_RE.test(heading);
    const isIntro = section.level < 2;
    if (!isWhy && !isIntro) continue;
    for (const paragraph of paragraphsIn(parsed, section)) ranked.push(paragraph);
  }
  for (const paragraph of ranked) {
    for (const line of cleanSentences(paragraph.text)) {
      if (!isNarratableProse(line)) continue;
      const framesProblem =
        PROBLEM_HEADING_RE.test(paragraph.heading.toLowerCase().trim()) ||
        /\b(usually means|means (copying|editing|writing)|by hand|before you (write|start)|drifts?|buries?|instead of|without (a|an|any)|the problem|tedious|painful|hard to|difficult to)\b/i.test(
          line
        );
      if (!framesProblem) continue;
      return [
        fact(
          repo,
          "problem",
          `The README describes the problem it solves: ${line}.`,
          line,
          0.8,
          "readme-section",
          `readme#${slug(paragraph.heading || "overview")}`,
          {
            semantic: "problem",
            exact: line,
            lineStart: paragraph.lineStart,
            lineEnd: paragraph.lineEnd,
            rule: "readme-problem",
          }
        ),
      ];
    }
  }
  return [];
}

/**
 * Dedicated "how it works" prose. When a repository documents its mechanism,
 * this is stronger evidence than a feature bullet, so the planner prefers it.
 */
export function extractMechanism(repo: EnrichedRepo, parsed: ParsedReadme): Fact[] {
  for (const section of parsed.sections) {
    if (!MECHANISM_HEADING_RE.test(section.heading.toLowerCase().trim())) continue;
    const facts: Fact[] = [];
    for (const paragraph of paragraphsIn(parsed, section)) {
      const line = cleanSentences(paragraph.text).find(isNarratableProse);
      if (!line) continue;
      facts.push(
        fact(
          repo,
          "mechanism",
          `README ${section.heading} section: ${line}.`,
          line,
          0.85,
          "readme-section",
          `readme#${slug(section.heading)}`,
          {
            semantic: "mechanism",
            exact: line,
            lineStart: paragraph.lineStart,
            lineEnd: paragraph.lineEnd,
            rule: "readme-mechanism",
          }
        )
      );
      if (facts.length >= 2) break;
    }
    if (facts.length > 0) return facts;
  }
  return [];
}

/**
 * A documented workflow: an ordered list of steps or the command sequence in a
 * Usage / Quick start section. A lone code block with no operation is *not* a
 * workflow.
 */
export function extractWorkflow(repo: EnrichedRepo, parsed: ParsedReadme): Fact[] {
  for (const section of parsed.sections) {
    if (!WORKFLOW_HEADING_RE.test(section.heading.toLowerCase().trim())) continue;
    const ordered = orderedStepsOf(section);
    const parts =
      ordered.length >= 2 ? ordered.map(step => step.text) : commandsIn(section, true);
    if (parts.length < 2) continue;
    return parts.slice(0, 3).map((part, index) =>
      fact(
        repo,
        "workflow",
        `README workflow step ${index + 1}: ${part}.`,
        sentence(part),
        0.8,
        "readme-section",
        `readme#${slug(section.heading)}`,
        { semantic: "workflow", exact: part, rule: "readme-workflow" }
      )
    );
  }
  return [];
}

/**
 * Render a documented shell command for speech: drop redirections and flags,
 * keep the pipeline shape. `my-service 2>&1 | logline` becomes
 * "my-service piped into logline" — honest about what the README shows
 * without asking the voice to read `2>&1`.
 */
export function speakCommand(command: string): string {
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      token =>
        !/^(\d*>{1,2}&?\d*|<\d*|&\d*|\/dev\/null|2>\S*|>>?)$/.test(token) &&
        !/^-{1,2}[\w-]+$/.test(token)
    );
  const segments = tokens
    .join(" ")
    .split("|")
    .map(part => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return "";
  return segments.join(" piped into ");
}

/**
 * A documented command with no prose description is still example evidence:
 * it demonstrates a concrete operation the README actually shows. Used as the
 * fallback when no command table exists, and capped at one fact so a wall of
 * shell lines cannot masquerade as documented examples.
 */
function commandExampleFact(
  repo: EnrichedRepo,
  section: ReadmeSection,
  command: string
): Fact | null {
  const spoken = sentence(speakCommand(command));
  // A command is not prose; the gate is speakability (enough word-like
  // tokens for the voice to say something), not sentence structure.
  const tokens = spoken.split(/\s+/).filter(token => /[A-Za-z]{2,}/.test(token));
  if (spoken.length < 6 || tokens.length < 2) return null;
  return fact(
    repo,
    "example",
    `The README documents the command: ${command}.`,
    spoken,
    0.7,
    "readme-code",
    `readme#${slug(section.heading)}`,
    { semantic: "example", exact: command, rule: "readme-usage-command" }
  );
}

/**
 * Documented examples. A command table that pairs a command with what it does
 * is the strongest example evidence a README can carry: it names the operation
 * rather than describing a feature. When there is no table, a documented
 * command in a usage section still demonstrates a real operation.
 */
export function extractExamples(repo: EnrichedRepo, parsed: ParsedReadme): Fact[] {
  for (const table of parsed.tables) {
    const headerText = table.headers.join(" ").toLowerCase();
    const isCommandTable =
      /\bcommand\b/.test(headerText) ||
      (/\b(what it does|description|purpose)\b/.test(headerText) &&
        /\b(command|flag|option|script|usage|name)\b/.test(headerText));
    if (!isCommandTable) continue;
    const facts: Fact[] = [];
    for (const row of table.rows.slice(0, 3)) {
      const [command, ...rest] = row;
      const description = rest.join(" ").trim();
      if (!command || !description) continue;
      if (!isNarratableProse(description)) continue;
      const spoken = sentence(`${command} ${lowerFirst(description)}`);
      facts.push(
        fact(
          repo,
          "example",
          `The command table documents ${command}: ${sentence(description)}.`,
          spoken,
          0.9,
          "readme-table",
          `readme#${slug(table.heading || "commands")}`,
          {
            semantic: "example",
            exact: `${command} — ${description}`,
            lineStart: table.lineStart,
            rule: "readme-command-table",
          }
        )
      );
    }
    if (facts.length > 0) return facts;
  }

  // No command table: a documented command in a usage/quick-start section is
  // still a concrete demonstrated operation. One fact only — a wall of shell
  // is not a documented example.
  for (const section of parsed.sections) {
    if (!WORKFLOW_HEADING_RE.test(section.heading.toLowerCase().trim())) continue;
    const command = commandsIn(section, true)[0];
    if (!command) continue;
    const example = commandExampleFact(repo, section, command);
    if (example) return [example];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Install commands                                                    */
/* ------------------------------------------------------------------ */

export type InstallInfo = {
  command: string | null;
  spoken: string;
  fact: Fact | null;
};

const PACKAGE_MANAGERS: {
  command: RegExp;
  spoken: string;
  display: string;
}[] = [
  { command: /\bpnpm[ \t]+(?:add|install)(?:[ \t]+\S+){0,10}/i, spoken: "install it with pnpm", display: "pnpm add" },
  { command: /\byarn[ \t]+add(?:[ \t]+\S+){0,10}/i, spoken: "install it with yarn", display: "yarn add" },
  { command: /\bbun[ \t]+add(?:[ \t]+\S+){0,10}/i, spoken: "install it with bun", display: "bun add" },
  { command: /\bnpm[ \t]+(?:install|i)(?:[ \t]+\S+){0,10}/i, spoken: "install it with npm", display: "npm install" },
  { command: /\bnpx[ \t]+create-[\w.-]+(?:[ \t]+\S+){0,10}/i, spoken: "run its project creator with npx", display: "npx create-*" },
  { command: /\bpip3?[ \t]+install(?:[ \t]+\S+){0,10}/i, spoken: "install it with pip", display: "pip install" },
  { command: /\b(?:uv|pipx)[ \t]+(?:tool[ \t]+)?install(?:[ \t]+\S+){0,10}/i, spoken: "install it with that Python tool", display: "uv tool install" },
  { command: /\bcargo[ \t]+install(?:[ \t]+\S+){0,10}/i, spoken: "install it with cargo", display: "cargo install" },
  { command: /\bgo[ \t]+install(?:[ \t]+\S+){0,10}/i, spoken: "install it from source with go", display: "go install" },
  { command: /\bbrew[ \t]+install(?:[ \t]+\S+){0,10}/i, spoken: "install it with homebrew", display: "brew install" },
  { command: /\bapt(?:-get)?[ \t]+install(?:[ \t]+\S+){0,10}/i, spoken: "install it with apt", display: "apt install" },
];

export function extractInstall(
  repo: EnrichedRepo,
  parsed: ParsedReadme
): InstallInfo {
  const section = sectionMatching(parsed, [
    /^(install|installation|setup|getting started|quick ?start)/,
  ]);
  const sectionCode = section?.codeBlocks.join("\n") ?? "";
  const haystack = `${section?.body ?? ""}\n${sectionCode}\n${parsed.plainText}`;

  for (const manager of PACKAGE_MANAGERS) {
    const match = haystack.match(manager.command);
    if (match) {
      const command = match[0].split(/\r?\n/)[0].trim().replace(/[.)]+$/, "");
      return {
        command,
        spoken: `You can ${manager.spoken}`,
        fact: fact(
          repo,
          "install",
          `The README documents a ${manager.display} setup command: ${command}.`,
          `you can ${manager.spoken}`,
          0.85,
          "readme-code",
          "readme#install"
        ),
      };
    }
  }

  if (/docker compose|docker-compose up|docker run/i.test(haystack)) {
    return {
      command: "docker compose up -d",
      spoken: "you can bring it up with Docker Compose",
      fact: fact(
        repo,
        "install",
        "The README documents a Docker Compose setup.",
        "you can bring it up with Docker Compose",
        0.8,
        "readme-code",
        "readme#docker"
      ),
    };
  }

  if (/git clone/i.test(haystack) && section) {
    return {
      command: "git clone " + repo.html_url.replace("https://github.com/", ""),
      spoken: "you clone the repository and follow its setup steps",
      fact: fact(
        repo,
        "install",
        "The README documents a clone-and-build setup.",
        "you clone the repository and follow its setup steps",
        0.7,
        "readme-section",
        "readme#setup"
      ),
    };
  }

  if (section) {
    // A fenced command inside the setup section is stronger evidence than the
    // mere existence of the section, so quote it verbatim.
    const command = firstCommandIn(section);
    if (command) {
      return {
        command,
        spoken: `The README starts you with ${command}`,
        fact: fact(
          repo,
          "install",
          `The setup section starts with the command: ${command}.`,
          `the README starts you with the command ${command}`,
          0.75,
          "readme-code",
          `readme#${slug(section.heading)}`
        ),
      };
    }
    return {
      command: null,
      spoken: "the README has a setup section that walks you through it",
      fact: fact(
        repo,
        "install",
        "The README contains a setup section.",
        "the README has a setup section that walks you through it",
        0.6,
        "readme-section",
        `readme#${slug(section.heading)}`
      ),
    };
  }

  return { command: null, spoken: "", fact: null };
}

function firstCommandIn(section: ReadmeSection): string | null {
  return commandsIn(section)[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Hosting / cost — evidence-gated                                     */
/* ------------------------------------------------------------------ */

function hostingFact(repo: EnrichedRepo, parsed: ParsedReadme): Fact | null {
  const text = parsed.plainText.toLowerCase();
  const selfHosted =
    /\bself[- ]host(ed|ing)?\b/.test(text) ||
    /\bruns? (locally|on your (own )?machine|on[- ]prem(ise)?)\b/.test(text) ||
    /\bwithout (a )?(cloud|server|account)\b/.test(text);
  if (selfHosted) {
    return fact(
      repo,
      "requirement",
      "The README states it can be self-hosted or run locally.",
      "it is built to run on your own machine",
      0.75,
      "readme-section",
      "readme#self-hosting"
    );
  }
  return null;
}

function costFact(repo: EnrichedRepo, parsed: ParsedReadme): Fact | null {
  const text = parsed.plainText.toLowerCase();
  if (/\b(free tier|free plan|completely free|free and open)\b/.test(text)) {
    return fact(
      repo,
      "requirement",
      "The README describes the service as free.",
      "the project describes itself as free to use",
      0.7,
      "readme-section",
      "readme#pricing"
    );
  }
  if (/\b(pricing|paid plan|subscription|billing|per month|free trial|api key)\b/.test(text)) {
    return fact(
      repo,
      "requirement",
      "The README mentions pricing, a subscription, or an API key.",
      "its hosted service may involve a subscription or an API key",
      0.6,
      "readme-section",
      "readme#pricing"
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type BuildFactsOptions = {
  previousStars?: number | null;
  previousCapturedAt?: string | null;
};

export function buildFactLedger(
  repo: EnrichedRepo,
  options: BuildFactsOptions = {}
): FactLedger {
  const parsed = parseReadme(repo.readmeText);
  const facts: Fact[] = [];

  /* --- purpose --------------------------------------------------- */
  const description = repo.description?.trim() ?? "";
  if (description.length >= 12) {
    facts.push(
      fact(
        repo,
        "purpose",
        `The repository describes itself as: ${sentence(description)}.`,
        sentence(description),
        0.95,
        "api-field",
        "repo.description",
        { semantic: "purpose", rule: "api-description" }
      )
    );
  } else {
    const overviewSentence = firstRealSentence(stripMarkdown(parsed.overview), 40);
    if (overviewSentence) {
      const intro = parsed.paragraphs.find(item => item.level < 2) ?? null;
      facts.push(
        fact(
          repo,
          "purpose",
          `The README overview states: ${overviewSentence}.`,
          sentence(overviewSentence),
          0.7,
          "readme-section",
          "readme#overview",
          {
            semantic: "purpose",
            exact: overviewSentence,
            lineStart: intro?.lineStart,
            lineEnd: intro?.lineEnd,
            rule: "readme-overview",
          }
        )
      );
    }
  }

  /* --- problem --------------------------------------------------- */
  facts.push(...extractProblem(repo, parsed));

  /* --- features (mechanism / outcome) ---------------------------- */
  const featureSection = sectionWithBullets(parsed, [
    /^(features?|capabilities|highlights|benefits?|why|what'?s inside|use ?cases?|tools?)/,
  ]);
  for (const entry of bulletEntriesOf(featureSection).slice(0, 4)) {
    facts.push(
      fact(
        repo,
        "feature",
        `README feature bullet: ${entry.text}.`,
        entry.text,
        0.7,
        "readme-section",
        `readme#${slug(featureSection!.heading)}`,
        {
          semantic: classifyBulletSemantic(entry.text),
          exact: entry.text,
          lineStart: entry.line,
          rule: "readme-feature-bullet",
        }
      )
    );
  }

  /* --- dedicated mechanism prose --------------------------------- */
  facts.push(...extractMechanism(repo, parsed));

  /* --- usage / examples ----------------------------------------- */
  const usageSection = sectionMatching(parsed, [
    /^(usage|examples?|how to use|basic usage)/,
  ]);
  if (usageSection) {
    const usageSentence = firstRealSentence(stripMarkdown(usageSection.body), 40);
    // Skip navigational sentences: "visit our docs", "see the course". Those
    // are not use cases and would read as filler in the narration.
    if (
      usageSentence &&
      !/\b(visit|see|read|docs|documentation|course|tutorial|guide|learn)\b/i.test(
        usageSentence
      )
    ) {
      const paragraph = paragraphsIn(parsed, usageSection)[0] ?? null;
      facts.push(
        fact(
          repo,
          "use_case",
          `README usage: ${usageSentence}.`,
          sentence(usageSentence),
          0.7,
          "readme-section",
          `readme#${slug(usageSection.heading)}`,
          {
            semantic: "example",
            exact: usageSentence,
            lineStart: paragraph?.lineStart,
            lineEnd: paragraph?.lineEnd,
            rule: "readme-usage-prose",
          }
        )
      );
    }
  }

  /* --- workflow steps ------------------------------------------- */
  facts.push(...extractWorkflow(repo, parsed));

  /* --- documented command examples ------------------------------ */
  facts.push(...extractExamples(repo, parsed));

  /* --- install --------------------------------------------------- */
  const install = extractInstall(repo, parsed);
  if (install.fact) facts.push(install.fact);

  /* --- license --------------------------------------------------- */
  if (repo.openSourceLicense) {
    facts.push(
      fact(
        repo,
        "license",
        `The GitHub API reports the ${repo.openSourceLicense} license.`,
        `it is released under the ${spdxToWords(repo.openSourceLicense)} license`,
        0.95,
        "api-field",
        "repo.license.spdx_id"
      )
    );
  } else if (repo.licenseSpdxId) {
    facts.push(
      fact(
        repo,
        "license",
        `The GitHub API reports a ${repo.licenseSpdxId} license.`,
        `it lists a ${repo.licenseSpdxId} license, so check the terms before you rely on it`,
        0.8,
        "api-field",
        "repo.license.spdx_id"
      )
    );
  }

  /* --- adoption -------------------------------------------------- */
  facts.push(
    fact(
      repo,
      "adoption",
      `The GitHub API reported ${repo.stargazers_count} stars and ${repo.forks_count} forks at capture time.`,
      `it has about ${formatCount(repo.stargazers_count)} stars on GitHub`,
      0.99,
      "api-field",
      "repo.stargazers_count"
    )
  );

  /* --- momentum (only with dated snapshots) ----------------------- */
  const previousStars = options.previousStars ?? null;
  const previousCapturedAt = options.previousCapturedAt ?? null;
  if (previousStars !== null && previousCapturedAt) {
    const elapsedDays = (Date.now() - Date.parse(previousCapturedAt)) / DAY;
    const delta = repo.stargazers_count - previousStars;
    if (Number.isFinite(elapsedDays) && elapsedDays >= 1 && delta > 0) {
      facts.push(
        fact(
          repo,
          "adoption",
          `Star count moved from ${previousStars} to ${repo.stargazers_count} between ${previousCapturedAt.slice(0, 10)} and ${repo.capturedAt.slice(0, 10)}.`,
          `it gained about ${formatCount(Math.round(delta / elapsedDays))} stars a day over the last ${Math.round(elapsedDays)} days`,
          0.85,
          "star-snapshot",
          `star-snapshots:${previousCapturedAt.slice(0, 10)}`
        )
      );
    }
  }

  /* --- activity --------------------------------------------------- */
  const pushedAt = repo.pushedAt ?? null;
  if (pushedAt) {
    const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(pushedAt)) / DAY));
    if (ageDays < 1) {
      facts.push(
        fact(
          repo,
          "activity",
          "The repository was pushed on the day it was captured.",
          "it was updated today",
          0.95,
          "api-field",
          "repo.pushed_at"
        )
      );
    } else if (ageDays <= 90) {
      facts.push(
        fact(
          repo,
          "activity",
          `The last push was ${ageDays} days before capture.`,
          `it was updated ${describeAge(ageDays)}`,
          0.95,
          "api-field",
          "repo.pushed_at"
        )
      );
    } else if (ageDays <= 545) {
      facts.push(
        fact(
          repo,
          "activity",
          `The last push was ${ageDays} days before capture.`,
          `the last commit landed ${describeAge(ageDays)}`,
          0.85,
          "api-field",
          "repo.pushed_at"
        )
      );
    }
  }

  /* --- release ---------------------------------------------------- */
  if (repo.latestRelease?.tag_name && repo.latestRelease.published_at) {
    const ageDays = Math.max(
      0,
      Math.round((Date.now() - Date.parse(repo.latestRelease.published_at)) / DAY)
    );
    facts.push(
      fact(
        repo,
        "release",
        `The latest GitHub release is ${repo.latestRelease.tag_name}, published ${ageDays} days before capture.`,
        `the latest tagged release is ${repo.latestRelease.tag_name}`,
        0.9,
        "release",
        "releases/latest"
      )
    );
  }

  /* --- requirements / hosting / cost ------------------------------ */
  const hosting = hostingFact(repo, parsed);
  if (hosting) facts.push(hosting);
  const cost = costFact(repo, parsed);
  if (cost) facts.push(cost);

  /* --- language ---------------------------------------------------- */
  if (repo.primaryLanguage) {
    facts.push(
      fact(
        repo,
        "language",
        `The repository's primary language is ${repo.primaryLanguage}.`,
        `it is written in ${repo.primaryLanguage}`,
        0.95,
        "api-field",
        "repo.language"
      )
    );
  }

  return {
    repositoryNodeId: repo.nodeId,
    fullName: repo.full_name,
    capturedAt: repo.capturedAt,
    facts,
  };
}

export function narratableFacts(ledger: FactLedger): Fact[] {
  return ledger.facts.filter(fact => fact.confidence >= FACT_CONFIDENCE_THRESHOLD);
}

export function factsOfKind(ledger: FactLedger, kind: FactKind): Fact[] {
  return narratableFacts(ledger).filter(fact => fact.kind === kind);
}

export function formatCount(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))} thousand`;
  }
  return String(value);
}

function describeAge(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function spdxToWords(spdx: string): string {
  switch (spdx) {
    case "MIT":
      return "MIT";
    case "Apache-2.0":
      return "Apache 2 point 0";
    case "BSD-3-Clause":
      return "three clause BSD";
    case "BSD-2-Clause":
      return "two clause BSD";
    case "GPL-3.0":
      return "GPL three";
    case "AGPL-3.0":
      return "AGPL three";
    case "MPL-2.0":
      return "Mozilla Public License 2 point 0";
    case "Unlicense":
      return "Unlicense";
    default:
      return spdx.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
}

export function unsupportedClaims(
  segments: { spokenText: string; factIds: string[] }[],
  ledger: FactLedger
): string[] {
  const known = new Set(ledger.facts.map(item => item.id));
  const problems: string[] = [];
  for (const segment of segments) {
    if (!segment.factIds.length) {
      problems.push(`segment "${truncate(segment.spokenText)}" cites no fact`);
      continue;
    }
    for (const id of segment.factIds) {
      if (!known.has(id)) {
        problems.push(`segment "${truncate(segment.spokenText)}" cites unknown fact "${id}"`);
      }
    }
  }
  return problems;
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}




