import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  distillInteractionProfile,
  distillRecentStyle,
  observeUserMessage,
  getStyleBrief,
  getStyleMemoryScore,
  listInteractionProfile,
  listStyleHabits,
  forgetInteractionPreference,
  forgetStyleHabit,
  pinInteractionPreference,
  pinStyleHabit,
  reviewInteractionProfile,
  reviewStyleHabits,
} from "./memory.js";
import { loadStore, saveStore } from "./store.js";

const testDir = join(tmpdir(), `style-memory-test-${randomUUID()}`);
const testFile = join(testDir, "style-memory.json");

// Save and restore any pre-existing env var to avoid pollution
let savedEnvPath: string | undefined;

before(async () => {
  savedEnvPath = process.env.STYLE_MEMORY_PATH;
  await mkdir(testDir, { recursive: true });
  process.env.STYLE_MEMORY_PATH = testFile;
  await rm(testFile, { force: true });
});

after(async () => {
  if (savedEnvPath !== undefined) {
    process.env.STYLE_MEMORY_PATH = savedEnvPath;
  } else {
    delete process.env.STYLE_MEMORY_PATH;
  }
  await rm(testDir, { recursive: true, force: true });
});

// Reset the store before each test for clean isolation
beforeEach(async () => {
  const store = await loadStore();
  store.habits = [];
  store.profile.preferences = [];
  store.settings.allowLearning = true;
  await saveStore(store);
});

describe("observeUserMessage", () => {
  it("learns a new habit from a user message", async () => {
    const result = await observeUserMessage("这个东西锤子得很");
    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].text, "锤子");
    assert.equal(result.learned[0].status, "candidate");
    assert.equal(result.learned[0].seenCount, 1);
    assert.equal(result.ignored.length, 0);
  });

  it("updates an existing habit on repeated use", async () => {
    // Seed: first observation
    await observeUserMessage("锤子");
    // Second observation — should update, not learn
    const result = await observeUserMessage("锤子");
    assert.equal(result.updated.length, 1);
    assert.equal(result.updated[0].text, "锤子");
    // seenCount should be 2 (1 from seed + 1 from this call)
    assert.equal(result.updated[0].seenCount, 2);
    assert.equal(result.learned.length, 0);
  });

  it("promotes a candidate to active after minPromoteCount uses", async () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "3";
    // 3 uses of the same word
    await observeUserMessage("巴适");
    await observeUserMessage("巴适");
    const result = await observeUserMessage("巴适");
    const updated = result.updated[0];
    assert.equal(updated.status, "active");
    assert.ok(updated.confidence >= 0.35);
    delete process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  });

  it("ignores empty messages", async () => {
    const result = await observeUserMessage("");
    assert.equal(result.learned.length, 0);
    assert.equal(result.updated.length, 0);
  });

  it("ignores sensitive content with credential patterns", async () => {
    const result = await observeUserMessage("my token=sk-abc123xyz789secret");
    assert.ok(result.ignored.includes("sensitive_context"));
    assert.equal(result.learned.length, 0);
  });

  it("does NOT ignore casual mentions of password topics", async () => {
    const result = await observeUserMessage("我密码忘了怎么办");
    assert.ok(!result.ignored.includes("sensitive_context"));
  });

  it("does NOT ignore normal JSON examples (not credentials)", async () => {
    // Sharing a config snippet should not be blocked
    const result = await observeUserMessage('my config: {"name": "my-config-file-v2"}');
    assert.ok(!result.ignored.includes("sensitive_context"));
  });

  it("respects learning_enabled off", async () => {
    const store = await loadStore();
    store.settings.allowLearning = false;
    await saveStore(store);

    const result = await observeUserMessage("哈哈哈");
    assert.equal(result.ignored[0], "learning_disabled");

    // Re-enable for subsequent tests
    store.settings.allowLearning = true;
    await saveStore(store);
  });
});

