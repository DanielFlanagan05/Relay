// Isolated checks for native harness slash-command discovery, caching,
// execution gating, and composer logic.
// Fake installed-harness fixtures in temp dirs only: no Electron, no IPC,
// no model, no network, no build.
//   node --test tests/commands.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import {
  CommandCatalog,
  runNativeCommand,
  findCommand,
} from "../electron/commands.mjs";

// Isolate providers from any real harness install on the developer's machine
// (electron/commands.mjs consults XDG_DATA_HOME for managed localai installs).
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "relay-commands-xdg-"));

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-commands-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

function piFixture(root, version, entries) {
  write(
    join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
  );
  const lines = entries.map((e) => {
    const description = e.template
      ? "`Quit ${APP_NAME}`" // literal template text written into the fixture
      : JSON.stringify(e.description);
    const hint = e.argumentHint
      ? ", argumentHint: " + JSON.stringify(e.argumentHint)
      : "";
    return `    { name: ${JSON.stringify(e.name)}, description: ${description}${hint} },`;
  });
  write(
    join(root, "dist/core/slash-commands.js"),
    [
      'import { APP_NAME } from "../config.js";',
      "export const BUILTIN_SLASH_COMMANDS = [",
      ...lines,
      "];",
    ].join("\n"),
  );
}

const hermesRegistry = `"""Slash command registry. Every consumer derives from COMMAND_REGISTRY."""
@dataclass(frozen=True)
class CommandDef:
    name: str
    description: str
    category: str

COMMAND_REGISTRY: list[CommandDef] = [
    CommandDef("new", "Start a new session (fresh session ID + history)", "Session",
               aliases=("reset",), args_hint="[name]"),
    CommandDef("model", "Show or change the model", "Configuration",
               args_hint="[name]", gateway_only=False),
    CommandDef("compress", "Compress conversation context (add 'here [N]' to keep recent N turns)", "Session",
               aliases=("compact",), args_hint="[here [N] | --preview]"),
]
`;

function hermesFixture(root, version) {
  write(
    join(root, "hermes_agent.egg-info/PKG-INFO"),
    `Metadata-Version: 2.1\nName: hermes-agent\nVersion: ${version}\n`,
  );
  write(join(root, "hermes_cli/commands.py"), hermesRegistry);
}

test("pi discovery reads the installed builtin registry, not --help", (t) => {
  const root = join(scratch(t), "pi-pkg");
  piFixture(root, "1.3.0", [
    { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
    { name: "compact", description: "Manually compact the session context" },
    { name: "quit", template: true },
  ]);
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: (name) => (name === "pi" ? join(root, "dist/bundle/cli.js") : null),
  });
  const entry = catalog.get("pi");
  assert.equal(entry.status, "complete");
  assert.equal(entry.version, "1.3.0");
  assert.equal(entry.commands.length, 3);
  assert.deepEqual(entry.commands[0], {
    name: "model",
    aliases: [],
    description: "Select model (opens selector UI)",
    args: "<provider/model>",
    source: "pi builtin registry (dist/core/slash-commands.js)",
  });
  // Template-literal descriptions survive without their interpolation.
  assert.equal(entry.commands[2].description, "Quit ");
  assert.ok(entry.discoveredAt && entry.fingerprint.includes("1.3.0"));
});

test("hermes discovery parses COMMAND_REGISTRY with aliases and args", (t) => {
  const root = scratch(t);
  hermesFixture(root, "2.4.1");
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: (name) => (name === "hermes" ? join(root, ".venv/bin/hermes") : null),
  });
  const entry = catalog.get("hermes");
  assert.equal(entry.status, "complete");
  assert.equal(entry.version, "2.4.1");
  const names = entry.commands.map((c) => c.name);
  assert.deepEqual(names, ["new", "model", "compress"]);
  const compress = entry.commands[2];
  assert.deepEqual(compress.aliases, ["compact"]);
  assert.equal(compress.args, "[here [N] | --preview]");
  // Apostrophes inside double-quoted Python strings must not break scanning.
  assert.ok(compress.description.includes("keep recent N turns"));
});

test("cache reuses results and a harness update adding/removing commands invalidates it", (t) => {
  const root = join(scratch(t), "pi-pkg");
  const cache = join(scratch(t), "cache.json");
  piFixture(root, "1.0.0", [
    { name: "alpha", description: "first" },
    { name: "beta", description: "second" },
  ]);
  const locate = (name) => (name === "pi" ? join(root, "dist/bundle/cli.js") : null);
  const catalog = new CommandCatalog({ file: cache, locate });
  const first = catalog.get("pi");
  assert.equal(first.cached, false);
  const second = catalog.get("pi");
  assert.equal(second.cached, true);
  assert.equal(second.discoveredAt, first.discoveredAt);
  // Simulate the installed harness updating: /beta removed, /gamma added.
  piFixture(root, "1.1.0", [
    { name: "alpha", description: "first" },
    { name: "gamma", description: "third" },
  ]);
  const third = catalog.get("pi");
  assert.equal(third.cached, false);
  assert.equal(third.version, "1.1.0");
  assert.deepEqual(third.commands.map((c) => c.name), ["alpha", "gamma"]);
  // A fresh process reads the persisted cache and only validates the fingerprint.
  const reopened = new CommandCatalog({ file: cache, locate });
  const fromDisk = reopened.get("pi");
  assert.equal(fromDisk.cached, true);
  assert.equal(fromDisk.version, "1.1.0");
});

