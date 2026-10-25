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
  | "problem"
  | "feature"
  | "mechanism"
  | "workflow"
  | "example"
  | "use_case"
  | "outcome"
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
  | "readme-table"
  | "source-file"
  | "release"
  | "star-snapshot";

/**
 * What a claim *does* inside an explanation (Pass A).
 *
 * `FactKind` records where a claim came from; `FactSemantic` records its job in
 * the narrative. They are deliberately separate axes: a README paragraph and a
 * command table can both be `mechanism` evidence even though their kinds differ,
 * and a `feature` bullet is not automatically an `example`. The planner and the
 * script composer reason about `semantic`, never about raw kinds.
 */
export type FactSemantic =
  | "identity"
  | "problem"
  | "purpose"
  | "mechanism"
  | "workflow"
  | "example"
  | "outcome"
  | "limitation"
  | "setup"
  | "metadata";

/**
 * Where a claim can be traced to. A claim is only as trustworthy as the piece
 * of documentation that supports it, so the excerpt and its location travel
 * with the fact instead of being recomputed at scoring time.
 */
export type FactProvenance = {
  /** Short verbatim excerpt that supports the claim. */
  excerpt?: string;
  /** Source file + section, e.g. "README.md#how-it-works". */
  path?: string;
  /** Inclusive line range in the source document (1-based). */
  lineStart?: number;
  lineEnd?: number;
  /** Name of the deterministic extraction rule that produced the fact. */
  rule?: string;
};

export type Fact = {
  id: string;
  kind: FactKind;
  /** What the claim does in an explanation. Optional for backwards compat. */
  semantic?: FactSemantic;
  /** Human-readable statement of the verified claim. */
  claim: string;
  /** Short form used when speaking (no trailing period, no markdown). */
  spoken: string;
  source: {
    kind: FactSourceKind;
    location: string;
    capturedAt: string;
  };
  /** Traceability back to the supporting document. */
  provenance?: FactProvenance;
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

/** Role of a clause inside the constrained story grammar. */
export type StorySlot =
  | "hook"
  | "identity"
  | "value"
  | "proof"
  | "demo"
  | "setup"
  | "availability"
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
  /** Grammar slot that produced this segment (for reproducibility/debugging). */
  narrativeRole?: StorySlot;
  /** Stable id of the clause template that produced this segment. */
  clauseId?: string;
  /**
   * Short, evidence-backed summary for the mascot callout bubble.
   *
   * Derivation happens in the script composer from the already-selected
   * purpose evidence, never from the raw README at render time. The segment's
   * `factIds` are the audit trail for this copy.
   */
  calloutText?: string;
  calloutRole?: CalloutRole;
  calloutImportance?: number;
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
  /** Story-grammar structure chosen for this script. */
  structure?: string;
  /** Deterministic score of the selected story, for QA/debugging. */
  scriptScore?: number;
};

/**
 * Structured intermediate representation of a repository narration (Phase 2).
 * The script compiler must cover purpose, mechanism and use case; popularity
 * metadata is optional and may never replace those sections.
 */
export type RepoNarration = {
  hook: string;
  purpose: string;
  mechanism: string;
  useCase: string;
  benefit: string;
  limitation?: string;
  installation?: string;
  optionalPopularityFact?: string;
};

export type ScriptValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  words: number;
  estimatedSeconds: number;
  /** Structured narration the script compiles to (recorded as an artifact). */
  narrative?: RepoNarration;
};

/**
 * Voice preset for the TTS narrator (see `VOICE_PRESET` in config.ts).
 * Recorded with the render metadata so every video states exactly which
 * Kokoro voice, speed and language produced its audio.
 */
export type VoicePreset = {
  /** Kokoro voice id, e.g. "am_liam". */
  id: string;
  /** Speech rate multiplier (1.0 = natural). */
  speed: number;
  /** Kokoro language code, e.g. "en-us". */
  language: string;
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
  /** Where the offset came from. Captured anchors are never invented. */
  source?: "captured" | "fallback";
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
  /** The exact callout cues used for frame capture (non-overlapping, timeline-bound). */
  callouts?: CalloutCue[];
  /** Animated comic impact bursts around the mascot. */
  impactBursts?: ImpactBurstCue[];
  /** Scheduled sound effect events synchronized with mascot and callouts. */
  soundEvents?: SoundEvent[];
  /** Where the story was cropped, in displayed screenshot pixels. */
  story?: {
    startPx: number;
    endPx: number;
    fullHeightPx: number;
    source: "live" | "fallback";
  };
};

