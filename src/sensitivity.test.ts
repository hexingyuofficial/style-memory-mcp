import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSensitive, sanitizeExample } from "./sensitivity.js";

describe("isSensitive", () => {
  it("flags real credential patterns", () => {
    assert.equal(isSensitive("my token=sk-abcdef123456"), true);
    assert.equal(isSensitive("api key = ghp_abcdef1234567890"), true);
    // ENV-style standalone assignment — blocklist hit on ".env" or "secret"
    assert.equal(isSensitive("MY_SECRET=A1B2C3D4E5F6G7H8I9J0"), true);
  });

  it("does not flag casual mentions", () => {
    assert.equal(isSensitive("我忘了密码"), false);
    assert.equal(isSensitive("how do I reset my password"), false);
  });

  it("flags common PII patterns", () => {
    assert.equal(isSensitive("我的邮箱是 test@example.com"), true);
    assert.equal(isSensitive("手机号 13800138000"), true);
    assert.equal(isSensitive("身份证 11010519491231002X"), true);
    assert.equal(isSensitive("银行卡 6222 0202 0202 0202"), true);
  });
});

describe("sanitizeExample", () => {
  it("returns undefined for non-strings, empty, or whitespace", () => {
    assert.equal(sanitizeExample(undefined), undefined);
    assert.equal(sanitizeExample(""), undefined);
    assert.equal(sanitizeExample("   "), undefined);
    assert.equal(sanitizeExample(42 as unknown as string), undefined);
  });

  it("collapses whitespace and trims", () => {
    assert.equal(sanitizeExample("  hello   world  "), "hello world");
  });

  it("truncates to maxLen", () => {
    const out = sanitizeExample("a".repeat(120), 10);
    assert.equal(out, "a".repeat(10));
  });

  it("uses default maxLen 60", () => {
    const out = sanitizeExample("莫".repeat(120));
    assert.equal(out!.length, 60);
  });

  it("drops anything that looks like a credential leak", () => {
    assert.equal(sanitizeExample("token=sk-abc123xyz456789longvalue"), undefined);
  });

  it("drops examples with PII", () => {
    assert.equal(sanitizeExample("联系我 test@example.com"), undefined);
  });

  it("keeps natural-language mentions of password topics", () => {
    assert.equal(sanitizeExample("我忘了密码"), "我忘了密码");
  });
});
