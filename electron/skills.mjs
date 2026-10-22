import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../skills/", import.meta.url));
export const hash = (text) => createHash("sha256").update(text).digest("hex");
export function normalizeSkill(value, previous) {
  const content = String(value.content || "");
  const changed = previous && previous.content !== content;
  return {
    ...value,
    revision: previous
      ? previous.revision + Number(!!changed)
      : value.revision || 1,
    category: value.category || "workflow",
    origin: changed
      ? "user"
      : value.origin || (value.source ? "imported" : "user"),
    contentHash: hash(content),
    requires: value.requires || [],
    warnings: value.warnings || [],
    ...(previous?.origin === "bundled" && changed
      ? { bundledId: previous.id }
      : {}),
  };
}
export function parseSkill(content, path, fallback) {
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = {};
  if (header)
    for (const line of header[1].split(/\r?\n/)) {
      const match = line.match(/^(name|description):\s*["']?(.*?)["']?\s*$/);
      if (match) metadata[match[1]] = match[2];
    }
  const body = header ? content.slice(header[0].length).trim() : content;
  return normalizeSkill({
    id: `skill:${path}`,
    name: metadata.name || fallback,
    description: metadata.description || "Imported instructions",
    content: body,
    source: path,
    origin: "imported",
    warnings: /(?:scripts|references|assets)\/|\]\((?!https?:|#)[^)]+\)/i.test(
      body,
    )
      ? [
          "This skill references supporting files. Only its instructions are imported; scripts and assets are not available.",
        ]
      : [],
  });
}
export function bundledSkills() {
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
  return manifest.map((entry) =>
    normalizeSkill({
      ...entry,
      origin: "bundled",
      content: readFileSync(`${root}/${entry.id}/SKILL.md`, "utf8")
        .replace(/^---\n[\s\S]*?\n---\n/, "")
        .trim(),
    }),
  );
}
export function capabilities(session) {
  return {
    readFiles: session.harness !== "direct",
    writeFiles:
      session.harness !== "direct" && session.permission === "workspace-write",
    readOnly: session.harness !== "hermes",
    // Explicit per-session opt-in, verified Direct chat route, never inside a child.
    delegation: !!(
      session.delegation &&
      session.harness === "direct" &&
      !session.taskId
    ),
    html: true,
  };
}
export const DELEGATION_WARNING =
  "Tool-driven delegation is experimental: it is enabled for this Direct chat session and has not been qualified with a live model.";
export function resolveSkills(data, session) {
  const ids = new Set([
    ...(session.hookIds || []),
    ...(session.nextTurnHookIds || []),
  ]);
  for (const id of session.disabledNextTurnHookIds || []) ids.delete(id);
  if (session.outputFormat === "html") ids.add("html-output");
  if (session.outputFormat === "markdown") ids.delete("html-output");
  const caps = capabilities(session),
    warnings = [],
    skills = [];
  if (caps.delegation) warnings.push(DELEGATION_WARNING);
  else if (session.delegation)
    warnings.push(
      "Delegation was requested but is unavailable on this route. Direct chat only; native harness delegation is not supported.",
    );
  for (const id of ids) {
    const skill = data.hooks.find((s) => s.id === id);
    if (!skill) {
      warnings.push(`Selected skill ${id} is no longer available.`);
      continue;
    }
    const missing = (skill.requires || []).filter((c) => !caps[c]);
    if (missing.length) {
      warnings.push(
        `${skill.name}: unavailable (${missing.join(", ")}). It will not be sent.`,
      );
      continue;
    }
    skills.push({
      ...normalizeSkill(skill),
      scope: (session.nextTurnHookIds || []).includes(id)
        ? "next-turn"
        : id === "html-output" && session.outputFormat === "html"
          ? "output"
          : "session",
    });
    warnings.push(...(skill.warnings || []));
  }
  if (ids.has("review") && session.permission === "workspace-write")
    warnings.push(
      "Code review is selected with write access. Use read-only permissions for review-only work.",
    );
  return {
    skills,
    warnings: [...new Set(warnings)],
    estimatedTokens: Math.ceil(
      skills.reduce((n, s) => n + s.content.length, 0) / 3,
    ),
    capabilities: caps,
  };
}
export function initialSkills(settings, cwd, explicit) {
  if (explicit) return [...new Set(explicit)];
  const workspace = settings.workspaceHooks?.[cwd] || {};
  return [
    ...new Set([
      ...(settings.defaultHooks || []),
      ...(workspace.enabled || []),
    ]),
  ].filter((id) => !(workspace.disabled || []).includes(id));
}
export function saveSkill(data, input) {
  const old = data.hooks.find((s) => s.id === input.id);
  const duplicate = data.hooks.find(
    (s) =>
      s.id !== input.id &&
      input.source &&
      (s.source === input.source || s.contentHash === hash(input.content)),
  );
  if (duplicate)
    throw new Error(`This skill is already imported as ${duplicate.name}`);
  const value = normalizeSkill(
    {
      ...old,
      ...input,
      origin: old?.origin || (input.source ? "imported" : "user"),
    },
    old,
  );
  if (old) Object.assign(old, value);
  else data.hooks.push(value);
  return value;
}
