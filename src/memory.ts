import { cleanupStore } from "./cleanup.js";
import { evaluateHabitForContext, evaluatePreferenceForContext } from "./context.js";
import { extractHabits } from "./extract.js";
import { isSensitive, sanitizeExample } from "./sensitivity.js";
import { clamp, loadStore, makeId, makeProfileId, MAX_SEEN_CONTEXTS, saveStore } from "./store.js";
import type {
  ExtractedHabit,
  HabitKind,
  InteractionPreference,
  InteractionPreferenceCategory,
  HintInput,
  ObserveResult,
  ProfileDistillResult,
  ProfileHintInput,
  ProfileReviewResult,
  ProfileReviewSuggestion,
  ReviewResult,
  ReviewSuggestion,
  StyleHabit,
  StyleMemoryScore,
  StyleSettings,
} from "./types.js";

const VALID_KINDS: ReadonlySet<HabitKind> = new Set<HabitKind>([
  "catchphrase",
  "dialect_marker",
  "emoji",
  "punctuation",
  "tone",
  "language_mix",
  "sentence_final_particle",
  "structure",
  "idiolect",
]);

const VALID_PROFILE_CATEGORIES: ReadonlySet<InteractionPreferenceCategory> =
  new Set<InteractionPreferenceCategory>([
    "response_structure",
    "collaboration",
    "explanation",
    "decision_making",
    "workflow",
    "tone_boundary",
  ]);

const BLOCKED_PROFILE_LABEL_RE =
  /\b(introvert|extrovert|neurotic|narciss|adhd|autis|depress|anxious|bipolar)\b|人格|性格|内向|外向|焦虑|抑郁|自恋|心理|精神/i;

/** Base delta applied to hint-sourced habits before LLM confidence scales it. */
const HINT_BASE_DELTA = 0.14;

/** Bounds for the scaled hint delta. */
const HINT_DELTA_MIN = 0.05;
const HINT_DELTA_MAX = 0.25;

/**
 * Hints whose scaled delta lands at ≥90% of the max ceiling are treated as
 * "high conviction" — they can skip the cross-context promote gate.
 * Empirically this corresponds to host-LLM `confidence` ≳ 0.71.
 *
 * Even so, a high-conviction hint still needs to have been observed at
 * least HIGH_CONVICTION_MIN_SEEN times before it bypasses cross-context.
 * Otherwise a single overconfident LLM call could promote anything to
 * `active` on first sighting, defeating the three-strike safety net.
 */
const HINT_HIGH_CONVICTION_DELTA = HINT_DELTA_MAX * 0.9;
const HIGH_CONVICTION_MIN_SEEN = 2;

/** Max length we ever accept for a hint's `text` field. */
const HINT_MAX_TEXT_LEN = 40;

export async function observeUserMessage(
  text: string,
  context?: string,
  hints?: HintInput[],
  profileHints?: ProfileHintInput[],
): Promise<ObserveResult> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  const ignored: string[] = [];

  if (!store.settings.allowLearning) {
    ignored.push("learning_disabled");
    await saveStore(store);
    return { learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup };
  }

  // Sensitive messages: skip rule-based extraction AND drop hints entirely
  // (the host LLM may have summarized something secret into a hint).
  if (isSensitive(text, context)) {
    ignored.push("sensitive_context");
    await saveStore(store);
    return { learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup };
  }

  const ruleExtracted = extractHabits(text).map(
    (item): ExtractedHabit => ({ ...item, source: item.source ?? "rule" }),
  );

  const hintExtracted = normalizeHints(hints, ignored, store.settings.maxExampleLen);
  const profileExtracted = normalizeProfileHints(
    profileHints,
    ignored,
    store.settings.maxExampleLen,
  );

  const learned: StyleHabit[] = [];
  const updated: StyleHabit[] = [];
  const profileLearned: InteractionPreference[] = [];
  const profileUpdated: InteractionPreference[] = [];
  const now = new Date().toISOString();

  for (const item of [...ruleExtracted, ...hintExtracted]) {
    const { habit, isNew } = upsertHabit(store.habits, item, now, store.settings, context);
    (isNew ? learned : updated).push(habit);
  }

  for (const item of profileExtracted) {
    const { preference, isNew } = upsertPreference(
      store.profile.preferences,
      item,
      now,
      store.settings,
      context,
    );
    (isNew ? profileLearned : profileUpdated).push(preference);
  }

  await saveStore(store);
  return { learned, updated, profileLearned, profileUpdated, ignored, cleanup };
}

