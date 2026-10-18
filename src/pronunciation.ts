/**
 * Pronunciation dictionary.
 *
 * Display text keeps the correct spelling ("Next.js", "npx", "CLI"). Spoken
 * text uses a form a TTS model can actually pronounce. The mapping is
 * explicit and exact-match: a blind global substitution would corrupt
 * unrelated words.
 */

export type PronunciationEntry = {
  display: string;
  spoken: string;
  matchMode: "exact" | "case-insensitive";
};

const EXACT: PronunciationEntry[] = [
  { display: "Next.js", spoken: "Next dot J S", matchMode: "exact" },
  { display: "Nuxt.js", spoken: "Nuxt dot J S", matchMode: "exact" },
  { display: "Vue.js", spoken: "Vue dot J S", matchMode: "exact" },
  { display: "Node.js", spoken: "Node dot J S", matchMode: "exact" },
  { display: "Deno.js", spoken: "Deno dot J S", matchMode: "exact" },
  { display: "Three.js", spoken: "Three dot J S", matchMode: "exact" },
  { display: "Docker", spoken: "Docker", matchMode: "exact" },
  { display: "Postgres", spoken: "Postgres", matchMode: "exact" },
  { display: "SQLite", spoken: "S Q Lite", matchMode: "exact" },
  { display: "SQL", spoken: "S Q L", matchMode: "exact" },
  { display: "HTTP", spoken: "H T T P", matchMode: "exact" },
  { display: "JSON", spoken: "J S O N", matchMode: "exact" },
  { display: "YAML", spoken: "Y A M L", matchMode: "exact" },
  { display: "CLI", spoken: "C L I", matchMode: "exact" },
  { display: "GPU", spoken: "G P U", matchMode: "exact" },
  { display: "CPU", spoken: "C P U", matchMode: "exact" },
  { display: "API", spoken: "A P I", matchMode: "exact" },
  { display: "SDK", spoken: "S D K", matchMode: "exact" },
  { display: "TUI", spoken: "T U I", matchMode: "exact" },
  { display: "SSR", spoken: "S S R", matchMode: "exact" },
  { display: "TLS", spoken: "T L S", matchMode: "exact" },
  { display: "SSH", spoken: "S S H", matchMode: "exact" },
  { display: "UI", spoken: "U I", matchMode: "exact" },
  { display: "URL", spoken: "U R L", matchMode: "exact" },
  { display: "CPU-only", spoken: "CPU only", matchMode: "exact" },
  { display: "MIT license", spoken: "M I T license", matchMode: "case-insensitive" },
  { display: "Apache 2.0", spoken: "Apache two point zero", matchMode: "exact" },
  { display: "GPL", spoken: "G P L", matchMode: "exact" },
  { display: "AGPL", spoken: "A G P L", matchMode: "exact" },
  { display: "MPL 2.0", spoken: "M P L two point zero", matchMode: "exact" },
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
  { display: "FFI", spoken: "F F I", matchMode: "exact" },
  { display: "PEP 8", spoken: "P E P eight", matchMode: "exact" },
];

/** Longest-first so `Node.js` wins over a hypothetical `js` entry. */
const SORTED = [...EXACT].sort((a, b) => b.display.length - a.display.length);

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Rewrite text for speech without touching the on-screen spelling.
 * Replacement is whole-token so `Go` inside `Google` is never rewritten.
 */
export function toSpoken(text: string): string {
  let spoken = text;
  for (const entry of SORTED) {
    const pattern =
      entry.matchMode === "exact"
        ? new RegExp(`(?<![\\w])${entry.display.replace(ESCAPE, "\\$&")}(?![\\w])`, "g")
        : new RegExp(
            `(?<![\\w])${entry.display.replace(ESCAPE, "\\$&")}(?![\\w])`,
            "gi"
          );
    spoken = spoken.replace(pattern, entry.spoken);
  }
  return spoken;
}

/** Exposed so tests can assert the dictionary has no duplicate keys. */
export function pronunciationEntries(): readonly PronunciationEntry[] {
  return EXACT;
}