// Isolated checks for the renderer-local status + delegation opt-in rules.
// Fixture objects only: no Electron, no IPC, no model, no network, no dist build.
//   node --test tests/session_status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  join(root, "src/features/status/sessionStatus.ts"),
  "utf8",
);
// Type-only surface disappears at transpile time; the module is pure JS.
const url =
  "data:text/javascript;base64," +
  Buffer.from(
    transformSync(source, { loader: "ts", format: "esm" }).code,
  ).toString("base64");
const {
  deriveSessionStatus,
  delegationOptIn,
  roundFor,
  openRoundFor,
  taskCounts,
} = await import(url);

const session = (overrides = {}) => ({
  id: "s1",
  status: "idle",
  harness: "direct",
  queueReason: "",
  error: "",
  archived: false,
  delegation: false,
  ...overrides,
});
const round = (overrides = {}) => ({
  id: "r1",
  parentSessionId: "s1",
  status: "running",
  round: 2,
  calls: 3,
  children: ["t1", "t2"],
  waitingOn: [],
  ...overrides,
});
const task = (id, status) => ({ id, parentSessionId: "s1", status });

test("every documented lifecycle state has its own truthful label", () => {
  const cases = [
    ["idle", "Ready"],
    ["queued", "Queued"],
    ["loading", "Loading model"],
    ["running", "Generating"],
    ["stopped", "Stopped"],
    ["error", "Failed"],
    ["interrupted", "Interrupted"],
  ];
  for (const [status, label] of cases) {
    const view = deriveSessionStatus({ session: session({ status }) });
    assert.equal(
      view.label,
      label,
      `${status} must render as "${label}", got "${view.label}"`,
    );
    assert.notEqual(view.state, "unknown", `${status} must not be unknown`);
  }
});

test("a parked parent reads as waiting for children, not as a stalled answer", () => {
  const parked = session({
    status: "queued",
    queueReason:
      "Waiting for 2 delegated task(s); the inference slot is released",
  });
  const waiting = round({
    status: "waiting",
    waitingOn: ["t1", "t2"],
    waitUntil: Date.now() + 60000,
  });
  const view = deriveSessionStatus({
    session: parked,
    round: waiting,
    tasks: [task("t1", "running"), task("t2", "queued")],
  });
  assert.equal(view.state, "waiting_children");
  assert.equal(view.label, "Waiting for children");
  assert.match(view.reason, /inference slot is released/);
  assert.match(view.action, /Stop the agent/);
  assert.equal(view.active, true);

  // The same queued session with no waiting round stays an ordinary queue wait.
  const plain = deriveSessionStatus({
    session: session({ status: "queued", queueReason: "All slots busy" }),
  });
  assert.equal(plain.state, "queued");
  assert.equal(plain.reason, "All slots busy", "backend reason is preserved");
});

test("waiting reason counts children from records and reports resumed rounds", () => {
  const waiting = round({ status: "waiting", waitingOn: ["t1", "t2", "t3"] });
  const tasks = [
    task("t1", "complete"),
    task("t2", "running"),
    task("t3", "failed"),
  ];
  const view = deriveSessionStatus({
    session: session({ status: "queued" }),
    round: waiting,
    tasks,
  });
  assert.match(view.reason, /1 delegated task\(s\) still running/);
  assert.match(view.reason, /2 of 3 finished/);

  // A resumed round has cleared waitingOn: say so instead of inventing a count.
  const resumed = deriveSessionStatus({
    session: session({ status: "queued" }),
    round: round({ status: "waiting", waitingOn: [] }),
    tasks: [],
  });
  assert.match(resumed.reason, /Resuming with delegated results/);
});

test("failures and interruptions carry a reason and a non-automatic action", () => {
  const failed = deriveSessionStatus({
    session: session({ status: "error", error: "Provider returned 502" }),
  });
  assert.equal(failed.tone, "danger");
  assert.match(failed.reason, /502/);
  assert.match(failed.action, /edit your last request/i);
  assert.doesNotMatch(
    `${failed.label}${failed.action}`,
    /retrying automatically/i,
  );

  const interrupted = deriveSessionStatus({
    session: session({
      status: "interrupted",
      queueReason:
        "The app closed during this turn. Send a new message to continue.",
    }),
  });
  assert.equal(interrupted.state, "interrupted");
  assert.match(interrupted.action, /not replayed/i);
});

