import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  addFailureRule,
  bootstrapStyleMemory,
  confirmAddress,
  distillRecentStyle,
  forgetAddress,
  forgetStyleHabit,
  getStyleBrief,
  getStyleBriefEnvelope,
  listAddresses,
  observeUserMessage,
  pinStyleHabit,
} from "./memory.js";
import { loadStore, saveStore } from "./store.js";

const dir = join(tmpdir(), `style-memory-v2-${randomUUID()}`);
const file = join(dir, "store.json");
let oldPath: string | undefined;

before(async () => {
  oldPath = process.env.STYLE_MEMORY_PATH;
  await mkdir(dir, { recursive: true });
  process.env.STYLE_MEMORY_PATH = file;
});

after(async () => {
  if (oldPath === undefined) delete process.env.STYLE_MEMORY_PATH;
  else process.env.STYLE_MEMORY_PATH = oldPath;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const store = await loadStore();
  store.habits = [];
  store.profile.preferences = [];
  store.profile.addresses.forEach((bucket) => { bucket.values = []; });
  store.profile.expressionPatterns = [];
  store.profile.failureLog = [];
  store.settings.allowLearning = true;
  for (const scale of [
    store.profile.observedVoice.verbosity,
    store.profile.observedVoice.formality,
    store.profile.observedVoice.expressiveness,
    store.profile.responsePreferences.replyVerbosity,
    store.profile.responsePreferences.warmth,
    store.profile.responsePreferences.initiative,
  ]) {
    scale.value = 3;
    scale.latentMean = 3;
    scale.confidence = 0;
    scale.evidenceWeight = 0;
    scale.evidenceCount = 0;
    scale.sessionCount = 0;
    scale.evidence = [];
    scale.pinned = false;
    scale.explicit = false;
  }
  store.profile.observedVoice.rhythm = undefined;
  store.profile.observedVoice.expressionDensity = 0;
  store.profile.observedVoice.punctuation = { baseStyle: "standard", literalPatterns: [] };
  store.initialization = { status: "pending" };
  store.briefState = { revision: 0 };
  await saveStore(store);
});

