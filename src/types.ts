/**
 * Shared domain types for the showcase pipeline.
 *
 * These types are the contracts between stages. Every stage reads explicit
 * input objects and returns explicit output objects; no stage mutates another
 * stage's artifacts.
 */

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

export type GitHubLicense = {
  key: string | null;
  name: string | null;
  spdx_id: string | null;
} | null;

export type GitHubRelease = {
  tag_name: string | null;
  name: string | null;
  published_at: string | null;
  html_url: string | null;
};

/** Raw repository metadata as returned by `GET /repos/{owner}/{repo}`. */
export type Repo = {
  node_id?: string;
  full_name: string;
  /** The REST payload returns an object here; the owner is derived from `full_name`. */
  owner?: unknown;
  name?: string;
  html_url: string;
  description: string | null;
  created_at?: string;
  updated_at: string;
  pushed_at?: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count?: number;
  language: string | null;
  languages?: Record<string, number>;
  default_branch: string;
  license: GitHubLicense;
  topics?: string[];
  homepage?: string | null;
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  size?: number;
};

/** A repository after hydration with README / languages / release data. */
export type EnrichedRepo = Repo & {
  nodeId: string;
  owner: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  topics: string[];
  homepage: string | null;
  languages: Record<string, number>;
  primaryLanguage: string | null;
  licenseSpdxId: string | null;
  licenseName: string | null;
  /** Recognized permissive/open-source licenses. Empty means "unverified". */
  openSourceLicense: string | null;
  readmeText: string | null;
  readmeUrl: string | null;
  latestRelease: GitHubRelease | null;
  /** Top-level entries from the default branch, used by the card's file list. */
  rootFiles: RootEntry[];
  /** Used for the file list's commit column. Null when the API call failed. */
  latestCommit: LatestCommit | null;
  sizeKb: number;
  capturedAt: string;
};

/** Latest commit on the default branch, as listed on the repository page. */
export type LatestCommit = {
  message: string;
  authorLogin: string | null;
  committedAt: string | null;
};

/** Top-level repository entry as listed on the repository page. */
export type RootEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
};

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export type DiscoveryMode =
  | "practical"
  | "popular"
  | "underdog"
  | "emerging"
  | "topic";

export type ScoreDimension =
  | "usefulness"
  | "documentation"
  | "maintenance"
  | "adoption"
  | "momentum"
  | "setup"
  | "maturity"
  | "novelty";

export type ScoreBreakdown = Record<ScoreDimension, number>;

export type CandidateEvaluation = {
  repo: Repo;
  fullName: string;
  mode: DiscoveryMode;
  eligible: boolean;
  totalScore: number;
  breakdown: ScoreBreakdown;
  penalties: { reason: string; points: number }[];
  reasons: string[];
  warnings: string[];
  /** Populated only for enriched candidates. */
  enriched: EnrichedRepo | null;
};

/* ------------------------------------------------------------------ */
/* Facts                                                               */
/* ------------------------------------------------------------------ */

export type FactKind =
  | "purpose"
  | "feature"
  | "use_case"
  | "install"
  | "license"
  | "adoption"
  | "activity"
  | "requirement"
  | "limitation"
  | "release"
  | "language";

export type FactSourceKind =
  | "api-field"
  | "readme-section"
  | "readme-code"
  | "release"
  | "star-snapshot";

export type Fact = {
  id: string;
  kind: FactKind;
  /** Human-readable statement of the verified claim. */
  claim: string;
  /** Short form used when speaking (no trailing period, no markdown). */
  spoken: string;
  source: {
    kind: FactSourceKind;
    location: string;
    capturedAt: string;
  };
  /** 0..1, assigned by deterministic rules in `facts.ts`. */
  confidence: number;
};

export type FactLedger = {
  repositoryNodeId: string;
  fullName: string;
  capturedAt: string;
  facts: Fact[];
};

/* ------------------------------------------------------------------ */
/* Narration                                                           */
/* ------------------------------------------------------------------ */

export type SegmentPurpose =
  | "identify"
  | "problem"
  | "explain"
  | "benefit"
  | "demo"
  | "install"
  | "license"
  | "adoption"
  | "caveat"
  | "cta";

export type VisualAnchor =
  | "repo-header"
  | "file-list"
  | "readme-intro"
  | "install-command"
  | "features"
  | "license"
  | "release";

export type NarrationSegment = {
  id: string;
  purpose: SegmentPurpose;
  /** Text handed to the TTS engine (pronunciation substitutions applied). */
  spokenText: string;
  /** Text shown on screen (correct spelling, different from spoken). */
  captionText: string;
  factIds: string[];
  visualAnchor?: VisualAnchor;
  pauseAfterMs?: number;
  /** Caption words/phrases to tint with the highlight color. */
  emphasis?: string[];
};

export type NarrationAngle =
  | "what-it-does"
  | "problem-solution"
  | "quick-tour"
  | "try-it"
  | "developer-workflow"
  | "under-the-radar"
  | "mature-and-popular"
  | "trade-off";

export type NarrationPlan = {
  repositoryNodeId: string;
  fullName: string;
  angle: NarrationAngle;
  angleReason: string;
  targetDurationSeconds: number;
  styleVariant: string;
  voiceId: string;
  speed: number;
  estimatedWords: number;
  segments: NarrationSegment[];
};

export type ScriptValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  words: number;
  estimatedSeconds: number;
};

/* ------------------------------------------------------------------ */
/* Captions & timeline                                                 */
/* ------------------------------------------------------------------ */

export type CaptionPhrase = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Words (as displayed) that receive the highlight colour. */
  highlights: string[];
  segmentId: string;
};

export type AudioChunk = {
  index: number;
  segmentId: string;
  file: string;
  text: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  startMs: number;
  endMs: number;
};

export type AudioMeasurement = {
  file: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
};

/** Measured position of one document section inside the scrolling document. */
export type MeasuredAnchor = {
  anchor: VisualAnchor;
  offsetTop: number;
  offsetHeight: number;
};

export type ScrollKeyframe = {
  timeMs: number;
  scrollY: number;
  easing: "linear" | "easeInOut";
  anchor?: VisualAnchor;
};

export type Timeline = {
  durationMs: number;
  sampleRate: number;
  chunks: AudioChunk[];
  captions: CaptionPhrase[];
  scroll: ScrollKeyframe[];
  anchors: MeasuredAnchor[];
  documentHeight: number;
  viewportHeight: number;
};

/* ------------------------------------------------------------------ */
/* Stages & runs                                                       */
/* ------------------------------------------------------------------ */

export type StageName =
  | "setup"
  | "discovery"
  | "enrichment"
  | "selection"
  | "facts"
  | "narration"
  | "tts"
  | "timeline"
  | "render"
  | "encode"
  | "qa";

export type StageResult<T> =
  | { ok: true; stage: StageName; value: T; warnings: string[] }
  | {
      ok: false;
      stage: StageName;
      code: string;
      message: string;
      retryable: boolean;
    };

export type MediaInfo = {
  width: number;
  height: number;
  durationSeconds: number;
  videoCodec: string;
  pixelFormat: string;
  frameRate: number;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  sizeBytes: number;
};

export type QaCheck = { name: string; ok: boolean; detail: string };

export type QaReport = {
  ok: boolean;
  checks: QaCheck[];
  media: MediaInfo | null;
};