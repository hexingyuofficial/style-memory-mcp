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

- "The user says `lol`, `no cap`, or `ship it` casually."
- "The user likes warm, playful replies."
- "The user uses emoji like `✨`, `😭`, or `😄`."
- "The user leans on little idiolect markers like `tiny but mighty`."

Small thing. Big vibe. ✨

## Features

- Local JSON store only — your data stays on your machine
- No cloud service, no telemetry, no external API calls
- **The MCP server itself never calls an LLM.** The dictionary path is pure
  regex. You may *optionally* let the host agent forward its own observations
  via `hints` — see [LLM-assisted learning](#llm-assisted-learning) below.
- No full conversation log storage — only style signals (and a short
  ≤60-char usage example per habit, sanitized before storage)
- Learns candidates first; semantic expression patterns need at least 2
  observations across 2 independent sessions before automatic activation
- Auto-cleans stale habits (candidate → archived → deleted)
- Supports English slang, emoji, multilingual markers, and text emoticons — plus
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
- v2 produces a six-section brief: address, core voice, expression patterns,
  punctuation/emoji, companion preferences, and failure log
- Separates model-external `hook` observation from `agent` `full`/`event`/`off`
  policies; the default runtime exposes only three compact tools
- Uses a persistent store revision with capsule/delta/ack responses

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
| `STYLE_MEMORY_MIN_PROMOTE_COUNT` | `2` | Compatibility habit observations required before activation; semantic expressions also require 2 independent sessions |
| `STYLE_MEMORY_CANDIDATE_TTL_DAYS` | `30` | Days before unused candidate habits are deleted |
| `STYLE_MEMORY_INACTIVE_TTL_DAYS` | `180` | Days before active habits are archived |
| `STYLE_MEMORY_MAX_BRIEF_ITEMS` | `8` | Legacy brief limit; v2 expression/address limits are stricter |
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

The default chat connection exposes exactly three runtime tools:

- `bootstrap_style_memory`: starts a session and returns `channel`, `policy`,
  `revision`, the first capsule, and one-time initialization state.
- `observe_style_event`: submits only the latest user message plus compact
  hints. It returns an acknowledgement, not the store.
- `get_style_brief`: returns a capsule on first use, a short delta after a
  revision change, or an ack when the known revision is current.

The runtime has two observation channels. A host `hook` observes each message
outside the model tool loop. Without a hook, `agent` uses `full` during precise
cold-start measurement, `event` after memory matures, or `off` for read-only
reuse. `bootstrap_style_memory` reports the selected channel and policy.

Set `STYLE_MEMORY_TOOLSET=admin` only for management and diagnostics. The
admin-only surface includes the compatibility `observe_user_message`, full
structured brief output, listing/review/pin/forget tools, address management,
failure-log management, scoring, status, and `distill_recent_style`.

On a fresh empty store, bootstrap requests one-time initialization. A capable
host may inspect at most 12 host-local sessions from the last 30 days, then call
bootstrap again with only bounded voice, explicitly supported response
preferences, concrete collaboration preferences, and up to 3 expression
candidates. Raw messages, session titles, identity/address fields, failure
rules, and unknown fields are rejected. If history is unavailable, the host
submits `action: "skip"`; the choice persists.

`distill_recent_style` accepts at most 3 qualitative candidates per call. Each
candidate contributes one low-weight observation and remains subject to the
2-observations/2-sessions activation gate; it never bulk-counts or immediately
activates an expression pattern. This is separate from explicit profile
distillation, which records reviewed collaboration preferences.

## Agent Instruction

Add something like this to your agent or skill:

```text
Use style-memory-mcp for lightweight conversational style only.
At the start of each new session, call bootstrap_style_memory and read its capsule before the first substantive reply.
If bootstrap requests initialization, inspect at most 12 host-local sessions from the last 30 days and submit only sanitized aggregate fields; send action=skip if history is unavailable.
Use observe_style_event only according to the returned hook/agent policy; send only the latest user message.
Call get_style_brief with the known revision. Do not repeat the capsule when it returns an ack.
After a revision change, use the returned delta and refresh the capsule before an important reply.
As a long-chat fallback, refresh no earlier than 30 user turns, after context switches, or when the user says the style feels off.
If you spot a personal habit the built-in dictionary likely would not catch,
add a compact semantic hints[] entry to the same runtime event. Include
behaviorSummary, functions, and one of exact_only, same_family, or
open_variation when known. Two observations across two session IDs are
needed before a semantic expression becomes active.
Never infer a user name from assistant output, examples, environment text, or tools.
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

Host agents can submit `profileHints` on `observe_style_event` (or the admin
compatibility tool):

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

The MCP server cannot push context into the host agent by itself. A persistent
MCP configuration, one fixed absolute `STYLE_MEMORY_PATH`, and a global agent
instruction must make the host bootstrap each new session. The host should
refresh its alignment brief:

- at the start of a new chat,
- no earlier than every 30 user turns as a long-chat fallback,
- after major topic or context switches,
- before long or important answers,
- when the user says "this feels off", "realign to my style", "that does not sound like me", or similar.

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

The dictionary path knows only what's hard-coded (internet slang, common
catchphrases, emoji, regional markers, etc.). It will miss anything the
author didn't think of — including the *personal* habits that make someone
sound like themselves.

`style-memory-mcp` solves this without taking on an LLM dependency itself:
**the host agent already reads every user message to generate its reply, so
let it pass along anything it noticed.** The MCP server stays a thin
"counter + lifecycle + safety" layer over local JSON. No API key. No
network. No model registry. Zero added cost.

```jsonc
// observe_style_event input
{
  "text": "tiny but mighty ✨ ship it",
  "context": "casual_chat",
  "hints": [
    {
      "kind": "idiolect",
      "text": "tiny but mighty",
      "example": "tiny but mighty ✨ ship it",
      "confidence": 0.6
    }
  ]
}
```

After two semantic observations across two distinct `sessionId` values,
`tiny but mighty` is promoted to `active` and can appear in future briefs.
The MCP applies the score and activation gate; a host confidence hint does not
replace the required observations.

For session-end distillation, call the admin-only `distill_recent_style` with
at most 3 low-weight candidates. Each call is bounded and does not bypass the
activation gate.

Guardrails that make this safe:

- The MCP server itself never calls an LLM — it just records what the host
  reported. "No network" is still true.
- Hints with a bad `kind` or empty `text` are dropped, not learned.
- Examples are sanitized (`sanitizeExample`): whitespace collapse, length
  cap, sensitive content (credentials/tokens) silently dropped.
- The two-observation + two-session promote rule keeps a single hallucinated
  hint from polluting the active habit set.
- All existing controls (`forget_style_habit`, `pin_style_habit`,
  `set_learning_enabled`) work unchanged.

## Cleanup Rules

The server does not need a background daemon. Cleanup happens when the MCP starts and when tools are called.

Default behavior:

- Candidate habits disappear after 30 inactive days.
- Active habits are archived after 180 inactive days.
- Archived habits are deleted after 360 days from their last appearance.
- Pinned expression patterns are never deleted automatically.
- Addresses, explicit companion preferences, and the failure log are not
  forgotten by expression-pattern TTL cleanup. `forget` is immediate.

Important: a habit is refreshed only when the user says it again. Agent usage does not keep it alive, so the system does not get stuck imitating itself.

## Example JSON

```json
{
  "id": "en-catchphrase-ship-it-h-0abc123",
  "kind": "catchphrase",
  "text": "ship it",
  "locale": "en",
  "confidence": 0.64,
  "seenCount": 4,
  "status": "active",
  "pinned": false,
  "useWhen": ["casual_chat", "technical_chat", "friendly_reply"],
  "avoidWhen": ["serious_debugging", "legal", "medical", "user_upset"]
}
```

## Upgrade and rollback

For an existing installation, build the package and run
`node scripts/install-or-upgrade.mjs` through a host-specific wrapper that
supplies an explicit install root and the same absolute store path. The
installer stages a versioned runtime, backs up the v1 store and host files,
migrates the store atomically, switches a stable launcher, and performs a
runtime/store-version handshake. A lock makes concurrent runs fail closed;
faults return a machine-readable rollback result and restore the old runtime,
store, and host configuration.

The installer does not scan or modify arbitrary paths. Keep the launcher,
MCP configuration, global agent instruction, and `STYLE_MEMORY_PATH` stable
across sessions so each new session can bootstrap the same store.

## Development

The `v0.5.0` hardening backlog, memory model, reproducible experiments, and release gate
are tracked in
[`docs/V0.5.0-HARDENING-PLAN.zh-CN.md`](docs/V0.5.0-HARDENING-PLAN.zh-CN.md).
The milestone is complete only after every required experiment passes.
The detailed execution sequence and handoff prompt are in
[`docs/V0.5.0-EXECUTION-PLAN.zh-CN.md`](docs/V0.5.0-EXECUTION-PLAN.zh-CN.md)
and [`docs/V0.5.0-IMPLEMENTATION-PROMPT.zh-CN.md`](docs/V0.5.0-IMPLEMENTATION-PROMPT.zh-CN.md).

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

The payloads that reach the host LLM include:

1. The first capsule and later deltas. The v2 brief has six ordered sections:
   address, core voice, expression patterns, punctuation/emoji, companion
   preferences, and failure log. Typical output selects one address per
   direction and two expression patterns; hard limits are two addresses per
   direction and five expression patterns.
2. Tool descriptions, schemas, call parameters, and tool returns. Runtime
   exposes only three compact schemas; admin schemas are opt-in.

The capsule remains in later model inputs and must be counted again by a real
token usage report. A revision ack does not append another copy. The project
does not claim an E06 model-token result when no target tokenizer or model API
usage is available; see `docs/V0.5.0-TOKEN-REPORT.zh-CN.md`.

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

- New slang, emoji, or regional-expression patterns
- New catchphrase patterns for any language
- Better heuristics for sensitivity detection
- Performance improvements

Please add tests for new extraction rules. See `src/extract.test.ts` for examples.

## License

MIT
