// Isolated checks for the session context usage derivation.
// Mock usage fixtures only: no Electron, no IPC, no model, no network, no build.
//   node --test tests/context_usage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  join(root, "src/features/context/contextUsageLogic.ts"),
  "utf8",
);
// Type-only surface disappears at transpile time; the module is pure JS.
const url =
  "data:text/javascript;base64," +
  Buffer.from(
    transformSync(source, { loader: "ts", format: "esm" }).code,
  ).toString("base64");
const {
  CHARS_PER_TOKEN,
  computeContextUsage,
  compactionDisplay,
  contextUsageAria,
  estimateRetainedTokens,
  formatContextUsage,
  lastContextMeasurement,
  usagePercent,
} = await import(url);

const model = (context, overrides = {}) => ({
  id: "m1",
  name: "Test model",
  context,
  ...overrides,
});
const user = (overrides = {}) => ({
  id: "u1",
  role: "user",
  content: "hello",
  createdAt: "2026-10-23T10:00:00.000Z",
  ...overrides,
});
const assistant = (overrides = {}) => ({
  id: "a1",
  role: "assistant",
  content: "answer",
  createdAt: "2026-10-23T10:00:05.000Z",
  ...overrides,
});
const session = (...messages) => ({ id: "s1", messages });

test("measured: per-request contextInput is shown as measured, not zeroed", () => {
  const s = session(
    user(),
    assistant({ usage: { contextInput: 24000, scope: "request", output: 300 } }),
  );
  const state = computeContextUsage(s, model(128000));
  assert.equal(state.quality, "measured");
  assert.equal(state.used, 24000);
  assert.equal(state.available, 128000);
  assert.equal(state.stale, false);
  assert.equal(formatContextUsage(state), "24,000 / 128,000 tokens");
});

test("cached input counts once: only the inclusive contextInput is trusted", () => {
  // Turn-scope billing totals (input + cacheRead across several requests)
  // must never be displayed as context occupancy.
  const s = session(
    user(),
    assistant({
      usage: { input: 5000, cacheRead: 20000, scope: "turn", output: 400 },
      turnUsage: { input: 55000, output: 3000 },
      requests: 11,
    }),
  );
  assert.equal(lastContextMeasurement(s.messages), null);
  const state = computeContextUsage(s, model(128000));
  assert.notEqual(state.quality, "measured");
  if (state.used !== null)
    assert.notEqual(
      state.used,
      55000,
      "cumulative turn input must not be shown as occupancy",
    );
});

test("estimated: transcript heuristic includes tools, thinking and the latest instruction snapshot only", () => {
  const s = session(
    user({
      content: "x".repeat(400),
      hookSnapshot: [{ id: "h1", name: "old", content: "y".repeat(4000) }],
    }),
    assistant({
      content: "z".repeat(400),
      thinking: "t".repeat(400),
      tools: [{ name: "read", output: "w".repeat(800), at: "now" }],
    }),
    user({
      content: "q".repeat(400),
      hookSnapshot: [{ id: "h2", name: "new", content: "n".repeat(400) }],
    }),
    assistant({ content: "a".repeat(400) }),
  );
  const state = computeContextUsage(s, model(64000));
  assert.equal(state.quality, "estimated");
  // 4 content blocks of 400 chars + thinking 400 + tool (4+800+8) + latest
  // snapshot only (name+content+8). The stale 4000-char snapshot is excluded.
  const expected = Math.ceil(
    (4 * 400 + 400 + (4 + 800 + 8) + (3 + 400 + 8)) / CHARS_PER_TOKEN,
  );
  assert.equal(state.used, expected);
  assert.match(formatContextUsage(state), /^~[\d,]+ \/ 64,000 tokens$/);
  assert.match(state.detail, /approximate|Estimated/i);
  assert.match(estimateRetainedTokens(s.messages) + "", /^\d+$/);
});

test("unavailable: a fresh session shows no number and never a bare zero", () => {
  const state = computeContextUsage(session(), model(128000));
  assert.equal(state.quality, "unavailable");
  assert.equal(state.used, null);
  assert.equal(formatContextUsage(state), "— / 128,000 tokens");
  assert.match(contextUsageAria(state), /unavailable/i);
  // Empty messages must not estimate to zero either.
  const blank = computeContextUsage(
    session(user({ content: "" }), assistant({ content: "" })),
    model(128000),
  );
  assert.equal(blank.quality, "unavailable");
  assert.equal(blank.used, null);
});

test("stale: a user message newer than the measured request is flagged", () => {
  const s = session(
    user(),
    assistant({ usage: { contextInput: 9000, scope: "request" } }),
    user({ id: "u2", createdAt: "2026-10-23T10:05:00.000Z" }),
  );
  const state = computeContextUsage(s, model(32000));
  assert.equal(state.quality, "measured");
  assert.equal(state.used, 9000);
  assert.equal(state.stale, true);
  assert.match(contextUsageAria(state), /predates/i);
});

