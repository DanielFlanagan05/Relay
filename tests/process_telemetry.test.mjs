// Isolated checks for the Local compute process-memory feature.
// Uses a fixture /proc tree and pure renderer helpers only: no Electron, no model,
// no inference, no network, no shared dist/ build, no real system mutation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync, transformSync } from "esbuild";
import { collectProcesses } from "../electron/processTelemetry.mjs";

const SYSTEM = {
  totalGiB: 32,
  availableGiB: 9.5,
  swapGiB: 0.25,
  source: "fixture MemAvailable",
};

function fixtureProcTree(specs) {
  const root = mkdtempSync(join(tmpdir(), "relay-proc-"));
  for (const spec of specs) {
    const dir = join(root, String(spec.pid));
    mkdirSync(dir, { recursive: true });
    if (spec.status !== null)
      writeFileSync(
        join(dir, "status"),
        spec.status ??
          [
            `Name:\t${spec.name}`,
            `State:\t${spec.state ?? "S (sleeping)"}`,
            `Uid:\t${spec.uid ?? 1000}\t${spec.uid ?? 1000}\t${spec.uid ?? 1000}\t${spec.uid ?? 1000}`,
            spec.vmRssKb === undefined ? "" : `VmRSS:\t${spec.vmRssKb} kB`,
            "",
          ].join("\n"),
      );
    if (spec.statm !== undefined)
      writeFileSync(join(dir, "statm"), `100 ${spec.statm} 10 0 0 0 0`);
    if (spec.cmdline !== undefined)
      writeFileSync(join(dir, "cmdline"), spec.cmdline);
    if (spec.comm) writeFileSync(join(dir, "comm"), spec.comm);
  }
  return root;
}

const read = (path) => readdirSync(path, { withFileTypes: true });