/**
 * Batched "distillation" path: the host LLM has reviewed many recent
 * messages and is reporting a small set of expression-DNA observations.
 * Treated as user-endorsed — each habit is promoted aggressively
 * (seedCount jumps straight to `minPromoteCount`).
 */
export async function distillRecentStyle(
  habits: HintInput[],
): Promise<ObserveResult> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  const ignored: string[] = [];

  if (!store.settings.allowLearning) {
    ignored.push("learning_disabled");
    await saveStore(store);
    return { learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup };
  }

  const distilled = normalizeHints(habits, ignored, store.settings.maxExampleLen).map(
    (item): ExtractedHabit => ({ ...item, source: "distill" }),
  );

  const learned: StyleHabit[] = [];
  const updated: StyleHabit[] = [];
  const now = new Date().toISOString();

  for (const item of distilled) {
    // The "context" we tag distilled habits with is generic — these
    // observations are about the user's voice as a whole, not a specific
    // chat. We still record it so cross-context counters move.
    const { habit, isNew } = upsertHabit(store.habits, item, now, store.settings, "distilled");
    (isNew ? learned : updated).push(habit);
  }

  await saveStore(store);
  return { learned, updated, profileLearned: [], profileUpdated: [], ignored, cleanup };
}

export async function distillInteractionProfile(
  preferences: ProfileHintInput[],
): Promise<ProfileDistillResult> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  const ignored: string[] = [];

  if (!store.settings.allowLearning) {
    ignored.push("learning_disabled");
    await saveStore(store);
    return { learned: [], updated: [], ignored, cleanup };
  }

  const distilled = normalizeProfileHints(
    preferences,
    ignored,
    store.settings.maxExampleLen,
  ).map((item) => ({ ...item, source: "distill" as const }));

  const learned: InteractionPreference[] = [];
  const updated: InteractionPreference[] = [];
  const now = new Date().toISOString();

  for (const item of distilled) {
    const { preference, isNew } = upsertPreference(
      store.profile.preferences,
      item,
      now,
      store.settings,
      "distilled",
    );
    (isNew ? learned : updated).push(preference);
  }

  await saveStore(store);
  return { learned, updated, ignored, cleanup };
}

export async function getStyleBrief(context?: string): Promise<string> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  if (cleanup.archived || cleanup.deleted) await saveStore(store);

  const habits = store.habits
    .filter((habit) => habit.status === "active" && habit.confidence >= 0.3)
    .map((habit) => ({ habit, decision: evaluateHabitForContext(habit, context) }))
    .filter((item) => item.decision.include)
    .sort(
      (a, b) =>
        b.decision.score - a.decision.score ||
        b.habit.confidence - a.habit.confidence ||
        b.habit.seenCount - a.habit.seenCount,
    )
    .slice(0, store.settings.maxBriefItems);
  const preferences = store.profile.preferences
    .filter((preference) => preference.status === "active" && preference.confidence >= 0.3)
    .map((preference) => ({
      preference,
      decision: evaluatePreferenceForContext(preference, context),
    }))
    .filter((item) => item.decision.include)
    .sort(
      (a, b) =>
        b.decision.score - a.decision.score ||
        b.preference.confidence - a.preference.confidence ||
        b.preference.seenCount - a.preference.seenCount,
    )
    .slice(0, Math.min(4, store.settings.maxBriefItems));

  if (habits.length === 0 && preferences.length === 0) {
    return "No stable style habits yet. Keep the reply natural and do not imitate aggressively.";
  }

  const now = new Date().toISOString();
  for (const { habit } of habits) habit.lastReturnedAt = now;
  for (const { preference } of preferences) preference.lastReturnedAt = now;
  await saveStore(store);

  return [
    "Style brief: use lightly, never imitate aggressively, and never reveal private memories.",
    context ? `Current context: ${context}.` : "Current context: unspecified.",
    "How to apply:",
    "- Echo the user's general rhythm and collaboration preference more than exact words.",
    "- Prefer clarity over flavor in technical, formal, upset, or high-stakes contexts.",
    "- Do not repeat a habit unless it fits naturally.",
    ...(preferences.length
      ? [
          "Interaction profile:",
          ...preferences.flatMap(({ preference }) => {
            const use = preference.useWhen.length ? ` Use: ${preference.useWhen.join(", ")}.` : "";
            const avoid = preference.avoidWhen.length
              ? ` Avoid: ${preference.avoidWhen.join(", ")}.`
              : "";
            const line = `- ${preference.category}: ${preference.text} (confidence ${preference.confidence.toFixed(2)}).${use}${avoid}`;
            return preference.example ? [line, `  e.g. "${preference.example}"`] : [line];
          }),
        ]
      : []),
    "Relevant habits:",
    ...habits.flatMap(({ habit }) => {
      const locale = habit.locale ? `, ${habit.locale}` : "";
      const use = habit.useWhen.length ? ` Use: ${habit.useWhen.join(", ")}.` : "";
      const avoid = habit.avoidWhen.length ? ` Avoid: ${habit.avoidWhen.join(", ")}.` : "";
      const line = `- ${habit.kind}${locale}: "${habit.text}" (confidence ${habit.confidence.toFixed(2)}).${use}${avoid}`;
      return habit.example ? [line, `  e.g. "${habit.example}"`] : [line];
    }),
  ].join("\n");
}

