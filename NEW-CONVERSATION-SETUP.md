# New Conversation Setup

This project keeps style memory in one local JSON store.

If a new chat window uses the same MCP config, it can read the same style memory right away.

## What to do

1. Point every agent/client to the same `style-memory-mcp` server.
2. Keep the JSON store path shared.
3. On a new conversation, call `get_style_brief` first.
4. After each user message, call `observe_user_message` with only the latest user message.

## What this means

- New conversations in the same agent setup will keep the same catchphrases and tone hints.
- Different clients will also share the style memory if they use the same JSON path.
- Clients without this MCP will not see the style memory.

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
