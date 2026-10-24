// Native slash-command execution for Pi sessions (phase 2).
//
// Commands are dispatched over Pi's RPC control interface (piControl.mjs),
// never through the prompt path. Outcomes are recorded on the session's own
// `commandLog` — deliberately separate from chat messages — and are never
// replayed after an app restart; an in-flight control child dies with the app.
//
// Compaction needs inference (Pi summarizes with the model), so it is routed
// through the scheduler exactly like a turn: it queues for a slot, respects
// pauses and memory headroom, and its compaction_start/compaction_end events
// feed `session.compaction` through the same normalize() path a turn uses.
// Read-only commands (stats) run directly, without holding a slot.

// Self-contained phase-2 refusal (mirrors the phase-1 gate in commands.mjs,
// which may be offline or mid-update). It never sends and never prompts.
function refuse(session, name, detail) {
  return {
    executed: false,
    command: String(name || "").replace(/^\//, "").toLowerCase(),
    reason:
      detail ||
      `/${String(name || "").replace(/^\//, "")} was recognized for ${session.harness}, but native execution is not supported for this harness/mode yet. Nothing was sent as a chat message.`,
  };
}

import { runNativeCommand } from "./commands.mjs";
import { normalize } from "./protocol.mjs";
import {
  PI_COMMAND_MAP,
  PI_CONTROL_PROTOCOL_VERSION,
  SUPPORTED_PI_MAJORS,
  piCommandMapping,
  piRpcSpecFor,
  runPiRpc,
} from "./piControl.mjs";

const PI_COMMAND_LIST = PI_COMMAND_MAP.map((c) => `/${c.name}`).join(", ");

const LOG_LIMIT = 50;

function now() {
  return new Date().toISOString();
}

export class PiCommands {
  constructor({ service }) {
    this.service = service;
    this.running = new Set(); // sid with an in-flight direct (read-only) command
  }
  // True while a control command runs or waits for this session. The
  // scheduler's own per-session queue covers control jobs waiting for a
  // slot; `running` covers direct read-only runs that hold no slot.
  busy(sid) {
    return (
      this.running.has(sid) ||
      this.service.scheduler.active.has(sid) ||
      this.service.scheduler.pending.some((j) => j.sessionId === sid)
    );
  }
  async run(sid, name, args = "") {
    const service = this.service;
    const s = service.store.session(sid);
    const clean = String(name || "").replace(/^\//, "").toLowerCase();
    if (s.harness !== "pi")
      return refuse(
        s,
        clean,
        `/${clean} was recognized, but native execution is not supported for the ${s.harness} harness yet (phase 2 covers Pi over its RPC control interface). Nothing was sent as a chat message.`,
      );
    const mapped = piCommandMapping(clean);
    // Anything outside the verified subset keeps the explicit refusal.
    if (!mapped)
      return refuse(
        s,
        clean,
        `/${clean} is not in the verified set of native Pi control commands (currently ${PI_COMMAND_LIST}); Relay only executes commands it has checked against Pi's RPC interface. Nothing was sent as a chat message.`,
      );
    if (this.busy(sid))
      return {
        executed: false,
        reason: `/${clean} was not sent: this session is busy with a turn or another command. Wait for it to finish or stop it first.`,
      };
    const version = this.piVersion();
    if (!SUPPORTED_PI_MAJORS.has(version))
      return {
        executed: false,
        reason: `Native execution of /${clean} is disabled: this RPC mapping is verified for Pi ${[...SUPPORTED_PI_MAJORS].join("/")}.x, not the installed ${version || "unknown"} version. Nothing was sent as a chat message.`,
      };
    const model = service.store.model(s.modelId);
    let spec;
    try {
      spec = piRpcSpecFor(s, model, service.directory);
    } catch (error) {
      return { executed: false, reason: `/${clean} could not start: ${error.message}` };
    }
    if (mapped.needsInference) {
      // Route compaction through the scheduler like a turn: it waits for an
      // inference slot instead of bypassing capacity control.
      const controller = new AbortController();
      try {
        service.scheduler.enqueue({
          sessionId: sid,
          modelId: s.modelId,
          control: true,
          controller,
          waiting: () => {},
          failed: (error) =>
            this.record(s, clean, "failed", `/${clean} failed: ${error.message}`),
          run: () => this.execute(s, clean, args, mapped, spec),
        });
        return {
          executed: true,
          queued: true,
          command: clean,
          reason: `/${clean} queued: it needs an inference slot; progress appears in the session’s context indicator.`,
        };
      } catch (error) {
        return { executed: false, reason: `/${clean} was not queued: ${error.message}` };
      }
    }
    // Read-only control commands: no slot, no model work.
    this.running.add(sid);
    try {
      return await this.execute(s, clean, args, mapped, spec);
    } finally {
      this.running.delete(sid);
    }
  }
  piVersion() {
    try {
      return this.service.commandCatalog.get("pi")?.version?.split(".")[0] || "";
    } catch {
      return "";
    }
  }
  async execute(s, clean, args, mapped, spec) {
    const service = this.service;
    // Pi may emit compaction events while the command runs; normalize them
    // exactly like a turn's events and feed session.compaction.
    const feed = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      for (const output of normalize("pi", event))
        if (output.type === "compaction") {
          s.compaction = { status: output.value, at: now() };
          service.store.save();
          service.changed();
        }
    };
    const result = await runPiRpc({
      spec,
      command: mapped.rpc,
      params: mapped.toParams(args || ""),
      timeoutMs: mapped.timeoutMs,
      cwd: s.cwd || undefined,
      onEventLine: feed,
    });
    if (result.ok) {
      const summary = mapped.summarize(result.data);
      this.record(s, clean, "ok", "", summary);
      return { executed: true, command: clean, rpc: mapped.rpc, data: result.data, reason: summary };
    }
    const reason = `/${clean} failed: ${result.error}`;
    this.record(s, clean, "failed", reason);
    if (mapped.needsInference) {
      s.compaction = { status: "failed", at: now() };
      service.store.save();
      service.changed();
    }
    return { executed: false, command: clean, rpc: mapped.rpc, reason };
  }
  record(s, command, status, reason = "", summary = "") {
    s.commandLog = (s.commandLog || []).concat({ command, status, at: now(), reason, summary });
    if (s.commandLog.length > LOG_LIMIT) s.commandLog = s.commandLog.slice(-LOG_LIMIT);
    this.service.changed(true);
  }
}

export const PI_CONTROL_VERSION = PI_CONTROL_PROTOCOL_VERSION;
