import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { Store } from "../electron/store.mjs";
import { Scheduler } from "../electron/scheduler.mjs";
import { AgentService } from "../electron/service.mjs";
import { processIdentity } from "../electron/discovery.mjs";
import { lines, normalize } from "../electron/protocol.mjs";
import {
  effectivePrompt,
  runDirect,
  runCLI,
  commandFor,
} from "../electron/adapters.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (predicate) => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for expected state");
};
const directory = (t) => {
  const d = mkdtempSync(join(tmpdir(), "relay-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const model = (extra = {}) => ({
  id: "local:shared-large",
  name: "Shared large model",
  kind: "local",
  model: "shared",
  endpoint: "http://127.0.0.1:8080/v1",
  context: 32768,
  parallel: 2,
  slotGiB: 4,
  ...extra,
});
function serviceFixture(t, runner, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-service-test-"));
  const service = new AgentService(dir, {
    memorySource: () => ({ availableGiB: 100, totalGiB: 128 }),
    runtimeSource: () => null,
    runner,
    ...extra,
  });
  service.store.data.models = [
    model(),
    model({ id: "cloud:test", kind: "cloud", harness: "codex", slotGiB: 0 }),
  ];
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}

test("two sessions on a large shared model run concurrently, third waits, contexts remain isolated", async (t) => {
  const running = [],
    finishes = new Map();
  const service = serviceFixture(t, async ({ session, prompt, emit }) => {
    running.push({ id: session.id, prompt });
    emit({ type: "delta", value: `Answer for ${session.id}` });
    await new Promise((resolve) => finishes.set(session.id, resolve));
  });
  const a = service.create({ modelId: model().id, harness: "direct" });
  const b = service.create({ modelId: model().id, harness: "direct" });
  const c = service.create({ modelId: model().id, harness: "direct" });
  service.send(a, "ALPHA secret");
  service.send(b, "BETA secret");
  service.send(c, "GAMMA secret");
  await tick();
  assert.equal(running.length, 2);
  assert.equal(service.scheduler.pending.length, 1);
  assert.equal(service.store.session(c).status, "queued");
  assert.ok(!running[0].prompt.includes("BETA"));
  assert.ok(!running[1].prompt.includes("ALPHA"));
  finishes.get(a)();
  await until(() => running.length === 3);
  assert.equal(service.store.session(a).status, "idle");
  assert.equal(service.scheduler.active.size, 2);
  finishes.get(b)();
  finishes.get(c)();
  await until(() => service.scheduler.active.size === 0);
});

test("headroom charges per-session cache, not the large weights a second time", async (t) => {
  let available = 20,
    count = 0;
  const releases = [];
  const service = serviceFixture(
    t,
    async () => {
      count++;
      await new Promise((r) => releases.push(r));
    },
    { memorySource: () => ({ availableGiB: available }) },
  );
  service.store.data.models[0].estimatedGiB = 105;
  const a = service.create({ modelId: model().id, harness: "direct" });
  const b = service.create({ modelId: model().id, harness: "direct" });
  service.send(a, "one");
  service.send(b, "two");
  await tick();
  assert.equal(
    count,
    2,
    "resident weights must not be charged per conversation",
  );
  releases.forEach((r) => r());
  await until(() => service.scheduler.active.size === 0);
  available = 10;
  service.send(a, "blocked");
  await tick();
  assert.equal(service.store.session(a).status, "queued");
  assert.match(service.store.session(a).queueReason, /memory/);
  service.cancel(a);
});

test("a blocked local pool does not block cloud; pause leaves active work alone", async (t) => {
  const starts = [];
  const finishes = [];
  const service = serviceFixture(
    t,
    async ({ session }) => {
      starts.push(session.modelId);
      await new Promise((r) => finishes.push(r));
    },
    { memorySource: () => ({ availableGiB: 3 }) },
  );
  const a = service.create({ modelId: model().id, harness: "direct" });
  const b = service.create({ modelId: "cloud:test", harness: "codex" });
  service.scheduler.pause(model().id, true);
  service.send(a, "local");
  service.send(b, "cloud");
  await tick();
  assert.deepEqual(starts, ["cloud:test"]);
  assert.equal(service.scheduler.pending.length, 1);
  service.cancel(a);
  finishes.forEach((r) => r());
  await until(() => service.scheduler.active.size === 0);
});

test("different managed profiles wait during startup instead of racing for the controller", async (t) => {
  const releases = [];
  const service = serviceFixture(t, async () => {
    await new Promise((r) => releases.push(r));
  });
  service.store.data.models = [
    model({ managed: true, installed: true, profile: "alpha" }),
    model({
      id: "managed:beta",
      managed: true,
      installed: true,
      profile: "beta",
    }),
  ];
  const a = service.create({ modelId: model().id, harness: "direct" });
  const b = service.create({ modelId: "managed:beta", harness: "direct" });
  service.send(a, "first");
  service.send(b, "second");
  await tick();
  assert.equal(releases.length, 1);
  assert.equal(service.scheduler.pending.length, 1);
  assert.match(service.store.session(b).queueReason, /managed runtime/);
  releases.shift()();
  await until(() => releases.length === 1);
  releases.shift()();
  await until(() => service.scheduler.active.size === 0);
});

test("cancelling an admitted turn before its microtask never invokes a harness", async (t) => {
  let starts = 0;
  const service = serviceFixture(t, async () => {
    starts++;
  });
  const sid = service.create({ modelId: model().id, harness: "direct" });
  service.send(sid, "cancel immediately");
  service.cancel(sid);
  await tick();
  assert.equal(starts, 0);
  assert.equal(service.store.session(sid).status, "stopped");
});

test("shutdown empties the queue and never pumps another turn", async () => {
  let starts = 0,
    release;
  const scheduler = new Scheduler({
    inspect: () => ({ key: "pool", parallel: 1, local: false }),
    memory: () => ({}),
    reserveGiB: () => 8,
    execute: async () => {
      starts++;
      await new Promise((r) => {
        release = r;
      });
    },
  });
  scheduler.enqueue({
    sessionId: "one",
    modelId: "m",
    controller: new AbortController(),
  });
  scheduler.enqueue({
    sessionId: "two",
    modelId: "m",
    controller: new AbortController(),
  });
  await tick();
  scheduler.close();
  release();
  await tick();
  await tick();
  assert.equal(starts, 1);
  assert.equal(scheduler.pending.length, 0);
});

test("runtime ownership survives reopening and refuses stale process identities", (t) => {
  const service = serviceFixture(t, async () => {}, {
    runtimeSource: () => ({
      profile: "large",
      pid: 999,
      supervisor_pid: process.pid,
    }),
  });
  const path = join(service.directory, "owned-runtime.json");
  writeFileSync(
    path,
    JSON.stringify({
      profile: "large",
      supervisorPid: process.pid,
      supervisorIdentity: processIdentity(process.pid),
    }),
  );
  assert.equal(service.publicRuntime().owned, true);
  writeFileSync(
    path,
    JSON.stringify({
      profile: "large",
      supervisorPid: process.pid,
      supervisorIdentity: "stale",
    }),
  );
  assert.equal(service.publicRuntime().owned, false);
});

test("queued cancellation never invokes a harness", async (t) => {
  let starts = 0;
  const service = serviceFixture(t, async () => {
    starts++;
  });
  service.scheduler.pause(model().id, true);
  const sid = service.create({ modelId: model().id, harness: "direct" });
  service.send(sid, "do not run");
  service.cancel(sid);
  service.scheduler.pause(model().id, false);
  await tick();
  assert.equal(starts, 0);
  assert.equal(service.store.session(sid).status, "stopped");
});

test("active cancellation preserves streamed partial output and releases its slot", async (t) => {
  const service = serviceFixture(t, async ({ signal, emit }) => {
    emit({ type: "delta", value: "Partial output retained" });
    await new Promise((resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("stopped", "AbortError")),
        { once: true },
      ),
    );
  });
  const sid = service.create({ modelId: model().id, harness: "direct" });
  service.send(sid, "begin");
  await tick();
  service.cancel(sid);
  await until(() => service.scheduler.active.size === 0);
  assert.equal(service.store.session(sid).status, "stopped");
  assert.equal(
    service.store.session(sid).messages.at(-1).content,
    "Partial output retained",
  );
});

