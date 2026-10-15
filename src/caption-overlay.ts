import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "canvas";

export type CaptionLayer = {
  start: number;
  end: number;
  file: string;
};

export async function generateCaptionLayers(
  narration: string,
  durationSeconds: number,
  outputDir: string
): Promise<CaptionLayer[]> {
  await fs.mkdir(outputDir, { recursive: true });
  const words = narration.trim().split(/\s+/).filter(Boolean);
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += 4) groups.push(words.slice(i, i + 4).join(" "));
  const duration = Math.max(1, Math.min(durationSeconds, 30));
  const weights = groups.map(group => Math.max(8, group.replace(/\s/g, "").length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = 0;
  const layers: CaptionLayer[] = [];
  let index = 0;

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const line = groups[groupIndex];
    const groupWords = line.split(/\s+/);
    const segmentStart = cursor;
    const segment = duration * (weights[groupIndex] / totalWeight);
    cursor = Math.min(duration, segmentStart + segment);
    const segmentEnd = groupIndex === groups.length - 1 ? duration : Math.min(duration, segmentStart + segment);
    const step = (segmentEnd - segmentStart) / Math.max(1, groupWords.length);

    const canvas = createCanvas(1080, 1920);
    const ctx = canvas.getContext("2d");
    const font = "bold 58px Arial";
    ctx.font = font;
    const space = ctx.measureText(" ").width;
    const wordWidths = groupWords.map(word => ctx.measureText(word.toUpperCase()).width);
    const totalWidth = wordWidths.reduce((sum, width) => sum + width, 0) + space * Math.max(0, groupWords.length - 1);
    const startX = (1080 - totalWidth) / 2;
    const baselineY = 1920 - 250;
    const positions: number[] = [];
    let x = startX;
    for (let i = 0; i < groupWords.length; i += 1) {
      positions.push(x);
      x += wordWidths[i] + space;
    }

    for (let wordIndex = 0; wordIndex < groupWords.length; wordIndex += 1) {
      const activeStart = Math.min(segmentEnd, segmentStart + step * wordIndex);
      const activeEnd = Math.min(segmentEnd, segmentStart + step * (wordIndex + 1));
      const layerCanvas = createCanvas(1080, 1920);
      const layerContext = layerCanvas.getContext("2d");
      layerContext.font = font;
      layerContext.textBaseline = "alphabetic";

      // Base line: white caption text.
      layerContext.fillStyle = "#FFFFFF";
      for (let i = 0; i < groupWords.length; i += 1) {
        layerContext.fillText(groupWords[i].toUpperCase(), positions[i], baselineY);
      }

      // Active word: lemon-yellow box with black text.
      const activeWord = groupWords[wordIndex].toUpperCase();
      const activeWidth = wordWidths[wordIndex];
      const padX = 12;
      const padY = 10;
      const boxX = positions[wordIndex] - padX;
      const boxY = baselineY - 58 - padY + 6;
      const boxWidth = activeWidth + padX * 2;
      const boxHeight = 58 + padY * 2;
      layerContext.fillStyle = "#F5E94B";
      roundRect(layerContext, boxX, boxY, boxWidth, boxHeight, 8);
      layerContext.fill();
      layerContext.fillStyle = "#000000";
      layerContext.fillText(activeWord, positions[wordIndex], baselineY);

      const filePath = path.join(outputDir, `caption-${index}.png`);
      await fs.writeFile(filePath, layerCanvas.toBuffer("image/png"));
      layers.push({ start: activeStart, end: activeEnd, file: filePath });
      index += 1;
    }
  }

  if (layers.length === 0) {
    return [];
  }
  return layers;
}

function roundRect(context: any, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}
