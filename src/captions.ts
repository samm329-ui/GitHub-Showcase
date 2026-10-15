import fs from "node:fs/promises";

export async function writeAss(
  narration: string,
  durationSeconds: number,
  outputPath: string,
  highlightWords: string[] = []
): Promise<void> {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += 4) {
    groups.push(words.slice(i, i + 4).join(" "));
  }

  const duration = Math.max(1, Math.min(durationSeconds, 30));
  const weights = groups.map(group => Math.max(8, group.replace(/\s/g, "").length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const highlightSet = new Set(highlightWords.map(word => word.toLowerCase().replace(/[^a-z0-9-]/g, "")));
  let cursor = 0;

  const header = [
    "[Script Info]",
    "Title: GitHub Showcase",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,Arial,62,&H00FFFFFF,&H00F5E94B,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,170,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ""
  ];

  const dialogues = groups.map((group, index) => {
    const start = cursor;
    const segment = duration * (weights[index] / totalWeight);
    cursor = Math.min(duration, start + segment);
    const end = index === groups.length - 1 ? duration : Math.min(duration, start + segment);
    const text = group
      .split(/\s+/)
      .map(word => {
        const key = word.toLowerCase().replace(/[^a-z0-9-]/g, "");
        return highlightSet.has(key)
          ? `{\\c&H4BE9F5&}${word.toUpperCase()}{\\c&HFFFFFF&}`
          : word.toUpperCase();
      })
      .join(" ");
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`;
  });

  await fs.writeFile(outputPath, [...header, ...dialogues, ""].join("\n"), "utf8");
}

function assTime(seconds: number): string {
  const cs = Math.floor((seconds % 1) * 100);
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