test("every process is listed with its own PID and measured memory, largest first", (t) => {
  const root = fixtureProcTree([
    { pid: 400, name: "llama-server", vmRssKb: 8 * 1024 * 1024 },
    { pid: 401, name: "chrome", vmRssKb: 1024 * 1024 },
    { pid: 402, name: "chrome", vmRssKb: 512 * 1024 },
    { pid: 403, name: "systemd", uid: 0, vmRssKb: 9 * 1024 },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = collectProcesses({
    procRoot: root,
    readdir: read,
    systemMemory: () => SYSTEM,
    ownUid: 1000,
  });
  assert.equal(result.available, true);
  assert.equal(result.permissionLimited, false);
  assert.deepEqual(
    result.processes.map((p) => [p.pid, p.name, p.rss]),
    [
      [400, "llama-server", 8 * 1024 ** 3],
      [401, "chrome", 1024 ** 3],
      [402, "chrome", 512 * 1024 ** 2],
      [403, "systemd", 9 * 1024 ** 2],
    ],
  );
  // Duplicate names stay separate; ownership is reported, never merged.
  assert.deepEqual(
    result.processes.map((p) => p.own),
    [true, true, true, false],
  );
  assert.deepEqual(result.system, SYSTEM);
  assert.equal(result.metric, "RSS");
  assert.match(result.metricLabel, /shared/i);
  assert.equal(result.errors.length, 0);
});

test("kernel threads and defunct processes are skipped and counted, not shown as zero", (t) => {
  const root = fixtureProcTree([
    { pid: 10, name: "kworker/0:1", status: null, cmdline: "" },
    {
      pid: 11,
      name: "zombie",
      state: "Z (zombie)",
      vmRssKb: 0,
      cmdline: "zombie",
    },
    { pid: 12, name: "editor", vmRssKb: 200 * 1024 },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = collectProcesses({
    procRoot: root,
    readdir: read,
    systemMemory: () => SYSTEM,
  });
  assert.deepEqual(
    result.processes.map((p) => p.pid),
    [12],
  );
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.errors, []);
});

test("memory falls back to statm and the name to comm before reporting a gap", (t) => {
  const root = fixtureProcTree([
    // No VmRSS in status but a real command line: derived from resident pages.
    {
      pid: 20,
      status: "State:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\n",
      statm: 300,
      cmdline: "/usr/bin/svc",
    },
    // No readable name anywhere: still reported by PID.
    {
      pid: 21,
      status:
        "State:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t77 kB\n",
      cmdline: "x",
    },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = collectProcesses({
    procRoot: root,
    readdir: read,
    systemMemory: () => SYSTEM,
  });
  const [first, second] = result.processes;
  assert.equal(first.pid, 20);
  assert.equal(first.rss, 300 * 4096);
  assert.equal(second.name, "[21]");
  assert.equal(second.rss, 77 * 1024);
});

test("processes that exit mid-scan are skipped without an error state", (t) => {
  const root = fixtureProcTree([
    { pid: 30, name: "short-lived", vmRssKb: 10 },
    { pid: 31, name: "editor", vmRssKb: 10 },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = readdirSync;
  const result = collectProcesses({
    procRoot: root,
    readdir: () => real(root, { withFileTypes: true }),
    readFile: (path) => {
      if (path.includes("/30/")) {
        const error = new Error("no such process");
        error.code = "ENOENT";
        throw error;
      }
      return readFileSync(path, "utf8");
    },
    systemMemory: () => SYSTEM,
  });
  assert.deepEqual(
    result.processes.map((p) => p.pid),
    [31],
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.skipped, 1);
});

test("unreadable processes are reported as permission-limited, never as zero", (t) => {
  const root = fixtureProcTree([
    { pid: 50, name: "mine", vmRssKb: 1000 },
    { pid: 51, name: "theirs", vmRssKb: 1000 },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = collectProcesses({
    procRoot: root,
    readdir: read,
    readFile: (path) => {
      if (path.includes("/51/")) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return readFileSync(path, "utf8");
    },
    systemMemory: () => SYSTEM,
  });
  assert.equal(result.available, true);
  assert.equal(result.permissionLimited, true);
  assert.deepEqual(
    result.processes.map((p) => p.pid),
    [50, 51],
  );
  assert.match(result.errors.join(" "), /PID 51/);
  assert.equal(result.processes[1].rss, null);
});

test("an unreadable process root says so instead of showing an empty machine", () => {
  const result = collectProcesses({
    procRoot: "/proc",
    readdir: () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
    systemMemory: () => SYSTEM,
  });
  assert.equal(result.available, false);
  assert.equal(result.permissionLimited, true);
  assert.match(result.errors.join(" "), /elevated privileges/);
});

test("unsupported platforms are labelled unavailable rather than estimated", () => {
  const result = collectProcesses({
    platform: "darwin",
    readdir: () => {
      throw new Error("must not be read on a non-Linux platform");
    },
    systemMemory: () => SYSTEM,
  });
  assert.equal(result.available, false);
  assert.deepEqual(result.processes, []);
  assert.match(result.errors.join(" "), /estimates/);
  assert.deepEqual(result.system, SYSTEM, "system headroom is still shown");
});

test("the display limit truncation is explicit", (t) => {
  const root = fixtureProcTree(
    Array.from({ length: 5 }, (_, i) => ({
      pid: 100 + i,
      name: `proc${i}`,
      vmRssKb: (5 - i) * 1024,
    })),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = collectProcesses({
    procRoot: root,
    readdir: read,
    systemMemory: () => SYSTEM,
    maxEntries: 2,
  });
  assert.equal(result.processes.length, 2);
  assert.equal(result.truncated, true);
});

// ── Renderer-local helpers, transpiled without a shared build ──────────────
const logicSource = readFileSync(
  resolve(import.meta.dirname, "../src/features/compute/processMemoryLogic.ts"),
  "utf8",
);
const logicUrl =
  "data:text/javascript;base64," +
  Buffer.from(
    transformSync(logicSource, { loader: "ts", format: "esm" }).code,
  ).toString("base64");
const {
  formatMemory,
  barPercent,
  filterProcesses,
  sortProcesses,
  summarize,
  isStale,
  diffSamples,
  collectionNotice,
} = await import(logicUrl);

test("memory labels and bar scale stay readable and honest", () => {
  assert.equal(formatMemory(0), "0 MiB");
  assert.equal(formatMemory(512 * 1024 ** 2), "512 MiB");
  assert.equal(formatMemory(2 * 1024 ** 3), "2 GiB");
  assert.equal(barPercent(500, 1000), 50);
  assert.equal(barPercent(1000, 1000), 100);
  assert.ok(barPercent(1, 1_000_000) > 0, "tiny processes stay visible");
  assert.equal(barPercent(0, 1000), 0);
  assert.equal(barPercent(2000, 1000), 100, "never overflows the track");
});

test("search matches names and PID prefixes without matching every digit", () => {
  const rows = [
    { pid: 1234, name: "Chrome Helper", rss: 3 },
    { pid: 45, name: "llama-server", rss: 9 },
    { pid: 7, name: "sort", rss: 1 },
  ];
  assert.deepEqual(filterProcesses(rows, "").length, 3);
  assert.deepEqual(
    filterProcesses(rows, "chrome").map((r) => r.pid),
    [1234],
  );
  assert.deepEqual(
    filterProcesses(rows, "12").map((r) => r.pid),
    [1234],
  );
  assert.deepEqual(filterProcesses(rows, "9"), [], "not a PID prefix or name");
});

test("sorting defaults to measured memory descending with deterministic ties", () => {
  const rows = [
    { pid: 2, name: "b", rss: 10, own: true, uid: 1 },
    { pid: 1, name: "a", rss: 10, own: true, uid: 1 },
    { pid: 3, name: "c", rss: 20, own: false, uid: 0 },
  ];
  assert.deepEqual(
    sortProcesses(rows, "memory").map((r) => r.pid),
    [3, 1, 2],
  );
  assert.deepEqual(
    sortProcesses(rows, "name").map((r) => r.pid),
    [1, 2, 3],
  );
  assert.deepEqual(
    sortProcesses(rows, "pid").map((r) => r.pid),
    [1, 2, 3],
  );
  assert.deepEqual(
    rows.map((r) => r.pid),
    [2, 1, 3],
    "input is not mutated",
  );
  assert.deepEqual(summarize(rows), {
    total: 40,
    own: 20,
    other: 20,
    count: 3,
  });
});

test("staleness and process start/exit are detected between samples", () => {
  const now = Date.parse("2026-10-22T12:00:30Z");
  assert.equal(isStale("2026-10-22T12:00:25Z", now), false);
  assert.equal(isStale("2026-10-22T11:59:00Z", now), true);
  assert.equal(isStale("not a date", now), true);
  const previous = {
    available: true,
    collectedAt: "2026-10-22T12:00:25Z",
    processes: [{ pid: 1, name: "a", rss: 1 }],
  };
  const next = {
    available: true,
    collectedAt: "2026-10-22T12:00:30Z",
    processes: [
      { pid: 1, name: "a", rss: 1 },
      { pid: 2, name: "b", rss: 1 },
    ],
  };
  assert.deepEqual(diffSamples(previous, next), { started: [2], exited: [] });
  assert.deepEqual(diffSamples(null, next), { started: [], exited: [] });
  assert.deepEqual(diffSamples({ ...previous, available: false }, next), {
    started: [],
    exited: [],
  });
});

test("collection wording separates failure, permission limits and truncation from emptiness", () => {
  assert.equal(collectionNotice(null, "boom").tone, "error");
  assert.match(collectionNotice(null, "boom").text, /boom/);
  const unavailable = {
    available: false,
    collectedAt: "2026-10-22T12:00:00Z",
    processes: [],
    errors: ["Per-process memory is only implemented for Linux"],
  };
  assert.equal(collectionNotice(unavailable, "").tone, "error");
  assert.match(collectionNotice(unavailable, "").text, /Linux/);
  assert.equal(
    collectionNotice(
      { ...unavailable, available: true, permissionLimited: true },
      "",
    ).tone,
    "warn",
  );
  assert.match(
    collectionNotice(
      { ...unavailable, available: true, permissionLimited: true },
      "",
    ).text,
    /not counted as zero/,
  );
  assert.equal(
    collectionNotice({ ...unavailable, available: true, truncated: true }, "")
      .tone,
    "warn",
  );
  assert.equal(
    collectionNotice({ ...unavailable, available: true, errors: [] }, "").text,
    "",
    "a healthy sample needs no banner",
  );
});

// ── Renderer smoke: real component, static render, no Electron and no build ─
const cache = resolve(
  import.meta.dirname,
  "../node_modules/.cache/relay-process-memory",
);
mkdirSync(cache, { recursive: true });
const bundle = join(cache, "ProcessMemory.mjs");
buildSync({
  entryPoints: [
    resolve(import.meta.dirname, "../src/features/compute/ProcessMemory.tsx"),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile: bundle,
  // Shared React instance with the test process; otherwise hooks have no dispatcher.
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/server",
    "lucide-react",
  ],
  logLevel: "silent",
});
const { ProcessMemory } = await import(pathToFileURL(bundle).href);
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const render = (props) =>
  renderToStaticMarkup(React.createElement(ProcessMemory, props));
const telemetry = (processes, overrides = {}) => ({
  available: true,
  metric: "RSS",
  metricLabel: "Resident set size (RSS) includes shared pages.",
  collectedAt: new Date().toISOString(),
  system: SYSTEM,
  processes,
  errors: [],
  permissionLimited: false,
  truncated: false,
  skipped: 0,
  ...overrides,
});

test("the graph renders every process with name, PID and a text memory value", () => {
  const html = render({
    call: async () => undefined,
    initialSample: telemetry([
      {
        pid: 900,
        name: "llama-server",
        uid: 1000,
        own: true,
        rss: 6 * 1024 ** 3,
      },
      { pid: 901, name: "firefox", uid: 1000, own: true, rss: 1024 ** 3 },
      { pid: 902, name: "sshd", uid: 0, own: false, rss: 8 * 1024 ** 2 },
    ]),
  });
  assert.match(html, /llama-server/);
  assert.match(html, />900</);
  assert.match(html, /6 GiB/);
  assert.match(html, /1 GiB/);
  assert.match(html, /8 MiB/);
  assert.match(html, /GiB total/);
  assert.match(html, /GiB available/);
  assert.match(html, /shared pages/);
  assert.equal(
    (html.match(/class="proc-row"/g) || []).length,
    3,
    "one bar per process, no merging of same-named processes",
  );
  assert.match(html, /aria-label="Processes by resident memory"/);
});

test("unavailable and permission-limited telemetry are shown as such", async () => {
  const unavailable = render({
    call: async () =>
      telemetry([], {
        available: false,
        errors: ["Process collection is unavailable here."],
      }),
    initialSample: telemetry([], {
      available: false,
      errors: ["Process collection is unavailable here."],
    }),
  });
  assert.match(unavailable, /unavailable here/);
  assert.match(unavailable, /role="alert"/);
  assert.doesNotMatch(unavailable, /class="proc-row"/);
  const limited = render({
    call: async () => undefined,
    initialSample: telemetry(
      [{ pid: 1, name: "init", uid: 0, own: false, rss: 1024 ** 2 }],
      { permissionLimited: true },
    ),
  });
  assert.match(limited, /not counted as zero/);
  const broken = render({
    call: async () => {
      throw new Error("IPC channel rejected");
    },
    initialSample: null,
  });
  assert.match(broken, /Reading process memory/);
});

test("statm uses the OS page size and measured zero is distinct from unavailable", (t) => {
  const root = fixtureProcTree([
    { pid: 70, name: "pages", statm: 3 },
    { pid: 71, name: "zero", vmRssKb: 0 },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = collectProcesses({
    procRoot: root,
    pageSize: 65536,
    systemMemory: () => SYSTEM,
  });
  assert.equal(result.processes[0].rss, 3 * 65536);
  assert.equal(result.processes[1].rss, 0);
  const unknown = collectProcesses({
    procRoot: root,
    pageSize: null,
    systemMemory: () => SYSTEM,
  });
  assert.equal(unknown.processes.find((p) => p.pid === 70).rss, null);
});

test("default collection does not truncate beyond 5000 processes", () => {
  const result = collectProcesses({
    readdir: () => Array.from({ length: 5001 }, (_, i) => String(i + 1)),
    readFile: () => "Name: process\nState: S\nVmRSS: 1 kB\n",
    systemMemory: () => SYSTEM,
  });
  assert.equal(result.processes.length, 5001);
  assert.equal(result.truncated, false);
});
