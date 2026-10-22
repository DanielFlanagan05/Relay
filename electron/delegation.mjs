// Milestone E backend: agent-callable delegation for Direct chat endpoints.
//
// Only an OpenAI-compatible /chat/completions route with verified streaming
// function-call deltas qualifies. Native harnesses (Pi, OpenCode, Hermes,
// Codex, Claude) keep their own tool loops and are deliberately unsupported
// here: Relay cannot observe or bound their children.
//
// Two rules govern everything below.
//   1. A tool action is executed only when it arrives as a real streamed
//      tool-call delta for a tool registered in this session. Text that merely
//      looks like tool-call JSON is content, never an action.
//   2. A parent that waits must not hold an inference slot. The waiting state
//      is persisted instead of a held scheduler job, so a one-slot runtime
//      cannot deadlock and foreground work stays fair.

import { randomUUID } from "node:crypto";
import { z } from "zod";

export const LIMITS = {
  rounds: 4,
  callsPerRound: 6,
  callsTotal: 10,
  argumentChars: 16384,
  resultChars: 6000,
  roundSeconds: 900,
  waitSeconds: 300,
  maxWaitSeconds: 900,
  children: 2,
  statusLines: 20,
  history: 100,
};

const uuid = z.string().uuid();
const argumentSchemas = {
  delegate: z
    .object({
      objective: z.string().trim().min(1).max(2000),
      context: z.string().max(12000).default(""),
      expected_result: z
        .string()
        .max(1000)
        .default("A concise result with evidence and unresolved questions."),
      max_seconds: z.number().int().min(30).max(900).default(300),
    })
    .strict(),
  task_status: z.object({ task_id: uuid.optional() }).strict(),
  wait_for_tasks: z
    .object({
      task_ids: z.array(uuid).max(LIMITS.children).default([]),
      timeout_seconds: z
        .number()
        .int()
        .min(15)
        .max(LIMITS.maxWaitSeconds)
        .default(LIMITS.waitSeconds),
    })
    .strict(),
  cancel_task: z.object({ task_id: uuid }).strict(),
};

export const TOOL_NAMES = Object.keys(argumentSchemas);

const descriptions = {
  delegate:
    "Start one bounded read-only child agent inside Relay. The child shares this session's model, gets only the context you supply, cannot write files, cannot delegate further, and cannot gain capabilities you do not have. Returns a task id immediately; the child runs when an inference slot is free.",
  task_status:
    "Report the current status and result of your own delegated tasks. Without task_id it reports every task you started in this session.",
  wait_for_tasks:
    "Release this turn's inference slot and resume only when the listed delegated tasks finish (all of them when task_ids is omitted). Use this instead of guessing. If the wait budget expires you receive the partial statuses and may wait again while your round budget lasts.",
  cancel_task:
    "Cancel one of your own delegated tasks that is no longer needed. Its partial output stays available in task_status.",
};

export const toolSpecs = Object.entries(argumentSchemas).map(([name, schema]) => ({
  type: "function",
  function: {
    name,
    description: descriptions[name],
    parameters: zodToJsonSchema(schema),
  },
}));

