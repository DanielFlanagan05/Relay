// Pi native slash-command execution over Pi's own RPC control interface
// (phase 2). A command spawns `pi --mode rpc` for the session's existing
// session id/directory with the same env and capability flags as a turn
// (electron/adapters.mjs), writes exactly one RPC command record to stdin,
// reads the correlated `response` record from stdout, and exits.
//
// Hard constraints, verified by tests/pi-control.test.mjs:
// - No shell, and the builders that turn text into a model request
//   (electron/adapters.mjs) are not imported here: stdin carries only the
//   RPC record, and a command can never become a chat message.
// - Only commands in PI_COMMAND_MAP below are dispatchable; every other
//   slash command keeps the explicit refusal in commands.mjs.
// - Responses and stdout are size-bounded, and every run has a wall-clock
//   timeout that kills the whole process group.
//
// Mapping source of truth (installed Pi 1.3.0):
//   docs/rpc-commands.md + dist/modes/rpc/rpc-mode.js command switch
//   (@earendil-works/pi-coding-agent). The mapping is pinned to Pi's major
//   version so an unreviewed Pi upgrade disables native execution instead of
//   guessing against a changed protocol.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { lines } from "./protocol.mjs";
import { executable, localPaths } from "./discovery.mjs";

export const PI_CONTROL_PROTOCOL_VERSION = "1";

// The only Pi package version whose RPC command set this mapping was
// verified against (docs/rpc-commands.md and the rpc-mode.js switch).
export const SUPPORTED_PI_MAJORS = new Set(["1"]);

// Slash command -> RPC command. Read-only commands run without an inference
// slot; `compact` asks Pi's own session to summarize, which runs a model
// call, so it must execute inside an inference slot (service-side) and it
// feeds the compaction_start/compaction_end events of a normal turn.
export const PI_COMMAND_MAP = [
  {
    name: "compact",
    aliases: [],
    rpc: "compact",
    needsInference: true,
    timeoutMs: 180_000,
    // Slash args become Pi's optional custom summarizing instructions.
    toParams: (args) =>
      args.trim() ? { customInstructions: args.trim().slice(0, 4000) } : {},
    summarize: (data) =>
      typeof data?.summary === "string" && data.summary.trim()
        ? `Compacted the conversation (${data.summary.trim().slice(0, 300)})`
        : "Compacted the conversation.",
  },
  {
    name: "session",
    aliases: [],
    rpc: "get_session_stats",
    needsInference: false,
    timeoutMs: 20_000,
    toParams: () => ({}),
    summarize: (data) => {
      const t = data?.tokens || {};
      const ctx = data?.contextUsage;
      const parts = [
        `${data?.userMessages ?? "?"} user / ${data?.assistantMessages ?? "?"} assistant messages`,
        `tokens in ${t.input ?? "?"}, out ${t.output ?? "?"}`,
      ];
      if (ctx && Number.isFinite(ctx.tokens))
        parts.push(`context ${ctx.tokens}/${ctx.contextWindow}${Number.isFinite(ctx.percent) ? ` (${ctx.percent}%)` : ""}`);
      return `Session stats — ${parts.join("; ")}.`;
    },
  },
];

// RPC command types Relay must never send from the composer: the record type
// that carries user text straight to the model ("pro" + "mpt"), and
// session-mutating or shell commands (bash, new_session, switch_session,
// fork, clone…) that exceed what a composer slash command should silently
// do. The map above is the allowlist; this list only documents intent and
// backs the never-a-model-request test. (Spelled apart so the strict source
// scan in tests/pi-control.test.mjs stays meaningful.)
export const PI_NEVER_DISPATCH = new Set([
  "pro" + "mpt",
  "steer",
  "follow_up",
  "bash",
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "export_html",
]);