describe("v2 addresses", () => {
  it("keeps the same literal independent in both directions and never reverse-learns", async () => {
    const first = "亲爱的";
    await observeUserMessage(`你好，${first}`, undefined, undefined, undefined, {
      sessionId: "s1",
      addressHints: [{ text: first, from: "user", to: "assistant", sourceRole: "user", currentMessage: `你好，${first}` }],
    });
    await observeUserMessage(`你好，${first}`, undefined, undefined, undefined, {
      sessionId: "s2",
      addressHints: [{ text: first, from: "user", to: "assistant", sourceRole: "user", currentMessage: `你好，${first}` }],
    });
    await observeUserMessage(`你好，${first}`, undefined, undefined, undefined, {
      sessionId: "s3",
      addressHints: [{ text: first, from: "user", to: "assistant", sourceRole: "user", currentMessage: `你好，${first}`, affectSummary: "亲昵、想拉近距离时使用" }],
    });
    await observeUserMessage(`我叫${first}`, undefined, undefined, undefined, {
      sessionId: "s4",
      addressHints: [{ text: first, from: "assistant", to: "user", sourceRole: "user", currentMessage: `我叫${first}`, explicit: true }],
    });

    const addresses = await listAddresses();
    const userToAssistant = addresses.find((item) => item.from === "user")!.values[0];
    const assistantToUser = addresses.find((item) => item.from === "assistant")!.values[0];
    assert.ok(userToAssistant && assistantToUser);
    assert.notEqual(userToAssistant.id, assistantToUser.id);
    assert.equal(userToAssistant.status, "active");
    assert.equal(assistantToUser.status, "active");
    const brief = await getStyleBrief();
    assert.match(brief, /用户→助手\[只识别，勿反称\]/);
    assert.match(brief, /助手→用户\[可以使用\]/);
  });

  it("does not accept assistant output as user-name evidence", async () => {
    const result = await observeUserMessage("小月，好的", undefined, [{
      kind: "idiolect", text: "小月", sourceRole: "assistant",
      addressFrom: "assistant", addressTo: "user",
    }]);
    assert.ok(result.ignored.includes("hint_source_role_rejected"));
    assert.equal((await listAddresses("assistant→user"))[0].values.length, 0);
  });

  it("activates a user-supplied assistant-to-user address after repeated direct evidence", async () => {
    const text = "你可以叫我星星";
    for (const [sessionId, repeat] of [["name-a", 1], ["name-b", 2]] as const) {
      for (let index = 0; index < repeat; index += 1) {
        await observeUserMessage(text, undefined, undefined, undefined, {
          sessionId,
          addressHints: [{ text: "星星", from: "assistant", to: "user", sourceRole: "user", currentMessage: text }],
        });
      }
    }
    const value = (await listAddresses("assistant→user"))[0].values[0];
    assert.equal(value.status, "active");
    assert.equal(value.explicit, false);
  });

  it("does not apply TTL to legacy habits or interaction preferences", async () => {
    const store = await loadStore();
    const old = new Date(Date.UTC(2024, 0, 1)).toISOString();
    store.habits = [{
      id: "legacy-kept", kind: "catchphrase", text: "旧兼容项", confidence: 0.6, seenCount: 3,
      firstSeenAt: old, lastSeenAt: old, status: "active", pinned: false, useWhen: [], avoidWhen: [],
    }];
    store.profile.preferences = [{
      id: "preference-kept", category: "workflow", text: "保留明确偏好", confidence: 0.8, seenCount: 3,
      firstSeenAt: old, lastSeenAt: old, status: "active", pinned: false, useWhen: [], avoidWhen: [],
    }];
    store.profile.expressionPatterns = [];
    await saveStore(store);

    await observeUserMessage("自然消息", undefined, undefined, undefined, { sessionId: "ttl" });
    const after = await loadStore();
    assert.equal(after.habits[0]?.status, "active");
    assert.equal(after.profile.preferences[0]?.status, "active");
  });

  it("counts a duplicate address hint from both input paths only once", async () => {
    const text = "你好，星星";
    await observeUserMessage(text, undefined, [{
      kind: "idiolect", text: "星星", addressFrom: "user", addressTo: "assistant", sourceRole: "user",
    }], undefined, {
      sessionId: "address-dedupe",
      addressHints: [{
        text: "星星", from: "user", to: "assistant", sourceRole: "user", currentMessage: text,
      }],
    });
    const value = (await listAddresses("user→assistant"))[0].values[0];
    assert.ok(value);
    assert.equal(value.evidence.seenCount, 1);
  });

  it("does not treat an address hint without an explicit user source as evidence", async () => {
    const text = "你好，星星";
    const result = await observeUserMessage(text, undefined, [{
      kind: "idiolect", text: "星星", addressFrom: "user", addressTo: "assistant",
    }], undefined, { sessionId: "address-source-required" });
    assert.ok(result.ignored.includes("address_source_role_required"));
    assert.equal((await listAddresses("user→assistant"))[0].values.length, 0);
  });

  it("keeps a one-direction forget isolated", async () => {
    const text = "星星";
    await observeUserMessage(text, undefined, undefined, undefined, {
      addressHints: [{ text, from: "user", to: "assistant", sourceRole: "user", currentMessage: text, explicit: true }],
    });
    await observeUserMessage(text, undefined, undefined, undefined, {
      addressHints: [{ text, from: "assistant", to: "user", sourceRole: "user", currentMessage: text, explicit: true }],
    });
    assert.equal(await forgetAddress("user→assistant", text), true);
    assert.equal((await listAddresses("user→assistant"))[0].values.length, 0);
    assert.equal((await listAddresses("assistant→user"))[0].values[0].text, text);
    assert.equal(await confirmAddress("assistant→user", text), true);
  });
});

