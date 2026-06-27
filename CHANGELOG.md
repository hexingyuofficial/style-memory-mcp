# Changelog

All notable changes to style-memory-mcp will be documented in this file.

## [0.4.0] — 2026-06-27

### Added

- **Expanded dialect coverage** — `src/extract.ts` now ships markers for
  Cantonese (`zh-CN-cantonese`), Northeast Mandarin (`zh-CN-dongbei`),
  Shanghainese (`zh-CN-shanghai`), and Min Nan / Taiwanese
  (`zh-TW-minnan`) alongside the original Sichuan set.
- **Current internet slang** — new `ZH_INTERNET_SLANG` and
  `EN_INTERNET_SLANG` arrays cover 2024–2026 web register
  (`yyds`, `绝绝子`, `家人们`, `bet`, `no cap`, `it's giving`, etc.).
  Tagged with locale `zh-CN-internet` / `en-internet` so the agent can
  tell universally-safe phrases apart from slang that must be avoided
  in legal / medical / serious-debugging replies.
- **English slang word-boundary matching** — internet-slang regexes use
  the same `\b`-anchored compilation as catchphrases, so `bet` does not
  match `better`, `ate` does not match `atelier`, `mid` does not match
  `midnight`.

### Changed

- **High-conviction hint bypass tightened** — a hint with self-rated
  confidence ≥ ~0.71 still bypasses the cross-context promote gate,
  but now also requires `seenCount ≥ HIGH_CONVICTION_MIN_SEEN` (2).
  A single overconfident LLM call can no longer promote a habit to
  `active` on first sighting; the three-strike safety net is restored.

### Safety

- New internet-slang entries carry per-entry `avoidWhen` lists — the
  collector does not flatten them to a generic default. Phrases like
  `yyds`, `栓Q`, `老登`, `mid`, `delulu` will not bleed into formal,
  legal, medical, or user-upset contexts.

## [0.3.0] — 2026-06-27

### Added

- **Interaction profile management tools** — new
  `review_interaction_profile`, `forget_interaction_preference`, and
  `pin_interaction_preference` tools so collaboration preferences can be
  reviewed, removed, or pinned just like style habits.
- **Style memory health score** — new `get_style_memory_score` tool returns
  readiness, stability, freshness, drift risk, over-imitation risk,
  `briefRefreshRecommended`, counts, and actionable recommendations.
- **Integration guide** — new `docs/INTEGRATION.zh-CN.md` documents generic
  MCP setup, Doubao-style setup notes, shared JSON store usage, and the
  automatic brief refresh protocol.
- **User guide** — new `docs/USER-GUIDE.zh-CN.md` explains natural commands
  such as "感觉飘了", "以后别这样", "这个固定下来", and "打个分".

### Changed

- Agent instruction template now tells host agents to refresh
  `get_style_brief` every 12–20 user turns in long chats, after context
  switches, before important long answers, and whenever the user says the
  style feels off.
- README files now document interaction-profile correction, health scoring,
  drift refresh behavior, and the distinction between stable assistant style
  alignment and mechanical user imitation.
- Package metadata now includes the `docs` directory and aligns the package,
  lockfile, and MCP server version at `0.3.0`.

### Safety

- The new profile-management tools keep the same boundary: local JSON only,
  no network, no LLM calls inside the MCP server, no full conversation logs,
  and no personality/psychology/diagnosis labels.

## [0.2.0] — 2026-06-27

### Added

- **LLM-assisted idiolect learning** — `observe_user_message` now accepts an
  optional `hints` array. The host LLM (which already reads every user
  message) can flag personal habits the built-in dictionary would miss
  (self-invented sentence-final particles, unusual structures, private
  emoji habits). The MCP itself still does NOT call any LLM and makes no
  network requests.
- **New tool `distill_recent_style`** — batched, user-endorsed seeding. The
  host LLM submits 3–8 high-conviction observations distilled from recent
  messages; each habit is promoted to `active` immediately. Useful for
  warm-starting a fresh store or deepening style coverage on demand.
- **Three new `HabitKind` values**: `sentence_final_particle`, `structure`,
  `idiolect` — to give LLM-reported observations a home that the
  dictionary path doesn't need.
- **`example` field on `StyleHabit`** — short (≤60 char) fragment from the
  user message that's included in `get_style_brief` output. Sanitized
  through `sanitizeExample` (whitespace collapse, length cap, credential
  filter); sensitive examples are dropped without dropping the habit.
- **Cross-context promote rule** — a candidate now needs `seenCount ≥
  minPromoteCount` AND to have been observed under ≥2 distinct `context`
  labels before it becomes `active`. Inspired by nuwa-skill's "appears
  across 2+ domains" check. Bypasses: distilled habits, hints with
  self-rated confidence ≥ ~0.71, and legacy callers that never supply
  `context` (so v0.1 behavior is preserved).
- **`seenContexts` field on `StyleHabit`** — tracks the distinct context
  labels that have triggered the habit. Capped at 8.
- **`source` field on `StyleHabit`** — provenance tag (`rule` / `hint` /
  `distill`); purely informational, no behavioral split.
- **`STYLE_MEMORY_MAX_EXAMPLE_LEN` env var** — defaults to 60.
- **`src/sensitivity.ts`** — `isSensitive` extracted from `memory.ts` and
  exported, plus new `sanitizeExample` helper. Reusable across all
  ingestion paths.

### Changed

- `observe_user_message` schema accepts up to 8 `hints` per call.
- `get_style_brief` output now embeds a habit's stored `example` on the
  line below it, so the host LLM sees usage context, not just the marker.

### Backward compatibility

- v0.1 stores load unchanged. Missing `example` / `seenContexts` / `source`
  fields are filled in safely. All previous v0.1 tests continue to pass, and
  new tests cover the added paths.

## [0.1.0] — 2026-06-27

### Added

- Initial release: local MCP server for conversational style learning
- 7 MCP tools: `observe_user_message`, `get_style_brief`, `list_style_habits`, `forget_style_habit`, `pin_style_habit`, `set_learning_enabled`, `get_style_memory_status`
- Rule-based extraction for: dialect markers (Sichuan), catchphrases (Chinese + English), emoji, kaomoji, punctuation, tone, language mixing
- Three-tier habit lifecycle: candidate → active → archived
- Auto-cleanup with configurable TTLs (candidate 30d, active→archived 180d, archived→deleted 360d)
- Pinned habits protected from auto-cleanup
- Two-pass sensitivity detection to avoid learning from credential-like messages
- Atomic JSON file writes (tmp → rename)
- Write queue to serialize concurrent saves (prevents race conditions)
- Bilingual README (English + 简体中文)
- Comprehensive test suite covering extract, memory, cleanup, sensitivity, and store
- Configurable via environment variables
- Pre-compiled English catchphrase regexes for performance
- Error handling on all MCP tool handlers (try/catch with MCP isError response)
- JSON corruption recovery (SyntaxError → fresh store; structural validation)
- Archived habit deletion after 360 days inactivity
