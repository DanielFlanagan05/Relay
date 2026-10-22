// Isolated UI smoke checks for Relay's renderer-local session logic.
// Runs pure TypeScript helpers through esbuild transpilation + node:test with
// fixture sessions only: no Electron, no model, no network, no shared dist/.
//
//   node scripts/ux-smoke.mjs
//
// Full Electron acceptance (owned by the reviewer; not run concurrently with
// other implementation work):  npm run test:ui
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  join(root, "src/features/sessions/sessionLogic.ts"),
  "utf8",
);
// Type-only imports disappear during transpilation; the module is pure JS.
const logicUrl =
  "data:text/javascript;base64," +
  Buffer.from(
    transformSync(source, { loader: "ts", format: "esm" }).code,
  ).toString("base64");
const {
  SAFE_PARSE,
  seedReadState,
  isUnread,
  filterSessions,
  groupByWorkspace,
  mergeDraftForRetry,
  platformModKey,
  nextTab,
  resizeValue,
} = await import(logicUrl);

const busy = (s) => !!s && ["running", "loading", "queued"].includes(s.status);
const session = (id, overrides = {}) => ({
  id,
  title: `Session ${id}`,
  cwd: "/home/dev/project-a",
  status: "idle",
  archived: false,
  pinned: false,
  updatedAt: "2026-10-20T00:00:00.000Z",
  messages: [{ id: `${id}m`, role: "user", content: `note ${id}` }],
  ...overrides,
});

test("unread state is renderer-local, per-session, and quiet once read", () => {
  const a = session("a1", { updatedAt: "2026-10-21T00:00:00.000Z" });
  const read = { a1: "2026-10-21T00:00:00.000Z" };
  assert.equal(isUnread(a, read, null), false, "read at latest = not unread");
  assert.equal(
    isUnread({ ...a, updatedAt: "2026-10-22T00:00:00.000Z" }, read, null),
    true,
    "new activity after last view = unread",
  );
  assert.equal(
    isUnread(a, read, "a1"),
    false,
    "visible session is never unread",
  );
  assert.equal(
    isUnread({ ...a, archived: true }, {}, null),
    false,
    "archived sessions are not flagged",
  );
  const seed = seedReadState([a, session("b2")]);
  assert.deepEqual(Object.keys(seed).sort(), ["a1", "b2"]);
});

