/**
 * Long-form captions — forced word alignment in, kinetic ASS captions out.
 *
 * Pipeline:
 *   alignment words (ms) → phrase grouping (2–5 words, ≤2 lines)
 *   → deterministic style preset assignment (≈55/20/15/10 distribution)
 *   → ASS burn-in track (fontsdir = assets/shared/fonts, Inter/Roboto Mono)
 *   → .srt sidecar
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AlignedWord } from "../channels/news/types.js";
import type { AlignedCaption } from "./types.js";
import { CAPTION, LONGFORM, TOKENS } from "./config.js";

export type PhraseGroup = {
  startMs: number;
  endMs: number;
  text: string;
  wordRange: [number, number];
  words: AlignedWord[];
};

const STRONG_CLAUSE = /[.!?…]["'”’)\]]?$/;
const CLAUSE_BREAK = /[,;:]["'”’)\]]?$/;

/** Group aligned words into readable phrase captions. */
export function groupIntoPhrases(words: AlignedWord[], maxCharsPerLine = CAPTION.maxCharsPerLine, maxLines = CAPTION.maxLines): PhraseGroup[] {
  const phrases: PhraseGroup[] = [];
  if (words.length === 0) return phrases;
  const maxChars = maxCharsPerLine * maxLines;
  let current: AlignedWord[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map(w => w.word).join(" ").replace(/\s+/g, " ").trim();
    const startMs = current[0].startMs;
    const endMs = current[current.length - 1].endMs;
    phrases.push({ startMs, endMs: Math.max(endMs, startMs + 350), text, wordRange: [0, 0], words: [...current] });
    current = [];
    currentChars = 0;
  };

  for (const word of words) {
    const w = word?.word;
    if (!w) {
      continue; // defensive: skip malformed word entries rather than crash the caption pass
    }
    const len = w.length + 1;
    const wouldOverflow = currentChars + len > maxChars;
    const boundary =
      current.length >= 2 &&
      (STRONG_CLAUSE.test(w) || CLAUSE_BREAK.test(w) || current.length >= 5);
    if (wouldOverflow && current.length > 0) flush();
    current.push(word);
    currentChars += len;
    if (boundary) flush();
  }
  flush();

  // Merge a trailing 1-word phrase into the previous phrase when it fits.
  for (let i = phrases.length - 1; i >= 1; i -= 1) {
    const p = phrases[i];
    if (p.words.length === 1) {
      const prev = phrases[i - 1];
      if ((prev.text.length + 1 + p.text.length) <= maxChars) {
        prev.text += " " + p.text;
        prev.endMs = p.endMs;
        prev.words = [...prev.words, ...p.words];
        phrases.splice(i, 1);
      }
    }
  }
  return phrases;
}

/** Any caption word worth accenting by default (product names, code idents). */
function autoEmphasis(text: string): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const picked = new Set<string>();
  for (const raw of tokens) {
    const clean = raw.replace(/[^\w./-]/g, "");
    if (!clean) continue;
    const isProductName = /^[A-Z][A-Za-z0-9._-]{2,}$/.test(clean);
    const isAllCaps = /^[A-Z0-9]{2,}$/.test(clean);
    const isPath = /\//.test(clean) && /^[a-z0-9]/i.test(clean);
    if (isProductName || isAllCaps || isPath) picked.add(clean);
    if (picked.size >= 3) break;
  }
  return [...picked];
}

const STYLE_CYCLE: AlignedCaption["animation"][] = [
  // 55% static-focus (11), 20% slides (4), 15% pop (3), 10% reveal (2)
  "static-focus", "static-focus", "static-focus", "static-focus", "static-focus",
  "static-focus", "static-focus", "static-focus", "static-focus", "static-focus", "static-focus",
  "slide-up", "slide-up", "slide-up", "slide-side",
  "pop", "pop", "pop",
  "reveal", "highlight-bar",
];

/** Assign deterministic styles: single-word phrases get single-word; others cycle. */
export function assignStyles(phrases: PhraseGroup[]): AlignedCaption[] {
  return phrases.map((phrase, index) => {
    const words = phrase.words;
    const single = words.length === 1;
    const animation: AlignedCaption["animation"] = single ? "single-word" : STYLE_CYCLE[index % STYLE_CYCLE.length];
    return {
      index,
      startMs: phrase.startMs,
      endMs: phrase.endMs,
      text: phrase.text,
      highlights: autoEmphasis(phrase.text),
      segmentId: `phrase-${index + 1}`,
      wordTimings: words.map(w => ({
        text: w.word,
        startMs: w.startMs,
        endMs: w.endMs,
      })),
      animation,
      emphasisWords: autoEmphasis(phrase.text),
    };
  });
}

/* ------------------------------------------------------------------ */
/* ASS generation                                                      */
/* ------------------------------------------------------------------ */

