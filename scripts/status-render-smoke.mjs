// Renderer-only component smoke for the status UI: mounts the new components with
// react-dom/server and fixture data. No Electron, no IPC, no model, no network,
// nothing written into the project's shared dist/.
//
//   node scripts/status-render-smoke.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Under node_modules so the bundle's external imports resolve; nothing lands in dist/.
const dir = mkdtempSync(join(root, "node_modules", ".relay-status-smoke-"));
const outfile = join(dir, "components.mjs");
// Bundle the two modules under test (plus their lucide icons) out of the source
// tree so the real components are mounted, not a copy of them.
await build({
  stdin: {
    contents:
      `export * from "./src/features/status/SessionStatusUI";\n` +
      `export * from "./src/features/status/sessionStatus";\n`,
    resolveDir: root,
    sourcefile: "relay-status-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  logLevel: "silent",
  external: ["react", "react-dom", "react/jsx-runtime", "lucide-react"],
});
const components = await import(outfile);
test.after(() => rmSync(dir, { recursive: true, force: true }));
const { StatusPill, StatusNotice, DelegationToggle, ROUND_TERMINAL } =
  components;
const render = (Component, props) =>
  renderToStaticMarkup(createElement(Component, props));

const session = (o = {}) => ({
  id: "s1",
  title: "Work",
  status: "idle",
  harness: "direct",
  queueReason: "",
  error: "",
  archived: false,
  delegation: false,
  permission: "read-only",
  ...o,
});
const state = (over = {}) => ({
  state: "idle",
  label: "Ready",
  reason: "",
  action: "",
  tone: "neutral",
  spin: false,
  active: false,
  ...over,
});

test("the header pill states the lifecycle in words, with the reason as a tooltip", () => {
  const html = render(StatusPill, {
    status: state({
      state: "waiting_children",
      label: "Waiting for children",
      reason:
        "2 delegated task(s) still running and the inference slot is released.",
      tone: "progress",
      spin: true,
      active: true,
    }),
  });
  assert.match(html, /Waiting for children/);
  assert.match(html, /state-label/);
  assert.match(html, /title="Waiting for children — 2 delegated task\(s\)/);
  // An unknown state falls back to the raw stored status class, never to a fake colour.
  const fallback = render(StatusPill, {
    status: state({ state: "unknown", label: "Unknown" }),
    fallback: "streaming",
  });
  assert.match(fallback, /state-label streaming/);
});

test("exactly one notice bar for each non-ready state, none for idle or unknown", () => {
  const expected = {
    queued: "Queued",
    loading: "Loading model",
    waiting_children: "Waiting for children",
    stopped: "Stopped",
    interrupted: "Interrupted",
  };
  for (const [s, label] of Object.entries(expected)) {
    const html = render(StatusNotice, {
      status: state({ state: s, label, reason: `why ${s}`, spin: true }),
    });
    assert.match(html, new RegExp(label), `${s} renders its label`);
    assert.match(html, new RegExp(`why ${s}`), `${s} renders its reason`);
    assert.match(html, /role="status"/, `${s} is announced`);
  }
  for (const s of ["idle", "unknown"])
    assert.equal(
      render(StatusNotice, { status: state({ state: s, label: s }) }),
      "",
      `${s} must not add chrome`,
    );
});

test("the delegation switch is unchecked by default and locked outside Direct chat", () => {
  const onDirect = render(DelegationToggle, {
    session: session(),
    rounds: [],
    tasks: [],
    update: () => {},
  });
  assert.match(onDirect, /type="checkbox"/);
  assert.doesNotMatch(onDirect, /checked/);
  assert.doesNotMatch(onDirect, /disabled/);
  assert.match(onDirect, /experimental/);
  assert.match(onDirect, /not qualified with a live model/);

  for (const [props, expect] of [
    [{ harness: "pi" }, /Native harness delegation is not verified/],
    [{ taskId: "t0" }, /child cannot delegate/],
    [{ archived: true }, /Restore this session/],
  ])
    assert.match(
      render(DelegationToggle, {
        session: session(props),
        rounds: [],
        tasks: [],
        update: () => {},
      }),
      expect,
    );
  assert.match(
    render(DelegationToggle, {
      session: session(),
      busy: true,
      rounds: [],
      tasks: [],
      update: () => {},
    }),
    /disabled/,
    "mid-turn is not a checkbox toggle",
  );

  const parked = render(DelegationToggle, {
    session: session({ delegation: true }),
    rounds: [
      { id: "r1", parentSessionId: "s1", status: "waiting", waitingOn: ["t1"] },
    ],
    tasks: [{ id: "t1", parentSessionId: "s1", status: "running" }],
    update: () => {},
  });
  assert.match(parked, /checked/);
  assert.match(parked, /1 task/);
  assert.match(parked, /waiting/);
});

test("terminal round statuses stay a single shared list", () => {
  assert.deepEqual([...ROUND_TERMINAL].sort(), [
    "canceled",
    "complete",
    "failed",
    "interrupted",
  ]);
});
