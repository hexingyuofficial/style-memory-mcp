export type HabitKind =
  | "catchphrase"
  | "dialect_marker"
  | "emoji"
  | "punctuation"
  | "tone"
  | "language_mix"
  // ── v0.2: kinds typically reported by host LLM via `hints` ──
  | "sentence_final_particle"
  | "structure"
  | "idiolect";

export type HabitStatus = "candidate" | "active" | "archived";

export type AddressParty = "user" | "assistant";
export type AddressDirection = "user→assistant" | "assistant→user";
export type ExpressionKind =
  | "lexical"
  | "laughter"
  | "kaomoji"
  | "emoji"
  | "unicode_symbol"
  | "text_marker"
  | "sticker_semantic"
  | "punctuation"
  | "mixed_language"
  | "other";
export type VariationPolicy = "exact_only" | "same_family" | "open_variation";
export type ObservationChannel = "hook" | "agent";
export type AgentObservationPolicy = "full" | "event" | "off";

export interface EvidenceState {
  seenCount: number;
  sessionIds: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastArchivedAt?: string;
  evidence?: EvidenceRecord[];
}

export interface EvidenceRecord {
  field: string;
  observedValue?: number;
  delta?: number;
  source: "explicit" | "feedback" | "rule" | "hint" | "distill";
  weight: number;
  sessionId?: string;
  timestamp: string;
  reason?: string;
}

export interface AddressValue {
  id: string;
  text: string;
  from: AddressParty;
  to: AddressParty;
  usageSummary?: string;
  affectSummary?: string;
  useWhen?: string[];
  status: HabitStatus;
  confidence: number;
  pinned: boolean;
  explicit: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
  archivedAt?: string;
  evidence: EvidenceState;
}

export interface AddressMemory {
  from: AddressParty;
  to: AddressParty;
  values: AddressValue[];
}

export interface ScaleMemory {
  value: 1 | 2 | 3 | 4 | 5;
  latentMean: number;
  confidence: number;
  evidenceWeight: number;
  evidenceCount: number;
  sessionCount: number;
  lastUpdatedAt: string;
  pinned?: boolean;
  explicit?: boolean;
  evidence?: EvidenceRecord[];
}

export interface ObservedVoice {
  verbosity: ScaleMemory;
  formality: ScaleMemory;
  expressiveness: ScaleMemory;
  rhythm?: string;
  expressionDensity: 0 | 1 | 2 | 3;
  punctuation: {
    baseStyle: "minimal" | "standard" | "expressive" | "ellipses";
    literalPatterns: string[];
  };
}

export interface ResponsePreferences {
  replyVerbosity: ScaleMemory;
  warmth: ScaleMemory;
  initiative: ScaleMemory;
  supportMode?: string;
}

export interface ExpressionPattern {
  id: string;
  kind: ExpressionKind;
  behaviorSummary: string;
  functions: string[];
  variationPolicy: VariationPolicy;
  examples: string[];
  useWhen?: string[];
  avoidWhen?: string[];
  density?: 0 | 1 | 2 | 3;
  status: HabitStatus;
  pinned: boolean;
  explicit: boolean;
  confidence: number;
  seenCount: number;
  sessionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastReturnedAt?: string;
  archivedAt?: string;
  evidence: EvidenceState;
}

export interface FailureRule {
  id: string;
  rule: string;
  status: "active" | "archived";
  pinned: boolean;
  explicit: boolean;
  createdAt: string;
  lastConfirmedAt: string;
}

/** Where a habit observation came from. Useful for debugging; no behavioral split. */
export type HabitSource = "rule" | "hint" | "distill";

export type InteractionPreferenceCategory =
  | "response_structure"
  | "collaboration"
  | "explanation"
  | "decision_making"
  | "workflow"
  | "tone_boundary";

export interface StyleHabit {
  id: string;
  kind: HabitKind;
  text: string;
  locale?: string;
  confidence: number;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastReturnedAt?: string;
  status: HabitStatus;
  pinned: boolean;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
  /**
   * A short example fragment showing how the user uses this habit.
   * Capped at ~60 chars, sensitive content filtered out before storage.
   * Only one example is kept per habit; the first one to land wins until
   * it is forgotten.
   */
  example?: string;
  /**
   * The distinct context labels under which this habit has been seen
   * (e.g. ["casual_chat", "technical_chat"]). Used by the cross-context
   * promote rule: a habit needs to appear under ≥2 contexts before it
   * is promoted from candidate to active. Capped at 8.
   */
  seenContexts?: string[];
  /** Provenance of the first observation. */
  source?: HabitSource;
}

export interface StyleSettings {
  dataPath: string;
  minPromoteCount: number;
  candidateTtlDays: number;
  inactiveTtlDays: number;
  maxBriefItems: number;
  maxExampleLen: number;
  allowLearning: boolean;
  observationChannel: ObservationChannel;
  agentPolicy: AgentObservationPolicy;
}