const ASS_HEADER = (width: number, height: number) => `[Script Info]
Title: Octavia Long-form captions
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${TOKENS.fontDisplay},${CAPTION.fontSize},&H00FAF7F5,&H00B8A263,&H00221710,&H64000000,-1,0,0,0,100,100,-0.4,0,1,3,2,2,${LONGFORM.safeMarginX},${LONGFORM.safeMarginX},${LONGFORM.safeMarginBottom},1
Style: CapSmall,${TOKENS.fontBody},${CAPTION.supportFontSize},&H00C5B6AA,&H00B8A263,&H00221710,&H64000000,-1,0,0,0,100,100,0,0,1,2,1,2,${LONGFORM.safeMarginX},${LONGFORM.safeMarginX},${LONGFORM.safeMarginBottom},1
Style: CapBig,${TOKENS.fontDisplay},88,&H00FAF7F5,&H00B8A263,&H00221710,&H64000000,-1,0,0,0,100,100,0,0,1,4,3,2,${LONGFORM.safeMarginX},${LONGFORM.safeMarginX},${LONGFORM.safeMarginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const BGR = (hex: string): string => {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [b, g, r].map(v => v.toString(16).padStart(2, "0").toUpperCase()).join("");
};

const PRIMARY = BGR(TOKENS.textPrimary);
const ACCENT = BGR(TOKENS.accentBlue);
const YELLOW = BGR(TOKENS.accentYellow);

function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function assTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const cs = totalCs % 100;
  const totalS = Math.floor(totalCs / 100);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** \kf karaoke that sweeps the accent color across the emphasis words. */
function karaokeHighlight(caption: AlignedCaption): string {
  const emphasis = new Set(caption.emphasisWords.map(w => w.toLowerCase()));
  const timings = caption.wordTimings ?? [];
  return caption.text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      const clean = word.replace(/[^\w./-]/g, "").toLowerCase();
      const t = timings[i];
      const durCs = t ? Math.max(1, Math.round((t.endMs - t.startMs) / 10)) : 30;
      const colored = emphasis.has(clean) ? `{\\c&H${ACCENT}&}${escapeAss(word)}{\\c&H${PRIMARY}&}` : escapeAss(word);
      return `{\\kf${durCs}}${colored}`;
    })
    .join(" ");
}

function entryEffect(caption: AlignedCaption): string {
  switch (caption.animation) {
    case "slide-up":
      return "{\\move(960,1150,960,1070,30,160)\\fad(90,90)}";
    case "slide-side":
      return "{\\move(240,1080,960,1080,30,170)\\fad(80,80)}";
    case "pop":
      return "{\\fad(70,90)\\t(0,140,\\fscx118\\fscy118)\\t(140,260,\\fscx100\\fscy100)}";
    case "reveal":
      return "{\\fad(40,110)\\clip(0,0,0,0)\\t(0,0,\\clip(0,0,1920,1080))}";
    case "single-word":
      return "{\\fad(60,110)}";
    case "highlight-bar":
      return "{\\fad(80,90)\\3c&H" + ACCENT + "&\\bord6}";
    case "static-focus":
    default:
      return "{\\fad(120,120)}";
  }
}

export function captionsToAss(captions: AlignedCaption[], width = 1920, height = 1080): string {
  const events = captions.map(caption => {
    const style = caption.animation === "single-word" ? "CapBig" : "Cap";
    const prefix = entryEffect(caption);
    const body = karaokeHighlight(caption);
    return `Dialogue: 0,${assTime(caption.startMs)},${assTime(caption.endMs)},${style},,0,0,0,,${prefix}${body}`;
  });
  return [ASS_HEADER(width, height), ...events, ""].join("\n");
}

export function captionsToSrt(captions: AlignedCaption[]): string {
  const stamp = (ms: number) => {
    const total = Math.max(0, Math.round(ms));
    const h = Math.floor(total / 3_600_000);
    const m = Math.floor((total % 3_600_000) / 60_000);
    const s = Math.floor((total % 60_000) / 1000);
    const msPart = total % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(msPart).padStart(3, "0")}`;
  };
  return captions
    .map((caption, i) => `${i + 1}\n${stamp(caption.startMs)} --> ${stamp(caption.endMs)}\n${caption.text}\n`)
    .join("\n");
}

export async function writeCaptionArtifacts(
  captions: AlignedCaption[],
  dir: string
): Promise<{ assPath: string; srtPath: string }> {
  await fs.mkdir(dir, { recursive: true });
  const assPath = path.join(dir, "captions.ass");
  const srtPath = path.join(dir, "captions.srt");
  await fs.writeFile(assPath, captionsToAss(captions), "utf8");
  await fs.writeFile(srtPath, captionsToSrt(captions), "utf8");
  return { assPath, srtPath };
}
