# style-memory-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

A tiny local MCP server that learns a user's conversational style, catchphrases, dialect markers, emoji habits, tone preferences, and concrete collaboration preferences without storing private memories.

It is meant to remember the *flavor* of how someone talks, not the private facts of their life.

## Why

Most agent memory tools remember facts:

- "The user lives in..."
- "The user works on..."
- "The user prefers..."

`style-memory-mcp` remembers voice:

- "The user says `lol` or `哈哈哈` casually."
- "The user likes warm, playful replies."
- "The user sometimes uses Sichuan markers like `锤子` or `巴适`."
- "The user uses kaomoji like `(｡･ω･｡)`."

Small thing. Big vibe. (｡･ω･｡)ﾉ

## Features

- Local JSON store only — your data stays on your machine
- No cloud service, no telemetry, no external API calls
- **The MCP server itself never calls an LLM.** The dictionary path is pure
  regex. You may *optionally* let the host agent forward its own observations
  via `hints` — see [LLM-assisted learning](#llm-assisted-learning) below.
- No full conversation log storage — only style signals (and a short
  ≤60-char usage example per habit, sanitized before storage)
- Learns candidates first, promotes repeated habits later
- Promotion now also requires the habit to appear under **≥2 distinct
  context labels** (cross-context check, inspired by nuwa-skill)
- Auto-cleans stale habits (candidate → archived → deleted)
- Supports Chinese, English, emoji, kaomoji, and dialect markers — plus
  free-form `idiolect` for whatever the host LLM notices
- Built-in dictionary covers Sichuan, Cantonese, Northeast (Dongbei),
  Shanghainese, and Min Nan / Taiwanese markers, plus current
  (2024–2026) Chinese and English internet slang. Locale-tagged so the
  agent can tell universally-safe phrases apart from slang that must
  stay out of legal / medical / serious replies.
- Returns an actionable style brief: how to apply the style first, then the
  context-relevant habits
- Supports an `interaction profile`: how the user prefers the agent to
  collaborate, without personality labels
- Interaction-profile preferences can be reviewed, pinned, or forgotten just
  like style habits
- Includes a lightweight `get_style_memory_score` health check for readiness,
  drift risk, over-imitation risk, and brief refresh recommendations
- Works with any MCP-capable agent that calls the tools
- Pin habits to protect them from auto-cleanup
- Pause learning anytime with `set_learning_enabled`

## Installation

### Local install

```bash
git clone https://github.com/hexingyuofficial/style-memory-mcp.git
cd style-memory-mcp
npm install
npm run build
```

### Global install (optional)

```bash
npm install -g style-memory-mcp
# Then use: style-memory-mcp
```

For local development:

```bash
npm run dev
```

## MCP Client Config

Add to your MCP client configuration (e.g. Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "style-memory": {
      "command": "node",
      "args": ["/absolute/path/to/style-memory-mcp/dist/server.js"]
    }
  }
}
```

You can customize the JSON store location:

```json
{
  "mcpServers": {
    "style-memory": {
      "command": "node",
      "args": ["/absolute/path/to/style-memory-mcp/dist/server.js"],
      "env": {
        "STYLE_MEMORY_PATH": "/absolute/path/to/style-memory.json"
      }
    }
  }
}
```

See [docs/INTEGRATION.zh-CN.md](docs/INTEGRATION.zh-CN.md) for a practical
Chinese integration guide, including Doubao-style setup notes and the
recommended automatic brief refresh protocol.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STYLE_MEMORY_PATH` | `~/.style-memory-mcp/style-memory.json` | Path to the JSON store |
| `STYLE_MEMORY_MIN_PROMOTE_COUNT` | `3` | Times a habit must be seen before becoming active |
| `STYLE_MEMORY_CANDIDATE_TTL_DAYS` | `30` | Days before unused candidate habits are deleted |
| `STYLE_MEMORY_INACTIVE_TTL_DAYS` | `180` | Days before active habits are archived |
| `STYLE_MEMORY_MAX_BRIEF_ITEMS` | `8` | Max habits returned in a style brief |
| `STYLE_MEMORY_MAX_EXAMPLE_LEN` | `60` | Max chars for a stored usage example |
| `STYLE_MEMORY_LEARNING` | `on` | Set to `off` to disable learning |
| `STYLE_MEMORY_DICTIONARY_PATH` | unset | Path to a custom style dictionary JSON file |

Custom dictionaries can be either an array or `{ "habits": [...] }`:

```json
{
  "habits": [
    {
      "kind": "catchphrase",
      "text": "ship it",
      "locale": "en",
      "confidenceDelta": 0.14,
      "useWhen": ["casual_chat"],
      "avoidWhen": ["formal_writing", "high_stakes_advice"],
      "match": "word"
    }
  ]
}
```

## Tools

### `observe_user_message`

Learns lightweight style signals from the latest user message.

Agents should call this after user messages, but should **not** send secrets, private memory dumps, or full chat logs.

