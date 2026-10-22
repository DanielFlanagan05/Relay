import { randomUUID } from "node:crypto";
import { z } from "zod";

export const taskInput = z
  .object({
    objective: z.string().trim().min(1).max(4000),
    context: z.string().max(20000).default(""),
    expectedResult: z
      .string()
      .max(2000)
      .default("A concise result with evidence and unresolved questions."),
    scope: z
      .string()
      .max(2000)
      .default("Read-only analysis. Do not modify files."),
    maxSeconds: z.number().int().min(10).max(1800).default(600),
  })
  .strict();
export const taskTerminal = (task) =>
  ["complete", "failed", "canceled", "interrupted"].includes(task.status);
export class TaskCoordinator {
  constructor(service) {
    this.service = service;
  }
  get data() {
    return this.service.store.data;
  }
  list(sid) {
    return this.data.tasks.filter((t) => t.parentSessionId === sid);
  }
  find(id) {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) throw new Error("Task not found");
    return task;
  }
  create(sid, input, { automated = false, roundId = "" } = {}) {
    const spec = taskInput.parse(input),
      parent = this.service.store.session(sid);
    if (parent.taskId) throw new Error("Child agents cannot delegate further");
    if (automated && parent.harness !== "direct")
      throw new Error(
        "Tool-driven delegation is supported only on Direct chat endpoints. Use the Delegate action for other harnesses.",
      );
    if (parent.archived)
      throw new Error("Restore the parent session before delegating");
    if (parent.harness === "hermes")
      throw new Error(
        "This harness cannot enforce a read-only child; choose another route",
      );
    if (this.list(sid).filter((t) => !taskTerminal(t)).length >= 2)
      throw new Error("At most two child tasks may run for this session");
    if (this.list(sid).length >= 100)
      throw new Error(
        "This session has reached its task history limit; start a new session",
      );
    this.service.validatePair(parent.modelId, parent.harness);
    const child = this.service.store.create({
      title: spec.objective.slice(0, 80),
      modelId: parent.modelId,
      harness: parent.harness,
      cwd: parent.cwd,
      permission: "read-only",
      delegation: false,
      hookIds: parent.hookIds.filter(
        (id) => !["subagents", "html-output"].includes(id),
      ),
    });
    const task = {
      id: randomUUID(),
      parentSessionId: sid,
      childSessionId: child.id,
      ...spec,
      automated,
      delegationId: roundId,
      status: "queued",
      createdAt: new Date().toISOString(),
      deadline: Date.now() + spec.maxSeconds * 1000,
      result: "",
      error: "",
    };
    child.taskId = task.id;
    child.outputFormat = "markdown";
    this.data.tasks.push(task);
    try {
      this.service.send(
        child.id,
        `Delegated read-only task\n\nObjective: ${spec.objective}\n\nScope: ${spec.scope}\n\nExpected result: ${spec.expectedResult}\n\nRelevant context supplied by the parent:\n${spec.context || "(No additional context supplied.)"}\n\nReport evidence, limitations, and unresolved work. Do not delegate or modify files.`,
        { taskId: task.id },
      );
    } catch (error) {
      task.status = "failed";
      task.error = error.message;
      task.finishedAt = new Date().toISOString();
    }
    this.service.changed(true);
    return task;
  }
  started(sid) {
    const task = this.data.tasks.find((t) => t.childSessionId === sid);
    if (task) {
      task.status = "running";
      task.startedAt = new Date().toISOString();
    }
  }
  settled(sid) {
    const task = this.data.tasks.find((t) => t.childSessionId === sid);
    if (!task) return;
    const child = this.service.store.session(sid),
      answer = child.messages.filter((m) => m.role === "assistant").at(-1);
    task.status =
      child.status === "idle"
        ? "complete"
        : child.status === "stopped"
          ? "canceled"
          : "failed";
    task.result = (answer?.content || "").slice(0, 16000);
    task.truncated = (answer?.content.length || 0) > 16000;
    task.error = child.error || task.error || "";
    task.finishedAt = new Date().toISOString();
    this.service.changed(true);
    // A parked parent holds no slot; it resumes only now.
    this.service.delegation?.onTaskSettled(task);
  }
  cancel(id) {
    const task = this.find(id);
    if (taskTerminal(task)) return;
    this.service.cancel(task.childSessionId);
    // Queued work has no execute/finally callback.
    if (!this.service.scheduler.active.has(task.childSessionId))
      this.settled(task.childSessionId);
  }
  cancelTree(sid) {
    this.service.cancel(sid);
    for (const t of this.list(sid)) this.cancel(t.id);
  }
  enforceDeadlines() {
    for (const task of this.data.tasks)
      if (!taskTerminal(task) && Date.now() > task.deadline) {
        task.error = "Task exceeded its elapsed-time budget";
        this.cancel(task.id);
      }
  }
  resultText(task) {
    return `Task: ${task.objective}\nStatus: ${task.status}\nScope: ${task.scope}\n${task.error ? `Error: ${task.error}\n` : ""}Result:\n${task.result || "(No result text)"}${task.truncated ? "\n[Result truncated; open the child session for full output.]" : ""}`;
  }
  collect(sid) {
    const parent = this.service.store.session(sid),
      tasks = this.list(sid).filter(taskTerminal);
    if (!tasks.length) throw new Error("No finished child results to collect");
    const text = tasks.map((t) => this.resultText(t)).join("\n\n---\n\n");
    if (parent.draft.length + text.length > 200000)
      throw new Error("Draft is too long to add these results");
    parent.draftRevision = (parent.draftRevision || 0) + 1;
    parent.draft = [
      parent.draft,
      "Review these delegated results and identify any remaining work:",
      text,
    ]
      .filter(Boolean)
      .join("\n\n");
    this.service.changed(true);
    return parent.draft;
  }
}
