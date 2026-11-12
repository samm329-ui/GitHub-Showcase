/**
 * Shared types for the Lazy News channel.
 *
 * News deliberately does NOT reuse most GitHub-specific contracts (Repo,
 * EnrichedRepo, …). It reuses the generic infrastructure (TTS, captions,
 * audio, render, QA, persistence) and keeps its own editorial types.
 */

/* ------------------------------------------------------------------ */
/* Source permissions                                                   */
/* ------------------------------------------------------------------ */

export type SourcePermissionBasis =
  | "public_domain"
  | "explicit_license"
  | "written_permission"
  | "terms_reviewed"
  | "discovery_only"
  | "unknown";

/**
 * Editorial perspective of an independent-reporting outlet. Used ONLY by the
 * corroboration/balance layer — never to rank an outlet's truthfulness.
 * Primary records, fact-check desks and aggregators carry no tag on purpose.
 */
export type EditorialPerspective = "left" | "centre_left" | "centre" | "centre_right" | "right";

export interface SourcePolicy {
  /** Stable id, e.g. "pib.gov.in". */
  sourceId: string;
  domain: string;
  documentTypes: string[];
  discoveryAllowed: boolean;
  metadataAllowed: boolean;
  fullTextFetchAllowed: boolean;
  llmProcessingAllowed: boolean;
  quotationAllowed: boolean;
  permissionBasis: SourcePermissionBasis;
  licenseUrl?: string;
  /** ISO date of last human terms review; stale entries degrade to discovery_only. */
  termsCheckedAt?: string;
  enabled: boolean;
  sourceRole: "primary" | "independent_reporting" | "discovery" | "social_signal" | "fact_check";
  parentPublisherGroup: string;
  /** Wire origin group: ap | reuters | afp | pib | un | release | none. */
  wireOrigin?: string;
  /** Editorial leaning of an independent-reporting outlet (see EditorialPerspective). */
  perspective?: EditorialPerspective;
  notes?: string;
}

export type IndependenceStatus =
  | "independent"
  | "syndicated"
  | "same_original_source"
  | "unknown";

/* ------------------------------------------------------------------ */
/* Discovery                                                            */
/* ------------------------------------------------------------------ */

export type DiscoverySourceType =
  | "rss"
  | "atom"
  | "api"
  | "primary_page"
  | "document"
  | "social"
  | "manual";

export type DiscoveredItem = {
  id: string;
  title: string;
  url: string;
  sourceId: string;
  sourceName: string;
  sourcePolicy: SourcePolicy;
  publishedAt: string | null;
  eventDate: string | null;
  description: string | null;
  authors?: string[];
  language?: string | null;
  matchedQuery?: string;
  /** UTC fetch time; publication time is preserved separately in publishedAt. */
  fetchedAt: string;
  fingerprint: string;
};

/* ------------------------------------------------------------------ */
/* Clustering + selection                                               */
/* ------------------------------------------------------------------ */

export type StoryCluster = {
  clusterId: string;
  canonicalTitle: string;
  items: DiscoveredItem[];
  /** Distinct reporting origins (wire-lineage aware). */
  independenceCount: number;
  independence: IndependenceStatus;
  sourceIds: string[];
  publishedTimes: string[];
  category: string;
  entityTokens: string[];
  /** Why these were grouped (rule ids), for observability. */
  mergeReasons: string[];
  confidence: number;
};

export type ScoringClass =
  | "breaking"
  | "developing"
  | "established"
  | "forgotten";

export type ScoredCandidate = {
  cluster: StoryCluster;
  score: number;
  breakdown: {
    significance: number;
    indiaRelevance: number;
    independentCorroboration: number;
    noveltyFreshness: number;
    underCoverage: number;
    publicImpact: number;
  };
  reasons: string[];
  underCovered: boolean;
  editorialState: ScoringClass;
  /** Insufficient evidence blocks selection regardless of score. */
  eligible: boolean;
  eligibilityNote: string | null;
};

/* ------------------------------------------------------------------ */
/* Evidence + fact ledger                                               */
/* ------------------------------------------------------------------ */

export type EvidenceRecord = {
  sourceId: string;
  url: string;
  publisher: string;
  parentPublisherGroup: string;
  wireOrigin?: string;
  sourceRole: SourcePolicy["sourceRole"];
  /** Snapshot of the policy at collection time — never re-derived later. */
  policy: SourcePolicy;
  independenceStatus: IndependenceStatus;
  publishedAt?: string;
  eventDate?: string;
  /** section / paragraph / page / filing item */
  locator?: string;
  /** Short excerpt ONLY (never whole articles). */
  excerpt?: string;
  supports: "supports" | "contradicts" | "context_only";
  fetchedAt: string;
};

