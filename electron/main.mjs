import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  safeStorage,
  Menu,
} from "electron";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { z } from "zod";
import { AgentService } from "./service.mjs";
import { id } from "./store.mjs";
import { taskInput } from "./tasks.mjs";
import { validateArtifact } from "./artifacts.mjs";
import { CommandCatalog, runNativeCommand } from "./commands.mjs";
import { collectProcesses } from "./processTelemetry.mjs";

const root = dirname(fileURLToPath(import.meta.url));
if (process.env.RELAY_DATA_DIR)
  app.setPath("userData", resolve(process.env.RELAY_DATA_DIR));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let window, service, commandCatalog;
const text = z.string().max(10000),
  sid = z.string().uuid();
const model = z
  .object({
    id: text,
    name: z.string().min(1).max(250),
    kind: z.enum(["local", "cloud"]),
    model: text,
    endpoint: z.string().url().optional(),
    context: z.number().int().min(4096).max(2000000),
    parallel: z.number().int().min(1).max(16),
    slotGiB: z.number().min(0).max(128),
    description: text.optional(),
  })
  .strict();
const hook = z
  .object({
    id: text,
    name: z.string().min(1).max(120),
    description: text,
    content: z.string().min(1).max(60000),
    source: text.optional(),
    category: z.enum(["style", "workflow", "output"]).optional(),
  })
  .strict();