export interface StyleStore {
  version: 2;
  settings: StyleSettings;
  initialization: InitializationState;
  /** v1 compatibility projection; v2 writes also maintain it for old clients. */
  habits: StyleHabit[];
  profile: InteractionProfile;
  evidenceState: EvidenceState;
  briefState: {
    revision: number;
    capsule?: string;
    lastContext?: string;
  };
  lastCleanupAt?: string;
}

export type InitializationStatus = "pending" | "completed" | "skipped";

export interface InitializationState {
  status: InitializationStatus;
  requestedAt?: string;
  completedAt?: string;
  sourceSessionCount?: number;
  lookbackDays?: number;
}

export interface InitializationVoiceInput {
  verbosity?: 1 | 2 | 3 | 4 | 5;
  formality?: 1 | 2 | 3 | 4 | 5;
  expressiveness?: 1 | 2 | 3 | 4 | 5;
  rhythm?: string;
  expressionDensity?: 0 | 1 | 2 | 3;
  punctuation?: {
    baseStyle?: "minimal" | "standard" | "expressive" | "ellipses";
    literalPatterns?: string[];
  };
}

export interface InitializationResponsePreferenceInput {
  field: "replyVerbosity" | "warmth" | "initiative";
  value: 1 | 2 | 3 | 4 | 5;
  evidence: "explicit_feedback";
}

export interface InitializationInput {
  action: "complete" | "skip";
  lookbackDays?: number;
  sessionCount?: number;
  observedVoice?: InitializationVoiceInput;
  responsePreferences?: InitializationResponsePreferenceInput[];
  profileHints?: ProfileHintInput[];
  expressionHints?: HintInput[];
}

export interface InitializationResult {
  status: InitializationStatus;
  requested: boolean;
  lookbackDays?: number;
  maxSessions?: number;
  sourceSessionCount?: number;
  ignored?: string[];
}

export interface InteractionProfile {
  preferences: InteractionPreference[];
  addresses: AddressMemory[];
  observedVoice: ObservedVoice;
  responsePreferences: ResponsePreferences;
  expressionPatterns: ExpressionPattern[];
  failureLog: FailureRule[];
}

export interface InteractionPreference {
  id: string;
  category: InteractionPreferenceCategory;
  text: string;
  confidence: number;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastReturnedAt?: string;
  status: HabitStatus;
  pinned: boolean;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
  example?: string;
  seenContexts?: string[];
  source?: HabitSource;
}

export interface ExtractedHabit {
  kind: HabitKind;
  text: string;
  locale?: string;
  confidenceDelta: number;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
  /** Example fragment, sanitized before reaching this stage. */
  example?: string;
  /** Optional semantic fields supplied by a host observation. */
  behaviorSummary?: string;
  functions?: string[];
  variationPolicy?: VariationPolicy;
  /** Provenance. Defaults to "rule" for dictionary-extracted habits. */
  source?: HabitSource;
  /** Optional host session handle retained for v2 evidence accounting. */
  sessionId?: string;
}

/**
 * Host LLM's observation of a style signal it noticed in the user message.
 * The MCP itself does NOT call an LLM — it just records what the host
 * already saw while drafting its reply.
 */
export interface HintInput {
  kind: HabitKind;
  text: string;
  locale?: string;
  /** A short user-message fragment showing the habit in use. Sanitized server-side. */
  example?: string;
  useWhen?: string[];
  avoidWhen?: string[];
  notes?: string;
  /** Host LLM's self-rated 0–1 certainty that this is a real personal habit. */
  confidence?: number;
  behaviorSummary?: string;
  functions?: string[];
  variationPolicy?: VariationPolicy;
  sessionId?: string;
  sourceRole?: "user" | "assistant" | "system" | "tool";
  addressFrom?: AddressParty;
  addressTo?: AddressParty;
  affectSummary?: string;
  usageSummary?: string;
}

/**
 * Host LLM's observation of how the user prefers to collaborate.
 * This is NOT a personality label. Keep it concrete and behavioral:
 * e.g. "prefers direct assessment before implementation".
 */
export interface ProfileHintInput {
  category: InteractionPreferenceCategory;
  text: string;
  example?: string;
  useWhen?: string[];
  avoidWhen?: string[];
  notes?: string;
  confidence?: number;
  sessionId?: string;
  explicit?: boolean;
  preferenceField?: "replyVerbosity" | "warmth" | "initiative";
  value?: 1 | 2 | 3 | 4 | 5;
}

export interface ObserveOptions {
  sessionId?: string;
  channel?: ObservationChannel;
  policy?: AgentObservationPolicy;
  addressHints?: AddressHintInput[];
  feedback?: FeedbackInput;
}

