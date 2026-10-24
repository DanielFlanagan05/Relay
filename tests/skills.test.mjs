import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../electron/store.mjs";
import {
  bundledSkills,
  resolveSkills,
  parseSkill,
  saveSkill,
} from "../electron/skills.mjs";
const directory = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test("v1 migration preserves custom instructions, IDs, defaults and native context with permanent backup", (t) => {
  const dir = directory(t),
    data = {
      version: 1,
      models: [],
      hooks: [
        {
          id: "careful",
          name: "My custom rule",
          content: "Keep me",
          description: "",
        },
      ],
      settings: { defaultHooks: ["careful"] },
      sessions: [
        {
          id: "s",
          nativeId: "n",
          remoteId: "remote",
          hookIds: ["careful"],
          status: "idle",
          messages: [
            {
              role: "user",
              content: "hello",
              hookSnapshot: [{ content: "original" }],
            },
          ],
        },
      ],
    };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(data));
  const store = new Store(dir);
  assert.equal(store.data.version, 2);
  assert.equal(
    store.data.hooks.find((h) => h.id === "careful").content,
    "Keep me",
  );
  assert.ok(store.data.hooks.some((h) => h.id === "review"));
  assert.equal(store.session("s").remoteId, "remote");
  assert.equal(
    store.session("s").messages[0].hookSnapshot[0].content,
    "original",
  );
  assert.equal(
    JSON.parse(readFileSync(join(dir, "workspace.json.v1.bak"))).version,
    1,
  );
  assert.deepEqual(new Store(dir).data.settings.defaultHooks, ["careful"]);
});
test("workspace defaults are captured and turn overrides resolve deterministically with capability gating", (t) => {
  const store = new Store(directory(t));
  store.data.settings.workspaceHooks = {
    "/project": { enabled: ["concise"], disabled: ["careful"] },
  };
  const session = store.create({
    cwd: "/project",
    modelId: "test",
    harness: "direct",
  });
  assert.deepEqual(session.hookIds, ["concise"]);
  store.data.settings.defaultHooks = ["plan"];
  assert.deepEqual(session.hookIds, ["concise"]);
  session.nextTurnHookIds = ["review", "review", "subagents"];
  session.disabledNextTurnHookIds = ["concise"];
  session.outputFormat = "html";
  const result = resolveSkills(store.data, session);
  assert.deepEqual(
    result.skills.map((s) => s.id),
    ["review", "html-output"],
  );
  assert.match(result.warnings.join(" "), /unavailable/);
  assert.ok(result.skills.every((s) => s.revision && s.contentHash));
});
test("editing bundled skills creates a versioned override and leaves the packaged original untouched", () => {
  const data = { hooks: bundledSkills() },
    old = data.hooks.find((s) => s.id === "concise");
  const oldRevision = old.revision;
  const changed = saveSkill(data, { ...old, content: "My terse instruction" });
  assert.equal(changed.revision, oldRevision + 1);
  assert.equal(changed.origin, "user");
  assert.equal(changed.bundledId, "concise");
  assert.notEqual(
    bundledSkills().find((s) => s.id === "concise").content,
    changed.content,
  );
});
test("import parses metadata and warns about missing supporting resources", () => {
  const s = parseSkill(
    '---\nname: "Review source"\ndescription: "Checks things"\n---\nRead [guide](references/guide.md).',
    "/workspace/a/SKILL.md",
    "a",
  );
  assert.equal(s.name, "Review source");
  assert.equal(s.description, "Checks things");
  assert.equal(s.warnings.length, 1);
  assert.equal(s.content, "Read [guide](references/guide.md).");
});

test("v2 refreshes bundled revisions and adds native skills without overwriting personal rules or history", (t) => {
  const dir = directory(t),
    store = new Store(dir);
  const concise = store.data.hooks.find((s) => s.id === "concise");
  concise.revision = 1;
  concise.content = "Old bundled text";
  saveSkill(store.data, {
    ...store.data.hooks.find((s) => s.id === "review"),
    content: "Personal review",
  });
  store.data.hooks = store.data.hooks.filter(
    (s) => !["local-work", "teamwork"].includes(s.id),
  );
  const session = store.create({ modelId: "fixture", harness: "pi" });
  session.messages.push({
    role: "user",
    content: "hi",
    hookSnapshot: [{ content: "Old bundled text" }],
  });
  store.save();
  const fresh = new Store(dir);
  assert.equal(fresh.data.hooks.find((s) => s.id === "concise").revision, 2);
  assert.notEqual(
    fresh.data.hooks.find((s) => s.id === "concise").content,
    "Old bundled text",
  );
  assert.equal(
    fresh.data.hooks.find((s) => s.id === "review").content,
    "Personal review",
  );
  assert.equal(
    fresh.session(session.id).messages[0].hookSnapshot[0].content,
    "Old bundled text",
  );
  const pi = {
    ...fresh.session(session.id),
    permission: "workspace-write",
    hookIds: ["local-work", "teamwork"],
  };
  assert.equal(resolveSkills(fresh.data, pi).skills.length, 2);
  assert.equal(
    resolveSkills(fresh.data, { ...pi, harness: "direct" }).skills.length,
    0,
  );
});
