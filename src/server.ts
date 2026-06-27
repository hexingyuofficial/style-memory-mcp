#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  distillRecentStyle,
  forgetStyleHabit,
  getStyleBrief,
  listStyleHabits,
  observeUserMessage,
  pinStyleHabit,
} from "./memory.js";
import { loadStore, saveStore } from "./store.js";

const server = new McpServer({
  name: "style-memory-mcp",
  version: "0.2.0",
});

/** Wrap a tool result in a safe MCP content response, catching errors. */
function safeHandler<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return fn()
    .then((value) => jsonResult(value))
    .catch(errorResult);
}

/** Wrap a text-only tool result without JSON-stringifying it. */
function safeTextHandler(
  fn: () => Promise<string>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return fn()
    .then((text) => textResult(text))
    .catch(errorResult);
}

// Shared schema for a single host-LLM observation. Reused by both
// `observe_user_message.hints` and `distill_recent_style.habits`.
const HABIT_KIND = z.enum([
  "catchphrase",
  "dialect_marker",
  "emoji",
  "punctuation",
  "tone",
  "language_mix",
  "sentence_final_particle",
  "structure",
  "idiolect",
]);

const HINT_SCHEMA = z.object({
  kind: HABIT_KIND.describe(
    "What kind of style signal you noticed. Use `idiolect` for one-off personal habits that don't fit elsewhere.",
  ),
  text: z
    .string()
    .min(1)
    .max(40)
    .describe("The marker itself, e.g. '莫', 'fr', or '(｡･ω･｡)'."),
  locale: z.string().max(40).optional(),
  example: z
    .string()
    .max(120)
    .optional()
    .describe(
      "A short fragment from the user message showing how the marker is used. Server truncates to 60 chars and drops anything sensitive.",
    ),
  useWhen: z.array(z.string().max(40)).max(8).optional(),
  avoidWhen: z.array(z.string().max(40)).max(8).optional(),
  notes: z.string().max(160).optional(),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Your 0–1 certainty this is a real personal habit."),
});

server.registerTool(
  "observe_user_message",
  {
    title: "Observe user message",
    description:
      "Learn lightweight conversational style signals from the latest user message. " +
      "Pass only the message text — not secrets, private memories, or full conversation logs. " +
      "Optionally include `hints`: things YOU (the host LLM) noticed that the built-in dictionary " +
      "wouldn't catch, such as a self-invented sentence-final particle or a unique structural quirk.",
    inputSchema: {
      text: z.string().min(1).max(4000).describe("The latest user message only."),
      context: z
        .string()
        .max(80)
        .optional()
        .describe("Short context label, such as casual_chat, technical_chat, or formal_writing."),
      hints: z
        .array(HINT_SCHEMA)
        .max(8)
        .optional()
        .describe(
          "Up to 8 personal style observations from this message. Only include things the user " +
            "actually said that look like a signature habit — if unsure, omit. Three repetitions " +
            "are required before a habit is treated as stable, so you don't need to be right on " +
            "the first try.",
        ),
    },
  },
  async ({ text, context, hints }) =>
    safeHandler(() => observeUserMessage(text, context, hints)),
);

server.registerTool(
  "get_style_brief",
  {
    title: "Get style brief",
    description:
      "Return a short style brief for the agent to use lightly. Call this at the start of a conversation or before drafting a friendly reply.",
    inputSchema: {
      context: z
        .string()
        .max(80)
        .optional()
        .describe("Short context label. Habits with matching avoidWhen will be omitted."),
    },
  },
  async ({ context }) => safeTextHandler(() => getStyleBrief(context)),
);

server.registerTool(
  "distill_recent_style",
  {
    title: "Distill recent style",
    description:
      "One-shot batched distillation: based on the user's recent ~10–20 messages, identify 3–7 " +
      "signature expressions (catchphrases, sentence-final particles, structural quirks, etc.) " +
      "and write them all at once. Treated as user-endorsed — each habit becomes active " +
      "immediately if its content passes basic checks. Use sparingly: at conversation seed-time, " +
      "or when the agent feels its style brief is too thin.",
    inputSchema: {
      habits: z
        .array(HINT_SCHEMA)
        .min(1)
        .max(8)
        .describe("3–7 high-conviction observations distilled from recent conversation."),
    },
  },
  async ({ habits }) => safeHandler(() => distillRecentStyle(habits)),
);

server.registerTool(
  "list_style_habits",
  {
    title: "List style habits",
    description: "List stored style habits and candidates from the local JSON store.",
    inputSchema: {},
  },
  async () => safeHandler(async () => ({ habits: await listStyleHabits() })),
);

server.registerTool(
  "forget_style_habit",
  {
    title: "Forget style habit",
    description: "Delete a style habit by id or exact text.",
    inputSchema: {
      idOrText: z.string().min(1).describe("Habit id or exact habit text."),
    },
  },
  async ({ idOrText }) =>
    safeHandler(async () => ({ removed: await forgetStyleHabit(idOrText) })),
);

server.registerTool(
  "pin_style_habit",
  {
    title: "Pin style habit",
    description: "Pin or unpin a style habit so cleanup will not delete it.",
    inputSchema: {
      idOrText: z.string().min(1).describe("Habit id or exact habit text."),
      pinned: z.boolean().default(true).describe("Whether the habit should be pinned."),
    },
  },
  async ({ idOrText, pinned }) =>
    safeHandler(async () => ({ updated: await pinStyleHabit(idOrText, pinned) })),
);

server.registerTool(
  "set_learning_enabled",
  {
    title: "Set learning enabled",
    description: "Enable or disable style learning in the local JSON store.",
    inputSchema: {
      enabled: z.boolean().describe("Set false to stop learning new style signals."),
    },
  },
  async ({ enabled }) =>
    safeHandler(async () => {
      const store = await loadStore();
      store.settings.allowLearning = enabled;
      await saveStore(store);
      return { allowLearning: enabled };
    }),
);

server.registerTool(
  "get_style_memory_status",
  {
    title: "Get style memory status",
    description: "Show where the local JSON store lives and how many habits are stored.",
    inputSchema: {},
  },
  async () =>
    safeHandler(async () => {
      const store = await loadStore();
      return {
        dataPath: store.settings.dataPath,
        allowLearning: store.settings.allowLearning,
        habits: store.habits.length,
        active: store.habits.filter((habit) => habit.status === "active").length,
        candidates: store.habits.filter((habit) => habit.status === "candidate").length,
        archived: store.habits.filter((habit) => habit.status === "archived").length,
        lastCleanupAt: store.lastCleanupAt,
      };
    }),
);

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[style-memory-mcp] Tool error:`, message);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
