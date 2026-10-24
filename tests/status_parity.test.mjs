// Cross-layer checks: the renderer's delegation opt-in rule and status labels must
// agree with the real backend gate, and the snapshot must actually carry the records
// the status UI reads. Fixtures + a throwaway data dir only: no model, no network,
// no Electron, no shared dist build.
//   node --test tests/status_parity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { transformSync } from "esbuild";
import { AgentService } from "../electron/service.mjs";
import { capabilities, DELEGATION_WARNING } from "../electron/skills.mjs";

const root = resolve(import.meta.dirname, "..");
const transpile = (file) =>
  "data:text/javascript;base64," +
  Buffer.from(
    transformSync(readFileSync(join(root, file), "utf8"), {
      loader: "ts",
      format: "esm",
    }).code,
  ).toString("base64");
const { delegationOptIn, deriveSessionStatus, statusLabelFor } = await import(
  transpile("src/features/status/sessionStatus.ts")
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

function serviceFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-status-"));
  const service = new AgentService(dir, {
    runner: async function* () {
      yield { type: "text", value: "unused" };
    },
    memorySource: () => ({ availableGiB: 100, totalGiB: 128 }),
    runtimeSource: () => null,
  });
  // One custom Direct model plus one profile per native harness, so validatePair
  // accepts the harness and only the delegation gate is under test.
  service.store.data.models = [
    structuredClone(model),
    ...["pi", "opencode", "hermes"].map((harness) => ({
      ...structuredClone(model),
      id: `profile-${harness}`,
      name: `${harness} profile`,
      harness,
      // Unmanaged fixture profiles: no LocalAi runtime is consulted.
      managed: false,
      installed: true,
    })),
  ];
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}

// The exact rejection text the backend throws for each refused route.
const refused = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

test("delegation is off until a Direct session asks for it", (t) => {
  const service = serviceFixture(t);
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  assert.equal(service.store.session(sid).delegation, false);
  assert.equal(
    delegationOptIn({ session: service.store.session(sid) }).enabled,
    false,
  );

  // Turning it on is an explicit, per-session patch — never a default.
  service.updateSession(sid, { delegation: true });
  assert.equal(service.store.session(sid).delegation, true);
  assert.equal(
    delegationOptIn({ session: service.store.session(sid) }).enabled,
    true,
  );

  // A fork must not silently inherit an experimental capability.
  const forked = service.fork(sid);
  assert.equal(service.store.session(forked).delegation, false);
});

test("UI availability matches backend rejection for every route", (t) => {
  const service = serviceFixture(t);
  // Only the harness ids Relay actually offers; hermes needs write permission.
  for (const harness of ["direct", "pi", "opencode", "hermes"]) {
    const sid = service.create({
      modelId: harness === "direct" ? "fixture" : `profile-${harness}`,
      harness,
      permission: harness === "hermes" ? "workspace-write" : "read-only",
    });
    const session = service.store.session(sid);
    const gate = delegationOptIn({ session });
    const error = refused(() =>
      service.delegationGate({ harness, taskId: session.taskId }, true),
    );
    assert.equal(
      gate.available,
      !error,
      `${harness}: UI says available=${gate.available}, backend said ${error}`,
    );
    if (error)
      assert.equal(
        gate.reason,
        error,
        `${harness}: UI wording must be the backend wording`,
      );
  }
});

test("a child session and a busy turn are refused the same way in both layers", (t) => {
  const service = serviceFixture(t);
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  const asChild = { ...service.store.session(sid), taskId: "task-1" };
  assert.equal(delegationOptIn({ session: asChild }).available, false);
  assert.equal(
    delegationOptIn({ session: asChild }).reason,
    refused(() =>
      service.delegationGate({ harness: "direct", taskId: "task-1" }, true),
    ),
  );
  const busySession = service.store.session(sid);
  assert.equal(
    delegationOptIn({ session: busySession, busy: true }).available,
    false,
  );
  assert.equal(
    delegationOptIn({ session: busySession, busy: true }).reason,
    refused(() =>
      service.delegationGate({ harness: "direct", busy: true }, true),
    ),
    "busy wording must be the gate's busy message",
  );
  // Idle in both layers: the patch goes through, so the checkbox is not decorative.
  service.updateSession(sid, { delegation: true });
  assert.equal(service.store.session(sid).delegation, true);
});

test("snapshot carries the records the status UI reads, per session", (t) => {
  const service = serviceFixture(t);
  const parent = service.create({
    modelId: "fixture",
    harness: "direct",
    delegation: true,
  });
  const other = service.create({ modelId: "fixture", harness: "direct" });
  const snapshot = service.snapshot();
  assert.ok(Array.isArray(snapshot.delegations), "snapshot.delegations exists");
  assert.ok(Array.isArray(snapshot.tasks), "snapshot.tasks exists");
  assert.equal(
    snapshot.sessions.find((s) => s.id === parent).delegation,
    true,
    "the opt-in flag reaches the renderer",
  );

  // A parked parent is queued with a released slot; only its own round says
  // "waiting for children", and it must not leak onto another session.
  snapshot.delegations.push({
    id: "round-1",
    parentSessionId: parent,
    status: "waiting",
    round: 2,
    calls: 2,
    children: ["t1"],
    waitingOn: ["t1"],
  });
  const tasks = [{ id: "t1", parentSessionId: parent, status: "running" }];
  const parked = snapshot.sessions.find((s) => s.id === parent);
  parked.status = "queued";
  assert.equal(
    statusLabelFor(parked, snapshot.delegations, tasks),
    "Waiting for children",
  );
  assert.equal(
    statusLabelFor(
      snapshot.sessions.find((s) => s.id === other),
      snapshot.delegations,
      tasks,
    ),
    "Ready",
    "another session never inherits the waiting state",
  );
  // Terminal rounds stop reporting waiting even while status is still queued.
  snapshot.delegations[0].status = "complete";
  assert.equal(
    statusLabelFor(parked, snapshot.delegations, tasks),
    "Queued",
    "a finished round cannot hold the parent in waiting",
  );
});

test("the capability rule shared with skill delivery agrees with the UI gate", (t) => {
  const service = serviceFixture(t);
  for (const harness of ["direct", "pi", "opencode"]) {
    for (const requested of [false, true]) {
      const sid = service.create({
        modelId: harness === "direct" ? "fixture" : `profile-${harness}`,
        harness,
      });
      // Requested on a route the gate refuses must fail closed, not half-enable.
      if (requested)
        refused(() => service.updateSession(sid, { delegation: true }));
      else service.updateSession(sid, { delegation: false });
      const session = service.store.session(sid);
      const gate = delegationOptIn({ session });
      // capabilities() is what decides whether the subagent skill is sent at all.
      assert.equal(
        capabilities(session).delegation,
        gate.enabled && gate.available,
        `${harness}/requested=${requested}: UI and skill delivery must agree`,
      );
      if (gate.enabled)
        assert.match(
          gate.reason,
          /not qualified with a live model/,
          "the UI must stay as modest as DELEGATION_WARNING",
        );
    }
  }
  assert.match(DELEGATION_WARNING, /experimental/);
});

test("status never claims a measurement the snapshot did not provide", (t) => {
  const service = serviceFixture(t);
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  const session = { ...service.store.session(sid), status: "running" };
  const view = deriveSessionStatus({ session });
  assert.equal(view.label, "Generating");
  assert.doesNotMatch(
    `${view.label} ${view.reason} ${view.action}`,
    /tokens|GiB|\/\s*min|measured|RSS/,
    "lifecycle text must not invent usage or memory numbers",
  );
});