test("force refresh re-discovers even when the fingerprint matches", (t) => {
  const root = join(scratch(t), "pi-pkg");
  piFixture(root, "1.0.0", [{ name: "alpha", description: "first" }]);
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: (name) => (name === "pi" ? join(root, "dist/bundle/cli.js") : null),
  });
  catalog.get("pi");
  const refreshed = catalog.refresh("pi");
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.commands.length, 1);
});

test("missing or unparseable catalogs report unavailable, never a fallback list", (t) => {
  const root = join(scratch(t), "pi-pkg");
  write(join(root, "package.json"), JSON.stringify({ name: "pi", version: "9.9.9" }));
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: (name) => (name === "pi" ? join(root, "dist/bundle/cli.js") : null),
  });
  const missing = catalog.get("pi");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.commands.length, 0);
  // Registry present but a format change yields no parseable entries.
  write(join(root, "dist/core/slash-commands.js"), "export const BUILTIN_SLASH_COMMANDS = computeAtRuntime();");
  const partial = catalog.get("pi");
  assert.equal(partial.status, "unavailable");
  assert.match(partial.reason, /no entries parsed/);
});

test("an absent harness is reported not-installed", (t) => {
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: () => null,
  });
  for (const harness of ["pi", "hermes", "codex", "claude", "opencode"])
    assert.equal(catalog.get(harness).status, "not-installed", harness);
});

test("binary-only harnesses report unavailable with a reason (no hand-written list)", (t) => {
  const root = scratch(t);
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: (name) => join(root, name), // pretend all are installed binaries
  });
  for (const harness of ["opencode", "codex", "claude"]) {
    const entry = catalog.get(harness);
    assert.equal(entry.status, "unavailable", harness);
    assert.equal(entry.commands.length, 0, harness);
    assert.ok(entry.reason.length > 30, harness);
  }
});

test("direct chat has no native commands", (t) => {
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: () => null,
  });
  const entry = catalog.get("direct");
  assert.equal(entry.status, "not-applicable");
  assert.equal(entry.commands.length, 0);
});

test("run() recognizes commands but refuses execution without touching send or inference", (t) => {
  const root = scratch(t);
  hermesFixture(root, "2.4.1");
  const catalog = new CommandCatalog({
    file: join(scratch(t), "cache.json"),
    locate: (name) => (name === "hermes" ? join(root, ".venv/bin/hermes") : null),
  });
  const service = {
    sent: [],
    send() {
      this.sent.push("send was called");
      throw new Error("send must never be called by commands:run");
    },
  };
  const session = { id: "s1", harness: "hermes", messages: [] };
  const result = runNativeCommand({ session, name: "/model", args: "gpt", catalog, service });
  assert.equal(result.executed, false);
  assert.equal(result.command, "model");
  assert.match(result.reason, /not supported/i);
  // The command was never rewritten into a chat prompt.
  assert.equal(service.sent.length, 0);
  // Aliases resolve; unknown names are rejected against the discovered list.
  assert.equal(findCommand(catalog.get("hermes"), "compact").name, "compress");
  const unknown = runNativeCommand({ session, name: "bogus", args: "", catalog, service });
  assert.equal(unknown.executed, false);
  assert.match(unknown.reason, /not in hermes.s discovered command list/);
  // Direct chat never reaches a harness.
  const direct = runNativeCommand({
    session: { id: "s2", harness: "direct", messages: [] },
    name: "model",
    catalog,
    service,
  });
  assert.equal(direct.executed, false);
  assert.match(direct.reason, /Direct chat/);
  assert.equal(service.sent.length, 0);
});

test("discovery never spawns subprocesses, imports network stacks, or calls fetch", () => {
  const source = readFileSync(
    new URL("../electron/commands.mjs", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "child_process",
    "node:http",
    "node:https",
    "fetch(",
    "spawn(",
    "execFile",
    "WebSocket",
  ])
    assert.ok(!source.includes(forbidden), `commands.mjs must not use ${forbidden}`);
});

// ---- pure composer logic (src/features/commands/commandLogic.ts) ------------

