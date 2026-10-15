import path from "node:path";

export const ROOT = process.cwd();
export const OUTPUT_DIR = path.join(ROOT, "output");
export const TEMP_DIR = path.join(ROOT, "temp");
export const MAX_SECONDS = 20;
export const VIEWPORT = { width: 540, height: 960 };
export const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222";
export const FPS = 60;
export const CAPTURE_FPS = 10;
