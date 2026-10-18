import fs from "node:fs/promises";
import type { CaptionPhrase } from "./types.js";
import { CAPTION_STYLE } from "./caption-overlay.js";

/**
 * Optional ASS export of the caption timeline.
 *
 * Useful for platforms that re-encode the MP4 and want burn-in subtitles, and
 * for debugging what the renderer was told to show. Timings come from measured
 * audio (see `timeline.ts`), never from a hard-coded 30 second window.
 */

const BGR = (hex: string): string => {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [b, g, r]
    .map(value => value.toString(16).padStart(2, "0").toUpperCase())
    .join("");
};

export function writeAssFromCaptions(
  captions: CaptionPhrase[],
  outputPath: string,
  options: { width?: number; height?: number } = {}
): Promise<void> {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const primary = `&H00${BGR(CAPTION_STYLE.color)}`;
  const secondary = `&H00${BGR(CAPTION_STYLE.highlightColor)}`;

  const header = [
    "[Script Info]",
    "Title: GitHub Showcase",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,Inter,${CAPTION_STYLE.fontSizePx},${primary},${secondary},&H00000000,&H64000000,-1,0,0,0,100,100,${CAPTION_STYLE.letterSpacingPx},0,1,0,0,2,90,90,${CAPTION_STYLE.bottomInsetPx + CAPTION_STYLE.paddingPx},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "",
  ];

  const dialogues = captions.map(caption => {
    const text = renderAssText(caption);
    return `Dialogue: 0,${assTime(caption.startMs)},${assTime(caption.endMs)},Caption,,0,0,0,,${text}`;
  });

  return fs.writeFile(outputPath, [...header, ...dialogues, ""].join("\n"), "utf8");
}

function renderAssText(caption: CaptionPhrase): string {
  const highlightSet = new Set(caption.highlights.map(word => word.toLowerCase()));
  return caption.text
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      const clean = word.replace(/[^\w.+#-]/g, "");
      return highlightSet.has(clean.toLowerCase())
        ? `{\\c&H29D6FF&}${word.toUpperCase()}{\\c&HFFFFFF&}`
        : word.toUpperCase();
    })
    .join("\\N")
    .replace(/^/, "");
}

function assTime(milliseconds: number): string {
  const totalCentiseconds = Math.max(0, Math.round(milliseconds / 10));
  const cs = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Legacy entry point: kept so older callers keep working. */
export async function writeAss(
  narration: string,
  durationSeconds: number,
  outputPath: string,
  highlightWords: string[] = []
): Promise<void> {
  const phrases: CaptionPhrase[] = narration
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .map((text, index) => ({
      index,
      startMs: (durationSeconds * 1000 * index) / Math.max(1, narration.trim().split(/(?<=[.!?])\s+/).length),
      endMs: (durationSeconds * 1000 * (index + 1)) / Math.max(1, narration.trim().split(/(?<=[.!?])\s+/).length),
      text,
      highlights: highlightWords,
      segmentId: `legacy-${index}`,
    }));
  await writeAssFromCaptions(phrases, outputPath);
}