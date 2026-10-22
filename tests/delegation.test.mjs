import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentService } from "../electron/service.mjs";
import { Store } from "../electron/store.mjs";
import { runDirect } from "../electron/adapters.mjs";
import { bundledSkills, resolveSkills } from "../electron/skills.mjs";
import {
  ToolCallAccumulator,
  compileToolCall,
  protocolMessages,
  sealProtocol,
  openaiHistory,
  toolSpecs,
  LIMITS,
} from "../electron/delegation.mjs";

const until = async (fn) => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out");
};
const stopper = (signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Turn stopped", "AbortError")),
      { once: true },
    ),
  );
const model = {
  id: "fixture",
  name: "Fixture",
  kind: "local",
  model: "fake",
  endpoint: "http://127.0.0.1:1/v1",
  parallel: 1,
  slotGiB: 0.25,
  context: 32768,
};

function fixture(t, runner, { delegation = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-delegation-"));
  const service = new AgentService(dir, {
    runner,
    memorySource: () => ({ availableGiB: 100, totalGiB: 128 }),
    runtimeSource: () => null,
  });
  // One shared inference slot: every test below must prove it cannot deadlock.
  service.store.data.models = [structuredClone(model)];
  const sid = service.create({
    modelId: "fixture",
    harness: "direct",
    delegation,
  });
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, sid, dir };
}
const call = (id, name, args) => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const answer = (service, sid) =>
  service.store
    .session(sid)
    .messages.filter((m) => m.role === "assistant")
    .at(-1);
const toolReplies = (service, sid) =>
  (answer(service, sid).protocol || []).filter((e) => e.role === "tool");

test("streamed tool-call deltas assemble into validated arguments", () => {
  const accumulator = new ToolCallAccumulator();
  // Real endpoints split id, name and arguments across chunks and indexes.
  accumulator.feed([{ index: 0, id: "call_a", function: { name: "dele" } }]);
  accumulator.feed([{ index: 0, function: { name: "gate" } }]);
  accumulator.feed([{ index: 0, function: { arguments: '{"objec' } }]);
  accumulator.feed([
    { index: 1, id: "call_b", function: { name: "wait_for_tasks" } },
  ]);
  accumulator.feed([
    { index: 0, function: { arguments: 'tive":"Inspect A"}' } },
  ]);
  accumulator.feed([{ index: 1, function: { arguments: "{}" } }]);
  const calls = accumulator.completed();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "delegate");
  assert.deepEqual(compileToolCall(calls[0]).args, {
    objective: "Inspect A",
    context: "",
    expected_result: "A concise result with evidence and unresolved questions.",
    max_seconds: 300,
  });
  assert.equal(compileToolCall(calls[1]).name, "wait_for_tasks");
  // Deltas that omit an index keep accumulating into the open call.
  const single = new ToolCallAccumulator();
  single.feed([{ function: { id: "x", name: "task_status" } }]);
  single.feed([{ function: { arguments: "{}" } }]);
  assert.equal(compileToolCall(single.completed()[0]).name, "task_status");
});

test("oversized, unknown and malformed calls are refused without acting", () => {
  const huge = new ToolCallAccumulator({ maxArgumentChars: 500 });
  for (let i = 0; i < 10; i++)
    huge.feed([
      {
        index: 0,
        id: "a",
        function: { name: "delegate", arguments: "x".repeat(200) },
      },
    ]);
  const [overflow] = huge.completed();
  assert.match(overflow.error, /size limit/);
  assert.equal(overflow.arguments.length, 500);
  assert.equal(compileToolCall(overflow).ok, false);

  assert.equal(
    compileToolCall(call("1", "rm_rf", {})).error,
    'Unknown tool "rm_rf". Available: delegate, task_status, wait_for_tasks, cancel_task.',
  );
  assert.match(
    compileToolCall(call("2", "delegate", "{not json")).error,
    /valid JSON/,
  );
  assert.match(
    compileToolCall(call("3", "delegate", { objective: "" })).error,
    /objective/,
  );
  // Unknown keys are refused instead of silently ignored.
  assert.match(
    compileToolCall(call("4", "delegate", { objective: "x", shell: "rm -r /" }))
      .error,
    /shell/,
  );
  // A name that only looks plausible is still unknown.
  assert.equal(compileToolCall(call("5", "delegate ", {})).ok, false);
});

