import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanupStore } from "./cleanup.js";
import { normalizeStore } from "./store.js";

const DAY = 86_400_000;

function pattern(status: "candidate" | "active" | "archived", ageDays: number, pinned = false) {
  const at = new Date(Date.UTC(2026, 0, 1) - ageDays * DAY).toISOString();
  return {
    id: status + "-" + ageDays + "-" + (pinned ? "pinned" : "plain"),
    kind: "lexical" as const,
    behaviorSummary: "a bounded expression pattern",
    functions: ["确认"],
    variationPolicy: "exact_only" as const,
    examples: ["x"], useWhen: [], avoidWhen: [], status,
    pinned, explicit: false, confidence: 0.5, seenCount: 3, sessionCount: 2,
    firstSeenAt: at, lastSeenAt: at, evidence: {
      seenCount: 3, sessionIds: ["a", "b"], firstSeenAt: at, lastSeenAt: at, evidence: [],
    },
  };
}

function fixture(patterns: ReturnType<typeof pattern>[]) {
  return normalizeStore(
    { version: 2, settings: {}, habits: [], profile: { expressionPatterns: patterns } },
    "./cleanup-test.json",
  );
}

describe("expression cleanup TTL boundaries", () => {
  it("applies candidate 30d, active 180d, and archived 360d at the boundary", () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const store = fixture([
      pattern("candidate", 30),
      pattern("active", 180),
      pattern("archived", 360),
      pattern("candidate", 29),
      pattern("active", 179),
      pattern("archived", 359),
    ]);
    const result = cleanupStore(store, now);
    assert.equal(result.deleted, 2);
    assert.equal(result.archived, 1);
    assert.ok(store.profile.expressionPatterns.some((item) => item.id === "candidate-29-plain"));
    assert.ok(store.profile.expressionPatterns.some((item) => item.id === "active-179-plain"));
    assert.ok(store.profile.expressionPatterns.some((item) => item.id === "archived-359-plain"));
  });

  it("protects pinned patterns at every TTL boundary", () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const store = fixture([
      pattern("candidate", 30, true),
      pattern("active", 180, true),
      pattern("archived", 360, true),
    ]);
    const result = cleanupStore(store, now);
    assert.equal(result.deleted, 0);
    assert.equal(result.archived, 0);
    assert.equal(store.profile.expressionPatterns.length, 3);
  });

  it("does not apply expression TTL to compatibility habits or preferences", () => {
    const old = new Date(Date.UTC(2024, 0, 1)).toISOString();
    const store = normalizeStore({
      version: 2,
      settings: {},
      habits: [{
        id: "legacy-old", kind: "catchphrase", text: "legacy", confidence: 0.5, seenCount: 2,
        firstSeenAt: old, lastSeenAt: old, status: "active", pinned: false, useWhen: [], avoidWhen: [],
      }],
      profile: {
        preferences: [{
          id: "preference-old", category: "workflow", text: "keep this", confidence: 0.5, seenCount: 2,
          firstSeenAt: old, lastSeenAt: old, status: "active", pinned: false, useWhen: [], avoidWhen: [],
        }],
        expressionPatterns: [],
      },
    }, "./cleanup-compatibility.json");
    cleanupStore(store, new Date(Date.UTC(2026, 0, 1)));
    assert.equal(store.habits[0]?.status, "active");
    assert.equal(store.profile.preferences[0]?.status, "active");
  });
});