May optionally include a `hints` array — see [LLM-assisted
learning](#llm-assisted-learning) below — and a `profileHints` array for
concrete collaboration preferences.

### `get_style_brief`

Returns a short text style brief for the agent to use lightly.

Agents should call this at the start of a conversation, or before drafting a friendly reply.

### `get_style_brief_structured`

Returns JSON for agents that want both the text brief and structured metadata:

- `brief`: text that can be placed directly into the agent context
- `habits`: structured style habits
- `interactionProfile`: structured collaboration preferences
- `profileNudge`: a light reminder when stable style habits exist but no stable interaction profile exists yet; otherwise `null`

### `distill_recent_style`

Batched, user-endorsed seeding. The host LLM submits 3–8 high-conviction
observations distilled from recent messages. Each habit becomes `active`
immediately. Useful for warm-starting a fresh store, or when the user
explicitly asks the agent to "really learn how I talk".

### `distill_interaction_profile`

Batched, user-endorsed seeding for concrete collaboration preferences such
as "prefers value judgment before steps" or "likes plan → implement →
verify for technical work". Do not submit personality labels,
psychological states, diagnoses, or private facts.

### `list_style_habits`

Lists candidates, active habits, and archived habits.

### `list_interaction_profile`

Lists stored collaboration and response-structure preferences.

### `review_style_habits`

Returns a short review queue with suggested actions: `keep`, `pin`,
`forget`, or `observe`. Useful when the user wants to inspect what the MCP
has learned.

### `review_interaction_profile`

Returns a short review queue for collaboration preferences with suggested
actions: `keep`, `pin`, `forget`, or `observe`.

### `forget_style_habit`

Deletes a habit by id or exact text.

### `forget_interaction_preference`

Deletes a collaboration preference by id or exact text.

### `pin_style_habit`

Pins a habit so cleanup will not delete it.

### `pin_interaction_preference`

Pins a collaboration preference so cleanup will not delete it.

### `set_learning_enabled`

Turns learning on or off.

### `get_style_memory_score`

Scores whether the local style memory is usable and stable. Returns
readiness, stability, freshness, drift risk, over-imitation risk, whether
`get_style_brief` should be refreshed, and short recommendations.

### `get_style_memory_status`

Shows the JSON path and habit counts.

## Agent Instruction

Add something like this to your agent or skill:

```text
Use style-memory-mcp for lightweight conversational style only.
At the start of a conversation, call get_style_brief.
After each user message, call observe_user_message with only the latest user message.
In long chats, silently call get_style_brief again every 12-20 user turns,
after major context switches, before long important answers, or whenever the
user says things like "感觉飘了" or "重新对齐一下".
If you spot a personal habit the built-in dictionary likely wouldn't catch
(e.g. a self-invented sentence-final particle, an unusual structural quirk),
add it as a hints[] entry on the same observe_user_message call.
Three repetitions across two distinct contexts are needed before a habit
becomes stable, so you don't need to be right on the first try.
Do not send secrets, private memories, files, or full conversation logs.
Use returned style hints lightly. Shape the assistant's own stable
collaboration style; never copy the user mechanically.
```

A longer template lives at `examples/agent-instruction.md`.

## Interaction Profile

`style-memory-mcp` does not build a personality profile. It can learn
concrete, behavioral collaboration preferences that are safer and more
useful:

- "The user prefers conclusions before details."
- "For technical work, the user likes plan → implement → verify."
- "The user prefers value judgment before step-by-step instructions."
- "The user dislikes vague praise and wants specific recommendations."

Do not store:

- "The user is anxious."
- "The user is introverted."
- Psychological labels, diagnoses, or personality types.
- Real-world identity, address, job, or other private facts.

Host agents can submit `profileHints` on `observe_user_message`:

```jsonc
{
  "text": "First tell me whether this is worth doing, then give steps.",
  "context": "planning",
  "profileHints": [
    {
      "category": "response_structure",
      "text": "prefers value judgment before step-by-step implementation",
      "example": "First tell me whether this is worth doing, then give steps.",
      "useWhen": ["planning", "technical_chat"],
      "confidence": 0.7
    }
  ]
}
```

For a one-shot seed, use `distill_interaction_profile` with 1–8
high-conviction preferences. Active profile preferences appear in
`get_style_brief` alongside style habits, but the brief stays short and
context-filtered.

If a profile preference is wrong, use `forget_interaction_preference`. If it
is important and should survive cleanup, use `pin_interaction_preference`.
Use `review_interaction_profile` for a short correction queue.

## Drift and Refresh

The MCP server cannot push context into the host agent by itself. The host
agent should refresh its alignment brief:

- at the start of a new chat,
- every 12–20 user turns in long chats,
- after major topic or context switches,
- before long or important answers,
- when the user says "感觉飘了", "重新对齐一下", "不像我", or similar.

For a quick health check, call `get_style_memory_score`. If
`briefRefreshRecommended` is `true`, call `get_style_brief` before the next
substantial reply.

## Read-only Reuse and Restarts

MCP processes are normally started and restarted by the host agent.
`style-memory-mcp` does not need to self-restart. The durable part is the
JSON store: if multiple conversations use the same `STYLE_MEMORY_PATH`, they
read the same style memory after any restart.

If the store has learned enough and you want it to guide style without
continuing to learn, use this pattern:

1. Keep the same `STYLE_MEMORY_PATH`.
2. Call `get_style_brief` at the start of a new conversation.
3. Call `set_learning_enabled(false)` or set `STYLE_MEMORY_LEARNING=off`.
4. Turn learning back on only when you want to refresh the style.

This gives you persistent style carryover without writing new habits on every
message.

## LLM-assisted learning

The dictionary path knows only what's hard-coded (Sichuan dialect, common
Chinese/English catchphrases, kaomoji, etc.). It will miss anything the
author didn't think of — including the *personal* habits that make someone
sound like themselves.

