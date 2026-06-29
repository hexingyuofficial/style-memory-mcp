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
- 先学候选，重复出现再升级为活跃习惯
- 升级时还要求该习惯出现在**≥2 个不同的 context 标签**下（借鉴 nuwa-skill 的跨域验证）
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
| `STYLE_MEMORY_MIN_PROMOTE_COUNT` | `3` | 习惯被观察到多少次后升级为活跃 |
| `STYLE_MEMORY_CANDIDATE_TTL_DAYS` | `30` | 候选习惯多少天不用后删除 |
| `STYLE_MEMORY_INACTIVE_TTL_DAYS` | `180` | 活跃习惯多少天不用后归档 |
| `STYLE_MEMORY_MAX_BRIEF_ITEMS` | `8` | 风格简报最多返回多少条 |
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

### `observe_user_message`

从用户的最新消息中学习轻量级风格信号。

Agent 应在用户消息后调用此工具，但**不要**传入密码、私人记忆或完整对话日志。

可以选择性附带 `hints` 数组和 `profileHints` 数组 — 见下方 [LLM 协同学习](#llm-协同学习) 和 [Interaction profile](#interaction-profile协作偏好层)。

### `get_style_brief`

返回纯文本风格简报供 agent 轻度参考。

Agent 应在对话开始前或写友好回复前调用此工具。

### `get_style_brief_structured`

返回 JSON，适合需要结构化数据的 agent：

- `brief`：可直接放入 agent 上下文的文本简报
- `habits`：结构化风格习惯
- `interactionProfile`：结构化协作偏好
- `profileNudge`：当已有较多稳定风格习惯但还没有稳定协作偏好时，给 host agent 的轻提醒；否则为 `null`

### `distill_recent_style`

批量、用户背书的蒸馏入口。Host LLM 一次性提交 3–8 条从最近消息蒸馏出的高置信度观察，每条直接成为 `active`。适合冷启动时给一份"起手种子"，或用户明确说"好好学一下我说话的样子"时调用。

### `distill_interaction_profile`

批量写入具体协作偏好，例如"喜欢先判断值不值得做，再给步骤"、"技术任务喜欢计划 → 实现 → 验证"。不要提交性格、心理状态、人格类型或诊断标签。

### `list_style_habits`

列出所有候选、活跃和已归档的习惯。

### `list_interaction_profile`

列出已存储的协作偏好。

### `review_style_habits`

返回一份简短的审查队列，给每条习惯建议 `keep`、`pin`、`forget` 或 `observe`。适合用户定期看看 MCP 到底学了什么。

### `review_interaction_profile`

返回协作偏好的审查队列，给每条偏好建议 `keep`、`pin`、`forget` 或 `observe`。

### `forget_style_habit`

通过 id 或确切文本删除一个习惯。

### `forget_interaction_preference`

通过 id 或确切文本删除一个协作偏好。

### `pin_style_habit`

固定（或取消固定）一个习惯，防止被自动清理。

### `pin_interaction_preference`

固定（或取消固定）一个协作偏好，防止被自动清理。

### `set_learning_enabled`

开启或关闭风格学习。

### `get_style_memory_score`

给当前风格记忆打分，返回可用度、稳定度、新鲜度、漂移风险、过度模仿风险、是否建议重新调用 `get_style_brief`，以及简短建议。

### `get_style_memory_status`

显示 JSON 存储路径和习惯统计信息。

## Agent 使用说明

在你的 agent 或 skill 中添加类似以下内容：

```text
使用 style-memory-mcp 仅用于轻量级对话风格。
对话开始时调用 get_style_brief。
每次用户消息后调用 observe_user_message，仅传入最新消息。
长聊天里每 12-20 个用户回合静默重新调用 get_style_brief；
话题大切换、长回答前，或者用户说"感觉飘了""重新对齐一下"时也重新调用。
如果你注意到内置字典大概率覆盖不到的个人化口癖
（比如自创句尾助词、罕见句式结构），把它放进同一次调用的 hints[] 数组里。
"跨 2 个 context + 累计 3 次"才会被升为稳定习惯，
所以你不需要一次就抓对——三次后会自动学到。
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

Host agent 可以在 `observe_user_message` 里附带 `profileHints`：

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

MCP 服务不能主动把 brief 推进宿主 agent 的上下文。自动重新对齐要靠宿主 agent 按固定节奏调用：

- 新聊天开始时调用 `get_style_brief`
- 长聊天每 12–20 个用户回合重新调用一次
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
// observe_user_message 输入
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

观察到 3 次、且跨 ≥2 个不同的 `context` 标签之后，"莫" 就会被升级为 `active`，并在下次 `get_style_brief` 时连同 example 一起被返回。高置信度（≥~0.71）的 hint 跳过跨 context 检查。

需要一次性蒸馏批量种子时，调用 `distill_recent_style` 提交 3–8 条从最近消息蒸馏的观察。

让这套设计安全的护栏：

- MCP 自己**仍然**不调 LLM——只是把 host 报上来的东西记账。"无网络"仍然成立。
- 不合法的 `kind` 或空 `text` 直接被丢弃，不会污染 store。
- Example 走 `sanitizeExample`：空白折叠、长度截断、敏感内容（密码、token）自动丢弃。
- 三次累积 + 跨 context 的升级规则保证：单次 LLM 幻觉的 hint 进不了 active 集合。
- 所有已有的控制项（`forget_style_habit`、`pin_style_habit`、`set_learning_enabled`）继续生效。

## 清理规则

服务器不需要后台常驻进程。清理在 MCP 启动和工具调用时触发。

默认行为：

- 候选习惯：30 天未使用 → 删除
- 活跃习惯：180 天未使用 → 归档
- 已归档习惯：再 180 天 → 删除
- 已固定的习惯：永不自动删除

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

## 开发

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

真正会进入宿主 LLM 上下文的只有两处：

1. `get_style_brief` 输出 — 由 `STYLE_MEMORY_MAX_BRIEF_ITEMS`（默认 8）硬上限保护。
   brief 只挑**用户实际用过、且已经升级为 active 的习惯**，不是字典里有什么就吐什么。
2. 工具描述 — 写死在 `server.ts`，跟字典大小无关。

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
