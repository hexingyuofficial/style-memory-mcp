// =============================================================================
// Sensitivity detection
//
// Two-pass approach:
//   1. Keyword blocklist — catches obvious secret-related terms.
//   2. Heuristic — only blocks if the text also LOOKS like an actual credential
//      leak (e.g. `sk-abc123xyz`, `password: hunter2`), so we don't bail on
//      innocent mentions like "I forgot my password".
// =============================================================================

const BLOCKED_TERMS = [
  "password", "secret", "token", "api key", "apikey",
  ".env", "private key", "authorized_keys",
  "身份证", "银行卡", "密码", "密钥", "令牌",
];

const CREDENTIAL_PATTERNS = [
  // Known API key prefixes: sk-, ghp_, github_pat_, pk_, rk_, etc.
  /(?:key|token|secret|password|apikey)\s*[=:]\s*(?:sk-|ghp_|github_pat_|pk_|rk_|sgp_|sk-ant)[\w-]{4,}/i,
  // key=base64-looking-value (20+ chars of base64/hex, no spaces)
  /(?:key|token|secret|password|apikey)\s*[=:]\s*[A-Za-z0-9+/=_-]{20,}/i,
  // ENV-style assignment with random-looking value
  /^[A-Z_]{3,30}=[A-Za-z0-9+/=_-]{12,}$/m,
];

/**
 * Whether a message likely contains sensitive content that should not be
 * learned from. `context` is concatenated with `text` for the keyword
 * pass, but only `text` is searched for credential patterns.
 */
export function isSensitive(text: string, context?: string): boolean {
  const combined = `${context || ""} ${text}`;
  const lower = combined.toLowerCase();

  const hitBlocklist = BLOCKED_TERMS.some((term) => lower.includes(term));
  if (!hitBlocklist) return false;

  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Clean a candidate example fragment so it is safe to store inside a habit.
 * Returns undefined if the fragment is empty, only whitespace, or looks
 * sensitive. Otherwise:
 *   - trims and collapses internal whitespace
 *   - truncates to `maxLen` chars (default 60)
 *
 * Used by both the `hints` path in `observe_user_message` and by
 * `distill_recent_style` before persistence.
 */
export function sanitizeExample(raw: unknown, maxLen = 60): string | undefined {
  if (typeof raw !== "string") return undefined;

  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (!collapsed) return undefined;

  // Sensitive material never gets stored, no matter how short.
  if (isSensitive(collapsed)) return undefined;

  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}