test("delegation off: unsolicited calls and tool-shaped prose never act", async (t) => {
  const { service, sid } = fixture(
    t,
    async ({ emit, tools }) => {
      assert.equal(
        tools,
        undefined,
        "a disabled session must not advertise tools",
      );
      emit({
        type: "delta",
        value:
          'I will delegate now: {"name":"delegate","arguments":{"objective":"Pretend work"}}',
      });
      return {
        text: "claimed",
        toolCalls: [call("ghost", "delegate", { objective: "Pretend work" })],
      };
    },
    { delegation: false },
  );
  service.send(sid, "please delegate");
  await until(() => service.store.session(sid).status === "idle");
  assert.equal(service.store.data.tasks.length, 0);
  const result = answer(service, sid);
  assert.match(result.content, /Pretend work/);
  assert.equal(result.protocol, undefined);
  assert.ok(
    result.tools.some((tool) => /delegation is disabled/i.test(tool.output)),
    "the ignored tool call is reported honestly",
  );
});

test("one slot: delegate then wait releases the parent and resumes with results", async (t) => {
  const parentTurns = [],
    evidence = {};
  let service, sid;
  const script = [
    {
      toolCalls: [
        call("c1", "delegate", { objective: "Inspect A", context: "detail" }),
      ],
    },
    { toolCalls: [call("c2", "wait_for_tasks", {})] },
    { text: "Integrated: child finding included." },
  ];
  const runner = async ({ session, prompt, messages, tools, emit }) => {
    if (session.taskId) {
      // Recorded at the instant the child grabbed the only slot.
      const parent = service.store.session(sid);
      evidence.parentStatus = parent.status;
      evidence.parentHoldsSlot = service.scheduler.active.has(sid);
      evidence.parentRound = service.store.data.delegations.at(-1)?.status;
      evidence.queueReason = parent.queueReason;
      evidence.permission = session.permission;
      evidence.delegation = session.delegation;
      evidence.childPrompt = messages ? messages.at(-1).content : prompt;
      emit({ type: "delta", value: "CHILD FINDING" });
      return { text: "CHILD FINDING" };
    }
    assert.ok(
      tools?.length,
      "an opted-in session advertises the delegation tools",
    );
    parentTurns.push(structuredClone(messages));
    const step = script.shift();
    if (!step) throw new Error("parent script exhausted");
    if (step.text) emit({ type: "delta", value: step.text });
    return step;
  };
  ({ service, sid } = fixture(t, runner));
  service.store.session(sid).messages = [
    { role: "user", content: "PARENT PRIVATE HISTORY" },
    { role: "assistant", content: "noted" },
  ];
  service.send(sid, "Delegate the inspection");
  await until(() => service.store.data.tasks.length === 1);
  const task = service.store.data.tasks[0];
  assert.equal(task.automated, true);
  assert.equal(
    task.delegationId,
    service.store.data.delegations.at(-1).id,
    "the task records which delegation round created it",
  );
  await until(() => service.store.session(sid).status === "idle");
  // No deadlock at one slot: the child only ever ran because the parked parent
  // gave the slot back, and the parent then resumed on that same slot.
  assert.equal(evidence.parentRound, "waiting");
  assert.equal(evidence.parentStatus, "queued");
  assert.equal(
    evidence.parentHoldsSlot,
    false,
    "the waiting parent holds no slot",
  );
  assert.match(evidence.queueReason, /slot is released/);
  assert.equal(service.scheduler.active.size, 0, "no leaked reservation");
  // A child never exceeds the parent that created it.
  assert.equal(evidence.permission, "read-only");
  assert.equal(evidence.delegation, false);
  assert.doesNotMatch(evidence.childPrompt, /PARENT PRIVATE/);
  assert.match(answer(service, sid).content, /Integrated: child finding/);
  const resumed = parentTurns.at(-1);
  assert.match(
    JSON.stringify(resumed[0]),
    /PARENT PRIVATE/,
    "own history kept",
  );
  // Each provider round is its own assistant entry, each answer paired below.
  assert.deepEqual(
    resumed
      .filter((m) => m.role === "assistant" && m.tool_calls)
      .flatMap((m) => m.tool_calls.map((c) => c.function.name)),
    ["delegate", "wait_for_tasks"],
  );
  const replies = resumed.filter((m) => m.role === "tool");
  assert.equal(replies.length, 2);
  assert.equal(replies[0].tool_call_id, "c1");
  assert.match(replies[1].tool_call_id, /^c2$/);
  assert.match(replies[1].content, /CHILD FINDING/);
  assert.match(replies[1].content, /status: complete/);
  assert.match(replies[1].content, /experimental/);
  assert.equal(service.store.data.delegations.at(-1).status, "complete");
});

