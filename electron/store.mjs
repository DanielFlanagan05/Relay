import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { bundledSkills, normalizeSkill, initialSkills } from "./skills.mjs";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const defaults = () => ({
  version: 2,
  sessions: [],
  models: [],
  hooks: bundledSkills(),
  tasks: [],
  settings: {
    reserveGiB: 8,
    cloudParallel: 4,
    defaultHooks: ["careful"],
    workspaceHooks: {},
    localaiRoot: "",
    theme: "dark",
  },
});

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.file = join(directory, "workspace.json");
    this.data = defaults();
    if (existsSync(this.file)) {
      try {
        if (
          JSON.parse(readFileSync(this.file, "utf8")).version === 1 &&
          !existsSync(this.file + ".v1.bak")
        )
          copyFileSync(this.file, this.file + ".v1.bak");
      } catch {}
    }
    if (existsSync(this.file)) {
      try {
        this.data = this.load(this.file);
      } catch (error) {
        // Keep corrupt evidence and use the last atomic backup, never silently erase sessions.
        renameSync(
          this.file,
          join(directory, `workspace.corrupt-${Date.now()}.json`),
        );
        if (!existsSync(this.file + ".bak")) throw error;
        this.data = this.load(this.file + ".bak");
      }
    }
    for (const s of this.data.sessions) {
      if (["running", "queued", "loading"].includes(s.status)) {
        s.status = "interrupted";
        s.queueReason =
          "The app closed during this turn. Send a new message to continue.";
        for (const m of s.messages)
          if (m.status === "streaming") m.status = "interrupted";
      }
    }
    for (const task of this.data.tasks) {
      if (
        !["complete", "failed", "canceled", "interrupted"].includes(task.status)
      ) {
        task.status = "interrupted";
        task.error = "The app closed during this task. It was not replayed.";
      }
    }
    this.save();
  }
  load(path) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      ![1, 2].includes(value.version) ||
      !Array.isArray(value.sessions) ||
      !Array.isArray(value.models) ||
      !Array.isArray(value.hooks)
    )
      throw new Error("Unrecognized workspace data. Restore a valid backup.");
    if (value.version === 1) {
      const builtins = bundledSkills();
      value.hooks = value.hooks.map((h) =>
        normalizeSkill({ ...h, origin: "user" }),
      );
      for (const skill of builtins)
        if (!value.hooks.some((h) => h.id === skill.id))
          value.hooks.push(skill);
    }
    value.hooks = value.hooks.map((h) => normalizeSkill(h));
    value.sessions = value.sessions.map((s) => ({
      nextTurnHookIds: [],
      disabledNextTurnHookIds: [],
      outputFormat: "auto",
      ...s,
    }));
    return {
      ...defaults(),
      ...value,
      version: 2,
      settings: { ...defaults().settings, ...value.settings },
    };
  }
  save() {
    if (existsSync(this.file)) copyFileSync(this.file, this.file + ".bak");
    writeFileSync(this.file + ".tmp", JSON.stringify(this.data), {
      mode: 0o600,
    });
    renameSync(this.file + ".tmp", this.file);
  }
  session(sid) {
    const session = this.data.sessions.find((s) => s.id === sid);
    if (!session) throw new Error("Session not found");
    return session;
  }
  model(mid) {
    const model = this.data.models.find((m) => m.id === mid);
    if (!model) throw new Error("Select an available model in Connections");
    return model;
  }
  create({
    title = "New session",
    modelId,
    harness = "direct",
    cwd = "",
    hookIds,
    parentId,
    permission = "read-only",
    preset = "chat",
  }) {
    const session = {
      id: id(),
      nativeId: id(),
      title,
      modelId,
      harness,
      cwd,
      hookIds: initialSkills(this.data.settings, cwd, hookIds),
      nextTurnHookIds: [],
      disabledNextTurnHookIds: [],
      outputFormat: "auto",
      preset,
      parentId,
      createdAt: now(),
      updatedAt: now(),
      status: "idle",
      messages: [],
      pinned: false,
      archived: false,
      permission,
      draft: "",
    };
    this.data.sessions.unshift(session);
    this.save();
    return session;
  }
}
