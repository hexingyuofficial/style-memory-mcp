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
  lastCleanupAt?: string;
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

export interface ObserveResult {
  learned: StyleHabit[];
  updated: StyleHabit[];
  ignored: string[];
  cleanup: {
    archived: number;
    deleted: number;
  };
}