describe("getStyleBrief", () => {
  it("returns a brief string with active habits", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "test-active-1",
        kind: "catchphrase" as const,
        text: "哈哈哈",
        locale: "zh-CN",
        confidence: 0.5,
        seenCount: 5,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: ["formal_writing"],
      },
    ];
    await saveStore(store);

    const brief = await getStyleBrief();
    assert.ok(brief.includes("哈哈哈"));
    assert.ok(brief.includes("How to apply:"));
    assert.ok(brief.includes("Relevant habits:"));
  });

  it("returns fallback message when no active habits", async () => {
    const brief = await getStyleBrief();
    assert.ok(brief.includes("No stable style habits yet"));
  });

  it("filters out habits with avoidWhen matching context", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "test-formal-avoid",
        kind: "catchphrase" as const,
        text: "lol",
        locale: "en",
        confidence: 0.5,
        seenCount: 5,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: ["formal_writing"],
      },
    ];
    await saveStore(store);

    const brief = await getStyleBrief("formal_writing");
    assert.ok(!brief.includes("lol"));
    assert.ok(brief.includes("No stable style habits"));
  });

  it("filters playful habits in high-stakes contexts", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "test-emoji",
        kind: "emoji" as const,
        text: "👍",
        confidence: 0.8,
        seenCount: 8,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["playful_chat"],
        avoidWhen: [],
      },
      {
        id: "test-tone",
        kind: "tone" as const,
        text: "warm-soft-tone",
        confidence: 0.6,
        seenCount: 8,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["high_stakes_advice"],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const brief = await getStyleBrief("medical");
    assert.ok(!brief.includes("👍"));
    assert.ok(brief.includes("warm-soft-tone"));
  });

  it("prioritizes habits that match the requested context", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "generic",
        kind: "tone" as const,
        text: "generic-friendly",
        confidence: 0.7,
        seenCount: 5,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: [],
      },
      {
        id: "technical",
        kind: "language_mix" as const,
        text: "zh-en-code-mix",
        confidence: 0.6,
        seenCount: 5,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["technical_chat"],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const brief = await getStyleBrief("technical_chat");
    assert.ok(brief.indexOf("zh-en-code-mix") < brief.indexOf("generic-friendly"));
  });

  it("includes active interaction profile preferences", async () => {
    const store = await loadStore();
    store.profile.preferences = [
      {
        id: "profile-direct-plan",
        category: "response_structure" as const,
        text: "prefers direct assessment before implementation",
        confidence: 0.8,
        seenCount: 5,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["technical_chat"],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const brief = await getStyleBrief("technical_chat");
    assert.ok(brief.includes("Interaction profile:"));
    assert.ok(brief.includes("prefers direct assessment before implementation"));
  });
});

describe("reviewStyleHabits", () => {
  it("summarizes habits and suggests review actions", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.habits = [
      {
        id: "strong-active",
        kind: "tone" as const,
        text: "warm-soft-tone",
        confidence: 0.8,
        seenCount: 8,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: ["formal_writing"],
      },
      {
        id: "weak-candidate",
        kind: "idiolect" as const,
        text: "one-off",
        confidence: 0.1,
        seenCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "candidate" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
      {
        id: "old-archived",
        kind: "catchphrase" as const,
        text: "old",
        confidence: 0.2,
        seenCount: 5,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "archived" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const review = await reviewStyleHabits();
    assert.equal(review.summary.total, 3);
    assert.equal(review.summary.active, 1);
    assert.equal(review.summary.candidates, 1);
    assert.equal(review.summary.archived, 1);

    const strong = review.suggestions.find((item) => item.id === "strong-active");
    const weak = review.suggestions.find((item) => item.id === "weak-candidate");
    const archived = review.suggestions.find((item) => item.id === "old-archived");
    assert.equal(strong?.suggestedAction, "pin");
    assert.equal(weak?.suggestedAction, "forget");
    assert.equal(archived?.suggestedAction, "forget");
  });

  it("respects review limit", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.habits = Array.from({ length: 5 }, (_, index) => ({
      id: `habit-${index}`,
      kind: "catchphrase" as const,
      text: `habit-${index}`,
      confidence: 0.4,
      seenCount: index + 1,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "candidate" as const,
      pinned: false,
      useWhen: [],
      avoidWhen: [],
    }));
    await saveStore(store);

    const review = await reviewStyleHabits(2);
    assert.equal(review.suggestions.length, 2);
  });
});

describe("listStyleHabits", () => {
  it("returns habits sorted by confidence and seenCount", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "low-conf",
        kind: "catchphrase" as const,
        text: "low",
        locale: "zh-CN",
        confidence: 0.3,
        seenCount: 2,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "candidate" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
      {
        id: "high-conf",
        kind: "catchphrase" as const,
        text: "high",
        locale: "zh-CN",
        confidence: 0.8,
        seenCount: 10,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const habits = await listStyleHabits();
    assert.equal(habits[0].text, "high");
    assert.equal(habits[1].text, "low");
  });
});

describe("forgetStyleHabit", () => {
  it("removes a habit by exact text", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "to-forget",
        kind: "catchphrase" as const,
        text: "forget-me",
        locale: "en",
        confidence: 0.5,
        seenCount: 3,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const removed = await forgetStyleHabit("forget-me");
    assert.equal(removed, true);

    const habits = await listStyleHabits();
    assert.equal(habits.length, 0);
  });

  it("returns false for non-existent habit", async () => {
    const removed = await forgetStyleHabit("does-not-exist-xyz");
    assert.equal(removed, false);
  });
});

