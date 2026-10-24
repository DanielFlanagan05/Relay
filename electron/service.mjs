import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  statSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, id, now } from "./store.mjs";
import { Scheduler } from "./scheduler.mjs";
import {
  memory,
  liveRuntime,
  importLocalModels,
  harnesses,
  discoverSkills,
  processIdentity,
  json,
} from "./discovery.mjs";
import { TaskCoordinator } from "./tasks.mjs";
import { DelegationEngine, LIMITS as delegationLimits } from "./delegation.mjs";
import { ArtifactStore, extractArtifacts } from "./artifacts.mjs";
import { resolveSkills, saveSkill, bundledSkills } from "./skills.mjs";
import { effectivePrompt, runCLI, runDirect } from "./adapters.mjs";
import { PiCommands } from "./piCommands.mjs";
import {
  normalizeUsage,
  addUsage,
  finalizeRate,
  estimateOutputTokens,
} from "./usage.mjs";

export class AgentService extends EventEmitter {
  constructor(
    directory,
    {
      memorySource = memory,
      runtimeSource = liveRuntime,
      runner,
      secret = () => undefined,
      localaiRoot = "",
      commandCatalog,
    } = {},
  ) {
    super();
    this.store = new Store(directory);
    this.directory = directory;
    this.commandCatalog = commandCatalog;
    // Native slash-command execution. Pi commands run over Pi's own RPC
    // control interface (piControl.mjs), never through the prompt path.
    this.commands = new PiCommands({ service: this });
    this.artifacts = new ArtifactStore(directory);
    this.tasks = new TaskCoordinator(this);
    this.delegation = new DelegationEngine(this);
    this.memorySource = memorySource;
    this.runtimeSource = runtimeSource;
    this.runner = runner;
    this.secret = secret;
    this.loading = new Map();
    this.owned = new Map();
    this.closed = false;
    const d = this.store.data;
    if (!d.settings.localaiRoot && localaiRoot)
      d.settings.localaiRoot = localaiRoot;
    if (!d.models.length) this.refreshModels();
    else
      for (const imported of importLocalModels(d.settings.localaiRoot)) {
        const existing = d.models.find((m) => m.id === imported.id);
        if (existing)
          Object.assign(existing, {
            baselineParallel: imported.baselineParallel,
            estimatedGiB: imported.estimatedGiB,
          });
      }
    this.scheduler = new Scheduler({
      inspect: (mid) => this.pool(mid),
      memory: memorySource,
      reserveGiB: () => this.store.data.settings.reserveGiB,
      execute: (job) => this.execute(job),
      changed: () => this.changed(),
    });
    this.timer = setInterval(() => {
      if (!this.closed) {
        this.tasks.enforceDeadlines();
        this.delegation.enforceBudgets();
        this.scheduler.pump();
      }
    }, 3000);
    this.timer.unref();
  }
  refreshModels() {
    const d = this.store.data;
    for (const model of importLocalModels(d.settings.localaiRoot)) {
      const existing = d.models.find((m) => m.id === model.id);
      if (!existing) d.models.push(model);
      else
        Object.assign(existing, {
          installed: model.installed,
          baselineParallel: model.baselineParallel,
          estimatedGiB: model.estimatedGiB,
          name: model.name,
          description: model.description,
        });
    }
    for (const model of [
      {
        id: "cloud:codex",
        name: "Codex",
        kind: "cloud",
        model: "",
        harness: "codex",
        engine: "OpenAI",
        parallel: 4,
        context: 200000,
        slotGiB: 0,
        description:
          "Uses your existing Codex CLI login and configured default model",
      },
      {
        id: "cloud:claude",
        name: "Claude Code",
        kind: "cloud",
        model: "",
        harness: "claude",
        engine: "Anthropic",
        parallel: 4,
        context: 200000,
        slotGiB: 0,
        description:
          "Uses your existing Claude Code CLI login and configured default model",
      },
    ])
      if (!d.models.some((m) => m.id === model.id)) d.models.push(model);
    this.store.save();
  }
  pool(mid) {
    const m = this.store.model(mid);
    const runtime = this.runtimeSource();
    // Reserve the controller during startup, before it has written live state.
    const other =
      m.managed &&
      [...(this.scheduler?.active.values() || [])]
        .map((job) => this.store.model(job.modelId))
        .find((model) => model.managed && model.profile !== m.profile);
    let parallel =
      m.kind === "cloud" ? this.store.data.settings.cloudParallel : m.parallel;
    if (m.managed && runtime?.profile === m.profile)
      parallel = Math.min(parallel, runtime.profile_settings?.sessions || 1);
    // Match the controller's startup footprint; resident weights are never charged twice.
    const startupGiB =
      m.managed && !runtime && m.estimatedGiB > 0 && m.baselineParallel
        ? m.estimatedGiB +
          Math.max(0, m.parallel - m.baselineParallel) * m.slotGiB +
          this.store.data.settings.reserveGiB
        : undefined;
    const available =
      startupGiB === undefined ? undefined : this.memorySource().availableGiB;
    const startupBlocked =
      startupGiB !== undefined &&
      (!Number.isFinite(available) || available < startupGiB)
        ? `Startup needs approximately ${startupGiB.toFixed(1)} GiB including the ${this.store.data.settings.reserveGiB} GiB system reserve; ${Number.isFinite(available) ? available.toFixed(1) + " GiB available" : "memory telemetry unavailable"}. Free memory or configure fewer slots.`
        : "";
    return {
      key: m.id,
      startupGiB,
      parallel,
      local: m.kind === "local",
      resident: !!(m.managed && runtime?.profile === m.profile),
      slotGiB: m.slotGiB || 0,
      blocked:
        m.managed && this.unloading
          ? "The current runtime is unloading"
          : other
            ? `${other.profile} is using the managed runtime slot. This profile will wait.`
            : m.managed && runtime && runtime.profile !== m.profile
              ? `${runtime.profile} is loaded. Finish its work and unload it in Compute to switch models.`
              : startupBlocked,
    };
  }
  snapshot() {
    return {
      ...structuredClone(this.store.data),
      memory: this.memorySource(),
      harnesses: harnesses(),
      runtime: this.publicRuntime(),
      pools: this.store.data.models.map((m) => ({
        modelId: m.id,
        ...this.pool(m.id),
        paused: this.scheduler?.paused.has(m.id) || false,
        active: [...(this.scheduler?.active.values() || [])].filter(
          (j) => j.modelId === m.id,
        ).length,
        queued: (this.scheduler?.pending || []).filter(
          (j) => j.modelId === m.id,
        ).length,
      })),
    };
  }
  publicRuntime() {
    const r = this.runtimeSource();
    return r
      ? {
          profile: r.profile,
          pid: r.pid,
          sessions: r.profile_settings?.sessions || 1,
          owned: this.ownsRuntime(r),
        }
      : null;
  }
  ownsRuntime(runtime) {
    const record = json(join(this.directory, "owned-runtime.json"), null);
    return !!(
      record &&
      runtime &&
      record.profile === runtime.profile &&
      record.supervisorPid === runtime.supervisor_pid &&
      record.supervisorIdentity &&
      processIdentity(record.supervisorPid) === record.supervisorIdentity
    );
  }
  changed(persist = false) {
    if (this.closed) return;
    if (persist) this.store.save();
    // One update per frame at most; token streams do not cause a full-render IPC flood.
    if (!this.updateTimer)
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        if (!this.closed) this.emit("changed", this.snapshot());
      }, 70);
  }
  /** Tool-driven delegation is opt-in and limited to the verified Direct chat route. */
  delegationGate({ harness, taskId, busy = false }, requested) {
    if (!requested) return false;
    if (taskId)
      throw new Error(
        "A delegated child cannot delegate. Its own children would be untracked.",
      );
    if (harness !== "direct")
      throw new Error(
        "Tool-driven delegation is currently supported only on Direct chat endpoints. Native harness delegation is not verified; use the Delegate action there.",
      );
    if (busy)
      throw new Error(
        "Stop the current turn before changing delegation for this session",
      );
    return true;
  }
  create(input) {
    this.validatePair(input.modelId, input.harness);
    if (
      input.cwd &&
      (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory())
    )
      throw new Error("Choose an existing workspace directory");
    if (input.harness === "hermes" && input.permission !== "workspace-write")
      throw new Error(
        "Hermes requires workspace write access; choose another harness for read-only work",
      );
    const s = this.store.create({
      ...input,
      delegation: this.delegationGate(
        { harness: input.harness || "direct" },
        input.delegation,
      ),
    });
    this.changed();
    return s.id;
  }
  validatePair(mid, hid) {
    const m = this.store.model(mid);
    if (
      process.env.RELAY_FIXTURE_ENDPOINT &&
      (m.managed ||
        hid !== "direct" ||
        m.endpoint !== process.env.RELAY_FIXTURE_ENDPOINT)
    )
      throw new Error("Fixture mode refuses real models and native harnesses");
    if (m.harness && hid !== m.harness)
      throw new Error(`Select the ${m.harness} harness for this connection`);
    if (!m.harness && !["direct", "pi", "opencode", "hermes"].includes(hid))
      throw new Error("Select a local harness for this model");
    if (!m.managed && !m.harness && hid !== "direct")
      throw new Error(
        "Custom endpoints currently support Direct chat. Import a LocalAi profile to use a coding harness.",
      );
    const h = harnesses().find((h) => h.id === hid);
    if (!h?.available && !this.runner)
      throw new Error(`${h?.name || hid} is not installed. Check Connections.`);
    if (m.managed && !m.installed && !this.runner)
      throw new Error(
        "This profile’s model weights are not installed. Choose an installed model.",
      );
  }
  updateSession(sid, patch) {
    const s = this.store.session(sid);
    if (
      s.taskId &&
      ["modelId", "harness", "cwd", "permission"].some((k) => k in patch)
    )
      throw new Error(
        "A child task cannot expand or change its inherited capabilities",
      );
    const busy =
      this.scheduler.active.has(sid) ||
      this.scheduler.pending.some((j) => j.sessionId === sid);
    if (
      busy &&
      ["modelId", "harness", "cwd", "permission"].some((k) => k in patch)
    )
      throw new Error(
        "Stop the current turn before changing its configuration",
      );
    if (
      (patch.modelId && patch.modelId !== s.modelId) ||
      (patch.harness && patch.harness !== s.harness)
    ) {
      this.validatePair(patch.modelId || s.modelId, patch.harness || s.harness);
      delete s.remoteId;
      s.nativeId = id();
    }
    if ("cwd" in patch && patch.cwd !== s.cwd) {
      if (
        patch.cwd &&
        (!existsSync(patch.cwd) || !statSync(patch.cwd).isDirectory())
      )
        throw new Error("Workspace directory does not exist");
      delete s.remoteId;
      s.nativeId = id();
    }
    if (
      (patch.harness || s.harness) === "hermes" &&
      (patch.permission || s.permission) !== "workspace-write"
    )
      throw new Error("Hermes does not support read-only work");
    if ("delegation" in patch)
      patch.delegation = this.delegationGate(
        {
          harness: patch.harness || s.harness,
          taskId: s.taskId,
          busy,
        },
        patch.delegation,
      );
    Object.assign(s, patch, { updatedAt: now() });
    this.changed(true);
  }
  // Native harness slash commands (phase 2). Pi commands execute over Pi's
  // own RPC control interface; every other route keeps the explicit
  // refusal. Outcomes are recorded on the session, never as chat messages.
  runCommand(sid, name, args = "") {
    return this.commands.run(sid, name, args);
  }
  send(sid, text, internal = {}) {
    const s = this.store.session(sid);
    if (this.delegation.openRound(sid))
      throw new Error(
        "This agent is waiting on delegated tasks. Stop the agent to take over the turn.",
      );
    if (s.taskId && internal.taskId !== s.taskId)
      throw new Error(
        "Child tasks are read-only records. Fork a child to continue independently.",
      );
    if (s.archived)
      throw new Error("Restore this session before sending a message");
    this.validatePair(s.modelId, s.harness);
    if (
      this.scheduler.active.has(sid) ||
      this.scheduler.pending.some((j) => j.sessionId === sid)
    )
      throw new Error("Wait for this session’s current turn to finish");
    const resolved = resolveSkills(this.store.data, s);
    const hooks = structuredClone(resolved.skills);
    const outputFormat = s.outputFormat;
    const user = {
      id: id(),
      role: "user",
      content: text,
      createdAt: now(),
      hookNames: hooks.map((h) => h.name),
      hookSnapshot: hooks,
      instructionWarnings: resolved.warnings,
    };
    const answer = {
      id: id(),
      role: "assistant",
      content: "",
      thinking: "",
      tools: [],
      createdAt: now(),
      status: "streaming",
    };
    s.messages.push(user, answer);
    s.status = "queued";
    s.draft = "";
    s.nextTurnHookIds = [];
    s.disabledNextTurnHookIds = [];
    s.updatedAt = now();
    s.queueReason = "Waiting for an inference slot";
    if (s.title === "New session") s.title = text.slice(0, 55);
    this.store.save();
    const controller = new AbortController();
    this.scheduler.enqueue({
      sessionId: sid,
      modelId: s.modelId,
      answerId: answer.id,
      outputFormat,
      taskId: internal.taskId,
      settled: () => this.tasks.settled(sid),
      prompt: effectivePrompt(s, text, hooks),
      controller,
      waiting: (reason) => {
        if (s.queueReason !== reason) {
          s.queueReason = reason;
          this.changed();
        }
      },
      failed: (error) => this.fail(s, answer, error),
    });
    this.changed();
  }
  fail(s, answer, error) {
    const aborted = error.name === "AbortError";
    // A stopped or failed parent must not leave children holding slots.
    this.delegation?.abortFor(s);
    s.status = aborted ? "stopped" : "error";
    s.queueReason = "";
    s.error = aborted ? "" : String(error.message).slice(0, 8000);
    if (!aborted) this.logUnnaturalStop(s, error);
    answer.status = aborted ? "stopped" : "error";
    s.updatedAt = now();
    this.changed(true);
  }
  // Every non-user stop is recorded with the runtime's own stop reason, so
  // "Connection error." can be traced to its cause (e.g. memory reserve exhausted).
  logUnnaturalStop(s, error) {
    let runtime = null;
    try {
      const file = join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
        "localai/stop-events.jsonl",
      );
      const last = readFileSync(file, "utf8").trim().split("\n").pop();
      const event = JSON.parse(last);
      // Only blame the runtime for a stop that happened shortly before.
      if (Date.now() - Date.parse(event.time) < 10 * 60 * 1000) runtime = event;
    } catch {}
    if (runtime && !runtime.natural)
      s.error = `${s.error}\nRuntime stopped: ${runtime.cause}.`.slice(0, 8000);
    try {
      appendFileSync(
        join(this.directory, "agent-stops.log"),
        JSON.stringify({
          time: new Date().toISOString(),
          session: s.title,
          sessionId: s.id,
          error: String(error.message).slice(0, 500),
          runtime,
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {}
  }
  async execute(job) {
    // A native slash-command control job (Pi /compact) holds an inference
    // slot but has no answer message; it runs through PiCommands instead of
    // the turn pipeline below.
    if (job.control) return job.run();
    const s = this.store.session(job.sessionId),
      model = this.store.model(job.modelId);
    const answer = s.messages.find((m) => m.id === job.answerId);
    const started = Date.now();
    // A parked continuation reuses this answer, so elapsed time accumulates
    // across execution segments and never counts the queued wait between them.
    const baseMs = answer.elapsedMs || 0;
    // A continuation reuses the existing answer; it never starts a new turn.
    if (!job.roundId) this.tasks.started(s.id);
    const round = job.roundId
      ? this.delegation.find(job.roundId)
      : this.delegation.begin({ session: s, answer, prompt: job.prompt });
    if (job.roundId && !round)
      throw new Error(
        "The delegation this turn was waiting on no longer exists",
      );
    if (round) round.resumedAt = now();
    s.error = "";
    s.queueReason = "";
    s.status = model.managed ? "loading" : "running";
    this.changed(true);
    let lastSave = Date.now();
    let generationStarted = 0;
    const baseActiveMs = answer.activeMs || 0;
    const updateTiming = () => {
      answer.elapsedMs = baseMs + Date.now() - started;
      answer.activeMs =
        baseActiveMs + (generationStarted ? Date.now() - generationStarted : 0);
      const rate = finalizeRate({
        turnOutput: answer.turnUsage?.output,
        generatedText: answer.content + answer.thinking,
        elapsedMs: answer.activeMs,
      });
      answer.tokensPerSecond = rate.rate || 0;
      answer.estimatedRate = rate.estimated || false;
      answer.rateKind = "turn-throughput";
    };
    const emit = (event) => {
      if (job.controller.signal.aborted) return;
      if (event.type === "remoteId") {
        s.remoteId = event.value;
        this.store.save();
      }
      if (event.type === "delta") {
        answer.content += event.value;
      }
      if (event.type === "thinking") answer.thinking += event.value;
      // Tool events are display data only; execution happens in the engine.
      if (event.type === "tool") {
        answer.tools.push({ ...event.value, at: now() });
        if (answer.tools.length > 250) answer.tools.shift();
      }
      if (event.type === "compaction") {
        s.compaction = { status: event.value, at: now() };
        this.store.save();
      }
      if (event.type === "diagnostic") {
        answer.tools.push({
          name: "Provider notice",
          output: event.value,
          at: now(),
        });
      }
      if (event.type === "usage") {
        const usage = normalizeUsage(event.value);
        if (usage) {
          // usage = this provider request (context occupancy on input);
          // turnUsage = cumulative across every request in the turn.
          answer.usage = usage;
          answer.turnUsage = addUsage(answer.turnUsage, usage);
          answer.usageReports = (answer.usageReports || 0) + 1;
          if (usage.scope === "request")
            answer.requests = (answer.requests || 0) + 1;
        }
      }
      updateTiming();
      if (Date.now() - lastSave > 700) {
        this.store.save();
        lastSave = Date.now();
      }
      this.changed();
    };
    try {
      job.controller.signal.throwIfAborted();
      if (model.managed && !this.runner)
        await this.ensureRuntime(model, job.controller.signal);
      job.controller.signal.throwIfAborted();
      s.status = "running";
      generationStarted = Date.now();
      this.changed(true);
      const run = this.runner || (s.harness === "direct" ? runDirect : runCLI);
      for (;;) {
        // Rounds, tool calls and elapsed time are all capped; the last round
        // deliberately carries no tools so the answer can only summarize.
        const budget =
          !round ||
          (!round.final &&
            round.round < delegationLimits.rounds &&
            round.calls < delegationLimits.callsTotal);
        const outcome = await run({
          session: s,
          model,
          prompt: round ? round.prompt : job.prompt,
          ...(round
            ? {
                messages: this.delegation.conversation(round, answer),
                tools: budget ? this.delegation.specs : [],
              }
            : {}),
          directory: this.directory,
          signal: job.controller.signal,
          emit,
          apiKey: this.secret(model.id),
        });
        if (!round) {
          // Delegation is off for this session: unsolicited tool calls from the
          // endpoint are inert, never an action.
          if (outcome?.toolCalls?.length)
            emit({
              type: "diagnostic",
              value:
                "The endpoint returned tool calls but delegation is disabled for this session. Nothing was executed.",
            });
          break;
        }
        const actions = this.delegation.compile({
          round,
          session: s,
          outcome,
          emit,
          deny: !budget,
        });
        const { parked } = await this.delegation.run({
          round,
          session: s,
          actions,
          emit,
        });
        // Parked: this job ends here, the scheduler slot is released, and a
        // continuation job resumes the same answer once the children settle.
        if (parked) {
          round.round += 1;
          updateTiming();
          this.changed(true);
          return;
        }
        if (!budget || !actions.length) break;
        round.round += 1;
      }
      if (round) this.delegation.finish(round, "complete");
      job.controller.signal.throwIfAborted();
      s.status = "idle";
      answer.status = "complete";
      s.updatedAt = now();
      if (job.outputFormat !== "markdown") {
        const parsed = extractArtifacts(answer.content);
        answer.artifacts = [];
        answer.artifactErrors = parsed.errors;
        for (const block of parsed.blocks) {
          try {
            answer.artifacts.push(this.artifacts.put(s, answer, block));
          } catch (error) {
            answer.artifactErrors.push(
              `Could not save artifact: ${error.message}`,
            );
          }
        }
      }
      updateTiming();
      this.emit("completed", { sessionId: s.id, title: s.title });
      this.changed(true);
    } catch (error) {
      updateTiming();
      this.fail(s, answer, error);
    }
  }
  async ensureRuntime(model, signal) {
    signal.throwIfAborted();
    let current = this.runtimeSource();
    if (current && current.profile !== model.profile)
      throw new Error(
        `${current.profile} is loaded. Finish its sessions and unload it before switching.`,
      );
    if (current?.profile === model.profile)
      return this.waitHealthy(model, signal);
    if (!this.loading.has(model.id)) {
      const promise = this.launchRuntime(model).finally(() =>
        this.loading.delete(model.id),
      );
      this.loading.set(model.id, promise);
    }
    await this.loading.get(model.id);
    signal.throwIfAborted();
    return this.waitHealthy(model, signal);
  }
  async launchRuntime(model) {
    if (process.env.RELAY_FIXTURE_ENDPOINT)
      throw new Error("Fixture mode cannot start model runtimes");
    const root = this.store.data.settings.localaiRoot;
    if (!existsSync(join(root, "scripts/linux/localai.py")))
      throw new Error("Set the LocalAi repository path in Settings");
    // Every import points to the existing shared model store; no weights are copied.
    const logPath = join(this.directory, "runtime.log");
    const log = openSync(logPath, "a", 0o600);
    const bridge = join(
      dirname(fileURLToPath(import.meta.url)),
      "localai_bridge.py",
    ).replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
    const child = spawn(
      "python3",
      [
        bridge,
        "--root",
        root,
        "--profile",
        model.profile,
        "--sessions",
        String(model.parallel),
        "--slot-gib",
        String(model.slotGiB),
        "--reserve-gib",
        String(this.store.data.settings.reserveGiB),
      ],
      { detached: true, stdio: ["ignore", log, log], env: process.env },
    );
    closeSync(log);
    child.on("error", (error) => {
      this.launchError = error.message;
    });
    this.owned.set(model.id, child);
    child.unref();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const identity = processIdentity(child.pid);
    if (identity) {
      const file = join(this.directory, "owned-runtime.json");
      writeFileSync(
        file + ".tmp",
        JSON.stringify({
          profile: model.profile,
          supervisorPid: child.pid,
          supervisorIdentity: identity,
        }),
        { mode: 0o600 },
      );
      renameSync(file + ".tmp", file);
    }
  }
  async waitHealthy(model, signal) {
    const deadline = Date.now() + 30 * 60 * 1000;
    const health = model.engine === "gufo" ? "/ready" : "/health";
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const child = this.owned.get(model.id);
      if (child && (child.exitCode !== null || child.signalCode !== null))
        throw new Error(
          "Model startup failed. Open runtime.log from Settings for controller diagnostics.",
        );
      if (this.launchError) {
        const error = this.launchError;
        this.launchError = "";
        throw new Error(error);
      }
      try {
        const response = await fetch(new URL(health, model.endpoint), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        });
        if (response.ok && this.runtimeSource()?.profile === model.profile)
          return;
      } catch (error) {
        if (signal.aborted) throw error;
      }
      await new Promise((resolve) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
    throw new Error("Model startup exceeded 30 minutes. Inspect runtime.log.");
  }
  cancel(sid) {
    const s = this.store.session(sid);
    // A parked parent has no job to abort: retire its round and descendants.
    const parked = this.delegation.pendingRound(sid);
    if (parked) {
      this.delegation.retire(
        parked,
        "canceled",
        "The parent session was stopped with Stop task and children.",
      );
      if (
        !this.scheduler.active.has(sid) &&
        !this.scheduler.pending.some((j) => j.sessionId === sid)
      ) {
        const answer = s.messages.find((m) => m.id === parked.parentAnswerId);
        if (answer && answer.status === "streaming") answer.status = "stopped";
        s.status = "stopped";
        s.queueReason = "";
        s.error = "";
        this.changed(true);
      }
    }
    const queued = this.scheduler.cancel(sid);
    if (queued)
      this.fail(
        s,
        s.messages.at(-1),
        new DOMException("Turn stopped", "AbortError"),
      );
    if (queued) this.tasks.settled(sid);
    this.changed();
  }
  fork(sid) {
    const s = this.store.session(sid);
    const fork = this.store.create({
      title: `${s.title} · fork`,
      delegation: false,
      modelId: s.modelId,
      harness: s.harness,
      cwd: s.cwd,
      hookIds: [...s.hookIds],
      thinking: s.thinking,
      parentId: sid,
    });
    fork.messages = structuredClone(
      s.messages.filter((m) => m.status !== "streaming"),
    );
    fork.permission = s.permission;
    this.changed(true);
    return fork.id;
  }
  handoff(sid, summary) {
    const s = this.store.session(sid);
    const next = this.store.create({
      title: `${s.title} · handoff`,
      modelId: s.modelId,
      harness: s.harness,
      cwd: s.cwd,
      hookIds: [...s.hookIds],
      thinking: s.thinking,
      parentId: sid,
    });
    next.permission = s.permission;
    next.messages = [
      {
        id: id(),
        role: "user",
        content: `Context handoff from an earlier conversation:\n\n${summary}`,
        createdAt: now(),
      },
    ];
    this.changed(true);
    return next.id;
  }
  remove(sid) {
    if (
      this.store.data.tasks.some(
        (t) => t.childSessionId === sid || t.parentSessionId === sid,
      )
    )
      throw new Error("Archive task sessions to retain their result history");
    if (
      this.scheduler.active.has(sid) ||
      this.scheduler.pending.some((j) => j.sessionId === sid)
    )
      throw new Error("Stop this session before deleting it");
    this.store.data.sessions = this.store.data.sessions.filter(
      (s) => s.id !== sid,
    );
    this.changed(true);
  }
  upsertModel(model) {
    const old = this.store.data.models.find((m) => m.id === model.id);
    if (this.scheduler.active.size && old?.managed)
      throw new Error("Finish active work before changing runtime limits");
    if (
      old?.managed &&
      ["profile", "engine", "endpoint", "kind", "managed"].some(
        (k) => k in model && model[k] !== old[k],
      )
    )
      throw new Error("Imported runtime identity cannot be changed");
    if (old) Object.assign(old, model);
    else this.store.data.models.push(model);
    this.changed(true);
  }
  async unload() {
    if (
      [...this.scheduler.active.values()].some(
        (j) => this.store.model(j.modelId).managed,
      )
    )
      throw new Error(
        "Stop or finish all active local sessions before unloading",
      );
    const runtime = this.runtimeSource();
    if (!runtime) return;
    if (!this.ownsRuntime(runtime))
      throw new Error(
        "This runtime was started outside Relay. Stop it with localai stop; Relay only unloads its own runtimes.",
      );
    this.unloading = true;
    this.changed();
    try {
      // Revalidate persisted supervisor identity immediately before signaling it.
      if (!this.ownsRuntime(runtime))
        throw new Error("Runtime ownership changed; refresh Compute");
      process.kill(runtime.supervisor_pid, "SIGTERM");
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && this.runtimeSource()?.pid === runtime.pid)
        await new Promise((resolve) => setTimeout(resolve, 150));
      if (this.runtimeSource()?.pid === runtime.pid)
        throw new Error("Runtime is still stopping. Inspect runtime.log.");
      for (const [mid] of this.owned)
        if (this.store.model(mid).profile === runtime.profile)
          this.owned.delete(mid);
      rmSync(join(this.directory, "owned-runtime.json"), { force: true });
    } finally {
      this.unloading = false;
      this.changed();
      this.scheduler.pump();
    }
  }
  artifact(sid, artifactId) {
    const s = this.store.session(sid);
    const record = s.messages
      .flatMap((m) => m.artifacts || [])
      .find((a) => a.id === artifactId);
    if (!record) throw new Error("Artifact not found in this session");
    return this.artifacts.get(record);
  }
  effectiveSkills(sid) {
    return resolveSkills(this.store.data, this.store.session(sid));
  }
  saveSkill(input) {
    const result = saveSkill(this.store.data, input);
    this.changed(true);
    return result;
  }
  resetSkill(id) {
    const original = bundledSkills().find((s) => s.id === id);
    if (!original) throw new Error("No bundled original exists");
    this.store.data.hooks = this.store.data.hooks.filter((s) => s.id !== id);
    this.store.data.hooks.push(original);
    this.changed(true);
  }
  skills(cwd) {
    return discoverSkills(cwd);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.updateTimer);
    this.scheduler.close();
    // The shared model is deliberately left resident; quitting the UI doesn't kill external consumers.
    this.store.save();
  }
}
