import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { defaultSettings, makeId, makeProfileId } from "./store.js";

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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
