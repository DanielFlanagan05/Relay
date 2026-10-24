// Native harness slash-command catalogs (phase 1: local discovery + cache).
//
// Hard constraints enforced here and verified by tests/commands.test.mjs:
// - Discovery is strictly local file reads. This module imports no child
//   process, no network stack, and calls no model. (`--help` output is not a
//   slash-command catalog, so we never run harness binaries to discover.)
// - Every read is size-bounded.
// - A harness with no usable local catalog is reported `unavailable` with a
//   per-harness reason; we never substitute a hand-written universal list.
// - runNativeCommand never routes a command into a chat prompt. Phase 1 had
//   no verified native control channel for any harness/mode, so it always
//   returns an explicit "execution not supported" result (see B.report.md for
//   the per-harness execution findings). Phase 2: Pi commands verified against
//   Pi's RPC interface execute in electron/piCommands.mjs before this gate is
//   consulted; everything else still lands here.

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { executable, localPaths } from "./discovery.mjs";

export const COMMAND_HARNESS_IDS = [
  "pi",
  "opencode",
  "hermes",
  "codex",
  "claude",
];

const READ_LIMIT = 4 * 1024 * 1024; // never ingest a file larger than 4 MiB
const SEARCH_DEPTH = 6; // bounded walk-up when locating an installed package

function readBounded(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > READ_LIMIT) return null;
    return { text: readFileSync(path, "utf8"), stat };
  } catch {
    return null;
  }
}