test("unknown or missing data is reported as unknown, never as idle", () => {
  assert.equal(deriveSessionStatus({}).state, "unknown");
  assert.equal(
    deriveSessionStatus({ session: session({ status: "telepathic" }) }).state,
    "unknown",
  );
  // A missing round never fabricates a delegation state.
  assert.equal(
    deriveSessionStatus({ session: session({ status: "running" }) }).state,
    "running",
  );
  assert.equal(
    deriveSessionStatus({ session: session({ status: "running" }) }).label,
    "Generating",
  );
  assert.equal(
    deriveSessionStatus({
      session: session({ status: "running" }),
      round: round({ status: "running", round: 3 }),
    }).label,
    "Delegating",
  );
});

test("a parked parent reads as waiting even when its status already dropped to idle", () => {
  // The durable proof is the round record; the session status alone can be a
  // plain slot wait, and a released slot can briefly read idle.
  const waiting = round({ status: "waiting", waitingOn: ["t1"] });
  const view = deriveSessionStatus({
    session: session({ status: "idle" }),
    round: waiting,
    tasks: [task("t1", "running")],
  });
  assert.equal(view.state, "waiting_children");
  assert.match(view.reason, /1 delegated task\(s\) still running/);
  // Terminal rounds and other rounds never do this.
  assert.equal(
    deriveSessionStatus({
      session: session({ status: "idle" }),
      round: round({ status: "complete" }),
    }).state,
    "idle",
  );
  assert.equal(
    deriveSessionStatus({
      session: session({ status: "stopped" }),
      round: waiting,
    }).state,
    "stopped",
    "a stopped turn is not reported as waiting",
  );
});

test("round lookup takes the open round and stays per-session", () => {
  const rounds = [
    round({ id: "old", status: "complete" }),
    round({ id: "open", status: "waiting" }),
    round({ id: "other", parentSessionId: "s2", status: "waiting" }),
  ];
  assert.equal(openRoundFor("s1", rounds).id, "open");
  assert.equal(openRoundFor("s2", rounds).id, "other");
  assert.equal(openRoundFor("s3", rounds), undefined);
  assert.equal(openRoundFor(undefined, rounds), undefined);
  // With only finished rounds, roundFor still returns the latest for history.
  assert.equal(
    roundFor("s1", [
      round({ id: "a", status: "complete" }),
      round({ id: "b", status: "failed" }),
    ]).id,
    "b",
  );
  assert.equal(roundFor("s1", []), undefined);
});

test("delegation opt-in is off by default and refused off the Direct route", () => {
  assert.equal(delegationOptIn({ session: session() }).enabled, false);
  assert.equal(delegationOptIn({ session: session() }).available, true);

  for (const harness of ["pi", "codex", "claude", "opencode", "hermes"]) {
    const gate = delegationOptIn({ session: session({ harness }) });
    assert.equal(gate.available, false, `${harness} must not offer delegation`);
    assert.match(gate.reason, /Direct chat endpoints/);
    assert.match(gate.reason, /not verified/);
  }

  const child = delegationOptIn({ session: session({ taskId: "t9" }) });
  assert.equal(child.available, false);
  assert.match(child.reason, /child cannot delegate/);

  const busy = delegationOptIn({ session: session(), busy: true });
  assert.equal(busy.available, false);
  assert.match(busy.reason, /Stop the current turn/);

  assert.match(
    delegationOptIn({ session: session({ archived: true }) }).reason,
    /Restore/,
  );
  assert.equal(delegationOptIn({}).available, false);
});

test("opt-in wording stays experimental and never claims qualification", () => {
  const gate = delegationOptIn({ session: session() });
  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /[Ee]xperimental/);
  assert.match(gate.reason, /not qualified with a live model/);
  assert.match(gate.reason, /read-only/);
  assert.doesNotMatch(gate.reason, /verified working|qualified\b(?! with)/);
});

test("task counts come from records", () => {
  const tasks = [
    task("t1", "queued"),
    task("t2", "complete"),
    task("t3", "interrupted"),
  ];
  assert.deepEqual(taskCounts(tasks), { total: 3, open: 1, finished: 2 });
  assert.deepEqual(taskCounts([]), { total: 0, open: 0, finished: 0 });
  assert.deepEqual(taskCounts(), { total: 0, open: 0, finished: 0 });
});
