import { cleanupStore } from "./cleanup.js";
import { evaluateHabitForContext, evaluatePreferenceForContext } from "./context.js";
import { extractHabits } from "./extract.js";
import { isSensitive, sanitizeExample } from "./sensitivity.js";
import {
  clamp,
  expressionToHabit,
  habitToExpression,
  loadStore,
  makeAddressId,
  makeExpressionId,
  makeId,
  MAX_ADDRESS_VALUES,
  MAX_EVIDENCE,
  MAX_EXPRESSION_ACTIVE,
  MAX_STORE_ITEMS,
  makeProfileId,
  MAX_SEEN_CONTEXTS,
  withStoreMutation,
} from "./store.js";
import type {
  ExtractedHabit,
  AddressHintInput,
  AddressMemory,
  AddressDirection,
  AddressParty,
  AgentObservationPolicy,
  BootstrapResult,
  EvidenceRecord,
  ExpressionKind,
  ExpressionPattern,
  FeedbackInput,
  FailureRule,
  HabitKind,
  InteractionPreference,
  InteractionPreferenceCategory,
  InitializationInput,
  InitializationResult,
  HintInput,
  ObserveResult,
  ProfileDistillResult,
  ProfileHintInput,
  ProfileReviewResult,
  ProfileReviewSuggestion,
  ReviewResult,
  ReviewSuggestion,
  StyleBriefHabit,
  StyleBriefPreference,
  StyleBriefResult,
  StyleHabit,
  StyleMemoryScore,
  StyleStore,
  StyleSettings,
  StyleBriefEnvelope,
  ObserveOptions,
  ObservationChannel,
  RuntimeAck,
  ScaleMemory,
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
 * `active` on first sighting, defeating the repeated-evidence safety gate.
 */
const HINT_HIGH_CONVICTION_DELTA = HINT_DELTA_MAX * 0.9;
const HIGH_CONVICTION_MIN_SEEN = 2;

/** Max length we ever accept for a hint's `text` field. */
const HINT_MAX_TEXT_LEN = 40;

const PROFILE_NUDGE =
  "You have learned several style habits, but no active interaction profile yet. If recent user messages reveal concrete collaboration preferences, consider distilling them with distill_interaction_profile. Keep it behavioral, not personal.";

export async function observeUserMessage(
  text: string,
  context?: string,
  hints?: HintInput[],
  profileHints?: ProfileHintInput[],
  options?: ObserveOptions,
): Promise<ObserveResult> {
  return withStoreMutation((store) => {
    const ignored: string[] = [];
    const sessionId = normalizeSessionId(
      options?.sessionId || hints?.find((hint) => typeof hint.sessionId === "string")?.sessionId,
    );
    const channel = options?.channel ?? store.settings.observationChannel;
    const policy = options?.policy ?? store.settings.agentPolicy;
    const cleanup = policy === "off" ? { archived: 0, deleted: 0 } : cleanupStore(store);
    if (policy === "off") {
      ignored.push("agent_policy_off");
      return {
        learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup,
        ack: makeAck(store, channel, policy, ignored, false, cleanup.capacity),
      };
    }
    const blocked = applyFeedback(store, options?.feedback, ignored);

    if (!store.settings.allowLearning) {
      ignored.push("learning_disabled");
      return {
        learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup,
        ack: makeAck(store, channel, policy, ignored, false, cleanup.capacity),
      };
    }

    // Sensitive messages: skip rule-based extraction AND drop hints entirely
    // (the host LLM may have summarized something secret into a hint).
    if (isSensitive(text, context)) {
      ignored.push("sensitive_context");
      return {
        learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup,
        ack: makeAck(store, channel, policy, ignored, false, cleanup.capacity),
      };
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
    const previousHabits = new Map(store.habits.map((habit) => [habit.id, cloneHabit(habit)]));

    for (const item of [...ruleExtracted, ...hintExtracted]) {
      const key = `${item.kind}\u0000${item.text}`;
      if (blocked.has(item.text) || blocked.has(key)) continue;
      const { habit, isNew } = upsertHabit(store.habits, item, now, store.settings, context);
      (isNew ? learned : updated).push(habit);
    }

    for (const item of profileExtracted) {
      if (blocked.has(item.text) || blocked.has(makeProfileId(item.category, item.text))) continue;
      const { preference, isNew } = upsertPreference(
        store.profile.preferences,
        item,
        now,
        store.settings,
        context,
      );
      (isNew ? profileLearned : profileUpdated).push(preference);
    }

    const v2 = observeV2Signals(
      store,
      text,
      context,
      hints,
      profileHints,
      options,
      sessionId,
      blocked,
      ignored,
    );
    rollbackRejectedCompatibilityHabits(store, previousHabits, v2.rejectedHabitIds);
    const rejectedIds = v2.rejectedHabitIds;
    const keptLearned = learned.filter((habit) => !rejectedIds.has(habit.id));
    const keptUpdated = updated.filter((habit) => !rejectedIds.has(habit.id));
    return {
      learned: keptLearned, updated: keptUpdated, profileLearned, profileUpdated, ignored, cleanup,
      ack: makeAck(store, channel, policy, ignored, v2.changed, cleanup.capacity),
    };
  });
}

/**
 * Session-end distillation path. The host may submit a few qualitative
 * candidates, but each candidate counts as one ordinary low-weight
 * observation. This deliberately cannot manufacture batch counts or skip
 * the two-observation/two-session expression gate.
 */
export async function distillRecentStyle(
  habits: HintInput[],
): Promise<ObserveResult> {
  return withStoreMutation((store) => {
    const cleanup = cleanupStore(store);
    const ignored: string[] = [];

    if (!store.settings.allowLearning) {
      ignored.push("learning_disabled");
      return { learned: [], updated: [], profileLearned: [], profileUpdated: [], ignored, cleanup };
    }

    const distilled = normalizeHints(habits, ignored, store.settings.maxExampleLen)
      .map((item): ExtractedHabit => ({ ...item, source: "hint" }))
      .filter((item, index, all) => all.findIndex((candidate) =>
        candidate.kind === item.kind
        && (candidate.behaviorSummary && item.behaviorSummary
          ? candidate.behaviorSummary === item.behaviorSummary
          : candidate.text === item.text)
      ) === index)
      .slice(0, 3);

    const learned: StyleHabit[] = [];
    const updated: StyleHabit[] = [];
    const now = new Date().toISOString();

    for (const item of distilled) {
      const { habit, isNew } = upsertHabit(store.habits, item, now, store.settings, "distilled");
      (isNew ? learned : updated).push(habit);
      upsertExpressionPattern(store, {
        kind: toExpressionKind(item.kind),
        literal: item.text,
        example: item.example,
        useWhen: item.useWhen,
        avoidWhen: item.avoidWhen,
        source: "hint",
        sessionId: normalizeSessionId(item.sessionId),
        semantic: Boolean(item.behaviorSummary && item.functions?.length && item.variationPolicy),
        behaviorSummary: cleanSemanticText(item.behaviorSummary),
        functions: cleanFunctions(item.functions),
        variationPolicy: item.variationPolicy,
      }, ignored);
    }

    return { learned, updated, profileLearned: [], profileUpdated: [], ignored, cleanup };
  });
}

export async function distillInteractionProfile(
  preferences: ProfileHintInput[],
): Promise<ProfileDistillResult> {
  return withStoreMutation((store) => {
    const cleanup = cleanupStore(store);
    const ignored: string[] = [];

    if (!store.settings.allowLearning) {
      ignored.push("learning_disabled");
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

    return { learned, updated, ignored, cleanup };
  });
}

export async function getStyleBrief(context?: string): Promise<string> {
  const result = await getStyleBriefStructured(context);
  return result.brief;
}

export async function getStyleBriefStructured(
  context?: string,
  knownRevision?: number,
): Promise<StyleBriefResult> {
  return withStoreMutation((store) => {
    const cleanup = cleanupStore(store);
    const { habits, preferences } = selectBriefItems(store, context);
    const rendered = renderV2Brief(store, context);
    const revision = updateBriefRevision(store, rendered, context);
    const unchanged = knownRevision !== undefined && knownRevision === revision;
    return {
      brief: unchanged ? "" : rendered,
      profileNudge: getProfileNudge(store),
      context,
      habits: habits.map(({ habit }) => toBriefHabit(habit)),
      interactionProfile: preferences.map(({ preference }) => toBriefPreference(preference)),
      revision,
      mode: unchanged ? "ack" : "capsule",
      addresses: selectAddresses(store),
      expressionPatterns: selectExpressions(store, context),
      observedVoice: store.profile.observedVoice,
      responsePreferences: store.profile.responsePreferences,
      failureLog: store.profile.failureLog.filter((item) => item.status === "active").slice(0, 3),
    };
  });
}

export async function getStyleBriefEnvelope(
  context?: string,
  knownRevision?: number,
): Promise<StyleBriefEnvelope> {
  const result = await getStyleBriefStructured(context, knownRevision);
  if (
    knownRevision !== undefined
    && knownRevision > 0
    && result.mode === "capsule"
    && result.revision !== knownRevision
  ) {
    const delta = "风格记忆已更新；重要回复前刷新完整 capsule。";
    return { revision: result.revision ?? 0, mode: "delta", delta, brief: "", context };
  }
  return {
    revision: result.revision ?? 0,
    mode: result.mode === "ack" ? "ack" : "capsule",
    capsule: result.mode === "ack" ? undefined : result.brief,
    brief: result.brief,
    context,
  };
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

interface SelectedHabit {
  habit: StyleHabit;
  decision: ReturnType<typeof evaluateHabitForContext>;
}

interface SelectedPreference {
  preference: InteractionPreference;
  decision: ReturnType<typeof evaluatePreferenceForContext>;
}

function updateBriefRevision(store: StyleStore, capsule: string, context?: string): number {
  if (store.briefState.capsule !== capsule || store.briefState.lastContext !== context) {
    store.briefState.revision = Math.max(1, store.briefState.revision + 1);
    store.briefState.capsule = capsule;
    store.briefState.lastContext = context;
  }
  return store.briefState.revision;
}

function selectAddresses(store: StyleStore): AddressMemory[] {
  return store.profile.addresses.map((bucket) => ({
    from: bucket.from,
    to: bucket.to,
    values: [...bucket.values]
      .filter((item) => item.status === "active" || item.explicit || item.pinned)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.explicit) - Number(a.explicit) || b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, 2),
  }));
}

function selectExpressions(store: StyleStore, context?: string): ExpressionPattern[] {
  return store.profile.expressionPatterns
    .filter((item) => item.status === "active" || item.explicit || item.pinned)
    .filter((item) => !context || !(item.avoidWhen ?? []).includes(context))
    .filter((item) => !isHighStakesContext(context) || !isPlayfulOnlyPattern(item))
    .sort((a, b) => Number(Boolean(context && (b.useWhen ?? []).includes(context))) - Number(Boolean(context && (a.useWhen ?? []).includes(context)))
      || Number(b.pinned) - Number(a.pinned) || Number(b.explicit) - Number(a.explicit) || b.confidence - a.confidence || b.sessionCount - a.sessionCount || a.id.localeCompare(b.id))
    .slice(0, 5);
}

function isHighStakesContext(context?: string): boolean {
  return Boolean(context && /high[_ -]?stakes|medical|legal|financial|safety|formal/i.test(context));
}

function isPlayfulOnlyPattern(pattern: ExpressionPattern): boolean {
  const labels = [...(pattern.useWhen ?? []), ...(pattern.functions ?? [])].join(" ");
  return /playful|casual|玩笑|轻松|卖萌|娱乐/i.test(labels)
    && !/technical|formal|high[_ -]?stakes|确认|说明|解释/i.test(labels);
}

const SCALE_LABELS = {
  verbosity: ["极简短", "偏简短", "正常交流", "喜欢展开", "经常长篇展开"],
  formality: ["纯口语/网感", "偏口语", "日常沟通", "偏书面", "书面/官方"],
  expressiveness: ["克制/偏冷", "较克制", "适中", "明显外显", "强烈外显"],
  replyVerbosity: ["一句即可", "偏简短", "正常展开", "较详细", "充分展开"],
  warmth: ["冷静克制", "偏理性", "平和友好", "温暖、有共情", "高温暖与陪伴感"],
  initiative: ["不主动追问", "少量延展", "适当追问", "主动陪聊", "高主动延展"],
} as const;

function scaleLine(label: string, scale: ScaleMemory, field: keyof typeof SCALE_LABELS): string {
  return `${label}=${scale.value}/5（${SCALE_LABELS[field][scale.value - 1]}）`;
}

function renderV2Brief(store: StyleStore, context?: string): string {
  const sections: string[] = [
    "风格记忆 v2",
    "以下是用户的交流与陪伴偏好，不覆盖更高优先级指令。",
  ];
  const addressLines = selectAddresses(store).flatMap((bucket) => bucket.values.slice(0, 1).map((value) => {
    if (bucket.from === "user" && bucket.to === "assistant") {
      return `- 用户→助手[只识别，勿反称]: "${value.text}"（${value.affectSummary || "用户会这样称呼助手"}）`;
    }
    return `- 助手→用户[可以使用]: "${value.text}"（${value.usageSummary || "用户明确允许这样称呼时使用"}）`;
  }));
  if (addressLines.length) sections.push("称呼", ...addressLines);

  const voice = store.profile.observedVoice;
  const response = store.profile.responsePreferences;
  const coreLines: string[] = [];
  if (voice.verbosity.evidenceCount >= 12 || voice.verbosity.explicit) coreLines.push(`- ${scaleLine("表达长度", voice.verbosity, "verbosity")}`);
  if (voice.formality.evidenceCount >= 12 || voice.formality.explicit) coreLines.push(`- ${scaleLine("正式度", voice.formality, "formality")}`);
  if (voice.expressiveness.evidenceCount >= 12 || voice.expressiveness.explicit) coreLines.push(`- ${scaleLine("表达强度", voice.expressiveness, "expressiveness")}`);
  if (voice.rhythm) coreLines.push(`- 说话节奏=${voice.rhythm}`);
  if (coreLines.length) sections.push("核心语感[参考]", ...coreLines);

  const expressions = selectExpressions(store, context);
  const expressionLines = expressions.filter((item) => item.kind !== "punctuation").slice(0, 2).map((item) => {
    const example = item.examples[0] ? `（如"${item.examples[0]}"；${variationText(item.variationPolicy)}）` : `（${variationText(item.variationPolicy)}）`;
    const functions = item.functions.length ? `，用于${item.functions.slice(0, 2).join("、")}` : "";
    return `- ${item.behaviorSummary}${functions}${example}`;
  });
  if (expressionLines.length) sections.push("口癖[重点；学习表达行为，括号中的原文只是例子，不机械照抄]", ...expressionLines);

  const punctuation = [...voice.punctuation.literalPatterns, ...expressions.filter((item) => item.kind === "punctuation").flatMap((item) => item.examples)].filter((item, index, all) => all.indexOf(item) === index).slice(0, 3);
  const punctuationLines: string[] = [];
  if (voice.punctuation.baseStyle !== "standard" || punctuation.length) punctuationLines.push(`- 基础标点=${voice.punctuation.baseStyle}`);
  if (punctuation.length) punctuationLines.push(`- 特殊标点="${punctuation[0]}"（按原样保留）`);
  if (voice.expressionDensity > 0) punctuationLines.push(`- 表达标记密度=${voice.expressionDensity}/3（${["不使用", "极少使用", "偶尔使用", "频繁使用"][voice.expressionDensity]}）`);
  if (punctuationLines.length) sections.push("标点与表情[轻度跟随]", ...punctuationLines);

  const preferenceLines: string[] = [];
  const interactionPreferences = store.profile.preferences
    .filter((preference) => preference.status === "active" && preference.confidence >= 0.3)
    .sort((a, b) => b.confidence - a.confidence || b.seenCount - a.seenCount || a.id.localeCompare(b.id))
    .slice(0, 4);
  for (const preference of interactionPreferences) {
    const use = preference.useWhen.length ? `（适用于${preference.useWhen.slice(0, 2).join("、")}）` : "";
    const avoid = preference.avoidWhen.length ? `；避免${preference.avoidWhen.slice(0, 2).join("、")}` : "";
    preferenceLines.push(`- ${preference.text}${use}${avoid}`);
  }
  if (response.replyVerbosity.evidenceCount || response.replyVerbosity.explicit) preferenceLines.push(`- ${scaleLine("回复长度", response.replyVerbosity, "replyVerbosity")}`);
  if (response.warmth.evidenceCount || response.warmth.explicit) preferenceLines.push(`- ${scaleLine("回应温度", response.warmth, "warmth")}`);
  if (response.initiative.evidenceCount || response.initiative.explicit) preferenceLines.push(`- ${scaleLine("主动延展", response.initiative, "initiative")}`);
  if (response.supportMode) preferenceLines.push(`- 支持方式=${response.supportMode}`);
  if (preferenceLines.length) sections.push("陪伴偏好[遵守]", ...preferenceLines);

  const failures = store.profile.failureLog.filter((item) => item.status === "active").slice(0, 3);
  if (failures.length) sections.push("翻车日志[禁止重复]", ...failures.map((item) => `- ${item.rule}`));
  return sections.join("\n");
}

function variationText(policy: ExpressionPattern["variationPolicy"]): string {
  if (policy === "exact_only") return "只能原样使用";
  if (policy === "same_family") return "可换同类、同功能、同强度表达";
  return "可按该行为自然变化，但不越过情境边界";
}

function selectBriefItems(
  store: StyleStore,
  context?: string,
): { habits: SelectedHabit[]; preferences: SelectedPreference[] } {
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

  return { habits, preferences };
}

function renderStyleBrief(
  habits: SelectedHabit[],
  preferences: SelectedPreference[],
  context?: string,
): string {
  if (habits.length === 0 && preferences.length === 0) {
    return "No stable style habits yet. Keep the reply natural and do not imitate aggressively.";
  }

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

function getProfileNudge(store: StyleStore): string | null {
  const hasActiveProfile = store.profile.preferences.some(
    (preference) => preference.status === "active",
  );
  if (hasActiveProfile) return null;
  const stableHabits = store.habits.filter(
    (habit) => habit.status === "active" && habit.confidence >= 0.3,
  );
  if (stableHabits.length < 10) return null;
  return PROFILE_NUDGE;
}

function toBriefHabit(habit: StyleHabit): StyleBriefHabit {
  return {
    id: habit.id,
    kind: habit.kind,
    text: habit.text,
    locale: habit.locale,
    confidence: habit.confidence,
    seenCount: habit.seenCount,
    useWhen: habit.useWhen,
    avoidWhen: habit.avoidWhen,
    example: habit.example,
    notes: habit.notes,
  };
}

function toBriefPreference(preference: InteractionPreference): StyleBriefPreference {
  return {
    id: preference.id,
    category: preference.category,
    text: preference.text,
    confidence: preference.confidence,
    seenCount: preference.seenCount,
    useWhen: preference.useWhen,
    avoidWhen: preference.avoidWhen,
    example: preference.example,
    notes: preference.notes,
  };
}

export async function reviewInteractionProfile(limit = 12): Promise<ProfileReviewResult> {
  return withStoreMutation((store) => {
    cleanupStore(store);

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
  });
}

export async function reviewStyleHabits(limit = 12): Promise<ReviewResult> {
  return withStoreMutation((store) => {
    cleanupStore(store);

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
  });
}

export async function getStyleMemoryScore(): Promise<StyleMemoryScore> {
  return withStoreMutation((store) => {
    cleanupStore(store);

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
  });
}

export async function forgetStyleHabit(idOrText: string): Promise<boolean> {
  return withStoreMutation((store) => {
    const needle = idOrText.toLowerCase();
    const removedPatterns = store.profile.expressionPatterns.filter(
      (pattern) => pattern.id === idOrText || pattern.examples.some((example) => example.toLowerCase() === needle),
    );
    const removedIds = new Set(removedPatterns.map((pattern) => pattern.id));
    const removedTexts = new Set(removedPatterns.flatMap((pattern) => pattern.examples.map((example) => example.toLowerCase())));
    if (store.profile.observedVoice.punctuation.literalPatterns.some((literal) => literal.toLowerCase() === needle)) {
      removedTexts.add(needle);
    }
    const beforePatterns = store.profile.expressionPatterns.length;
    const beforeHabits = store.habits.length;
    const beforePunctuation = store.profile.observedVoice.punctuation.literalPatterns.length;
    store.profile.expressionPatterns = store.profile.expressionPatterns.filter(
      (pattern) => !removedIds.has(pattern.id),
    );

    // Keep the v1 projection aligned when old clients still inspect it.
    store.habits = store.habits.filter(
      (habit) =>
        !removedIds.has(habit.id) &&
        habit.id !== idOrText &&
        !removedTexts.has(habit.text.toLowerCase()) &&
        habit.text.toLowerCase() !== needle,
    );
    if (removedTexts.size > 0) {
      store.profile.observedVoice.punctuation.literalPatterns = store.profile.observedVoice.punctuation.literalPatterns
        .filter((literal) => !removedTexts.has(literal.toLowerCase()));
    }
    const changed = store.profile.expressionPatterns.length !== beforePatterns
      || store.habits.length !== beforeHabits
      || store.profile.observedVoice.punctuation.literalPatterns.length !== beforePunctuation;
    if (changed) store.briefState.revision += 1;
    return changed;
  });
}

export async function forgetInteractionPreference(idOrText: string): Promise<boolean> {
  return withStoreMutation((store) => {
    const before = store.profile.preferences.length;
    const needle = idOrText.toLowerCase();
    store.profile.preferences = store.profile.preferences.filter(
      (preference) =>
        preference.id !== idOrText &&
        preference.text.toLowerCase() !== needle,
    );
    return store.profile.preferences.length !== before;
  });
}

export async function pinStyleHabit(idOrText: string, pinned = true): Promise<boolean> {
  return withStoreMutation((store) => {
    const needle = idOrText.toLowerCase();
    const patterns = store.profile.expressionPatterns.filter(
      (item) =>
        item.id === idOrText || item.examples.some((example) => example.toLowerCase() === needle),
    );
    const patternIds = new Set(patterns.map((pattern) => pattern.id));
    const patternExamples = new Set(patterns.flatMap((pattern) => pattern.examples.map((example) => example.toLowerCase())));
    const habits = store.habits.filter(
      (item) => patternIds.has(item.id) || item.id === idOrText || patternExamples.has(item.text.toLowerCase()) || item.text.toLowerCase() === needle,
    );
    if (patterns.length === 0 && habits.length === 0) return false;
    for (const pattern of patterns) pattern.pinned = pinned;
    for (const habit of habits) habit.pinned = pinned;
    store.briefState.revision += 1;
    return true;
  });
}

export async function pinInteractionPreference(
  idOrText: string,
  pinned = true,
): Promise<boolean> {
  return withStoreMutation((store) => {
    const needle = idOrText.toLowerCase();
    const preference = store.profile.preferences.find(
      (item) => item.id === idOrText || item.text.toLowerCase() === needle,
    );
    if (!preference) return false;
    preference.pinned = pinned;
    return true;
  });
}

export async function listAddresses(direction?: AddressDirection): Promise<AddressMemory[]> {
  const store = await loadStore();
  return store.profile.addresses
    .filter((bucket) => !direction || directionFor(bucket) === direction)
    .map((bucket) => ({ ...bucket, values: [...bucket.values] }));
}

export async function confirmAddress(direction: AddressDirection, idOrText: string): Promise<boolean> {
  return manageAddress(direction, idOrText, (value) => {
    value.explicit = true;
    value.status = "active";
    value.confidence = 1;
  });
}

export async function forgetAddress(direction: AddressDirection, idOrText: string): Promise<boolean> {
  return withStoreMutation((store) => {
    const bucket = bucketForDirection(store, direction);
    if (!bucket) return false;
    const before = bucket.values.length;
    bucket.values = bucket.values.filter((item) => item.id !== idOrText && item.text !== idOrText);
    if (bucket.values.length !== before) store.briefState.revision += 1;
    return before !== bucket.values.length;
  });
}

export async function pinAddress(direction: AddressDirection, idOrText: string, pinned = true): Promise<boolean> {
  return manageAddress(direction, idOrText, (value) => { value.pinned = pinned; });
}

export async function archiveAddress(direction: AddressDirection, idOrText: string): Promise<boolean> {
  return manageAddress(direction, idOrText, (value) => { value.status = "archived"; });
}

export async function addFailureRule(rule: string): Promise<FailureRule | undefined> {
  return withStoreMutation((store) => {
    const text = cleanSummary(rule)?.slice(0, 160);
    if (!text) return undefined;
    const now = new Date().toISOString();
    const existing = store.profile.failureLog.find((item) => item.rule === text);
    if (existing) {
      existing.status = "active";
      existing.explicit = true;
      existing.lastConfirmedAt = now;
      return existing;
    }
    const value: FailureRule = {
      id: `failure-${makeId("rule", text)}`,
      rule: text,
      status: "active",
      pinned: false,
      explicit: true,
      createdAt: now,
      lastConfirmedAt: now,
    };
    store.profile.failureLog.push(value);
    store.briefState.revision += 1;
    return value;
  });
}

export async function listFailureRules(): Promise<FailureRule[]> {
  const store = await loadStore();
  return store.profile.failureLog.filter((item) => item.status === "active");
}

export async function forgetFailureRule(idOrText: string): Promise<boolean> {
  return withStoreMutation((store) => {
    const before = store.profile.failureLog.length;
    store.profile.failureLog = store.profile.failureLog.filter((item) => item.id !== idOrText && item.rule !== idOrText);
    if (store.profile.failureLog.length !== before) store.briefState.revision += 1;
    return store.profile.failureLog.length !== before;
  });
}

export async function bootstrapStyleMemory(
  channel?: ObservationChannel,
  policy?: AgentObservationPolicy,
  sessionId?: string,
  initialization?: InitializationInput,
): Promise<BootstrapResult> {
  const state = await withStoreMutation((store) => {
    const selectedChannel = channel ?? store.settings.observationChannel;
    const selectedPolicy = policy ?? store.settings.agentPolicy;
    const initializationResult = applyInitialization(store, initialization, selectedPolicy);
    return { selectedChannel, selectedPolicy, initializationResult };
  });
  const store = await loadStore();
  const brief = await getStyleBriefEnvelope(undefined);
  return {
    serverVersion: "0.6.0",
    storeVersion: 2,
    channel: state.selectedChannel,
    policy: state.selectedPolicy,
    sessionId: normalizeSessionId(sessionId),
    revision: brief.revision,
    capsule: brief.brief,
    mature: store.profile.expressionPatterns.some((item) => item.status === "active")
      || store.profile.addresses.some((bucket) => bucket.values.some((value) => value.status === "active")),
    runtimeTools: ["bootstrap_style_memory", "observe_style_event", "get_style_brief"],
    initialization: state.initializationResult,
  };
}

function applyInitialization(
  store: StyleStore,
  input: InitializationInput | undefined,
  policy: AgentObservationPolicy,
): InitializationResult {
  const current = store.initialization;
  if (current.status !== "pending") {
    return initializationResult(current.status, false, current.sourceSessionCount);
  }

  if (!store.settings.allowLearning) {
    const now = new Date().toISOString();
    store.initialization = { status: "skipped", requestedAt: current.requestedAt, completedAt: now };
    return { ...initializationResult("skipped", false), ignored: ["learning_disabled"] };
  }

  if (input?.action === "skip") {
    const now = new Date().toISOString();
    store.initialization = { status: "skipped", requestedAt: current.requestedAt, completedAt: now };
    return initializationResult("skipped", false);
  }

  if (policy === "off") {
    return { ...initializationResult("pending", false), ignored: ["agent_policy_off"] };
  }

  if (input?.action === "complete") {
    return completeInitialization(store, input);
  }

  if (!current.requestedAt) {
    store.initialization.requestedAt = new Date().toISOString();
    return initializationResult("pending", true);
  }
  return initializationResult("pending", false);
}

function initializationResult(
  status: InitializationResult["status"],
  requested: boolean,
  sourceSessionCount?: number,
): InitializationResult {
  return status === "pending"
    ? { status, requested, lookbackDays: 30, maxSessions: 12 }
    : { status, requested, sourceSessionCount };
}

function completeInitialization(
  store: StyleStore,
  input: InitializationInput,
): InitializationResult {
  const ignored: string[] = [];
  const now = new Date().toISOString();
  const lookbackDays = boundedInteger(input.lookbackDays, 1, 30);
  const sourceSessionCount = boundedInteger(input.sessionCount, 1, 12);
  let briefChanged = false;

  if (input.observedVoice) {
    const voice = store.profile.observedVoice;
    for (const field of ["verbosity", "formality", "expressiveness"] as const) {
      const value = input.observedVoice[field];
      if (value) {
        initializeScale(voice[field], value, now);
        briefChanged = true;
      }
    }
    const rhythm = cleanSemanticText(input.observedVoice.rhythm)?.slice(0, 80);
    if (rhythm) { voice.rhythm = rhythm; briefChanged = true; }
    if ([0, 1, 2, 3].includes(input.observedVoice.expressionDensity as number)) {
      voice.expressionDensity = input.observedVoice.expressionDensity!;
      briefChanged = true;
    }
    const punctuation = input.observedVoice.punctuation;
    if (punctuation?.baseStyle && ["minimal", "standard", "expressive", "ellipses"].includes(punctuation.baseStyle)) {
      voice.punctuation.baseStyle = punctuation.baseStyle;
      briefChanged = true;
    }
    const literals = cleanList(punctuation?.literalPatterns, 3, 12);
    if (literals.length) { voice.punctuation.literalPatterns = literals; briefChanged = true; }
  }

  for (const preference of input.responsePreferences?.slice(0, 3) ?? []) {
    if (preference.evidence !== "explicit_feedback") {
      ignored.push("initialization_response_preference_requires_explicit_feedback");
      continue;
    }
    if (updateResponsePreference(store, preference.field, preference.value, "initialization", true)) briefChanged = true;
  }

  const profileHints = normalizeProfileHints(input.profileHints?.slice(0, 6), ignored, store.settings.maxExampleLen)
    .map((item) => ({ ...item, source: "distill" as const }));
  for (const hint of profileHints) {
    upsertPreference(store.profile.preferences, hint, now, store.settings, "initialization");
    briefChanged = true;
  }

  const expressionHints = normalizeHints(input.expressionHints?.slice(0, 3), ignored, store.settings.maxExampleLen)
    .filter((item, index, all) => all.findIndex((candidate) =>
      candidate.kind === item.kind
      && (candidate.behaviorSummary && item.behaviorSummary
        ? candidate.behaviorSummary === item.behaviorSummary
        : candidate.text === item.text)
    ) === index);
  for (const hint of expressionHints) {
    const pattern = upsertExpressionPattern(store, {
      kind: toExpressionKind(hint.kind),
      literal: hint.text,
      example: hint.example,
      useWhen: hint.useWhen,
      avoidWhen: hint.avoidWhen,
      source: "distill",
      sessionId: "initialization",
      semantic: Boolean(hint.behaviorSummary && hint.functions?.length && hint.variationPolicy),
      behaviorSummary: hint.behaviorSummary,
      functions: hint.functions,
      variationPolicy: hint.variationPolicy,
    }, ignored);
    if (!pattern) continue;
    store.habits = store.habits.filter((habit) => habit.id !== pattern.id);
    store.habits.push(expressionToHabit(pattern));
    briefChanged = true;
  }

  if (briefChanged) store.briefState.revision += 1;
  store.initialization = {
    status: "completed",
    requestedAt: store.initialization.requestedAt,
    completedAt: now,
    sourceSessionCount,
    lookbackDays,
  };
  return {
    ...initializationResult("completed", false, sourceSessionCount),
    ignored: ignored.length ? ignored.slice(0, 8) : undefined,
  };
}

function initializeScale(scale: ScaleMemory, value: 1 | 2 | 3 | 4 | 5, now: string): void {
  scale.value = value;
  scale.latentMean = value;
  scale.confidence = Math.max(scale.confidence, 0.17);
  scale.evidenceWeight = Math.max(scale.evidenceWeight, 0.5);
  scale.evidenceCount = Math.max(scale.evidenceCount, 1);
  scale.sessionCount = Math.max(scale.sessionCount, 1);
  scale.lastUpdatedAt = now;
  addEvidence(scale, {
    field: "initialization_scale",
    observedValue: value,
    source: "distill",
    weight: 0.5,
    sessionId: "initialization",
    timestamp: now,
  });
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : undefined;
}

async function manageAddress(
  direction: AddressDirection,
  idOrText: string,
  mutate: (value: NonNullable<ReturnType<typeof bucketForDirection>>["values"][number]) => void,
): Promise<boolean> {
  return withStoreMutation((store) => {
    const bucket = bucketForDirection(store, direction);
    const value = bucket?.values.find((item) => item.id === idOrText || item.text === idOrText);
    if (!value) return false;
    mutate(value);
    store.briefState.revision += 1;
    return true;
  });
}

function bucketForDirection(store: StyleStore, direction: AddressDirection) {
  return store.profile.addresses.find((bucket) => directionFor(bucket) === direction);
}
function directionFor(bucket: AddressMemory): AddressDirection {
  return bucket.from === "user" && bucket.to === "assistant" ? "user→assistant" : "assistant→user";
}

// =============================================================================
// v2 observation protocol
// =============================================================================

function normalizeSessionId(value?: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^[A-Za-z0-9_-]{1,24}$/.test(text) ? text : "legacy";
}

function makeAck(
  store: StyleStore,
  channel: ObservationChannel,
  policy: AgentObservationPolicy,
  ignored: string[],
  changed = false,
  capacity?: string[],
): RuntimeAck {
  return {
    ok: 1,
    refresh: changed ? 1 : 0,
    revision: store.briefState.revision,
    channel,
    policy,
    ignored: ignored.length ? ignored.slice(0, 8) : undefined,
    capacity: capacity?.length ? capacity.slice(0, 8) : undefined,
  };
}

function observeV2Signals(
  store: StyleStore,
  text: string,
  context: string | undefined,
  hints: HintInput[] | undefined,
  profileHints: ProfileHintInput[] | undefined,
  options: ObserveOptions | undefined,
  sessionId: string,
  blocked: Set<string>,
  ignored: string[],
): { changed: boolean; rejectedHabitIds: Set<string> } {
  let changed = false;
  const rejectedHabitIds = new Set<string>();
  const ruleItems = extractHabits(text);
  const seenPatterns = new Set<string>();
  const observedPatternIds = new Set<string>();

  // Semantic host hints must win over low-level rule extraction. The shared
  // set also ensures one message contributes at most one observation.
  for (const hint of hints ?? []) {
    if (!hint || typeof hint !== "object") continue;
    if (hint.sourceRole && hint.sourceRole !== "user") {
      ignored.push("hint_source_role_rejected");
      continue;
    }
    if (blocked.has(hint.text)) continue;
    const behaviorSummary = cleanSemanticText(hint.behaviorSummary);
    const functions = cleanFunctions(hint.functions);
    const semantic = Boolean(behaviorSummary && functions.length && hint.variationPolicy);
    const pattern = upsertExpressionPattern(store, {
      kind: toExpressionKind(hint.kind),
      literal: hint.text,
      example: hint.example,
      useWhen: hint.useWhen,
      avoidWhen: hint.avoidWhen,
      source: "hint",
      sessionId: normalizeSessionId(hint.sessionId || sessionId),
      semantic,
      behaviorSummary,
      functions,
      variationPolicy: hint.variationPolicy,
      messagePatternIds: observedPatternIds,
    }, ignored);
    if (!pattern) rejectedHabitIds.add(makeId(hint.kind, hint.text, hint.locale));
    if (pattern) {
      seenPatterns.add(pattern.id);
      syncCompatibilityHabitProjection(store, pattern, (habit) => syncHabitFromPattern(habit, pattern));
    }
  }

  for (const item of ruleItems) {
    const key = `${item.kind}\u0000${item.text}`;
    if (blocked.has(item.text) || blocked.has(key)) continue;
    const pattern = upsertExpressionPattern(store, {
      kind: toExpressionKind(item.kind),
      literal: item.text,
      example: item.example,
      useWhen: item.useWhen,
      avoidWhen: item.avoidWhen,
      source: "rule",
      sessionId,
      semantic: false,
      messagePatternIds: observedPatternIds,
    }, ignored);
    if (!pattern) rejectedHabitIds.add(makeId(item.kind, item.text, item.locale));
    if (pattern) {
      seenPatterns.add(pattern.id);
      syncCompatibilityHabitProjection(store, pattern, (habit) => syncHabitFromPattern(habit, pattern));
    }
  }

  const addressHints = options?.addressHints ?? [];
  const observedAddresses = new Set<string>();
  for (const hint of addressHints) {
    const key = `${hint.from}\u0000${hint.to}\u0000${hint.text.trim()}`;
    if (blocked.has(hint.text) || observedAddresses.has(key)) continue;
    observedAddresses.add(key);
    if (upsertAddress(store, hint, text, sessionId, ignored)) changed = true;
  }

  for (const hint of hints ?? []) {
    if (hint.addressFrom && hint.addressTo && hint.sourceRole === "user") {
      const addressHint: AddressHintInput = {
        text: hint.text,
        from: hint.addressFrom,
        to: hint.addressTo,
        sourceRole: "user",
        currentMessage: text,
        usageSummary: hint.usageSummary,
        affectSummary: hint.affectSummary,
        sessionId: hint.sessionId,
      };
      const key = `${addressHint.from}\u0000${addressHint.to}\u0000${addressHint.text.trim()}`;
      if (!blocked.has(hint.text) && !observedAddresses.has(key)) {
        observedAddresses.add(key);
        if (upsertAddress(store, addressHint, text, sessionId, ignored)) changed = true;
      }
    } else if (hint.addressFrom || hint.addressTo) {
      ignored.push("address_source_role_required");
    }
  }

  if (updateObservedVoice(store, text, ruleItems, sessionId, blocked)) changed = true;
  for (const hint of profileHints ?? []) {
    if (hint.preferenceField && hint.value) {
      if (updateResponsePreference(store, hint.preferenceField, hint.value, sessionId, hint.explicit === true)) changed = true;
    }
  }

  const expressionsBefore = store.profile.expressionPatterns.length;
  if (seenPatterns.size > 0 && expressionsBefore !== 0) {
    const activeChanged = Array.from(seenPatterns).some((id) => {
      const pattern = store.profile.expressionPatterns.find((item) => item.id === id);
      return Boolean(pattern && (pattern.status === "active" || pattern.explicit || pattern.pinned));
    });
    if (activeChanged) changed = true;
  }
  if (changed) store.briefState.revision += 1;
  return { changed, rejectedHabitIds };
}

function cloneHabit(habit: StyleHabit): StyleHabit {
  return {
    ...habit,
    useWhen: [...habit.useWhen],
    avoidWhen: [...habit.avoidWhen],
    seenContexts: habit.seenContexts ? [...habit.seenContexts] : undefined,
  };
}

function rollbackRejectedCompatibilityHabits(
  store: StyleStore,
  previousHabits: Map<string, StyleHabit>,
  rejectedIds: Set<string>,
): void {
  for (const id of rejectedIds) {
    const currentIndex = store.habits.findIndex((habit) => habit.id === id);
    const previous = previousHabits.get(id);
    if (previous) {
      if (currentIndex >= 0) store.habits[currentIndex] = previous;
      continue;
    }
    if (currentIndex >= 0) store.habits.splice(currentIndex, 1);
  }
}

interface PatternObservation {
  kind: ExpressionKind;
  literal: string;
  example?: string;
  useWhen?: string[];
  avoidWhen?: string[];
  source: "rule" | "hint" | "distill";
  sessionId: string;
  semantic: boolean;
  behaviorSummary?: string;
  functions?: string[];
  variationPolicy?: "exact_only" | "same_family" | "open_variation";
  messagePatternIds?: Set<string>;
}

function upsertExpressionPattern(
  store: StyleStore,
  observation: PatternObservation,
  ignored: string[],
): ExpressionPattern | undefined {
  const literal = typeof observation.literal === "string" ? observation.literal.trim() : "";
  if (!literal || [...literal].length > 48 || isSensitive(literal)) {
    ignored.push("expression_bad_literal");
    return undefined;
  }
  const functions = observation.functions ?? [];
  let pattern = store.profile.expressionPatterns.find((candidate) => {
    if (candidate.kind !== observation.kind) return false;
    if (candidate.examples.includes(literal)) return true;
    if (observation.semantic && candidate.behaviorSummary === observation.behaviorSummary) return true;
    return false;
  });
  const now = new Date().toISOString();
  if (!pattern) {
    const statusCount = store.profile.expressionPatterns.filter((item) => item.status === "candidate").length;
    if (store.profile.expressionPatterns.length >= MAX_STORE_ITEMS || statusCount >= 24) {
      ignored.push("expression_capacity");
      return undefined;
    }
    const summary = observation.semantic
      ? observation.behaviorSummary!.slice(0, 160)
      : `观察到${observation.kind}表达，具体功能待明确确认`;
    pattern = {
      id: observation.semantic
        ? makeExpressionId(observation.kind, summary)
        : makeExpressionId(observation.kind, literal),
      kind: observation.kind,
      behaviorSummary: summary,
      functions,
      variationPolicy: observation.variationPolicy ?? "exact_only",
      examples: [literal],
      useWhen: cleanList(observation.useWhen, 5, 40),
      avoidWhen: cleanList(observation.avoidWhen, 5, 40),
      status: "candidate",
      pinned: false,
      explicit: false,
      confidence: observation.semantic ? 0.12 : 0.05,
      seenCount: 0,
      sessionCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      evidence: { seenCount: 0, sessionIds: [], firstSeenAt: now, lastSeenAt: now, evidence: [] },
    };
    store.profile.expressionPatterns.push(pattern);
  }

  if (pattern.archivedAt) {
    // Archived evidence does not carry into the new activation window.
    pattern.seenCount = 0;
    pattern.sessionCount = 0;
    pattern.evidence = { seenCount: 0, sessionIds: [], firstSeenAt: now, lastSeenAt: now, evidence: [] };
    pattern.archivedAt = undefined;
    pattern.status = "candidate";
  }
  if (observation.semantic) {
    pattern.behaviorSummary = observation.behaviorSummary!.slice(0, 160);
    pattern.functions = cleanList(functions, 5, 32);
    pattern.variationPolicy = observation.variationPolicy ?? pattern.variationPolicy;
  }
  if (!pattern.examples.includes(literal) && pattern.examples.length < 3) pattern.examples.push(literal);
  pattern.useWhen = mergeTextList(pattern.useWhen, observation.useWhen, 5, 40);
  pattern.avoidWhen = mergeTextList(pattern.avoidWhen, observation.avoidWhen, 5, 40);

  if (observation.messagePatternIds?.has(pattern.id)) return pattern;
  observation.messagePatternIds?.add(pattern.id);

  // One message contributes at most one observation to a pattern. The caller
  // deduplicates rules and hints by literal; this record remains bounded.
  if (!pattern.evidence.sessionIds.includes(observation.sessionId)) {
    pattern.evidence.sessionIds.push(observation.sessionId);
    pattern.evidence.sessionIds = pattern.evidence.sessionIds.slice(-50);
    pattern.sessionCount = pattern.evidence.sessionIds.length;
  }
  pattern.seenCount += 1;
  pattern.evidence.seenCount = pattern.seenCount;
  pattern.evidence.lastSeenAt = now;
  pattern.lastSeenAt = now;
  pattern.confidence = clamp(pattern.confidence + (observation.semantic ? 0.14 : 0.03));
  addEvidence(pattern.evidence, {
    field: "expression_pattern",
    delta: observation.semantic ? 0.14 : 0.03,
    source: observation.source,
    weight: observation.semantic ? 0.3 : 0.5,
    sessionId: observation.sessionId,
    timestamp: now,
  });
  if (pattern.status === "candidate" && observation.semantic && pattern.seenCount >= 2 && pattern.sessionCount >= 2) {
    const activeCount = store.profile.expressionPatterns.filter((item) => item.status === "active").length;
    if (activeCount < MAX_EXPRESSION_ACTIVE || pattern.pinned || pattern.explicit) {
      pattern.status = "active";
      pattern.confidence = Math.max(pattern.confidence, 0.35);
    } else {
      ignored.push("expression_active_capacity");
    }
  }
  return pattern;
}

function upsertAddress(
  store: StyleStore,
  hint: AddressHintInput,
  currentMessage: string,
  fallbackSessionId: string,
  ignored: string[],
): boolean {
  if (hint.sourceRole !== "user" || hint.currentMessage !== currentMessage || !currentMessage.includes(hint.text)) {
    ignored.push("address_not_bound_to_current_user_message");
    return false;
  }
  if (!isAddressParty(hint.from) || !isAddressParty(hint.to) || hint.from === hint.to) {
    ignored.push("address_invalid_direction");
    return false;
  }
  const text = hint.text.trim();
  if (!text || [...text].length > 48 || isSensitive(text)) {
    ignored.push("address_bad_text");
    return false;
  }
  const bucket = store.profile.addresses.find((item) => item.from === hint.from && item.to === hint.to);
  if (!bucket) {
    ignored.push("address_invalid_direction");
    return false;
  }
  let value = bucket.values.find((item) => item.text === text);
  const now = new Date().toISOString();
  const sessionId = normalizeSessionId(hint.sessionId || fallbackSessionId);
  if (!value) {
    if (bucket.values.length >= MAX_ADDRESS_VALUES) {
      ignored.push(`address_capacity:${hint.from}→${hint.to}`);
      return false;
    }
    value = {
      id: makeAddressId(hint.from, hint.to, text), text,
      from: hint.from, to: hint.to,
      usageSummary: cleanSummary(hint.usageSummary) || (hint.to === "assistant" ? "用户会这样称呼助手" : "用户明确允许这样称呼时使用"),
      affectSummary: hint.from === "user" && hint.to === "assistant"
        ? cleanAffect(hint.affectSummary) || "用户会这样称呼助手"
        : undefined,
      useWhen: cleanList(hint.useWhen, 3, 24),
      status: hint.explicit ? "active" : "candidate",
      confidence: hint.explicit ? 1 : 0.1,
      pinned: false,
      explicit: hint.explicit === true,
      firstSeenAt: now,
      lastSeenAt: now,
      evidence: { seenCount: 0, sessionIds: [], firstSeenAt: now, lastSeenAt: now, evidence: [] },
    };
    bucket.values.push(value);
  }
  if (hint.affectSummary && hint.from === "user" && hint.to === "assistant") value.affectSummary = cleanAffect(hint.affectSummary) || value.affectSummary;
  if (hint.usageSummary) value.usageSummary = cleanSummary(hint.usageSummary) || value.usageSummary;
  if (hint.explicit) {
    value.explicit = true;
    value.status = "active";
    value.confidence = 1;
  }
  if (!value.evidence.sessionIds.includes(sessionId)) value.evidence.sessionIds.push(sessionId);
  value.evidence.seenCount += 1;
  value.evidence.lastSeenAt = now;
  value.lastSeenAt = now;
  value.confidence = clamp(value.confidence + (value.explicit ? 0 : 0.2));
  if (!value.explicit && value.evidence.seenCount >= 3 && value.evidence.sessionIds.length >= 2) value.status = "active";
  return true;
}

function applyFeedback(store: StyleStore, feedback: FeedbackInput | undefined, ignored: string[]): Set<string> {
  const blocked = new Set<string>();
  if (!feedback) return blocked;
  const target = feedback.idOrText || feedback.text;
  if (feedback.kind === "address") {
    const direction = feedback.direction;
    if (!direction || !target) { ignored.push("feedback_address_direction_required"); return blocked; }
    const [from, to] = direction === "user→assistant" ? ["user", "assistant"] : direction === "assistant→user" ? ["assistant", "user"] : ["", ""];
    if (!from || !to) { ignored.push("feedback_invalid_direction"); return blocked; }
    const bucket = store.profile.addresses.find((item) => item.from === from && item.to === to);
    const value = bucket?.values.find((item) => item.id === target || item.text === target);
    if (feedback.action === "forget" || feedback.action === "correct") {
      if (bucket) bucket.values = bucket.values.filter((item) => item !== value);
      blocked.add(target);
      if (feedback.text) blocked.add(feedback.text);
      if (value) blocked.add(value.text);
    } else if (value && feedback.action === "confirm") {
      value.explicit = true; value.status = "active"; value.confidence = 1;
    } else if (value && feedback.action === "pin") value.pinned = true;
    else if (value && feedback.action === "archive") value.status = "archived";
    else if (!value) ignored.push("feedback_target_not_found");
  } else if (feedback.kind === "expression") {
    if (feedback.action === "forget" || feedback.action === "correct") {
      const removed = store.profile.expressionPatterns.filter((item) => item.id === target || item.examples.includes(target || ""));
      store.profile.expressionPatterns = store.profile.expressionPatterns.filter((item) => !removed.includes(item));
      if (target) {
        const removedLiterals = new Set(removed.flatMap((item) => item.examples));
        removedLiterals.add(target);
        store.habits = store.habits.filter((item) => item.id !== target && !removedLiterals.has(item.text));
        blocked.add(target);
        for (const literal of removedLiterals) blocked.add(literal);
        store.profile.observedVoice.punctuation.literalPatterns = store.profile.observedVoice.punctuation.literalPatterns.filter((item) => !removedLiterals.has(item));
      }
    } else {
      const value = store.profile.expressionPatterns.find((item) => item.id === target || item.examples.includes(target || ""));
      if (value && feedback.action === "confirm") {
        value.explicit = true;
        value.status = "active";
        value.confidence = 1;
        syncCompatibilityHabitProjection(store, value, (habit) => {
          habit.status = "active";
          habit.confidence = 1;
        });
      } else if (value && feedback.action === "pin") {
        value.pinned = true;
        syncCompatibilityHabitProjection(store, value, (habit) => { habit.pinned = true; });
      } else if (value && feedback.action === "archive") {
        value.status = "archived";
        syncCompatibilityHabitProjection(store, value, (habit) => { habit.status = "archived"; });
      }
      else ignored.push("feedback_target_not_found");
    }
  } else if (feedback.kind === "failure" && feedback.rule && (feedback.action === "set" || feedback.action === "confirm")) {
    const rule = cleanSummary(feedback.rule);
    if (rule) {
      const now = new Date().toISOString();
      const existing = store.profile.failureLog.find((item) => item.rule === rule);
      if (existing) { existing.status = "active"; existing.lastConfirmedAt = now; }
      else store.profile.failureLog.push({ id: `failure-${makeId("rule", rule)}`, rule, status: "active", pinned: false, explicit: true, createdAt: now, lastConfirmedAt: now });
    }
  } else if (feedback.kind === "response_preference") {
    if (feedback.action === "forget" || feedback.action === "correct") {
      if (!target) {
        ignored.push("feedback_target_required");
      } else {
        const removed = store.profile.preferences.filter(
          (item) => item.id === target || item.text === target,
        );
        store.profile.preferences = store.profile.preferences.filter((item) => !removed.includes(item));
        blocked.add(target);
        for (const item of removed) blocked.add(item.text);
        if (removed.length === 0) ignored.push("feedback_target_not_found");
      }
    } else if ((feedback.action === "set" || feedback.action === "confirm") && feedback.field && feedback.value) {
      updateResponsePreference(store, feedback.field as "replyVerbosity" | "warmth" | "initiative", feedback.value as 1 | 2 | 3 | 4 | 5, "feedback", true);
    } else {
      ignored.push("feedback_target_not_found");
    }
  }
  store.briefState.revision += 1;
  return blocked;
}

function syncCompatibilityHabitProjection(
  store: StyleStore,
  pattern: ExpressionPattern,
  mutate: (habit: StyleHabit) => void,
): void {
  const examples = new Set(pattern.examples.map((example) => example.toLowerCase()));
  for (const habit of store.habits) {
    if (habit.id === pattern.id || examples.has(habit.text.toLowerCase())) mutate(habit);
  }
}

function syncHabitFromPattern(habit: StyleHabit, pattern: ExpressionPattern): void {
  if (pattern.status === "active") {
    habit.status = "active";
    habit.confidence = Math.max(habit.confidence, pattern.confidence);
  }
  if (pattern.pinned) habit.pinned = true;
}

function updateObservedVoice(
  store: StyleStore,
  text: string,
  rules: ExtractedHabit[],
  sessionId: string,
  blocked = new Set<string>(),
): boolean {
  if (!text.trim()) return false;
  const now = new Date().toISOString();
  const voice = store.profile.observedVoice;
  const values: Array<["verbosity" | "formality" | "expressiveness", number]> = [
    ["verbosity", text.length < 16 ? 2 : text.length < 80 ? 3 : text.length < 240 ? 4 : 5],
    ["formality", /您|请|因此|综上|regards|sincerely/i.test(text) ? 4 : /哈哈|呜呜|啊啊|!|！|😂|🥺/.test(text) ? 2 : 3],
    ["expressiveness", Math.min(5, 1 + (text.match(/[!?！？~～😂🤣🥺❤♥]/gu) || []).length)],
  ];
  let changed = false;
  for (const [field, value] of values) {
    const scale = voice[field];
    if (updateScale(scale, value, sessionId, "rule", false, now)) changed = true;
  }
  const directPunctuation = text.match(/(?:\.{2,}|。{2,}|…{2,}|[!?！？~～]{2,})/gu) ?? [];
  const markers = [
    ...rules.filter((item) => ["emoji", "punctuation"].includes(item.kind)),
    ...directPunctuation
      .filter((literal) => !blocked.has(literal))
      .map((literal): ExtractedHabit => ({
        kind: "punctuation",
        text: literal,
        confidenceDelta: 0.1,
        useWhen: [],
        avoidWhen: [],
        source: "rule",
      })),
  ];
  if (markers.length) {
    voice.expressionDensity = Math.min(3, Math.max(voice.expressionDensity, 1 + (markers.length > 1 ? 1 : 0))) as 0 | 1 | 2 | 3;
    for (const marker of markers) {
      if (marker.kind === "punctuation" && !blocked.has(marker.text) && !voice.punctuation.literalPatterns.includes(marker.text)) {
        voice.punctuation.literalPatterns = [...voice.punctuation.literalPatterns, marker.text].slice(-3);
        voice.punctuation.baseStyle = marker.text.includes("...") || marker.text.includes("…") || marker.text.includes("。。。") ? "ellipses" : "expressive";
        changed = true;
      }
    }
  }
  return changed;
}

function updateResponsePreference(
  store: StyleStore,
  field: "replyVerbosity" | "warmth" | "initiative",
  value: 1 | 2 | 3 | 4 | 5,
  sessionId: string,
  explicit: boolean,
): boolean {
  const scale = store.profile.responsePreferences[field];
  const changed = updateScale(
    scale,
    value,
    sessionId,
    explicit ? "explicit" : "feedback",
    explicit,
    new Date().toISOString(),
  );
  if (explicit) { scale.explicit = true; scale.pinned = true; scale.value = value; scale.latentMean = value; }
  return changed || explicit;
}

function updateScale(
  scale: ScaleMemory,
  observed: number,
  sessionId: string,
  source: EvidenceRecord["source"],
  explicit: boolean,
  now: string,
): boolean {
  const record: EvidenceRecord = { field: "scale", observedValue: observed, source, weight: explicit ? 1 : 0.5, sessionId, timestamp: now };
  scale.evidence = [...(scale.evidence ?? []), record].slice(-MAX_EVIDENCE);
  const valid = scale.evidence;
  const weight = valid.reduce((sum, item) => sum + item.weight, 0);
  scale.latentMean = valid.reduce((sum, item) => sum + (item.observedValue ?? scale.value) * item.weight, 0) / Math.max(weight, 1);
  scale.evidenceWeight = weight;
  scale.evidenceCount = valid.length;
  scale.sessionCount = new Set(valid.map((item) => item.sessionId).filter(Boolean)).size;
  scale.confidence = Math.min(1, weight / 6);
  scale.lastUpdatedAt = now;
  if (explicit) {
    const next = clampScale(observed);
    const changed = scale.value !== next;
    scale.value = next; scale.explicit = true; scale.pinned = true;
    scale.latentMean = observed;
    return changed;
  }
  if (scale.pinned || scale.explicit) return false;
  const stable = scale.evidenceCount >= 12 && scale.sessionCount >= 2;
  if (!stable) return false;
  if (scale.latentMean >= scale.value + 0.65) { scale.value = clampScale(scale.value + 1); return true; }
  if (scale.latentMean <= scale.value - 0.65) { scale.value = clampScale(scale.value - 1); return true; }
  return false;
}

function clampScale(value: number): 1 | 2 | 3 | 4 | 5 {
  return Math.max(1, Math.min(5, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

function addEvidence(state: { evidence?: EvidenceRecord[] }, record: EvidenceRecord) {
  state.evidence = [...(state.evidence ?? []), record].slice(-MAX_EVIDENCE);
}

function toExpressionKind(kind: HabitKind): ExpressionKind {
  if (kind === "emoji") return "emoji";
  if (kind === "punctuation") return "punctuation";
  if (kind === "language_mix") return "mixed_language";
  if (kind === "catchphrase") return "lexical";
  if (kind === "idiolect" || kind === "structure") return "other";
  return "text_marker";
}

function isAddressParty(value: unknown): value is AddressParty { return value === "user" || value === "assistant"; }
function cleanSemanticText(value?: string): string | undefined {
  return typeof value === "string" && value.trim() && !isSensitive(value) && !BLOCKED_PROFILE_LABEL_RE.test(value) ? value.trim().slice(0, 160) : undefined;
}
function cleanAffect(value?: string): string | undefined {
  return cleanSemanticText(value)?.slice(0, 48);
}
function cleanSummary(value?: string): string | undefined { return cleanSemanticText(value)?.slice(0, 48); }
function cleanFunctions(value?: string[]): string[] { return cleanList(value, 5, 32); }
function cleanList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()) && !isSensitive(item)).map((item) => item.trim().slice(0, maxLen)))).slice(0, maxItems);
}
function mergeTextList(current: string[] | undefined, next: string[] | undefined, maxItems: number, maxLen: number): string[] {
  return cleanList([...(current ?? []), ...(next ?? [])], maxItems, maxLen);
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
      behaviorSummary: cleanSemanticText(hint.behaviorSummary),
      functions: cleanFunctions(hint.functions),
      variationPolicy: hint.variationPolicy,
      source: "hint",
      sessionId: typeof hint.sessionId === "string" ? normalizeSessionId(hint.sessionId) : undefined,
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
  // single hint would defeat the repeated-evidence rule entirely.
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
    habit.seenCount = 0;
    habit.seenContexts = [];
    habit.firstSeenAt = now;
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
