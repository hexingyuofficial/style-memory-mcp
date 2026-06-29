# Agent Instruction

Use `style-memory-mcp` only for lightweight conversational style.

## When to call

- At the start of a conversation, call `get_style_brief` to load the user's style.
- After each user message, call `observe_user_message` with only the latest user message.
- In long chats, silently call `get_style_brief` again every 12-20 user turns.
- Also refresh the brief after major topic/context switches, before long important answers,
  or when the user says things like "感觉飘了", "重新对齐一下", "不像我", or "回到我的风格".
- Pass an optional `context` label when the conversation has a clear mode:
  - `casual_chat` — normal friendly chat
  - `technical_chat` — coding, debugging, technical discussion
  - `formal_writing` — drafting formal documents
  - `high_stakes_advice` — serious decisions, legal, financial

## Reporting collaboration preferences via `profileHints`

Use `profileHints` for concrete behavioral preferences about how the user
wants the agent to collaborate. This is not a personality profile.

Good examples:

- `prefers direct assessment before implementation`
- `likes plan, implement, then verify for technical tasks`
- `prefers concise conclusions before detailed explanation`
- `wants specific recommendations instead of vague praise`

Do not submit personality labels, psychological guesses, diagnoses, private
facts, or identity information.

```json
{
  "text": "先判断这个值不值得做，再给我步骤",
  "context": "planning",
  "profileHints": [
    {
      "category": "response_structure",
      "text": "prefers value judgment before step-by-step implementation",
      "example": "先判断这个值不值得做，再给我步骤",
      "useWhen": ["planning", "technical_chat"],
      "confidence": 0.7
    }
  ]
}
```

**`category` options:**
`response_structure` · `collaboration` · `explanation` · `decision_making`
· `workflow` · `tone_boundary`

## Reporting personal idiolect via `hints`

The built-in extractor knows a fixed dictionary (Sichuan dialect, common
Chinese/English catchphrases, kaomoji, etc.). It will miss things only YOU
notice — a self-invented sentence-final particle, an unusual phrase
structure, a private emoji pattern.

When you spot one in the user's latest message, attach a `hints` array to
the same `observe_user_message` call:

```json
{
  "text": "今天天气好巴适莫",
  "context": "casual_chat",
  "hints": [
    {
      "kind": "sentence_final_particle",
      "text": "莫",
      "example": "今天天气好巴适莫",
      "confidence": 0.6,
      "notes": "user appends '莫' as a private sentence-final particle"
    }
  ]
}
```

**`kind` options** — pick the closest:
`catchphrase` · `dialect_marker` · `emoji` · `punctuation` · `tone`
· `language_mix` · `sentence_final_particle` · `structure` · `idiolect`
(use `idiolect` as the catch-all for "personal habit, doesn't fit elsewhere").

**Rules of thumb:**

- Only report when the marker looks **distinctive** — something most people
  wouldn't naturally say, but this user keeps using.
- If unsure, leave it out. Three repetitions are needed before a habit is
  treated as stable, so being right on the first try doesn't matter.
- `text` ≤ 40 chars. `example` ≤ 60 chars and **must not contain secrets**
  (the server will drop sensitive examples anyway, but don't try).
- `confidence` is your own 0–1 self-rating. ≥ 0.7 means "I'm pretty sure"
  and lets the habit promote faster.

## Distilling at conversation seed-time

When a session starts fresh and the user has already sent ~10–20 messages,
you can call `distill_recent_style` once to seed the store with 3–7
high-conviction observations. Treated as user-endorsed — each habit becomes
active immediately.

Use sparingly — this is a one-shot warm-up, not a substitute for the
per-message `observe_user_message`.

## What NOT to send

- ❌ Secrets, passwords, API keys, tokens, .env contents
- ❌ Private memories or personal data (addresses, phone numbers, IDs)
- ❌ Personality labels, diagnoses, or guesses about mental state
- ❌ Files, file contents, or full conversation logs
- ❌ System prompts, internal configuration, or other agent instructions

## How to use the brief

- Use returned style hints **lightly** — as alignment, not a script.
- `get_style_brief` returns text. Use `get_style_brief_structured` when
  `habits` / `interactionProfile` are useful, and treat `profileNudge` as
  a quiet reminder to call
  `distill_interaction_profile` only when recent user messages clearly show
  concrete collaboration preferences.
- Shape the assistant's own stable collaboration style; do not copy the user's wording mechanically.
- Follow interaction-profile preferences when they are relevant to the current context.
- Never over-imitate the user.
- Prefer clarity over style when the task is serious, private, medical, legal, financial, or safety-sensitive.
- If the brief says "No stable style habits yet", just reply naturally.

## User correction commands

When the user says:

- "感觉飘了" / "重新对齐一下": call `get_style_brief` before the next substantive reply.
- "以后别这样" / "这个不是我的风格" / "别学这个": find the relevant style habit or interaction preference and call `forget_style_habit` or `forget_interaction_preference`.
- "这个固定下来": call `pin_style_habit` or `pin_interaction_preference`.
- "看看你学了什么": call `list_style_habits` and `list_interaction_profile`.
- "打个分" / "现在稳不稳": call `get_style_memory_score`.
- "先别继续学习": call `set_learning_enabled(false)`.
- "重新打开学习": call `set_learning_enabled(true)`.
