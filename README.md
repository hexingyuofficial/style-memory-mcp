# style-memory-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

A tiny local MCP server that learns a user's conversational style, catchphrases, dialect markers, emoji habits, and tone preferences without storing private memories.

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

## Tools

### `observe_user_message`

Learns lightweight style signals from the latest user message.

Agents should call this after user messages, but should **not** send secrets, private memory dumps, or full chat logs.

May optionally include a `hints` array — see [LLM-assisted
learning](#llm-assisted-learning) below.

### `get_style_brief`

Returns a short style brief for the agent to use lightly.

Agents should call this at the start of a conversation, or before drafting a friendly reply.

### `distill_recent_style`

Batched, user-endorsed seeding. The host LLM submits 3–8 high-conviction
observations distilled from recent messages. Each habit becomes `active`
immediately. Useful for warm-starting a fresh store, or when the user
explicitly asks the agent to "really learn how I talk".

### `list_style_habits`

Lists candidates, active habits, and archived habits.

### `forget_style_habit`

Deletes a habit by id or exact text.

### `pin_style_habit`

Pins a habit so cleanup will not delete it.

### `set_learning_enabled`

Turns learning on or off.

### `get_style_memory_status`

Shows the JSON path and habit counts.

## Agent Instruction

Add something like this to your agent or skill:

```text
Use style-memory-mcp for lightweight conversational style only.
At the start of a conversation, call get_style_brief.
After each user message, call observe_user_message with only the latest user message.
If you spot a personal habit the built-in dictionary likely wouldn't catch
(e.g. a self-invented sentence-final particle, an unusual structural quirk),
add it as a hints[] entry on the same observe_user_message call.
Three repetitions across two distinct contexts are needed before a habit
becomes stable, so you don't need to be right on the first try.
Do not send secrets, private memories, files, or full conversation logs.
Use returned style hints lightly. Never over-imitate the user.
```

A longer template lives at `examples/agent-instruction.md`.

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
