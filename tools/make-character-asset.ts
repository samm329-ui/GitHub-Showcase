import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";

/**
 * Turn a character illustration shot on a flat white background into a
 * transparent PNG suitable for the showcase composition.
 *
 * The background is removed with a flood fill from the image border, so white
 * areas enclosed by the character (shirt, eye highlights) are preserved. A
 * short feather pass removes the white anti-aliasing fringe without eating the
 * dark outlines.
 */

const input = path.join(process.cwd(), "Character", "image.png");
const output = path.join(process.cwd(), "assets", "character.png");

const image = await loadImage(input);
const canvas = createCanvas(image.width, image.height);
const ctx = canvas.getContext("2d");
ctx.drawImage(image, 0, 0);

const { width, height } = canvas;
const pixels = ctx.getImageData(0, 0, width, height);
const data = pixels.data;

const isBackground = (index: number): boolean => {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min > 226 && max - min < 18;
};

const visited = new Uint8Array(width * height);
const stack: number[] = [];
const push = (x: number, y: number) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const pixel = y * width + x;
  if (visited[pixel]) return;
  visited[pixel] = 1;
  if (!isBackground(pixel * 4)) return;
  stack.push(pixel);
};

for (let x = 0; x < width; x += 1) {
  push(x, 0);
  push(x, height - 1);
}
for (let y = 0; y < height; y += 1) {
  push(0, y);
  push(width - 1, y);
}

while (stack.length > 0) {
  const pixel = stack.pop()!;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  data[pixel * 4 + 3] = 0;
  push(x - 1, y);
  push(x + 1, y);
  push(x, y - 1);
  push(x, y + 1);
}

/**
 * Feather light pixels that touch transparency, preserving dark outlines.
 * Two rings are processed so the white anti-aliasing rim disappears on a dark
 * background instead of leaving a halo.
 */
const alphaAt = (x: number, y: number) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return data[(y * width + x) * 4 + 3];
};

const NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

for (let pass = 0; pass < 2; pass += 1) {
  const feather: { index: number; alpha: number }[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] === 0) continue;
      const touchesBackground = NEIGHBOURS.some(
        ([dx, dy]) => alphaAt(x + dx, y + dy) === 0
      );
      if (!touchesBackground) continue;
      const min = Math.min(data[index], data[index + 1], data[index + 2]);
      if (min <= 150) continue;
      const alpha = Math.round(255 * Math.max(0, (255 - min) / 105));
      feather.push({ index, alpha });
    }
  }
  for (const { index, alpha } of feather) {
    data[index + 3] = Math.min(data[index + 3], alpha);
  }
}

/** Crop to the visible alpha bounds with a little breathing room. */
let minX = width;
let minY = height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (data[(y * width + x) * 4 + 3] < 8) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
}

const pad = 8;
minX = Math.max(0, minX - pad);
minY = Math.max(0, minY - pad);
maxX = Math.min(width - 1, maxX + pad);
maxY = Math.min(height - 1, maxY + pad);

ctx.putImageData(pixels, 0, 0);

const cropped = createCanvas(maxX - minX + 1, maxY - minY + 1);
cropped
  .getContext("2d")
  .drawImage(canvas, minX, minY, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, cropped.toBuffer("image/png"));
console.log(
  `wrote ${path.relative(process.cwd(), output)} (${cropped.width}x${cropped.height})`
);
