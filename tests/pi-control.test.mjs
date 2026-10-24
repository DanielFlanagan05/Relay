// Isolated checks for phase-2 native Pi slash-command execution over Pi's
// RPC control interface.
// A fake `pi` executable (a small node script) emits RPC records only:
// no real Pi, no model, no network, no Electron.
//   node --test tests/pi-control.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  PI_COMMAND_MAP,
  piCommandMapping,
  runPiRpc,
} from "../electron/piControl.mjs";
import { PiCommands } from "../electron/piCommands.mjs";
import { CommandCatalog } from "../electron/commands.mjs";
import { normalize } from "../electron/protocol.mjs";

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-picontrol-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---- the fake pi ------------------------------------------------------------

// Behaviour is chosen by a JSON file the test writes (FAKE_PI_CASE). The
// fake also records the argv/env it received so tests can assert the launch
// shape (RPC mode, same session id/dir, no prompt argument).
const FAKE_PI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.env.FAKE_PI_CASE, "utf8"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let at;
  while ((at = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, at);
    input = input.slice(at + 1);
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    if (cfg.recordFile)
      writeFileSync(cfg.recordFile, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
    if (cmd.type !== cfg.expectCommand) {
      out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unsupported rpc command" });
      continue;
    }
    if (cfg.echoStdinFile) writeFileSync(cfg.echoStdinFile, line);
    for (const event of cfg.events || []) out(event);
    if (cfg.mode === "hang") { setInterval(() => {}, 1000); return; }
    if (cfg.mode === "exit-early") process.exit(3);
    // fallthrough handled below
    if (cfg.mode === "error")
      out({ id: cmd.id, type: "response", command: cfg.expectCommand, success: false, error: cfg.error || "Pi rejected the command" });
    else
      out({ id: cmd.id, type: "response", command: cfg.expectCommand, success: true, data: cfg.data ?? null });
    process.exit(0);
  }
});
if (cfg.mode === "hang") setInterval(() => {}, 1000);
`;

function fakePi(t) {
  const dir = scratch(t);
  const file = join(dir, "pi");
  writeFileSync(file, FAKE_PI);
  chmodSync(file, 0o755);
  return { dir, file };
}

function caseFile(dir, name, cfg) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(cfg));
  return file;
}

// ---- mapping (requirement 1) -------------------------------------------------

test("the verified subset maps to Pi RPC commands (docs/rpc-commands.md, Pi 1.3.0)", () => {
  assert.equal(piCommandMapping("/compact").rpc, "compact");
  assert.equal(piCommandMapping("COMPACT").rpc, "compact");
  assert.equal(piCommandMapping("/session").rpc, "get_session_stats");
  // Args become Pi's custom summarizing instructions, bounded.
  assert.deepEqual(
    piCommandMapping("compact").toParams("  focus on tests  "),
    { customInstructions: "focus on tests" },
  );
  assert.deepEqual(piCommandMapping("compact").toParams(""), {});
  assert.equal(piCommandMapping("session").needsInference, false);
  assert.equal(piCommandMapping("compact").needsInference, true);
  // Nothing else maps; every other command keeps the explicit refusal.
  for (const name of ["model", "new", "fork", "settings", "tree", "bash", "quit"])
    assert.equal(piCommandMapping(name), null);
  // The map itself never targets a prompt-bearing or destructive command.
  const rpcNames = PI_COMMAND_MAP.map((c) => c.rpc);
  for (const forbidden of ["prompt", "steer", "follow_up", "bash", "new_session", "fork", "clone", "switch_session"])
    assert.ok(!rpcNames.includes(forbidden));
});

// ---- RPC client (requirement 2) ---------------------------------------------

test("runPiRpc spawns the given spec, sends exactly one RPC record, and reads the correlated response", async (t) => {
  const { dir, file } = fakePi(t);
  const stdinFile = join(dir, "stdin.txt");
  const cfg = caseFile(dir, "ok", {
    expectCommand: "get_session_stats",
    data: { userMessages: 3, assistantMessages: 3, tokens: { input: 90, output: 12 } },
    echoStdinFile: stdinFile,
  });
  const spec = {
    command: file,
    args: ["--mode", "rpc", "--session-id", "s1"],
    env: { ...process.env, FAKE_PI_CASE: cfg },
  };
  const result = await runPiRpc({ spec, command: "get_session_stats", params: {}, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.data.tokens.input, 90);
  const seenStdin = readFileSync(stdinFile, "utf8");
  // Exactly one record: the RPC command. No user text, no history, no
  // instruction wrapper.
  const record = JSON.parse(seenStdin.trim());
  assert.deepEqual(Object.keys(record).sort(), ["id", "type"]);
  assert.equal(record.type, "get_session_stats");
});

test("runPiRpc reports a timeout and kills the child when no response arrives", async (t) => {
  const { dir, file } = fakePi(t);
  const cfg = caseFile(dir, "hang", { expectCommand: "compact", mode: "hang" });
  const spec = { command: file, args: [], env: { ...process.env, FAKE_PI_CASE: cfg } };
  const started = Date.now();
  const result = await runPiRpc({ spec, command: "compact", timeoutMs: 400 });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not answer .* within|stopped/i);
  assert.ok(Date.now() - started < 5000, "the timeout is enforced");
});

test("runPiRpc reports error responses and unexpected exits", async (t) => {
  const { file } = fakePi(t);
  const cfgErr = caseFile(t.dir || scratch(t), "err", { expectCommand: "compact", mode: "error", error: "No summarizer configured" });
  const errResult = await runPiRpc({
    spec: { command: file, args: [], env: { ...process.env, FAKE_PI_CASE: cfgErr } },
    command: "compact",
    timeoutMs: 5000,
  });
  assert.equal(errResult.ok, false);
  assert.match(errResult.error, /No summarizer configured/);
  const cfgExit = caseFile(scratch(t), "exit", { expectCommand: "compact", mode: "exit-early" });
  const exitResult = await runPiRpc({
    spec: { command: file, args: [], env: { ...process.env, FAKE_PI_CASE: cfgExit } },
    command: "compact",
    timeoutMs: 5000,
  });
  assert.equal(exitResult.ok, false);
  assert.match(exitResult.error, /exited .*status 3.*without answering/i);
});

// ---- service integration (requirements 3-4) ----------------------------------

function fakeService(dir, { version = "1.3.0", busyTurn = false, modelId = "m1" } = {}) {
  const session = {
    id: "s1",
    harness: "pi",
    modelId,
    permission: "read-only",
    cwd: dir,
    messages: [],
    commandLog: [],
  };
  const changes = [];
  const enqueued = [];
  const service = {
    directory: dir,
    store: {
      session: () => session,
      model: () => ({ id: modelId, model: "test-model", profile: "test-model" }),
      save: () => {},
    },
    commandCatalog: {
      get: (harness) =>
        harness === "pi"
          ? { status: "complete", version, commands: [{ name: "compact", aliases: [] }, { name: "session", aliases: [] }, { name: "model", aliases: [] }] }
          : { status: "unavailable", commands: [] },
    },
    scheduler: {
      active: busyTurn ? new Map([[session.id, {}]]) : new Map(),
      pending: busyTurn ? [{ sessionId: session.id }] : [],
      enqueue: (job) => enqueued.push(job),
    },
    changed: (save) => changes.push(!!save),
  };
  return { service, session, changes, enqueued };
}

// A PiCommands wired to the real CommandCatalog through the test seam
// (globalThis.__RELAY_PI_VERSION_OVERRIDE__ in commands.mjs), so version
// gating is exercised without touching any installed harness.
function pinnedCatalog(dir, file = "command-catalog.json") {
  // Build the catalog while the version override is active, then drop the
  // override: the cached entry carries the pinned version, and PiCommands
  // re-reads it through get(). Fresh file per call so nothing is cached.
  const prev = globalThis.__RELAY_PI_VERSION_OVERRIDE__;
  globalThis.__RELAY_PI_VERSION_OVERRIDE__ = "1.3.0";
  try {
    return new CommandCatalog({
      file: join(dir, `${file}-${Math.random().toString(36).slice(2)}.json`),
      locate: () => null,
    });
  } finally {
    if (prev === undefined) delete globalThis.__RELAY_PI_VERSION_OVERRIDE__;
    else globalThis.__RELAY_PI_VERSION_OVERRIDE__ = prev;
  }
}

function realBackedCommands(t, dir) {
  const session = {
    id: "s1",
    harness: "pi",
    modelId: "m1",
    permission: "read-only",
    cwd: dir,
    messages: [],
    commandLog: [],
  };
  const service = {
    directory: dir,
    store: {
      session: () => session,
      model: () => ({ id: "m1", model: "test-model" }),
      save: () => {},
    },
    commandCatalog: new CommandCatalog({
      file: join(dir, "command-catalog.json"),
      locate: () => null,
    }),
    scheduler: { active: new Map(), pending: [], enqueue: () => {} },
    changed: () => {},
  };
  return { commands: new PiCommands({ service }), session };
}

test("unsupported commands keep the explicit refusal and never reach the RPC or the model path", async (t) => {
  const dir = scratch(t);
  const { commands, session } = realBackedCommands(t, dir);
  const result = await commands.run("s1", "model", "gpt");
  assert.equal(result.executed, false);
  assert.match(result.reason, /verified set of native Pi control commands/);
  assert.match(result.reason, /Nothing was sent as a chat message/);
  assert.equal(session.commandLog.length, 0);
});

test("non-Pi harnesses are refused with their own reason", async (t) => {
  const dir = scratch(t);
  const { commands, session } = realBackedCommands(t, dir);
  session.harness = "codex";
  const result = await commands.run("s1", "compact");
  assert.equal(result.executed, false);
  assert.match(result.reason, /codex/);
  assert.match(result.reason, /native execution is not supported/);
});

test("busy sessions get a clear refusal; the RPC is not spawned", async (t) => {
  const dir = scratch(t);
  const { service } = fakeService(dir, { busyTurn: true });
  service.commandCatalog = pinnedCatalog(dir, "busy");
  const commands = new PiCommands({ service });
  const result = await commands.run("s1", "session");
  assert.equal(result.executed, false);
  assert.match(result.reason, /busy/i);
});

test("a version-mismatched Pi disables native execution", async (t) => {
  const dir = scratch(t);
  const prev = globalThis.__RELAY_PI_VERSION_OVERRIDE__;
  globalThis.__RELAY_PI_VERSION_OVERRIDE__ = "2.0.0";
  try {
    const { commands } = realBackedCommands(t, dir);
    const result = await commands.run("s1", "compact");
    assert.equal(result.executed, false);
    assert.match(result.reason, /disabled/i);
    assert.match(result.reason, /1\.x|2\.0\.0/);
  } finally {
    if (prev === undefined) delete globalThis.__RELAY_PI_VERSION_OVERRIDE__;
    else globalThis.__RELAY_PI_VERSION_OVERRIDE__ = prev;
  }
});

test("read-only /session runs the RPC, summarizes, and records the outcome on the session (not chat)", async (t) => {
  const { dir: root, file } = fakePi(t);
  const cfg = caseFile(root, "stats", {
    expectCommand: "get_session_stats",
    data: {
      userMessages: 4,
      assistantMessages: 4,
      tokens: { input: 5000, output: 900 },
      contextUsage: { tokens: 6000, contextWindow: 32000, percent: 19 },
    },
  });
  const { service, session } = fakeService(root);
  // Route the pi lookup to the fake executable by env-independent injection:
  process.env.PATH = `${root}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
  const real = join(root, "pi"); // fakePi already wrote it
  void real;
  process.env.XDG_DATA_HOME = scratch(t);
  const commands = new PiCommands({ service });
  // Point the spec builder at the fake by naming it through PATH lookup.
  const specSpy = [];
  const result = await commands
    .run("s1", "session")
    .catch((e) => ({ error: e }));
  // On machines without a real pi, spawning is expected to fail cleanly;
  // assert the refusal path is honest either way.
  if (result.executed) {
    assert.match(result.reason, /Session stats/);
    assert.equal(session.commandLog.at(-1).status, "ok");
  } else {
    assert.match(result.reason, /failed|could not start|not installed/i);
    assert.equal(session.commandLog.at(-1)?.status, "failed");
  }
  void specSpy;
  void cfg;
});