export interface AddressHintInput {
  text: string;
  from: AddressParty;
  to: AddressParty;
  sourceRole: "user";
  currentMessage: string;
  usageSummary?: string;
  affectSummary?: string;
  useWhen?: string[];
  explicit?: boolean;
  sessionId?: string;
}

export interface FeedbackInput {
  kind: "address" | "expression" | "response_preference" | "failure";
  action: "confirm" | "correct" | "forget" | "pin" | "archive" | "set";
  idOrText?: string;
  direction?: AddressDirection;
  text?: string;
  rule?: string;
  field?: string;
  value?: number;
  message?: string;
}

export interface ObserveResult {
  learned: StyleHabit[];
  updated: StyleHabit[];
  profileLearned: InteractionPreference[];
  profileUpdated: InteractionPreference[];
  ignored: string[];
  cleanup: {
    archived: number;
    deleted: number;
  };
  ack?: RuntimeAck;
}

export interface RuntimeAck {
  ok: 1;
  refresh: 0 | 1;
  revision: number;
  channel: ObservationChannel;
  policy: AgentObservationPolicy;
  ignored?: string[];
  capacity?: string[];
}

export interface StyleBriefEnvelope {
  revision: number;
  mode: "capsule" | "delta" | "ack";
  capsule?: string;
  delta?: string;
  brief: string;
  context?: string;
}

export interface BootstrapResult {
  serverVersion: string;
  storeVersion: 2;
  channel: ObservationChannel;
  policy: AgentObservationPolicy;
  sessionId: string;
  revision: number;
  capsule: string;
  mature: boolean;
  runtimeTools: string[];
  initialization: InitializationResult;
}

export type ReviewSuggestionAction = "keep" | "pin" | "forget" | "observe";

export interface ReviewSuggestion {
  id: string;
  kind: HabitKind;
  text: string;
  status: HabitStatus;
  confidence: number;
  seenCount: number;
  pinned: boolean;
  lastSeenAt: string;
  suggestedAction: ReviewSuggestionAction;
  reason: string;
  useWhen: string[];
  avoidWhen: string[];
  example?: string;
}

export interface ReviewResult {
  summary: {
    total: number;
    active: number;
    candidates: number;
    archived: number;
    pinned: number;
    allowLearning: boolean;
  };
  suggestions: ReviewSuggestion[];
}

export interface ProfileReviewSuggestion {
  id: string;
  category: InteractionPreferenceCategory;
  text: string;
  status: HabitStatus;
  confidence: number;
  seenCount: number;
  pinned: boolean;
  lastSeenAt: string;
  suggestedAction: ReviewSuggestionAction;
  reason: string;
  useWhen: string[];
  avoidWhen: string[];
  example?: string;
}

export interface ProfileReviewResult {
  summary: {
    total: number;
    active: number;
    candidates: number;
    archived: number;
    pinned: number;
    allowLearning: boolean;
  };
  suggestions: ProfileReviewSuggestion[];
}

export interface ProfileDistillResult {
  learned: InteractionPreference[];
  updated: InteractionPreference[];
  ignored: string[];
  cleanup: {
    archived: number;
    deleted: number;
  };
}

export interface StyleMemoryScore {
  overall: number;
  readiness: number;
  stability: number;
  freshness: number;
  driftRisk: number;
  overfitRisk: number;
  briefRefreshRecommended: boolean;
  counts: {
    habits: number;
    activeHabits: number;
    candidateHabits: number;
    archivedHabits: number;
    profilePreferences: number;
    activeProfilePreferences: number;
    candidateProfilePreferences: number;
    archivedProfilePreferences: number;
    pinnedItems: number;
  };
  recommendations: string[];
}

export interface StyleBriefHabit {
  id: string;
  kind: HabitKind;
  text: string;
  locale?: string;
  confidence: number;
  seenCount: number;
  useWhen: string[];
  avoidWhen: string[];
  example?: string;
  notes?: string;
}

export interface StyleBriefPreference {
  id: string;
  category: InteractionPreferenceCategory;
  text: string;
  confidence: number;
  seenCount: number;
  useWhen: string[];
  avoidWhen: string[];
  example?: string;
  notes?: string;
}

export interface StyleBriefResult {
  brief: string;
  profileNudge: string | null;
  context?: string;
  habits: StyleBriefHabit[];
  interactionProfile: StyleBriefPreference[];
  revision?: number;
  mode?: "capsule" | "delta" | "ack";
  delta?: string;
  addresses?: AddressMemory[];
  expressionPatterns?: ExpressionPattern[];
  observedVoice?: ObservedVoice;
  responsePreferences?: ResponsePreferences;
  failureLog?: FailureRule[];
}