describe("v2 expressions, brief, and feedback", () => {
  it("requires two observations across two sessions for a semantic pattern", async () => {
    const hint = { kind: "idiolect" as const, text: "啵", behaviorSummary: "轻松确认时用短词承接", functions: ["确认"], variationPolicy: "exact_only" as const };
    await observeUserMessage("啵", undefined, [{ ...hint, sessionId: "a" }], undefined, { sessionId: "a" });
    let store = await loadStore();
    assert.equal(store.profile.expressionPatterns[0].status, "candidate");
    await observeUserMessage("啵", undefined, [{ ...hint, sessionId: "b" }], undefined, { sessionId: "b" });
    store = await loadStore();
    assert.equal(store.profile.expressionPatterns[0].status, "active");
    assert.match(await getStyleBrief(), /口癖\[重点/);
    assert.match(await getStyleBrief(), /轻松确认时用短词承接/);
    assert.doesNotMatch(await getStyleBrief(), /confidence/);
  });

  it("preserves special punctuation exactly and blocks a same-turn correction", async () => {
    await observeUserMessage("。。。", undefined, undefined, undefined, { sessionId: "p1" });
    let store = await loadStore();
    assert.ok(store.profile.observedVoice.punctuation.literalPatterns.includes("。。。"));
    await observeUserMessage("别学这个。。。", undefined, [{ kind: "punctuation", text: "。。。" }], undefined, {
      sessionId: "p1",
      feedback: { kind: "expression", action: "forget", text: "。。。", idOrText: "。。。" },
    });
    store = await loadStore();
    assert.equal(store.profile.expressionPatterns.some((item) => item.examples.includes("。。。")), false);
  });

  it("removes forgotten punctuation from the observed voice projection", async () => {
    await observeUserMessage("。。。", undefined, undefined, undefined, { sessionId: "forget-punctuation" });
    assert.ok((await loadStore()).profile.observedVoice.punctuation.literalPatterns.includes("。。。"));
    assert.equal(await forgetStyleHabit("。。。"), true);
    const after = await loadStore();
    assert.equal(after.profile.observedVoice.punctuation.literalPatterns.includes("。。。"), false);
    assert.equal(after.profile.expressionPatterns.some((item) => item.examples.includes("。。。")), false);
  });

  it("blocks examples when same-turn feedback targets an expression by id", async () => {
    const hint = { kind: "idiolect" as const, text: "啵", behaviorSummary: "轻松确认时用短词承接", functions: ["确认"], variationPolicy: "exact_only" as const };
    await observeUserMessage("啵", undefined, [{ ...hint, sessionId: "f1" }], undefined, { sessionId: "f1" });
    await observeUserMessage("啵", undefined, [{ ...hint, sessionId: "f2" }], undefined, { sessionId: "f2" });
    await observeUserMessage("啵", undefined, [{ ...hint, sessionId: "f2" }], undefined, { sessionId: "f2" });
    const before = await loadStore();
    const pattern = before.profile.expressionPatterns.find((item) => item.examples.includes("啵"));
    assert.ok(pattern);
    await observeUserMessage("别学啵", undefined, [{ kind: "idiolect", text: "啵" }], undefined, {
      sessionId: "f2",
      feedback: { kind: "expression", action: "forget", idOrText: pattern!.id },
    });
    const after = await loadStore();
    assert.equal(after.profile.expressionPatterns.some((item) => item.examples.includes("啵")), false);
  });

  it("forgets and pins the primary expression pattern, keeping the projection aligned", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.profile.expressionPatterns = [{
      id: "primary-expression", kind: "lexical", behaviorSummary: "轻松确认时用短词承接", functions: ["确认"],
      variationPolicy: "exact_only", examples: ["啵"], useWhen: [], avoidWhen: [], status: "active",
      pinned: false, explicit: false, confidence: 0.8, seenCount: 3, sessionCount: 2,
      firstSeenAt: now, lastSeenAt: now, evidence: { seenCount: 3, sessionIds: ["a", "b"], evidence: [] },
    }];
    store.habits = [{
      id: "primary-expression", kind: "catchphrase", text: "啵", confidence: 0.8, seenCount: 3,
      firstSeenAt: now, lastSeenAt: now, status: "active", pinned: false, useWhen: [], avoidWhen: [],
    }];
    await saveStore(store);
    assert.equal(await pinStyleHabit("primary-expression"), true);
    let after = await loadStore();
    assert.equal(after.profile.expressionPatterns[0].pinned, true);
    assert.equal(after.habits[0].pinned, true);
    assert.equal(await forgetStyleHabit("primary-expression"), true);
    after = await loadStore();
    assert.equal(after.profile.expressionPatterns.length, 0);
    assert.equal(after.habits.length, 0);
  });

  it("keeps feedback mutations aligned with the compatibility projection", async () => {
    const now = new Date().toISOString();
    const store = await loadStore();
    store.profile.expressionPatterns = [{
      id: "feedback-expression", kind: "lexical", behaviorSummary: "轻松确认时用短词承接", functions: ["确认"],
      variationPolicy: "exact_only", examples: ["啵"], useWhen: [], avoidWhen: [], status: "candidate",
      pinned: false, explicit: false, confidence: 0.2, seenCount: 1, sessionCount: 1,
      firstSeenAt: now, lastSeenAt: now, evidence: { seenCount: 1, sessionIds: ["feedback"], evidence: [] },
    }];
    store.habits = [{
      id: "feedback-expression", kind: "catchphrase", text: "啵", confidence: 0.2, seenCount: 1,
      firstSeenAt: now, lastSeenAt: now, status: "candidate", pinned: false, useWhen: [], avoidWhen: [],
    }];
    await saveStore(store);

    await observeUserMessage("啵", undefined, undefined, undefined, {
      sessionId: "feedback", feedback: { kind: "expression", action: "confirm", idOrText: "feedback-expression" },
    });
    let after = await loadStore();
    assert.equal(after.profile.expressionPatterns[0].status, "active");
    assert.equal(after.habits[0].status, "active");
    assert.equal(after.habits[0].confidence, 1);

    await observeUserMessage("啵", undefined, undefined, undefined, {
      sessionId: "feedback", feedback: { kind: "expression", action: "pin", idOrText: "feedback-expression" },
    });
    after = await loadStore();
    assert.equal(after.profile.expressionPatterns[0].pinned, true);
    assert.equal(after.habits[0].pinned, true);

    await observeUserMessage("啵", undefined, undefined, undefined, {
      sessionId: "feedback", feedback: { kind: "expression", action: "archive", idOrText: "feedback-expression" },
    });
    after = await loadStore();
    assert.equal(after.profile.expressionPatterns[0].status, "archived");
    assert.equal(after.habits[0].status, "archived");
  });

  it("forgets response preference text and blocks same-turn relearning", async () => {
    const now = new Date().toISOString();
    const text = "prefers conclusion first, then key reasons and next steps";
    const store = await loadStore();
    store.profile.preferences = [{
      id: "profile-response-structure",
      category: "response_structure",
      text,
      confidence: 1,
      seenCount: 3,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "active",
      pinned: false,
      useWhen: ["technical_chat"],
      avoidWhen: [],
    }];
    await saveStore(store);
    const beforeRevision = store.briefState.revision;

    await observeUserMessage("请不要再记住这个偏好", "technical_chat", undefined, [{
      category: "response_structure",
      text,
    }], {
      sessionId: "forget-pref",
      feedback: { kind: "response_preference", action: "forget", idOrText: text, text },
    });

    const after = await loadStore();
    assert.equal(after.profile.preferences.some((item) => item.text === text), false);
    assert.equal(after.briefState.revision, beforeRevision + 1);
  });

  it("returns channel and policy at bootstrap and uses revision ack", async () => {
    const first = await bootstrapStyleMemory("agent", "event", "abc");
    assert.equal(first.channel, "agent");
    assert.equal(first.policy, "event");
    const envelope = await getStyleBriefEnvelope(undefined, first.revision);
    assert.equal(envelope.mode, "ack");
  });

  it("stores explicit failure rules and does not infer them from silence", async () => {
    await addFailureRule("别急着给建议，先回应感受");
    const brief = await getStyleBrief();
    assert.match(brief, /翻车日志/);
    assert.match(brief, /先回应感受/);
  });
});