function statToken(path) {
  try {
    const s = statSync(path);
    return `${Math.trunc(s.mtimeMs)}:${s.size}`;
  } catch {
    return "missing";
  }
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Ancestor walk with an explicit depth bound (never an unbounded scan).
function ancestors(start, depth) {
  const out = [];
  let dir = start;
  for (let i = 0; i <= depth; i++) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// ---- small, string-aware scanners -----------------------------------------

// Balanced `[...]` slice starting at or after `from`, skipping string literals.
function scanArray(source, from) {
  const start = source.indexOf("[", from);
  if (start < 0) return null;
  let depth = 0,
    i = start,
    quote = null;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

// Balanced `(...)` slice for a Python call, string-aware; returns inner text.
function scanCall(source, openIndex) {
  let depth = 0,
    quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

const STRING_LITERALS =
  /(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;

function firstString(text) {
  STRING_LITERALS.lastIndex = 0;
  const m = STRING_LITERALS.exec(text);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, "");
}

function fieldOf(block, key) {
  const at = block.search(new RegExp(`\\b${key}\\s*:\\s*(?=["'\`])`));
  if (at < 0) return null;
  const colon = block.indexOf(":", at);
  return firstString(block.slice(colon + 1));
}

// Python keyword argument: `key="value"`.
function kwOf(block, key) {
  const at = block.search(new RegExp(`\\b${key}\\s*=\\s*(?=["'])`));
  if (at < 0) return null;
  const equals = block.indexOf("=", at);
  return firstString(block.slice(equals + 1));
}

function tupleOf(inner, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*\\(`).exec(inner);
  if (!m) return [];
  const slice = scanCall(inner, inner.indexOf("(", m.index));
  if (slice === null) return [];
  const out = [];
  STRING_LITERALS.lastIndex = 0;
  let lit;
  while ((lit = STRING_LITERALS.exec(slice)))
    out.push((lit[1] ?? lit[2] ?? "").replace(/\$\{[^}]*\}/g, ""));
  return out;
}

// Split a call's inner arguments on top-level commas (string/paren aware).
function splitArgs(inner) {
  const parts = [];
  let depth = 0,
    quote = null,
    current = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        current += inner[++i] ?? "";
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
      current += c;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim());
}

// ---- Pi ---------------------------------------------------------------------
// Source of truth: dist/core/slash-commands.js exports BUILTIN_SLASH_COMMANDS,
// the registry the interactive TUI itself renders. Version from package.json.

// Test seam: isolated suites can pin the Pi package version (the RPC command
// mapping is version-pinned; see piControl.mjs) so discovery and execution
// agree without touching the developer's real install.
function piInstall(locate) {
  // Test seam: isolated suites can pin the Pi package version (the RPC
  // command mapping is version-pinned; see piControl.mjs) without touching
  // the developer's real install.
  const pinned = globalThis.__RELAY_PI_VERSION_OVERRIDE__;
  if (pinned !== undefined)
    return { exec: locate("pi") || "pi", root: pinned ? "override:" + pinned : null };
  const exec = locate("pi");
  if (!exec) return null;
  const start = realPath(exec);
  for (const dir of ancestors(dirname(start), SEARCH_DEPTH)) {
    if (existsSync(join(dir, "dist", "core", "slash-commands.js")))
      return { exec, root: dir };
  }
  // Managed localai node install even when the located PATH entry is a wrapper.
  const fallback = join(
    localPaths().data,
    "apps/node/lib/node_modules/@earendil-works/pi-coding-agent",
  );
  if (existsSync(join(fallback, "dist", "core", "slash-commands.js")))
    return { exec, root: fallback };
  return { exec, root: null };
}

const piProvider = {
  fingerprint(ctx, locate) {
    const install = ctx || piInstall(locate);
    if (!install) return "not-installed";
    if (install.root?.startsWith("override:"))
      return `pi-override:${install.root.slice(9)}`;
    if (!install.root) return `no-package:${statToken(install.exec)}`;
    const pkg = readBounded(join(install.root, "package.json"));
    let version = "unknown";
    try {
      version = JSON.parse(pkg?.text || "{}").version || "unknown";
    } catch {}
    return `pi:${version}:${statToken(join(install.root, "dist/core/slash-commands.js"))}`;
  },
  discover(ctx, locate) {
    const install = ctx || piInstall(locate);
    if (!install) return { status: "not-installed", commands: [] };
    if (install.root?.startsWith("override:")) {
      const version = install.root.slice(9);
      if (!version) return { status: "not-installed", commands: [] };
      return {
        status: "complete",
        version,
        commands: [
          { name: "compact", aliases: [], description: "Compact context", args: "", source: "override" },
          { name: "session", aliases: [], description: "Session info", args: "", source: "override" },
        ],
      };
    }
    if (!install.root)
      return {
        status: "unavailable",
        reason:
          "Pi was found but its installed package root (dist/core/slash-commands.js) could not be located.",
        commands: [],
      };
    const pkg = readBounded(join(install.root, "package.json"));
    let version = "unknown";
    try {
      version = JSON.parse(pkg?.text || "{}").version || "unknown";
    } catch {}
    const registry = readBounded(
      join(install.root, "dist/core/slash-commands.js"),
    );
    if (!registry)
      return {
        status: "unavailable",
        version,
        reason: "Pi's slash-command registry file is missing or too large to read.",
        commands: [],
      };
    const declared =
      scanArray(
        registry.text,
        registry.text.indexOf("BUILTIN_SLASH_COMMANDS"),
      ) ?? "";
    const commands = [];
    let depth = 0,
      quote = null,
      start = -1;
    for (let i = 0; i < declared.length; i++) {
      const c = declared[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          const block = declared.slice(start, i + 1);
          const name = fieldOf(block, "name");
          if (name)
            commands.push({
              name,
              aliases: [],
              description: fieldOf(block, "description") || "",
              args: fieldOf(block, "argumentHint") || "",
              source: "pi builtin registry (dist/core/slash-commands.js)",
            });
          start = -1;
        }
      }
    }
    if (!commands.length)
      return {
        status: "unavailable",
        version,
        reason:
          "Pi's installed slash-command registry was found but no entries parsed; the format may have changed.",
        commands: [],
      };
    return { status: "complete", version, commands };
  },
  ctx: piInstall,
};

// ---- Hermes -----------------------------------------------------------------
// Source of truth: hermes_cli/commands.py COMMAND_REGISTRY (`CommandDef(...)`
// entries). The file states every consumer (CLI help, gateway dispatch,
// autocomplete) derives from it, so it is the installed source of truth.

function hermesInstall(locate) {
  const exec = locate("hermes");
  if (!exec) return null;
  const start = realPath(exec);
  const candidates = [];
  for (const dir of ancestors(dirname(start), SEARCH_DEPTH)) {
    candidates.push(dir, join(dir, "hermes"));
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/^python3/i.test(entry.name) && existsSync(join(dir, entry.name, "site-packages")))
          candidates.push(join(dir, entry.name, "site-packages"));
        if (/^lib$/i.test(entry.name)) {
          try {
            for (const py of readdirSync(join(dir, entry.name)))
              if (/^python/i.test(py))
                candidates.push(join(dir, entry.name, py, "site-packages"));
          } catch {}
        }
      }
    } catch {}
  }
  for (const dir of candidates)
    if (existsSync(join(dir, "hermes_cli", "commands.py")))
      return { exec, root: dir };
  return { exec, root: null };
}

function hermesVersion(root) {
  const pkgInfo = readBounded(join(root, "hermes_agent.egg-info", "PKG-INFO"));
  const versionLine = pkgInfo?.text?.match(/^Version:\s*(.+)$/m);
  if (versionLine) return versionLine[1].trim();
  const versionFile = readBounded(join(root, "hermes_cli", "version.py"));
  return versionFile?.text?.match(/__version__\s*=\s*["']([^"']+)["']/)?.[1] || "unknown";
}

const hermesProvider = {
  fingerprint(ctx, locate) {
    const install = ctx || hermesInstall(locate);
    if (!install) return "not-installed";
    if (!install.root) return `no-package:${statToken(install.exec)}`;
    return `hermes:${hermesVersion(install.root)}:${statToken(join(install.root, "hermes_cli/commands.py"))}`;
  },
  discover(ctx, locate) {
    const install = ctx || hermesInstall(locate);
    if (!install) return { status: "not-installed", commands: [] };
    if (!install.root)
      return {
        status: "unavailable",
        reason:
          "Hermes was found but hermes_cli/commands.py (its command registry source) could not be located within the bounded search.",
        commands: [],
      };
    const version = hermesVersion(install.root);
    const registry = readBounded(join(install.root, "hermes_cli/commands.py"));
    if (!registry)
      return {
        status: "unavailable",
        version,
        reason: "Hermes' command registry file is missing or too large to read.",
        commands: [],
      };
    const commands = [];
    const needle = "CommandDef(";
    let at = 0,
      reads = 0;
    while (
      (at = registry.text.indexOf(needle, at)) >= 0 &&
      reads++ < 500 // bounded: a registry this large is malformed; stop scanning
    ) {
      const inner = scanCall(registry.text, at + needle.length - 1);
      at += needle.length;
      if (inner === null) continue;
      const parts = splitArgs(inner);
      const name = firstString(parts[0] || "");
      if (!name || !/^[a-z][a-z0-9_-]*$/i.test(name)) continue;
      commands.push({
        name,
        aliases: tupleOf(inner, "aliases"),
        description: firstString(parts[1] || "") || "",
        args: tupleLike(kwOf(inner, "args_hint")) || "",
        category: firstString(parts[2] || "") || "",
        source: "hermes command registry (hermes_cli/commands.py COMMAND_REGISTRY)",
      });
    }
    if (!commands.length)
      return {
        status: "unavailable",
        version,
        reason:
          "Hermes' command registry was found but no CommandDef entries parsed; the format may have changed.",
        commands: [],
      };
    return { status: "complete", version, commands };
  },
  ctx: hermesInstall,
};

function tupleLike(value) {
  return typeof value === "string" ? value : "";
}

// ---- OpenCode / Codex / Claude Code -----------------------------------------
// These install as single native binaries on this machine (verified in
// B.report.md). Their command sets are compiled in; nothing ships a
// machine-readable manifest we can read without scraping binary strings,
// which would be unreliable and mislabeled. Phase 1 reports unavailable.

function binaryProvider(id, name, reason) {
  return {
    fingerprint(ctx, locate) {
      const exec = locate(id);
      return exec ? `${id}:${statToken(realPath(exec))}` : "not-installed";
    },
    discover(ctx, locate) {
      const exec = locate(id);
      if (!exec) return { status: "not-installed", commands: [] };
      return { status: "unavailable", reason, commands: [] };
    },
    ctx: () => null,
  };
}

export const CATALOG_PROVIDERS = {
  pi: piProvider,
  hermes: hermesProvider,
  opencode: binaryProvider(
    "opencode",
    "OpenCode",
    "OpenCode is installed as a single binary; it ships no bundled machine-readable slash-command catalog in its package or config, so its built-in commands cannot be enumerated locally. Phase 1 reports this instead of guessing.",
  ),
  codex: binaryProvider(
    "codex",
    "Codex",
    "The Codex standalone package ships only the binary plus ripgrep/voice resources (codex-path, codex-resources); no command manifest is bundled. Phase 1 reports this instead of guessing.",
  ),
  claude: binaryProvider(
    "claude",
    "Claude Code",
    "Claude Code is installed as a single native binary (~293 MB) with no bundled command manifest. Custom-command directories (~/.claude/commands) are a later phase. Phase 1 reports this instead of guessing.",
  ),
};

// ---- cache ------------------------------------------------------------------

export class CommandCatalog {
  // `file` persists entries across app starts; fingerprints (installed version
  // + registry/binary mtime+size) invalidate them. All work is in-process file
  // reads; nothing here spawns a subprocess or reaches the network.
  constructor({ file, locate = executable, providers = CATALOG_PROVIDERS }) {
    this.file = file;
    this.locate = locate;
    this.providers = providers;
    this.entries = this.#load();
  }
  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }
  #persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file + ".tmp", JSON.stringify(this.entries), {
        mode: 0o600,
      });
      renameSync(this.file + ".tmp", this.file);
    } catch {}
  }
  // Cheap identity of the local sources (version + file fingerprints) used to
  // decide whether a cached catalog is still valid.
  fingerprint(harness) {
    const provider = this.providers[harness];
    if (!provider) return "unknown-harness";
    return provider.fingerprint(provider.ctx ? provider.ctx(this.locate) : null, this.locate);
  }
  get(harness, { force = false } = {}) {
    if (harness === "direct")
      return {
        harness,
        status: "not-applicable",
        reason: "Direct chat has no native harness commands.",
        commands: [],
      };
    const provider = this.providers[harness];
    if (!provider)
      return {
        harness,
        status: "unavailable",
        reason: `No command catalog provider for harness "${harness}".`,
        commands: [],
      };
    const fingerprint = this.fingerprint(harness);
    const cached = this.entries[harness];
    if (!force && cached && cached.fingerprint === fingerprint)
      return { ...cached, cached: true };
    const result = provider.discover(
      provider.ctx ? provider.ctx(this.locate) : null,
      this.locate,
    );
    const entry = {
      harness,
      version: result.version || null,
      status: result.status,
      reason: result.reason || null,
      commands: result.commands,
      fingerprint,
      discoveredAt: new Date().toISOString(),
    };
    this.entries[harness] = entry;
    this.#persist();
    return { ...entry, cached: false };
  }
  refresh(harness) {
    return this.get(harness, { force: true });
  }
}

// ---- execution (phase 1: explicit refusal, never a chat prompt) -------------
//
// Execution findings (documented in B.report.md): every Relay harness turn is
// launched by electron/adapters.mjs as a fresh headless subprocess whose stdin
// is closed immediately after the prompt (runCLI: `child.stdin.end(...)`), and
// no installed harness exposes a verified local command/control channel from
// that mode. Piping "/model" into a headless prompt invocation would be sent to
// the model as text, which is exactly what must not happen. Until a persistent
// protocol/SDK bridge lands (plan section "Native execution", phase 2+),
// runNativeCommand returns a structured refusal without spawning or sending.

export function findCommand(entry, name) {
  const needle = String(name || "")
    .replace(/^\//, "")
    .toLowerCase();
  return (
    entry?.commands?.find(
      (c) =>
        c.name.toLowerCase() === needle ||
        (c.aliases || []).some((a) => a.toLowerCase() === needle),
    ) || null
  );
}

export function runNativeCommand({ session, name, args = "", catalog }) {
  if (!session) return { executed: false, reason: "Session not found." };
  if (session.harness === "direct")
    return {
      executed: false,
      reason:
        "Direct chat has no native harness commands. Your text will be sent as an ordinary message.",
    };
  const entry = catalog.get(session.harness);
  const command = findCommand(entry, name);
  if (entry.status === "unavailable" || entry.status === "not-installed")
    return {
      executed: false,
      reason: `${session.harness}: ${entry.reason || "no local command catalog is available"}`,
    };
  if (!command)
    return {
      executed: false,
      reason: `/${name} is not in ${session.harness}'s discovered command list (version ${entry.version || "unknown"}). Use Refresh to re-read the local catalog.`,
    };
  return {
    executed: false,
    command: command.name,
    args,
    reason: `/${command.name} was recognized for ${session.harness}${entry.version ? ` ${entry.version}` : ""}, but native execution is not supported for this harness/mode yet: Relay runs each turn as a headless subprocess with stdin closed and this harness exposes no verified native control channel. Nothing was sent as a chat message.`,
  };
}
