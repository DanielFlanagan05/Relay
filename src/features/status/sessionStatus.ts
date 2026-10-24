// Renderer-local, pure session status + delegation opt-in rules.
//
// Design rules (keep them when extending):
//   1. Every reported state must come from a field the backend actually writes
//      (`session.status`, `session.queueReason`, `session.error`, a delegation
//      round record, or a task record). Never infer a state from silence,
//      timing, or a missing delta: report `unknown` instead.
//   2. Nothing here measures tokens, rates, or hardware. C owns usage/rate
//      accounting; this module only phrases lifecycle.
//   3. No React, DOM, or IPC imports: scripts/ux-smoke.mjs and
//      tests/session_status.test.mjs transpile this file and assert on it.
//   4. Wording must agree with the backend gate in electron/service.mjs
//      (`delegationGate`) so the UI never promises more than the service does.

export const ROUND_TERMINAL = ["complete", "failed", "canceled", "interrupted"];

/** Structural view of electron/delegation.mjs round records already present in the snapshot. */
export type DelegationRound = {
  id: string;
  parentSessionId: string;
  parentAnswerId?: string;
  status: string;
  round?: number;
  calls?: number;
  children?: string[];
  waitingOn?: string[];
  waitUntil?: number;
  error?: string;
  endedAt?: string;
};

export type TaskLike = {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  status: string;
  objective?: string;
};

export type SessionLike = {
  id?: string;
  status?: string;
  queueReason?: string;
  error?: string;
  harness?: string;
  taskId?: string;
  archived?: boolean;
  delegation?: boolean;
};

export type SessionStatusState =
  | "idle"
  | "queued"
  | "loading"
  | "running"
  | "waiting_children"
  | "failed"
  | "stopped"
  | "interrupted"
  | "unknown";

export type SessionStatus = {
  state: SessionStatusState;
  /** Short label for a status pill. */
  label: string;
  /** Why the session is in this state. "" when there is nothing truthful to say. */
  reason: string;
  /** The user's next move. Never an automatic action. "" when none applies. */
  action: string;
  /** Drives colour only: neutral | progress | warning | danger. */
  tone: "neutral" | "progress" | "warning" | "danger";
  /** Animated indicator. */
  spin: boolean;
  /** Counts as in-flight for busy/active filters and input locking. */
  active: boolean;
};

const text = (value: unknown, max = 300): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const terminal = (status?: string) => ROUND_TERMINAL.includes(status || "");

/** Newest non-terminal round for a session, falling back to the newest round. */
export const roundFor = <T extends DelegationRound>(
  sid: string | undefined,
  rounds: T[] = [],
): T | undefined => {
  if (!sid) return undefined;
  const own = rounds.filter((r) => r && r.parentSessionId === sid);
  return (
    [...own].reverse().find((r) => !terminal(r.status)) || own[own.length - 1]
  );
};

export const openRoundFor = <T extends DelegationRound>(
  sid: string | undefined,
  rounds: T[] = [],
): T | undefined => {
  if (!sid) return undefined;
  return rounds
    .filter((r) => r && r.parentSessionId === sid && !terminal(r.status))
    .pop();
};

const waitingReason = (
  round: DelegationRound | undefined,
  tasks: TaskLike[],
): string => {
  const ids = Array.isArray(round?.waitingOn) ? round.waitingOn : [];
  const open = ids.filter((id) => {
    const task = tasks.find((t) => t.id === id);
    return !task || !terminal(task.status);
  }).length;
  const finished = tasks.filter(
    (t) => ids.includes(t.id) && terminal(t.status),
  ).length;
  // Mirrors electron/delegation.mjs park(): the parent is queued with its slot released.
  if (!ids.length)
    return "Resuming with delegated results; waiting for an inference slot.";
  return `${open} delegated task(s) still running and the inference slot is released${
    finished ? `; ${finished} of ${ids.length} finished` : ""
  }.`;
};

/**
 * Single source of truth for "what is this session doing right now".
 * `round` comes from `openRoundFor(...)`; `tasks` are that round's tasks.
 */
