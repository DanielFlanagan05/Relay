// Pure derivation of per-session context occupancy from telemetry the harness
// already reports. No IPC, no module state: callers pass the session and its
// active model, so switching sessions can never carry values across (each call
// derives only from the given session).
//
// Semantics (LOCAL_AGENT_UTILIZATION.md "Fixes applied"):
// - Context used = the context retained for the next request: the last
//   request's input including cached input where the harness reports it
//   (`usage.contextInput`), NOT cumulative turn/lifetime billing totals
//   (`turnUsage`).
// - Context available = the active model's context window capacity.
// - Absent telemetry stays absent. An unknown value is reported as
//   unavailable, never as zero.

import type { Message, Model, Session } from "../../types";

export type ContextQuality = "measured" | "estimated" | "unavailable";

export type ContextUsageState = {
  used: number | null;
  available: number | null;
  quality: ContextQuality;
  // A measured value is stale when a newer user message is not part of the
  // request that produced it (it under-counts until the next usage report).
  stale: boolean;
  detail: string;
};

export type CompactionDisplay = {
  text: string;
  title: string;
  tone: "running" | "done" | "failed";
};

const measuredNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

// Rough heuristic used only when the harness reports no context count at all.
export const CHARS_PER_TOKEN = 4;

// The most recent per-request context count the harness actually reported.
// `usage.contextInput` is only ever set from per-request telemetry
// (electron/protocol.mjs); turn-scope totals deliberately lack it.
export function lastContextMeasurement(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && measuredNumber(m.usage?.contextInput))
      return { tokens: m.usage!.contextInput as number, index: i };
  }
  return null;
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}

// Lower-bound estimate of retained context from what is visible in the
// transcript: message content and thinking, tool records, and the instruction
// snapshot frozen for the latest user turn (older snapshots are no longer
// re-injected). The harness system prompt and its own tool schemas remain
// invisible, so this is always labelled approximate and may under-count.
export function estimateRetainedTokens(messages: Message[]): number | null {
  if (!messages?.length) return null;
  let chars = 0;
  for (const m of messages) {
    if (!m) continue;
    chars += textLength(m.content);
    chars += textLength(m.thinking);
    for (const t of m.tools || [])
      chars +=
        textLength(t.name) + textLength(t.input) + textLength(t.output) + 8;
  }
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  for (const h of lastUser?.hookSnapshot || [])
    chars += textLength(h.content) + textLength(h.name) + 8;
  if (chars <= 0) return null;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function computeContextUsage(
  session: Pick<Session, "messages">,
  model?: Model,
): ContextUsageState {
  const messages = session?.messages || [];
  const available =
    measuredNumber(model?.context) && (model?.context as number) > 0
      ? model?.context
      : null;
  const measurement = lastContextMeasurement(messages);
  if (measurement) {
    // Anything the user added after the measured request is not in it yet.
    const stale = messages
      .slice(measurement.index + 1)
      .some((m) => m?.role === "user");
    return {
      used: measurement.tokens,
      available,
      quality: "measured",
      stale,
      detail:
        "Measured context input of the last request, cached input included, " +
        "as reported by the harness. Not a cumulative token total." +
        (stale
          ? " Your newest message is not counted yet; this updates when the current turn reports usage."
          : ""),
    };
  }
  const estimate = estimateRetainedTokens(messages);
  if (estimate !== null && estimate > 0)
    return {
      used: estimate,
      available,
      quality: "estimated",
      stale: false,
      detail:
        "Estimated from the visible conversation (content, thinking, tool " +
        "records and the latest instruction snapshot, ~4 characters per " +
        "token). This harness reports no per-request context count; the " +
        "system prompt and harness-side content are invisible to Relay, so " +
        "the real occupancy is likely higher.",
    };
  return {
    used: null,
    available,
    quality: "unavailable",
    stale: false,
    detail: messages.length
      ? "No context measurement is available for this session yet."
      : "Nothing has been sent in this session. Context occupancy appears after the first turn.",
  };
}

export const formatTokens = (n: number) => n.toLocaleString("en-US");

export function formatContextUsage(state: ContextUsageState): string {
  const used =
    state.used === null
      ? "—"
      : `${state.quality === "estimated" ? "~" : ""}${formatTokens(state.used)}`;
  const available =
    state.available === null ? "—" : formatTokens(state.available);
  return `${used} / ${available} tokens`;
}

export function contextUsageAria(state: ContextUsageState): string {
  const capacity =
    state.available === null
      ? "context limit unknown"
      : `of ${formatTokens(state.available)} tokens`;
  if (state.used === null) return `Context usage unavailable ${capacity}.`;
  if (state.quality === "estimated")
    return `Approximately ${formatTokens(state.used)} tokens used ${capacity}, estimated. Not exact.`;
  return (
    `${formatTokens(state.used)} tokens used ${capacity}, measured` +
    (state.stale ? ". Last measurement predates your newest message." : ".")
  );
}

export function usagePercent(state: ContextUsageState): number | null {
  if (state.used === null || state.available === null || !state.available)
    return null;
  return Math.min(100, Math.max(0, (state.used / state.available) * 100));
}

// Compaction status. Set only from an explicit Session.compaction field, which
// in turn is written only from a verifiable harness event (today: Pi's
// compaction_start/compaction_end via electron/protocol.mjs). A token-count
// decrease alone is never treated as compaction.
export function compactionDisplay(
  compaction?: { status: string; at: string } | null,
): CompactionDisplay | null {
  if (!compaction) return null;
  const at = compaction.at ? new Date(compaction.at).toLocaleString() : "";
  if (compaction.status === "running")
    return {
      text: "Compacting context…",
      title: "Waiting for the harness to confirm compaction",
      tone: "running",
    };
  if (compaction.status === "done")
    return {
      text: "Context compacted",
      title: at ? `Last compaction: ${at}` : "Context compacted",
      tone: "done",
    };
  if (compaction.status === "failed")
    return {
      text: "Compaction failed",
      title: at
        ? `The compaction attempt at ${at} failed. Context was not reduced.`
        : "The compaction attempt failed. Context was not reduced.",
      tone: "failed",
    };
  // An unrecognised status is not proof of anything; show nothing.
  return null;
}
