import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type {
  InteractionPreference,
  InteractionPreferenceCategory,
  StyleHabit,
  StyleSettings,
  StyleStore,
} from "./types.js";

const DEFAULT_DIR = join(homedir(), ".style-memory-mcp");
const DEFAULT_FILE = join(DEFAULT_DIR, "style-memory.json");

const HABIT_KIND_SCHEMA = z.enum([
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

const HABIT_STATUS_SCHEMA = z.enum(["candidate", "active", "archived"]);
const HABIT_SOURCE_SCHEMA = z.enum(["rule", "hint", "distill"]);

const STYLE_HABIT_SCHEMA = z
  .object({
    id: z.string().min(1).optional(),
    kind: HABIT_KIND_SCHEMA,
    text: z.string().min(1),
    locale: z.string().optional(),
    confidence: z.number().finite().optional(),
    seenCount: z.number().int().positive().optional(),
    firstSeenAt: z.string().optional(),
    lastSeenAt: z.string().optional(),
    lastReturnedAt: z.string().optional(),
    status: HABIT_STATUS_SCHEMA.optional(),
    pinned: z.boolean().optional(),
    useWhen: z.array(z.string()).optional(),
    avoidWhen: z.array(z.string()).optional(),
    notes: z.string().optional(),
    example: z.string().optional(),
    seenContexts: z.array(z.string()).optional(),
    source: HABIT_SOURCE_SCHEMA.optional(),
  })
  .passthrough();

const INTERACTION_PREFERENCE_SCHEMA = z
  .object({
    id: z.string().min(1).optional(),
    category: z.string().optional(),
    text: z.string().min(1),
    confidence: z.number().finite().optional(),
    seenCount: z.number().int().positive().optional(),
    firstSeenAt: z.string().optional(),
    lastSeenAt: z.string().optional(),
    lastReturnedAt: z.string().optional(),
    status: HABIT_STATUS_SCHEMA.optional(),
    pinned: z.boolean().optional(),
    useWhen: z.array(z.string()).optional(),
    avoidWhen: z.array(z.string()).optional(),
    notes: z.string().optional(),
    example: z.string().optional(),
    seenContexts: z.array(z.string()).optional(),
    source: HABIT_SOURCE_SCHEMA.optional(),
  })
  .passthrough();

const STORE_SCHEMA = z
  .object({
    version: z.number().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    habits: z.array(z.unknown()),
    profile: z
      .object({
        preferences: z.array(z.unknown()).optional(),
      })
      .optional(),
    lastCleanupAt: z.string().optional(),
  })
  .passthrough();

// ---- Store operation queue: serializes writes and read-modify-write mutations. ----
let storeQueue: Promise<void> = Promise.resolve();

export function resolveDataPath(input?: string): string {
  return input?.trim() || process.env.STYLE_MEMORY_PATH || DEFAULT_FILE;
}

export function defaultSettings(dataPath = DEFAULT_FILE): StyleSettings {
  return {
    dataPath,
    minPromoteCount: readPositiveIntEnv("STYLE_MEMORY_MIN_PROMOTE_COUNT", 3, 1, 50),
    candidateTtlDays: readPositiveIntEnv("STYLE_MEMORY_CANDIDATE_TTL_DAYS", 30, 1, 3650),
    inactiveTtlDays: readPositiveIntEnv("STYLE_MEMORY_INACTIVE_TTL_DAYS", 180, 1, 3650),
    maxBriefItems: readPositiveIntEnv("STYLE_MEMORY_MAX_BRIEF_ITEMS", 8, 1, 50),
    maxExampleLen: readPositiveIntEnv("STYLE_MEMORY_MAX_EXAMPLE_LEN", 60, 1, 240),
    allowLearning: process.env.STYLE_MEMORY_LEARNING !== "off",
  };
}

function freshStore(dataPath: string): StyleStore {
  return {
    version: 1,
    settings: defaultSettings(dataPath),
    habits: [],
    profile: { preferences: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Max distinct context labels we keep per habit. */
export const MAX_SEEN_CONTEXTS = 8;

export async function loadStore(dataPath = resolveDataPath()): Promise<StyleStore> {
  try {
    const raw = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw);

    return normalizeStore(parsed, dataPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return freshStore(dataPath);
    }

    // JSON parse error (SyntaxError) — file is corrupt, start fresh
    if (error instanceof SyntaxError) {
      console.warn(
        `[style-memory-mcp] Corrupt JSON at ${dataPath}, starting fresh. Error: ${(error as Error).message}`,
      );
      return freshStore(dataPath);
    }

    throw error;
  }
}

/**
 * Save the store to disk. All writes are serialized through a promise chain
 * to prevent race conditions where concurrent observe calls overwrite each
 * other's data.
 *
 * Uses atomic write (tmp → rename) so a crash mid-write never produces a
 * partially-written file.
 */
export async function saveStore(store: StyleStore): Promise<void> {
  const write = storeQueue.then(
    () => doSave(store),
    () => doSave(store), // continue queue even after a previous failure
  );
  storeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

/**
 * Run a read-modify-write operation as one serialized transaction.
 *
 * This prevents concurrent MCP tool calls from loading the same old store,
 * mutating separate copies, and overwriting each other's updates on save.
 * Do not call `saveStore` from inside the callback; the final save happens
 * automatically after the callback resolves.
 */
export async function withStoreMutation<T>(
  mutate: (store: StyleStore) => T | Promise<T>,
  dataPath = resolveDataPath(),
): Promise<T> {
  const job = storeQueue.then(
    () => doStoreMutation(mutate, dataPath),
    () => doStoreMutation(mutate, dataPath),
  );
  storeQueue = job.then(
    () => undefined,
    () => undefined,
  );
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
  await mkdir(dirname(store.settings.dataPath), { recursive: true });
  const tempPath = `${store.settings.dataPath}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, store.settings.dataPath);
}

export function normalizeStore(store: unknown, dataPath: string): StyleStore {
  const parsed = STORE_SCHEMA.safeParse(store);
  if (!parsed.success) {
    console.warn(
      `[style-memory-mcp] Corrupt store structure at ${dataPath}, starting fresh.`,
    );
    return freshStore(dataPath);
  }

  const raw = parsed.data;
  const settings = normalizeSettings(raw.settings, dataPath);

  return {
    version: 1,
    settings,
    habits: raw.habits.flatMap((habit) => {
      const normalized = normalizeHabit(habit);
      return normalized ? [normalized] : [];
    }),
    profile: normalizeProfile(raw.profile),
    lastCleanupAt: raw.lastCleanupAt,
  };
}

function normalizeSettings(settings: unknown, dataPath: string): StyleSettings {
  const defaults = defaultSettings(dataPath);
  if (!isRecord(settings)) return defaults;

  return {
    dataPath,
    minPromoteCount: readStoredPositiveInt(
      settings.minPromoteCount,
      defaults.minPromoteCount,
      1,
      50,
    ),
    candidateTtlDays: readStoredPositiveInt(
      settings.candidateTtlDays,
      defaults.candidateTtlDays,
      1,
      3650,
    ),
    inactiveTtlDays: readStoredPositiveInt(
      settings.inactiveTtlDays,
      defaults.inactiveTtlDays,
      1,
      3650,
    ),
    maxBriefItems: readStoredPositiveInt(
      settings.maxBriefItems,
      defaults.maxBriefItems,
      1,
      50,
    ),
    maxExampleLen: readStoredPositiveInt(
      settings.maxExampleLen,
      defaults.maxExampleLen,
      1,
      240,
    ),
    allowLearning:
      typeof settings.allowLearning === "boolean"
        ? settings.allowLearning
        : defaults.allowLearning,
  };
}

export function normalizeHabit(habit: unknown): StyleHabit | undefined {
  const parsed = STYLE_HABIT_SCHEMA.safeParse(habit);
  if (!parsed.success) return undefined;

  const raw = parsed.data;
  const maxExampleLen = readPositiveIntEnv("STYLE_MEMORY_MAX_EXAMPLE_LEN", 60, 1, 240);

  // v0.2: example may pre-exist on disk; clamp to length and drop falsy values.
  const rawExample = typeof raw.example === "string" ? raw.example : undefined;
  const example =
    rawExample && rawExample.length > 0
      ? rawExample.slice(0, maxExampleLen)
      : undefined;

  // v0.2: seenContexts may be missing on legacy stores. Coerce to array, dedupe,
  // cap at MAX_SEEN_CONTEXTS so a tampered store can't bloat memory.
  const rawContexts = Array.isArray(raw.seenContexts) ? raw.seenContexts : [];
  const seenContexts = Array.from(
    new Set(rawContexts.filter((c): c is string => typeof c === "string" && c.length > 0)),
  ).slice(0, MAX_SEEN_CONTEXTS);

  return {
    id: raw.id || makeId(raw.kind, raw.text, raw.locale),
    kind: raw.kind,
    text: raw.text,
    locale: raw.locale,
    confidence: clamp(raw.confidence ?? 0.1),
    seenCount: raw.seenCount ?? 1,
    firstSeenAt: raw.firstSeenAt || new Date().toISOString(),
    lastSeenAt: raw.lastSeenAt || new Date().toISOString(),
    lastReturnedAt: raw.lastReturnedAt,
    status: raw.status || "candidate",
    pinned: Boolean(raw.pinned),
    useWhen: raw.useWhen || [],
    avoidWhen: raw.avoidWhen || [],
    notes: raw.notes,
    example,
    seenContexts: seenContexts.length > 0 ? seenContexts : undefined,
    source: raw.source,
  };
}

export function normalizeProfile(profile: unknown): StyleStore["profile"] {
  const preferences = isRecord(profile) && Array.isArray(profile.preferences)
    ? profile.preferences.flatMap((preference) => {
        const normalized = normalizeInteractionPreference(preference);
        return normalized ? [normalized] : [];
      })
    : [];
  return { preferences };
}

export function normalizeInteractionPreference(
  preference: unknown,
): InteractionPreference | undefined {
  const parsed = INTERACTION_PREFERENCE_SCHEMA.safeParse(preference);
  if (!parsed.success) return undefined;

  const raw = parsed.data;
  const maxExampleLen = readPositiveIntEnv("STYLE_MEMORY_MAX_EXAMPLE_LEN", 60, 1, 240);
  const rawExample = typeof raw.example === "string" ? raw.example : undefined;
  const example =
    rawExample && rawExample.length > 0
      ? rawExample.slice(0, maxExampleLen)
      : undefined;
  const rawContexts = Array.isArray(raw.seenContexts) ? raw.seenContexts : [];
  const seenContexts = Array.from(
    new Set(rawContexts.filter((c): c is string => typeof c === "string" && c.length > 0)),
  ).slice(0, MAX_SEEN_CONTEXTS);
  const category = normalizeProfileCategory(raw.category);

  return {
    id: raw.id || makeProfileId(category, raw.text),
    category,
    text: raw.text,
    confidence: clamp(raw.confidence ?? 0.1),
    seenCount: raw.seenCount ?? 1,
    firstSeenAt: raw.firstSeenAt || new Date().toISOString(),
    lastSeenAt: raw.lastSeenAt || new Date().toISOString(),
    lastReturnedAt: raw.lastReturnedAt,
    status: raw.status || "candidate",
    pinned: Boolean(raw.pinned),
    useWhen: raw.useWhen || [],
    avoidWhen: raw.avoidWhen || [],
    notes: raw.notes,
    example,
    seenContexts: seenContexts.length > 0 ? seenContexts : undefined,
    source: raw.source,
  };
}

export function makeId(kind: string, text: string, locale?: string): string {
  const readable = `${locale || "any"}-${kind}-${text}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  const prefix = readable || `${locale || "any"}-${kind}`;
  return `${prefix}-h-${shortHash(`${locale || ""}\u0000${kind}\u0000${text}`)}`.slice(0, 72);
}

export function makeProfileId(category: string, text: string): string {
  const readable = `profile-${category}-${text}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  const prefix = readable || `profile-${category}`;
  return `${prefix}-h-${shortHash(`${category}\u0000${text}`)}`.slice(0, 72);
}

function normalizeProfileCategory(category: unknown): InteractionPreferenceCategory {
  switch (category) {
    case "response_structure":
    case "collaboration":
    case "explanation":
    case "decision_making":
    case "workflow":
    case "tone_boundary":
      return category;
    default:
      return "collaboration";
  }
}

function readPositiveIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(
      `[style-memory-mcp] Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

function readStoredPositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isInteger(value) && typeof value === "number" && value >= min && value <= max
    ? value
    : fallback;
}

function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/**
 * Clamp a number to [min, max] and round to 4 decimal places.
 * Uses Math.round instead of toFixed for consistent rounding across JS engines.
 */
export function clamp(value: number, min = 0, max = 1): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Math.max(min, Math.min(max, rounded));
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}