// Pi reasoning level; "default" passes no --thinking flag (the harness decides).
const thinkingLevel = z.enum([
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const sessionPatch = z
  .object({
    title: z.string().min(1).max(250).optional(),
    modelId: text.optional(),
    harness: z
      .enum(["direct", "pi", "opencode", "hermes", "codex", "claude"])
      .optional(),
    cwd: text.optional(),
    permission: z.enum(["read-only", "workspace-write"]).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    hookIds: z.array(text).max(30).optional(),
    nextTurnHookIds: z.array(text).max(30).optional(),
    disabledNextTurnHookIds: z.array(text).max(30).optional(),
    outputFormat: z.enum(["auto", "markdown", "html"]).optional(),
    thinking: thinkingLevel.optional(),
    draft: z.string().max(200000).optional(),
    // Experimental, per-session opt-in. Direct chat only; the backend rejects
    // every other route rather than pretending a native harness is bridged.
    delegation: z.boolean().optional(),
  })
  .strict();
const schemas = {
  snapshot: z.object({}),
  refresh: z.object({}),
  // Display-only per-process memory for the Local compute page. No input, and the
  // payload carries only PID, name, owner uid, and measured resident memory.
  processes: z.object({}).strict(),
  chooseFolder: z.object({}),
  openData: z.object({}),
  create: z
    .object({
      modelId: text,
      harness: text,
      cwd: text.optional(),
      hookIds: z.array(text).max(30).optional(),
      permission: z.enum(["read-only", "workspace-write"]).optional(),
      preset: z.enum(["chat", "implement", "review", "plan"]).optional(),
      thinking: thinkingLevel.optional(),
      delegation: z.boolean().optional(),
    })
    .strict(),
  updateSession: z.object({ sid, patch: sessionPatch }).strict(),
  send: z.object({ sid, text: z.string().trim().min(1).max(200000) }).strict(),
  // Native harness slash commands. Deliberately separate from `send`: a
  // command never enters the prompt/inference path. Discovery is local-only
  // (electron/commands.mjs); phase 1 execution returns an explicit reason.
  commandsList: z.object({ sessionId: sid }).strict(),
  commandsRefresh: z
    .object({
      harness: z.enum(["pi", "opencode", "hermes", "codex", "claude"]),
    })
    .strict(),
  commandsRun: z
    .object({
      sessionId: sid,
      name: z
        .string()
        .regex(/^\/?[a-z][a-z0-9_-]{0,49}$/i)
        .max(50),
      args: z.string().max(4000).optional(),
    })
    .strict(),
  cancel: z.object({ sid }).strict(),
  fork: z.object({ sid }).strict(),
  remove: z.object({ sid }).strict(),
  export: z.object({ sid }).strict(),
  handoff: z
    .object({ sid, summary: z.string().trim().min(1).max(60000) })
    .strict(),
  openExternal: z.object({ url: z.string().url().max(20000) }).strict(),
  saveModel: z
    .object({ model, apiKey: z.string().max(10000).optional() })
    .strict(),
  saveHook: z.object({ hook }).strict(),
  deleteHook: z.object({ id: text }).strict(),
  skills: z.object({ cwd: text }).strict(),
  effectiveSkills: z.object({ sid }).strict(),
  delegate: z.object({ sid, task: taskInput }).strict(),
  cancelTask: z.object({ id: z.string().uuid() }).strict(),
  cancelTaskTree: z.object({ sid }).strict(),
  collectTasks: z.object({ sid }).strict(),
  artifact: z.object({ sid, id: z.string().uuid() }).strict(),
  exportArtifact: z.object({ sid, id: z.string().uuid() }).strict(),
  previewHtml: z
    .object({
      html: z.string().max(128 * 1024),
      css: z
        .string()
        .max(128 * 1024)
        .default(""),
    })
    .strict(),
  resetSkill: z.object({ id: text }).strict(),
  exportSkill: z.object({ id: text }).strict(),
  pause: z.object({ modelId: text, paused: z.boolean() }).strict(),
  unload: z.object({}),
  settings: z
    .object({
      reserveGiB: z.number().min(2).max(128),
      cloudParallel: z.number().int().min(1).max(16),
      defaultHooks: z.array(text).max(30),
      workspaceHooks: z
        .record(
          z
            .object({
              enabled: z.array(text).max(30),
              disabled: z.array(text).max(30),
            })
            .strict(),
        )
        .optional(),
      localaiRoot: text,
      theme: z.enum(["dark", "light"]),
    })
    .strict(),
};
let secretFile;
function secrets() {
  try {
    return JSON.parse(readFileSync(secretFile, "utf8"));
  } catch {
    return {};
  }
}
function getSecret(mid) {
  const entry = secrets()[mid];
  if (!entry) return undefined;
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      "OS credential encryption is unavailable. Unlock your desktop keyring.",
    );
  return safeStorage.decryptString(Buffer.from(entry, "base64"));
}
function saveSecret(mid, key) {
  if (
    !safeStorage.isEncryptionAvailable() ||
    safeStorage.getSelectedStorageBackend?.() === "basic_text"
  )
    throw new Error(
      "A secure OS keyring is required to save API keys. Configure your desktop keyring first.",
    );
  const data = secrets();
  if (!key) delete data[mid];
  else data[mid] = safeStorage.encryptString(key).toString("base64");
  writeFileSync(secretFile + ".tmp", JSON.stringify(data), { mode: 0o600 });
  renameSync(secretFile + ".tmp", secretFile);
}
function checkEndpoint(endpoint) {
  const u = new URL(endpoint);
  if (u.username || u.password || u.search || u.hash)
    throw new Error(
      "Use a plain endpoint URL without credentials, query, or fragment",
    );
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    throw new Error(
      "Remote endpoints require HTTPS. Localhost endpoints may use HTTP.",
    );
}
async function action(name, input) {
  const data = schemas[name]?.parse(input);
  if (!data) throw new Error("Unknown application action");
  switch (name) {
    case "snapshot":
      return service.snapshot();
    case "refresh":
      service.refreshModels();
      service.changed();
      return service.snapshot();
    case "processes":
      return collectProcesses();
    case "create":
      return service.create(data);
    case "updateSession":
      return service.updateSession(data.sid, data.patch);
    case "send":
      return service.send(data.sid, data.text);
    case "cancel":
      return service.cancel(data.sid);
    case "commands:list":
      return commandCatalog.get(service.store.session(data.sessionId).harness);
    case "commands:refresh":
      return commandCatalog.refresh(data.harness);
    case "commands:run":
      // Never a send and never a shell: verified Pi commands execute over
      // Pi's own RPC control interface (electron/piControl.mjs); every other
      // route keeps runNativeCommand's explicit refusal.
      return service.runCommand(data.sessionId, data.name, data.args || "");
    case "fork":
      return service.fork(data.sid);
    case "handoff":
      return service.handoff(data.sid, data.summary);
    case "openExternal": {
      const url = new URL(data.url);
      if (!["https:", "http:"].includes(url.protocol))
        throw new Error("Only web links can be opened");
      return shell.openExternal(url.href);
    }
    case "remove":
      return service.remove(data.sid);
    case "chooseFolder": {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    }
    case "saveModel": {
      const existing = service.store.data.models.find(
        (m) => m.id === data.model.id,
      );
      if (data.model.endpoint) checkEndpoint(data.model.endpoint);
      if (!existing && !data.model.endpoint)
        throw new Error("An endpoint is required");
      if (data.model.kind === "local" && data.model.slotGiB < 0.25)
        throw new Error(
          "Local slots require a positive KV/prefill memory budget",
        );
      if (data.apiKey !== undefined) saveSecret(data.model.id, data.apiKey);
      return service.upsertModel(data.model);
    }
    case "delegate":
      return service.tasks.create(data.sid, data.task);
    case "cancelTask":
      return service.tasks.cancel(data.id);
    case "cancelTaskTree":
      return service.tasks.cancelTree(data.sid);
    case "collectTasks":
      return service.tasks.collect(data.sid);
    case "artifact":
      return service.artifact(data.sid, data.id);
    case "previewHtml":
      return validateArtifact({
        version: 1,
        type: "html-css",
        title: "HTML preview",
        html: data.html,
        css: data.css,
      });
    case "exportArtifact": {
      const artifact = service.artifact(data.sid, data.id);
      const result = await dialog.showSaveDialog(window, {
        defaultPath: "artifact.html",
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!result.canceled && result.filePath)
        writeFileSync(result.filePath, artifact.document, { mode: 0o600 });
      return !result.canceled;
    }
    case "saveHook":
      return service.saveSkill(data.hook);
    case "effectiveSkills":
      return service.effectiveSkills(data.sid);
    case "resetSkill":
      return service.resetSkill(data.id);
    case "exportSkill": {
      const skill = service.store.data.hooks.find((s) => s.id === data.id);
      if (!skill) throw new Error("Skill not found");
      const result = await dialog.showSaveDialog(window, {
        defaultPath: "SKILL.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!result.canceled && result.filePath)
        writeFileSync(
          result.filePath,
          `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}\n`,
        );
      return !result.canceled;
    }
    case "deleteHook":
      service.store.data.hooks = service.store.data.hooks.filter(
        (h) => h.id !== data.id,
      );
      service.changed(true);
      return;
    case "skills":
      return service.skills(data.cwd);
    case "pause":
      service.store.model(data.modelId);
      service.scheduler.pause(data.modelId, data.paused);
      return;
    case "unload":
      return service.unload();
    case "settings":
      Object.assign(service.store.data.settings, data);
      service.changed(true);
      return;
    case "openData":
      return shell.openPath(service.directory);
    case "export": {
      const session = service.store.session(data.sid);
      const result = await dialog.showSaveDialog(window, {
        defaultPath: `${session.title.replace(/[^\w -]/g, "").slice(0, 80) || "session"}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!result.canceled && result.filePath)
        writeFileSync(
          result.filePath,
          `# ${session.title}\n\n${session.messages.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n")}\n`,
        );
      return;
    }
  }
}
if (gotLock)
  app.whenReady().then(() => {
    const directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    secretFile = join(directory, "credentials.json");
    commandCatalog = new CommandCatalog({
      file: join(directory, "command-catalog.json"),
    });
    const candidates = [
      process.env.RELAY_LOCALAI_ROOT,
      join(homedir(), "dev/LocalAi"),
    ].filter(Boolean);
    service = new AgentService(directory, {
      commandCatalog,
      secret: getSecret,
      localaiRoot:
        candidates.find((p) =>
          existsSync(join(p, "config/linux/profiles.json")),
        ) || "",
    });
    ipcMain.handle("relay:action", async (event, name, input) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Untrusted IPC sender");
      try {
        return { ok: true, value: (await action(name, input)) ?? true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    function openWindow() {
      window = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1024,
        minHeight: 700,
        backgroundColor: "#101113",
        title: "Relay",
        icon: join(root, "../build/icon.png"),
        titleBarStyle: "hiddenInset",
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-frame-navigate", (event) => {
        if (event.url !== "about:srcdoc") event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      window.webContents.session.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      if (process.env.RELAY_DEV_URL) {
        const url = new URL(process.env.RELAY_DEV_URL);
        if (url.origin !== "http://127.0.0.1:5173")
          throw new Error("Invalid development URL");
        window.loadURL(url.href);
      } else window.loadFile(join(root, "../dist/index.html"));
      window.on("closed", () => {
        window = null;
      });
    }
    service.on("changed", (data) => {
      if (window && !window.isDestroyed())
        window.webContents.send("relay:changed", data);
    });
    service.on("completed", ({ title }) => {
      if (window && !window.isFocused() && Notification.isSupported())
        new Notification({
          title: "Relay · Session finished",
          body: title,
        }).show();
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Relay",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    openWindow();
    app.on("second-instance", () => {
      if (window) {
        if (window.isMinimized()) window.restore();
        window.focus();
      }
    });
    app.on("activate", () => {
      if (!window) openWindow();
    });
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => service?.close());
