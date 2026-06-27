# Changelog

All notable changes to style-memory-mcp will be documented in this file.

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
  fields are filled in safely. All 36 v0.1 tests continue to pass; 20 new
  tests cover the new paths.

## [0.1.0] — 2024-06-27

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
- Comprehensive test suite (36 tests covering extract, memory, cleanup, sensitivity)
- Configurable via environment variables
- Pre-compiled English catchphrase regexes for performance
- Error handling on all MCP tool handlers (try/catch with MCP isError response)
- JSON corruption recovery (SyntaxError → fresh store; structural validation)
- Archived habit deletion after 360 days inactivity
