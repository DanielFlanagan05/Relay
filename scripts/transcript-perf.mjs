// Long-transcript performance measurement (IMPROVEMENT_PLAN.md §5, last paragraph).
//
//   node scripts/transcript-perf.mjs [--quick]
//
// Builds isolated synthetic workspaces under the OS temp dir (never ~/.config/Relay),
// then measures, with performance.now():
//   * Store load (constructor), save() time and workspace.json size
//   * Service snapshot construction (structuredClone), IPC-style serialization cost
//   * A streamed turn through the real AgentService: `changed` event rate (the 70 ms
//     throttle), store.save() cost during streaming (the 700 ms throttle)
//   * Microbench replication of the per-delta updateTiming() work in service.mjs
//   * Renderer cost with the REAL src/features/conversation/Markdown.tsx bundled by
//     esbuild and mounted via react-dom/server renderToString (no Electron, no dist build;
//     same pattern as scripts/status-render-smoke.mjs)
//
// Everything printed is measured on this machine; nothing is extrapolated.
// Estimates and proxies are labelled as such.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, release, hostname } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

import { Store } from "../electron/store.mjs";
import { AgentService } from "../electron/service.mjs";
import { finalizeRate } from "../electron/usage.mjs";

const QUICK = process.argv.includes("--quick");

// ---------------------------------------------------------------- utilities

function median(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function time(fn, runs = 1) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return out;
}
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const f = (n, d = 1) => (typeof n === "number" ? n.toFixed(d) : String(n));

// Deterministic PRNG so every run measures the same fixture.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- fixtures

const WORDS =
  "the model runtime streams tokens while the scheduler admits sessions and the store persists every turn of the transcript with tool records and reasoning".split(
    " ",
  );
function sentence(rnd, min = 8, max = 24) {
  const n = min + Math.floor(rnd() * (max - min));
  let s = "";
  for (let i = 0; i < n; i++) s += (s ? " " : "") + WORDS[Math.floor(rnd() * WORDS.length)];
  return s[0].toUpperCase() + s.slice(1) + ".";
}
function paragraph(rnd, sentences = 4) {
  return Array.from({ length: sentences }, () => sentence(rnd)).join(" ");
}
function codeBlock(rnd, language, lines) {
  const body = Array.from({ length: lines }, (_, i) => {
    const shapes = [
      `  const value${i} = compute(${Math.floor(rnd() * 100)}) // ${sentence(rnd, 3, 6)}`,
      `  if (state.phase === "${["admit", "stream", "settle"][i % 3]}") queue.push(job${i});`,
      `  return items.filter((x) => x.tokens > ${i}).map((x) => x.normalize());`,
      `  await store.save(); // ${sentence(rnd, 4, 8)}`,
    ];
    return shapes[Math.floor(rnd() * shapes.length)];
  }).join("\n");
  return "```" + language + "\n" + body + "\n```";
}

// One realistic transcript pair (user + assistant with thinking, tools, code).
function turn(rnd, i) {
  const user = {
    id: `u-${i}`,
    role: "user",
    content: `${sentence(rnd, 6, 20)}\n\n${codeBlock(rnd, "json", 3 + Math.floor(rnd() * 6))}`,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const tools = Array.from({ length: 2 + Math.floor(rnd() * 8) }, (_, k) => ({
    name: ["read", "grep", "bash", "edit"][k % 4],
    input: { path: `src/module${k}/file${i}.ts`, pattern: sentence(rnd, 2, 4) },
    output: `${sentence(rnd, 10, 40)}\n${"line of tool output ".repeat(10 + Math.floor(rnd() * 30))}`,
    at: "2026-10-01T00:00:01.000Z",
  }));
  const assistant = {
    id: `a-${i}`,
    role: "assistant",
    content: [
      `## Turn ${i}`,
      paragraph(rnd, 3),
      codeBlock(rnd, "typescript", 15 + Math.floor(rnd() * 30)),
      paragraph(rnd, 3),
      "- " + sentence(rnd),
      "- " + sentence(rnd),
      codeBlock(rnd, "python", 8 + Math.floor(rnd() * 12)),
    ].join("\n\n"),
    thinking: Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => sentence(rnd, 12, 40)).join(
      " ",
    ),
    tools,
    createdAt: "2026-10-01T00:00:02.000Z",
    status: "complete",
  };
  return [user, assistant];
}