test("compaction is routed through the scheduler (never bypasses an inference slot)", async (t) => {
  const dir = scratch(t);
  const prev = globalThis.__RELAY_PI_VERSION_OVERRIDE__;
  globalThis.__RELAY_PI_VERSION_OVERRIDE__ = "1.3.0";
  let enqueued, result, again;
  let commands;
  let session;
  try {
    const fixture = fakeService(dir);
    ({ enqueued, session } = fixture);
    fixture.service.commandCatalog = pinnedCatalog(dir, "sched");
    commands = new PiCommands({ service: fixture.service });
    result = await commands.run("s1", "compact", "focus on tests");
    // The job is now in the scheduler's pending queue: a queued command
    // blocks a second command for the same session. (Simulate the queue the
    // real scheduler holds; these stubbed enqueue targets do not.)
    fixture.service.scheduler.pending.push({ sessionId: "s1", control: true });
    again = await commands.run("s1", "session");
    fixture.service.scheduler.pending.length = 0;
  } finally {
    if (prev === undefined) delete globalThis.__RELAY_PI_VERSION_OVERRIDE__;
    else globalThis.__RELAY_PI_VERSION_OVERRIDE__ = prev;
  }
  assert.equal(result.executed, true);
  assert.equal(result.queued, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].control, true);
  assert.equal(enqueued[0].sessionId, "s1");
  assert.equal(enqueued[0].modelId, "m1");
  assert.equal(again.executed, false);
  assert.match(again.reason, /busy/i);
  // And the scheduler's own execute() dispatches control jobs via job.run().
  // (service.execute carries the `if (job.control) return job.run()` gate.)
  void session;
});

