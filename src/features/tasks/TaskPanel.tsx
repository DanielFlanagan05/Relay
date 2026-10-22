import { useState } from "react";
import type { Session, Snapshot } from "../../types";
type Call = <T = unknown>(
  name: string,
  input?: unknown,
) => Promise<T | undefined>;
const done = (status: string) =>
  ["complete", "failed", "canceled", "interrupted"].includes(status);
export function TaskPanel({
  session,
  data,
  call,
  open,
  notify,
}: {
  session: Session;
  data: Snapshot;
  call: Call;
  open: (id: string) => void;
  notify: (s: string) => void;
}) {
  const tasks = data.tasks.filter((t) => t.parentSessionId === session.id);
  const parentTask = data.tasks.find((t) => t.childSessionId === session.id);
  const [objective, setObjective] = useState(""),
    [context, setContext] = useState(""),
    [expected, setExpected] = useState(
      "A concise result with evidence and unresolved questions.",
    ),
    [scope, setScope] = useState("Read-only analysis. Do not modify files."),
    [pending, setPending] = useState(false),
    [seconds, setSeconds] = useState(600);
  return (
    <section className="task-panel">
      <h3>Delegated tasks</h3>
      {parentTask ? (
        <>
          <p>
            This is a read-only child task. Fork it to continue independently.
          </p>
          <button
            className="button"
            onClick={() => open(parentTask.parentSessionId)}
          >
            Open parent session
          </button>
          <p>{parentTask.objective}</p>
          <p>Scope: {parentTask.scope}</p>
        </>
      ) : (
        <>
          <p>
            Children share this session’s model and workspace. Each receives
            only the task context you provide and runs with read-only
            permissions.
          </p>
          {session.harness === "direct" && (
            <p className="skill-warning">
              Direct-chat children have no file tools. Include any material they
              need in the context.
            </p>
          )}
          <details className="delegate-form">
            <summary>Delegate a task</summary>
            <label>
              Objective
              <textarea
                aria-label="Child task objective"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                maxLength={4000}
              />
            </label>
            <label>
              Relevant context
              <textarea
                aria-label="Child task context"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                maxLength={20000}
              />
            </label>
            <label>
              Expected result
              <input
                aria-label="Child task expected result"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                maxLength={2000}
              />
            </label>
            <label>
              Scope
              <input
                aria-label="Child task scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                maxLength={2000}
              />
            </label>
            <label>
              Time budget (seconds)
              <input
                type="number"
                min={10}
                max={1800}
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
              />
            </label>
            <button
              className="button primary"
              disabled={
                pending ||
                !objective.trim() ||
                tasks.filter((t) => !done(t.status)).length >= 2 ||
                session.harness === "hermes" ||
                session.archived
              }
              onClick={async () => {
                setPending(true);
                const task = await call("delegate", {
                  sid: session.id,
                  task: {
                    objective,
                    context,
                    scope,
                    expectedResult: expected,
                    maxSeconds: seconds,
                  },
                });
                if (task) {
                  setObjective("");
                  notify("Read-only child task queued");
                }
                setPending(false);
              }}
            >
              Start read-only child
            </button>
            {session.harness === "hermes" && (
              <p>Hermes does not support read-only children.</p>
            )}
          </details>
          {tasks.length > 0 && (
            <div className="panel-toolbar">
              <button
                className="button"
                disabled={!tasks.some((t) => done(t.status))}
                onClick={async () => {
                  const draft = await call<string>("collectTasks", {
                    sid: session.id,
                  });
                  if (draft !== undefined)
                    notify(
                      "Child results added to the parent draft for review",
                    );
                }}
              >
                Add results to draft
              </button>
              <button
                className="button"
                disabled={tasks.every((t) => done(t.status))}
                onClick={() => call("cancelTaskTree", { sid: session.id })}
              >
                Stop task & children
              </button>
            </div>
          )}
        </>
      )}
      {tasks.map((t) => (
        <article className="task-card" key={t.id}>
          <strong>{t.objective}</strong>
          <span className={`state-label ${t.status}`}>
            {t.status} ·{" "}
            {Math.max(
              0,
              Math.round(
                ((t.finishedAt ? Date.parse(t.finishedAt) : Date.now()) -
                  Date.parse(t.createdAt)) /
                  1000,
              ),
            )}
            s
          </span>
          <p>{t.scope}</p>
          <div className="panel-toolbar">
            <button className="button" onClick={() => open(t.childSessionId)}>
              Open child
            </button>
            {!done(t.status) && (
              <button
                className="button"
                onClick={() => call("cancelTask", { id: t.id })}
              >
                Stop child
              </button>
            )}
          </div>
          {t.error && <p className="skill-warning">{t.error}</p>}
          {t.result && (
            <details>
              <summary>Result{t.truncated ? " (truncated)" : ""}</summary>
              <pre>{t.result}</pre>
            </details>
          )}
        </article>
      ))}
      {!tasks.length && !parentTask && (
        <p className="subtle">
          No child tasks yet. Maximum two active children; all use the shared
          inference queue.
        </p>
      )}
    </section>
  );
}