test("fresh during a running turn: usage on the streaming answer is not stale", () => {
  const s = session(
    user(),
    assistant({ usage: { contextInput: 9000, scope: "request" } }),
    user({ id: "u2" }),
    assistant({
      id: "a2",
      status: "streaming",
      usage: { contextInput: 9500, scope: "request" },
    }),
  );
  const state = computeContextUsage(s, model(32000));
  assert.equal(state.used, 9500);
  assert.equal(state.stale, false, "the current request itself reported it");
});

test("model/context-limit switch updates capacity, keeps measured usage", () => {
  const s = session(
    user(),
    assistant({ usage: { contextInput: 24000, scope: "request" } }),
  );
  const before = computeContextUsage(s, model(128000));
  const after = computeContextUsage(s, model(32000));
  assert.equal(before.available, 128000);
  assert.equal(after.available, 32000);
  assert.equal(after.used, 24000);
  assert.equal(formatContextUsage(after), "24,000 / 32,000 tokens");
  // Unknown model capacity stays unknown, never a guess.
  assert.equal(computeContextUsage(s, undefined).available, null);
  assert.equal(computeContextUsage(s, model(0)).available, null);
});

test("session switching never carries another session's values across", () => {
  const a = session(
    user(),
    assistant({ usage: { contextInput: 40000, scope: "request" } }),
  );
  const b = session();
  const m = model(128000);
  assert.equal(computeContextUsage(a, m).used, 40000);
  // Switching to a fresh session shows unavailable, not A's 40,000.
  const onB = computeContextUsage(b, m);
  assert.equal(onB.used, null);
  assert.equal(onB.quality, "unavailable");
  // And back to A shows A's own value again.
  assert.equal(computeContextUsage(a, m).used, 40000);
});

test("compaction: running, done (with time), and failure are distinct; nothing is implied", () => {
  assert.equal(compactionDisplay(undefined), null);
  assert.equal(compactionDisplay(null), null);
  assert.equal(compactionDisplay({ status: "maybe", at: "" }), null);
  const running = compactionDisplay({
    status: "running",
    at: "2026-10-23T10:00:00.000Z",
  });
  assert.equal(running.text, "Compacting context…");
  assert.equal(running.tone, "running");
  const done = compactionDisplay({
    status: "done",
    at: "2026-10-23T10:02:00.000Z",
  });
  assert.equal(done.text, "Context compacted");
  assert.match(done.title, /Last compaction/);
  assert.match(done.title, /2026/, "last compaction time is discoverable");
  const failed = compactionDisplay({
    status: "failed",
    at: "2026-10-23T10:04:00.000Z",
  });
  assert.equal(failed.tone, "failed");
  assert.match(failed.text, /fail/i);
  assert.doesNotMatch(failed.text, /compacted$/i);
});

test("usage percent meter only appears when both numbers are known", () => {
  const m = model(100000);
  assert.equal(
    usagePercent(computeContextUsage(
      session(user(), assistant({ usage: { contextInput: 25000 } })), m,
    )),
    25,
  );
  // Overflow clamps instead of drawing a broken meter.
  assert.equal(
    usagePercent(computeContextUsage(
      session(user(), assistant({ usage: { contextInput: 150000 } })), m,
    )),
    100,
  );
  assert.equal(usagePercent(computeContextUsage(session(), m)), null);
  assert.equal(
    usagePercent(computeContextUsage(
      session(user(), assistant({ usage: { contextInput: 10 } })),
      undefined,
    )),
    null,
  );
});

test("wiring: the renderer mounts ContextUsage above the composer with a live region", () => {
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  const component = readFileSync(
    join(root, "src/features/context/ContextUsage.tsx"),
    "utf8",
  );
  assert.match(app, /import \{ ContextUsage \} from "\.\/features\/context\/ContextUsage"/);
  const usageAt = app.indexOf("<ContextUsage session={session} model={model} />");
  const composerAt = app.indexOf(
    '<div className={cx("composer", session.archived && "disabled")}>',
  );
  assert.ok(usageAt > 0 && composerAt > usageAt, "rendered directly above the composer box");
  assert.match(component, /role="status"/);
  assert.match(component, /aria-live="polite"/);
  // The live region must stay mounted even without compaction data.
  assert.match(
    component,
    /<span\s+className="context-compaction-slot"[\s\S]*?role="status"/,
  );
  // The additive session field exists and documents its event-only contract.
  const types = readFileSync(join(root, "src/types.ts"), "utf8");
  assert.match(types, /compaction\?: \{ status: "running" \| "done" \| "failed"; at: string \}/);
});