export async function listStyleHabits(): Promise<StyleHabit[]> {
  const store = await loadStore();
  return [...store.habits].sort((a, b) => b.confidence - a.confidence || b.seenCount - a.seenCount);
}

export async function listInteractionProfile(): Promise<InteractionPreference[]> {
  const store = await loadStore();
  return [...store.profile.preferences].sort(
    (a, b) => b.confidence - a.confidence || b.seenCount - a.seenCount,
  );
}

export async function reviewInteractionProfile(limit = 12): Promise<ProfileReviewResult> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  if (cleanup.archived || cleanup.deleted) await saveStore(store);

  const preferences = store.profile.preferences;
  const suggestions = [...preferences]
    .sort((a, b) => profileReviewPriority(b) - profileReviewPriority(a))
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map(toProfileReviewSuggestion);

  return {
    summary: {
      total: preferences.length,
      active: preferences.filter((preference) => preference.status === "active").length,
      candidates: preferences.filter((preference) => preference.status === "candidate").length,
      archived: preferences.filter((preference) => preference.status === "archived").length,
      pinned: preferences.filter((preference) => preference.pinned).length,
      allowLearning: store.settings.allowLearning,
    },
    suggestions,
  };
}

export async function reviewStyleHabits(limit = 12): Promise<ReviewResult> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  if (cleanup.archived || cleanup.deleted) await saveStore(store);

  const suggestions = [...store.habits]
    .sort((a, b) => reviewPriority(b) - reviewPriority(a))
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map(toReviewSuggestion);

  return {
    summary: {
      total: store.habits.length,
      active: store.habits.filter((habit) => habit.status === "active").length,
      candidates: store.habits.filter((habit) => habit.status === "candidate").length,
      archived: store.habits.filter((habit) => habit.status === "archived").length,
      pinned: store.habits.filter((habit) => habit.pinned).length,
      allowLearning: store.settings.allowLearning,
    },
    suggestions,
  };
}

