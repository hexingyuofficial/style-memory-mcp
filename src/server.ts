#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addFailureRule,
  archiveAddress,
  bootstrapStyleMemory,
  confirmAddress,
  distillInteractionProfile,
  distillRecentStyle,
  forgetAddress,
  forgetFailureRule,
  forgetInteractionPreference,
  forgetStyleHabit,
  getStyleBrief,
  getStyleBriefEnvelope,
  getStyleBriefStructured,
  getStyleMemoryScore,
  listAddresses,
  listFailureRules,
  listInteractionProfile,
  listStyleHabits,
  observeUserMessage,
  pinAddress,
  pinInteractionPreference,
  pinStyleHabit,
  reviewInteractionProfile,
  reviewStyleHabits,
} from "./memory.js";
import type { AddressDirection, AgentObservationPolicy, InitializationInput, ObservationChannel } from "./types.js";
import { withStoreMutation } from "./store.js";

const SERVER_VERSION = "0.6.0";
const RUNTIME_TOOLS = ["bootstrap_style_memory", "observe_style_event", "get_style_brief"] as const;
const ENABLE_ADMIN = process.env.STYLE_MEMORY_TOOLSET === "admin"
  || process.env.STYLE_MEMORY_ENABLE_ADMIN === "1";

const server = new McpServer({
  name: "style-memory-mcp",
  version: SERVER_VERSION,
});

type TextResponse = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function safeHandler<T>(fn: () => Promise<T>): Promise<TextResponse> {
  return fn().then((value) => jsonResult(value)).catch(errorResult);
}

function safeTextHandler(fn: () => Promise<string>): Promise<TextResponse> {
  return fn().then((value) => textResult(value)).catch(errorResult);
}

const HABIT_KIND = z.enum([
  "catchphrase", "dialect_marker", "emoji", "punctuation", "tone", "language_mix",
  "sentence_final_particle", "structure", "idiolect",
]);
const ADDRESS_DIRECTION = z.enum(["user→assistant", "assistant→user"]);
const CHANNEL = z.enum(["hook", "agent"]);
const POLICY = z.enum(["full", "event", "off"]);

const HINT_SCHEMA = z.object({
  kind: HABIT_KIND,
  text: z.string().min(1).max(40),
  example: z.string().max(120).optional(),
  useWhen: z.array(z.string().max(40)).max(8).optional(),
  avoidWhen: z.array(z.string().max(40)).max(8).optional(),
  behaviorSummary: z.string().max(160).optional(),
  functions: z.array(z.string().max(32)).max(5).optional(),
  variationPolicy: z.enum(["exact_only", "same_family", "open_variation"]).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional(),
  sourceRole: z.enum(["user", "assistant", "system", "tool"]).optional(),
  addressFrom: z.enum(["user", "assistant"]).optional(),
  addressTo: z.enum(["user", "assistant"]).optional(),
  affectSummary: z.string().max(48).optional(),
  usageSummary: z.string().max(48).optional(),
});

