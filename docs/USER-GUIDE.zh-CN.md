# style-memory-mcp 用户指南

`style-memory-mcp` 帮 agent 保持稳定的闲聊、表达和协作方式。它不是人格画像，也不是私人记忆库，MCP
本身不调用 LLM，不保存完整对话。

它可以记录：

- 用户自己的表达习惯（`observedVoice`）；
- 用户明确希望 agent 如何回应（`responsePreferences`）；
- 可以轻度参考的表达模式、标点和表达标记；
- 用户明确指出的翻车规则。

它不应记录身份、联系方式、凭据、文件内容、完整聊天记录或心理/人格诊断。

全新安装第一次启动时，宿主可以在本地总结最近 30 天、最多 12 个 session 来建立初始风格。MCP 不接收原始聊天、标题或私人事实，只接收有限的风格汇总；无法读取历史时会记录“跳过”，不反复询问。即使 store 在本地，凭据和明确 PII 仍会过滤，因为后续 brief 会进入模型上下文。

## 常用说法

你可以自然地对 agent 说：

- “感觉飘了，重新对齐一下。”
- “以后别这样。” / “这个不是我的风格，忘掉。”
- “这个固定下来。”
- “先别继续学习。” / “重新打开学习。”
- “看看你现在学了什么。” / “给风格记忆打个分。”

agent 应把这些请求映射到对应的 admin 工具：`get_style_brief`、`forget_*`、`pin_*`、
`set_learning_enabled`、`list_*`、`review_*` 和 `get_style_memory_score`。日常聊天默认只需要三个 runtime 工具。

## 六段 brief

正常 brief 按以下顺序组织，空段会省略：

1. `称呼`：分别显示 `user→assistant` 和 `assistant→user`。前者只识别用户如何叫 agent，固定标注“勿反称”；
   后者才允许 agent 称呼用户。
2. `核心语感`：描述用户自己的表达长度、正式度、表达强度和节奏。
3. `口癖`：描述表达行为和功能，原词只作为一个实际例子，不是机械复读模板。
4. `标点与表情`：描述特殊标点、emoji、颜文字和密度；`。。。`、`...`、`……`、`?!` 等按原样保存。
5. `陪伴偏好`：描述 agent 的回复长度、温度、主动延展和支持方式；用户说得短不等于 agent 必须回得短。
6. `翻车日志`：只放用户明确确认过的禁止行为，不从沉默推断。

所有 1-5 数值都带固定语义标签，例如 `回复长度=3/5（正常展开）`；brief 不输出裸分数，也不把
`temperature` 当作情绪。表达模式只在语义合适时轻度使用，通常一条回复使用 0-1 个，严肃、医疗、法律或安全场景优先清晰。

## 称呼边界

称呼有两个完全独立的方向：

- `user→assistant`：用户怎样叫 agent，只用于识别亲昵、玩笑或想拉近距离等可观察关系语境，绝不反过来叫用户；
- `assistant→user`：agent 可以怎样叫用户，只能来自用户明确要求/确认，或多次无歧义地说“你可以这样叫我”。

引用、转述、否定、反例、第三方或角色姓名、文档示例、环境文字、工具结果和 assistant 自己的输出都不是称呼证据。
同一 literal 可以在两个方向各有独立记录；对一个方向 confirm、correct、forget、archive 或 pin 不会改动另一方向。
用户→助手的 active 项必须有短的可观察语境；证据不足时只能写中性摘要，不能猜心理或人格。

每个方向最多保存 6 个称呼值，brief 最多显示 2 个，通常各显示 1 个。满容量时自动候选会被拒绝并报告状态，不会静默删除；
称呼也不参加表达模式的自动 TTL。

## 表达模式与反馈

口癖主记录是 `ExpressionPattern`，而不是 literal 清单。每项包含 `kind`、`behaviorSummary`、`functions` 和
`variationPolicy`，实际词语、笑声、emoji、颜文字或特殊标点只放在 `examples` 和证据中。

变体策略只有三种：