export async function getStyleMemoryScore(): Promise<StyleMemoryScore> {
  const store = await loadStore();
  const cleanup = cleanupStore(store);
  if (cleanup.archived || cleanup.deleted) await saveStore(store);

  const habits = store.habits;
  const preferences = store.profile.preferences;
  const allItems = [...habits, ...preferences];
  const activeHabits = habits.filter((habit) => habit.status === "active");
  const candidateHabits = habits.filter((habit) => habit.status === "candidate");
  const archivedHabits = habits.filter((habit) => habit.status === "archived");
  const activeProfilePreferences = preferences.filter(
    (preference) => preference.status === "active",
  );
  const candidateProfilePreferences = preferences.filter(
    (preference) => preference.status === "candidate",
  );
  const archivedProfilePreferences = preferences.filter(
    (preference) => preference.status === "archived",
  );

  const activeItems = [...activeHabits, ...activeProfilePreferences];
  const candidateItems = [...candidateHabits, ...candidateProfilePreferences];
  const pinnedItems = allItems.filter((item) => item.pinned).length;

  const activeCoverage = Math.min(1, activeItems.length / 6);
  const profileCoverage = activeProfilePreferences.length > 0 ? 1 : 0;
  const readiness = score(20 + activeCoverage * 60 + profileCoverage * 20);

  const stableSeenCounts = activeItems.length
    ? average(activeItems.map((item) => Math.min(1, item.seenCount / 5)))
    : 0;
  const stableConfidence = activeItems.length
    ? average(activeItems.map((item) => item.confidence))
    : 0;
  const candidatePenalty = allItems.length ? candidateItems.length / allItems.length : 0;
  const stability = score((stableSeenCounts * 0.45 + stableConfidence * 0.55) * 100 - candidatePenalty * 20);

  const newestSeenAt = newestDate(allItems.map((item) => item.lastSeenAt));
  const freshness = newestSeenAt
    ? score(100 - Math.min(100, ageDays(newestSeenAt) * 4))
    : 0;

  const driftRisk = score(
    candidateItems.length * 7 +
      archivedHabits.length * 3 +
      archivedProfilePreferences.length * 3 +
      Math.max(0, candidateItems.length - activeItems.length) * 6,
  );

  const expressiveHabits = habits.filter((habit) =>
    ["catchphrase", "dialect_marker", "emoji", "punctuation", "sentence_final_particle", "idiolect"].includes(
      habit.kind,
    ),
  );
  const overfitRisk = score(
    expressiveHabits.length * 6 +
      Math.max(0, expressiveHabits.length - activeProfilePreferences.length * 2) * 5,
  );

  const briefRefreshRecommended = activeItems.some(
    (item) => !item.lastReturnedAt || item.lastSeenAt > item.lastReturnedAt,
  );
  const overall = score(
    readiness * 0.38 +
      stability * 0.32 +
      freshness * 0.15 +
      (100 - driftRisk) * 0.1 +
      (100 - overfitRisk) * 0.05,
  );

  const recommendations: string[] = [];
  if (activeItems.length === 0) {
    recommendations.push("Keep learning: no active style or interaction profile items are ready yet.");
  }
  if (activeProfilePreferences.length === 0) {
    recommendations.push("Seed at least one concrete interaction preference so the agent learns how to collaborate, not just how the user writes.");
  }
  if (candidateItems.length >= Math.max(6, activeItems.length * 2)) {
    recommendations.push("Review candidates: many unconfirmed items may increase drift.");
  }
  if (overfitRisk >= 60) {
    recommendations.push("Use style lightly: expressive habits are dense, so avoid mechanical imitation.");
  }
  if (briefRefreshRecommended) {
    recommendations.push("Refresh alignment: call get_style_brief before the next substantial reply.");
  }
  if (!store.settings.allowLearning) {
    recommendations.push("Learning is off: the store is in read-only reuse mode.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Memory looks usable: keep observing lightly and refresh the brief periodically.");
  }

  return {
    overall,
    readiness,
    stability,
    freshness,
    driftRisk,
    overfitRisk,
    briefRefreshRecommended,
    counts: {
      habits: habits.length,
      activeHabits: activeHabits.length,
      candidateHabits: candidateHabits.length,
      archivedHabits: archivedHabits.length,
      profilePreferences: preferences.length,
      activeProfilePreferences: activeProfilePreferences.length,
      candidateProfilePreferences: candidateProfilePreferences.length,
      archivedProfilePreferences: archivedProfilePreferences.length,
      pinnedItems,
    },
    recommendations,
  };
}

export async function forgetStyleHabit(idOrText: string): Promise<boolean> {
  const store = await loadStore();
  const before = store.habits.length;
  // Match by id first (precise), then fall back to text (case-insensitive)
  store.habits = store.habits.filter(
    (habit) =>
      habit.id !== idOrText &&
      habit.text.toLowerCase() !== idOrText.toLowerCase(),
  );
  await saveStore(store);
  return store.habits.length !== before;
}

export async function forgetInteractionPreference(idOrText: string): Promise<boolean> {
  const store = await loadStore();
  const before = store.profile.preferences.length;
  const needle = idOrText.toLowerCase();
  store.profile.preferences = store.profile.preferences.filter(
    (preference) =>
      preference.id !== idOrText &&
      preference.text.toLowerCase() !== needle,
  );
  await saveStore(store);
  return store.profile.preferences.length !== before;
}

export async function pinStyleHabit(idOrText: string, pinned = true): Promise<boolean> {
  const store = await loadStore();
  // Match by id first, then by text as fallback
  const habit = store.habits.find(
    (item) =>
      item.id === idOrText || item.text.toLowerCase() === idOrText.toLowerCase(),
  );
  if (!habit) return false;
  habit.pinned = pinned;
  await saveStore(store);
  return true;
}

