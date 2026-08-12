import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  AddressMemory,
  AddressParty,
  AgentObservationPolicy,
  EvidenceRecord,
  EvidenceState,
  ExpressionKind,
  ExpressionPattern,
  FailureRule,
  HabitKind,
  HabitStatus,
  InteractionPreference,
  InteractionPreferenceCategory,
  InitializationState,
  ObservedVoice,
  ResponsePreferences,
  ScaleMemory,
  StyleHabit,
  StyleSettings,
  StyleStore,
  VariationPolicy,
} from "./types.js";

const DEFAULT_DIR = join(homedir(), ".style-memory-mcp");
const DEFAULT_FILE = join(DEFAULT_DIR, "style-memory.json");
const DAY_MS = 86_400_000;

export const MAX_SEEN_CONTEXTS = 8;
export const MAX_EVIDENCE = 50;
export const MAX_ADDRESS_VALUES = 6;
export const MAX_EXPRESSION_ACTIVE = 12;
export const MAX_EXPRESSION_CANDIDATE = 24;
export const MAX_EXPRESSION_ARCHIVED = 24;
export const MAX_STORE_ITEMS = 64;

const EXPRESSION_KINDS = new Set<ExpressionKind>([
  "lexical", "laughter", "kaomoji", "emoji", "unicode_symbol", "text_marker",
  "sticker_semantic", "punctuation", "mixed_language", "other",
]);
const HABIT_KINDS = new Set<HabitKind>([
  "catchphrase", "dialect_marker", "emoji", "punctuation", "tone", "language_mix",
  "sentence_final_particle", "structure", "idiolect",
]);
const VARIATION_POLICIES = new Set<VariationPolicy>([
  "exact_only", "same_family", "open_variation",
]);
const STATUSES = new Set<HabitStatus>(["candidate", "active", "archived"]);
const PROFILE_CATEGORIES = new Set<InteractionPreferenceCategory>([
  "response_structure", "collaboration", "explanation", "decision_making", "workflow", "tone_boundary",
]);

let storeQueue: Promise<void> = Promise.resolve();

export function resolveDataPath(input?: string): string {
  const value = input?.trim() || process.env.STYLE_MEMORY_PATH || DEFAULT_FILE;
  return isAbsolute(value) ? value : resolve(value);
}

export function defaultSettings(dataPath = DEFAULT_FILE): StyleSettings {
  const channel = process.env.STYLE_MEMORY_CHANNEL === "agent" ? "agent" : "hook";
  const policy = process.env.STYLE_MEMORY_AGENT_POLICY === "off"
    ? "off"
    : process.env.STYLE_MEMORY_AGENT_POLICY === "event" ? "event" : "full";
  return {
    dataPath: resolveDataPath(dataPath),
    minPromoteCount: readPositiveIntEnv("STYLE_MEMORY_MIN_PROMOTE_COUNT", 2, 1, 50),
    candidateTtlDays: 30,
    inactiveTtlDays: 180,
    maxBriefItems: readPositiveIntEnv("STYLE_MEMORY_MAX_BRIEF_ITEMS", 8, 1, 50),
    maxExampleLen: readPositiveIntEnv("STYLE_MEMORY_MAX_EXAMPLE_LEN", 60, 1, 240),
    allowLearning: process.env.STYLE_MEMORY_LEARNING !== "off",
    observationChannel: channel,
    agentPolicy: policy,
  };
}

function nowIso(): string { return new Date().toISOString(); }

function emptyEvidence(at = nowIso()): EvidenceState {
  return { seenCount: 0, sessionIds: [], firstSeenAt: at, lastSeenAt: at, evidence: [] };
}

function scale(value: 1 | 2 | 3 | 4 | 5, at = nowIso()): ScaleMemory {
  return {
    value,
    latentMean: value,
    confidence: 0,
    evidenceWeight: 0,
    evidenceCount: 0,
    sessionCount: 0,
    lastUpdatedAt: at,
  };
}

