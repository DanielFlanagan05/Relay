import { parseSkill } from "./skills.mjs";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, totalmem, freemem } from "node:os";
import { join, delimiter } from "node:path";
import { accessSync, constants } from "node:fs";

export const GiB = 1024 ** 3;
export const json = (path, fallback = {}) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
export const localPaths = () => ({
  data: join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "localai",
  ),
  state: join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "localai",
  ),
});
export function executable(name) {
  const candidates = name.includes("/")
    ? [name]
    : (process.env.PATH || "").split(delimiter).map((p) => join(p, name));
  const { data } = localPaths();
  if (["pi", "claude"].includes(name))
    candidates.unshift(join(data, "apps/node/bin", name));
  if (name === "opencode")
    candidates.unshift(join(data, "apps/opencode/opencode"));
  if (name === "hermes")
    candidates.unshift(join(data, "apps/hermes/.venv/bin/hermes"));
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}
export function memory() {
  try {
    const raw = readFileSync("/proc/meminfo", "utf8");
    const bytes = (name) =>
      Number(raw.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] || 0) *
      1024;
    return {
      totalGiB: bytes("MemTotal") / GiB,
      availableGiB: bytes("MemAvailable") / GiB,
      swapGiB: (bytes("SwapTotal") - bytes("SwapFree")) / GiB,
      source: "Linux MemAvailable · unified memory counted once",
    };
  } catch {
    return {
      totalGiB: totalmem() / GiB,
      availableGiB: freemem() / GiB,
      swapGiB: 0,
      source: "OS free memory · conservative estimate",
    };
  }
}
export function processIdentity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return ["Z", "X"].includes(fields[0]) ? null : fields[19];
  } catch {
    return null;
  }
}
export function liveRuntime() {
  const state = json(join(localPaths().state, "server.json"), null);
  if (!state) return null;
  try {
    const raw = readFileSync(`/proc/${state.pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(fields[0]) || fields[19] !== String(state.identity))
      return null;
    return state;
  } catch {
    return null;
  }
}
export function importLocalModels(root) {
  const profiles = json(join(root, "config/linux/profiles.json"));
  const verified = json(join(localPaths().state, "verified-models.json"));
  return Object.entries(profiles)
    .filter(([, p]) => p.model && p.engine !== "comfyui")
    .map(([profile, p]) => ({
      id: `localai:${profile}`,
      name: p.display_name || profile,
      kind: "local",
      managed: true,
      profile,
      engine: p.engine,
      model: profile,
      weightKey: `${p.engine}:${p.model}`,
      endpoint: `http://127.0.0.1:${p.port || 8080}/v1`,
      context: p.context,
      parallel: p.sessions || 1,
      baselineParallel: p.sessions || 1,
      slotGiB: 4,
      estimatedGiB: p.estimated_gib || 0,
      installed: !!verified[p.model],
      experimental: /experimental|test|candidate/i.test(
        profile + " " + (p.display_name || ""),
      ),
      description:
        p.purpose ||
        `${p.engine} · shared model weights, separate conversation context`,
    }));
}
export function harnesses() {
  return [
    {
      id: "direct",
      name: "Direct chat",
      detail: "OpenAI-compatible local endpoint · no tools",
      available: true,
    },
    {
      id: "pi",
      name: "Pi",
      detail: "Local models · tools · native session persistence",
      available: !!executable("pi"),
    },
    {
      id: "opencode",
      name: "OpenCode",
      detail: "Local models · tools · native session persistence",
      available: !!executable("opencode"),
    },
    {
      id: "hermes",
      name: "Hermes",
      detail: "Local models · native sessions · workspace write only",
      available: !!executable("hermes"),
    },
    {
      id: "codex",
      name: "Codex",
      detail: "Cloud · existing CLI login · JSON events",
      available: !!executable("codex"),
    },
    {
      id: "claude",
      name: "Claude Code",
      detail: "Cloud · existing CLI login · streaming events",
      available: !!executable("claude"),
    },
  ];
}
export function discoverSkills(cwd) {
  const roots = [
    join(homedir(), ".agents/skills"),
    join(homedir(), ".claude/skills"),
    join(homedir(), ".pi/agent/skills"),
    join(homedir(), ".codex/skills"),
  ];
  if (cwd) roots.push(join(cwd, ".agents/skills"), join(cwd, ".claude/skills"));
  const skills = [];
  for (const root of roots) {
    try {
      for (const dir of readdirSync(root, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && !d.name.startsWith("."),
      )) {
        const path = join(root, dir.name, "SKILL.md");
        if (!existsSync(path)) continue;
        const content = readFileSync(path, "utf8");
        if (content.length > 60000) continue;
        const skill = parseSkill(content, path, dir.name);
        if (
          !skills.some(
            (s) => s.contentHash === skill.contentHash || s.source === path,
          )
        )
          skills.push(skill);
      }
    } catch {}
  }
  return skills;
}
