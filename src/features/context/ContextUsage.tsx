// Per-session context occupancy line shown directly above the composer,
// bottom-right. Derivation lives in contextUsageLogic.ts (pure, tested);
// this component only renders the state for the session it is given, so
// switching sessions re-derives from the new session's own messages.
// No IPC: the parent passes session and model in.
import {
  compactionDisplay,
  computeContextUsage,
  contextUsageAria,
  formatContextUsage,
  usagePercent,
} from "./contextUsageLogic";
import type { Model, Session } from "../../types";

const cx = (...v: (string | false | undefined)[]) =>
  v.filter(Boolean).join(" ");

export function ContextUsage({
  session,
  model,
}: {
  session: Pick<Session, "messages" | "compaction">;
  model?: Model;
}) {
  const state = computeContextUsage(session, model);
  const compaction = compactionDisplay(session.compaction);
  const percent = usagePercent(state);
  return (
    <div className="context-usage-row">
      {/* The live region stays mounted so a later compaction change is
          announced instead of appearing as an already-changed node. */}
      <span
        className="context-compaction-slot"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {compaction && (
          <span
            className={cx("context-compaction", compaction.tone)}
            title={compaction.title}
          >
            {compaction.text}
          </span>
        )}
      </span>
      <span
        className={cx("context-usage", state.quality, state.stale && "stale")}
        title={state.detail}
        aria-label={contextUsageAria(state)}
      >
        {percent !== null && (
          <span className="context-usage-meter" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
        <span className="context-usage-text">{formatContextUsage(state)}</span>
      </span>
    </div>
  );
}