describe("v0.6 first-run initialization", () => {
  it("requests initialization only on the first bootstrap of an empty store", async () => {
    const first = await bootstrapStyleMemory("agent", "event", "init-first");
    const second = await bootstrapStyleMemory("agent", "event", "init-second");

    assert.deepEqual(first.initialization, {
      status: "pending",
      requested: true,
      lookbackDays: 30,
      maxSessions: 12,
    });
    assert.equal(second.initialization.status, "pending");
    assert.equal(second.initialization.requested, false);
    assert.ok((await loadStore()).initialization.requestedAt);
  });

  it("persists skip and does not ask again", async () => {
    const skipped = await bootstrapStyleMemory("agent", "event", "init-skip", { action: "skip" });
    const next = await bootstrapStyleMemory("agent", "event", "init-after-skip");

    assert.equal(skipped.initialization.status, "skipped");
    assert.equal(next.initialization.status, "skipped");
    assert.equal(next.initialization.requested, false);
  });

  it("initializes from bounded aggregates without storing session text or private fields", async () => {
    const result = await bootstrapStyleMemory("agent", "event", "init-complete", {
      action: "complete",
      lookbackDays: 30,
      sessionCount: 12,
      observedVoice: {
        verbosity: 2,
        formality: 2,
        expressiveness: 4,
        rhythm: "short direct clauses",
        expressionDensity: 2,
        punctuation: { baseStyle: "expressive", literalPatterns: ["哈哈", "secret token=sk-abc123xyz789secret"] },
      },
      responsePreferences: [{ field: "replyVerbosity", value: 2, evidence: "explicit_feedback" }],
      profileHints: [{
        category: "workflow",
        text: "prefers the agent to implement and verify without hand-holding",
        confidence: 0.8,
      }],
      expressionHints: [{
        kind: "idiolect",
        text: "哈哈哈",
        behaviorSummary: "uses repeated laughter for relaxed acknowledgement",
        functions: ["acknowledgement"],
        variationPolicy: "same_family",
        sessionId: "history-title-must-not-survive",
      }],
    });
    const store = await loadStore();

    assert.equal(result.initialization.status, "completed");
    assert.equal(store.initialization.sourceSessionCount, 12);
    assert.equal(store.initialization.lookbackDays, 30);
    assert.equal(store.profile.observedVoice.verbosity.value, 2);
    assert.equal(store.profile.observedVoice.rhythm, "short direct clauses");
    assert.deepEqual(store.profile.observedVoice.punctuation.literalPatterns, ["哈哈"]);
    assert.equal(store.profile.responsePreferences.replyVerbosity.value, 2);
    assert.equal(store.profile.responsePreferences.replyVerbosity.explicit, true);
    assert.equal(store.profile.preferences[0].status, "active");
    assert.equal(store.profile.addresses.every((bucket) => bucket.values.length === 0), true);
    assert.equal(store.profile.failureLog.length, 0);
    assert.equal(store.profile.expressionPatterns[0].status, "candidate");
    assert.equal(store.profile.expressionPatterns[0].seenCount, 1);
    assert.deepEqual(store.profile.expressionPatterns[0].evidence.sessionIds, ["initialization"]);
    assert.doesNotMatch(JSON.stringify(store), /history-title-must-not-survive|abc123xyz789secret/);
  });

  it("activates an initialized expression only after another session observes it", async () => {
    const hint = {
      kind: "idiolect" as const,
      text: "哈哈哈",
      behaviorSummary: "uses repeated laughter for relaxed acknowledgement",
      functions: ["acknowledgement"],
      variationPolicy: "same_family" as const,
    };
    await bootstrapStyleMemory("agent", "event", "init-expression", {
      action: "complete",
      sessionCount: 6,
      expressionHints: [hint],
    });
    await observeUserMessage("哈哈哈", undefined, [{ ...hint, sessionId: "later" }], undefined, { sessionId: "later" });

    const pattern = (await loadStore()).profile.expressionPatterns[0];
    assert.equal(pattern.seenCount, 2);
    assert.equal(pattern.sessionCount, 2);
    assert.equal(pattern.status, "active");
    assert.equal((await loadStore()).habits[0].status, "active");
  });

  it("keeps repeated completion idempotent", async () => {
    const initialization = {
      action: "complete" as const,
      sessionCount: 4,
      expressionHints: [{
        kind: "idiolect" as const,
        text: "哈哈哈",
        behaviorSummary: "uses repeated laughter for relaxed acknowledgement",
        functions: ["acknowledgement"],
        variationPolicy: "same_family" as const,
      }],
    };
    await bootstrapStyleMemory("agent", "event", "init-once", initialization);
    await bootstrapStyleMemory("agent", "event", "init-twice", initialization);

    const patterns = (await loadStore()).profile.expressionPatterns;
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].seenCount, 1);
  });

  it("skips initialization when learning is disabled", async () => {
    const store = await loadStore();
    const beforeVerbosity = store.profile.observedVoice.verbosity.value;
    store.settings.allowLearning = false;
    await saveStore(store);

    const result = await bootstrapStyleMemory("agent", "off", "init-disabled", {
      action: "complete",
      observedVoice: { verbosity: 1 },
    });
    const after = await loadStore();
    assert.equal(result.initialization.status, "skipped");
    assert.deepEqual(result.initialization.ignored, ["learning_disabled"]);
    assert.equal(after.profile.observedVoice.verbosity.value, beforeVerbosity);
  });

  it("does not request or apply initialization under an off policy", async () => {
    const result = await bootstrapStyleMemory("agent", "off", "init-off", {
      action: "complete",
      observedVoice: { verbosity: 1 },
    });
    const store = await loadStore();

    assert.equal(result.initialization.status, "pending");
    assert.equal(result.initialization.requested, false);
    assert.deepEqual(result.initialization.ignored, ["agent_policy_off"]);
    assert.equal(store.initialization.requestedAt, undefined);
  });
});

