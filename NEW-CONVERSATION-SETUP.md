# New Conversation Setup

This project keeps style memory in one local JSON store.

If a new chat window uses the same MCP config, it can read the same style memory right away.

## What to do

1. Point every agent/client to the same `style-memory-mcp` server.
2. Keep the JSON store path shared.
3. On a new conversation, call `get_style_brief` first.
4. After each user message, call `observe_user_message` with only the latest user message.
5. In long chats, call `get_style_brief` again every 12-20 user turns, after major context switches, or when the user says the style feels off.

If the style is already good enough, you can run in read-only mode:

1. Keep the same `STYLE_MEMORY_PATH`.
2. Call `get_style_brief` at startup.
3. Disable learning with `set_learning_enabled(false)` or `STYLE_MEMORY_LEARNING=off`.
4. Re-enable learning only when you want to refresh the style profile.

## What this means

- New conversations in the same agent setup will keep the same catchphrases and tone hints.
- Different clients will also share the style memory if they use the same JSON path.
- Clients without this MCP will not see the style memory.
- The host agent controls MCP process restarts. The JSON store is what keeps memory durable across restarts.
- The MCP cannot push a brief into the host by itself. The host agent must call `get_style_brief` on startup and periodically refresh it.
- If the user says "感觉飘了" or "重新对齐一下", call `get_style_brief` immediately.

## Recommended config

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

## Short version

If the new window is wired to the same MCP, the memory stays with you. If it is not wired, it does not.