- `exact_only`：原样使用，适合固定口头禅和特殊标点；
- `same_family`：可换同类型、同功能、同强度的未见过表达，适合笑声、emoji 和颜文字；
- `open_variation`：只按行为摘要自然表达，仍受场景边界约束。

普通表达模式要经过至少 2 次观察、跨 2 个独立 session 才能 active；首次初始化或一次 session 末的
`distill_recent_style` 最多提交 3 个候选，每个只贡献一次低权重观察，不能批量加 count 或立即 active。
store 最多保留 12 个未固定 active 表达模式，brief 典型选 2 个，绝对最多 5 个；不会为了凑满而突破 capsule 预算。

明确反馈优先。`“这个固定下来”` 可以 pin，`“以后别这样”` 应写入翻车规则或删除相关模式；同轮被纠正的表达不会再次从同一消息学习。

## 学习、遗忘与容量

表达模式使用 `candidate → active → archived → deleted`：candidate 30 天无新证据删除，active 180 天无新证据归档，
archived 从最后出现起 360 天删除。pinned 不自动遗忘，明确 forget 立即删除；归档模式重新出现后只计算归档后的新证据，
仍需重新满足 2 次、2 session，明确确认则可立即恢复。

自动遗忘只作用于表达模式，不作用于称呼、明确陪伴偏好或翻车日志。未固定项容量为 active/candidate/archived = 12/24/24，
总安全上限为 64；超限按固定排序处理，全 protected 时拒绝自动学习并返回容量状态。

## Runtime 与 admin

默认聊天连接只暴露三个 runtime 工具：`bootstrap_style_memory`、`observe_style_event`、`get_style_brief`。
新 session 首轮实质回复前调用 bootstrap，它返回 `channel`、`policy`、`revision` 和 capsule。revision 未变时 brief 只返回紧凑 ack；
revision 变化时优先返回 delta，纠错、上下文压缩或无法独立执行时才重新返回 capsule。

若首次 bootstrap 返回 `initialization.status=pending` 且 `requested=true`，支持历史读取的宿主应在本地总结后再调用一次 bootstrap；只传结构化汇总，不传原文。没有历史访问能力则提交 `initialization.action=skip`。

观察通道和策略必须区分：

- `hook`：宿主在模型外逐消息观察，不产生模型工具调用；
- `agent/full`：没有 hook 的冷启动精确统计；
- `agent/event`：记忆成熟后，只在明确反馈、纠正、疑似已知模式、新例子或特殊表达出现时调用；
- `agent/off`：只读，不学习也不应用反馈。

bootstrap/status 会返回当前通道和策略。设置 `STYLE_MEMORY_TOOLSET=admin` 才启用兼容入口
`observe_user_message`、结构化 brief、称呼/翻车日志管理、review、score 和蒸馏工具；它不是默认 runtime 工具。

## 跨 session 与安装

跨 session 复用依赖持久 MCP 配置、固定的绝对 `STYLE_MEMORY_PATH` 和宿主全局 agent instruction。MCP 不能向未调用它的上下文主动推送 brief；
每个新 session 都要重新 bootstrap，使用无语义短 `sessionId` 区分证据。

升级应通过带明确 `installRoot` 和 `storePath` 的 `node scripts/install-or-upgrade.mjs` 完成。安装器先验证和 staging，
再备份旧 store/宿主配置，迁移并原子切换版本目录，最后做 server/store/runtime 握手。并发、构建、迁移、配置、切换、启动或握手失败时会返回
机器可读 rollback，并恢复旧 runtime、store 和宿主文件。它不会扫描或猜测任意宿主路径，也不应直接用于真实安装演练；隔离实验见
[`docs/V0.5.0-EVIDENCE.zh-CN.md`](V0.5.0-EVIDENCE.zh-CN.md)。

## 安全提示

只发送最新用户消息和必要的紧凑语义 hint，不发送秘密、文件、完整历史或私人事实。MCP 的规则提取只能给出低层
`kind + literal` 证据；行为功能和变体边界应来自明确反馈、已有模式匹配或宿主 hint，不能从一个符号猜出“害羞”等心理含义。
