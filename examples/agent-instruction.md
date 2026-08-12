# Agent Instruction

Use `style-memory-mcp` only as a lightweight local conversational style layer. It is not a personality profile or a source of private facts.

## Session and observation protocol

- At the start of every session, call `bootstrap_style_memory` with `channel: "agent"`, `policy: "full"`, and a fresh meaningless short `sessionId` when the host does not provide a model-external hook (including OpenCode); read its capsule before the first substantive reply. Do not omit these arguments on such hosts, because the server's default store channel may be `hook`.
- If the first bootstrap returns `initialization.status: "pending"` with `requested: true`, inspect at most 12 sessions from the last 30 days using host-local history access. Call bootstrap once more with only aggregate `observedVoice`, response preferences backed by explicit user feedback, concrete `profileHints`, and at most 3 `expressionHints`. Never submit raw messages, session titles, names, addresses, private facts, files, or failure rules. If history is unavailable, submit `{ "initialization": { "action": "skip" } }` so the request is not repeated.
- Follow the returned `channel` and `policy`:
  - `hook`: the host observes each committed user message outside the model tool loop;
  - `agent/full`: call `observe_style_event` for each committed user message during cold start;
  - `agent/event`: call it only for explicit feedback, corrections, likely known patterns, new examples, or special expressions;
  - `agent/off`: read-only; do not learn or apply feedback.
- Outside the bounded initialization aggregate, send only the latest user message. Never send secrets, files, private memories, or full conversation history.
- Keep `sessionId` short and meaningless. Do not use a chat title or identity as evidence.
- Keep the returned `revision`. A revision-unchanged `get_style_brief` response is only an ack; use a delta after a revision change.
- Request a full capsule for correction, context compression, or when a delta cannot be followed independently. A long-chat fallback refresh is not earlier than 30 user turns.

The default runtime tool set is `bootstrap_style_memory`, `observe_style_event`, and `get_style_brief`. The admin-only
`observe_user_message` is a compatibility path and is not the default daily protocol.

## Semantic hints and explicit feedback

Use `profileHints` only for concrete preferences about how the user wants the agent to collaborate. Do not infer response length or warmth from the user's message length or tone.

Good examples:

```json
{
  "category": "response_structure",
  "text": "prefers the conclusion before detailed reasoning",
  "useWhen": ["technical_chat"],
  "confidence": 0.8
}
```

Use `hints` for distinctive user expression signals that are present in the current message. The server can record low-level
`kind + literal`; provide `behaviorSummary`, `functions`, and `variationPolicy` only when the behavior is actually supported by
explicit feedback, an existing pattern, or a compact host observation. Do not guess a psychological meaning from one symbol.

For address hints, bind the hint to the current user message and set `sourceRole` to `user`. Keep the directions separate:

- `user→assistant` means how the user addresses the agent. Recognize it, but never use it to address the user.
- `assistant→user` is allowed only after the user explicitly asks/confirms that form, or repeatedly and unambiguously says the agent may use it.

Quoted, negated, hypothetical, third-party, document, environment, tool, and assistant-generated text is not address evidence.

## Brief semantics

The brief has six ordered sections: addresses; observed voice; expression patterns; punctuation and expression markers;
response preferences; and confirmed failure rules. Numeric values always carry a fixed semantic label, such as
`回复长度=3/5（正常展开）`; never expose a bare score or use `temperature` as emotion.

Expression patterns are behavior-first records with `kind`, `behaviorSummary`, `functions`, and one of
`exact_only`, `same_family`, or `open_variation`. Examples are evidence, not scripts. Use a pattern naturally, usually 0-1 per reply;
do not mechanically repeat the latest literal or use playful style in serious contexts.

Normal expression patterns need two observations across two sessions to become active. Initialization and the admin-only
`distill_recent_style` accepts at most three low-weight candidates; each contributes once and does not bypass that gate.

## User corrections

When the user says:

- “感觉飘了” / “重新对齐一下”: call `get_style_brief` before the next substantive reply.
- “以后别这样” / “这个不是我的风格”: use the relevant admin forget tool or record a confirmed failure rule.
- “这个固定下来”: use the relevant admin pin tool.
- “看看我现在学了什么”: use the admin list/review tools.
- “先别继续学习”: call `set_learning_enabled(false)`.
- “重新打开学习”: call `set_learning_enabled(true)`.

Never treat absence from one message as negative evidence. Explicit feedback wins, and a same-turn correction must not be re-learned from that message.
