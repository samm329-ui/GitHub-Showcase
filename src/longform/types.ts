/**
 * Shared Long-form domain types. Contracts between stages; every stage reads
 * explicit objects and returns explicit objects.
 */
import type { CaptionPhrase } from "../types.js";
import type { AlignedWord } from "../channels/news/types.js";
import type { CameraKey } from "./camera.js";
export type { CameraKey } from "./camera.js";

/* ---------------- dataset reconciliation / selection ---------------- */

export type DatasetCandidate = {
  /** dataset/<channel>/<id>.json */
  recordId: string;
  /** Stable GitHub identity. */
  nodeId: string;
  fullName: string;
  htmlUrl: string | null;
  description: string | null;
  stars: number | null;
  forks: number | null;
  primaryLanguage: string | null;
  license: string | null;
  topics: string[];
  pushedAt: string | null;
  readmeChars: number;
  factCount: number;
  segmentCount: number;
  spokenWords: number;
  estimatedSeconds: number | null;
  styleVariant: string | null;
  /** Deterministic base quality 0..100 before diversity penalty. */
  baseScore: number;
  /** Why the record is or isn't usable. */
  issues: string[];
};

export type SelectionResult = {
  episodeId: string;
  candidates: DatasetCandidate[];
  /** Ranked strongest-first (rank 1 = strongest). Presentation = reverse. */
  ranked: Array<DatasetCandidate & { selectionScore: number; diversityPenalty: number }>;
  /** All five, in PRESENTATION order (rank 5 first … rank 1 last). */
  presentation: Array<DatasetCandidate & { rank: number; selectionScore: number }>;
};

/* ---------------- episodes / ledger ---------------- */

export type EpisodeStatus =
  | "created"
  | "selection-committed"
  | "script-ready"
  | "narration-ready"
  | "capture-ready"
  | "composition-ready"
  | "rendering"
  | "qa-pending"
  | "completed"
  | "failed";

