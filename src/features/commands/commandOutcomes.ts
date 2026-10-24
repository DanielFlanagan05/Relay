// Pure logic for native slash-command outcomes (phase 2): outcomes are
// recorded on the session separately from chat messages and rendered as a
// small derived transcript block. Nothing here mutates data or reaches the
// backend; see electron/piCommands.mjs for execution.

export type CommandOutcome = {
  command: string;
  status: string; // "ok" | "failed" (and future values render generically)
  at: string;
  reason?: string;
  summary?: string;
};

// The newest recorded outcome, or null when the session has none.
export function latestOutcome(
  log: CommandOutcome[] | undefined | null,
): CommandOutcome | null {
  if (!Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry && typeof entry.command === "string") return entry;
  }
  return null;
}

// One line of human-facing text for the transcript block.
export function outcomeLine(entry: CommandOutcome): string {
  const label = `/${entry.command}`;
  if (entry.status === "ok")
    return entry.summary?.trim() || `${label} completed.`;
  return entry.reason?.trim() || `${label} did not complete (${entry.status}).`;
}

// Outcomes are system records, never chat messages: render only when the
// newest entry is recent enough to inform the current view.
export const OUTCOME_FRESH_MS = 10 * 60 * 1000;

export function outcomeVisible(
  entry: CommandOutcome | null,
  nowMs: number,
  freshMs = OUTCOME_FRESH_MS,
): boolean {
  if (!entry) return false;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return false;
  return Math.abs(nowMs - at) <= freshMs;
}
