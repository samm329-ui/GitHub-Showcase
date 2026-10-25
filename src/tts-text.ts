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
      /(?:(--version|-v\b|version\s+v?|v\.)\s*)?(?:(\b|\B)(v)?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?(?:[-+]([0-9A-Za-z][0-9A-Za-z.-]*))?\b)/gi,
      (match, leadWord: string | undefined, boundary: string, prefix: string | undefined, major: string, minor: string, patch?: string, suffix?: string) => {
        const hasLead = Boolean(leadWord && leadWord.trim());
        const parts = [major, minor, patch].filter((part): part is string => Boolean(part));
        const spoken = parts.map(numberWords).join(" point ");
        const isThreePart = Boolean(patch);
        const hasV = Boolean(prefix && prefix.toLowerCase() === "v");
        const lead = hasLead || isThreePart || hasV ? "version " : "";
        const tail = suffix ? ` ${suffix.replace(/[._-]+/g, " ")}` : "";
        return `${lead}${spoken}${tail}`;
      }
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
 * Remove duplicate consecutive words or acronyms caused by symbols, punctuation,
 * or Markdown cleaning (e.g. "API API", "version version", "admin admin").
 */
export function deduplicateSpokenWords(text: string): string {
  // Deduplicate spelled out acronyms like 'A P I A P I'
  let result = text.replace(/\b([A-Z](?:\s+[A-Z])+)\s+\1\b/g, "$1");
  // Deduplicate spelled out acronym followed/preceded by word e.g. 'A P I api' or 'api A P I'
  result = result.replace(/\b([A-Z](?:\s+[A-Z])+)\s+([a-zA-Z]+)\b/g, (m, acronym, word) => {
    if (acronym.replace(/\s+/g, "").toLowerCase() === word.toLowerCase()) return acronym;
    return m;
  });
  result = result.replace(/\b([a-zA-Z]+)\s+([A-Z](?:\s+[A-Z])+)\b/g, (m, word, acronym) => {
    if (word.toLowerCase() === acronym.replace(/\s+/g, "").toLowerCase()) return acronym;
    return m;
  });
  // Deduplicate identical words (case-insensitive) e.g. 'version version', 'admin admin', 'the the'
  // Preserving "plus plus" for C plus plus
  result = result.replace(/\b([a-zA-Z]{2,})\s+\1\b/gi, (m, word) => {
    if (word.toLowerCase() === "plus") return m;
    return word;
  });
  return result;
}

/**
 * Clean and normalise authored narration for Kokoro. Caption text must be
 * produced separately and never passed through this function.
 */
export function prepareTtsText(input: string): string {
  let text = input;
  // Emoji and pictographs are not speakable; drop them before any other work.
  text = text.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, " ");

  // Drop parenthetical URL route paths like (/admin/) or (/api/v1/)
  // which otherwise get stripped of slashes and cause duplicate speech ("API api v1", "admin admin").
  text = text.replace(/\(\s*\/[a-zA-Z0-9_./-]+\s*\)/g, " ");

  // Clean owner/repo where owner and repo are identical across slash (e.g. "Opendray/opendray" -> "Opendray")
  text = text.replace(/\b([a-zA-Z0-9_-]+)\/(\1)\b/gi, "$1");

  // Collapse duplicate words across slash or dash, e.g. "API/API" or "API-API"
  text = text.replace(/\b([a-zA-Z0-9]+)[\s/\\-]+(\1)\b/gi, "$1");

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
    .replace(/\bwww\.\S+/gi, " ");

  // Protect programming languages with symbols before general punctuation stripping
  text = text.replace(/(?<![A-Za-z0-9])C#(?![\w#])/g, "C sharp");
  text = text.replace(/(?<![A-Za-z0-9])C\+\+(?![\w+])/g, "C plus plus");

  // Rank numbers, issue numbers and social hashtags:
  // #1 tool / #1 on GitHub -> number one
  text = text.replace(/(?<!\w)#1(?!\d)/g, "number one");
  // #2 through #9
  text = text.replace(/(?<!\w)#([2-9])(?!\d)/g, (_m, d: string) => `number ${numberWords(d)}`);
  // GitHub issue / PR numbers (#123, #45)
  text = text.replace(/(?<!\w)#(\d{2,})/g, (_m, d: string) => `issue ${numberWords(d)}`);
  // Social / topic hashtags like #hashtag, #trending, #ai, #dev
  text = text.replace(/(?<!\w)#([a-zA-Z][a-zA-Z0-9_-]*)/g, "hashtag $1");
  // Clean any remaining bare hashes, tildes, carets
  text = text.replace(/[#~^]/g, " ");

  // Keep apostrophes, hyphens and sentence punctuation; normalise the rest.
  text = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2014\u2013]/g, ", ")
    .replace(/\u2026/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  // Times such as 12:30 should not keep a colon that a regex might read as
  // punctuation or that a voice may pronounce oddly.
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, "$1 $2");
  // Colons are not spoken as a separate word; remove them so Kokoro does not
  // pronounce "colon".
  text = text.replace(/:/g, " ");

  text = speakCommands(text);
  text = speakDates(text);
  text = speakNumbers(text);

  // Pluses: 100+ -> one hundred plus, 50+ -> fifty plus
  text = text.replace(/(\d+)\+/g, "$1 plus");

  // CLI double dashes e.g. --version, --port, --help
  text = text.replace(/--([a-zA-Z][a-zA-Z0-9_-]*)/g, "$1");

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

  // The pronunciation dictionary is the single source of truth for
  // names, acronyms and product terms.
  text = toSpoken(text);

  // Deduplicate consecutive identical words or acronyms (e.g. "version version", "API API")
  return deduplicateSpokenWords(text);
}