describe("pinStyleHabit", () => {
  it("pins and unpins a habit", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "to-pin",
        kind: "catchphrase" as const,
        text: "pin-me",
        locale: "en",
        confidence: 0.5,
        seenCount: 3,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const pinned = await pinStyleHabit("pin-me", true);
    assert.equal(pinned, true);

    const habits = await listStyleHabits();
    assert.equal(habits[0].pinned, true);

    const unpinned = await pinStyleHabit("pin-me", false);
    assert.equal(unpinned, true);
  });

  it("returns false for non-existent habit", async () => {
    const result = await pinStyleHabit("does-not-exist", true);
    assert.equal(result, false);
  });
});

// ---- Cleanup lifecycle tests ----

describe("cleanup lifecycle (via observeUserMessage)", () => {
  it("archived habits are eventually deleted", async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * 86_400_000); // 400 days ago

    const store = await loadStore();
    store.habits = [
      {
        id: "old-archived",
        kind: "catchphrase" as const,
        text: "ancient",
        locale: "en",
        confidence: 0.2,
        seenCount: 5,
        firstSeenAt: oldDate.toISOString(),
        lastSeenAt: oldDate.toISOString(),
        status: "archived" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    // Trigger cleanup via observe
    const result = await observeUserMessage("hello");
    assert.ok(result.cleanup.deleted >= 1 || result.cleanup.archived >= 0);

    // Old archived habit should be gone
    const habits = await listStyleHabits();
    const ancient = habits.find((h) => h.id === "old-archived");
    assert.equal(ancient, undefined);
  });

  it("pinned habits survive cleanup", async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * 86_400_000);

    const store = await loadStore();
    store.habits = [
      {
        id: "pinned-ancient",
        kind: "catchphrase" as const,
        text: "immortal",
        locale: "en",
        confidence: 0.5,
        seenCount: 10,
        firstSeenAt: oldDate.toISOString(),
        lastSeenAt: oldDate.toISOString(),
        status: "candidate" as const,
        pinned: true,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    await observeUserMessage("hello");

    const habits = await listStyleHabits();
    const pinned = habits.find((h) => h.id === "pinned-ancient");
    assert.ok(pinned, "pinned habit should survive cleanup");
  });
});

// =============================================================================
// v0.2: host-LLM hints + cross-context promote + distillation
// =============================================================================

