import type { InteractionPreference, StyleHabit } from "./types.js";

const HIGH_STAKES_CONTEXTS = new Set([
  "high_stakes_advice",
  "legal",
  "medical",
  "financial",
  "security",
  "privacy",
  "user_upset",
  "crisis",
]);

const SERIOUS_CONTEXTS = new Set([
  "serious_debugging",
  "error_report",
  "incident_response",
  "formal_writing",
  "high_stakes_advice",
  ...HIGH_STAKES_CONTEXTS,
]);

const PLAYFUL_KINDS = new Set<StyleHabit["kind"]>([
  "emoji",
  "dialect_marker",
  "catchphrase",
  "sentence_final_particle",
]);

export interface ContextDecision {
  include: boolean;
  score: number;
  reason?: string;
}

export function evaluateHabitForContext(habit: StyleHabit, context?: string): ContextDecision {
  if (!context) return { include: true, score: habit.confidence };

  const labels = expandContext(context);
  if (habit.avoidWhen.some((item) => labels.has(item))) {
    return { include: false, score: 0, reason: "avoidWhen" };
  }

  if (labels.has("high_stakes_advice") && PLAYFUL_KINDS.has(habit.kind)) {
    return { include: false, score: 0, reason: "high_stakes" };
  }

  if (labels.has("serious_context") && habit.kind === "emoji") {
    return { include: false, score: 0, reason: "serious_context" };
  }

  let score = habit.confidence;
  if (habit.useWhen.some((item) => labels.has(item))) score += 0.2;
  if (habit.seenContexts?.some((item) => labels.has(item))) score += 0.08;

  return { include: true, score };
}

export function evaluatePreferenceForContext(
  preference: InteractionPreference,
  context?: string,
): ContextDecision {
  if (!context) return { include: true, score: preference.confidence };

  const labels = expandContext(context);
  if (preference.avoidWhen.some((item) => labels.has(item))) {
    return { include: false, score: 0, reason: "avoidWhen" };
  }

  let score = preference.confidence + 0.05;
  if (preference.useWhen.some((item) => labels.has(item))) score += 0.2;
  if (preference.seenContexts?.some((item) => labels.has(item))) score += 0.08;

  return { include: true, score };
}

export function expandContext(context: string): Set<string> {
  const raw = context.trim();
  const labels = new Set<string>();
  if (!raw) return labels;

  labels.add(raw);

  const normalized = raw.toLowerCase();
  labels.add(normalized);

  if (HIGH_STAKES_CONTEXTS.has(normalized)) labels.add("high_stakes_advice");
  if (SERIOUS_CONTEXTS.has(normalized)) labels.add("serious_context");
  if (normalized.includes("debug") || normalized.includes("code")) labels.add("technical_chat");
  if (normalized.includes("formal") || normalized.includes("writing")) labels.add("formal_writing");

  return labels;
}