export async function pinInteractionPreference(
  idOrText: string,
  pinned = true,
): Promise<boolean> {
  const store = await loadStore();
  const needle = idOrText.toLowerCase();
  const preference = store.profile.preferences.find(
    (item) => item.id === idOrText || item.text.toLowerCase() === needle,
  );
  if (!preference) return false;
  preference.pinned = pinned;
  await saveStore(store);
  return true;
}

// =============================================================================
// Internal: hint normalization + upsert
// =============================================================================

/**
 * Validate & normalize an incoming hints array into the same `ExtractedHabit`
 * shape that `extractHabits` produces. Invalid entries are dropped (with a
 * note pushed into `ignored`) rather than failing the whole call.
 */
function normalizeHints(
  hints: HintInput[] | undefined,
  ignored: string[],
  maxExampleLen: number,
): ExtractedHabit[] {
  if (!hints || hints.length === 0) return [];

  const out: ExtractedHabit[] = [];

  for (const hint of hints) {
    if (!hint || typeof hint !== "object") {
      ignored.push("hint_malformed");
      continue;
    }

    if (!VALID_KINDS.has(hint.kind)) {
      ignored.push(`hint_unknown_kind:${hint.kind}`);
      continue;
    }

    const text = typeof hint.text === "string" ? hint.text.trim() : "";
    if (!text || text.length > HINT_MAX_TEXT_LEN) {
      ignored.push("hint_bad_text");
      continue;
    }
    if (isSensitive(text)) {
      ignored.push("hint_sensitive");
      continue;
    }

    // Scale the base delta by host LLM's self-rated confidence.
    // confidence 0 → 0.5×, 1 → 2× — clamped to [0.05, 0.25].
    const conf =
      typeof hint.confidence === "number" && hint.confidence >= 0 && hint.confidence <= 1
        ? hint.confidence
        : 0.5;
    const scaled = HINT_BASE_DELTA * (0.5 + 1.5 * conf);
    const confidenceDelta = Math.min(HINT_DELTA_MAX, Math.max(HINT_DELTA_MIN, scaled));

    const example = sanitizeExample(hint.example, maxExampleLen);
    const notes =
      typeof hint.notes === "string" && !isSensitive(hint.notes)
        ? hint.notes.slice(0, 160)
        : undefined;

    out.push({
      kind: hint.kind,
      text,
      locale: cleanLabel(hint.locale, 40),
      confidenceDelta,
      useWhen: Array.isArray(hint.useWhen)
        ? cleanLabelList(hint.useWhen, 8)
        : defaultUseWhen(hint.kind),
      avoidWhen: Array.isArray(hint.avoidWhen)
        ? cleanLabelList(hint.avoidWhen, 8)
        : defaultAvoidWhen(hint.kind),
      notes,
      example,
      source: "hint",
    });
  }

  return out;
}

interface NormalizedProfileHint {
  category: InteractionPreferenceCategory;
  text: string;
  confidenceDelta: number;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
  example?: string;
  source?: "hint" | "distill";
}

function normalizeProfileHints(
  hints: ProfileHintInput[] | undefined,
  ignored: string[],
  maxExampleLen: number,
): NormalizedProfileHint[] {
  if (!hints || hints.length === 0) return [];

  const out: NormalizedProfileHint[] = [];
  for (const hint of hints) {
    if (!hint || typeof hint !== "object") {
      ignored.push("profile_hint_malformed");
      continue;
    }

    if (!VALID_PROFILE_CATEGORIES.has(hint.category)) {
      ignored.push(`profile_hint_unknown_category:${hint.category}`);
      continue;
    }

    const text = typeof hint.text === "string" ? hint.text.trim() : "";
    if (!text || text.length > 120) {
      ignored.push("profile_hint_bad_text");
      continue;
    }
    if (isSensitive(text) || BLOCKED_PROFILE_LABEL_RE.test(text)) {
      ignored.push("profile_hint_sensitive_or_label");
      continue;
    }

    const conf =
      typeof hint.confidence === "number" && hint.confidence >= 0 && hint.confidence <= 1
        ? hint.confidence
        : 0.5;
    const scaled = HINT_BASE_DELTA * (0.5 + 1.5 * conf);
    const confidenceDelta = Math.min(HINT_DELTA_MAX, Math.max(HINT_DELTA_MIN, scaled));
    const notes =
      typeof hint.notes === "string" &&
      !isSensitive(hint.notes) &&
      !BLOCKED_PROFILE_LABEL_RE.test(hint.notes)
        ? hint.notes.slice(0, 160)
        : undefined;

    out.push({
      category: hint.category,
      text,
      confidenceDelta,
      useWhen: Array.isArray(hint.useWhen) ? cleanLabelList(hint.useWhen, 8) : ["general"],
      avoidWhen: Array.isArray(hint.avoidWhen)
        ? cleanLabelList(hint.avoidWhen, 8)
        : ["high_stakes_advice"],
      notes,
      example: sanitizeExample(hint.example, maxExampleLen),
      source: "hint",
    });
  }

  return out;
}