test("failed and cancelled children are reported, not glossed over", async (t) => {
  const script = [
    {
      toolCalls: [
        call("c1", "delegate", { objective: "Will fail" }),
        call("c2", "delegate", { objective: "Will be cancelled" }),
      ],
    },
    { toolCalls: [call("c3", "wait_for_tasks", {})] },
    { text: "Partial only." },
  ];
  const { service, sid } = fixture(t, async ({ session, emit, signal }) => {
    if (session.taskId) {
      if (session.title.includes("fail")) throw new Error("child boom");
      return stopper(signal);
    }
    const step = script.shift();
    if (!step) throw new Error("script exhausted");
    if (step.text) emit({ type: "delta", value: step.text });
    return step;
  });
  service.send(sid, "delegate and wait");
  await until(() => service.delegation.pendingRound(sid)?.status === "waiting");
  const [failed, blocking] = service.tasks.list(sid);
  await until(() => service.tasks.find(failed.id).status === "failed");
  // The model is waiting on both; cancelling one still resumes it.
  service.tasks.cancel(blocking.id);
  await until(() => service.store.session(sid).status === "idle");
  const wait = toolReplies(service, sid).at(-1);
  assert.match(wait.content, /status: failed/);
  assert.match(wait.content, /child boom/);
  assert.match(wait.content, /status: canceled/);
  assert.match(wait.content, /experimental/);
  assert.match(answer(service, sid).content, /Partial only/);
  assert.equal(service.scheduler.active.size, 0);
});

test("status, wait and cancel are scoped to the parent's own tasks", async (t) => {
  const { service, sid } = fixture(t, async ({ emit }) => {
    emit({ type: "delta", value: "child" });
    return { text: "child" };
  });
  const other = service.create({ modelId: "fixture", harness: "direct" });
  const foreign = service.tasks.create(other, {
    objective: "Someone else's task",
  });
  await until(() => service.scheduler.active.size === 0);
  const engine = service.delegation;
  const round = engine.begin({
    session: service.store.session(sid),
    answer: { id: "answer", protocol: [] },
    prompt: "p",
  });
  const ask = (name, args) =>
    engine.dispatch({
      round,
      session: service.store.session(sid),
      action: { name, args },
    });
  assert.match((await ask("task_status", {})).text, /No delegated tasks/);
  assert.match(
    (await ask("task_status", { task_id: foreign.id })).error,
    /only inspect/,
  );
  assert.match(
    (await ask("cancel_task", { task_id: foreign.id })).error,
    /only cancel/,
  );
  assert.match(
    (await ask("wait_for_tasks", { task_ids: [foreign.id] })).error,
    /only wait/,
  );
  assert.equal(
    foreign.status,
    "complete",
    "another session's task is untouched",
  );
  engine.retire(round, "complete");
});