const logicSource = readFileSync(
  new URL("../src/features/commands/commandLogic.ts", import.meta.url),
  "utf8",
);
const logicUrl =
  "data:text/javascript;base64," +
  Buffer.from(
    transformSync(logicSource, { loader: "ts", format: "esm" }).code,
  ).toString("base64");
const {
  slashQuery,
  filterCommands,
  insertCommand,
  slashKeyDown,
  classifySubmit,
  MAX_SUGGESTIONS,
} = await import(logicUrl);

const sample = [
  { name: "model", aliases: [], description: "Select model", args: "<provider/model>" },
  { name: "new", aliases: ["reset"], description: "New session" },
  { name: "compact", aliases: ["compress"], description: "Compact context" },
  { name: "copy", aliases: [], description: "Copy answer" },
];

test("suggestions open only for a leading single-slash token", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/mod"), "mod");
  assert.equal(slashQuery("/MOD"), "mod");
  assert.equal(slashQuery("//literal"), null); // literal-slash escape
  assert.equal(slashQuery("/model gpt"), null); // already entering arguments
  assert.equal(slashQuery("hello"), null);
  assert.equal(slashQuery("say /hi"), null); // not at draft start: prose stays
  assert.equal(slashQuery("/new\nmore lines"), null); // multi-line stays a message
});

test("filtering matches names and aliases with names ranked first", () => {
  assert.deepEqual(filterCommands(sample, "").map((c) => c.name), [
    "model",
    "new",
    "compact",
    "copy",
  ]);
  assert.deepEqual(filterCommands(sample, "co").map((c) => c.name), ["compact", "copy"]);
  // Alias-only match ranks after name matches.
  assert.deepEqual(filterCommands(sample, "com").map((c) => c.name), ["compact"]);
  assert.deepEqual(filterCommands(sample, "re").map((c) => c.name), ["new"]);
  assert.deepEqual(filterCommands(sample, "zzz"), []);
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `c${i}`,
    aliases: [],
    description: "",
  }));
  assert.equal(filterCommands(many, "c").length, MAX_SUGGESTIONS);
});

test("keyboard model: arrows wrap, Enter/Tab select only with options, Escape dismisses, IME ignored", () => {
  assert.deepEqual(slashKeyDown({ open: true, index: 0, count: 3 }, "ArrowDown"), {
    handled: true,
    index: 1,
  });
  assert.deepEqual(slashKeyDown({ open: true, index: 0, count: 3 }, "ArrowUp"), {
    handled: true,
    index: 2,
  });
  assert.deepEqual(slashKeyDown({ open: true, index: 2, count: 3 }, "ArrowDown"), {
    handled: true,
    index: 0,
  });
  assert.deepEqual(slashKeyDown({ open: true, index: 1, count: 3 }, "Enter"), {
    handled: true,
    action: "select",
  });
  assert.deepEqual(slashKeyDown({ open: true, index: 1, count: 3 }, "Tab"), {
    handled: true,
    action: "select",
  });
  assert.deepEqual(slashKeyDown({ open: true, index: 0, count: 0 }, "Enter"), {
    handled: false,
  }); // Enter sends the message when nothing is selectable
  assert.deepEqual(slashKeyDown({ open: true, index: 0, count: 2 }, "Escape"), {
    handled: true,
    action: "dismiss",
  });
  assert.deepEqual(slashKeyDown({ open: false, index: 0, count: 2 }, "ArrowDown"), {
    handled: false,
  });
  // IME composition must never be hijacked, even if called by mistake.
  assert.deepEqual(
    slashKeyDown({ open: true, index: 0, count: 2 }, "Enter", true),
    { handled: false },
  );
});

test("completion inserts the command with a trailing space for arguments", () => {
  assert.equal(insertCommand(sample[0]), "/model ");
});

test("submit classification: native commands dispatch, literals and unknown text stay messages", () => {
  assert.deepEqual(classifySubmit("/model localai/gufo", sample), {
    kind: "command",
    name: "model",
    args: "localai/gufo",
  });
  assert.deepEqual(classifySubmit("/compact", sample), {
    kind: "command",
    name: "compact",
    args: "",
  });
  // Alias submissions resolve to the canonical command name.
  assert.deepEqual(classifySubmit("/reset quickly", sample), {
    kind: "command",
    name: "new",
    args: "quickly",
  });
  // "//" sends a literal leading slash as an ordinary message.
  assert.deepEqual(classifySubmit("//model note", sample), {
    kind: "message",
    text: "/model note",
  });
  // Unknown "/word" and every ordinary draft remain message text untouched.
  assert.deepEqual(classifySubmit("/unknownthing", sample), {
    kind: "message",
    text: "/unknownthing",
  });
  assert.deepEqual(classifySubmit("hello", sample), {
    kind: "message",
    text: "hello",
  });
  assert.deepEqual(classifySubmit("use /model in prose", sample), {
    kind: "message",
    text: "use /model in prose",
  });
});