function defaultUseWhen(_kind: HabitKind): string[] {
  // Safe defaults that mirror catchphrase semantics — anything more
  // specific should come from the hint itself.
  return ["casual_chat"];
}

function defaultAvoidWhen(_kind: HabitKind): string[] {
  return ["formal_writing", "high_stakes_advice"];
}

function cleanLabel(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLen || isSensitive(text)) return undefined;
  return text;
}

function cleanLabelList(values: unknown[], maxItems: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const label = cleanLabel(value, 40);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= maxItems) break;
  }
  return out;
}

function reviewPriority(habit: StyleHabit): number {
  let score = habit.confidence + habit.seenCount * 0.02;
  if (habit.status === "candidate") score += 0.25;
  if (habit.status === "archived") score += 0.15;
  if (habit.pinned) score -= 0.2;
  return score;
}

function profileReviewPriority(preference: InteractionPreference): number {
  let score = preference.confidence + preference.seenCount * 0.02;
  if (preference.status === "candidate") score += 0.25;
  if (preference.status === "archived") score += 0.15;
  if (preference.pinned) score -= 0.2;
  return score;
}

function toReviewSuggestion(habit: StyleHabit): ReviewSuggestion {
  if (habit.pinned) {
    return baseReviewSuggestion(habit, "keep", "Pinned by user; keep unless it no longer feels accurate.");
  }

  if (habit.status === "archived") {
    return baseReviewSuggestion(habit, "forget", "Archived and no longer active; consider forgetting it.");
  }

  if (habit.status === "active" && habit.confidence >= 0.7 && habit.seenCount >= 5) {
    return baseReviewSuggestion(habit, "pin", "Strong active signal; consider pinning if it feels essential.");
  }

  if (habit.status === "candidate") {
    return baseReviewSuggestion(
      habit,
      habit.seenCount <= 1 && habit.confidence < 0.25 ? "forget" : "observe",
      habit.seenCount <= 1 && habit.confidence < 0.25
        ? "Weak one-off candidate; consider forgetting it."
        : "Candidate still needs more observations before becoming stable.",
    );
  }

  return baseReviewSuggestion(habit, "keep", "Active style signal; keep observing.");
}

function toProfileReviewSuggestion(
  preference: InteractionPreference,
): ProfileReviewSuggestion {
  if (preference.pinned) {
    return baseProfileReviewSuggestion(
      preference,
      "keep",
      "Pinned by user; keep unless it no longer matches how the agent should collaborate.",
    );
  }

  if (preference.status === "archived") {
    return baseProfileReviewSuggestion(
      preference,
      "forget",
      "Archived and no longer active; consider forgetting it.",
    );
  }

  if (preference.status === "active" && preference.confidence >= 0.7 && preference.seenCount >= 5) {
    return baseProfileReviewSuggestion(
      preference,
      "pin",
      "Strong active collaboration preference; consider pinning if it still feels right.",
    );
  }

  if (preference.status === "candidate") {
    return baseProfileReviewSuggestion(
      preference,
      preference.seenCount <= 1 && preference.confidence < 0.25 ? "forget" : "observe",
      preference.seenCount <= 1 && preference.confidence < 0.25
        ? "Weak one-off collaboration preference; consider forgetting it."
        : "Candidate still needs more observations before becoming stable.",
    );
  }

  return baseProfileReviewSuggestion(
    preference,
    "keep",
    "Active collaboration preference; keep observing.",
  );
}

function baseReviewSuggestion(
  habit: StyleHabit,
  suggestedAction: ReviewSuggestion["suggestedAction"],
  reason: string,
): ReviewSuggestion {
  return {
    id: habit.id,
    kind: habit.kind,
    text: habit.text,
    status: habit.status,
    confidence: habit.confidence,
    seenCount: habit.seenCount,
    pinned: habit.pinned,
    lastSeenAt: habit.lastSeenAt,
    suggestedAction,
    reason,
    useWhen: habit.useWhen,
    avoidWhen: habit.avoidWhen,
    example: habit.example,
  };
}

