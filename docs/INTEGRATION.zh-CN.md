# style-memory-mcp 接入指南

`style-memory-mcp` 是本地 stdio MCP server。它不会主动把 brief 推进宿主上下文；宿主必须在新 session
首轮实质回复前调用 bootstrap，并在 revision 变化或需要重新对齐时调用 `get_style_brief`。

## 配置

先在仓库中执行 `npm install`、`npm run check` 和 `npm run build`。MCP 配置使用绝对路径，并让所有希望共享记忆的
客户端使用同一个绝对 `STYLE_MEMORY_PATH`：

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

默认连接只暴露三个 runtime 工具：

- `bootstrap_style_memory`：开始 session，返回 `channel`、`policy`、`revision` 和 capsule；
- `observe_style_event`：提交最新用户消息及可选紧凑 hint，成功只返回 ack；
- `get_style_brief`：首次返回 capsule，已知 revision 过期时返回 delta，未变化时返回 ack。

`STYLE_MEMORY_TOOLSET=admin` 才启用管理面，包括兼容入口 `observe_user_message`、结构化 brief、review/list、称呼、翻车日志、
pin/forget、评分、学习开关和 `distill_recent_style`。兼容入口不是默认聊天协议。

## 宿主启动协议

把下面的语义放入宿主全局 agent instruction，而不是只放在某个聊天窗口：

```text
Use style-memory-mcp as a local style-alignment layer.

At the start of every new session, call bootstrap_style_memory and read its capsule before the first substantive reply.
If it requests initialization, inspect at most 12 host-local sessions from the last 30 days and call bootstrap again with only sanitized aggregates. Never send raw messages, titles, identity, addresses, private facts, or failure rules. Send initialization.action=skip when history is unavailable.
Use the returned channel and policy:
- hook: observe each user message outside the model tool loop;
- agent/full: during cold start, call observe_style_event for each committed user message;
- agent/event: after the memory is mature, call it only for explicit feedback, corrections, likely known patterns,
  new examples, or special expressions;
- agent/off: read-only; do not learn or apply feedback.
Send only the latest committed user message and compact semantic hints. Never send secrets, files, or full history.
Keep the revision returned by the server. Do not repeat a capsule when get_style_brief returns an ack.
When the revision changes, use its delta; request a complete capsule for correction, context compression, or when a delta
cannot be followed independently. In long chats, a fallback refresh is not earlier than 30 user turns.
```

`hook` 是模型外的宿主能力；不能用每轮模型工具调用冒充 hook。没有 hook 时，`full` 适合冷启动精确统计，核心记忆成熟后切换
`event`；`off` 只读。bootstrap/status 的返回值必须明确标注实际通道和策略。

每个新 session 使用无语义短 `sessionId`，不要把标题、身份或对话内容编码进 sessionId。未提交的消息不应补算为观察。

全新空 store 只请求一次初始化。宿主在本地读取近期历史，MCP 只接收结构化汇总：声线量表、由明确反馈支持的回复偏好、具体协作偏好和最多 3 个表达候选。初始化不接收原始 session、消息、标题、称呼、私人事实或翻车规则；无历史能力时持久化 `skip`。正常风格摘要不会被无意义打码，但凭据和明确 PII 仍会过滤。

## Hint 与反馈边界

host 可以在同一个 `observe_style_event` 里提交 `hints`、`profileHints`、`addressHints` 和显式 `feedback`，但 MCP 最终负责校验、
评分和生命周期。

- `profileHints` 只记录具体的回应/协作偏好，写入 `responsePreferences` 或 profile；不能用用户消息短、用户口吻等推断 agent 回复长度或温度。
- `hints` 先保存 `kind + literal` 低层证据；行为摘要、功能和变体策略应有宿主语义、明确反馈或已有模式支持。
- `distill_recent_style` 是 admin 的 session 末路径，每次最多 3 个候选；初始化和蒸馏每项只贡献一次低权重观察，仍需 2 次、2 session，不能立即 active。
- `addressHints` 必须绑定当前用户消息、`sourceRole=user` 和合法 `from/to`。用户→助手只识别不反称；助手→用户只能由用户明确要求/确认产生。

称呼两个方向独立存储、独立纠错和独立容量控制。同一 literal 双向存在时，操作一个方向不会修改另一个方向；引用、否定、第三方姓名、
文档示例、assistant 输出和工具输出不是证据。

## Brief 与 token 成本

brief 固定六段：称呼、核心语感、口癖、标点与表情、陪伴偏好、翻车日志。表达模式以行为为主、例子为辅；`exact_only`、
`same_family`、`open_variation` 是唯一变体策略。capsule 通常只带每方向一个称呼和两个表达模式，绝对上限分别是每方向 2 个和表达模式 5 个，
且不能为了填满条目突破 token 上限。

宿主应计入完整 20 回合成本：全局指令、每轮工具 schema、调用参数、工具返回、首次 capsule、后续 delta，以及 capsule 留在后续输入中的重复占用；
cached input 单列。没有目标模型 tokenizer 或真实 API usage 时，只能报告协议覆盖范围和测量限制，不能用字符数声称模型 token 结果，见
[`docs/V0.5.0-TOKEN-REPORT.zh-CN.md`](V0.5.0-TOKEN-REPORT.zh-CN.md)。

## 豆包等宿主

如果宿主支持自定义 MCP server，使用上面的 JSON，并把全局启动协议写入 agent 指令。如果入口只支持普通提示词，它可以参考
`examples/agent-instruction.md`，但不能持久读写本地 store，也不能模拟 hook 的模型外成本。

## 升级与排查

升级使用显式隔离参数：

```bash
node scripts/install-or-upgrade.mjs \
  --install-root /absolute/path/to/style-memory-runtime \
  --store /absolute/path/to/style-memory.json
```

安装器会自动 staging、备份、迁移、原子切换和握手；失败返回 rollback。它不会猜测或扫描宿主配置，配置文件必须由调用方显式提供。
E10 只使用临时 fixture，不修改真实安装或真实 store。

- 看不到工具：确认宿主支持 MCP 并重启连接；默认应只有三个 runtime 工具。
- 启动失败：确认 `npm run build` 成功，并使用 `dist/server.js` 的绝对路径。
- brief 不一致：确认所有 session 使用同一个绝对 `STYLE_MEMORY_PATH`，且启动协议在全局指令中。
- 学不到东西：检查 channel/policy；`off` 不学习，`event` 只处理触发事件，表达模式还需 2 次、2 session。