// Small structural projection of the argument schemas onto the JSON Schema
// subset OpenAI-compatible endpoints accept. Kept next to the validators so a
// tool definition can never drift from what is actually accepted.
function zodToJsonSchema(schema) {
  const shape = schema.shape || {};
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(shape)) {
    const check = unwrap(value);
    properties[key] = jsonType(check);
    if (!isOptional(value)) required.push(key);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
function unwrap(value) {
  let current = value;
  while (current?._def?.innerType) current = current._def.innerType;
  return current;
}
function isOptional(value) {
  return value?.isOptional?.() === true || value?._def?.typeName === "ZodDefault";
}
function jsonType(schema) {
  const kind = schema?._def?.typeName;
  if (kind === "ZodArray")
    return { type: "array", items: jsonType(schema._def.type), maxItems: LIMITS.children };
  if (kind === "ZodNumber")
    return {
      type: "integer",
      ...(schema._def?.checks?.length
        ? {
            ...(schema._def.checks.find((c) => c.kind === "min")
              ? { minimum: schema._def.checks.find((c) => c.kind === "min").value }
              : {}),
            ...(schema._def.checks.find((c) => c.kind === "max")
              ? { maximum: schema._def.checks.find((c) => c.kind === "max").value }
              : {}),
          }
        : {}),
    };
  return {
    type: "string",
    ...(schema?._def?.checks?.find((c) => c.kind === "max")
      ? {
          maxLength: schema._def.checks.find((c) => c.kind === "max").value,
        }
      : {}),
  };
}

/**
 * Accumulates OpenAI-style streamed tool-call deltas. A call arrives split
 * across chunks: `id` and `name` usually first, `arguments` in fragments.
 */
export class ToolCallAccumulator {
  constructor({ maxArgumentChars = LIMITS.argumentChars } = {}) {
    this.max = maxArgumentChars;
    this.entries = [];
    this.byIndex = new Map();
    this.malformed = false;
  }
  open(id = "") {
    const entry = { id, name: "", arguments: "", error: "" };
    this.entries.push(entry);
    return entry;
  }
  at(index) {
    if (!this.byIndex.has(index)) this.byIndex.set(index, this.open());
    return this.byIndex.get(index);
  }
  feed(deltas) {
    if (!Array.isArray(deltas)) {
      this.malformed = true;
      return;
    }
    for (const delta of deltas) {
      if (!delta || typeof delta !== "object") {
        this.malformed = true;
        continue;
      }
      let entry;
      if (Number.isFinite(delta.index)) entry = this.at(delta.index);
      else if (delta.id && !this.entries.some((e) => e.id === delta.id))
        entry = this.open(String(delta.id).slice(0, 200));
      else entry = this.entries.at(-1) || this.open();
      if (delta.id) entry.id = String(delta.id).slice(0, 200);
      const fn = delta.function || delta.func || {};
      if (typeof fn.name === "string") entry.name += fn.name;
      if (typeof fn.arguments === "string") {
        if (entry.error) continue;
        entry.arguments += fn.arguments;
        // Bound the buffer itself: a runaway model must not grow the transcript.
        if (entry.arguments.length > this.max) {
          entry.arguments = entry.arguments.slice(0, this.max);
          entry.error = "Tool arguments exceeded the size limit";
        }
      }
    }
  }
  completed() {
    return this.entries
      .map((entry, position) => ({
        id: entry.id || `relay_call_${position}`,
        name: entry.name.trim(),
        arguments: entry.arguments,
        error: entry.error,
      }))
      .filter((entry) => entry.name || entry.arguments || entry.error);
  }
}

/** Validates one streamed call against the registered protocol for this turn. */
export function compileToolCall(call, { allowed = TOOL_NAMES } = {}) {
  if (call.error) return { ok: false, error: call.error };
  if (!allowed.includes(call.name))
    return {
      ok: false,
      error: `Unknown tool "${call.name || "(unnamed)"}". Available: ${allowed.join(", ")}.`,
    };
  const text = call.arguments.trim();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, error: "Tool arguments must be a JSON object" };
  const result = argumentSchemas[call.name].safeParse(parsed);
  if (!result.success)
    return {
      ok: false,
      error: `Invalid arguments: ${result.error.issues
        .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
        .join("; ")
        .slice(0, 500)}`,
    };
  return { ok: true, id: call.id, name: call.name, args: result.data };
}

/** Protocol messages for a stored answer, with dangling tool calls dropped. */
export function protocolMessages(protocol = []) {
  const out = [];
  for (let i = 0; i < protocol.length; i++) {
    const entry = protocol[i];
    if (entry.role === "assistant") {
      const calls = entry.tool_calls || [];
      const answered = new Set(
        protocol
          .slice(i + 1)
          .filter((e) => e.role === "tool")
          .map((e) => e.tool_call_id),
      );
      const complete = calls.filter((c) => answered.has(c.id));
      const text = entry.content || "";
      if (complete.length)
        out.push({
          role: "assistant",
          content: text || null,
          tool_calls: complete.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.function.name, arguments: c.function.arguments },
          })),
        });
      else if (text) out.push({ role: "assistant", content: text });
    } else if (entry.role === "tool" && entry.tool_call_id)
      out.push({
        role: "tool",
        tool_call_id: entry.tool_call_id,
        content: String(entry.content ?? ""),
      });
  }
  return out;
}