function baseProfileReviewSuggestion(
  preference: InteractionPreference,
  suggestedAction: ReviewSuggestion["suggestedAction"],
  reason: string,
): ProfileReviewSuggestion {
  return {
    id: preference.id,
    category: preference.category,
    text: preference.text,
    status: preference.status,
    confidence: preference.confidence,
    seenCount: preference.seenCount,
    pinned: preference.pinned,
    lastSeenAt: preference.lastSeenAt,
    suggestedAction,
    reason,
    useWhen: preference.useWhen,
    avoidWhen: preference.avoidWhen,
    example: preference.example,
  };
}

function score(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function newestDate(values: Array<string | undefined>): Date | undefined {
  let newest: Date | undefined;
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!newest || date > newest) newest = date;
  }
  return newest;
}

function ageDays(date: Date): number {
  return Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
}

function upsertPreference(
  preferences: InteractionPreference[],
  item: NormalizedProfileHint,
  now: string,
  settings: StyleSettings,
  context?: string,
): { preference: InteractionPreference; isNew: boolean } {
  const id = makeProfileId(item.category, item.text);
  let preference = preferences.find(
    (candidate) =>
      candidate.id === id ||
      (candidate.category === item.category && candidate.text === item.text),
  );

  const initialSeenContexts = context ? [context] : undefined;

  if (!preference) {
    const isDistill = item.source === "distill";
    preference = {
      id,
      category: item.category,
      text: item.text,
      confidence: clamp(item.confidenceDelta),
      seenCount: isDistill ? settings.minPromoteCount : 1,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "candidate",
      pinned: false,
      useWhen: item.useWhen,
      avoidWhen: item.avoidWhen,
      notes: item.notes,
      example: item.example,
      seenContexts: initialSeenContexts,
      source: item.source ?? "hint",
    };
    preferences.push(preference);
    maybePromotePreference(preference, item, settings);
    return { preference, isNew: true };
  }

  preference.seenCount += 1;
  preference.lastSeenAt = now;
  preference.confidence = clamp(preference.confidence + item.confidenceDelta);
  preference.useWhen = mergeList(preference.useWhen, item.useWhen);
  preference.avoidWhen = mergeList(preference.avoidWhen, item.avoidWhen);
  preference.notes = preference.notes || item.notes;
  if (!preference.example && item.example) preference.example = item.example;

  if (context) {
    const existing = preference.seenContexts ?? [];
    if (!existing.includes(context)) {
      preference.seenContexts = [...existing, context].slice(-MAX_SEEN_CONTEXTS);
    }
  }

  if (preference.status === "archived") preference.status = "candidate";
  maybePromotePreference(preference, item, settings);

  return { preference, isNew: false };
}

function maybePromotePreference(
  preference: InteractionPreference,
  item: NormalizedProfileHint,
  settings: StyleSettings,
) {
  if (preference.status !== "candidate") return;
  if (preference.seenCount < settings.minPromoteCount) return;

  const contextsSeen = preference.seenContexts?.length ?? 0;
  // High-conviction hints can skip cross-context, but still need at least
  // HIGH_CONVICTION_MIN_SEEN observations — otherwise an overconfident
  // single hint would defeat the three-strike rule entirely.
  const isHighConfidenceHint =
    item.source === "hint" &&
    item.confidenceDelta >= HINT_HIGH_CONVICTION_DELTA &&
    preference.seenCount >= HIGH_CONVICTION_MIN_SEEN;
  const crossContextOk =
    contextsSeen >= 2 ||
    isHighConfidenceHint ||
    item.source === "distill" ||
    contextsSeen === 0;
  if (!crossContextOk) return;

  preference.status = "active";
  preference.confidence = Math.max(preference.confidence, 0.35);
}

