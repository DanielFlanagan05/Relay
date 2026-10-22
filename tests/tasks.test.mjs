import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentService } from "../electron/service.mjs";
import { Store } from "../electron/store.mjs";
const until = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out");
};
function fixture(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), "relay-tasks-"));
  const service = new AgentService(dir, {
    runner,
    memorySource: () => ({ availableGiB: 100, totalGiB: 128 }),
    runtimeSource: () => null,
  });
  service.store.data.models = [
    {
      id: "fixture",
      name: "Fixture",
      kind: "local",
      model: "fake",
      endpoint: "http://127.0.0.1:1/v1",
      parallel: 1,
      slotGiB: 0.25,
      context: 32768,
    },
  ];
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, sid, dir };
}
test("guided children share one slot, get bounded context and collect results without sending", async (t) => {
  const seen = [],
    releases = [];
  const { service, sid } = fixture(t, async ({ session, prompt, emit }) => {
    seen.push({ session: structuredClone(session), prompt });
    await new Promise((r) => releases.push(r));
    emit({ type: "delta", value: "Verified result" });
  });
  service.store.session(sid).messages = [
    { role: "user", content: "PARENT PRIVATE HISTORY" },
  ];
  const a = service.tasks.create(sid, {
      objective: "Inspect A",
      context: "Only this context",
    }),
    b = service.tasks.create(sid, { objective: "Inspect B" });
  await until(() => seen.length === 1);
  assert.equal(service.scheduler.active.size, 1);
  assert.equal(service.scheduler.pending.length, 1);
  assert.equal(seen[0].session.permission, "read-only");
  assert.doesNotMatch(seen[0].prompt, /PARENT PRIVATE/);
  assert.throws(
    () => service.tasks.create(sid, { objective: "Third" }),
    /two child/,
  );
  assert.throws(
    () =>
      service.updateSession(a.childSessionId, {
        permission: "workspace-write",
      }),
    /capabilities/,
  );
  assert.throws(
    () => service.tasks.create(a.childSessionId, { objective: "Grandchild" }),
    /cannot delegate/,
  );
  releases.shift()();
  await until(() => seen.length === 2);
  releases.shift()();
  await until(() => service.scheduler.active.size === 0);
  assert.equal(a.status, "complete");
  assert.equal(b.status, "complete");
  assert.match(service.tasks.collect(sid), /Verified result/);
  assert.equal(service.store.session(sid).messages.length, 1);
});
test("stop tree cancels queued and active children without leaking slots", async (t) => {
  const { service, sid } = fixture(
    t,
    async ({ signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const a = service.tasks.create(sid, { objective: "Active" }),
    b = service.tasks.create(sid, { objective: "Queued" });
  await until(() => a.status === "running");
  service.tasks.cancelTree(sid);
  await until(() => service.scheduler.active.size === 0);
  assert.equal(service.scheduler.pending.length, 0);
  assert.equal(a.status, "canceled");
  assert.equal(b.status, "canceled");
});
test("child failures and deadlines are explicit; restart never replays tasks", async (t) => {
  const { service, sid, dir } = fixture(t, async () => {
    throw new Error("Fixture failure");
  });
  const failed = service.tasks.create(sid, { objective: "Fail" });
  await until(() => failed.status === "failed");
  assert.match(failed.error, /Fixture failure/);
  service.scheduler.pause("fixture", true);
  const expired = service.tasks.create(sid, { objective: "Deadline" });
  expired.deadline = Date.now() - 1;
  service.tasks.enforceDeadlines();
  assert.equal(expired.status, "canceled");
  assert.match(expired.error, /budget/);
  const interrupted = service.tasks.create(sid, { objective: "Restart" });
  service.store.save();
  const restored = new Store(dir);
  assert.equal(
    restored.data.tasks.find((t) => t.id === interrupted.id).status,
    "interrupted",
  );
});
test("foreground requests take priority over queued child work", async (t) => {
  const order = [],
    releases = [];
  const { service, sid } = fixture(t, async ({ session }) => {
    order.push(session.id);
    await new Promise((r) => releases.push(r));
  });
  const a = service.tasks.create(sid, { objective: "First" }),
    b = service.tasks.create(sid, { objective: "Second" });
  await until(() => order.length === 1);
  service.send(sid, "Foreground");
  releases.shift()();
  await until(() => order.length === 2);
  assert.equal(order[1], sid);
  releases.shift()();
  await until(() => order.length === 3);
  assert.equal(order[2], b.childSessionId);
  releases.shift()();
  await until(() => service.scheduler.active.size === 0);
});
