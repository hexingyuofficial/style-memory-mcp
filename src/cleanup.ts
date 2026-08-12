import type { ExpressionPattern, StyleStore } from "./types.js";
import {
  MAX_EXPRESSION_ACTIVE,
  MAX_EXPRESSION_ARCHIVED,
  MAX_EXPRESSION_CANDIDATE,
  daysBetween,
} from "./store.js";

export interface CleanupResult {
  archived: number;
  deleted: number;
  capacity?: string[];
}

/** Deterministic TTL cleanup. Addresses, failure rules and explicit preferences are never touched. */
export function cleanupStore(store: StyleStore, now = new Date()): CleanupResult {
  let archived = 0;
  let deleted = 0;
  const capacity: string[] = [];

  const patterns = cleanupExpressions(store.profile.expressionPatterns, store, () => archived++, () => deleted++, now);
  store.profile.expressionPatterns = enforceExpressionCapacity(patterns, capacity);

  if (archived > 0 || deleted > 0 || capacity.length > 0) {
    store.lastCleanupAt = now.toISOString();
  }
  return { archived, deleted, capacity: capacity.length ? capacity : undefined };
}

function cleanupExpressions(
  items: ExpressionPattern[],
  store: StyleStore,
  onArchived: () => void,
  onDeleted: () => void,
  now: Date,
): ExpressionPattern[] {
  const kept: ExpressionPattern[] = [];
  for (const item of items) {
    if (item.pinned) {
      kept.push(item);
      continue;
    }
    const inactiveDays = daysBetween(new Date(item.lastSeenAt), now);
    if (item.status === "candidate" && inactiveDays >= store.settings.candidateTtlDays) {
      onDeleted();
      continue;
    }
    if (item.status === "active" && inactiveDays >= store.settings.inactiveTtlDays) {
      item.status = "archived";
      item.archivedAt = now.toISOString();
      item.evidence.lastArchivedAt = item.archivedAt;
      item.confidence = Math.min(item.confidence, 0.25);
      onArchived();
      kept.push(item);
      continue;
    }
    if (item.status === "archived" && inactiveDays >= store.settings.inactiveTtlDays * 2) {
      onDeleted();
      continue;
    }
    kept.push(item);
  }
  return kept;
}

function enforceExpressionCapacity(items: ExpressionPattern[], capacity: string[]): ExpressionPattern[] {
  const limits: Record<ExpressionPattern["status"], number> = {
    active: MAX_EXPRESSION_ACTIVE,
    candidate: MAX_EXPRESSION_CANDIDATE,
    archived: MAX_EXPRESSION_ARCHIVED,
  };
  const kept: ExpressionPattern[] = [];
  for (const status of ["active", "candidate", "archived"] as const) {
    const group = items.filter((item) => item.status === status);
    const protectedItems = group.filter((item) => item.pinned || item.explicit);
    const unprotectedItems = group.filter((item) => !item.pinned && !item.explicit);
    const available = Math.max(0, limits[status] - protectedItems.length);
    const sorted = protectedItems.length >= limits[status]
      ? protectedItems
      : [...protectedItems, ...unprotectedItems.sort(compareProtected).slice(0, available)];
    if (sorted.length < group.length) capacity.push(`expression_${status}_capacity`);
    if (protectedItems.length >= limits[status] && unprotectedItems.length > 0) {
      capacity.push(`expression_${status}_protected_full`);
    }
    kept.push(...sorted);
  }
  return kept.sort((a, b) => a.id.localeCompare(b.id));
}

function compareProtected(a: ExpressionPattern, b: ExpressionPattern): number {
  return Number(b.pinned) - Number(a.pinned)
    || Number(b.explicit) - Number(a.explicit)
    || b.sessionCount - a.sessionCount
    || b.seenCount - a.seenCount
    || b.lastSeenAt.localeCompare(a.lastSeenAt)
    || a.id.localeCompare(b.id);
}
