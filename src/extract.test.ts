import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractHabits } from "./extract.js";

describe("extractHabits", () => {
  it("returns empty for empty input", () => {
    assert.deepEqual(extractHabits(""), []);
    assert.deepEqual(extractHabits("   "), []);
  });

  it("returns empty for very long input (>4000 chars)", () => {
    const long = "哈".repeat(4001);
    assert.deepEqual(extractHabits(long), []);
  });

  // ---- dialect markers ----

  it("detects Sichuan dialect markers", () => {
    const result = extractHabits("这个东西锤子得很，一点都不巴适");
    const texts = result.filter(h => h.kind === "dialect_marker").map(h => h.text);
    assert.ok(texts.includes("锤子"));
    assert.ok(texts.includes("巴适"));
  });

  it("sets correct locale and useWhen for dialect markers", () => {
    const result = extractHabits("安逸");
    const habit = result.find(h => h.text === "安逸");
    assert.ok(habit);
    assert.equal(habit!.locale, "zh-CN-sichuan");
    assert.ok(habit!.useWhen.includes("casual_chat"));
    assert.ok(habit!.avoidWhen.includes("serious_debugging"));
  });

  // ---- catchphrases ----

  it("detects Chinese catchphrases", () => {
    const result = extractHabits("哈哈哈笑死我了救命");
    const texts = result.filter(h => h.kind === "catchphrase" && h.locale === "zh-CN").map(h => h.text);
    assert.ok(texts.includes("哈哈哈"));
    assert.ok(texts.includes("笑死"));
    assert.ok(texts.includes("救命"));
  });

  it("detects Chinese catchphrases with context hints", () => {
    const result = extractHabits("绝了");
    const habit = result.find(h => h.text === "绝了");
    assert.ok(habit);
    assert.equal(habit!.kind, "catchphrase");
    assert.equal(habit!.locale, "zh-CN");
    assert.ok(habit!.avoidWhen.includes("formal_writing"));
  });

  it("detects English catchphrases with word boundaries", () => {
    const result = extractHabits("lol tbh that's kinda cool ngl");
    const texts = result.filter(h => h.kind === "catchphrase" && h.locale === "en").map(h => h.text);
    assert.ok(texts.includes("lol"));
    assert.ok(texts.includes("tbh"));
    assert.ok(texts.includes("kinda"));
    assert.ok(texts.includes("ngl"));
  });

  it("does not match English catchphrases embedded in words", () => {
    const result = extractHabits("hello there idol kindly");
    const texts = result.filter(h => h.kind === "catchphrase" && h.locale === "en").map(h => h.text);
    // "lol" should not match inside "hello", "idol", "kindly"
    assert.ok(!texts.includes("lol"));
    assert.ok(!texts.includes("idk")); // not present
    assert.ok(!texts.includes("kinda")); // "kindly" should not trigger "kinda"
  });

  it("does not flag common Chinese filler words as catchphrases", () => {
    const result = extractHabits("的了我你是他在有");
    const catchphrases = result.filter(h => h.kind === "catchphrase" && h.locale === "zh-CN");
    assert.equal(catchphrases.length, 0);
  });

  // ---- emoticons and emoji ----

  it("detects kaomoji expressions", () => {
    const result = extractHabits("hello (｡･ω･｡)ﾉ world");
    const emoticons = result.filter(h => h.kind === "emoji");
    const texts = emoticons.map(h => h.text);
    assert.ok(texts.some(t => t.includes("｡･ω･｡")));
  });

  it("detects Unicode emoji", () => {
    const result = extractHabits("nice 👍 good 🎉 stuff");
    const emoji = result.filter(h => h.kind === "emoji");
    assert.ok(emoji.length >= 2);
  });

  it("forgives mixed bracket types in kaomoji", () => {
    // (你好）uses English opening + Chinese closing bracket
    const result = extractHabits("(你好）");
    const emoticons = result.filter(h => h.kind === "emoji");
    assert.ok(emoticons.length >= 1);
  });

  // ---- punctuation and tone ----

  it("detects laughter patterns", () => {
    const result = extractHabits("哈哈哈哈哈哈");
    const tone = result.filter(h => h.kind === "tone");
    assert.ok(tone.some(h => h.text === "laughs-with-hahaha"));
  });

  it("detects expressive punctuation", () => {
    const result = extractHabits("真的吗！！！这也太酷了吧？？");
    const punct = result.filter(h => h.kind === "punctuation");
    assert.ok(punct.some(h => h.text === "expressive-punctuation"));
  });

  // ---- language mix ----

  it("detects Chinese-English code mixing", () => {
    const result = extractHabits("这个API的设计很不错，performance也很好");
    const mix = result.filter(h => h.kind === "language_mix");
    assert.ok(mix.some(h => h.text === "zh-en-code-mix"));
  });

  it("does not flag pure Chinese as mixed", () => {
    const result = extractHabits("今天天气真好");
    const mix = result.filter(h => h.kind === "language_mix");
    assert.equal(mix.length, 0);
  });

  it("does not flag pure English as mixed", () => {
    const result = extractHabits("The weather is great today");
    const mix = result.filter(h => h.kind === "language_mix");
    assert.equal(mix.length, 0);
  });

  // ---- deduplication ----

  it("deduplicates identical habits within one extraction", () => {
    const result = extractHabits("哈哈哈 哈哈哈 哈哈哈");
    const catchphrases = result.filter(h => h.text === "哈哈哈");
    assert.equal(catchphrases.length, 1);
  });

  // ---- confidence delta ----

  it("returns reasonable confidence deltas", () => {
    const result = extractHabits("锤子 哈哈哈 lol 👍");
    for (const h of result) {
      assert.ok(h.confidenceDelta > 0, `${h.kind}:${h.text} should have positive confidenceDelta`);
      assert.ok(h.confidenceDelta <= 1, `${h.kind}:${h.text} confidenceDelta should be <= 1`);
    }
  });
});