/* ------------------------------------------------------------------ */
/* Mobile page capture & character                                     */
/* ------------------------------------------------------------------ */

export type PageCaptureSource = "live" | "fallback";

export type MobilePageCapture = {
  imagePath: string;
  sourceUrl: string;
  source: PageCaptureSource;
  cssViewport: { width: number; height: number };
  /** Dimensions after normalization to the card content width. */
  raster: { width: number; height: number };
  /** Raw dimensions returned by Chromium before normalization. */
  rawRaster: { width: number; height: number };
  pixelsPerCssPx: number;
  documentHeightCssPx: number;
  /** Anchor offsets are already in displayed raster pixels. */
  anchors: MeasuredAnchor[];
  title: string;
  capturedAt: string;
  warnings: string[];
};

export type SpeechEnvelope = {
  /** Samples per second (deliberately low, e.g. 25). */
  rateHz: number;
  durationMs: number;
  /** 0..1 amplitude per sample, already smoothed. */
  levels: number[];
};

/** Presenter framing/action chosen for a narration slot. */
export type CharacterPoseName = "present" | "point" | "close";

export type CharacterCue = {
  startMs: number;
  endMs: number;
  pose: CharacterPoseName;
};

/* ------------------------------------------------------------------ */
/* Callout bubble                                                      */
/* ------------------------------------------------------------------ */

export type CalloutRole =
  | "purpose"
  | "mechanism"
  | "example"
  | "benefit"
  | "tradeoff"
  | "installation";

/**
 * One callout bubble event, bound to the measured audio timeline.
 *
 * Renders concise, non-overlapping summaries of important narrative beats
 * (purpose, mechanism, example, benefit, tradeoff), attached to the mascot's head.
 * `factIds` are the audit trail supporting the displayed copy.
 */
export type CalloutCue = {
  id: string;
  segmentId: string;
  role?: CalloutRole;
  text: string;
  startMs: number;
  endMs: number;
  factIds: string[];
  anchor: "mascot-head";
  importance?: number;
  selectionScore?: number;
  omissionAlternatives?: string[];
};

/** Deterministic per-frame visual state of a callout cue. */
export type CalloutState = {
  cueId: string | null;
  visible: boolean;
  text: string;
  opacity: number;
  translateY: number;
  scale: number;
  raysOpacity: number;
};

export type CalloutAssetProfile = {
  widthPx: number;
  heightPx: number;
  /** Normalized coordinates in the asset's actual image box (0..1). */
  tailTip: { x: number; y: number };
  /** Normalized safe rectangle for separate text (0..1). */
  textSafeRect: { x: number; y: number; width: number; height: number };
  containsEmbeddedRays: boolean;
  containsEmbeddedArrow: boolean;
};

/* ------------------------------------------------------------------ */
/* Mascot impact accents                                               */
/* ------------------------------------------------------------------ */

export type ImpactAnchor =
  | "hair-left"
  | "hair-right"
  | "shoulder-left"
  | "shoulder-right"
  | "laptop-edge";

export type ImpactVariant = "two-rays" | "three-rays" | "short-spark" | "sweep";

export type ImpactLayer = "behind-mascot" | "front-mascot";

export type ImpactBurstCue = {
  id: string;
  startMs: number;
  endMs: number;
  anchor: ImpactAnchor;
  variant: ImpactVariant;
  rotationDeg: number;
  scale: number;
  opacity: number;
  layer: ImpactLayer;
  relatedSegmentId?: string;
  seed: number;
};

/* ------------------------------------------------------------------ */
/* Sound effects (SFX)                                                */
/* ------------------------------------------------------------------ */

export type SoundEventKind = "mascot-entrance" | "callout-pop";

export type SoundEvent = {
  asset: string;
  startMs: number;
  gain: number;
  kind?: SoundEventKind;
  cueId?: string;
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