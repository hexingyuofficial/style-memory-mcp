# style-memory-mcp 接入指南

`style-memory-mcp` 是一个本地 stdio MCP server。只要客户端支持启动本地 MCP server，并允许模型调用工具，就可以接入同一份风格记忆。

它不会主动把 brief 推进聊天上下文；重新对齐必须由宿主 agent 主动调用 `get_style_brief`。

## 通用配置

先安装并构建：

```bash
npm install
npm run build
```

在支持 MCP 的客户端里添加：

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

要点：

- `args` 必须是 `dist/server.js` 的绝对路径。
- 多个客户端想共享同一份风格记忆，就使用同一个 `STYLE_MEMORY_PATH`。
- 如果一个客户端不支持 MCP 工具调用，只贴提示词也能改善一点风格，但不能持久学习、评分或自动更新 JSON。

## 启动协议

把下面这段放进 agent 的系统提示词、项目说明或自定义指令里：

```text
Use style-memory-mcp as a lightweight local style alignment layer.

At the start of a new chat, silently call get_style_brief before answering.
After each user message, call observe_user_message with only the latest user message.
Do not send secrets, files, private memory dumps, or full conversation logs.

Use the get_style_brief text to shape the assistant's own stable collaboration style.
If you need structured metadata, call get_style_brief_structured.
If its `profileNudge` is non-null and recent user messages clearly reveal concrete collaboration preferences,
consider calling distill_interaction_profile.
Do not mimic the user mechanically.

Refresh alignment by calling get_style_brief again:
- every 12 to 20 user turns in a long chat,
- after a major topic/context switch,
- before a long or important answer,
- whenever the user says things like "感觉飘了", "重新对齐一下", "不像我", "回到我的风格".

If the user says "以后别这样", "这个不是我的风格", or "别学这个",
review and remove the relevant style habit or interaction preference.
If the user says "这个固定下来", pin the relevant item.
```

## 自动重新对齐

MCP 不能自己插话，也不能主动修改宿主 agent 的上下文。自动重新对齐要靠 agent 执行一个固定节奏：

1. 新会话开始：调用 `get_style_brief`。
2. 每条用户消息后：调用 `observe_user_message`。
3. 每 12-20 个用户回合：再次调用 `get_style_brief`。
4. 话题切换、长回答前、用户说“感觉飘了”：立即调用 `get_style_brief`。
5. 可选：定期调用 `get_style_memory_score`。如果 `briefRefreshRecommended` 为 `true`，下一次重要回复前调用 `get_style_brief`。

这个流程不会让 agent 每句话都贴 brief，只是静默刷新自己的风格小抄。

## 豆包接入备忘

如果你使用的豆包环境支持自定义 MCP server 或本地工具配置，使用上面的通用 JSON 即可。服务名建议叫 `style-memory`。

如果豆包界面要求你填写“工具启动命令”，拆成：

```text
command: node
args: /absolute/path/to/style-memory-mcp/dist/server.js
env:
  STYLE_MEMORY_PATH=/absolute/path/to/style-memory.json
```

然后把“启动协议”那段放进豆包的 agent 指令里。

如果当前豆包入口只支持普通提示词、不支持 MCP：

- 可以贴 `examples/agent-instruction.md` 的简化版，让它尽量按风格工作。
- 但它不能读写本地 JSON，也不能真的持久学习。
- 等该入口支持 MCP 后，再接入本项目。

## 排查

- 看不到工具：确认客户端支持 MCP，并且已重启客户端。
- server 启动失败：确认 `npm run build` 成功，`dist/server.js` 存在。
- 找不到文件：确认配置里使用绝对路径。
- 学不到东西：确认没有设置 `STYLE_MEMORY_LEARNING=off`。
- 风格太像用户：提醒 agent “不要机械模仿，只形成稳定协作风格”，并 review/forget 多余的表达类 habit。