export const deriveSessionStatus = ({
  session,
  round,
  tasks = [],
}: {
  session?: SessionLike;
  round?: DelegationRound;
  tasks?: TaskLike[];
}): SessionStatus => {
  const unknown: SessionStatus = {
    state: "unknown",
    label: "Unknown",
    reason: "",
    action: "",
    tone: "neutral",
    spin: false,
    active: false,
  };
  if (!session || typeof session.status !== "string") return unknown;
  const base = { ...unknown, reason: text(session.queueReason) };

  const waitingView = (): SessionStatus => ({
    ...base,
    state: "waiting_children",
    label: "Waiting for children",
    reason: waitingReason(round, tasks),
    action: "Stop the agent to take over the turn yourself.",
    tone: "progress",
    spin: true,
    active: true,
  });
  // The round record is the durable proof of a parked turn. A parked parent is
  // queued with its slot released, but between releasing the slot and being
  // re-queued it can read idle while its children are still running.
  if (
    round?.status === "waiting" &&
    ["idle", "queued"].includes(session.status)
  )
    return waitingView();

  switch (session.status) {
    case "idle":
      return {
        ...base,
        state: "idle",
        label: "Ready",
        reason: "",
        action: "",
      };
    case "queued":
      return {
        ...base,
        state: "queued",
        label: "Queued",
        reason: base.reason || "Waiting for an inference slot on this model.",
        action: "",
        tone: "progress",
        spin: true,
        active: true,
      };
    case "loading":
      return {
        ...base,
        state: "loading",
        label: "Loading model",
        // Keeps the wording the previous hard-coded notice showed the user.
        reason:
          base.reason ||
          "Preparing shared model runtime. Other sessions will reuse this instance.",
        action: "",
        tone: "progress",
        spin: true,
        active: true,
      };
    case "running":
      return {
        ...base,
        state: "running",
        label: round && !terminal(round.status) ? "Delegating" : "Generating",
        reason:
          round && !terminal(round.status)
            ? `Experimental tool-driven delegation, round ${round.round || 1}.`
            : "",
        action: "",
        tone: "progress",
        spin: true,
        active: true,
      };
    case "stopped":
      return {
        ...base,
        state: "stopped",
        label: "Stopped",
        reason: base.reason || "You stopped this turn.",
        action:
          "Nothing is replayed automatically; send a new message to retry.",
        tone: "warning",
      };
    case "error":
      return {
        ...base,
        state: "failed",
        label: "Failed",
        reason:
          text(session.error) || base.reason || "The turn did not finish.",
        action: "Review the details, then edit your last request.",
        tone: "danger",
      };
    case "interrupted":
      return {
        ...base,
        // Only the store writes this, on a real restart mid-turn. Never inferred.
        state: "interrupted",
        label: "Interrupted",
        reason: base.reason || "The app closed during this turn.",
        action:
          "Send a new message to continue. Tools already run are not replayed.",
        tone: "warning",
      };
    default:
      return { ...unknown, reason: base.reason };
  }
};

/** Sidebar one-liner: the same label the header pill shows, from the same rules. */
export const statusLabelFor = (
  session?: SessionLike,
  rounds: DelegationRound[] = [],
  tasks: TaskLike[] = [],
): string =>
  deriveSessionStatus({
    session,
    round: openRoundFor(session?.id, rounds),
    tasks,
  }).label;

export type DelegationOptIn = {
  available: boolean;
  enabled: boolean;
  /** Why it is unavailable, or what enabling it does. Always shown as a title. */
  reason: string;
  label: string;
};

/**
 * Mirrors `delegationGate` in electron/service.mjs. The UI hides or disables
 * the control for the same reasons the backend rejects the patch, and never
 * advertises delegation on a native harness route.
 */
export const delegationOptIn = ({
  session,
  busy = false,
}: {
  session?: SessionLike;
  busy?: boolean;
}): DelegationOptIn => {
  const enabled = session?.delegation === true;
  const label = "Experimental delegation";
  if (!session)
    return { available: false, enabled, label, reason: "No session selected." };
  if (session.taskId)
    return {
      available: false,
      enabled,
      label,
      reason:
        "A delegated child cannot delegate. Its own children would be untracked.",
    };
  if (session.harness !== "direct")
    return {
      available: false,
      enabled,
      label,
      reason:
        "Tool-driven delegation is currently supported only on Direct chat endpoints. Native harness delegation is not verified; use the Delegate action there.",
    };
  if (session.archived)
    return {
      available: false,
      enabled,
      label,
      reason: "Restore this session to change delegation.",
    };
  if (busy)
    return {
      available: false,
      enabled,
      label,
      // Exact backend text (delegationGate) so parity holds character for character.
      reason:
        "Stop the current turn before changing delegation for this session",
    };
  return {
    available: true,
    enabled,
    label,
    reason:
      "Let this Direct-chat agent request bounded read-only child tasks (delegate, task_status, wait_for_tasks, cancel_task). Experimental: not qualified with a live model. Disabled by default.",
  };
};

/** Round/task counts for the task panel header; measured records only. */
export const taskCounts = (tasks: TaskLike[] = []) => ({
  total: tasks.length,
  open: tasks.filter((t) => !terminal(t.status)).length,
  finished: tasks.filter((t) => terminal(t.status)).length,
});
