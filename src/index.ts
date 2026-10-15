import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OUTPUT_DIR, TEMP_DIR, MAX_SECONDS } from "./config.js";
import { discoverRepos, getReadme, getRepo, parseRepoUrl } from "./github.js";
import { makeScript, buildRepoFacts } from "./script.js";
import { makeVoice } from "./voice.js";
import { captureRepository } from "./browser-capture.js";
import { generateCaptionLayers } from "./caption-overlay.js";
import { renderVideo } from "./render.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const discoverMode = args.includes("--discover");
  const repoIndex = args.indexOf("--repo");
  const repoArg = repoIndex >= 0 ? args[repoIndex + 1] : undefined;

  if (!discoverMode && !repoArg) {
    console.log("Commands:");
    console.log("  npm run start -- --repo https://github.com/owner/repo");
    console.log("  npm run start -- --discover");
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(TEMP_DIR, { recursive: true });

  const historyPath = path.join(OUTPUT_DIR, "showcase-history.json");
  let history: { fullName: string; at: string }[] = [];
  try {
    history = JSON.parse(await fs.readFile(historyPath, "utf8")) as { fullName: string; at: string }[];
  } catch {
    history = [];
  }
  const used = new Set(history.map(item => item.fullName));

  let fullName: string;
  if (discoverMode) {
    const candidates = (await discoverRepos(30)).filter(repo => !used.has(repo.full_name));
    if (!candidates.length) throw new Error("No unused repository candidates found. Try again later or provide --repo.");
    console.log("\\nRepository candidates:");
    candidates.slice(0, 10).forEach((r, i) => console.log(`${i + 1}. ${r.full_name} (${r.stargazers_count} stars) �?" ${r.description}`));
    fullName = candidates[0].full_name;
    console.log(`\\nAuto-selected: ${fullName}`);
  } else {
    fullName = parseRepoUrl(repoArg!);
  }

  console.log(`\nStage 1/5: Fetching ${fullName}...`);
  const repo = await getRepo(fullName);
  const readme = await getReadme(fullName);
  if (readme.trim().length < 80) throw new Error("README is too short for a useful showcase.");

  const facts = buildRepoFacts(repo, readme);
  const narration = makeScript(repo, readme);
  const slug = fullName.replace("/", "-").replace(/[^A-Za-z0-9._-]/g, "");
  const workDir = path.join(TEMP_DIR, slug);
  const framesDir = path.join(workDir, "frames");
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const wav = path.join(workDir, "voice.wav");
  const captionsDir = path.join(workDir, "captions");
  await fs.mkdir(captionsDir, { recursive: true });
  const captionsManifest = path.join(captionsDir, "layers.json");
  const captionsConcat = path.join(captionsDir, "concat.txt");
  const narrationPath = path.join(workDir, "narration.txt");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const output = path.join(OUTPUT_DIR, `${slug}-${date}.mp4`);

  await fs.writeFile(narrationPath, narration, "utf8");
  console.log(`\nRepository facts:`);
  console.log(`Stars: ${facts.stars}`);
  console.log(`Language: ${facts.language}`);
  console.log(`License: ${facts.license}`);
  console.log(`Install: ${facts.install}`);
  console.log(`Hosting: ${facts.hosting}`);
  console.log(`Cost: ${facts.cost}`);
  console.log(`\nVoiceover:\n${narration}\n`);
  console.log("Stage 2/5: Generating offline voice...");
  await makeVoice(narration, wav);

  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", wav
  ]);
  const audioSeconds = Math.max(5, Math.min(MAX_SECONDS, Number(stdout.trim()) || 20));

  console.log("Stage 3/5: Capturing the GitHub page with scrolling...");
  await captureRepository(`https://github.com/${fullName}`, framesDir, Math.ceil(audioSeconds), {
    stars: facts.stars, license: facts.license, language: facts.language
  });

  console.log("Stage 4/5: Creating captions and rendering MP4...");
  const layers = await generateCaptionLayers(narration, audioSeconds, captionsDir);
  await fs.writeFile(captionsManifest, JSON.stringify(layers, null, 2), "utf8");
  const concatLines = layers.map(layer => `file '${layer.file.replace(/\\/g, "/")}'\nduration ${Math.max(0.05, layer.end - layer.start)}`).join("\n") + "\n";
  await fs.writeFile(captionsConcat, concatLines, "utf8");
  await renderVideo(framesDir, wav, captionsConcat, output);

  const ffprobe = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration",
    "-of", "json", output
  ]);
  const info = JSON.parse(ffprobe.stdout) as { streams?: { codec_type: string; width?: number; height?: number }[]; format?: { duration?: string } };
  const video = info.streams?.find(stream => stream.codec_type === "video");
  const audio = info.streams?.find(stream => stream.codec_type === "audio");
  const duration = Number(info.format?.duration ?? 0);
  if (!video || !audio || video.width !== 1080 || video.height !== 1920 || duration <= 0 || duration > 30) {
    throw new Error("Rendered video failed automated validation.");
  }
  console.log("Stage 5/5: Validated final MP4.");

  history.push({ fullName, at: new Date().toISOString() });
  await fs.writeFile(historyPath, JSON.stringify(history, null, 2), "utf8");
  await fs.writeFile(path.join(OUTPUT_DIR, `${slug}.json`), JSON.stringify({
    fullName,
    output,
    narration,
    facts,
    audioSeconds,
    createdAt: new Date().toISOString()
  }, null, 2), "utf8");

  console.log(`\\nFinished.\\nVideo: ${output}\\nNarration: ${narrationPath}`);
}

main().catch(error => {
  console.error("\nPipeline failed:", error instanceof Error ? error.message : error);
  console.error("Check that Chrome remote debugging, FFmpeg, ffprobe, and espeak-ng are installed and available.");
  process.exitCode = 1;
});