/** Chat history for a direct endpoint, including prior tool-call protocol. */
export function openaiHistory(session) {
  const out = [];
  for (const message of session.messages.slice(0, -2)) {
    if (message.role === "user" && message.content)
      out.push({ role: "user", content: message.content });
    else if (message.role === "assistant" && message.protocol?.length)
      out.push(...protocolMessages(message.protocol));
    else if (message.role === "assistant" && message.content)
      out.push({ role: "assistant", content: message.content });
  }
  return out;
}

export function appendToolResult(answer, callId, content, name = "") {
  const protocol = answer.protocol || (answer.protocol = []);
  if (protocol.some((e) => e.role === "tool" && e.tool_call_id === callId))
    return;
  protocol.push({
    role: "tool",
    tool_call_id: callId,
    name,
    content: String(content).slice(0, LIMITS.resultChars),
  });
}

/** Every tool call needs an answer before the next request or the model sees a broken transcript. */
export function sealProtocol(answer, note = "No result: this turn was stopped.") {
  if (!answer?.protocol?.length) return;
  for (const entry of answer.protocol)
    for (const call of entry.tool_calls || [])
      appendToolResult(answer, call.id, note, call.function?.name);
}

const roundTerminal = (round) =>
  ["complete", "failed", "canceled", "interrupted"].includes(round.status);

