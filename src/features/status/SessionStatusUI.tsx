// Status presentation for one session, driven only by deriveSessionStatus().
// Kept separate from App.tsx so the lifecycle rules stay testable and the
// shared-file diff small. No IPC calls: the parent passes snapshot data in.
import {
  Activity,
  Hourglass,
  Layers,
  LoaderCircle,
  ShieldCheck,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  delegationOptIn,
  deriveSessionStatus,
  type DelegationRound,
  type SessionStatus,
  type TaskLike,
} from "./sessionStatus";
import type { Session } from "../../types";

const cx = (...v: (string | false | undefined)[]) =>
  v.filter(Boolean).join(" ");

/** Compact pill for the session header / task cards. Colour is never the only signal. */
export function StatusPill({
  status,
  fallback = "idle",
}: {
  status: SessionStatus;
  fallback?: string;
}) {
  return (
    <span
      className={cx(
        "state-label",
        status.state === "unknown" ? fallback : status.state,
      )}
      title={[status.label, status.reason].filter(Boolean).join(" — ")}
    >
      <span />
      {status.label}
    </span>
  );
}

/**
 * One notice bar above the composer for every non-ready state. Replaces the
 * previous per-status branches so a new lifecycle state cannot go unreported.
 * Returns null for idle and for genuinely unknown data (never a guess).
 */
export function StatusNotice({
  status,
  children,
}: {
  status: SessionStatus;
  children?: ReactNode;
}) {
  if (status.state === "idle" || status.state === "unknown") return null;
  const Icon =
    status.state === "waiting_children"
      ? Hourglass
      : status.state === "queued"
        ? Layers
        : status.state === "stopped" || status.state === "interrupted"
          ? Square
          : status.tone === "danger"
            ? Activity
            : LoaderCircle;
  return (
    <div className={cx("queue-notice", `state-${status.state}`)} role="status">
      <Icon
        size={16}
        className={status.spin ? "spin" : ""}
        aria-hidden="true"
      />
      <span>
        <strong>{status.label}</strong>
        {status.reason ? ` · ${status.reason}` : ""}
        {status.action ? ` ${status.action}` : ""}
        {children}
      </span>
    </div>
  );
}

/**
 * The experimental Direct-chat delegation switch. Availability and wording come
 * from the same rule the backend gate uses, so the control cannot offer more
 * than `delegationGate` accepts. Off by default; hidden reason always visible.
 */
export function DelegationToggle({
  session,
  busy = false,
  rounds = [],
  tasks = [],
  update,
}: {
  session: Session;
  busy?: boolean;
  rounds?: DelegationRound[];
  tasks?: TaskLike[];
  update: (patch: Record<string, unknown>) => void;
}) {
  const gate = delegationOptIn({ session, busy });
  const open = rounds.filter(
    (r) => r.parentSessionId === session.id && r.status === "waiting",
  ).length;
  const active = gate.enabled;
  const counts = tasks.filter((t) => t.parentSessionId === session.id).length;
  return (
    <label
      className={cx(
        "delegation-toggle",
        active && "on",
        !gate.available && "locked",
      )}
      title={gate.reason}
    >
      <input
        type="checkbox"
        aria-label="Experimental tool-driven delegation for this Direct chat session"
        checked={active}
        disabled={!gate.available}
        onChange={(e) => update({ delegation: e.target.checked })}
      />
      <ShieldCheck size={13} aria-hidden="true" />
      <span>
        {active ? "Delegation on" : "Delegation"}
        <em>experimental</em>
        {!!counts && ` · ${counts} task${counts === 1 ? "" : "s"}`}
        {!!open && " · waiting"}
      </span>
    </label>
  );
}

export { deriveSessionStatus };
