import { toSpoken } from "./pronunciation.js";

/**
 * Speech-only text preparation.
 *
 * The script compiler authors short, factual sentences. This module is the last
 * boundary before Kokoro: it removes anything that only makes sense on screen
 * (Markdown, code fences, URLs, raw command syntax) and turns numbers,
 * versions and symbols into words. It never touches `captionText`; captions
 * keep their original spelling and punctuation.
 *
 * This is deliberately deterministic and local. It is not a second script
 * generator: if a sentence is not already worth saying, cleaning it will not
 * make it worth saying.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];

const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety",
];

function numberWords(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 9999) return raw;
  if (value < 20) return SMALL_NUMBERS[value];
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const rest = value % 10;
    return rest === 0 ? TENS[tens] : `${TENS[tens]} ${SMALL_NUMBERS[rest]}`;
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    return rest === 0
      ? `${SMALL_NUMBERS[hundreds]} hundred`
      : `${SMALL_NUMBERS[hundreds]} hundred ${numberWords(String(rest))}`;
  }
  const thousands = Math.floor(value / 1000);
  const rest = value % 1000;
  return rest === 0
    ? `${numberWords(String(thousands))} thousand`
    : `${numberWords(String(thousands))} thousand ${numberWords(String(rest))}`;
}

function speakVersion(match: string, prefix: string, major: string, minor?: string, patch?: string, suffix?: string): string {
  const parts = [major, minor, patch].filter((part): part is string => Boolean(part));
  const spoken = parts.map(numberWords).join(" point ");
  const isThreePart = Boolean(patch);
  const hasVersionPrefix = prefix.toLowerCase() === "v";
  const lead = isThreePart || hasVersionPrefix ? "version " : "";
  const tail = suffix ? ` ${suffix.replace(/[._-]+/g, " ")}` : "";
  return `${lead}${spoken}${tail}`;
}

function speakDates(text: string): string {
  return text
    .replace(
      /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g,
      (_match, year: string, month: string, day: string) => {
        const monthName = MONTHS[Number(month) - 1];
        if (!monthName) return `${year}`;
        return `${monthName} ${Number(day)}, ${year}`;
      }
    )
    .replace(
      /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g,
      (_match, month: string, day: string, year: string) => {
        const monthName = MONTHS[Number(month) - 1];
        if (!monthName) return `${year}`;
        return `${monthName} ${Number(day)}, ${year}`;
      }
    );
}

function speakNumbers(text: string): string {
  return text
    .replace(
      /\b(v)?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?(?:[-+]([0-9A-Za-z][0-9A-Za-z.-]*))?\b/g,
      (match, prefix: string | undefined, major: string, minor: string, patch?: string, suffix?: string) =>
        speakVersion(match, prefix ?? "", major, minor, patch, suffix)
    )
    .replace(/\b(\d{1,4})\s*%/g, (_match, value: string) => `${numberWords(value)} percent`)
    .replace(/\b(\d{1,4})\b/g, (match, value: string) => numberWords(value));
}

function speakInlineCode(raw: string): string {
  const code = raw.trim();
  if (!code) return "";
  // A path or file name is not something to read character by character.
  if (/^[\w./\\-]+$/.test(code) && /[./\\]/.test(code)) return "";
  // Command-looking inline code is translated in speakCommandPatterns below
  // when it is on a line; inline instances keep safe words only.
  return code
    .replace(/["'`]/g, "")
    .replace(/[;{}[\]()<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function speakCommands(text: string): string {
  return text
    .replace(
      /\b(npm|pnpm|yarn|bun|cargo|pip3?|brew|go|npx)\s+(install|add|i|create-[\w.-]+)(?:\s+-{1,2}[\w-]+)*\s*([@\w./-]+)?/gi,
      (_match, manager: string, verb: string, packageName?: string) => {
        const isCreator = /^create-/i.test(verb);
        const spokenVerb =
          verb === "i" ? "install" : isCreator ? verb.replace(/-/g, " ") : verb;
        const command = `${manager} ${spokenVerb}`;
        const spokenPackage = (packageName ?? "")
          .replace(/^@/, "")
          .replace(/[-_/]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return `the ${command} command${
          spokenPackage && !isCreator ? ` for ${spokenPackage}` : ""
        }`;
      }
    );
}

/**
 * Clean and normalise authored narration for Kokoro. Caption text must be
 * produced separately and never passed through this function.
 */
export function prepareTtsText(input: string): string {
  let text = input;

  text = text
    // Fenced code, front matter and HTML are not speech.
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    // Images disappear; links keep their visible label.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    // Inline code is kept only when it contains safe words.
    .replace(/`([^`]+)`/g, (_match, code: string) => ` ${speakInlineCode(code)} `)
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    // Emphasis markers.
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/\*(.*?)\*/gs, "$1")
    .replace(/_(.*?)_/gs, "$1")
    .replace(/~~(.*?)~~/gs, "$1")
    // Table separators and raw Markdown punctuation.
    .replace(/\|/g, " ")
    .replace(/^\s*[-: ]+\s*$/gm, " ")
    // URLs and bare repository paths are not read aloud.
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    // A GitHub issue or PR number is meaningful; a bare hash is not.
    .replace(/#(\d+)/g, "issue $1")
    .replace(/[#~^]/g, " ")
    // Keep apostrophes, hyphens and sentence punctuation; normalise the rest.
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2014\u2013]/g, ", ")
    .replace(/\u2026/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  // Times such as 12:30 should not keep a colon that a regex might read as
  // punctuation or that a voice may pronounce oddly.
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, "$1 $2");

  text = speakCommands(text);
  text = speakDates(text);
  text = speakNumbers(text);

  text = text
    .replace(/\be\.g\./gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/\betc\./gi, "and so on")
    .replace(/\bvs\.?\b/gi, "versus")
    .replace(/\bw\//gi, "with ")
    .replace(/&/g, " and ")
    .replace(/@/g, " at ")
    .replace(/\+/g, " plus ")
    .replace(/[\u00D7\u2715]/g, " times ")
    .replace(/[\u2192\u279C]/g, " to ")
    .replace(/=>|->/g, " to ")
    .replace(/[=<>]/g, " ")
    .replace(/[$\u20AC\u00A3]/g, " ")
    .replace(/[\\/]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    // Only comma/semicolon/colon need a trailing space. Inserting one after a
    // period would split product names such as Next.js into "Next. js".
    .replace(/([,;:])(?=\S)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  // The existing pronunciation dictionary is the single source of truth for
  // names, acronyms and product terms. It is applied last so cleaning cannot
  // break a multi-word alias.
  return toSpoken(text);
}