function freshProfile() {
  return {
    preferences: [] as InteractionPreference[],
    addresses: [
      { from: "user", to: "assistant", values: [] },
      { from: "assistant", to: "user", values: [] },
    ] as AddressMemory[],
    observedVoice: {
      verbosity: scale(3),
      formality: scale(3),
      expressiveness: scale(3),
      expressionDensity: 0 as const,
      punctuation: { baseStyle: "standard" as const, literalPatterns: [] },
    } as ObservedVoice,
    responsePreferences: {
      replyVerbosity: scale(3),
      warmth: scale(3),
      initiative: scale(3),
      supportMode: undefined,
    } as ResponsePreferences,
    expressionPatterns: [] as ExpressionPattern[],
    failureLog: [] as FailureRule[],
  };
}

function freshStore(dataPath: string): StyleStore {
  return {
    version: 2,
    settings: defaultSettings(dataPath),
    initialization: { status: "pending" },
    habits: [],
    profile: freshProfile(),
    evidenceState: emptyEvidence(),
    briefState: { revision: 0 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function loadStore(dataPath = resolveDataPath()): Promise<StyleStore> {
  const resolved = resolveDataPath(dataPath);
  try {
    const raw = await readFile(resolved, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isStructurallyCorruptStore(parsed)) {
      await preserveCorruptStore(resolved);
      console.warn(`[style-memory-mcp] Corrupt store structure at ${resolved}; using a fresh in-memory store.`);
      return freshStore(resolved);
    }
    return normalizeStore(parsed, resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return freshStore(resolved);
    if (error instanceof SyntaxError) {
      await preserveCorruptStore(resolved);
      console.warn(`[style-memory-mcp] Corrupt JSON at ${resolved}; using a fresh in-memory store.`);
      return freshStore(resolved);
    }
    throw error;
  }
}

/** Convert a v1-shaped value without guessing address direction or behavior. */
export function migrateV1ToV2(input: unknown, dataPath = resolveDataPath()): StyleStore {
  const resolved = resolveDataPath(dataPath);
  const raw = isRecord(input) ? input : {};
  const store = freshStore(resolved);
  store.settings = normalizeSettings(raw.settings, resolved);
  const rawHabits: unknown[] = Array.isArray(raw.habits) ? raw.habits : [];
  store.habits = rawHabits.flatMap((item) => {
    const habit = normalizeHabit(item);
    return habit ? [habit] : [];
  });
  const rawProfile = isRecord(raw.profile) ? raw.profile : {};
  const rawPrefs = Array.isArray(rawProfile.preferences) ? rawProfile.preferences : [];
  store.profile.preferences = rawPrefs.flatMap((item) => {
    const preference = normalizeInteractionPreference(item);
    return preference ? [preference] : [];
  });
  // Legacy habits are preserved as exact_only expression candidates. No
  // behavior, affect, or address direction is inferred from a literal.
  store.profile.expressionPatterns = store.habits.map(habitToExpression);
  store.evidenceState = evidenceFromItems(store.profile.expressionPatterns);
  if (hasLearnedMemory(store)) store.initialization = { status: "completed" };
  if (typeof raw.lastCleanupAt === "string") store.lastCleanupAt = raw.lastCleanupAt;
  return store;
}

/** Migrate a file with backup + atomic replacement. Re-running on v2 is a no-op. */
export async function migrateStoreFile(dataPath = resolveDataPath()): Promise<{
  migrated: boolean;
  backupPath?: string;
  store: StyleStore;
}> {
  const resolved = resolveDataPath(dataPath);
  const raw = await readFile(resolved, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (isRecord(parsed) && parsed.version === 2) {
    return { migrated: false, store: normalizeStore(parsed, resolved) };
  }
  const backupPath = `${resolved}.v1-backup`;
  await copyFile(resolved, backupPath, 0);
  const store = migrateV1ToV2(parsed, resolved);
  await atomicWrite(store, resolved);
  return { migrated: true, backupPath, store };
}

export async function saveStore(store: StyleStore): Promise<void> {
  const write = storeQueue.then(() => doSave(ensureV2(store)), () => doSave(ensureV2(store)));
  storeQueue = write.then(() => undefined, () => undefined);
  return write;
}

export async function withStoreMutation<T>(
  mutate: (store: StyleStore) => T | Promise<T>,
  dataPath = resolveDataPath(),
): Promise<T> {
  const job = storeQueue.then(
    () => doStoreMutation(mutate, resolveDataPath(dataPath)),
    () => doStoreMutation(mutate, resolveDataPath(dataPath)),
  );
  storeQueue = job.then(() => undefined, () => undefined);
  return job;
}

async function doStoreMutation<T>(
  mutate: (store: StyleStore) => T | Promise<T>,
  dataPath: string,
): Promise<T> {
  const store = await loadStore(dataPath);
  const result = await mutate(store);
  await doSave(store);
  return result;
}

async function doSave(store: StyleStore): Promise<void> {
  const normalized = ensureV2(store);
  await atomicWrite(normalized, normalized.settings.dataPath);
}

async function atomicWrite(store: StyleStore, dataPath: string): Promise<void> {
  await mkdir(dirname(dataPath), { recursive: true });
  const tempPath = `${dataPath}.tmp-${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, dataPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function preserveCorruptStore(dataPath: string): Promise<void> {
  const backup = `${dataPath}.corrupt-${Date.now()}-${randomUUID()}`;
  return copyFile(dataPath, backup).catch(() => undefined);
}

function isStructurallyCorruptStore(input: unknown): boolean {
  if (!isRecord(input)) return true;
  if (input.version === 2) return input.habits !== undefined && !Array.isArray(input.habits);
  return !Array.isArray(input.habits);
}

export function normalizeStore(input: unknown, dataPath: string): StyleStore {
  if (!isRecord(input)) {
    console.warn(`[style-memory-mcp] Corrupt store structure at ${dataPath}, starting fresh.`);
    return freshStore(resolveDataPath(dataPath));
  }
  const raw = input;
  if (raw.version === 2 && raw.habits !== undefined && !Array.isArray(raw.habits)) {
    console.warn(`[style-memory-mcp] Corrupt v2 compatibility projection at ${dataPath}, starting fresh.`);
    return freshStore(resolveDataPath(dataPath));
  }
  if (raw.version !== 2 && !Array.isArray(raw.habits)) {
    console.warn(`[style-memory-mcp] Corrupt legacy store structure at ${dataPath}, starting fresh.`);
    return freshStore(resolveDataPath(dataPath));
  }
  if (raw.version !== 2) return ensureV2(migrateV1ToV2(raw, dataPath));
  const store = freshStore(dataPath);
  store.settings = normalizeSettings(raw.settings, dataPath);
  const rawHabits: unknown[] = Array.isArray(raw.habits) ? raw.habits : [];
  store.habits = rawHabits.flatMap((item) => {
    const habit = normalizeHabit(item);
    return habit ? [habit] : [];
  });
  const profile = isRecord(raw.profile) ? raw.profile : {};
  store.profile.preferences = Array.isArray(profile.preferences)
    ? profile.preferences.flatMap((item) => {
        const preference = normalizeInteractionPreference(item);
        return preference ? [preference] : [];
      })
    : [];
  store.profile.addresses = normalizeAddresses(profile.addresses);
  store.profile.observedVoice = normalizeObservedVoice(profile.observedVoice);
  store.profile.responsePreferences = normalizeResponsePreferences(profile.responsePreferences);
  store.profile.expressionPatterns = normalizeExpressions(profile.expressionPatterns);
  if (store.profile.expressionPatterns.length === 0 && store.habits.length > 0) {
    store.profile.expressionPatterns = store.habits.map(habitToExpression);
  }
  store.profile.failureLog = normalizeFailureLog(profile.failureLog);
  store.initialization = normalizeInitialization(
    raw.initialization,
    hasLearnedMemory(store) ? "completed" : "pending",
  );
  store.evidenceState = normalizeEvidence(raw.evidenceState) ?? evidenceFromItems(store.profile.expressionPatterns);
  store.briefState = normalizeBriefState(raw.briefState);
  store.lastCleanupAt = typeof raw.lastCleanupAt === "string" ? raw.lastCleanupAt : undefined;
  return ensureV2(store);
}

function ensureV2(store: StyleStore): StyleStore {
  if (store.version !== 2) return migrateV1ToV2(store, store.settings?.dataPath ?? DEFAULT_FILE);
  store.settings = normalizeSettings(store.settings, store.settings.dataPath);
  store.profile = {
    ...freshProfile(),
    ...store.profile,
    addresses: normalizeAddresses(store.profile?.addresses),
    observedVoice: normalizeObservedVoice(store.profile?.observedVoice),
    responsePreferences: normalizeResponsePreferences(store.profile?.responsePreferences),
    expressionPatterns: normalizeExpressions(store.profile?.expressionPatterns),
    failureLog: normalizeFailureLog(store.profile?.failureLog),
    preferences: Array.isArray(store.profile?.preferences)
      ? store.profile.preferences.flatMap((item) => {
          const normalized = normalizeInteractionPreference(item);
          return normalized ? [normalized] : [];
        })
      : [],
  };
  if (store.profile.expressionPatterns.length === 0 && store.habits.length) {
    store.profile.expressionPatterns = store.habits.map(habitToExpression);
  }
  store.habits = Array.isArray(store.habits) ? store.habits : [];
  store.initialization = normalizeInitialization(
    store.initialization,
    hasLearnedMemory(store) ? "completed" : "pending",
  );
  store.evidenceState = normalizeEvidence(store.evidenceState) ?? evidenceFromItems(store.profile.expressionPatterns);
  store.briefState = normalizeBriefState(store.briefState);
  return store;
}

function normalizeInitialization(
  value: unknown,
  fallbackStatus: InitializationState["status"],
): InitializationState {
  if (!isRecord(value)) return { status: fallbackStatus };
  const status = value.status === "completed" || value.status === "skipped"
    ? value.status
    : "pending";
  return {
    status,
    requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : undefined,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
    sourceSessionCount: storedInt(value.sourceSessionCount, 0, 1, 12) || undefined,
    lookbackDays: storedInt(value.lookbackDays, 0, 1, 30) || undefined,
  };
}

function hasLearnedMemory(store: StyleStore): boolean {
  const voice = store.profile.observedVoice;
  const response = store.profile.responsePreferences;
  return store.habits.length > 0
    || store.profile.preferences.length > 0
    || store.profile.expressionPatterns.length > 0
    || store.profile.addresses.some((bucket) => bucket.values.length > 0)
    || store.profile.failureLog.length > 0
    || [voice.verbosity, voice.formality, voice.expressiveness,
      response.replyVerbosity, response.warmth, response.initiative]
      .some((item) => item.evidenceCount > 0);
}

function normalizeSettings(value: unknown, dataPath: string): StyleSettings {
  const defaults = defaultSettings(dataPath);
  const raw = isRecord(value) ? value : {};
  const storedMinPromoteCount = storedInt(raw.minPromoteCount, defaults.minPromoteCount, 1, 50);
  const minPromoteCount = process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT
    ? defaults.minPromoteCount
    : storedMinPromoteCount === 3 ? defaults.minPromoteCount : storedMinPromoteCount;
  return {
    ...defaults,
    dataPath: resolveDataPath(dataPath),
    minPromoteCount,
    candidateTtlDays: storedInt(raw.candidateTtlDays, 30, 1, 3650),
    inactiveTtlDays: storedInt(raw.inactiveTtlDays, 180, 1, 3650),
    maxBriefItems: storedInt(raw.maxBriefItems, defaults.maxBriefItems, 1, 50),
    maxExampleLen: storedInt(raw.maxExampleLen, defaults.maxExampleLen, 1, 240),
    allowLearning: typeof raw.allowLearning === "boolean" ? raw.allowLearning : defaults.allowLearning,
    observationChannel: raw.observationChannel === "agent" ? "agent" : "hook",
    agentPolicy: raw.agentPolicy === "off" ? "off" : raw.agentPolicy === "event" ? "event" : "full",
  };
}

export function normalizeHabit(value: unknown): StyleHabit | undefined {
  if (!isRecord(value) || typeof value.text !== "string" || !HABIT_KINDS.has(value.kind as HabitKind)) return undefined;
  const now = nowIso();
  const text = value.text.trim();
  if (!text || text.length > 240) return undefined;
  const status = STATUSES.has(value.status as HabitStatus) ? value.status as HabitStatus : "candidate";
  return {
    id: typeof value.id === "string" && value.id ? value.id : makeId(String(value.kind), text, typeof value.locale === "string" ? value.locale : undefined),
    kind: value.kind as HabitKind,
    text,
    locale: typeof value.locale === "string" ? value.locale.slice(0, 40) : undefined,
    confidence: clamp(typeof value.confidence === "number" ? value.confidence : 0.1),
    seenCount: positiveInt(value.seenCount, 1),
    firstSeenAt: stringOr(value.firstSeenAt, now),
    lastSeenAt: stringOr(value.lastSeenAt, now),
    lastReturnedAt: typeof value.lastReturnedAt === "string" ? value.lastReturnedAt : undefined,
    status,
    pinned: value.pinned === true,
    useWhen: labels(value.useWhen, 8, 40),
    avoidWhen: labels(value.avoidWhen, 8, 40),
    notes: boundedString(value.notes, 160),
    example: boundedString(value.example, 240),
    seenContexts: labels(value.seenContexts, MAX_SEEN_CONTEXTS, 80),
    source: value.source === "hint" || value.source === "distill" ? value.source : "rule",
  };
}

export function normalizeInteractionPreference(value: unknown): InteractionPreference | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const category = PROFILE_CATEGORIES.has(value.category as InteractionPreferenceCategory)
    ? value.category as InteractionPreferenceCategory : "collaboration";
  const now = nowIso();
  const text = value.text.trim();
  if (!text || text.length > 240) return undefined;
  return {
    id: typeof value.id === "string" && value.id ? value.id : makeProfileId(category, text),
    category, text,
    confidence: clamp(typeof value.confidence === "number" ? value.confidence : 0.1),
    seenCount: positiveInt(value.seenCount, 1),
    firstSeenAt: stringOr(value.firstSeenAt, now),
    lastSeenAt: stringOr(value.lastSeenAt, now),
    lastReturnedAt: typeof value.lastReturnedAt === "string" ? value.lastReturnedAt : undefined,
    status: STATUSES.has(value.status as HabitStatus) ? value.status as HabitStatus : "candidate",
    pinned: value.pinned === true,
    useWhen: labels(value.useWhen, 8, 40),
    avoidWhen: labels(value.avoidWhen, 8, 40),
    notes: boundedString(value.notes, 160),
    example: boundedString(value.example, 240),
    seenContexts: labels(value.seenContexts, MAX_SEEN_CONTEXTS, 80),
    source: value.source === "hint" || value.source === "distill" ? value.source : "rule",
  };
}

function normalizeAddresses(value: unknown): AddressMemory[] {
  const out: AddressMemory[] = [
    { from: "user", to: "assistant", values: [] },
    { from: "assistant", to: "user", values: [] },
  ];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item) || !isParty(item.from) || !isParty(item.to) || item.from === item.to) continue;
    const target = out.find((entry) => entry.from === item.from && entry.to === item.to)!;
    if (!Array.isArray(item.values)) continue;
    target.values = item.values
      .flatMap((raw) => normalizeAddress(raw, item.from as AddressParty, item.to as AddressParty))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .slice(0, MAX_ADDRESS_VALUES);
  }
  return out;
}

function normalizeAddress(value: unknown, from: AddressParty, to: AddressParty) {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const text = value.text.trim();
  if (!text || [...text].length > 48) return undefined;
  const now = nowIso();
  const evidence = normalizeEvidence(value.evidence) ?? emptyEvidence(now);
  return {
    id: typeof value.id === "string" && value.id ? value.id : makeAddressId(from, to, text),
    text,
    from, to,
    usageSummary: boundedString(value.usageSummary, 48),
    affectSummary: boundedString(value.affectSummary, 48),
    useWhen: labels(value.useWhen, 3, 24),
    status: STATUSES.has(value.status as HabitStatus) ? value.status as HabitStatus : "candidate",
    confidence: clamp(typeof value.confidence === "number" ? value.confidence : 0.1),
    pinned: value.pinned === true,
    explicit: value.explicit === true,
    firstSeenAt: stringOr(value.firstSeenAt, now),
    lastSeenAt: stringOr(value.lastSeenAt, now),
    archivedAt: typeof value.archivedAt === "string" ? value.archivedAt : undefined,
    evidence,
  };
}

function normalizeExpressions(value: unknown): ExpressionPattern[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw) || !EXPRESSION_KINDS.has(raw.kind as ExpressionKind)) return [];
    const now = nowIso();
    const kind = raw.kind as ExpressionKind;
    const summary = typeof raw.behaviorSummary === "string" ? raw.behaviorSummary.trim().slice(0, 160) : "";
    if (!summary) return [];
    const policy = VARIATION_POLICIES.has(raw.variationPolicy as VariationPolicy) ? raw.variationPolicy as VariationPolicy : "exact_only";
    const examples = Array.isArray(raw.examples) ? raw.examples.filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.slice(0, 60)).slice(0, 3) : [];
    const evidence = normalizeEvidence(raw.evidence) ?? emptyEvidence(now);
    return [{
      id: typeof raw.id === "string" && raw.id ? raw.id : makeExpressionId(kind, summary),
      kind, behaviorSummary: summary,
      functions: labels(raw.functions, 5, 32),
      variationPolicy: policy,
      examples,
      useWhen: labels(raw.useWhen, 5, 40),
      avoidWhen: labels(raw.avoidWhen, 5, 40),
      density: [0, 1, 2, 3].includes(raw.density as number) ? raw.density as 0 | 1 | 2 | 3 : undefined,
      status: STATUSES.has(raw.status as HabitStatus) ? raw.status as HabitStatus : "candidate",
      pinned: raw.pinned === true,
      explicit: raw.explicit === true,
      confidence: clamp(typeof raw.confidence === "number" ? raw.confidence : 0.1),
      seenCount: positiveInt(raw.seenCount, evidence.seenCount || 1),
      sessionCount: positiveInt(raw.sessionCount, evidence.sessionIds.length || 1),
      firstSeenAt: stringOr(raw.firstSeenAt, now),
      lastSeenAt: stringOr(raw.lastSeenAt, now),
      lastReturnedAt: typeof raw.lastReturnedAt === "string" ? raw.lastReturnedAt : undefined,
      archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
      evidence,
    } satisfies ExpressionPattern];
  });
}

function normalizeObservedVoice(value: unknown): ObservedVoice {
  const profile = freshProfile().observedVoice;
  if (!isRecord(value)) return profile;
  return {
    verbosity: normalizeScale(value.verbosity, 3),
    formality: normalizeScale(value.formality, 3),
    expressiveness: normalizeScale(value.expressiveness, 3),
    rhythm: boundedString(value.rhythm, 80),
    expressionDensity: [0, 1, 2, 3].includes(value.expressionDensity as number) ? value.expressionDensity as 0 | 1 | 2 | 3 : 0,
    punctuation: {
      baseStyle: value.punctuation && isRecord(value.punctuation) && ["minimal", "standard", "expressive", "ellipses"].includes(value.punctuation.baseStyle as string)
        ? value.punctuation.baseStyle as ObservedVoice["punctuation"]["baseStyle"] : "standard",
      literalPatterns: labels(value.punctuation && isRecord(value.punctuation) ? value.punctuation.literalPatterns : undefined, 3, 12),
    },
  };
}

function normalizeResponsePreferences(value: unknown): ResponsePreferences {
  const profile = freshProfile().responsePreferences;
  if (!isRecord(value)) return profile;
  return {
    replyVerbosity: normalizeScale(value.replyVerbosity, 3),
    warmth: normalizeScale(value.warmth, 3),
    initiative: normalizeScale(value.initiative, 3),
    supportMode: boundedString(value.supportMode, 80),
  };
}

function normalizeScale(value: unknown, fallback: 1 | 2 | 3 | 4 | 5): ScaleMemory {
  const base = scale(fallback);
  if (!isRecord(value)) return base;
  const integer = Number.isInteger(value.value) && Number(value.value) >= 1 && Number(value.value) <= 5 ? Number(value.value) as 1 | 2 | 3 | 4 | 5 : fallback;
  return {
    value: integer,
    latentMean: typeof value.latentMean === "number" && Number.isFinite(value.latentMean) ? Math.max(1, Math.min(5, value.latentMean)) : integer,
    confidence: clamp(typeof value.confidence === "number" ? value.confidence : 0),
    evidenceWeight: Math.max(0, typeof value.evidenceWeight === "number" ? value.evidenceWeight : 0),
    evidenceCount: Math.max(0, positiveInt(value.evidenceCount, 0)),
    sessionCount: Math.max(0, positiveInt(value.sessionCount, 0)),
    lastUpdatedAt: stringOr(value.lastUpdatedAt, nowIso()),
    pinned: value.pinned === true,
    explicit: value.explicit === true,
    evidence: recordsForScale(value.evidence),
  };
}

function recordsForScale(value: unknown): EvidenceRecord[] {
  return Array.isArray(value) ? value.flatMap(normalizeEvidenceRecord).slice(-MAX_EVIDENCE) : [];
}

function normalizeFailureLog(value: unknown): FailureRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.rule !== "string" || !raw.rule.trim()) return [];
    const now = nowIso();
    return [{
      id: typeof raw.id === "string" && raw.id ? raw.id : `failure-${shortHash(raw.rule)}`,
      rule: raw.rule.trim().slice(0, 160),
      status: raw.status === "archived" ? "archived" as const : "active" as const,
      pinned: raw.pinned === true,
      explicit: raw.explicit !== false && raw.explicit !== "false",
      createdAt: stringOr(raw.createdAt, now),
      lastConfirmedAt: stringOr(raw.lastConfirmedAt, now),
    } satisfies FailureRule];
  }).slice(0, 24);
}

function normalizeEvidence(value: unknown): EvidenceState | undefined {
  if (!isRecord(value)) return undefined;
  const records = Array.isArray(value.evidence) ? value.evidence.flatMap(normalizeEvidenceRecord).slice(-MAX_EVIDENCE) : [];
  const sessions = labels(value.sessionIds, 50, 24);
  return {
    seenCount: Math.max(0, positiveInt(value.seenCount, 0)),
    sessionIds: sessions,
    firstSeenAt: typeof value.firstSeenAt === "string" ? value.firstSeenAt : undefined,
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : undefined,
    lastArchivedAt: typeof value.lastArchivedAt === "string" ? value.lastArchivedAt : undefined,
    evidence: records,
  };
}

function normalizeEvidenceRecord(value: unknown): EvidenceRecord[] {
  if (!isRecord(value) || typeof value.field !== "string" || typeof value.timestamp !== "string") return [];
  const source = ["explicit", "feedback", "rule", "hint", "distill"].includes(value.source as string)
    ? value.source as EvidenceRecord["source"] : "rule";
  return [{
    field: value.field.slice(0, 80),
    observedValue: typeof value.observedValue === "number" ? value.observedValue : undefined,
    delta: typeof value.delta === "number" ? value.delta : undefined,
    source,
    weight: typeof value.weight === "number" && Number.isFinite(value.weight) ? Math.max(0, Math.min(1, value.weight)) : 0.5,
    sessionId: boundedString(value.sessionId, 24),
    timestamp: value.timestamp,
    reason: boundedString(value.reason, 120),
  }];
}

function normalizeBriefState(value: unknown) {
  if (!isRecord(value)) return { revision: 0 };
  return {
    revision: Number.isInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : 0,
    capsule: boundedString(value.capsule, 16000),
    lastContext: boundedString(value.lastContext, 80),
  };
}

function evidenceFromItems(items: ExpressionPattern[]): EvidenceState {
  const evidence = emptyEvidence();
  evidence.seenCount = items.reduce((sum, item) => sum + item.seenCount, 0);
  evidence.sessionIds = Array.from(new Set(items.flatMap((item) => item.evidence.sessionIds))).slice(0, 50);
  return evidence;
}

export function habitToExpression(habit: StyleHabit): ExpressionPattern {
  const now = habit.lastSeenAt || nowIso();
  const kind: ExpressionKind = habit.kind === "emoji" ? "emoji" : habit.kind === "punctuation" ? "punctuation" : habit.kind === "language_mix" ? "mixed_language" : habit.kind === "catchphrase" ? "lexical" : "other";
  return {
    id: habit.id,
    kind,
    behaviorSummary: `用户在${habit.useWhen[0] || "日常交流"}中使用这一表达作为可观察的${kind}信号`,
    functions: [],
    variationPolicy: kind === "punctuation" ? "exact_only" : "exact_only",
    examples: habit.example ? [habit.example] : [habit.text],
    useWhen: habit.useWhen,
    avoidWhen: habit.avoidWhen,
    status: habit.status,
    pinned: habit.pinned,
    explicit: habit.source === "distill",
    confidence: habit.confidence,
    seenCount: habit.seenCount,
    sessionCount: habit.seenContexts?.length || 1,
    firstSeenAt: habit.firstSeenAt,
    lastSeenAt: now,
    lastReturnedAt: habit.lastReturnedAt,
    evidence: {
      seenCount: habit.seenCount,
      sessionIds: habit.seenContexts?.slice(0, 50) || [],
      firstSeenAt: habit.firstSeenAt,
      lastSeenAt: now,
      evidence: [],
    },
  };
}

export function expressionToHabit(pattern: ExpressionPattern): StyleHabit {
  const text = pattern.examples[0] || pattern.behaviorSummary;
  const kind: HabitKind = pattern.kind === "emoji" ? "emoji" : pattern.kind === "punctuation" ? "punctuation" : pattern.kind === "mixed_language" ? "language_mix" : pattern.kind === "lexical" ? "catchphrase" : "idiolect";
  return {
    id: pattern.id, kind, text, confidence: pattern.confidence, seenCount: pattern.seenCount,
    firstSeenAt: pattern.firstSeenAt, lastSeenAt: pattern.lastSeenAt, lastReturnedAt: pattern.lastReturnedAt,
    status: pattern.status, pinned: pattern.pinned, useWhen: pattern.useWhen || [], avoidWhen: pattern.avoidWhen || [],
    example: pattern.examples[0], seenContexts: pattern.evidence.sessionIds, source: "hint",
  };
}

export function makeId(kind: string, text: string, locale?: string): string {
  const readable = `${locale || "any"}-${kind}-${text}`.toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 56);
  return `${readable || `${locale || "any"}-${kind}`}-h-${shortHash(`${locale || ""}\u0000${kind}\u0000${text}`)}`.slice(0, 72);
}

export function makeProfileId(category: string, text: string): string {
  const readable = `profile-${category}-${text}`.toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 56);
  return `${readable || `profile-${category}`}-h-${shortHash(`${category}\u0000${text}`)}`.slice(0, 72);
}

export function makeAddressId(from: AddressParty, to: AddressParty, text: string): string {
  return `address-${from}-${to}-${shortHash(`${from}\u0000${to}\u0000${text}`)}`;
}

export function makeExpressionId(kind: ExpressionKind, summary: string): string {
  return `expression-${kind}-${shortHash(`${kind}\u0000${summary}`)}`;
}

export function clamp(value: number, min = 0, max = 1): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Math.max(min, Math.min(max, Number.isFinite(rounded) ? rounded : min));
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

function isParty(value: unknown): value is AddressParty { return value === "user" || value === "assistant"; }
function positiveInt(value: unknown, fallback: number): number { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback; }
function storedInt(value: unknown, fallback: number, min: number, max: number): number { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function stringOr(value: unknown, fallback: string): string { return typeof value === "string" && value ? value : fallback; }
function boundedString(value: unknown, max: number): string | undefined { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined; }
function labels(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, maxLen)))).slice(0, maxItems);
}
function readPositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[style-memory-mcp] Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  return value;
}
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36).padStart(7, "0");
}