test("recurring instructions are snapshotted per turn, and disabling applies on next turn", async (t) => {
  const prompts = [];
  const service = serviceFixture(t, async ({ prompt, emit }) => {
    prompts.push(prompt);
    emit({ type: "delta", value: "ok" });
  });
  const sid = service.create({
    modelId: model().id,
    harness: "direct",
    hookIds: ["concise"],
  });
  service.scheduler.pause(model().id, true);
  service.send(sid, "first");
  service.store.data.hooks.find((h) => h.id === "concise").content =
    "CHANGED AFTER QUEUE";
  service.updateSession(sid, { hookIds: [] });
  service.scheduler.pause(model().id, false);
  await until(() => service.scheduler.active.size === 0);
  assert.match(prompts[0], /concise/);
  assert.ok(!prompts[0].includes("CHANGED AFTER QUEUE"));
  service.send(sid, "second");
  await until(() => service.scheduler.active.size === 0);
  assert.match(prompts[1], /No extra instructions/);
  assert.deepEqual(service.store.session(sid).messages[0].hookNames, [
    "Keep it concise",
  ]);
});

test("restart keeps transcripts and marks unfinished work interrupted", (t) => {
  const dir = directory(t);
  const store = new Store(dir);
  const s = store.create({ modelId: "x" });
  s.status = "running";
  s.remoteId = "native-id";
  s.messages.push({
    role: "assistant",
    content: "saved part",
    status: "streaming",
  });
  store.save();
  const reopened = new Store(dir);
  assert.equal(reopened.session(s.id).status, "interrupted");
  assert.equal(reopened.session(s.id).messages[0].content, "saved part");
  assert.equal(reopened.session(s.id).remoteId, "native-id");
});