test("filters keep search, archive, activity, and unread semantics", () => {
  const sessions = [
    session("s1", { status: "running" }),
    session("s2", { status: "error", cwd: "/other" }),
    session("s3", { status: "interrupted" }),
    session("s4", { archived: true }),
  ];
  const base = {
    showArchive: false,
    search: "",
    activityFilter: "all",
    readState: {},
    selectedId: null,
    busy,
  };
  assert.deepEqual(
    filterSessions(sessions, base).map((s) => s.id),
    ["s1", "s2", "s3"],
  );
  assert.deepEqual(
    filterSessions(sessions, { ...base, activityFilter: "active" }).map(
      (s) => s.id,
    ),
    ["s1"],
  );
  assert.deepEqual(
    filterSessions(sessions, { ...base, activityFilter: "attention" }).map(
      (s) => s.id,
    ),
    ["s2", "s3"],
  );
  // Nothing read yet except s1 → every other visible session is unread.
  assert.deepEqual(
    filterSessions(sessions, {
      ...base,
      activityFilter: "unread",
      readState: { s1: "2099-01-01T00:00:00.000Z" },
    }).map((s) => s.id),
    ["s2", "s3"],
  );
  assert.deepEqual(
    filterSessions(sessions, { ...base, search: "/other" }).map((s) => s.id),
    ["s2"],
    "search covers workspace paths",
  );
  assert.deepEqual(
    filterSessions(sessions, { ...base, search: "note s3" }).map((s) => s.id),
    ["s3"],
    "search covers message content",
  );
  assert.deepEqual(
    filterSessions(sessions, { ...base, showArchive: true }).map((s) => s.id),
    ["s4"],
  );
  const pinned = [
    session("p1", { pinned: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
    session("p2", { updatedAt: "2026-09-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    filterSessions(pinned, base).map((s) => s.id),
    ["p1", "p2"],
    "pins stay first",
  );
});

test("sessions group by workspace, most recently active group first", () => {
  const groups = groupByWorkspace([
    session("g1", { cwd: "/ws/old", updatedAt: "2026-10-10T00:00:00.000Z" }),
    session("g2", { cwd: "/ws/new", updatedAt: "2026-10-20T00:00:00.000Z" }),
    session("g3", { cwd: "", updatedAt: "2026-10-15T00:00:00.000Z" }),
    session("g4", { cwd: "/ws/new", updatedAt: "2026-10-19T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.cwd),
    ["/ws/new", "", "/ws/old"],
  );
  assert.deepEqual(
    groups[0].sessions.map((s) => s.id),
    ["g2", "g4"],
  );
});

test("error recovery returns the request to the composer without replay", () => {
  assert.equal(
    mergeDraftForRetry("", "run the migration"),
    "run the migration",
  );
  assert.equal(
    mergeDraftForRetry("follow-up question", "run the migration"),
    "follow-up question\n\nrun the migration",
  );
  assert.equal(mergeDraftForRetry("kept draft", undefined), "kept draft");
});

test("shortcut labels follow the platform", () => {
  assert.equal(platformModKey("MacIntel", ""), "⌘");
  assert.equal(
    platformModKey("", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"),
    "⌘",
  );
  assert.equal(platformModKey("Linux x86_64", ""), "Ctrl");
  assert.equal(platformModKey("Win32", ""), "Ctrl");
});

test("tab headers support arrow, Home, and End navigation", () => {
  const tabs = ["details", "artifacts", "agents"];
  assert.equal(nextTab(tabs, "details", "ArrowRight"), "artifacts");
  assert.equal(nextTab(tabs, "details", "ArrowLeft"), "agents", "wraps");
  assert.equal(nextTab(tabs, "agents", "Home"), "details");
  assert.equal(nextTab(tabs, "details", "End"), "agents");
  assert.equal(nextTab(tabs, "details", "a"), null, "unhandled keys ignored");
  assert.equal(nextTab(tabs, "gone", "ArrowRight"), null);
});

test("keyboard resizing clamps to bounds and honours reversed handles", () => {
  assert.equal(resizeValue("ArrowRight", 250, 200, 360), 270);
  assert.equal(resizeValue("ArrowLeft", 210, 200, 360), 200, "clamps at min");
  assert.equal(resizeValue("End", 250, 200, 360), 360);
  assert.equal(resizeValue("Home", 250, 200, 360), 200);
  assert.equal(resizeValue("ArrowRight", 250, 200, 360, true), 230);
  assert.equal(resizeValue("PageUp", 250, 200, 360), 330);
  assert.equal(resizeValue("a", 250, 200, 360), null);
});

test("persisted renderer state degrades safely", () => {
  assert.deepEqual(SAFE_PARSE("{ not json", {}), {});
  assert.deepEqual(SAFE_PARSE(null, { fallback: true }), { fallback: true });
  assert.deepEqual(SAFE_PARSE("[1,2]", []), [1, 2]);
  assert.equal(SAFE_PARSE("42", "fallback"), "fallback", "scalars rejected");
});

// Cheap wiring smoke: fail early if an interface change dropped a landmark
// that these polish items rely on. Not a substitute for Electron acceptance.
test("renderer wiring keeps accessibility landmarks in place", () => {
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  const styles = readFileSync(join(root, "src/styles.css"), "utf8");
  const panel = readFileSync(
    join(root, "src/features/artifacts/ArtifactPanel.tsx"),
    "utf8",
  );
  for (const needle of [
    'aria-controls="support-panel-body"',
    'role="tablist"',
    "Unread activity",
    "workspace-group-heading",
    "Edit last request",
    "Connection and provider details",
    "{modKey} N",
  ])
    assert.ok(app.includes(needle), `App.tsx lost ${needle}`);
  for (const needle of [
    ".workspace-group-heading",
    ".unread-dot",
    ".error-details",
    "prefers-reduced-motion",
    "prefers-contrast",
    'html[data-theme="light"]',
  ])
    assert.ok(styles.includes(needle), `styles.css lost ${needle}`);
  for (const needle of [
    'id="artifact-body"',
    "aria-pressed={expanded}",
    "Copy source",
    'role="tabpanel"',
  ])
    assert.ok(panel.includes(needle), `ArtifactPanel lost ${needle}`);
});

test("workspace recency ignores pin ordering inside the group", () => {
  const rows = [
    session("old-pin", { pinned: true, cwd: "/a", updatedAt: "2026-01-01" }),
    session("new", { cwd: "/a", updatedAt: "2026-10-22" }),
    session("middle", { cwd: "/b", updatedAt: "2026-10-21" }),
  ];
  assert.deepEqual(
    groupByWorkspace(rows).map((g) => g.cwd),
    ["/a", "/b"],
  );
});