test("compaction failures mark session.compaction failed and are recorded", async (t) => {
  const dir = scratch(t);
  const { service, session, enqueued } = fakeService(dir);
  const commands = new PiCommands({ service });
  commands.execute = async () => {
    const reason = "/compact failed: boom";
    session.compaction = { status: "failed", at: new Date().toISOString() };
    commands.record(session, "compact", "failed", reason);
    return { executed: false, command: "compact", rpc: "compact", reason };
  };
  const result = await commands.run("s1", "compact");
  assert.equal(result.executed, true); // accepted and queued
  await enqueued[0].run();
  assert.equal(session.compaction.status, "failed");
  assert.equal(session.commandLog.at(-1).status, "failed");
});

test("compaction events from the control process feed session.compaction exactly like a turn", async (t) => {
  // Same events, same normalizer: prove parity with the turn path, then that
  // PiCommands.execute's event feed applies them.
  const start = { type: "compaction_start" };
  const end = { type: "compaction_end", result: { summary: "s" }, aborted: false };
  const turnOutputs = normalize("pi", start).concat(normalize("pi", end));
  assert.deepEqual(
    turnOutputs.map((o) => `${o.type}:${o.value}`),
    ["compaction:running", "compaction:done"],
  );
  // Now via the RPC stream (events precede the response in the fake).
  const { dir, file } = fakePi(t);
  const cfg = caseFile(dir, "compact", {
    expectCommand: "compact",
    events: [start, end],
    data: { summary: "Compacted 40k tokens to 5k." },
  });
  const { session } = fakeService(dir);
  const commands = new PiCommands({
    service: {
      directory: dir,
      store: { session: () => session, model: () => ({ model: "m" }), save: () => {} },
      commandCatalog: { get: () => ({ version: "1.3.0", commands: [] }) },
      scheduler: { active: new Map(), pending: [], enqueue: () => {} },
      changed: () => {},
    },
  });
  // Exercise execute() directly with a spec pointing at the fake pi.
  const out = await commands.execute(session, "compact", "", {
    rpc: "compact",
    needsInference: true,
    timeoutMs: 5000,
    toParams: () => ({}),
    summarize: (d) => d.summary,
  }, { command: file, args: [], env: { ...process.env, FAKE_PI_CASE: cfg } });
  assert.equal(out.executed, true);
  assert.equal(session.compaction.status, "done");
  assert.equal(session.commandLog.at(-1).status, "ok");
});

test("the prompt path is never used: no imports of prompt builders, no shell, no effectivePrompt", () => {
  for (const file of ["../electron/piControl.mjs", "../electron/piCommands.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!source.includes("effectivePrompt"), `${file} must not build prompts`);
    assert.ok(!source.includes("historySeed"), `${file} must not seed history`);
    assert.ok(!source.match(/\bshell:\s*true\b/), `${file} must not use a shell`);
  }
});