export type ClaimStatus =
  | "verified"
  | "attributed"
  | "disputed"
  | "unverified"
  | "excluded";

export type ClaimKind =
  | "event"
  | "date"
  | "number"
  | "quote"
  | "identity"
  | "legal_status"
  | "cause"
  | "effect"
  | "claim_by_actor"
  | "forecast"
  | "analysis";

export type ContentClass = "fact" | "interpretation" | "satire";

export type FactRecord = {
  id: string;
  claim: string;
  kind: ClaimKind;
  status: ClaimStatus;
  importance: "core" | "supporting" | "optional";
  contentClass: ContentClass;
  evidence: EvidenceRecord[];
  /** Count of distinct reporting origins supporting the claim (wire-lineage aware). */
  independenceCount: number;
  conflictNote?: string;
  safeNarration?: string;
  asOf?: string;
  confidence: number;
  verifiedByHuman: boolean;
};

export type EvidenceLedger = {
  storyId: string;
  capturedAt: string;
  facts: FactRecord[];
  verifierPassed: boolean;
  verifierErrors: string[];
  verifierWarnings: string[];
  independenceCount: number;
};

export type StoryPackage = {
  storyId: string;
  workingTitle: string;
  category: string;
  editorialState: ScoringClass;
  cluster: StoryCluster;
  scored: ScoredCandidate;
  sources: EvidenceRecord[];
  ledger: EvidenceLedger;
  /** Set only after Gate A. */
  gateAApproval: GateApproval | null;
};

/* ------------------------------------------------------------------ */
/* Approvals (Gates A / B / C) — no env var may bypass A or B          */
/* ------------------------------------------------------------------ */

export type GateId = "A" | "B" | "C";

export type GateApproval = {
  gate: GateId;
  approved: boolean;
  approvedAt: string | null;
  note: string;
  /** SHA-256 of the exact payload the human was shown. */
  payloadHash: string;
};

export type ApprovalState = {
  gateA: GateApproval | null;
  gateB: GateApproval | null;
  gateC: GateApproval | null;
};

/* ------------------------------------------------------------------ */
/* Script                                                               */
/* ------------------------------------------------------------------ */

export type NewsContentClass = "fact" | "interpretation" | "satire";

export type NewsSegment = {
  id: string;
  text: string;
  factIds: string[];
  delivery:
    | "dry_hook"
    | "measured_explanation"
    | "firm_attribution"
    | "dry_observation"
    | "punchline";
  sceneMode: "opening" | "narration_focus" | "board_callout" | "return_to_narration" | "closing";
  contentClass: NewsContentClass;
};

export type NewsCallout = {
  id: string;
  text: string;
  factIds: string[];
  highlightWords: string[];
  triggerNarrationId: string;
  priority: "high" | "medium";
  reveal: "type_on" | "marker_reveal";
};

export type EpisodeScript = {
  storyId: string;
  workingTitle: string;
  language: "en";
  tone: "dry_sarcastic";
  estimatedDurationSeconds: number;
  narration: NewsSegment[];
  callouts: NewsCallout[];
  sources: string[];
  editorialNotes: string[];
  /** Set only after Gate B. */
  gateBApproval?: GateApproval | null;
};

/* ------------------------------------------------------------------ */
/* Scene events                                                         */
/* ------------------------------------------------------------------ */

export type SceneMode =
  | "opening"
  | "narration_focus"
  | "board_callout"
  | "return_to_narration"
  | "closing";

export type NewsSceneEvent = {
  id: string;
  startMs: number;
  endMs: number;
  mode: SceneMode;
  narrationIds: string[];
  factIds: string[];
  subtitleText?: string;
  boardText?: string;
  highlightWords?: string[];
  boardReveal?: "type_on" | "marker_reveal";
  backgroundFocus?: "normal" | "dim_soft_blur";
  narratorMotion?: "entrance" | "idle" | "subtle_tilt" | "settle" | "none";
  stickyNoteMotion?: "idle" | "pause" | "small_flutter";
  sfx?: string[];
};

/* ------------------------------------------------------------------ */
/* Alignment                                                            */
/* ------------------------------------------------------------------ */

export type AlignedWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
  segmentId: string | null;
};

export type AlignmentReport = {
  alignmentSource: "whisperx" | "mfa" | "faster_whisper_fallback" | "none";
  modelVersion: string | null;
  tokensTotal: number;
  tokensAligned: number;
  coverage: number;
  monotonic: boolean;
  chunkBoundaryViolations: number;
  missingWords: string[];
  words: AlignedWord[];
};

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

export type NewsEpisodeStatus =
  | "discovered"
  | "facts_pending"
  | "facts_approved"
  | "script_pending"
  | "script_approved"
  | "rendering"
  | "completed"
  | "failed";
