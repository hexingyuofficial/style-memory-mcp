import type { StyleHabit, StyleStore } from "./types.js";
import { daysBetween } from "./store.js";

export interface CleanupResult {
  archived: number;
  deleted: number;
}

/**
 * Clean up expired habits from the store.
 * Mutates `store.habits` in place.
 *
 * Lifecycle:
 *   candidate + inactive > candidateTtlDays        → deleted
 *   active   + inactive > inactiveTtlDays          → archived
 *   archived + inactive > inactiveTtlDays * 2      → deleted
 *   active   + inactive > inactiveTtlDays * 3      → deleted (skip archive)
 *   pinned   (any status)                          → never touched
 */
export function cleanupStore(store: StyleStore, now = new Date()): CleanupResult {
  let archived = 0;
  let deleted = 0;

  const kept: StyleHabit[] = [];
  for (const habit of store.habits) {
    // Pinned habits bypass all cleanup — user explicitly wants to keep them
    if (habit.pinned) {
      kept.push(habit);
      continue;
    }

    const inactiveDays = daysBetween(new Date(habit.lastSeenAt), now);

    if (habit.status === "candidate" && inactiveDays > store.settings.candidateTtlDays) {
      deleted++;
      continue;
    }

    if (habit.status === "archived" && inactiveDays > store.settings.inactiveTtlDays * 2) {
      deleted++;
      continue;
    }

    if (habit.status === "active" && inactiveDays > store.settings.inactiveTtlDays * 3) {
      deleted++;
      continue;
    }

    if (habit.status === "active" && inactiveDays > store.settings.inactiveTtlDays) {
      habit.status = "archived";
      habit.confidence = Math.min(habit.confidence, 0.25);
      archived++;
    }

    kept.push(habit);
  }

  store.habits = kept;
  store.lastCleanupAt = now.toISOString();
  return { archived, deleted };
}
