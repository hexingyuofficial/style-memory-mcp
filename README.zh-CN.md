# style-memory-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

一个轻量级的本地 MCP 服务器，学习用户的对话风格、口头禅、方言标记、表情习惯、语气偏好，以及具体的协作偏好，**不存储私人记忆**。

它的目的是记住一个人说话的"味道"，而不是他生活中的私密事实。

## 为什么

大多数 agent 记忆工具记住的是事实：

- "用户住在..."
- "用户的工作是..."
- "用户偏好..."

`style-memory-mcp` 记住的是风格：

- "用户会随口说 `lol` 或 `哈哈哈`"
- "用户喜欢温暖、俏皮的回复"
- "用户偶尔会用四川方言，比如 `锤子`、`巴适`"
- "用户喜欢用颜文字 `(｡･ω･｡)`"

小事情。大感觉。(｡･ω･｡)ﾉ

## 特性

- 仅本地 JSON 存储 — 数据留在你的机器上
- 无云服务、无遥测、无外部 API 调用
- **MCP 服务自身从不调用任何 LLM**。字典抽取纯正则。host agent 可以选择性地通过 `hints` 把自己观察到的口癖也报上来——见下方 [LLM 协同学习](#llm-协同学习)。
- 不存储完整对话日志 — 仅存风格信号（以及每个 habit 最多一条 ≤60 字的用法示例，存储前会先做敏感过滤）
- 先学候选；表达模式至少实际观察 2 次、跨 2 个独立 session 才自动激活
- 自动清理过期习惯（候选 → 归档 → 删除）
- 支持中文、英文、emoji、颜文字、方言标记 — 以及给 host LLM 兜底用的 free-form `idiolect` 类型
- 内置字典覆盖四川话、粤语、东北话、上海话、闽南/台语方言标记，以及当下
  （2024–2026）的中英文网络用语。每条都打了 locale 标签，并按需配置 `avoidWhen`，
  让 agent 能区分"通用安全的口头禅"和"在正经/法律/医疗回答里必须回避的网络梗"
- 返回面向 agent 的可执行风格简报：先讲如何使用，再给当前场景相关习惯
- 支持 `interaction profile`：记录"用户喜欢 AI 如何协作"，而不是给用户贴性格标签
- 协作偏好也可以 review、forget、pin，和口癖/语气习惯一样可管理
- 提供 `get_style_memory_score` 健康评分：可用度、稳定度、新鲜度、漂移风险、过度模仿风险、是否建议重新拉 brief
- 兼容任何支持 MCP 工具的 agent
- 可固定习惯以防止自动清理
- 随时可通过 `set_learning_enabled` 暂停学习
- v2 brief 固定为六段：称呼、核心语感、口癖、标点与表情、陪伴偏好、翻车日志
- 区分模型外 `hook` 与 agent 的 `full`/`event`/`off` 策略，默认 runtime 只有 3 个工具
- brief 使用持久 `revision`，按 capsule/delta/ack 增量返回

## 安装

### 本地安装

```bash
git clone https://github.com/hexingyuofficial/style-memory-mcp.git
cd style-memory-mcp
npm install
npm run build
```

### 全局安装（可选）

```bash
npm install -g style-memory-mcp
# 之后可直接使用: style-memory-mcp
```

本地开发模式：

```bash
npm run dev
```

## MCP 客户端配置

添加到你的 MCP 客户端配置中（如 Claude Desktop、Cursor 等）：

```json
{
  "mcpServers": {
    "style-memory": {
      "command": "node",
      "args": ["/绝对路径/style-memory-mcp/dist/server.js"]
    }
  }
}
```

接入细节见 [docs/INTEGRATION.zh-CN.md](docs/INTEGRATION.zh-CN.md)，里面包含通用 MCP 配置、豆包接入备忘，以及长聊天自动重新对齐协议。

真实使用方式见 [docs/USER-GUIDE.zh-CN.md](docs/USER-GUIDE.zh-CN.md)。

可以自定义 JSON 存储位置：

```json
{
  "mcpServers": {
    "style-memory": {
      "command": "node",
      "args": ["/绝对路径/style-memory-mcp/dist/server.js"],
      "env": {
        "STYLE_MEMORY_PATH": "/绝对路径/style-memory.json"
      }
    }
  }
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `STYLE_MEMORY_PATH` | `~/.style-memory-mcp/style-memory.json` | JSON 存储文件路径 |
| `STYLE_MEMORY_MIN_PROMOTE_COUNT` | `2` | 兼容层习惯激活所需观察次数；语义表达还必须跨 2 个独立 session |
| `STYLE_MEMORY_CANDIDATE_TTL_DAYS` | `30` | 候选习惯多少天不用后删除 |
| `STYLE_MEMORY_INACTIVE_TTL_DAYS` | `180` | 活跃习惯多少天不用后归档 |
| `STYLE_MEMORY_MAX_BRIEF_ITEMS` | `8` | 旧版 brief 上限；v2 的表达模式/称呼上限更严格 |
| `STYLE_MEMORY_MAX_EXAMPLE_LEN` | `60` | 单个 habit 存储的用法示例最大字符数 |
| `STYLE_MEMORY_LEARNING` | `on` | 设为 `off` 暂停学习 |
| `STYLE_MEMORY_DICTIONARY_PATH` | 未设置 | 自定义风格词典 JSON 路径 |

自定义词典可以用数组，或 `{ "habits": [...] }`：

```json
{
  "habits": [
    {
      "kind": "catchphrase",
      "text": "妙啊",
      "locale": "zh-CN",
      "confidenceDelta": 0.14,
      "useWhen": ["casual_chat"],
      "avoidWhen": ["formal_writing", "high_stakes_advice"],
      "match": "substring"
    },
    {
      "kind": "idiolect",
      "text": "ship it",
      "locale": "en",
      "match": "word"
    }
  ]
}
```

## 工具

默认聊天连接只暴露 3 个 runtime 工具：

- `bootstrap_style_memory`：开始 session，返回 `channel`、`policy`、`revision`、首个 capsule 和一次性初始化状态。
- `observe_style_event`：提交最新一条用户消息和紧凑语义 hint；成功时只返回 ack，不返回完整 store。
- `get_style_brief`：首次返回 capsule；已知 revision 过期时返回短 delta；revision 未变时只返回 ack。

观察有两个通道：宿主支持模型外 hook 时逐消息观察，不产生模型工具调用；没有 hook 时使用 agent 通道，冷启动精确统计用 `full`，记忆成熟后用 `event`，只读复用用 `off`。bootstrap 会明确返回通道与策略。

设置 `STYLE_MEMORY_TOOLSET=admin` 才启用管理/诊断面。它包含兼容入口 `observe_user_message`、完整结构化 brief、list/review/pin/forget、称呼管理、翻车日志管理、评分、status，以及 `distill_recent_style`。

全新空 store 第一次 bootstrap 会请求一次初始化。有历史读取能力的宿主可在本地查看最近 30 天、最多 12 个 session，再只提交有限的声线汇总、由明确反馈支持的回复偏好、具体协作偏好和最多 3 个表达候选。原始消息、session 标题、身份/称呼、私人事实、翻车规则和未知字段会在协议入口被拒绝。宿主无法读取历史时提交 `action: "skip"`，之后不再重复提示。

`distill_recent_style` 每次最多接收 3 个候选。初始化和蒸馏中的每个候选都只贡献一次低权重观察，仍需 2 次观察、跨 2 个独立 session 才能激活表达模式；它不接受批量 count，也不会立即 active。它与经过用户确认的协作偏好蒸馏是两条不同路径。

## Agent 使用说明

在你的 agent 或 skill 中添加类似以下内容：

```text
使用 style-memory-mcp 仅用于轻量级对话风格。
每个新 session 首轮实质回复前调用 bootstrap_style_memory，并读取返回 capsule。
若 bootstrap 请求初始化，在宿主本地查看最近 30 天、最多 12 个 session，只提交脱敏后的结构化汇总；无法读取历史则提交 action=skip。
按照 bootstrap 返回的 hook/agent 通道与 full/event/off 策略执行 observe_style_event，
每次只提交最新用户消息。用已知 revision 调用 get_style_brief；ack 时不要重复注入正文。
revision 变化后先使用 delta，并在重要回复前刷新完整 capsule。
长聊天兜底刷新不早于 30 个用户回合，也可在话题大切换、长回答前或用户说"感觉飘了"时刷新。
如果你注意到内置字典覆盖不到的个人化口癖，把带 behaviorSummary、functions、
variationPolicy 的紧凑 hints[] 放进同一次事件调用。
表达模式需要实际观察 2 次且跨 2 个 session 才自动激活。
不得从 assistant 输出、文档示例、环境文本或工具结果推断用户称呼。
不要传入密码、私人记忆、文件或完整对话日志。
轻度参考返回的风格提示。形成 agent 自己稳定的协作风格，不要机械模仿用户。
```

完整范本见 `examples/agent-instruction.md`。

## Interaction profile：协作偏好层

`style-memory-mcp` 不做性格画像。它可以学习的是更具体、更安全、更可执行的协作偏好：

- "用户喜欢先结论后细节"
- "用户做技术任务时喜欢计划 → 实现 → 验证"
- "用户喜欢先判断值不值得做，再进入步骤"
- "用户不喜欢空泛夸奖，希望建议具体"

不要写入这类内容：

- "用户很焦虑"
- "用户是内向人格"
- "用户有某种心理问题"
- "用户的真实身份、住址、工作、私人事实"

Host agent 可以在 `observe_style_event`（或 admin 兼容入口）里附带 `profileHints`：

```jsonc
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

也可以用 `distill_interaction_profile` 一次性写入 1–8 条高置信度协作偏好。它们会和口癖/语气 habit 一起进入 `get_style_brief`，但 brief 仍然保持短小，只返回当前场景相关内容。

如果协作偏好学错了，用 `forget_interaction_preference` 删除；如果某条偏好很重要，用 `pin_interaction_preference` 固定；定期用 `review_interaction_profile` 查看是否需要清理。

## 漂移与重新对齐

MCP 服务不能主动把 brief 推进宿主 agent 的上下文。跨 session 的自动启动必须依赖持久 MCP 配置、固定的绝对 `STYLE_MEMORY_PATH` 和宿主全局 agent 指令；对齐仍要由宿主调用：

- 新聊天开始时调用 `get_style_brief`
- 长聊天兜底不早于每 30 个用户回合重新调用一次
- 话题/场景大切换后重新调用
- 长回答或重要回答前重新调用
- 用户说"感觉飘了""重新对齐一下""不像我"时立即重新调用

也可以调用 `get_style_memory_score` 看健康评分。如果 `briefRefreshRecommended` 是 `true`，下一次重要回复前应该重新调用 `get_style_brief`。

## 只读复用与重启

MCP 进程通常由宿主 agent 启动和重启，`style-memory-mcp` 自身不需要也不应该强行自重启。真正持久的是 JSON store：只要多个会话使用同一个 `STYLE_MEMORY_PATH`，重启后仍会读到同一份风格记忆。

如果你已经学够了，想让它只负责"接住风格"而不是继续学习，可以：

1. 保持同一个 `STYLE_MEMORY_PATH`。
2. 在新会话开头调用 `get_style_brief`。
3. 通过 `set_learning_enabled(false)` 或 `STYLE_MEMORY_LEARNING=off` 暂停继续学习。
4. 需要重新学习时再打开 learning。

这样体验上就是：同一个 agent 或新会话都能读到风格，但不会每次都继续写入新习惯。

## LLM 协同学习

字典抽取只认硬编码的内容（川渝方言、常见中英文口头禅、颜文字等），作者没想到的——尤其是让一个人之所以听起来像 ta 自己的**个人化习惯**——它统统看不见。

`style-memory-mcp` 不引入 LLM 依赖也能解决这个问题：**反正 host agent 每条用户消息都要读一遍来生成回复，让它顺手把观察一起报上来即可。** MCP 服务器自己就保持"计数器 + 生命周期 + 安全校验"的薄层定位，零 API key、零网络、零模型、零成本。

```jsonc
// observe_style_event 输入
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

实际提交 2 次、且跨 ≥2 个不同 `sessionId` 之后，"莫" 才会被升级为 `active`，并可在后续 brief 出现。最终计数和激活门槛由 MCP 执行，host 的 confidence 不能替代这些观察。

需要 session 末蒸馏候选时，在 admin 工具面调用 `distill_recent_style`，每次最多提交 3 条低权重观察；它不绕过激活门槛。

让这套设计安全的护栏：

- MCP 自己**仍然**不调 LLM——只是把 host 报上来的东西记账。"无网络"仍然成立。
- 不合法的 `kind` 或空 `text` 直接被丢弃，不会污染 store。
- Example 走 `sanitizeExample`：空白折叠、长度截断、敏感内容（密码、token）自动丢弃。
- 两次累积 + 跨 session 的升级规则保证：单次 LLM 幻觉的 hint 进不了 active 集合。
- 所有已有的控制项（`forget_style_habit`、`pin_style_habit`、`set_learning_enabled`）继续生效。

## 清理规则

服务器不需要后台常驻进程。清理在 MCP 启动和工具调用时触发。

默认行为：

- 候选习惯：30 天未使用 → 删除
- 活跃习惯：180 天未使用 → 归档
- 已归档习惯：从最后一次出现起满 360 天 → 删除
- 已固定的表达模式：永不自动删除
- 称呼、明确陪伴偏好和翻车日志不参与表达模式 TTL；主动 forget 立即删除

重要：习惯只会在用户再次说出时刷新。agent 的使用不会保持习惯活跃，防止系统陷入自我模仿循环。

## 示例 JSON

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

## v2 brief 与称呼边界

正常 v2 capsule 按以下顺序渲染，空段省略：

1. `称呼`：分别渲染 `user→assistant` 和 `assistant→user`。前者固定标注“只识别，勿反称”，只表示用户如何叫 agent；后者才是 agent 可以如何称呼用户。两个方向同一 literal 也拥有独立 id、状态、证据和摘要，单方向 confirm/correct/forget/archive/pin 不影响另一方向。每方向 store 最多 6 个，brief 最多 2 个，典型只放 1 个。
2. `核心语感`：只表达用户的 observedVoice，例如表达长度、正式度和 expressiveness。
3. `口癖`：主记录是 `ExpressionPattern` 的行为摘要、功能和变体边界，具体文字通常只作为一个例子。策略只有 `exact_only`、`same_family`、`open_variation`；store 最多 12 个未固定 active，brief 典型 2 个、硬上限 5 个。
4. `标点与表情`：特殊字符原样保留，例如 `。。。`、`...`、`……`、`?!`、`？！`、`~~`。
5. `陪伴偏好`：单独记录 agent 的 responsePreferences；用户说得短，不等于 agent 必须短。数值始终带固定语义标签，例如“回复长度=3/5（正常展开）”。
6. `翻车日志`：只记录用户明确反馈的禁止重复规则，不从沉默或一次缺席推断。

表达模式使用 candidate → active → archived → deleted 生命周期，TTL 默认分别为 30/180/360 天；archived 的 360 天从最后一次出现计算。pinned 不自动清理，用户主动 forget 立即生效。容量为未固定 active/candidate/archived = 12/24/24，总安全上限 64，超限使用确定性排序并报告容量状态。

## 升级与回滚

已有安装应通过带明确 `installRoot` 和固定 `storePath` 的安装器 wrapper 执行 `node scripts/install-or-upgrade.mjs`。安装器会先构建/校验，将新运行时放入版本目录，备份 v1 store 和宿主配置，原子迁移并切换稳定 launcher，再通过 server/store 版本握手确认。并发安装由锁拒绝；构建、迁移、配置、切换、启动或握手任一步失败都会返回机器可读的 rollback，并恢复旧 runtime、store 和宿主文件。

安装器不会扫描或猜测任意宿主路径。要跨 session 复用，必须保留持久 MCP 配置、全局 agent 指令和同一个绝对 `STYLE_MEMORY_PATH`。完整 E01–E10 命令、fixture 和结果见 [`docs/V0.5.0-EVIDENCE.zh-CN.md`](docs/V0.5.0-EVIDENCE.zh-CN.md)。

## 开发

`v0.5.0` 的加固问题、记忆结构、可重复实验和发布门槛记录在
[`docs/V0.5.0-HARDENING-PLAN.zh-CN.md`](docs/V0.5.0-HARDENING-PLAN.zh-CN.md)。
该版本只在全部必须实验通过后才视为完成。
详细执行顺序见 [`docs/V0.5.0-EXECUTION-PLAN.zh-CN.md`](docs/V0.5.0-EXECUTION-PLAN.zh-CN.md)，
新实施窗口可直接使用 [`docs/V0.5.0-IMPLEMENTATION-PROMPT.zh-CN.md`](docs/V0.5.0-IMPLEMENTATION-PROMPT.zh-CN.md)。

```bash
# 安装依赖
npm install

# 类型检查
npm run check

# 构建
npm run build

# 运行测试
npm test

# 开发模式（tsx 热重载）
npm run dev
```

## 字典体积 & token 成本

内置字典（方言、口头禅、网络用语）住在 `src/extract.ts` 里，**永远不会**
被发给 LLM。它们只参与本地 `text.includes()` / 正则扫描。字典翻一倍，每次
对话也是零额外 token。

真正会进入宿主 LLM 上下文的包括：

1. 首次 capsule 和后续 delta。v2 brief 按六段顺序组织；典型每个称呼方向 1 个、口癖 2 个，硬上限分别为每方向 2 个和表达模式 5 个。
2. 工具描述、schema、调用参数和工具返回。默认 runtime 只有 3 个紧凑 schema，admin schema 按需启用。

capsule 会留在后续模型输入中，必须在真实 token 报告里重复计入；revision 未变时 ack 不追加正文。当前环境没有目标模型 tokenizer 或 API usage，因此不能把字符数冒充 E06 的模型 token 结果，限制和可复现命令见 [`docs/V0.5.0-TOKEN-REPORT.zh-CN.md`](docs/V0.5.0-TOKEN-REPORT.zh-CN.md)。

所以如果你的方言或网络用语没被覆盖，请大胆提 PR 加新条目 —— 只会提升召回率，
不会让任何人的 prompt 变长。

## 隐私

这个项目刻意在数据处理上保持"无聊"：

- 存储风格信号，而非原始消息。
- 自动避免从明显的密码/密钥上下文中学习。
- 独立的 JSON 存储，与任何用户记忆数据库分离。
- 用户可随时列出、删除、固定或禁用学习。
- 无网络调用。所有操作在本地完成。

## 贡献

欢迎贡献！尤其欢迎：

- 新增方言标记（粤语、上海话、东北话等）
- 任何语言的新口头禅模式
- 更好的敏感内容检测启发式
- 性能优化

如果是个人化的、字典抽不到的口癖，**不需要改字典**——直接让 agent 通过 `hints` 上报即可（见上方 [LLM 协同学习](#llm-协同学习)）。字典里加东西适合"绝大多数中国人都会这么说"这种共通模式。

添加新的提取规则时请同步添加测试。参考 `src/extract.test.ts` 和 `src/memory.test.ts`。

## 开源协议

MIT