// messageCount = number of turns; the stored transcript has 2x messages.
function syntheticData(turnsPerSession, sessionCount) {
  const rnd = mulberry32(0xc0ffee);
  const model = {
    id: "local:bench",
    name: "Bench local",
    kind: "local",
    model: "bench",
    endpoint: "http://127.0.0.1:9/v1",
    context: 131072,
    parallel: 2,
    slotGiB: 4,
  };
  const sessions = Array.from({ length: sessionCount }, (_, s) => {
    const messages = Array.from({ length: turnsPerSession }, (_, i) => turn(rnd, i)).flat();
    return {
      id: `session-${s}`,
      nativeId: `native-${s}`,
      title: `Bench session ${s}`,
      modelId: model.id,
      harness: "direct",
      cwd: "",
      hookIds: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      status: "idle",
      messages,
      pinned: false,
      archived: false,
      permission: "read-only",
      draft: "",
    };
  });
  return {
    version: 2,
    sessions,
    models: [model],
    hooks: [],
    tasks: [],
    delegations: [],
    settings: { reserveGiB: 8, cloudParallel: 4, defaultHooks: [], workspaceHooks: {}, localaiRoot: "", theme: "dark" },
  };
}

// ---------------------------------------------------------------- store + service bench

function openStore(dir, data) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(data));
}

function benchStore(dir) {
  // The Store constructor performs load + migrations + one save; report it whole,
  // then isolate the recurring save() the streaming path hits every 700 ms.
  const open = median(time(() => new Store(dir), 3));
  const store = new Store(dir);
  const pureLoad = median(
    time(() => {
      const scratch = Object.create(Store.prototype);
      scratch.load(join(dir, "workspace.json"));
    }, 3),
  );
  const saveSamples = time(() => store.save(), 5);
  const fileSize = statSync(join(dir, "workspace.json")).size;
  return { open, pureLoad, save: median(saveSamples), fileSize, store };
}

function openService(dir, runner = async () => {}) {
  return new AgentService(dir, {
    memorySource: () => ({ availableGiB: 64, totalGiB: 128 }),
    runtimeSource: () => null,
    runner,
    localaiRoot: dir, // keep discovery away from the real ~/.config
  });
}

function benchSnapshot(service) {
  const samples = time(() => {
    const snap = service.snapshot();
    // Proxy for webContents.send: Electron structured-clones the payload over IPC.
    structuredClone(snap);
  }, 5);
  const snap = service.snapshot();
  const jsonSamples = time(() => JSON.stringify(snap), 3);
  return {
    snapshotClone: median(samples),
    payloadBytes: JSON.stringify(snap).length,
    stringify: median(jsonSamples),
  };
}

// ---------------------------------------------------------------- streaming bench