test("child ceiling, capability ceiling and recursion all stay closed", async (t) => {
  const { service, sid } = fixture(t, async ({ emit }) => {
    emit({ type: "delta", value: "child output" });
    return { text: "child output" };
  });
  // Even a write-capable parent can only spawn read-only, non-delegating children.
  service.updateSession(sid, { permission: "workspace-write" });
  const engine = service.delegation;
  const round = engine.begin({
    session: service.store.session(sid),
    answer: { id: "a", protocol: [] },
    prompt: "p",
  });
  let accepted = 0;
  for (let i = 0; i < 4; i++) {
    const result = await engine.dispatch({
      round,
      session: service.store.session(sid),
      action: { name: "delegate", args: { objective: `Task ${i}` } },
    });
    if (result.text) accepted += 1;
    else assert.match(result.error, /At most 2 child tasks/);
  }
  assert.equal(accepted, LIMITS.children);
  await until(() => service.scheduler.active.size === 0);
  const child = service.store.session(
    service.tasks.list(sid)[0].childSessionId,
  );
  assert.equal(child.permission, "read-only");
  assert.equal(child.delegation, false);
  assert.equal(engine.enabledFor(child), false);
  assert.throws(
    () => service.updateSession(child.id, { delegation: true }),
    /child cannot delegate/,
  );
  assert.throws(
    () => service.tasks.create(child.id, { objective: "Grandchild" }),
    /cannot delegate further/,
  );
  // A native harness is never silently promised delegation.
  assert.throws(
    () => service.delegationGate({ harness: "pi" }, true),
    /Direct chat/,
  );
  assert.equal(service.delegationGate({ harness: "direct" }, false), false);
});

test("stopping a parked parent cancels descendants and seals the protocol", async (t) => {
  const script = [
    { toolCalls: [call("d", "delegate", { objective: "Long child" })] },
    { toolCalls: [call("w", "wait_for_tasks", {})] },
  ];
  const { service, sid } = fixture(t, async ({ session, emit, signal }) => {
    if (session.taskId) {
      emit({ type: "delta", value: "partial" });
      return stopper(signal);
    }
    const step = script.shift();
    if (!step) throw new Error("script exhausted");
    return step;
  });
  service.send(sid, "wait for it");
  await until(() => service.delegation.pendingRound(sid)?.status === "waiting");
  const task = service.tasks.list(sid)[0];
  service.cancel(sid);
  await until(() => service.store.session(sid).status === "stopped");
  await until(() => service.tasks.find(task.id).status === "canceled");
  await until(() => service.scheduler.active.size === 0);
  assert.equal(
    service.delegation.openRound(sid),
    undefined,
    "no round survives",
  );
  const result = answer(service, sid);
  assert.equal(result.status, "stopped");
  for (const entry of (result.protocol || []).filter(
    (e) => e.role === "assistant",
  ))
    for (const c of entry.tool_calls)
      assert.ok(
        result.protocol.some(
          (e) => e.role === "tool" && e.tool_call_id === c.id,
        ),
        "an unanswered tool call would corrupt the next request",
      );
});

test("wait budget expiry resumes the parent and closes outstanding children", async (t) => {
  const script = [
    { toolCalls: [call("d", "delegate", { objective: "Slow child" })] },
    { toolCalls: [call("w", "wait_for_tasks", { timeout_seconds: 15 })] },
    { text: "Reported partial state." },
  ];
  const { service, sid } = fixture(t, async ({ session, emit, signal }) => {
    if (session.taskId) return stopper(signal);
    const step = script.shift();
    if (!step) throw new Error("script exhausted");
    if (step.text) emit({ type: "delta", value: step.text });
    return step;
  });
  service.send(sid, "delegate and wait");
  await until(() => service.delegation.pendingRound(sid)?.status === "waiting");
  const round = service.delegation.pendingRound(sid);
  const child = service.tasks.list(sid)[0];
  round.waitUntil = Date.now() - 1;
  service.delegation.enforceBudgets();
  await until(() => service.store.session(sid).status === "idle");
  assert.equal(script.length, 0, "the parent was resumed and answered");
  assert.equal(round.status, "complete");
  assert.equal(round.final, true);
  assert.match(round.error, /wait budget expired/);
  assert.match(toolReplies(service, sid).at(-1).content, /were canceled/);
  assert.match(answer(service, sid).content, /Reported partial state/);
  // The turn ends without orphaned children holding slots.
  await until(() => service.scheduler.active.size === 0);
  assert.equal(service.tasks.find(child.id).status, "canceled");
});