describe("v2 protocol and capacity boundaries", () => {
  it("does not learn or apply feedback when the agent policy is off", async () => {
    const before = await loadStore();
    const result = await observeUserMessage("啵", undefined, [{ kind: "idiolect", text: "啵" }], undefined, {
      sessionId: "off-1",
      channel: "agent",
      policy: "off",
      feedback: { kind: "failure", action: "set", rule: "不要写入" },
    });
    const after = await loadStore();
    assert.equal(result.ack?.policy, "off");
    assert.ok(result.ignored.includes("agent_policy_off"));
    assert.deepEqual(after.profile.failureLog, before.profile.failureLog);
    assert.equal(after.profile.expressionPatterns.length, before.profile.expressionPatterns.length);
  });

  it("returns a compact delta after a known revision becomes stale", async () => {
    const first = await bootstrapStyleMemory("agent", "event", "delta-1");
    await addFailureRule("先确认再展开");
    const next = await getStyleBriefEnvelope(undefined, first.revision);
    assert.equal(next.mode, "delta");
    assert.ok(next.delta);
    assert.equal(next.brief, "");
    const ack = await getStyleBriefEnvelope(undefined, next.revision);
    assert.equal(ack.mode, "ack");
  });

  it("keeps the typical capsule compact and limits expressions to two", async () => {
    const store = await loadStore();
    const now = new Date().toISOString();
    store.profile.addresses[0].values = [0, 1].map((index) => ({
      id: "ua-" + index, text: "称呼" + index, from: "user" as const, to: "assistant" as const,
      affectSummary: "中性话语作用", status: "active" as const, confidence: 0.8,
      pinned: false, explicit: false, firstSeenAt: now, lastSeenAt: now,
      evidence: { seenCount: 3, sessionIds: ["s1", "s2"], evidence: [] },
    }));
    store.profile.expressionPatterns = Array.from({ length: 6 }, (_, index) => ({
      id: "expression-" + index, kind: "lexical" as const,
      behaviorSummary: "表达模式" + index, functions: ["确认"], variationPolicy: "same_family" as const,
      examples: ["例子" + index], useWhen: ["casual_chat"], avoidWhen: [], status: "active" as const,
      pinned: false, explicit: false, confidence: 0.8, seenCount: 5, sessionCount: 2,
      firstSeenAt: now, lastSeenAt: now,
      evidence: { seenCount: 5, sessionIds: ["s1", "s2"], evidence: [] },
    }));
    await saveStore(store);
    const brief = await getStyleBrief();
    assert.ok(brief.indexOf("称呼") < brief.indexOf("口癖[重点"));
    assert.equal((brief.match(/用户→助手\[只识别，勿反称\]/g) ?? []).length, 1);
    assert.equal((brief.match(/表达模式\d/g) ?? []).length, 2);
  });

  it("does not let session distillation bypass the expression gates", async () => {
    const hint = {
      kind: "idiolect" as const, text: "啵", behaviorSummary: "轻松确认时用短词承接",
      functions: ["确认"], variationPolicy: "same_family" as const, confidence: 1,
    };
    await distillRecentStyle([{ ...hint, sessionId: "d1" }]);
    await distillRecentStyle([{ ...hint, sessionId: "d1" }]);
    let store = await loadStore();
    let pattern = store.profile.expressionPatterns.find((item) => item.examples.includes("啵"));
    assert.ok(pattern);
    assert.equal(pattern!.seenCount, 2);
    assert.equal(pattern!.status, "candidate");
    await distillRecentStyle([{ ...hint, sessionId: "d2" }]);
    store = await loadStore();
    pattern = store.profile.expressionPatterns.find((item) => item.examples.includes("啵"));
    assert.equal(pattern!.seenCount, 3);
    assert.equal(pattern!.sessionCount, 2);
    assert.equal(pattern!.status, "active");
  });

  it("does not leave a compatibility habit when expression capacity rejects it", async () => {
    const store = await loadStore();
    const now = new Date().toISOString();
    store.profile.expressionPatterns = Array.from({ length: 24 }, (_, index) => ({
      id: `candidate-${index}`, kind: "lexical" as const, behaviorSummary: `候选${index}`,
      functions: [], variationPolicy: "exact_only" as const, examples: [`候选原文${index}`], useWhen: [], avoidWhen: [],
      status: "candidate" as const, pinned: false, explicit: false, confidence: 0.1, seenCount: 1,
      sessionCount: 1, firstSeenAt: now, lastSeenAt: now,
      evidence: { seenCount: 1, sessionIds: ["capacity"], evidence: [] },
    }));
    store.habits = [];
    await saveStore(store);
    const result = await observeUserMessage("容量测试", undefined, [{ kind: "idiolect", text: "容量测试" }], undefined, { sessionId: "capacity" });
    assert.ok(result.ignored.includes("expression_capacity"));
    const after = await loadStore();
    assert.equal(after.habits.some((habit) => habit.text === "容量测试"), false);
  });
});
