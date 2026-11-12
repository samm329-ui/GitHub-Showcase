/**
 * Bundled fonts → inline `@font-face` CSS.
 *
 * The two channels style their scenes by family name (`Roboto`, `Inter`,
 * `Montserrat`, `Roboto Mono`). Family names only render consistently when
 * the font is installed — which no two operating systems agree on. The
 * pipeline therefore ships the exact latin subsets in `assets/shared/fonts/`
 * (both channels use them) and inlines them as data URIs into the generated
 * HTML: every render, on every OS, resolves the same glyphs.
 *
 * Missing files never break a render — the `@font-face` rule is simply
 * omitted and the CSS falls back to the system stack as before.
 */
import fs from "node:fs";
import path from "node:path";

type FontFaceSpec = {
  file: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
};

/** Mirrors `assets/shared/fonts/` — keep the two in sync when adding fonts. */
const FONT_FACES: FontFaceSpec[] = [
  { file: "roboto-latin-400-normal.woff2", family: "Roboto", weight: 400, style: "normal" },
  { file: "roboto-latin-700-normal.woff2", family: "Roboto", weight: 700, style: "normal" },
  { file: "roboto-latin-900-normal.woff2", family: "Roboto", weight: 900, style: "normal" },
  { file: "roboto-mono-latin-400-normal.woff2", family: "Roboto Mono", weight: 400, style: "normal" },
  { file: "inter-latin-700-normal.woff2", family: "Inter", weight: 700, style: "normal" },
  { file: "inter-latin-800-italic.woff2", family: "Inter", weight: 800, style: "italic" },
  { file: "inter-latin-900-normal.woff2", family: "Inter", weight: 900, style: "normal" },
  { file: "montserrat-latin-800-italic.woff2", family: "Montserrat", weight: 800, style: "italic" },
];

const fontDir = () => path.join(process.cwd(), "assets", "shared", "fonts");

let cachedCss: string | null = null;

/** `@font-face` declarations for every bundled font present, as inline data
 *  URIs. Computed once per process. */
export function bundledFontFaces(): string {
  if (cachedCss !== null) return cachedCss;
  const rules: string[] = [];
  for (const spec of FONT_FACES) {
    let base64: string;
    try {
      base64 = fs.readFileSync(path.join(fontDir(), spec.file)).toString("base64");
    } catch {
      continue; // missing fonts are optional; fall back to system stacks
    }
    rules.push(
      `@font-face{font-family:"${spec.family}";font-style:${spec.style};font-weight:${spec.weight};` +
        `font-display:block;src:url(data:font/woff2;base64,${base64}) format("woff2");}`
    );
  }
  cachedCss = rules.join("\n");
  return cachedCss;
}
