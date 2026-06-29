import { readFileSync } from "node:fs";
import type { ExtractedHabit } from "./types.js";
import type { HabitKind } from "./types.js";

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

  // Cantonese (粤语 / 廣東話)
  { text: "唔系",   locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: not / no." },
  { text: "点解",   locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: why / how come." },
  { text: "几好",   locale: "zh-CN-cantonese", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: pretty good." },
  { text: "得闲",   locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: free / have time." },
  { text: "唔该",   locale: "zh-CN-cantonese", useWhen: ["casual_chat", "polite_request"], avoidWhen: ["formal_writing"], notes: "Cantonese: thanks / excuse me." },
  { text: "犀利",   locale: "zh-CN-cantonese", useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"], notes: "Cantonese: impressive, sharp." },
  { text: "好彩",   locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: luckily / fortunately." },
  { text: "靓仔",   locale: "zh-CN-cantonese", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context"], notes: "Cantonese: handsome guy / dude." },
  { text: "靓女",   locale: "zh-CN-cantonese", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context"], notes: "Cantonese: pretty girl / miss." },
  { text: "嘅",     locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese possessive/sentence-final particle." },
  { text: "嘢",     locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: thing / stuff." },
  { text: "巴闭",   locale: "zh-CN-cantonese", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"], notes: "Cantonese: showing off, big deal." },
  { text: "揾食",   locale: "zh-CN-cantonese", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Cantonese: make a living." },
  { text: "扑街",   locale: "zh-CN-cantonese", useWhen: ["joking", "casual_chat"], avoidWhen: ["formal_writing", "user_upset", "high_stakes_advice", "professional_context"], notes: "Cantonese: harsh expletive; only use as self-deprecating banter, never at the user." },

  // Northeast Mandarin (东北话 / Dongbei)
  { text: "贼拉",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"], notes: "Dongbei intensifier: very, really." },
  { text: "贼好",   locale: "zh-CN-dongbei", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Dongbei: really good." },
  { text: "咋整",   locale: "zh-CN-dongbei", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Dongbei: what to do." },
  { text: "唠嗑",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"], notes: "Dongbei: chat, shoot the breeze." },
  { text: "嘎嘎",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"], notes: "Dongbei intensifier: very." },
  { text: "得劲",   locale: "zh-CN-dongbei", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Dongbei/Henan: feels good, satisfying." },
  { text: "忽悠",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "high_stakes_advice"], notes: "Dongbei: to BS / sweet-talk." },
  { text: "磨叽",   locale: "zh-CN-dongbei", useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "user_upset"], notes: "Dongbei: dawdling, slow." },
  { text: "嗯呐",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "light_confirmation"], avoidWhen: ["formal_writing"], notes: "Dongbei: yeah / mhm." },
  { text: "瞅啥",   locale: "zh-CN-dongbei", useWhen: ["joking", "casual_chat"], avoidWhen: ["formal_writing", "user_upset"], notes: "Dongbei: what you looking at (joking)." },
  { text: "寻思",   locale: "zh-CN-dongbei", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Dongbei: thinking, pondering." },
  { text: "老铁",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context"], notes: "Dongbei → internet: bro, pal." },
  { text: "稀罕",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"], notes: "Dongbei: like / fond of." },
  { text: "整活",   locale: "zh-CN-dongbei", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"], notes: "Dongbei → internet: to pull antics, do something funny." },

  // Shanghainese (上海话 / 沪语)
  { text: "侬好",   locale: "zh-CN-shanghai", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"], notes: "Shanghainese: hello (you-good)." },
  { text: "嗲",     locale: "zh-CN-shanghai", useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"], notes: "Shanghainese: lovely, classy, cute." },
  { text: "轧朋友", locale: "zh-CN-shanghai", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Shanghainese: to date." },
  { text: "白相",   locale: "zh-CN-shanghai", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Shanghainese: to play, hang out." },
  { text: "勿要",   locale: "zh-CN-shanghai", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Shanghainese: don't." },
  { text: "晓得伐", locale: "zh-CN-shanghai", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Shanghainese: know or not." },
  { text: "扎台型", locale: "zh-CN-shanghai", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"], notes: "Shanghainese: showing off / saving face." },
  { text: "灵光",   locale: "zh-CN-shanghai", useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"], notes: "Shanghainese: smart, sharp, works well." },

  // Min Nan / Taiwanese (闽南语 / 台語)
  { text: "呷饱",   locale: "zh-TW-minnan", useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"], notes: "Min Nan: eaten yet (greeting)." },
  { text: "按怎",   locale: "zh-TW-minnan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Min Nan: how / what's up." },
  { text: "啥米",   locale: "zh-TW-minnan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Min Nan: what." },
  { text: "爱睏",   locale: "zh-TW-minnan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Min Nan: sleepy." },
  { text: "揪团",   locale: "zh-TW-minnan", useWhen: ["casual_chat"], avoidWhen: ["formal_writing"], notes: "Min Nan / Taiwan: group up, organize." },
  { text: "阿娘喂", locale: "zh-TW-minnan", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"], notes: "Min Nan: oh my (surprise)." },
  { text: "丢咩",   locale: "zh-TW-minnan", useWhen: ["casual_chat", "light_confirmation"], avoidWhen: ["formal_writing"], notes: "Min Nan: that's right." },
  { text: "欸不是", locale: "zh-TW-minnan", useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"], notes: "Taiwan: wait what / hold on (mild disagreement)." },
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

// ---------------------------------------------------------------------------
// Internet slang — current (2024-2026) Mandarin web slang.
// These deserve stricter avoidWhen than generic catchphrases: an agent
// that mirrors "yyds" or "绝绝子" into a legal/medical/serious_debugging
// reply would feel painfully off. PRs welcome — add markers with the
// same useWhen/avoidWhen shape, prefer two or more characters so they
// don't collide with high-frequency single characters.
// ---------------------------------------------------------------------------
const ZH_INTERNET_SLANG: Array<{
  text: string;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
}> = [
  // Reactions / amplifiers
  { text: "yyds",       useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing", "legal", "medical", "serious_debugging"], notes: "永远的神 — internet praise; never use in serious technical or medical replies." },
  { text: "绝绝子",     useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing", "legal", "medical", "serious_debugging"] },
  { text: "破防",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset", "high_stakes_advice"], notes: "Internet: emotionally hit; avoid when the user is actually upset." },
  { text: "栓Q",        useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "666",        useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing", "legal", "medical"] },
  { text: "xswl",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context"], notes: "笑死我了." },
  { text: "awsl",       useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context"], notes: "啊我死了 — fan-ish excitement." },
  { text: "yygq",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"], notes: "阴阳怪气 — sarcasm tag; usage signals user notices passive-aggression." },
  { text: "emo",        useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "user_upset", "medical"], notes: "Mood-down (Chinese internet sense); avoid in serious mental-health contexts." },
  { text: "麻了",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"] },
  { text: "绷不住了",   useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"] },
  { text: "笑不活了",   useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"] },
  { text: "蚌埠住了",   useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"] },
  { text: "急了",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"] },
  { text: "真的会谢",   useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"], notes: "Sarcastic 'thanks'." },
  { text: "好家伙",     useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"] },
  { text: "芜湖",       useWhen: ["casual_chat", "excited_reply"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "起飞",       useWhen: ["casual_chat", "excited_reply"], avoidWhen: ["formal_writing", "professional_context", "medical"], notes: "Often co-occurs with 芜湖 — excited 'let's go!'." },
  { text: "芭比Q了",    useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset"], notes: "Internet: we're cooked / done for." },

  // Address terms / cohort talk
  { text: "家人们",     useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context"], notes: "Livestream-style audience address." },
  { text: "谁懂啊",     useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"] },
  { text: "姐妹",       useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "铁子",       useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "宝",         useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context", "user_upset"], notes: "Affectionate address; avoid when user wants to be taken seriously." },

  // Filler / discourse
  { text: "有一说一",   useWhen: ["casual_chat"], avoidWhen: ["formal_writing"] },
  { text: "确实",       useWhen: ["casual_chat", "light_confirmation"], avoidWhen: ["formal_writing", "legal"] },
  { text: "属实",       useWhen: ["casual_chat", "light_confirmation"], avoidWhen: ["formal_writing", "legal"] },
  { text: "一整个",     useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"], notes: "Often '一整个X住': 一整个无语住, 一整个爱住." },
  { text: "已读乱回",   useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"] },
  { text: "答辩",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset", "professional_context"], notes: "Internet slang for low-quality work; never used at the user." },

  // Work / life mood
  { text: "班味",       useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing"], notes: "Office-grind aesthetic." },
  { text: "躺平",       useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "high_stakes_advice", "career_advice"] },
  { text: "摆烂",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "high_stakes_advice", "career_advice"] },
  { text: "内卷",       useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "high_stakes_advice"] },

  // People-types
  { text: "老登",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context", "user_upset"], notes: "Mildly dismissive; never directed at the user." },
  { text: "老六",       useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context", "user_upset"], notes: "Gamer slang: sneaky player; never directed at the user." },
];

// ---------------------------------------------------------------------------
// English internet slang — current (2024-2026) Gen Z / web register.
// Same shape as ZH_INTERNET_SLANG. Avoid single-letter markers like "L"/"W"
// (catastrophic false positives) and anything that's actually offensive
// or NSFW-adjacent.
// ---------------------------------------------------------------------------
const EN_INTERNET_SLANG: Array<{
  text: string;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
}> = [
  { text: "bet",             useWhen: ["casual_chat", "light_confirmation"], avoidWhen: ["formal_writing", "legal", "medical"], notes: "Gen Z: OK / sure / sounds good." },
  { text: "no cap",          useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "legal", "medical"] },
  { text: "deadass",         useWhen: ["casual_chat"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "bussin",          useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"] },
  { text: "slaps",           useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing", "user_upset"], notes: "'This slaps' = this is great." },
  { text: "mid",             useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "compliment", "user_upset"], notes: "Dismissive: mediocre. Never apply to the user's work without care." },
  { text: "goated",          useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"] },
  { text: "rizz",            useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "sus",             useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "high_stakes_advice", "legal"], notes: "'Sus' is fine for jokes; never use for actual security analysis." },
  { text: "yeet",            useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "iykyk",           useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"] },
  { text: "bestie",          useWhen: ["casual_chat", "warm_chat"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "slay",            useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing", "professional_context"] },
  { text: "it's giving",     useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing"], notes: "'It's giving X' — vibe descriptor." },
  { text: "ate",             useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"], notes: "'You ate that' = nailed it. Word-boundary matched to avoid false hits." },
  { text: "unhinged",        useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset", "medical"] },
  { text: "lowkey",          useWhen: ["casual_chat"], avoidWhen: ["formal_writing"] },
  { text: "highkey",         useWhen: ["casual_chat"], avoidWhen: ["formal_writing"] },
  { text: "hits different",  useWhen: ["casual_chat", "compliment"], avoidWhen: ["formal_writing"] },
  { text: "delulu",          useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset", "medical"], notes: "'Delusional' as joke; never use seriously about user beliefs." },
  { text: "cooked",          useWhen: ["casual_chat", "joking"], avoidWhen: ["formal_writing", "user_upset", "high_stakes_advice"], notes: "'We're cooked' = we're done for." },
  { text: "we're so back",   useWhen: ["casual_chat", "excited_reply"], avoidWhen: ["formal_writing"] },
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

// English internet-slang regexes get the same word-boundary protection so
// "bet" does not match "better", "ate" does not match "atelier", etc.
const EN_INTERNET_SLANG_REGEXES: Array<{
  entry: (typeof EN_INTERNET_SLANG)[number];
  re: RegExp;
}> = EN_INTERNET_SLANG.map((entry) => {
  const escaped = entry.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    entry,
    re: new RegExp(`(^|\\b)${escaped}(\\b|$)`, "i"),
  };
});

type CustomMatchMode = "substring" | "word";

interface CustomDictionaryEntry {
  kind: HabitKind;
  text: string;
  locale?: string;
  confidenceDelta?: number;
  useWhen?: string[];
  avoidWhen?: string[];
  notes?: string;
  match?: CustomMatchMode;
}

interface NormalizedCustomDictionaryEntry {
  kind: HabitKind;
  text: string;
  locale?: string;
  confidenceDelta: number;
  useWhen: string[];
  avoidWhen: string[];
  notes?: string;
  match: CustomMatchMode;
  re?: RegExp;
}

const VALID_CUSTOM_KINDS = new Set<HabitKind>([
  "catchphrase",
  "dialect_marker",
  "emoji",
  "punctuation",
  "tone",
  "language_mix",
  "sentence_final_particle",
  "structure",
  "idiolect",
]);

const CUSTOM_DICTIONARY = loadCustomDictionary();

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
  collectInternetSlang(normalized, results);
  collectEmoticons(normalized, results);
  collectPunctuation(normalized, results);
  collectLanguageMix(normalized, results);
  collectCustomDictionary(normalized, results);

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

/**
 * Internet slang collector. Same kind ("catchphrase") as ZH/EN catchphrases,
 * but tagged with `zh-CN-internet` / `en-internet` so the agent can tell
 * "哈哈哈" (universally safe) apart from "yyds" (avoid in legal/medical).
 * Each entry carries its own avoidWhen — we do not flatten to a single
 * defaults bag.
 */
function collectInternetSlang(text: string, results: ExtractedHabit[]) {
  // Chinese: plain substring match. Mandarin doesn't have word boundaries
  // the way alphabetic scripts do, and all entries are ≥2 chars so the
  // false-positive risk is low. COMMON_ZH_FILLERS still applies as a
  // defensive guard if someone adds a single-character entry later.
  for (const entry of ZH_INTERNET_SLANG) {
    if (text.includes(entry.text) && !COMMON_ZH_FILLERS.has(entry.text)) {
      results.push({
        kind: "catchphrase",
        text: entry.text,
        locale: "zh-CN-internet",
        // Slightly higher delta than generic catchphrase: hitting "yyds"
        // is a much stronger style signal than hitting "感觉".
        confidenceDelta: 0.14,
        useWhen: entry.useWhen,
        avoidWhen: entry.avoidWhen,
        notes: entry.notes,
      });
    }
  }

  const lower = text.toLowerCase();
  for (const { entry, re } of EN_INTERNET_SLANG_REGEXES) {
    if (re.test(lower)) {
      results.push({
        kind: "catchphrase",
        text: entry.text,
        locale: "en-internet",
        confidenceDelta: 0.14,
        useWhen: entry.useWhen,
        avoidWhen: entry.avoidWhen,
        notes: entry.notes,
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

function collectCustomDictionary(text: string, results: ExtractedHabit[]) {
  for (const entry of CUSTOM_DICTIONARY) {
    const matched =
      entry.match === "word"
        ? Boolean(entry.re?.test(text))
        : text.includes(entry.text);
    if (!matched) continue;

    results.push({
      kind: entry.kind,
      text: entry.text,
      locale: entry.locale,
      confidenceDelta: entry.confidenceDelta,
      useWhen: entry.useWhen,
      avoidWhen: entry.avoidWhen,
      notes: entry.notes,
      source: "rule",
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

function loadCustomDictionary(): NormalizedCustomDictionaryEntry[] {
  const dataPath = process.env.STYLE_MEMORY_DICTIONARY_PATH?.trim();
  if (!dataPath) return [];

  try {
    const raw = JSON.parse(readFileSync(dataPath, "utf8"));
    const entries = Array.isArray(raw) ? raw : raw?.habits;
    if (!Array.isArray(entries)) {
      console.warn(
        `[style-memory-mcp] Ignoring custom dictionary at ${dataPath}: expected an array or { "habits": [...] }.`,
      );
      return [];
    }

    return entries.flatMap((entry) => {
      const normalized = normalizeCustomDictionaryEntry(entry);
      return normalized ? [normalized] : [];
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[style-memory-mcp] Failed to load custom dictionary: ${message}`);
    return [];
  }
}

function normalizeCustomDictionaryEntry(
  entry: unknown,
): NormalizedCustomDictionaryEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as Partial<CustomDictionaryEntry>;
  if (!candidate.kind || !VALID_CUSTOM_KINDS.has(candidate.kind)) return undefined;
  if (typeof candidate.text !== "string") return undefined;

  const text = candidate.text.trim();
  if (!text || text.length > 80 || COMMON_ZH_FILLERS.has(text)) return undefined;

  const match = candidate.match === "word" ? "word" : "substring";
  return {
    kind: candidate.kind,
    text,
    locale: cleanString(candidate.locale, 40),
    confidenceDelta: cleanConfidence(candidate.confidenceDelta),
    useWhen: cleanStringList(candidate.useWhen, 8, ["casual_chat"]),
    avoidWhen: cleanStringList(candidate.avoidWhen, 8, ["formal_writing", "high_stakes_advice"]),
    notes: cleanString(candidate.notes, 160),
    match,
    re: match === "word" ? wordRegex(text) : undefined,
  };
}

function cleanConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.14;
  return Math.min(1, Math.max(0.01, value));
}

function cleanString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLen ? text : undefined;
}

function cleanStringList(value: unknown, maxItems: number, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const item of value) {
    const label = cleanString(item, 40);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : fallback;
}

function wordRegex(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\b)${escaped}(\\b|$)`, "i");
}