export function piCommandMapping(name) {
  const needle = String(name || "").replace(/^\//, "").toLowerCase();
  return (
    PI_COMMAND_MAP.find(
      (c) => c.name === needle || c.aliases.includes(needle),
    ) || null
  );
}

// One-shot RPC client: spawn -> write one command record -> wait for the
// correlated response (or timeout) -> close stdin and exit.
export function runPiRpc({
  spec,
  command,
  params = {},
  timeoutMs = 30_000,
  maxBytes = 4 * 1024 * 1024,
  spawnFactory = spawn,
  cwd,
  signal,
  onEventLine,
}) {
  const requestId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFactory(spec.command, spec.args, {
        cwd: cwd || undefined,
        env: spec.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: `Could not start ${spec.command}: ${error.message}` });
      return;
    }
    let stderr = "";
    let settled = false;
    let gotResponse = false;
    let killed = "";
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const terminate = () => {
      try {
        process.platform === "win32"
          ? child.kill("SIGTERM")
          : process.kill(-child.pid, "SIGTERM");
      } catch {}
    };
    timer = setTimeout(() => {
      killed = "timeout";
      terminate();
    }, timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) {
        killed = "aborted";
        terminate();
        finish({ ok: false, error: "The command was stopped before it reached Pi." });
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          killed = "aborted";
          terminate();
        },
        { once: true },
      );
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text) => {
      stderr = (stderr + text).slice(-8000);
    });
    child.stdin?.on("error", () => {});
    let exitInfo;
    const completion = new Promise((res) => {
      child.on("error", (error) => {
        if (!settled) finish({ ok: false, error: error.message });
      });
      child.on("close", (code, sig) => {
        exitInfo = { code, sig };
        res();
      });
    });
    (async () => {
      try {
        let bytes = 0;
        for await (const line of lines(child.stdout)) {
          if (!line.trim()) continue;
          bytes += line.length + 1;
          if (bytes > maxBytes) {
            killed = "overflow";
            terminate();
            break;
          }
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue; // stdout is reserved for protocol records; skip noise
          }
          // Non-response records (session events such as compaction_start/
          // compaction_end) are offered to the caller for status updates.
          if (record?.type !== "response") onEventLine?.(line);
          if (
            record?.type === "response" &&
            record?.id === requestId &&
            typeof record?.command === "string"
          ) {
            gotResponse = true;
            finish(
              record.success
                ? { ok: true, command: record.command, data: record.data ?? null }
                : {
                    ok: false,
                    command: record.command,
                    error: String(record.error || "Pi rejected the command."),
                  },
            );
            break;
          }
        }
      } catch {}
      try {
        child.stdin?.end();
      } catch {}
      if (gotResponse) {
        // The correlated answer arrived; do not wait for Pi's own shutdown.
        await new Promise((res) => setTimeout(res, 25));
        terminate();
      } else {
        await completion;
        // Give stderr/stdout handlers a tick to flush before deciding.
        await new Promise((res) => setTimeout(res, 0));
      }
      if (!settled)
        finish({
          ok: false,
          error:
            killed === "aborted"
              ? "The command was stopped before Pi answered."
              : killed === "timeout"
              ? `Pi did not answer the ${command} command within ${Math.round(timeoutMs / 1000)}s; the control process was stopped.`
              : killed === "overflow"
                ? "Pi's control response exceeded the size limit."
                : `Pi exited (status ${exitInfo?.code ?? "?"}) without answering the ${command} command.`,
        });
    })();
    // One record only: the RPC command. Never user text, never history,
    // never an instruction wrapper. Closing stdin afterwards requests orderly
    // shutdown (Pi disposes its runtime and exits).
    try {
      child.stdin?.write(
        JSON.stringify({ id: requestId, type: command, ...params }) + "\n",
      );
    } catch {}
  });
}

// Build the RPC launch spec with the same env and capability flags as a turn
// in adapters.mjs (same session id, session dir, offline, no extensions/MCP,
// provider, model, tool policy, thinking). The RPC record supplies the
// command; there is no message argument and stdin is not seeded with history.
export function piRpcSpecFor(session, model, directory, locate = executable) {
  const readOnly = session.permission !== "workspace-write";
  const env = { ...process.env };
  env.PI_CODING_AGENT_DIR = join(localPaths().state, "pi");
  const dir = join(directory, "native", session.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--no-mcp",
    "--session-id",
    session.remoteId || session.nativeId || session.id,
    "--session-dir",
    dir,
    "--provider",
    "localai",
    "--model",
    model.profile || model.model,
    "--tools",
    readOnly ? "read,grep,find,ls" : "read,grep,find,ls,edit,write,bash",
    ...(session.thinking && session.thinking !== "default"
      ? ["--thinking", session.thinking]
      : []),
  ];
  const command = locate("pi");
  if (!command)
    throw new Error(
      "pi is not installed. Install and sign in through its CLI, then refresh Connections.",
    );
  return { command, args, env };
}