test("a corrupt primary workspace recovers a valid backup and retains corrupt evidence", (t) => {
  const dir = directory(t);
  const store = new Store(dir);
  const s = store.create({ modelId: "x", title: "important" });
  store.save();
  writeFileSync(store.file, "{corrupted");
  const reopened = new Store(dir);
  assert.equal(reopened.session(s.id).title, "important");
});

test("forks copy history but never reuse native session IDs", async (t) => {
  const service = serviceFixture(t, async ({ emit }) =>
    emit({ type: "delta", value: "Hello" }),
  );
  const sid = service.create({ modelId: model().id, harness: "direct" });
  service.send(sid, "hi");
  await until(() => service.scheduler.active.size === 0);
  service.store.session(sid).remoteId = "native-original";
  const fork = service.store.session(service.fork(sid));
  assert.equal(fork.parentId, sid);
  assert.equal(fork.remoteId, undefined);
  fork.messages[0].content = "changed";
  assert.equal(service.store.session(sid).messages[0].content, "hi");
});

test("a context handoff starts a short independent session and preserves the full source", async (t) => {
  const service = serviceFixture(t, async ({ emit }) =>
    emit({ type: "delta", value: "a long answer" }),
  );
  const sid = service.create({ modelId: model().id, harness: "direct" });
  service.send(sid, "old task");
  await until(() => service.scheduler.active.size === 0);
  const next = service.store.session(
    service.handoff(sid, "Keep the ALPHA goal; implement the parser next."),
  );
  assert.equal(next.messages.length, 1);
  assert.match(next.messages[0].content, /ALPHA/);
  assert.equal(service.store.session(sid).messages.length, 2);
  assert.equal(next.remoteId, undefined);
});

test("the live server capacity caps configured concurrency until a restart", (t) => {
  const service = serviceFixture(t, async () => {}, {
    runtimeSource: () => ({
      profile: "large",
      profile_settings: { sessions: 2 },
    }),
  });
  service.store.data.models[0] = model({
    managed: true,
    profile: "large",
    parallel: 8,
  });
  assert.equal(service.pool(model().id).parallel, 2);
});

test("unsupported model/harness combinations fail before storing a turn", (t) => {
  const service = serviceFixture(t, async () => {});
  assert.throws(
    () => service.create({ modelId: "cloud:test", harness: "direct" }),
    /codex/,
  );
  assert.throws(
    () => service.create({ modelId: model().id, harness: "pi" }),
    /Custom endpoints/,
  );
});

test("changing the workspace rotates native identity to avoid resuming a stale Pi history", (t) => {
  const service = serviceFixture(t, async () => {});
  const sid = service.create({ modelId: model().id, harness: "direct" });
  const s = service.store.session(sid);
  const before = s.nativeId;
  s.remoteId = "old-native";
  service.updateSession(sid, { cwd: service.directory });
  assert.notEqual(s.nativeId, before);
  assert.equal(s.remoteId, undefined);
});

test("JSONL framing handles split UTF-8, LF boundaries, and Unicode separators", async () => {
  const input = Buffer.from('{"text":"café\u2028hello"}\r\n{"done":true}');
  const result = [];
  for await (const line of lines(
    Readable.from([
      input.subarray(0, 13),
      input.subarray(13, 16),
      input.subarray(16),
    ]),
  ))
    result.push(JSON.parse(line));
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "café\u2028hello");
});

test("normalizes installed Pi, Codex, Claude, Hermes, and OpenCode event forms", () => {
  assert.deepEqual(
    normalize("pi", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "pi" },
    }),
    [{ type: "delta", value: "pi" }],
  );
  assert.equal(
    normalize("codex", { type: "thread.started", thread_id: "thread-a" })[0]
      .value,
    "thread-a",
  );
  assert.equal(
    normalize("claude", {
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "claude" } },
    })[0].value,
    "claude",
  );
  assert.equal(
    normalize("hermes", { type: "text", text: "hermes" })[0].value,
    "hermes",
  );
  assert.equal(
    normalize("opencode", {
      type: "text",
      sessionID: "native",
      part: { text: "open" },
    }).at(-1).value,
    "open",
  );
  assert.equal(
    normalize("pi", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "OOM" },
    }).at(-1).type,
    "error",
  );
});

