import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { StyleHabit, StyleSettings, StyleStore } from "./types.js";

const DEFAULT_DIR = join(homedir(), ".style-memory-mcp");
const DEFAULT_FILE = join(DEFAULT_DIR, "style-memory.json");

// ---- Write queue: serializes all saveStore calls to prevent race conditions ----
let writeQueue: Promise<void> = Promise.resolve();

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

/** Max distinct context labels we keep per habit. */
export const MAX_SEEN_CONTEXTS = 8;

export async function loadStore(dataPath = resolveDataPath()): Promise<StyleStore> {
  try {
    const raw = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw);

    // Runtime structural validation: ensure habits is an array
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.habits)) {
      console.warn(
        `[style-memory-mcp] Corrupt store structure at ${dataPath}, starting fresh.`,
      );
      return {
        version: 1,
        settings: defaultSettings(dataPath),
        habits: [],
      };
    }

    return normalizeStore(parsed as StyleStore, dataPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        version: 1,
        settings: defaultSettings(dataPath),
        habits: [],
      };
    }

    // JSON parse error (SyntaxError) — file is corrupt, start fresh
    if (error instanceof SyntaxError) {
      console.warn(
        `[style-memory-mcp] Corrupt JSON at ${dataPath}, starting fresh. Error: ${(error as Error).message}`,
      );
      return {
        version: 1,
        settings: defaultSettings(dataPath),
        habits: [],
      };
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
  writeQueue = writeQueue.then(
    () => doSave(store),
    () => doSave(store), // continue queue even after a previous failure
  );
  return writeQueue;
}

async function doSave(store: StyleStore): Promise<void> {
  await mkdir(dirname(store.settings.dataPath), { recursive: true });
  const tempPath = `${store.settings.dataPath}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, store.settings.dataPath);
}

export function normalizeStore(store: StyleStore, dataPath: string): StyleStore {
  const settings = {
    ...defaultSettings(dataPath),
    ...(store.settings || {}),
    dataPath,
  };

  return {
    version: 1,
    settings,
    habits: Array.isArray(store.habits) ? store.habits.map(normalizeHabit) : [],
    lastCleanupAt: store.lastCleanupAt,
  };
}

export function normalizeHabit(habit: StyleHabit): StyleHabit {
  const maxExampleLen = readPositiveIntEnv("STYLE_MEMORY_MAX_EXAMPLE_LEN", 60, 1, 240);

  // v0.2: example may pre-exist on disk; clamp to length and drop falsy values.
  const rawExample = typeof habit.example === "string" ? habit.example : undefined;
  const example =
    rawExample && rawExample.length > 0
      ? rawExample.slice(0, maxExampleLen)
      : undefined;

  // v0.2: seenContexts may be missing on legacy stores. Coerce to array, dedupe,
  // cap at MAX_SEEN_CONTEXTS so a tampered store can't bloat memory.
  const rawContexts = Array.isArray(habit.seenContexts) ? habit.seenContexts : [];
  const seenContexts = Array.from(
    new Set(rawContexts.filter((c): c is string => typeof c === "string" && c.length > 0)),
  ).slice(0, MAX_SEEN_CONTEXTS);

  return {
    id: habit.id,
    kind: habit.kind,
    text: habit.text,
    locale: habit.locale,
    confidence: clamp(habit.confidence ?? 0.1),
    seenCount: habit.seenCount ?? 1,
    firstSeenAt: habit.firstSeenAt || new Date().toISOString(),
    lastSeenAt: habit.lastSeenAt || new Date().toISOString(),
    lastReturnedAt: habit.lastReturnedAt,
    status: habit.status || "candidate",
    pinned: Boolean(habit.pinned),
    useWhen: habit.useWhen || [],
    avoidWhen: habit.avoidWhen || [],
    notes: habit.notes,
    example,
    seenContexts: seenContexts.length > 0 ? seenContexts : undefined,
    source: habit.source,
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
