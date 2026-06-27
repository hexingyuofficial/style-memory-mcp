import type { ExtractedHabit } from "./types.js";

// =============================================================================
// Style extraction: rule-based detection of conversational style signals.
//
// Current dialect coverage: Sichuan (zh-CN-sichuan).
// Other dialect markers can be added by extending DIALECT_MARKERS below.
// PRs for other regional dialects (Cantonese, Shanghainese, Dongbei, etc.)
// are welcome — just add entries with the appropriate locale tag.
// =============================================================================

/** High-frequency Chinese words that should never be treated as catchphrases. */
const COMMON_ZH_FILLERS = new Set([
  "的", "了", "我", "你", "他", "她", "它",
  "是", "在", "有", "和", "就", "都", "也", "不",
  "这", "那", "吗", "呢", "吧", "啊", "哦", "嗯",
]);

// ---------------------------------------------------------------------------
// Dialect markers — extend this list to add more regional dialects.
// Each entry should include the appropriate locale (e.g. zh-CN-cantonese,
// zh-CN-dongbei) and reasonable useWhen / avoidWhen hints.
// ---------------------------------------------------------------------------
const DIALECT_MARKERS: Array<{
  text: string;
  locale: string;
  useWhen: string[];
  avoidWhen: string[];
  notes: string;
}> = [
  // Sichuan (西南官话 / Southwest Mandarin)
  { text: "锤子",   locale: "zh-CN-sichuan", useWhen: ["casual_chat", "joking", "warm_chat"], avoidWhen: ["serious_debugging", "legal", "medical", "user_upset"], notes: "Sichuan dialect marker; use lightly as flavor, not imitation." },
  { text: "巴适",   locale: "zh-CN-sichuan", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["serious_debugging", "legal", "medical"], notes: "Sichuan dialect: comfortable, nice." },
  { text: "要得",   locale: "zh-CN-sichuan", useWhen: ["casual_chat", "light_confirmation"], avoidWhen: ["formal_writing", "legal"], notes: "Sichuan dialect: OK, sure." },
  { text: "莫得",   locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "high_stakes_advice"], notes: "Sichuan dialect: don't have / no." },
  { text: "安逸",   locale: "zh-CN-sichuan", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["serious_debugging", "legal", "medical"], notes: "Sichuan dialect: comfortable, satisfying." },
  { text: "瓜兮兮", locale: "zh-CN-sichuan", useWhen: ["joking", "casual_chat"], avoidWhen: ["formal_writing", "user_upset", "high_stakes_advice"], notes: "Sichuan dialect: silly, goofy." },
  { text: "爪子",   locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "high_stakes_advice"], notes: "Sichuan dialect: what's up / what do you want." },
  { text: "咋个",   locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Sichuan dialect: how / why." },
  { text: "噻",     locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "high_stakes_advice"], notes: "Sichuan dialect sentence-final particle." },
  { text: "撒子",   locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Sichuan dialect: what." },
  { text: "雄起",   locale: "zh-CN-sichuan", useWhen: ["casual_chat", "encouragement"], avoidWhen: ["formal_writing", "medical"], notes: "Sichuan dialect: cheer up / go for it." },
  { text: "晓得",   locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Sichuan dialect: know / understand." },
  { text: "搞快点", locale: "zh-CN-sichuan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Sichuan dialect: hurry up." },
];

// ---------------------------------------------------------------------------
// Catchphrases — language-specific common expressions.
// ---------------------------------------------------------------------------
const ZH_CATCHPHRASES = [
  "哈哈哈", "哈哈哈哈",
  "笑死", "救命",
  "可以不", "有问题不",
  "好哇", "哇", "嘛", "诶", "呀", "捏",
  "呜呜",
  "就是说", "感觉",
  "绝了", "离谱",
  "牛的", "太强了",
];

const EN_CATCHPHRASES = [
  "lol", "lmao", "haha",
  "tbh", "imo", "idk",
  "kinda", "sorta",
  "you know", "y'know",
  "ngl", "fr",
  "no worries", "all good",
];

// Pre-compile word-boundary regex for each English catchphrase
const EN_CATCHPHRASE_REGEXES: Array<{ phrase: string; re: RegExp }> =
  EN_CATCHPHRASES.map((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      phrase,
      re: new RegExp(`(^|\\b)${escaped}(\\b|$)`, "i"),
    };
  });

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Match kaomoji and text emoticons.
 *
 * Part 1: bracket-wrapped expressions like (｡･ω･｡) or （笑）
 *   — forgiving: mixed bracket types (like (你好）) also match,
 *     since users often mix Chinese/English brackets in practice.
 *
 * Part 2: standalone symbol sequences like ✧｡･ω≖◡ (2-32 chars).
 *   Upper bound prevents catastrophic backtracking on long symbol runs.
 */
const EMOTICON_RE =
  /(?:[（(][^（）()\n]{1,24}[)）])|(?:[✧｡･ω≖◡꒰꒱づ・ﾟ∀≧≦]{2,32})/gu;

/** Unicode emoji (Extended_Pictographic property). */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// =============================================================================
// Public API
// =============================================================================

export function extractHabits(text: string): ExtractedHabit[] {
  const normalized = text.trim();
  if (!normalized || normalized.length > 4000) return [];

  const results: ExtractedHabit[] = [];
  collectDialectMarkers(normalized, results);
  collectCatchphrases(normalized, results);
  collectEmoticons(normalized, results);
  collectPunctuation(normalized, results);
  collectLanguageMix(normalized, results);

  return dedupe(results);
}

// =============================================================================
// Collectors
// =============================================================================

function collectDialectMarkers(text: string, results: ExtractedHabit[]) {
  for (const marker of DIALECT_MARKERS) {
    if (text.includes(marker.text)) {
      results.push({
        kind: "dialect_marker",
        text: marker.text,
        locale: marker.locale,
        confidenceDelta: 0.2,
        useWhen: marker.useWhen,
        avoidWhen: marker.avoidWhen,
        notes: marker.notes,
      });
    }
  }
}

function collectCatchphrases(text: string, results: ExtractedHabit[]) {
  for (const phrase of ZH_CATCHPHRASES) {
    if (text.includes(phrase) && !COMMON_ZH_FILLERS.has(phrase)) {
      results.push({
        kind: "catchphrase",
        text: phrase,
        locale: "zh-CN",
        confidenceDelta: 0.12,
        useWhen: ["casual_chat", "light_confirmation"],
        avoidWhen: ["formal_writing", "high_stakes_advice"],
      });
    }
  }

  const lower = text.toLowerCase();
  for (const { phrase, re } of EN_CATCHPHRASE_REGEXES) {
    if (re.test(lower)) {
      results.push({
        kind: "catchphrase",
        text: phrase,
        locale: "en",
        confidenceDelta: 0.12,
        useWhen: ["casual_chat", "friendly_reply"],
        avoidWhen: ["formal_writing", "high_stakes_advice"],
      });
    }
  }
}

function collectEmoticons(text: string, results: ExtractedHabit[]) {
  const emoticons = text.match(EMOTICON_RE) || [];
  for (const item of emoticons.slice(0, 4)) {
    if (item.length < 2 || item.length > 32) continue;
    results.push({
      kind: "emoji",
      text: item,
      confidenceDelta: 0.16,
      useWhen: ["playful_chat", "warm_chat"],
      avoidWhen: ["formal_writing", "error_report", "user_upset"],
      notes: "Text emoticon or kaomoji.",
    });
  }

  const emoji = text.match(EMOJI_RE) || [];
  for (const item of emoji.slice(0, 4)) {
    results.push({
      kind: "emoji",
      text: item,
      confidenceDelta: 0.08,
      useWhen: ["playful_chat"],
      avoidWhen: ["formal_writing", "high_stakes_advice"],
    });
  }
}

function collectPunctuation(text: string, results: ExtractedHabit[]) {
  // Laughter patterns (哈哈哈哈, hehehe, etc.)
  if (/哈{2,}/u.test(text)) {
    results.push({
      kind: "tone",
      text: "laughs-with-hahaha",
      confidenceDelta: 0.08,
      useWhen: ["casual_chat"],
      avoidWhen: ["formal_writing", "user_upset"],
      notes: "User often softens tone with laughter.",
    });
  }

  // Repetitive exclamation / question marks
  if (/[!?？！]{2,}/u.test(text)) {
    results.push({
      kind: "punctuation",
      text: "expressive-punctuation",
      confidenceDelta: 0.06,
      useWhen: ["casual_chat", "excited_reply"],
      avoidWhen: ["formal_writing"],
    });
  }
}

function collectLanguageMix(text: string, results: ExtractedHabit[]) {
  const hasZh = /\p{Script=Han}/u.test(text);
  const hasLatin = /\p{Script=Latin}/u.test(text);
  if (hasZh && hasLatin) {
    results.push({
      kind: "language_mix",
      text: "zh-en-code-mix",
      confidenceDelta: 0.07,
      useWhen: ["technical_chat", "casual_chat"],
      avoidWhen: ["formal_writing"],
      notes: "User may be comfortable mixing Chinese and English terms.",
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

function dedupe(items: ExtractedHabit[]): ExtractedHabit[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.locale || ""}:${item.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
