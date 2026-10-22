import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import type { Hook, Session, Snapshot } from "../../types";

export function SkillSelector({
  session,
  data,
  notify,
}: {
  session: Session;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("session");
  const [query, setQuery] = useState("");
  const [resolved, setResolved] = useState<{
    skills: Hook[];
    warnings: string[];
    estimatedTokens: number;
  }>();
  const [pending, setPending] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popover.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    let current = true;
    window.relay
      .call<typeof resolved>("effectiveSkills", { sid: session.id })
      .then((value) => {
        if (current) setResolved(value);
      })
      .catch((e) => notify(e.message));
    return () => {
      current = false;
    };
  }, [
    session.id,
    JSON.stringify([
      session.hookIds,
      session.nextTurnHookIds,
      session.disabledNextTurnHookIds,
      session.outputFormat,
      data.hooks,
      session.permission,
    ]),
  ]);
  const checked = (id: string) =>
    scope === "session"
      ? session.hookIds.includes(id)
      : !session.disabledNextTurnHookIds.includes(id) &&
        (session.hookIds.includes(id) || session.nextTurnHookIds.includes(id));
  async function toggle(id: string) {
    setPending(true);
    const patch =
      scope === "session"
        ? {
            hookIds: checked(id)
              ? session.hookIds.filter((h) => h !== id)
              : [...session.hookIds, id],
          }
        : {
            nextTurnHookIds: checked(id)
              ? session.nextTurnHookIds.filter((h) => h !== id)
              : [...new Set([...session.nextTurnHookIds, id])],
            disabledNextTurnHookIds: checked(id)
              ? [...new Set([...session.disabledNextTurnHookIds, id])]
              : session.disabledNextTurnHookIds.filter((h) => h !== id),
          };
    try {
      await window.relay.call("updateSession", { sid: session.id, patch });
    } catch (e) {
      notify((e as Error).message);
    }
    setPending(false);
  }
  return (
    <div className="relative skill-control" ref={popover}>
      <button
        className="hook-selector has-hooks"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={14} />
        {resolved?.skills.length || 0} active instructions
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="popover hooks-popover"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <div className="skill-toolbar">
            <select
              aria-label="Instruction scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="session">This session</option>
              <option value="turn">Next turn only</option>
            </select>
            <input
              aria-label="Find instructions"
              placeholder="Find a skill…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="skill-choices">
            {data.hooks
              .filter((h) =>
                `${h.name} ${h.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((h) => {
                const unavailable = (h.requires || []).includes("delegation");
                return (
                  <button
                    key={h.id}
                    disabled={pending || unavailable}
                    title={
                      unavailable
                        ? "Agent-callable delegation is unavailable on this route"
                        : undefined
                    }
                    onClick={() => toggle(h.id)}
                    aria-pressed={checked(h.id)}
                  >
                    <span
                      className={`checkbox ${checked(h.id) ? "checked" : ""}`}
                    >
                      {checked(h.id) && <Check size={11} />}
                    </span>
                    <span>
                      <strong>{h.name}</strong>
                      <small>
                        {unavailable
                          ? "Requires supported delegation tools"
                          : h.description}
                      </small>
                    </span>
                  </button>
                );
              })}
          </div>
          <details className="effective-instructions">
            <summary>
              Effective instructions · ~{resolved?.estimatedTokens || 0} tokens
            </summary>
            {resolved?.skills.map((h) => (
              <section key={h.id}>
                <strong>
                  {h.name} · v{h.revision} · {h.scope}
                </strong>
                <small>
                  {h.source || h.origin} · {h.contentHash?.slice(0, 10)}
                </small>
                <p>{h.content}</p>
              </section>
            ))}
            {resolved?.warnings.map((warning) => (
              <p className="skill-warning" key={warning}>
                {warning}
              </p>
            ))}
            <p>
              Relay sends these instructions with the next request. Harness
              instructions still apply. Changes do not erase prior conversation
              context.
            </p>
          </details>
          <p>Next-turn overrides clear when a message is sent.</p>
          <button className="done-button" onClick={() => setOpen(false)}>
            Done
            <Check size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