`style-memory-mcp` solves this without taking on an LLM dependency itself:
**the host agent already reads every user message to generate its reply, so
let it pass along anything it noticed.** The MCP server stays a thin
"counter + lifecycle + safety" layer over local JSON. No API key. No
network. No model registry. Zero added cost.

```jsonc
// observe_user_message input
{
  "text": "今天天气好巴适莫",
  "context": "casual_chat",
  "hints": [
    {
      "kind": "sentence_final_particle",
      "text": "莫",
      "example": "今天天气好巴适莫",
      "confidence": 0.6
    }
  ]
}
```

After three observations across two distinct `context` labels, `莫` is
promoted to `active` and shows up in future `get_style_brief` calls,
example included. High-confidence hints (≥ ~0.71) skip the cross-context
gate.

For batched, user-endorsed seeding, call `distill_recent_style` once with
3–8 observations distilled from recent messages.

Guardrails that make this safe:

- The MCP server itself never calls an LLM — it just records what the host
  reported. "No network" is still true.
- Hints with a bad `kind` or empty `text` are dropped, not learned.
- Examples are sanitized (`sanitizeExample`): whitespace collapse, length
  cap, sensitive content (credentials/tokens) silently dropped.
- The three-strike + cross-context promote rule keeps a single hallucinated
  hint from polluting the active habit set.
- All existing controls (`forget_style_habit`, `pin_style_habit`,
  `set_learning_enabled`) work unchanged.

## Cleanup Rules

The server does not need a background daemon. Cleanup happens when the MCP starts and when tools are called.

Default behavior:

- Candidate habits disappear after 30 inactive days.
- Active habits are archived after 180 inactive days.
- Archived habits are deleted after another 180 inactive days.
- Pinned habits are never deleted automatically.

Important: a habit is refreshed only when the user says it again. Agent usage does not keep it alive, so the system does not get stuck imitating itself.

## Example JSON

```json
{
  "id": "zh-cn-sichuan-dialect_marker-锤子",
  "kind": "dialect_marker",
  "text": "锤子",
  "locale": "zh-CN-sichuan",
  "confidence": 0.64,
  "seenCount": 4,
  "status": "active",
  "pinned": false,
  "useWhen": ["casual_chat", "joking", "warm_chat"],
  "avoidWhen": ["serious_debugging", "legal", "medical", "user_upset"]
}
```

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run check

# Build
npm run build

# Run tests
npm test

# Development mode (auto-reload with tsx)
npm run dev
```

## Dictionary size & token cost

The built-in dictionary (dialect markers, catchphrases, internet slang)
lives in `src/extract.ts` and is **never** sent to the LLM. It only
participates in local `text.includes()` / regex scans. Doubling the
dictionary costs zero extra tokens per turn.

The only payloads that reach the host LLM are:

1. `get_style_brief` output — bounded by `STYLE_MEMORY_MAX_BRIEF_ITEMS`
   (default 8). The brief surfaces only **habits the user has actually
   exhibited and which were promoted to active**, not whatever sits in
   the dictionary.
2. Tool descriptions — fixed in `server.ts`, independent of dictionary
   size.

So if your dialect or slang isn't covered, please send a PR with new
entries — it only improves recall and won't bloat anyone's prompts.

## Privacy

This project is intentionally boring about data:

- It stores style signals, not raw messages.
- It avoids learning from obvious secret contexts (credential-like patterns are filtered).
- It keeps its own JSON store, separate from any user memory database.
- Users can list, forget, pin, or disable learning at any time.
- No network calls. Everything runs locally.

## Contributing

Contributions are welcome! Especially:

- New dialect markers (Cantonese, Shanghainese, Dongbei, etc.)
- New catchphrase patterns for any language
- Better heuristics for sensitivity detection
- Performance improvements

Please add tests for new extraction rules. See `src/extract.test.ts` for examples.

## License

MIT