async function streamOnce(service, sid, { deltas, gapMs }) {
  const events = [];
  const onSave = service.store.save.bind(service.store);
  let saveCount = 0;
  let saveMs = 0;
  service.store.save = () => {
    const t = performance.now();
    onSave();
    saveMs += performance.now() - t;
    saveCount++;
  };
  const changed = () => events.push(performance.now());
  service.on("changed", changed);
  const started = performance.now();
  service.send(sid, "Streaming benchmark turn. Reply briefly.");
  // Poll session status instead of racing the "completed" event: the scheduler
  // runs execute() asynchronously and a failure must not hang this harness.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = service.store.session(sid).status;
    if (status !== "queued" && status !== "loading" && status !== "running") break;
    if (Date.now() > deadline) throw new Error("streaming benchmark timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
  // let the trailing throttled update land
  await new Promise((r) => setTimeout(r, 120));
  service.removeListener("changed", changed);
  service.store.save = onSave;
  const wall = performance.now() - started;
  const span = events.length > 1 ? events.at(-1) - events[0] : wall;
  return {
    wall,
    changedEvents: events.length,
    changedHz: span > 0 ? ((events.length - 1) / span) * 1000 : 0,
    saveCount,
    saveAvgMs: saveCount ? saveMs / saveCount : 0,
    deltas,
    gapMs,
  };
}

async function streamScenario(turns, sessionCount) {
  const dir = mkdtempSync(join(tmpdir(), "relay-perf-stream-"));
  const deltas = QUICK ? 120 : 240;
  const gapMs = 25; // ~40 tokens/s, matching the shared runtime's observed decode rate
  const runner = async ({ emit, signal }) => {
    for (let i = 0; i < deltas && !signal.aborted; i++) {
      await new Promise((r) => setTimeout(r, gapMs));
      emit({ type: "thinking", value: "reasoning " });
      emit({ type: "delta", value: `w${i} ` });
    }
  };
  const service = openService(dir, runner);
  // Realistic pressure: every session keeps its transcript, because the 70 ms
  // snapshot and the 700 ms save serialize the WHOLE store, not just the
  // streaming session.
  service.store.data = syntheticData(turns, sessionCount);
  const target = service.store.session("session-0");
  const rows = [];
  rows.push({ label: `stream into ${turns}-turn transcript, ${sessionCount} session(s) each ${turns} turns`, ...(await streamOnce(service, target.id, { deltas, gapMs })) });
  const answer = target.messages.at(-1);
  const after = benchSnapshot(service);
  service.close();
  rmSync(dir, { recursive: true, force: true });
  return { row: rows[0], answerChars: (answer.content + answer.thinking).length, snapshotAfter: after };
}

// ---------------------------------------------------------------- microbenchmarks

function microbenches() {
  // Replication of the per-delta work inside execute()'s emit closure:
  // answer.content += value; then updateTiming() evaluates
  // `answer.content + answer.thinking` eagerly for finalizeRate().
  const out = [];
  for (const kb of [4, 32, 128, 256]) {
    const a = "x".repeat(kb * 1024);
    const b = "y".repeat(kb * 1024);
    let sink = 0;
    const t = performance.now();
    for (let i = 0; i < 20000; i++) {
      const joined = a + b; // same expression shape as updateTiming()'s generatedText
      sink += joined.length; // .length is O(1) on V8 ConsStrings; stringify flattens
      if (sink < 0) console.log("never");
    }
    const perConcat = (performance.now() - t) / 20000;
    // And the flattened-string case (what JSON.stringify hits during save):
    const flat = (a + b).slice();
    let n = 0;
    const t2 = performance.now();
    for (let i = 0; i < 200; i++) n += flat.length;
    void n;
    out.push({ kbPerSide: kb, perDeltaConcatMs: perConcat, flatLengthReadMs: (performance.now() - t2) / 200 });
  }
  // finalizeRate itself at a realistic call rate (once per delta).
  const text = "word ".repeat(40000);
  const t = performance.now();
  for (let i = 0; i < 20000; i++) finalizeRate({ turnOutput: undefined, generatedText: text, elapsedMs: 1000 });
  const finalizeMs = (performance.now() - t) / 20000;
  return { concat: out, finalizeRateMs: finalizeMs };
}

// ---------------------------------------------------------------- renderer bench

async function loadRealMarkdown() {
  const root = resolve(import.meta.dirname, "..");
  const dir = mkdtempSync(join(root, "node_modules", ".relay-perf-render-"));
  const outfile = join(dir, "markdown.mjs");
  await build({
    stdin: {
      contents: `export { Markdown } from "./src/features/conversation/Markdown";\n`,
      resolveDir: root,
      sourcefile: "perf-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile,
    logLevel: "silent",
    external: ["react", "react-dom", "react/jsx-runtime"],
  });
  const mod = await import(outfile);
  return { Markdown: mod.Markdown, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function longContent(rnd, kb, { code = true } = {}) {
  const parts = [];
  let size = 0;
  let i = 0;
  while (size < kb * 1024) {
    parts.push(`### Section ${i}\n\n${paragraph(rnd, 4)}`);
    if (code && i % 2 === 1) parts.push(codeBlock(rnd, ["typescript", "json", "python"][i % 3], 25));
    size = parts.join("\n\n").length;
    i++;
  }
  return parts.join("\n\n");
}

async function rendererBench() {
  const { Markdown, cleanup } = await loadRealMarkdown();
  // Warm the module first: hljs loads grammars lazily, which would otherwise
  // charge the first measured render with a one-time cost.
  renderToStaticMarkup(createElement(Markdown, null, "# warm\n\n```typescript\nconst a = 1;\n```"));
  const rnd = mulberry32(0xbeef);
  const rows = [];
  for (const kb of QUICK ? [2, 16, 64] : [2, 8, 32, 96]) {
    const content = longContent(rnd, kb);
    const plain = longContent(rnd, kb, { code: false });
    const withCode = median(
      time(() => renderToStaticMarkup(createElement(Markdown, null, content)), QUICK ? 1 : 2),
    );
    const noCode = median(
      time(() => renderToStaticMarkup(createElement(Markdown, null, plain)), QUICK ? 1 : 2),
    );
    rows.push({ kb: content.length / 1024, withCode, noCode, highlights: content.length < 50 * 1024 });
  }
  // Full message list, no virtualization: what one snapshot re-render faces.
  // (MessageView in App.tsx is not memoized, so every `changed` event re-renders
  // every message; renderToString is a fresh-render proxy, labelled as such.)
  const listRows = [];
  for (const n of QUICK ? [50, 300] : [50, 500, 2000]) {
    const messages = syntheticData(Math.ceil(n / 2), 1).sessions[0].messages.slice(0, n);
    const el = createElement(
      "div",
      null,
      ...messages.map((m) =>
        createElement(Markdown, { key: m.id, children: m.role === "assistant" ? m.content : "" }),
      ),
    );
    const ms = median(
      time(() => renderToStaticMarkup(el), QUICK ? 1 : 2),
    );
    listRows.push({ messages: n, chars: messages.reduce((t, m) => t + (m.content || "").length, 0), ms });
  }
  cleanup();
  return { single: rows, list: listRows };
}

// ---------------------------------------------------------------- main

const machine = {
  host: hostname(),
  cpu: cpus()[0].model.trim(),
  cores: cpus().length,
  memGiB: (totalmem() / 1024 ** 3).toFixed(1),
  node: process.version,
  kernel: release(),
};

console.log("MACHINE", JSON.stringify(machine));

const storeRows = [];
// [sessions, turns] — a "turn" stores one user + one assistant message.
// Transcript scaling keeps 10 sessions; session scaling keeps 25 turns (~50
// messages) per session, matching the assignment's 50/500/2,000-message ramp.
// 500 sessions x 2,000 messages (≈1 GB of JSON) was deliberately not run;
// both ramps are linear so the cross product is extrapolatable (labelled as
// an extrapolation, not a measurement).
const scenarios = QUICK
  ? [
      [10, 25],
      [10, 250],
      [100, 25],
    ]
  : [
      [10, 25],
      [10, 250],
      [10, 1000],
      [100, 25],
      [500, 25],
      [100, 250],
    ];

for (const [sessions, turns] of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), "relay-perf-store-"));
  openStore(dir, syntheticData(turns, sessions));
  const b = benchStore(dir);
  const service = openService(dir);
  const snap = benchSnapshot(service);
  service.close();
  rmSync(dir, { recursive: true, force: true });
  storeRows.push({
    sessions,
    turns,
    storedMessages: sessions * turns * 2,
    openMs: b.open,
    pureLoadMs: b.pureLoad,
    saveMs: b.save,
    fileMB: mb(b.fileSize),
    snapshotCloneMs: snap.snapshotClone,
    payloadMB: mb(snap.payloadBytes),
    stringifyMs: snap.stringify,
  });
  console.log("STORE", JSON.stringify(storeRows.at(-1)));
}

for (const [turns, sessions] of QUICK ? [[250, 3]] : [[25, 1], [250, 10], [1000, 10]]) {
  const r = await streamScenario(turns, sessions);
  console.log("STREAM", JSON.stringify(r));
}

console.log("MICRO", JSON.stringify(microbenches()));

console.log("RENDER", JSON.stringify(await rendererBench()));
