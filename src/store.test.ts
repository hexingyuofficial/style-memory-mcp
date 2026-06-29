import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { defaultSettings, makeId, makeProfileId, normalizeStore } from "./store.js";

let savedMinPromoteCount: string | undefined;
let savedMaxBriefItems: string | undefined;

beforeEach(() => {
  savedMinPromoteCount = process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  savedMaxBriefItems = process.env.STYLE_MEMORY_MAX_BRIEF_ITEMS;
});

afterEach(() => {
  restoreEnv("STYLE_MEMORY_MIN_PROMOTE_COUNT", savedMinPromoteCount);
  restoreEnv("STYLE_MEMORY_MAX_BRIEF_ITEMS", savedMaxBriefItems);
});

describe("makeId", () => {
  it("keeps readable ids while adding a stable hash", () => {
    const id = makeId("catchphrase", "哈哈哈", "zh-CN");
    assert.ok(id.startsWith("zh-cn-catchphrase-"));
    assert.match(id, /-h-[a-z0-9]+$/);
    assert.equal(id, makeId("catchphrase", "哈哈哈", "zh-CN"));
  });

  it("does not collide for symbol-only habits", () => {
    const thumbsUp = makeId("emoji", "👍");
    const party = makeId("emoji", "🎉");
    assert.notEqual(thumbsUp, party);
    assert.ok(thumbsUp.startsWith("any-emoji-h-"));
    assert.ok(party.startsWith("any-emoji-h-"));
  });
});

describe("makeProfileId", () => {
  it("creates stable profile ids with readable prefixes", () => {
    const id = makeProfileId(
      "response_structure",
      "prefers direct assessment before implementation",
    );
    assert.ok(id.startsWith("profile-response-structure-prefers-direct-assessment"));
    assert.match(id, /-h-[a-z0-9]+$/);
    assert.equal(
      id,
      makeProfileId("response_structure", "prefers direct assessment before implementation"),
    );
  });
});

describe("defaultSettings", () => {
  it("falls back when numeric env vars are invalid", () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "abc";
    process.env.STYLE_MEMORY_MAX_BRIEF_ITEMS = "0";

    const settings = defaultSettings("/tmp/style-memory-test.json");
    assert.equal(settings.minPromoteCount, 3);
    assert.equal(settings.maxBriefItems, 8);
  });

  it("accepts valid numeric env vars", () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "5";
    process.env.STYLE_MEMORY_MAX_BRIEF_ITEMS = "12";

    const settings = defaultSettings("/tmp/style-memory-test.json");
    assert.equal(settings.minPromoteCount, 5);
    assert.equal(settings.maxBriefItems, 12);
  });
});

describe("normalizeStore", () => {
  it("drops invalid items while preserving valid legacy items", () => {
    const store = normalizeStore(
      {
        version: 1,
        settings: {},
        habits: [
          {
            kind: "catchphrase",
            text: "哈哈哈",
            confidence: 0.5,
            seenCount: 3,
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            status: "active",
            pinned: false,
            useWhen: ["casual_chat"],
            avoidWhen: [],
          },
          {
            kind: "not-real",
            text: "bad",
          },
        ],
        profile: {
          preferences: [
            {
              category: "workflow",
              text: "prefers plan then implementation",
              status: "active",
              useWhen: [],
              avoidWhen: [],
            },
            {
              category: "workflow",
              text: "",
            },
          ],
        },
      },
      "/tmp/style-memory-test.json",
    );

    assert.equal(store.habits.length, 1);
    assert.equal(store.habits[0].text, "哈哈哈");
    assert.ok(store.habits[0].id);
    assert.equal(store.profile.preferences.length, 1);
    assert.equal(store.profile.preferences[0].category, "workflow");
    assert.ok(store.profile.preferences[0].id);
  });

  it("starts fresh when the store root shape is corrupt", () => {
    const store = normalizeStore({ habits: "bad" }, "/tmp/style-memory-test.json");
    assert.equal(store.habits.length, 0);
    assert.equal(store.profile.preferences.length, 0);
  });

  it("normalizes invalid stored settings and pins dataPath to the resolved path", () => {
    const store = normalizeStore(
      {
        settings: {
          dataPath: "/tmp/evil.json",
          minPromoteCount: "fast",
          maxBriefItems: 12,
          allowLearning: false,
        },
        habits: [],
      },
      "/tmp/style-memory-test.json",
    );

    assert.equal(store.settings.dataPath, "/tmp/style-memory-test.json");
    assert.equal(store.settings.minPromoteCount, 3);
    assert.equal(store.settings.maxBriefItems, 12);
    assert.equal(store.settings.allowLearning, false);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