test("provider rounds are bounded and the last round can only summarize", async (t) => {
  let rounds = 0;
  const { service, sid } = fixture(t, async ({ session, emit, tools }) => {
    if (session.taskId) {
      emit({ type: "delta", value: "done" });
      return { text: "done" };
    }
    rounds += 1;
    if (rounds > LIMITS.rounds) throw new Error("the round cap failed");
    if (rounds === LIMITS.rounds)
      assert.deepEqual(
        tools,
        [],
        "the final summary round must not offer tools",
      );
    // A model that never stops delegating still terminates.
    return {
      toolCalls: [
        call(`c${rounds}`, "task_status", {}),
        call(`w${rounds}`, "wait_for_tasks", {}),
      ],
    };
  });
  service.send(sid, "loop forever");
  await until(() => service.store.session(sid).status === "idle");
  assert.equal(rounds, LIMITS.rounds);
  const result = answer(service, sid);
  assert.equal(result.status, "complete");
  assert.equal(service.delegation.openRound(sid), undefined);
  assert.ok(
    toolReplies(service, sid).some((e) =>
      /budget for this turn is spent/i.test(e.content),
    ),
    "the model is told the calls were refused",
  );
  assert.equal(service.store.data.tasks.length, 0, "no child was ever started");
});

test("the elapsed turn budget aborts an in-flight delegation round", async (t) => {
  const { service, sid } = fixture(t, async ({ session, signal }) => {
    if (session.taskId) return { text: "child" };
    return stopper(signal);
  });
  service.send(sid, "slow delegation");
  await until(() => service.delegation.openRound(sid)?.status === "running");
  service.delegation.openRound(sid).deadline = Date.now() - 1;
  service.delegation.enforceBudgets();
  await until(() => service.store.session(sid).status === "stopped");
  assert.equal(service.delegation.openRound(sid), undefined);
  assert.match(service.store.data.delegations.at(-1).error, /elapsed budget/);
  await until(() => service.scheduler.active.size === 0);
});

test("restart marks rounds interrupted and keeps the transcript protocol-valid", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-delegation-restart-"));
  const script = [
    { toolCalls: [call("d", "delegate", { objective: "Alive at shutdown" })] },
    { toolCalls: [call("w", "wait_for_tasks", {})] },
  ];
  const first = new AgentService(dir, {
    runner: async ({ session, signal }) => {
      if (session.taskId) return stopper(signal);
      const step = script.shift();
      if (!step) throw new Error("script exhausted");
      return step;
    },
    memorySource: () => ({ availableGiB: 100, totalGiB: 128 }),
    runtimeSource: () => null,
  });
  first.store.data.models = [structuredClone(model)];
  const sid = first.create({
    modelId: "fixture",
    harness: "direct",
    delegation: true,
  });
  first.send(sid, "wait");
  await until(() => first.delegation.pendingRound(sid)?.status === "waiting");
  first.store.save();
  first.close();
  const reopened = new Store(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const round = reopened.data.delegations.at(-1);
  assert.equal(round.status, "interrupted");
  assert.match(round.error, /not replayed/);
  assert.equal(reopened.data.tasks[0].status, "interrupted");
  assert.equal(reopened.data.tasks[0].automated, true);
  const session = reopened.session(sid);
  assert.equal(session.status, "interrupted");
  assert.equal(session.delegationRoundId, undefined);
  const result = session.messages.at(-1);
  assert.equal(result.status, "interrupted");
  assert.ok(
    result.protocol.some((e) => e.role === "tool" && e.tool_call_id === "w"),
    "recovery supplies the missing tool result",
  );
  // A resumed conversation must never resend an unanswered tool call.
  session.messages.push({ role: "user", content: "next", createdAt: "now" });
  session.messages.push({ role: "assistant", content: "", createdAt: "now" });
  const history = openaiHistory(session);
  const dangling = history
    .filter((m) => m.role === "assistant" && m.tool_calls)
    .flatMap((m) => m.tool_calls)
    .filter(
      (c) => !history.some((m) => m.role === "tool" && m.tool_call_id === c.id),
    );
  assert.equal(dangling.length, 0);
});

