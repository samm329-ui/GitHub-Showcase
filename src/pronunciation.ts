/**
 * Pronunciation dictionary.
 *
 * Display text keeps the correct spelling ("Next.js", "npx", "CLI"). Spoken
 * text uses a form a TTS model can actually pronounce. The mapping is
 * explicit and whole-token: a blind global substitution would corrupt
 * unrelated words.
 *
 * Casing is never a reason for a mispronunciation: "CLI", "cli" and "Cli"
 * all become "C L I". Lowercase acronyms are the worst case for Kokoro —
 * it reads "cli" as "KLI" and "llm" as "LM". Entries are case-insensitive
 * by default. `matchMode: "exact"` is reserved for tokens that are also
 * ordinary English words (e.g. "rag", "go", "rest") and must only be
 * rewritten when the author actually wrote the acronym.
 */

export type PronunciationEntry = {
  display: string;
  spoken: string;
  matchMode: "exact" | "case-insensitive";
};

const EXACT: PronunciationEntry[] = [
  { display: "Next.js", spoken: "Next dot J S", matchMode: "case-insensitive" },
  { display: "Nuxt.js", spoken: "Nuxt dot J S", matchMode: "case-insensitive" },
  { display: "Vue.js", spoken: "Vue dot J S", matchMode: "case-insensitive" },
  { display: "Node.js", spoken: "Node dot J S", matchMode: "case-insensitive" },
  { display: "Deno.js", spoken: "Deno dot J S", matchMode: "case-insensitive" },
  { display: "Three.js", spoken: "Three dot J S", matchMode: "case-insensitive" },
  { display: "Docker", spoken: "Docker", matchMode: "exact" },
  { display: "Postgres", spoken: "Postgres", matchMode: "exact" },
  { display: "SQLite", spoken: "S Q Lite", matchMode: "case-insensitive" },
  { display: "SQL", spoken: "S Q L", matchMode: "case-insensitive" },
  { display: "HTTP", spoken: "H T T P", matchMode: "case-insensitive" },
  { display: "JSON", spoken: "J S O N", matchMode: "case-insensitive" },
  { display: "YAML", spoken: "Y A M L", matchMode: "case-insensitive" },
  { display: "CLI", spoken: "C L I", matchMode: "case-insensitive" },
  { display: "GPU", spoken: "G P U", matchMode: "case-insensitive" },
  { display: "CPU", spoken: "C P U", matchMode: "case-insensitive" },
  { display: "API", spoken: "A P I", matchMode: "case-insensitive" },
  { display: "SDK", spoken: "S D K", matchMode: "case-insensitive" },
  { display: "TUI", spoken: "T U I", matchMode: "case-insensitive" },
  { display: "SSR", spoken: "S S R", matchMode: "case-insensitive" },
  { display: "TLS", spoken: "T L S", matchMode: "case-insensitive" },
  { display: "SSH", spoken: "S S H", matchMode: "case-insensitive" },
  { display: "UI", spoken: "U I", matchMode: "case-insensitive" },
  { display: "URL", spoken: "U R L", matchMode: "case-insensitive" },
  { display: "CPU-only", spoken: "CPU only", matchMode: "case-insensitive" },
  { display: "MIT license", spoken: "M I T license", matchMode: "case-insensitive" },
  { display: "Apache 2.0", spoken: "Apache two point zero", matchMode: "exact" },
  { display: "GPL", spoken: "G P L", matchMode: "case-insensitive" },
  { display: "AGPL", spoken: "A G P L", matchMode: "case-insensitive" },
  { display: "MPL 2.0", spoken: "M P L two point zero", matchMode: "case-insensitive" },
  { display: "Rust", spoken: "Rust", matchMode: "exact" },
  { display: "Go", spoken: "Go", matchMode: "exact" },
  { display: "LangChain", spoken: "Lang Chain", matchMode: "exact" },
  { display: "PyTorch", spoken: "Pytorch", matchMode: "exact" },
  { display: "ffmpeg", spoken: "F F M P E G", matchMode: "case-insensitive" },
  { display: "npx", spoken: "n p x", matchMode: "case-insensitive" },
  { display: "npm", spoken: "n p m", matchMode: "case-insensitive" },
  { display: "pnpm", spoken: "p n p m", matchMode: "case-insensitive" },
  { display: "pip", spoken: "pip", matchMode: "case-insensitive" },
  { display: "JSONL", spoken: "J S O N L", matchMode: "case-insensitive" },
  { display: "GitHub Actions", spoken: "GitHub Actions", matchMode: "exact" },
  { display: "macOS", spoken: "Mac O S", matchMode: "exact" },
  { display: "Linux", spoken: "Linux", matchMode: "exact" },
  { display: "Windows", spoken: "Windows", matchMode: "exact" },
  { display: "PostgreSQL", spoken: "Postgres Q L", matchMode: "exact" },
  { display: "FFI", spoken: "F F I", matchMode: "case-insensitive" },
  { display: "PEP 8", spoken: "P E P eight", matchMode: "exact" },
  { display: "GitHub", spoken: "Git Hub", matchMode: "exact" },
  { display: "HTML", spoken: "H T M L", matchMode: "case-insensitive" },
  { display: "CSS", spoken: "C S S", matchMode: "case-insensitive" },
  { display: "HTTPS", spoken: "H T T P S", matchMode: "case-insensitive" },
  { display: "JS", spoken: "J S", matchMode: "case-insensitive" },
  { display: "TS", spoken: "T S", matchMode: "case-insensitive" },
  { display: "CI", spoken: "C I", matchMode: "case-insensitive" },
  { display: "CD", spoken: "C D", matchMode: "case-insensitive" },
  { display: "OS", spoken: "O S", matchMode: "case-insensitive" },
  { display: "iOS", spoken: "eye O S", matchMode: "exact" },
  { display: "IP", spoken: "I P", matchMode: "case-insensitive" },
  { display: "LLM", spoken: "L L M", matchMode: "case-insensitive" },
  { display: "vLLM", spoken: "V L L M", matchMode: "case-insensitive" },
  { display: "MCP", spoken: "M C P", matchMode: "case-insensitive" },
  { display: "RAG", spoken: "R A G", matchMode: "exact" },
  { display: "REST", spoken: "rest", matchMode: "exact" },
  { display: "gRPC", spoken: "G R P C", matchMode: "case-insensitive" },
  { display: "WASM", spoken: "W A S M", matchMode: "case-insensitive" },
  { display: "OAuth", spoken: "O Auth", matchMode: "exact" },
  { display: "JWT", spoken: "J W T", matchMode: "case-insensitive" },
  { display: "ORM", spoken: "O R M", matchMode: "case-insensitive" },
  { display: "TTS", spoken: "T T S", matchMode: "case-insensitive" },
  { display: "PDF", spoken: "P D F", matchMode: "case-insensitive" },
  { display: "CSV", spoken: "C S V", matchMode: "case-insensitive" },
  { display: "XML", spoken: "X M L", matchMode: "case-insensitive" },
  { display: "UUID", spoken: "U U I D", matchMode: "case-insensitive" },
  { display: "VLM", spoken: "V L M", matchMode: "case-insensitive" },
  { display: "DAW", spoken: "D A W", matchMode: "case-insensitive" },
  { display: "CTF", spoken: "C T F", matchMode: "case-insensitive" },
  { display: "OSINT", spoken: "O S I N T", matchMode: "case-insensitive" },
  { display: "MIDI", spoken: "M I D I", matchMode: "case-insensitive" },
  { display: "VST3", spoken: "V S T three", matchMode: "case-insensitive" },
  { display: "VST", spoken: "V S T", matchMode: "case-insensitive" },
  { display: "ASIO", spoken: "A S I O", matchMode: "case-insensitive" },
  { display: "STL", spoken: "S T L", matchMode: "case-insensitive" },
  { display: "CAD", spoken: "C A D", matchMode: "exact" },
  { display: "GUI", spoken: "G U I", matchMode: "case-insensitive" },
  { display: "C++", spoken: "C plus plus", matchMode: "case-insensitive" },
  { display: "C#", spoken: "C sharp", matchMode: "case-insensitive" },
  { display: "README", spoken: "read me", matchMode: "case-insensitive" },
  { display: "EMFILE", spoken: "em file", matchMode: "case-insensitive" },
  { display: "bunx", spoken: "bun X", matchMode: "case-insensitive" },
];