describe("observeUserMessage with hints", () => {
  it("learns a custom idiolect kind reported by host LLM", async () => {
    const result = await observeUserMessage(
      "今天天气好巴适莫",
      "casual_chat",
      [
        {
          kind: "sentence_final_particle",
          text: "莫",
          example: "今天天气好巴适莫",
          confidence: 0.6,
          notes: "用户自创句尾助词",
        },
      ],
    );
    const moHabit = [...result.learned, ...result.updated].find((h) => h.text === "莫");
    assert.ok(moHabit, "should learn the '莫' particle from hints");
    assert.equal(moHabit!.kind, "sentence_final_particle");
    assert.equal(moHabit!.source, "hint");
    assert.equal(moHabit!.example, "今天天气好巴适莫");
    assert.deepEqual(moHabit!.seenContexts, ["casual_chat"]);
  });

  it("requires cross-context observation before promoting a low-confidence hint", async () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "3";
    // 3 sightings, all in the SAME context — count is satisfied, but
    // the cross-context gate should keep it as a candidate.
    for (let i = 0; i < 3; i++) {
      await observeUserMessage("好困莫", "casual_chat", [
        { kind: "sentence_final_particle", text: "莫", confidence: 0.5 },
      ]);
    }
    let habits = await listStyleHabits();
    let mo = habits.find((h) => h.text === "莫");
    assert.ok(mo);
    assert.equal(mo!.status, "candidate", "single-context hint should NOT promote");

    // Now seen under a second context — promote.
    await observeUserMessage("没思路莫", "technical_chat", [
      { kind: "sentence_final_particle", text: "莫", confidence: 0.5 },
    ]);
    habits = await listStyleHabits();
    mo = habits.find((h) => h.text === "莫");
    assert.equal(mo!.status, "active", "two-context hint should promote");
    assert.ok((mo!.seenContexts ?? []).length >= 2);
    delete process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  });

  it("high-confidence hint bypasses cross-context gate", async () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "3";
    for (let i = 0; i < 3; i++) {
      await observeUserMessage("呢个真系好正啊", "casual_chat", [
        { kind: "dialect_marker", text: "正", locale: "zh-CN-cantonese", confidence: 1.0 },
      ]);
    }
    const habits = await listStyleHabits();
    const zheng = habits.find((h) => h.text === "正");
    assert.ok(zheng, "high-conviction hint should be learned");
    assert.equal(zheng!.status, "active", "≥0.71 confidence hint should bypass cross-context gate");
    delete process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  });

  it("a single high-confidence hint does NOT promote on first sighting", async () => {
    // Regression guard: an overconfident LLM that fires confidence=1.0 once
    // must not be able to insta-promote anything to active. The minPromote
    // gate (seenCount ≥ 3) still applies, AND the high-conviction bypass
    // requires seenCount ≥ HIGH_CONVICTION_MIN_SEEN even after minPromote
    // is reached, in case a future change relaxes minPromote globally.
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "1";
    await observeUserMessage("人生海海", "casual_chat", [
      { kind: "idiolect", text: "海海", confidence: 1.0 },
    ]);
    const habits = await listStyleHabits();
    const haihai = habits.find((h) => h.text === "海海");
    assert.ok(haihai, "hint should still be learned as a candidate");
    assert.equal(
      haihai!.status,
      "candidate",
      "one-shot overconfident hint must stay a candidate even when minPromoteCount=1",
    );
    delete process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  });

  it("drops sensitive example but keeps the hint itself", async () => {
    const result = await observeUserMessage(
      "我打字超快",
      "casual_chat",
      [
        {
          kind: "idiolect",
          text: "超快",
          example: "my password=hunter2supersecretvalue123",
          confidence: 0.4,
        },
      ],
    );
    const learned = [...result.learned, ...result.updated].find((h) => h.text === "超快");
    assert.ok(learned);
    assert.equal(learned!.example, undefined, "sensitive example must not be stored");
  });

  it("rejects malformed hints without failing the call", async () => {
    const result = await observeUserMessage(
      "hello world",
      "casual_chat",
      [
        // @ts-expect-error — intentionally bad kind to test runtime guard
        { kind: "not_a_real_kind", text: "x" },
        { kind: "idiolect", text: "", confidence: 0.5 },
        { kind: "idiolect", text: "a".repeat(60), confidence: 0.5 },
      ],
    );
    assert.ok(result.ignored.some((s) => s.startsWith("hint_unknown_kind")));
    assert.ok(result.ignored.includes("hint_bad_text"));
  });

  it("does NOT learn from hints when message is sensitive", async () => {
    const result = await observeUserMessage(
      "my api key = sk-abc123xyzlongsecretvalue",
      "casual_chat",
      [{ kind: "idiolect", text: "abc", confidence: 0.9 }],
    );
    assert.ok(result.ignored.includes("sensitive_context"));
    assert.equal(result.learned.length, 0);
  });

  it("rejects sensitive hint text", async () => {
    const result = await observeUserMessage(
      "hello",
      "casual_chat",
      [{ kind: "idiolect", text: "test@example.com", confidence: 0.9 }],
    );
    assert.ok(result.ignored.includes("hint_sensitive"));
    assert.equal(result.learned.length, 0);
  });

  it("drops sensitive hint notes and labels while keeping the habit", async () => {
    const result = await observeUserMessage(
      "hello vibe",
      "casual_chat",
      [
        {
          kind: "idiolect",
          text: "vibe",
          notes: "email test@example.com",
          useWhen: ["casual_chat", "test@example.com"],
          avoidWhen: ["formal_writing", "13800138000"],
          confidence: 0.6,
        },
      ],
    );
    const habit = result.learned.find((h) => h.text === "vibe");
    assert.ok(habit);
    assert.equal(habit!.notes, undefined);
    assert.deepEqual(habit!.useWhen, ["casual_chat"]);
    assert.deepEqual(habit!.avoidWhen, ["formal_writing"]);
  });

  it("learns concrete interaction profile hints", async () => {
    const result = await observeUserMessage(
      "先判断值不值得做，再给我步骤",
      "technical_chat",
      undefined,
      [
        {
          category: "response_structure",
          text: "prefers value judgment before step-by-step implementation",
          example: "先判断值不值得做，再给我步骤",
          useWhen: ["technical_chat", "planning"],
          confidence: 0.7,
        },
      ],
    );

    assert.equal(result.profileLearned.length, 1);
    assert.equal(
      result.profileLearned[0].text,
      "prefers value judgment before step-by-step implementation",
    );
    assert.equal(result.profileLearned[0].status, "candidate");
  });

  it("rejects personality or psychology labels in profile hints", async () => {
    const result = await observeUserMessage(
      "hello",
      "casual_chat",
      undefined,
      [
        {
          category: "collaboration",
          text: "user is anxious and introverted",
          confidence: 0.9,
        },
      ],
    );

    assert.ok(result.ignored.includes("profile_hint_sensitive_or_label"));
    assert.equal(result.profileLearned.length, 0);
  });

  it("rejects Chinese personality labels in profile hints", async () => {
    const result = await observeUserMessage(
      "hello",
      "casual_chat",
      undefined,
      [
        {
          category: "collaboration",
          text: "用户性格内向",
          confidence: 0.9,
        },
      ],
    );

    assert.ok(result.ignored.includes("profile_hint_sensitive_or_label"));
    assert.equal(result.profileLearned.length, 0);
  });
});

