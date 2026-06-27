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
}

export interface StyleStore {
  version: 1;
  settings: StyleSettings;
  habits: StyleHabit[];
  profile: InteractionProfile;
  lastCleanupAt?: string;
}

export interface InteractionProfile {
  preferences: InteractionPreference[];
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
  /** Provenance. Defaults to "rule" for dictionary-extracted habits. */
  source?: HabitSource;
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