export type EpisodeRecord = {
  episodeId: string;
  runId: string;
  status: EpisodeStatus;
  stage: string | null;
  repositoryCount: number;
  workDir: string | null;
  outputPath: string | null;
  error: string | null;
  errorStage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type EpisodeRepositoryRecord = {
  episodeId: string;
  nodeId: string;
  fullName: string;
  datasetRecordId: string;
  rank: number;
  selectionScore: number;
  selectedAt: string;
  usageStatus: "reserved" | "produced";
};

/* ---------------- master script ---------------- */

export type EvidencePacket = {
  nodeId: string;
  fullName: string;
  description: string | null;
  stars: number | null;
  forks: number | null;
  primaryLanguage: string | null;
  license: string | null;
  topics: string[];
  createdAt: string | null;
  pushedAt: string | null;
  latestRelease: { tag: string | null; name: string | null; publishedAt: string | null } | null;
  facts: Array<{ id: string; kind: string; semantic: string | undefined; claim: string; confidence: number }>;
  readmeExcerpt: string;
  readmeHeadings: string[];
  installCommand: string | null;
};

export type VisualTargetType = "overview" | "readme-section" | "install" | "code-file";

export type MasterSegment = {
  id: string;
  purpose: "identify" | "explain" | "feature" | "demo" | "install" | "caveat" | "summary" | "transition" | "cta";
  spokenText: string;
  captionText: string;
  factIds: string[];
  visualTarget: { type: VisualTargetType; detail: string };
  highlight: { enabled: boolean; targetText: string | null };
  mascot: { enabled: boolean; position: "bottom-right" | "bottom-left" | "right-middle" | "left-middle"; asset: "point" | "present" };
  pauseAfterMs: number;
};

export type MasterScript = {
  opening: { hookSpoken: string; digInSpoken: string };
  repositories: Array<{
    nodeId: string;
    fullName: string;
    presentationRank: number; // 5..1, in presentation order
    segments: MasterSegment[];
  }>;
  closing: { spokenText: string };
  estimatedWords: number;
};

/* ---------------- narration / alignment ---------------- */

export type NarrationResult = {
  narrationWav: string;
  transcriptPath: string;
  durationMs: number;
  sampleRate: number;
  segmentsJsonPath: string;
  segmentCount: number;
  spokenWords: number;
};

export type AlignmentResult = {
  outPath: string;
  words: AlignedWord[];
  coverage: number;
  monotonic: boolean;
  alignmentSource: string;
  modelVersion: string | null;
  tokensTotal: number;
  tokensAligned: number;
  missingWords: string[];
};

export type AlignedCaption = CaptionPhrase & {
  animation: "static-focus" | "slide-up" | "slide-side" | "pop" | "reveal" | "single-word" | "highlight-bar";
  emphasisWords: string[];
};

/* ---------------- captures ---------------- */

export type CaptureTile = { index: number; offsetY: number; heightPx: number };
export type MeasuredAnchor = { anchor: string; offsetTop: number; offsetHeight: number };

export type RepositoryCapture = {
  nodeId: string;
  fullName: string;
  kind: "overview";
  sourceUrl: string;
  capturedAt: string;
  cssViewport: { width: number; height: number };
  documentHeightCssPx: number;
  imagePath: string;
  sha256: string;
  bytes: number;
  tiles: CaptureTile[];
  anchors: MeasuredAnchor[];
  /** Highlight plans resolved against this capture, in image coordinates. */
  highlights: Array<{
    segmentId: string;
    targetText: string;
    /** Rect in the full captured image (px). */
    x: number; y: number; width: number; height: number;
    source: "dom";
    validated: boolean;
  }>;
  warnings: string[];
};

export type SourceFileCapture = {
  nodeId: string;
  fullName: string;
  kind: "source-file";
  filePath: string;
  sourceUrl: string;
  capturedAt: string;
  imagePath: string;
  sha256: string;
  bytes: number;
  cssViewport: { width: number; height: number };
  lineHighlight: { lineStart: number; lineEnd: number; x: number; y: number; width: number; height: number } | null;
  syntaxLanguage: string | null;
  contentHash: string;
  warnings: string[];
};

export type CaptureBundle = {
  nodeId: string;
  overview: RepositoryCapture | null;
  sourceFile: SourceFileCapture | null;
};

/* ---------------- scene manifest / timeline ---------------- */

export type CameraKeyframe = CameraKey;

export type SceneType =
  | "opening"
  | "repo-reveal"
  | "repo-overview"
  | "repo-readme"
  | "repo-code"
  | "repo-outro"
  | "closing";

export type Scene = {
  id: string;
  index: number;
  type: SceneType;
  nodeId: string | null;
  rank: number | null;
  fullName: string | null;
  captureImage: string | null;
  sourceFileImage: string | null;
  startMs: number;
  endMs: number;
  /** Crop rectangle of the capture image to show (CSS px), if any. */
  viewRect: { x: number; y: number; width: number; height: number } | null;
  cameraKeys: CameraKey[];
  highlights: Array<{ x: number; y: number; width: number; height: number; startMs: number; endMs: number }>;
  mascot: {
    visible: boolean;
    asset: "escort" | "point" | "present";
    position: "bottom-right" | "bottom-left" | "right-middle" | "left-middle";
    startMs: number;
    endMs: number;
    /** Fraction of frame height. */
    heightRatio: number;
  } | null;
  callout: { text: string; startMs: number; endMs: number } | null;
  titleText: string | null;
  titleSubText: string | null;
  /** Full-frame transparent PNG title overlay (set by the composition stage). */
  titlePng: string | null;
  captionTrack: "story" | "none";
  sfx: Array<{ role: string; atMs: number }>;
};

export type SceneManifest = {
  episodeId: string;
  scenes: Scene[];
  totalDurationMs: number;
  generatedAt: string;
};

/* ---------------- audio ---------------- */

export type AudioPlan = {
  narrationWav: string;
  mixedWav: string;
  bgmIncluded: boolean;
  ducking: { method: "sidechain-compress"; ratio: number; threshold: number; attackMs: number; releaseMs: number };
  sfxEvents: Array<{ role: string; asset: string; atMs: number; gainDb: number }>;
  musicStartMs: number;
  musicEndMs: number;
};

/* ---------------- render / QA ---------------- */

export type RenderResult = {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  codec: string;
  pixelFormat: string;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  sizeBytes: number;
  segmentsRendered: number;
  segmentsReused: number;
  renderMs: number;
};