const PROFILE_CATEGORY = z.enum([
  "response_structure", "collaboration", "explanation", "decision_making", "workflow", "tone_boundary",
]);
const PROFILE_HINT_SCHEMA = z.object({
  category: PROFILE_CATEGORY,
  text: z.string().min(1).max(120),
  example: z.string().max(120).optional(),
  useWhen: z.array(z.string().max(40)).max(8).optional(),
  avoidWhen: z.array(z.string().max(40)).max(8).optional(),
  notes: z.string().max(160).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional(),
  explicit: z.boolean().optional(),
  preferenceField: z.enum(["replyVerbosity", "warmth", "initiative"]).optional(),
  value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
});
const ADDRESS_HINT_SCHEMA = z.object({
  text: z.string().min(1).max(48),
  from: z.enum(["user", "assistant"]),
  to: z.enum(["user", "assistant"]),
  sourceRole: z.literal("user"),
  currentMessage: z.string().min(1).max(4000),
  usageSummary: z.string().max(48).optional(),
  affectSummary: z.string().max(48).optional(),
  useWhen: z.array(z.string().max(24)).max(3).optional(),
  explicit: z.boolean().optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional(),
});
const FEEDBACK_SCHEMA = z.object({
  kind: z.enum(["address", "expression", "response_preference", "failure"]),
  action: z.enum(["confirm", "correct", "forget", "pin", "archive", "set"]),
  idOrText: z.string().max(160).optional(),
  direction: ADDRESS_DIRECTION.optional(),
  text: z.string().max(160).optional(),
  rule: z.string().max(160).optional(),
  field: z.string().max(40).optional(),
  value: z.number().int().min(1).max(5).optional(),
});
const INITIALIZATION_EXPRESSION_SCHEMA = z.object({
  kind: HABIT_KIND,
  text: z.string().min(1).max(40),
  example: z.string().max(120).optional(),
  useWhen: z.array(z.string().max(40)).max(8).optional(),
  avoidWhen: z.array(z.string().max(40)).max(8).optional(),
  behaviorSummary: z.string().min(1).max(160),
  functions: z.array(z.string().min(1).max(32)).min(1).max(5),
  variationPolicy: z.enum(["exact_only", "same_family", "open_variation"]),
  confidence: z.number().min(0).max(1).optional(),
}).strict();
const INITIALIZATION_PROFILE_SCHEMA = z.object({
  category: PROFILE_CATEGORY,
  text: z.string().min(1).max(120),
  useWhen: z.array(z.string().max(40)).max(8).optional(),
  avoidWhen: z.array(z.string().max(40)).max(8).optional(),
  notes: z.string().max(160).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();
const INITIALIZATION_SCHEMA = z.object({
  action: z.enum(["complete", "skip"]),
  lookbackDays: z.number().int().min(1).max(30).optional(),
  sessionCount: z.number().int().min(1).max(12).optional(),
  observedVoice: z.object({
    verbosity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    formality: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    expressiveness: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    rhythm: z.string().max(80).optional(),
    expressionDensity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    punctuation: z.object({
      baseStyle: z.enum(["minimal", "standard", "expressive", "ellipses"]).optional(),
      literalPatterns: z.array(z.string().min(1).max(12)).max(3).optional(),
    }).strict().optional(),
  }).strict().optional(),
  responsePreferences: z.array(z.object({
    field: z.enum(["replyVerbosity", "warmth", "initiative"]),
    value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    evidence: z.literal("explicit_feedback"),
  }).strict()).max(3).optional(),
  profileHints: z.array(INITIALIZATION_PROFILE_SCHEMA).max(6).optional(),
  expressionHints: z.array(INITIALIZATION_EXPRESSION_SCHEMA).max(3).optional(),
}).strict();

const OBSERVE_SCHEMA = {
  text: z.string().min(1).max(4000),
  context: z.string().max(80).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional(),
  channel: CHANNEL.optional(),
  policy: POLICY.optional(),
  hints: z.array(HINT_SCHEMA).max(8).optional(),
  profileHints: z.array(PROFILE_HINT_SCHEMA).max(6).optional(),
  addressHints: z.array(ADDRESS_HINT_SCHEMA).max(6).optional(),
  feedback: FEEDBACK_SCHEMA.optional(),
};

server.registerTool(
  "bootstrap_style_memory",
  {
    title: "Bootstrap style memory",
    description: "Start a session and return the compact style capsule. On a fresh store it requests one-time initialization from sanitized host-local session aggregates.",
    inputSchema: {
      channel: CHANNEL.optional(),
      policy: POLICY.optional(),
      sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional(),
      initialization: INITIALIZATION_SCHEMA.optional(),
    },
  },
  async ({ channel, policy, sessionId, initialization }) =>
    safeHandler(() => bootstrapStyleMemory(
      channel as ObservationChannel | undefined,
      policy as AgentObservationPolicy | undefined,
      sessionId,
      initialization as InitializationInput | undefined,
    )),
);

server.registerTool(
  "observe_style_event",
  {
    title: "Observe style event",
    description: "Submit only the latest user message and compact semantic hints; normal success returns an ack, not the store.",
    inputSchema: OBSERVE_SCHEMA,
  },
  async ({ text, context, sessionId, channel, policy, hints, profileHints, addressHints, feedback }) =>
    safeHandler(async () => {
      const result = await observeUserMessage(text, context, hints, profileHints, {
        sessionId,
        channel,
        policy,
        addressHints,
        feedback,
      });
      return result.ack ?? { ok: 1, refresh: 0, revision: 0, channel: channel ?? "agent", policy: policy ?? "event" };
    }),
);

server.registerTool(
  "get_style_brief",
  {
    title: "Get style brief",
    description: "Return a capsule on first use, a compact delta after a revision change, or an ack when unchanged.",
    inputSchema: {
      context: z.string().max(80).optional(),
      knownRevision: z.number().int().min(0).optional(),
    },
  },
  async ({ context, knownRevision }) => safeHandler(() => getStyleBriefEnvelope(context, knownRevision)),
);

if (ENABLE_ADMIN) registerAdminTools();

function registerAdminTools() {
  server.registerTool(
    "observe_user_message",
    {
      title: "Observe user message (admin)",
      description: "Compatibility/admin form of observe_style_event; returns the complete observation result.",
      inputSchema: OBSERVE_SCHEMA,
    },
    async ({ text, context, sessionId, channel, policy, hints, profileHints, addressHints, feedback }) =>
      safeHandler(() => observeUserMessage(text, context, hints, profileHints, { sessionId, channel, policy, addressHints, feedback })),
  );
  server.registerTool(
    "get_style_brief_structured",
    {
      title: "Get structured style brief",
      description: "Return full structured memory for administration and diagnostics.",
      inputSchema: { context: z.string().max(80).optional(), knownRevision: z.number().int().min(0).optional() },
    },
    async ({ context, knownRevision }) => safeHandler(() => getStyleBriefStructured(context, knownRevision)),
  );
  server.registerTool(
    "distill_recent_style",
    {
      title: "Distill recent style",
      description: "Admin-only session-end path for up to three low-weight qualitative candidates; it does not bypass activation gates.",
      inputSchema: { habits: z.array(HINT_SCHEMA).min(1).max(3) },
    },
    async ({ habits }) => safeHandler(() => distillRecentStyle(habits)),
  );
  server.registerTool(
    "distill_interaction_profile",
    {
      title: "Distill interaction profile",
      description: "Write concrete collaboration preferences after explicit review.",
      inputSchema: { preferences: z.array(PROFILE_HINT_SCHEMA).min(1).max(8) },
    },
    async ({ preferences }) => safeHandler(() => distillInteractionProfile(preferences)),
  );
  server.registerTool("list_style_habits", { title: "List style habits", description: "List compatibility habits.", inputSchema: {} }, async () => safeHandler(async () => ({ habits: await listStyleHabits() })));
  server.registerTool("list_interaction_profile", { title: "List interaction profile", description: "List collaboration preferences.", inputSchema: {} }, async () => safeHandler(async () => ({ preferences: await listInteractionProfile() })));
  server.registerTool(
    "review_style_habits",
    { title: "Review style habits", description: "Return a review queue.", inputSchema: { limit: z.number().int().min(1).max(50).default(12) } },
    async ({ limit }) => safeHandler(() => reviewStyleHabits(limit)),
  );
  server.registerTool(
    "review_interaction_profile",
    { title: "Review interaction profile", description: "Return a profile review queue.", inputSchema: { limit: z.number().int().min(1).max(50).default(12) } },
    async ({ limit }) => safeHandler(() => reviewInteractionProfile(limit)),
  );
  server.registerTool(
    "forget_style_habit",
    { title: "Forget style habit", description: "Delete a compatibility habit.", inputSchema: { idOrText: z.string().min(1) } },
    async ({ idOrText }) => safeHandler(async () => ({ removed: await forgetStyleHabit(idOrText) })),
  );
  server.registerTool(
    "forget_interaction_preference",
    { title: "Forget interaction preference", description: "Delete a collaboration preference.", inputSchema: { idOrText: z.string().min(1) } },
    async ({ idOrText }) => safeHandler(async () => ({ removed: await forgetInteractionPreference(idOrText) })),
  );
  server.registerTool(
    "pin_style_habit",
    { title: "Pin style habit", description: "Pin or unpin a compatibility habit.", inputSchema: { idOrText: z.string().min(1), pinned: z.boolean().default(true) } },
    async ({ idOrText, pinned }) => safeHandler(async () => ({ updated: await pinStyleHabit(idOrText, pinned) })),
  );
  server.registerTool(
    "pin_interaction_preference",
    { title: "Pin interaction preference", description: "Pin or unpin a preference.", inputSchema: { idOrText: z.string().min(1), pinned: z.boolean().default(true) } },
    async ({ idOrText, pinned }) => safeHandler(async () => ({ updated: await pinInteractionPreference(idOrText, pinned) })),
  );
  server.registerTool(
    "set_learning_enabled",
    { title: "Set learning enabled", description: "Enable or disable learning.", inputSchema: { enabled: z.boolean() } },
    async ({ enabled }) => safeHandler(async () => withStoreMutation((store) => { store.settings.allowLearning = enabled; return { allowLearning: enabled }; })),
  );
  server.registerTool("get_style_memory_score", { title: "Get style memory score", description: "Score memory quality.", inputSchema: {} }, async () => safeHandler(() => getStyleMemoryScore()));
  server.registerTool(
    "get_style_memory_status",
    { title: "Get style memory status", description: "Return a machine-readable runtime/store handshake and memory counts.", inputSchema: {} },
    async () => safeHandler(async () => withStoreMutation((store) => ({
      serverVersion: SERVER_VERSION,
      storeVersion: store.version,
      runtimePath: process.env.STYLE_MEMORY_RUNTIME_PATH ?? process.argv[1] ?? "",
      dataPath: store.settings.dataPath,
      channel: store.settings.observationChannel,
      policy: store.settings.agentPolicy,
      runtimeTools: [...RUNTIME_TOOLS],
      adminEnabled: ENABLE_ADMIN,
      allowLearning: store.settings.allowLearning,
      habits: store.habits.length,
      active: store.habits.filter((habit) => habit.status === "active").length,
      candidates: store.habits.filter((habit) => habit.status === "candidate").length,
      archived: store.habits.filter((habit) => habit.status === "archived").length,
      expressionPatterns: store.profile.expressionPatterns.length,
      activeExpressionPatterns: store.profile.expressionPatterns.filter((item) => item.status === "active").length,
      profilePreferences: store.profile.preferences.length,
      activeProfilePreferences: store.profile.preferences.filter((item) => item.status === "active").length,
      lastCleanupAt: store.lastCleanupAt,
    }))),
  );
  server.registerTool(
    "list_addresses",
    { title: "List addresses", description: "List direction-scoped address memory.", inputSchema: { direction: ADDRESS_DIRECTION.optional() } },
    async ({ direction }) => safeHandler(() => listAddresses(direction as AddressDirection | undefined)),
  );
  server.registerTool(
    "manage_address",
    { title: "Manage address", description: "Confirm, forget, pin, or archive one direction-scoped address.", inputSchema: { direction: ADDRESS_DIRECTION, idOrText: z.string().min(1), action: z.enum(["confirm", "forget", "pin", "unpin", "archive"]) } },
    async ({ direction, idOrText, action }) => safeHandler(async () => {
      if (action === "confirm") return { updated: await confirmAddress(direction, idOrText) };
      if (action === "forget") return { updated: await forgetAddress(direction, idOrText) };
      if (action === "pin" || action === "unpin") return { updated: await pinAddress(direction, idOrText, action === "pin") };
      return { updated: await archiveAddress(direction, idOrText) };
    }),
  );
  server.registerTool(
    "list_failure_rules",
    { title: "List failure rules", description: "List explicit do-not-repeat rules.", inputSchema: {} },
    async () => safeHandler(async () => ({ rules: await listFailureRules() })),
  );
  server.registerTool(
    "add_failure_rule",
    { title: "Add failure rule", description: "Record an explicit correction rule.", inputSchema: { rule: z.string().min(1).max(160) } },
    async ({ rule }) => safeHandler(async () => ({ rule: await addFailureRule(rule) })),
  );
  server.registerTool(
    "forget_failure_rule",
    { title: "Forget failure rule", description: "Delete an explicit correction rule.", inputSchema: { idOrText: z.string().min(1) } },
    async ({ idOrText }) => safeHandler(async () => ({ removed: await forgetFailureRule(idOrText) })),
  );
}

function jsonResult(value: unknown): TextResponse {
  return textResult(JSON.stringify(value, null, 2));
}

function textResult(text: string): TextResponse {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): TextResponse {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[style-memory-mcp] Tool error:", message);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