/** Longest-first so `Node.js` wins over a hypothetical `js` entry. */
const SORTED = [...EXACT].sort((a, b) => b.display.length - a.display.length);

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** A spoken form made only of separated capital letters, e.g. "L L M". */
const LETTER_SPELLING = /^(?:[A-Z] )*[A-Z]$/;

/**
 * Rewrite text for speech without touching the on-screen spelling.
 * Replacement is whole-token so `Go` inside `Google` is never rewritten.
 * Casing is ignored for acronym entries, and a plural acronym ("llms")
 * keeps its "s" as a separate spoken letter ("L L M s").
 */
export function toSpoken(text: string): string {
  let spoken = text;
  for (const entry of SORTED) {
    const core = entry.display.replace(ESCAPE, "\\$&");
    const pluralize = LETTER_SPELLING.test(entry.spoken);
    const source = `(?<![\\w])${core}${pluralize ? "(s)?" : ""}(?![\\w])`;
    const pattern = new RegExp(source, entry.matchMode === "exact" ? "g" : "gi");
    spoken = spoken.replace(pattern, (...args: unknown[]) => {
      const suffix = pluralize ? args[1] : undefined;
      return `${entry.spoken}${typeof suffix === "string" ? " s" : ""}`;
    });
  }
  return spoken;
}

/** Exposed so tests can assert the dictionary has no duplicate keys. */
export function pronunciationEntries(): readonly PronunciationEntry[] {
  return EXACT;
}