export class DelegationEngine {
  constructor(service) {
    this.service = service;
  }
  get data() {
    return this.service.store.data;
  }
  get specs() {
    return toolSpecs;
  }
  /** Capability gate: explicit opt-in, direct chat only, never inside a child. */
  enabledFor(session) {
    return !!(
      session?.delegation &&
      session.harness === "direct" &&
      !session.taskId &&
      !session.archived
    );
  }
  list(sid) {
    return this.data.delegations.filter((r) => r.parentSessionId === sid);
  }
  find(id) {
    return this.data.delegations.find((r) => r.id === id);
  }
  openRound(sid) {
    return this.list(sid).find((r) => !roundTerminal(r));
  }
  pendingRound(sid) {
    return this.list(sid).find((r) => r.status === "waiting");
  }
  begin({ session, answer, prompt }) {
    if (!this.enabledFor(session)) return null;
    const existing = this.openRound(session.id);
    if (existing) this.retire(existing, "interrupted", "A new turn replaced it.");
    for (const round of this.list(session.id))
      if (round.endedAt && Date.now() - Date.parse(round.endedAt) > 864e5)
        this.data.delegations.splice(this.data.delegations.indexOf(round), 1);
    const round = {
      id: randomUUID(),
      parentSessionId: session.id,
      parentAnswerId: answer.id,
      prompt,
      status: "running",
      round: 1,
      calls: 0,
      children: [],
      waitingOn: [],
      waitCalls: [],
      final: false,
      experimental: true,
      qualified: false,
      createdAt: new Date().toISOString(),
      deadline: Date.now() + LIMITS.roundSeconds * 1000,
      error: "",
    };
    this.data.delegations.push(round);
    if (this.data.delegations.length > LIMITS.history)
      this.data.delegations.splice(
        0,
        this.data.delegations.length - LIMITS.history,
      );
    session.delegationRoundId = round.id;
    return round;
  }
  /** Streamed calls for one round, validated against this session's protocol. */
  compile({ round, session, outcome, emit }) {
    // Only calls that arrived on the tool-call channel can become actions.
    const answer = this.answer(round);
    const streamed = outcome?.toolCalls || [];
    if (!this.enabledFor(session)) {
      if (streamed.length)
        emit({
          type: "diagnostic",
          value:
            "The endpoint returned tool calls that this session did not request. Nothing was executed.",
        });
      return [];
    }
    const allowed = TOOL_NAMES;
    const actions = [];
    answer.protocol || (answer.protocol = []);
    const calls = [];
    for (const raw of streamed.slice(0, LIMITS.callsPerRound + 2)) {
      const compiled = compileToolCall(raw, { allowed });
      if (!compiled.ok) {
        calls.push({
          id: raw.id,
          type: "function",
          function: {
            name: raw.name.slice(0, 120) || "unknown",
            arguments: raw.arguments.slice(0, 2000),
          },
        });
        actions.push({ ...compiled, id: raw.id, name: raw.name });
        continue;
      }
      calls.push({
        id: compiled.id,
        type: "function",
        function: {
          name: compiled.name,
          arguments: JSON.stringify(compiled.args),
        },
      });
      actions.push(compiled);
    }
    if (streamed.length > LIMITS.callsPerRound)
      for (const raw of streamed.slice(LIMITS.callsPerRound)) {
        calls.push({
          id: raw.id,
          type: "function",
          function: {
            name: raw.name.slice(0, 120) || "unknown",
            arguments: raw.arguments.slice(0, 2000),
          },
        });
        actions.push({
          ok: false,
          id: raw.id,
          name: raw.name,
          error: "Per-round tool-call limit reached; this call was not executed.",
        });
      }
    if (calls.length || outcome.text)
      answer.protocol.push({
        role: "assistant",
        content: outcome.text || null,
        tool_calls: calls,
      });
    return actions;
  }
  answer(round) {
    const session = this.service.store.session(round.parentSessionId);
    const found = session.messages.find((m) => m.id === round.parentAnswerId);
    if (!found) throw new Error("The answer this delegation belongs to is gone");
    return found;
  }
  taskById(id) {
    return this.data.tasks.find((t) => t.id === id);
  }
  /** Executes validated calls. Parks the parent (releasing its slot) when it waits. */
  async run({ round, session, actions, emit }) {
    const waitCalls = [];
    let wait = null;
    for (const action of actions) {
      if (round.final && action.name === "wait_for_tasks") {
        this.reply(
          round,
          action,
          "The round budget for this turn is spent; waiting is unavailable on the final round. Report what you know and name the unresolved work.",
        );
        continue;
      }
      const result = await this.invoke({ round, session, action, emit });
      if (result.wait) {
        waitCalls.push(action.id);
        wait = result;
        continue;
      }
      this.reply(round, action, result.text, result.error);
    }
    if (!wait) return { waited: false };
    return {
      waited: true,
      ...this.park(round, {
        taskIds: wait.taskIds,
        seconds: wait.seconds,
        callIds: waitCalls,
      }),
    };
  }
  reply(round, action, text, error = "") {
    const answer = this.answer(round);
    appendToolResult(
      answer,
      action.id,
      error ? `Error: ${error}` : text || "(no output)",
      action.name,
    );
    this.service.changed(true);
  }
  async invoke({ round, session, action, emit }) {
    round.calls += 1;
    const show = (output, error = "") =>
      emit({
        type: "tool",
        value: {
          name: `Delegation · ${action.name}`,
          input: action.args,
          output: String(output ?? "").slice(0, 2000),
          error,
          at: new Date().toISOString(),
        },
      });
    if (!action.ok) {
      show("", action.error);
      return { text: "", error: action.error };
    }
    try {
      const value = await this.dispatch({ round, session, action });
      show(value.text, value.error);
      return value;
    } catch (error) {
      const message = String(error.message || error).slice(0, 1000);
      show("", message);
      return { text: "", error: message };
    }
  }
  dispatch({ round, session, action }) {
    const tasks = this.service.tasks;
    switch (action.name) {
      case "delegate": {
        if (round.final)
          return {
            text: "",
            error:
              "The delegation budget for this turn is spent. Report the outstanding work instead.",
          };
        if (
          tasks
            .list(session.id)
            .filter((t) => !["complete", "failed", "canceled", "interrupted"].includes(t.status))
            .length >= LIMITS.children
        )
          return {
            text: "",
            error: `At most ${LIMITS.children} child tasks may run per session. Wait for or cancel one first.`,
          };
        const task = tasks.create(
          session.id,
          {
            objective: action.args.objective,
            context: action.args.context,
            expectedResult: action.args.expected_result,
            scope:
              "Read-only analysis inside the parent workspace. Do not modify files, do not delegate.",
            maxSeconds: action.args.max_seconds,
          },
          { automated: true, roundId: round.id },
        );
        round.children.push(task.id);
        return {
          text: `Queued read-only child task ${task.id}. It starts when a shared inference slot is free. Use task_status or wait_for_tasks.`,
        };
      }
      case "task_status": {
        const mine = tasks.list(session.id);
        const selected = action.args.task_id
          ? mine.filter((t) => t.id === action.args.task_id)
          : mine.slice(-LIMITS.statusLines);
        if (action.args.task_id && !selected.length)
          return {
            text: "",
            error:
              "Task not found. You can only inspect tasks started by this session.",
          };
        if (!selected.length)
          return { text: "No delegated tasks in this session yet." };
        return {
          text: selected
            .map((t) => this.statusLine(t))
            .join("\n\n")
            .slice(0, LIMITS.resultChars),
        };
      }
      case "wait_for_tasks": {
        const mine = new Set(tasks.list(session.id).map((t) => t.id));
        const wanted = action.args.task_ids.length
          ? action.args.task_ids.filter((id) => mine.has(id))
          : tasks
              .list(session.id)
              .filter((t) => !tasksTerminal(t))
              .map((t) => t.id);
        if (action.args.task_ids.some((id) => !mine.has(id)))
          return {
            text: "",
            error:
              "You can only wait for tasks started by this session. Ignored the unknown ids.",
          };
        const running = wanted.filter((id) => !tasksTerminal(this.taskById(id)));
        if (!running.length)
          return {
            text: runningSummary(tasks, wanted, "No listed task is still running."),
          };
        return {
          wait: true,
          taskIds: running,
          seconds: action.args.timeout_seconds,
          text: "",
        };
      }
      case "cancel_task": {
        const task = tasks
          .list(session.id)
          .find((t) => t.id === action.args.task_id);
        if (!task)
          return {
            text: "",
            error: "Task not found. You can only cancel tasks started by this session.",
          };
        tasks.cancel(task.id);
        return {
          text: `Cancellation requested for ${task.id}. Partial output, if any, remains visible in task_status.`,
        };
      }
      default:
        return { text: "", error: "Tool is not available in this session." };
    }
  }
  statusLine(task) {
    return [
      `task ${task.id}`,
      `status: ${task.status}`,
      `objective: ${task.objective.slice(0, 300)}`,
      task.error ? `error: ${task.error.slice(0, 400)}` : "",
      task.result ? `result: ${task.result.slice(0, 2200)}` : "",
      task.truncated ? "(result truncated; the child session keeps the full output)" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  /** Releases the inference slot: nothing is scheduled for the parent while it waits. */
  park(round, { taskIds, seconds, callIds }) {
    const session = this.service.store.session(round.parentSessionId);
    round.status = "waiting";
    round.waitCallIds = [...new Set([...round.waitCallIds, ...callIds])];
    round.waitingOn = [...new Set([...round.waitingOn, ...taskIds])].filter(
      (id) => !tasksTerminal(this.taskById(id)),
    );
    // Everything already finished: resume now rather than parking an empty wait.
    if (!round.waitingOn.length)
      return this.resume(round, "Delegated tasks were already finished."), {
        parked: false,
      };
    round.waitUntil = Date.now() + seconds * 1000;
    session.status = "queued";
    session.queueReason = `Waiting for ${round.waitingOn.length} delegated task(s); the inference slot is released`;
    this.service.changed(true);
    return { parked: true };
  }
  onTaskSettled(task) {
    for (const round of this.data.delegations)
      if (
        round.status === "waiting" &&
        round.parentSessionId === task.parentSessionId &&
        round.waitingOn.every((id) => tasksTerminal(this.taskById(id)))
      )
        this.resume(round);
  }
  resume(round, note = "") {
    if (round.status !== "waiting") return;
    const session = this.service.store.session(round.parentSessionId);
    const answer = this.answer(round);
    const summary = this.summary(round, note);
    for (const callId of round.waitCallIds)
      appendToolResult(answer, callId, summary, "wait_for_tasks");
    round.waitCallIds = [];
    round.waitingOn = [];
    round.waitUntil = 0;
    round.status = "running";
    session.queueReason = "Resuming with delegated results";
    session.status = "queued";
    // A continuation is an ordinary foreground job: children stay behind it and
    // the parent only ever occupies a slot while it is actually generating.
    try {
      this.service.scheduler.enqueue({
        sessionId: session.id,
        modelId: session.modelId,
        answerId: answer.id,
        roundId: round.id,
        prompt: round.prompt,
        outputFormat: session.outputFormat,
        settled: () => this.service.tasks.settled(session.id),
        waiting: (reason) => {
          session.queueReason = reason;
          this.service.changed();
        },
        failed: (error) => this.service.fail(session, answer, error),
      });
    } catch (error) {
      round.status = "failed";
      round.error = `Could not resume the parent turn: ${error.message}`;
      sealProtocol(answer, "No result: the parent could not be resumed.");
      session.status = "error";
      session.error = round.error;
    }
    this.service.changed(true);
  }
  summary(round, note = "") {
    const tasks = this.service.tasks;
    const ids = round.waitingOn.length
      ? round.waitingOn
      : round.children.slice(-LIMITS.children);
    const lines = ids
      .map((id) => this.taskById(id))
      .filter(Boolean)
      .map((t) => this.statusLine(t));
    return [
      note,
      lines.length ? lines.join("\n\n") : "No delegated task records were found.",
      `Rounds used: ${round.round}/${LIMITS.rounds}. Delegation is experimental and has not been qualified with a live model.`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, LIMITS.resultChars);
  }
  /** Budget/timeout sweep, called from the service heartbeat. */
  enforceBudgets() {
    for (const round of [...this.data.delegations]) {
      if (roundTerminal(round)) continue;
      const expired = Date.now() > round.deadline;
      const waitExpired =
        round.status === "waiting" && round.waitUntil && Date.now() > round.waitUntil;
      if (!expired && !waitExpired) continue;
      if (round.status === "waiting") {
        const stragglers = round.waitingOn.filter(
          (id) => !tasksTerminal(this.taskById(id)),
        );
        round.final = true;
        round.round = LIMITS.rounds;
        round.error = expired
          ? "The delegation turn exceeded its elapsed budget"
          : "The wait budget expired; outstanding tasks keep running";
        this.resume(
          round,
          expired
            ? "Delegation budget exceeded. Outstanding tasks were canceled; summarize partial results and unresolved work."
            : "The wait budget expired. Outstanding tasks are still running; use their partial status.",
        );
        if (expired)
          for (const id of stragglers) cancelQuietly(this.service, id);
      } else if (expired) {
        this.retire(round, "failed", "The delegation turn exceeded its elapsed budget");
        this.service.scheduler.cancel(round.parentSessionId);
      }
    }
  }
  /** A stopped or failed parent must not leave children running. */
  abortFor(session) {
    for (const round of this.list(session.id))
      if (!roundTerminal(round)) this.retire(round, "canceled", "The parent turn stopped.");
  }
  retire(round, status, error) {
    if (roundTerminal(round)) return;
    round.status = status;
    round.error = error || round.error;
    round.endedAt = new Date().toISOString();
    for (const id of round.children) {
      const task = this.taskById(id);
      if (task && !tasksTerminal(task)) cancelQuietly(this.service, id);
    }
    try {
      sealProtocol(this.answer(round));
    } catch {}
    const session = this.service.store.session(round.parentSessionId);
    if (session.delegationRoundId === round.id) delete session.delegationRoundId;
    this.service.changed(true);
  }
  finish(round, status = "complete", error = "") {
    if (!round || roundTerminal(round)) return;
    this.retire(round, status, error);
  }
}

function tasksTerminal(task) {
  return (
    !!task &&
    ["complete", "failed", "canceled", "interrupted"].includes(task.status)
  );
}
function cancelQuietly(service, id) {
  try {
    service.tasks.cancel(id);
  } catch {}
}
function runningSummary(tasks, ids, empty) {
  const list = ids.map((id) => tasks.find(id)).filter(Boolean);
  if (!list.length) return empty;
  return list.map((t) => statusLineStatic(t)).join("\n\n").slice(0, LIMITS.resultChars);
}
function statusLineStatic(task) {
  return [
    `task ${task.id}`,
    `status: ${task.status}`,
    task.error ? `error: ${task.error.slice(0, 400)}` : "",
    task.result ? `result: ${task.result.slice(0, 2200)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const delegationRoundTerminal = roundTerminal;