test("real SSE transport restores only its own conversation and includes current instructions", async (t) => {
  let received;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Restored "}}]}\n\n');
    res.write(
      'data: {"choices":[{"delta":{"content":"context"}}],"usage":{"prompt_tokens":44,"completion_tokens":2}}\n\n',
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const session = {
    messages: [
      { role: "user", content: "Session A private context" },
      { role: "assistant", content: "Remembered" },
      { role: "user", content: "current" },
      { role: "assistant", content: "" },
    ],
  };
  const output = [];
  const prompt = effectivePrompt(session, "current", [
    { name: "Rule", content: "Stay concise" },
  ]);
  await runDirect({
    session,
    model: model({
      context: 4096,
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    }),
    prompt,
    signal: new AbortController().signal,
    emit: (event) => output.push(event),
  });
  assert.equal(received.messages.length, 3);
  assert.ok(
    received.max_tokens >= 256 && received.max_tokens < 4096,
    "4K contexts need a smaller output budget",
  );
  assert.equal(received.messages[0].content, "Session A private context");
  assert.match(received.messages.at(-1).content, /Stay concise/);
  assert.equal(
    output
      .filter((e) => e.type === "delta")
      .map((e) => e.value)
      .join(""),
    "Restored context",
  );
  assert.equal(output.at(-1).value.output, 2);
});

test("subprocess transport streams events, captures native ID, and surfaces provider failures", async (t) => {
  const outputs = [];
  const script = `process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'thread.started',thread_id:'native-fixture'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture answer'}})); });`;
  await runCLI({
    session: { harness: "codex", messages: [] },
    model: model(),
    prompt: "hello",
    directory: directory(t),
    signal: new AbortController().signal,
    emit: (e) => outputs.push(e),
    commandFactory: () => ({
      command: process.execPath,
      args: ["-e", script],
      env: process.env,
      input: "hello",
    }),
  });
  assert.equal(outputs[0].value, "native-fixture");
  assert.match(outputs[1].value, /fixture answer/);
  await assert.rejects(
    runCLI({
      session: { harness: "codex", messages: [] },
      model: model(),
      prompt: "hello",
      directory: directory(t),
      signal: new AbortController().signal,
      emit: () => {},
      commandFactory: () => ({
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({type:'error',message:'login expired'}));process.exit(1)`,
        ],
        env: process.env,
      }),
    }),
    /login expired/,
  );
});

test("installed local harness commands select LocalAi configuration instead of account defaults", (t) => {
  const dir = directory(t);
  const m = model({ managed: true, profile: "coding-concurrent" });
  const s = {
    id: "00000000-0000-4000-8000-000000000001",
    permission: "workspace-write",
  };
  const pi = commandFor(
    { ...s, harness: "pi" },
    m,
    "hello",
    dir,
    (name) => `/synthetic/${name}`,
  );
  assert.match(pi.env.PI_CODING_AGENT_DIR, /localai\/pi$/);
  const open = commandFor(
    { ...s, harness: "opencode" },
    m,
    "hello",
    dir,
    (name) => `/synthetic/${name}`,
  );
  assert.match(open.env.OPENCODE_CONFIG, /opencode-coding-concurrent\.json$/);
  const hermes = commandFor(
    { ...s, harness: "hermes" },
    m,
    "hello",
    dir,
    (name) => `/synthetic/${name}`,
  );
  assert.match(hermes.env.HERMES_HOME, /hermes-profiles\/coding-concurrent$/);
  assert.equal(hermes.env.OPENAI_API_KEY, "local-only");
  assert.ok(hermes.args.includes("custom"));
  assert.equal(hermes.input, "hello");
});

test("CLI cancellation waits until the owned process has exited", async t => {
  const controller = new AbortController(); let pid;
  const script = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));console.log(JSON.stringify({type:'thread.started',thread_id:String(process.pid)}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}}));setInterval(()=>{},1000);`;
  await assert.rejects(runCLI({ session: { harness: 'codex', messages: [] }, model: model(), prompt: 'hello', directory: directory(t), signal: controller.signal,
    emit: event => { if (event.type === 'remoteId') pid = Number(event.value); if (event.type === 'delta') controller.abort(); },
    commandFactory: () => ({ command: process.execPath, args: ['-e', script], env: process.env }) }), { name: 'AbortError' });
  assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test("direct transport rejects context overflow without silently discarding history", async () => {
  await assert.rejects(
    runDirect({
      session: {
        messages: [{ role: "user", content: "long".repeat(6000) }, {}, {}],
      },
      model: model({ context: 4096 }),
      prompt: "continue",
      signal: new AbortController().signal,
      emit: () => {},
    }),
    /context window/,
  );
});