describe("getStyleBrief renders examples", () => {
  it("includes the example fragment when present", async () => {
    const store = await loadStore();
    store.habits = [
      {
        id: "test-with-example",
        kind: "sentence_final_particle" as const,
        text: "莫",
        locale: "zh-CN",
        confidence: 0.5,
        seenCount: 5,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: ["formal_writing"],
        example: "今天天气好巴适莫",
        seenContexts: ["casual_chat", "technical_chat"],
        source: "hint" as const,
      },
    ];
    await saveStore(store);

    const brief = await getStyleBrief();
    assert.ok(brief.includes("莫"));
    assert.ok(brief.includes("今天天气好巴适莫"), "brief should embed the stored example");
  });
});

describe("distillRecentStyle", () => {
  it("writes batched observations and promotes to active immediately", async () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "3";
    const result = await distillRecentStyle([
      {
        kind: "idiolect",
        text: "莫",
        example: "今天好困莫",
        confidence: 0.7,
      },
      {
        kind: "tone",
        text: "warm-soft-tone",
        confidence: 0.8,
      },
    ]);
    assert.equal(result.learned.length, 2);
    for (const h of result.learned) {
      assert.equal(h.status, "active", "distilled habits should be active on first write");
      assert.equal(h.source, "distill");
    }
    delete process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  });

  it("sanitizes examples on distilled habits too", async () => {
    const result = await distillRecentStyle([
      {
        kind: "idiolect",
        text: "hi",
        example: "secret=ghp_abcdefghijklmnopqrstuvwxyz0123",
        confidence: 0.9,
      },
    ]);
    assert.equal(result.learned[0].example, undefined);
  });

  it("respects learning_enabled off", async () => {
    const store = await loadStore();
    store.settings.allowLearning = false;
    await saveStore(store);

    const result = await distillRecentStyle([{ kind: "idiolect", text: "x" }]);
    assert.ok(result.ignored.includes("learning_disabled"));
    assert.equal(result.learned.length, 0);

    store.settings.allowLearning = true;
    await saveStore(store);
  });
});

