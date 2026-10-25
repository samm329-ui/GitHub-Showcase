import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";

/**
 * Derivative presenter framing from the supplied transparent cut-out.
 *
 * The source artwork is a single full/half-body pose, so this tool does not
 * invent limbs that are not in the drawing. It creates a medium close-up that
 * keeps the face and hands in frame for the closing beat; the renderer swaps
 * framing and applies a role-specific lean so the character reads as a
 * presenter rather than a sticker. Additional pose PNGs can be supplied through
 * the SHOWCASE_CHARACTER_*_PNG environment variables without changing code.
 */

const input = path.join(process.cwd(), "assets", "character.png");
const closeOut = path.join(process.cwd(), "assets", "character-close.png");

const image = await loadImage(input);
const source = createCanvas(image.width, image.height);
const ctx = source.getContext("2d");
ctx.drawImage(image, 0, 0);

const pixels = ctx.getImageData(0, 0, source.width, source.height);
const data = pixels.data;

const top = 0;
const bottom = Math.floor(source.height * 0.85);
let minX = source.width;
let minY = bottom;
let maxX = 0;
let maxY = top;

for (let y = top; y < bottom; y += 1) {
  for (let x = 0; x < source.width; x += 1) {
    if (data[(y * source.width + x) * 4 + 3] < 8) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
}

if (maxX <= minX || maxY <= minY) {
  throw new Error("the source image has no visible alpha bounds");
}

const pad = 10;
minX = Math.max(0, minX - pad);
minY = Math.max(0, minY - pad);
maxX = Math.min(source.width - 1, maxX + pad);
maxY = Math.min(bottom - 1, maxY + pad);

const cropped = createCanvas(maxX - minX + 1, maxY - minY + 1);
cropped
  .getContext("2d")
  .drawImage(
    source,
    minX,
    minY,
    cropped.width,
    cropped.height,
    0,
    0,
    cropped.width,
    cropped.height
  );

await fs.mkdir(path.dirname(closeOut), { recursive: true });
await fs.writeFile(closeOut, cropped.toBuffer("image/png"));
console.log(
  `wrote ${path.relative(process.cwd(), closeOut)} (${cropped.width}x${cropped.height})`
);