function upsertHabit(
  habits: StyleHabit[],
  item: ExtractedHabit,
  now: string,
  settings: StyleSettings,
  context?: string,
): { habit: StyleHabit; isNew: boolean } {
  const id = makeId(item.kind, item.text, item.locale);
  let habit = habits.find(
    (candidate) =>
      candidate.id === id ||
      (candidate.kind === item.kind &&
        candidate.text === item.text &&
        (candidate.locale || "") === (item.locale || "")),
  );

  const initialSeenContexts = context ? [context] : undefined;

  if (!habit) {
    const isDistill = item.source === "distill";
    habit = {
      id,
      kind: item.kind,
      text: item.text,
      locale: item.locale,
      confidence: clamp(item.confidenceDelta),
      // Distilled habits arrive pre-endorsed: jump straight to the promote
      // threshold so a single batch can make them active.
      seenCount: isDistill ? settings.minPromoteCount : 1,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "candidate",
      pinned: false,
      useWhen: item.useWhen,
      avoidWhen: item.avoidWhen,
      notes: item.notes,
      example: item.example,
      seenContexts: initialSeenContexts,
      source: item.source ?? "rule",
    };
    habits.push(habit);
    // A brand-new distilled habit may already qualify for active — run
    // the promote check once so the caller sees a usable state.
    maybePromote(habit, item, settings);
    return { habit, isNew: true };
  }

  habit.seenCount += 1;
  habit.lastSeenAt = now;
  habit.confidence = clamp(habit.confidence + item.confidenceDelta);
  habit.useWhen = mergeList(habit.useWhen, item.useWhen);
  habit.avoidWhen = mergeList(habit.avoidWhen, item.avoidWhen);
  habit.notes = habit.notes || item.notes;

  // Fill example if we don't have one yet. We don't overwrite an existing
  // one — the first reasonable example is usually fine and constant
  // churning would just chew through writes.
  if (!habit.example && item.example) habit.example = item.example;

  if (context) {
    const existing = habit.seenContexts ?? [];
    if (!existing.includes(context)) {
      habit.seenContexts = [...existing, context].slice(-MAX_SEEN_CONTEXTS);
    }
  }

  // An archived habit re-appearing: revive as candidate.
  // It won't promote to active until it satisfies the promote gates again,
  // which prevents a single accidental use from resurrecting an old habit.
  if (habit.status === "archived") {
    habit.status = "candidate";
  }

  maybePromote(habit, item, settings);

  return { habit, isNew: false };
}

/**
 * Promote candidate → active when BOTH gates pass:
 *   1. seenCount ≥ minPromoteCount (the original rule)
 *   2. seen under ≥2 distinct context labels (nuwa-style cross-domain check)
 *
 * Bypass for the cross-context gate:
 *   - Distilled habits skip both gates (handled by seedCount in upsert).
 *   - Hints with self-rated confidence ≥ HIGH_CONFIDENCE_BYPASS skip
 *     the cross-context gate — high-conviction idiolect doesn't need
 *     to wait for a second chat type to show up. BUT the habit must
 *     still have been observed ≥ HIGH_CONVICTION_MIN_SEEN times so a
 *     single overconfident LLM call can't promote on first sighting.
 *   - If the agent has NEVER passed a context label for this habit
 *     (legacy v0.1 callers, untyped clients), fall back to the
 *     count-only rule — refusing to ever promote them would be
 *     a silent regression.
 */
function maybePromote(habit: StyleHabit, item: ExtractedHabit, settings: StyleSettings) {
  if (habit.status !== "candidate") return;
  if (habit.seenCount < settings.minPromoteCount) return;

  const contextsSeen = habit.seenContexts?.length ?? 0;
  const isHighConfidenceHint =
    item.source === "hint" &&
    item.confidenceDelta >= HINT_HIGH_CONVICTION_DELTA &&
    habit.seenCount >= HIGH_CONVICTION_MIN_SEEN;
  const isLegacyNoContext = contextsSeen === 0; // caller never used the context field
  const crossContextOk =
    contextsSeen >= 2 ||
    isHighConfidenceHint ||
    item.source === "distill" ||
    isLegacyNoContext;
  if (!crossContextOk) return;

  habit.status = "active";
  habit.confidence = Math.max(habit.confidence, 0.35);
}

/**
 * Merge two string arrays, deduplicating entries.
 * Capped at 12 entries to prevent unbounded growth.
 * When at capacity, new values are still added (pushing out oldest extras).
 */
function mergeList(a: string[], b: string[]): string[] {
  // Keep existing values, append truly new ones from b
  const existing = new Set(a);
  const added: string[] = [];
  for (const item of b) {
    if (!existing.has(item)) {
      existing.add(item);
      added.push(item);
    }
  }
  const merged = [...a, ...added];
  return merged.slice(-12); // keep the most recent 12
}