describe("interaction profile", () => {
  it("distills interaction preferences as active immediately", async () => {
    process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT = "3";
    const result = await distillInteractionProfile([
      {
        category: "workflow",
        text: "prefers plan, implement, then verify",
        example: "先做计划，再实现，最后跑测试",
        useWhen: ["technical_chat"],
        confidence: 0.8,
      },
    ]);

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].status, "active");
    assert.equal(result.learned[0].source, "distill");
    delete process.env.STYLE_MEMORY_MIN_PROMOTE_COUNT;
  });

  it("lists interaction profile preferences sorted by confidence", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.profile.preferences = [
      {
        id: "low",
        category: "collaboration" as const,
        text: "low",
        confidence: 0.3,
        seenCount: 2,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "candidate" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
      {
        id: "high",
        category: "workflow" as const,
        text: "high",
        confidence: 0.8,
        seenCount: 2,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "active" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const profile = await listInteractionProfile();
    assert.equal(profile[0].text, "high");
    assert.equal(profile[1].text, "low");
  });

  it("reviews interaction profile preferences with suggested actions", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.profile.preferences = [
      {
        id: "strong-profile",
        category: "workflow" as const,
        text: "prefers plan, implement, then verify",
        confidence: 0.8,
        seenCount: 8,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "active" as const,
        pinned: false,
        useWhen: ["technical_chat"],
        avoidWhen: [],
      },
      {
        id: "weak-profile",
        category: "collaboration" as const,
        text: "weak one-off",
        confidence: 0.1,
        seenCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "candidate" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const review = await reviewInteractionProfile();
    assert.equal(review.summary.total, 2);
    assert.equal(review.summary.active, 1);
    assert.equal(review.summary.candidates, 1);
    assert.equal(
      review.suggestions.find((item) => item.id === "strong-profile")?.suggestedAction,
      "pin",
    );
    assert.equal(
      review.suggestions.find((item) => item.id === "weak-profile")?.suggestedAction,
      "forget",
    );
  });

  it("forgets interaction preferences by exact text", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.profile.preferences = [
      {
        id: "profile-to-forget",
        category: "tone_boundary" as const,
        text: "avoid too many kaomoji",
        confidence: 0.6,
        seenCount: 3,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const removed = await forgetInteractionPreference("avoid too many kaomoji");
    assert.equal(removed, true);
    assert.equal((await listInteractionProfile()).length, 0);
  });

  it("pins and unpins interaction preferences", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.profile.preferences = [
      {
        id: "profile-to-pin",
        category: "response_structure" as const,
        text: "prefers conclusions before details",
        confidence: 0.7,
        seenCount: 4,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "active" as const,
        pinned: false,
        useWhen: ["general"],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    assert.equal(await pinInteractionPreference("prefers conclusions before details", true), true);
    assert.equal((await listInteractionProfile())[0].pinned, true);
    assert.equal(await pinInteractionPreference("prefers conclusions before details", false), true);
    assert.equal((await listInteractionProfile())[0].pinned, false);
  });

  it("scores style memory and recommends refreshing the brief after updates", async () => {
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    const store = await loadStore();
    store.habits = [
      {
        id: "active-habit",
        kind: "emoji" as const,
        text: "(｡･ω･｡)",
        confidence: 0.7,
        seenCount: 5,
        firstSeenAt: earlier,
        lastSeenAt: now,
        lastReturnedAt: earlier,
        status: "active" as const,
        pinned: false,
        useWhen: ["casual_chat"],
        avoidWhen: ["formal_writing"],
      },
    ];
    store.profile.preferences = [
      {
        id: "active-profile",
        category: "workflow" as const,
        text: "prefers plan, implement, then verify",
        confidence: 0.8,
        seenCount: 5,
        firstSeenAt: earlier,
        lastSeenAt: now,
        lastReturnedAt: earlier,
        status: "active" as const,
        pinned: false,
        useWhen: ["technical_chat"],
        avoidWhen: [],
      },
    ];
    await saveStore(store);

    const score = await getStyleMemoryScore();
    assert.ok(score.overall > 0);
    assert.ok(score.readiness >= 40);
    assert.equal(score.briefRefreshRecommended, true);
    assert.ok(score.recommendations.some((item) => item.includes("get_style_brief")));
  });
});

describe("legacy store compatibility", () => {
  it("loads a v0.1-shaped habit (no example, no seenContexts) and updates it", async () => {
    const store = await loadStore();
    store.habits = [
      {
        // Intentionally omit example / seenContexts / source — v0.1 shape.
        id: "legacy-habit",
        kind: "catchphrase" as const,
        text: "legacy",
        locale: "en",
        confidence: 0.2,
        seenCount: 1,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        status: "candidate" as const,
        pinned: false,
        useWhen: [],
        avoidWhen: [],
      } as any,
    ];
    await saveStore(store);

    // Re-load: normalizeHabit should accept it and add safe defaults.
    const reloaded = await listStyleHabits();
    const legacy = reloaded.find((h) => h.id === "legacy-habit");
    assert.ok(legacy);
    assert.equal(legacy!.example, undefined);
    // seenContexts is allowed to be undefined or an empty-array equivalent.
    assert.ok(legacy!.seenContexts === undefined || legacy!.seenContexts.length === 0);
  });

  it("loads a store without profile and adds an empty profile", async () => {
    await writeFile(
      testFile,
      JSON.stringify({
        version: 1,
        settings: (await loadStore()).settings,
        habits: [],
      }),
      "utf8",
    );

    const store = await loadStore();
    assert.deepEqual(store.profile.preferences, []);
  });
});