test("protocol helpers drop dangling calls and seal unanswered ones", () => {
  const result = {
    protocol: [
      {
        role: "assistant",
        content: "thinking aloud",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "task_status", arguments: "{}" },
          },
          {
            id: "b",
            type: "function",
            function: { name: "wait_for_tasks", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "ok" },
    ],
  };
  // While unfinished, the unanswered call is not sent back to the endpoint.
  assert.deepEqual(
    protocolMessages(result.protocol).map((m) => m.role),
    ["assistant", "tool"],
  );
  assert.deepEqual(
    protocolMessages(result.protocol)[0].tool_calls.map((c) => c.id),
    ["a"],
  );
  sealProtocol(result);
  assert.equal(result.protocol.length, 3);
  assert.match(result.protocol.at(-1).content, /stopped/);
  assert.equal(
    protocolMessages(result.protocol)[0].tool_calls.length,
    2,
    "a sealed turn resends complete call/result pairs",
  );
  sealProtocol(result);
  assert.equal(
    result.protocol.length,
    3,
    "sealing twice does not duplicate results",
  );
});

test("the real SSE transport assembles streamed calls and offers them only when opted in", async (t) => {
  const requests = [];
  const chunks = [
    { delta: { content: "Let me " } },
    {
      delta: {
        tool_calls: [{ index: 0, id: "a", function: { name: "delegate" } }],
      },
    },
    { delta: { tool_calls: [{ index: 0, function: { arguments: '{"obj' } }] } },
    {
      delta: {
        tool_calls: [{ index: 0, function: { arguments: 'ective":"Look' } }],
      },
    },
    {
      delta: { tool_calls: [{ index: 0, function: { arguments: ' at B"}' } }] },
    },
    { delta: {}, finish_reason: "tool_calls" },
  ];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const piece of req) body += piece;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const part of chunks)
      res.write(`data: ${JSON.stringify({ choices: [part] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const fixtureModel = { model: "fake", context: 32768, endpoint };
  const session = {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "" },
    ],
  };
  const withTools = await runDirect({
    session,
    model: fixtureModel,
    prompt: "go",
    tools: toolSpecs,
    signal: new AbortController().signal,
    emit: () => {},
  });
  assert.equal(requests[0].tools.length, 4);
  assert.equal(requests[0].tool_choice, "auto");
  assert.deepEqual(
    compileToolCall(withTools.toolCalls[0]).args.objective,
    "Look at B",
  );
  // A session without opt-in sends no tools field at all.
  await runDirect({
    session,
    model: fixtureModel,
    prompt: "go",
    signal: new AbortController().signal,
    emit: () => {},
  });
  assert.equal(requests[1].tools, undefined);
  assert.equal(requests[1].tool_choice, undefined);
});

test("the subagent skill is only delivered when delegation is really available", () => {
  const data = { hooks: bundledSkills() };
  const off = resolveSkills(data, {
    hookIds: ["subagents"],
    harness: "direct",
    delegation: false,
  });
  assert.equal(off.skills.length, 0);
  assert.match(off.warnings.join(" "), /unavailable \(delegation\)/);
  const native = resolveSkills(data, {
    hookIds: ["subagents"],
    harness: "pi",
    delegation: true,
  });
  assert.equal(native.skills.length, 0);
  assert.match(native.warnings.join(" "), /not supported/);
  const on = resolveSkills(data, {
    hookIds: ["subagents"],
    harness: "direct",
    delegation: true,
  });
  assert.equal(on.skills.length, 1);
  assert.match(on.warnings.join(" "), /experimental/);
});

test("tool batches enforce per-round and remaining-turn budgets without duplicate calls", async (t) => {
  const { service, sid } = fixture(t, async () => ({ text: "done" }));
  const session = service.store.session(sid);
  const message = { id: "budget-answer", role: "assistant", content: "" };
  session.messages.push(message);
  const round = service.delegation.begin({
    session,
    answer: message,
    prompt: "test",
  });
  for (const used of [0, 8]) {
    round.calls = used;
    message.protocol = [];
    const actions = service.delegation.compile({
      round,
      session,
      emit() {},
      outcome: {
        toolCalls: Array.from({ length: 9 }, (_, i) =>
          call(`call_${i}`, "task_status", {}),
        ),
      },
    });
    assert.equal(actions.filter((a) => a.ok).length, Math.min(6, 10 - used));
    assert.equal(
      new Set(message.protocol[0].tool_calls.map((c) => c.id)).size,
      9,
    );
    assert.equal(message.protocol[0].tool_calls.length, 9);
  }
});

test("parked waits count toward the provider round limit", async (t) => {
  let turns = 0;
  const { service, sid } = fixture(t, async ({ session, tools, emit }) => {
    if (session.taskId) return { text: "child done" };
    turns++;
    if (turns === LIMITS.rounds) {
      assert.equal(tools.length, 0);
      emit({ type: "delta", value: "finished" });
      return { text: "finished" };
    }
    assert.ok(turns < LIMITS.rounds);
    return {
      toolCalls: [
        call(`d${turns}`, "delegate", { objective: "Inspect" }),
        call(`w${turns}`, "wait_for_tasks", {}),
      ],
    };
  });
  service.send(sid, "bounded work");
  const sentAt = service.store.session(sid).updatedAt;
  await until(() => service.store.session(sid).status === "idle");
  assert.equal(turns, LIMITS.rounds);
  assert.ok(service.store.session(sid).updatedAt > sentAt);
});

test("unindexed interleaved tool fragments resolve by call identity", () => {
  const accumulator = new ToolCallAccumulator();
  accumulator.feed([
    { id: "a", function: { name: "task_status", arguments: "{" } },
    { id: "b", function: { name: "wait_for_tasks", arguments: "{}" } },
  ]);
  accumulator.feed([{ id: "a", function: { arguments: "}" } }]);
  assert.deepEqual(
    accumulator.completed().map((c) => c.arguments),
    ["{}", "{}"],
  );
});

test("multiple waits in one batch retain every requested child", async (t) => {
  const { service, sid } = fixture(t, async () => ({ text: "done" }));
  const session = service.store.session(sid);
  const message = { id: "wait-answer", role: "assistant", content: "" };
  session.messages.push(message);
  const round = service.delegation.begin({
    session,
    answer: message,
    prompt: "test",
  });
  const ids = ["a", "b"];
  service.store.data.tasks.push(
    ...ids.map((id) => ({ id, status: "running", parentSessionId: sid })),
  );
  service.delegation.invoke = async ({ action }) => ({
    wait: true,
    taskIds: [action.id],
    seconds: action.id === "a" ? 15 : 30,
  });
  await service.delegation.run({
    round,
    session,
    actions: ids.map((id) => ({ id, name: "wait_for_tasks", ok: true })),
    emit() {},
  });
  assert.deepEqual(round.waitingOn, ids);
  assert.deepEqual(round.waitCallIds, ids);
  assert.ok(round.waitUntil <= Date.now() + 15000);
});
