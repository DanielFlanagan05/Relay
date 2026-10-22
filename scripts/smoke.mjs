// Launches real Electron, but all generation goes to an isolated localhost test server.
// Never starts LocalAi, uses provider credentials, or touches the user's Relay data.
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../electron/store.mjs";

const directory = mkdtempSync(join(tmpdir(), "relay-ui-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const requests = [],
  waiting = [];
let active = 0,
  peak = 0,
  release = false,
  desktop;
const answer =
  "## Shared model, independent sessions\n\nThe shared runtime is ready. Each conversation keeps its own context while using the same model weights.\n\n- **One resident model** serves multiple sessions.\n- **Separate context** prevents conversation history from mixing.\n- **A fair queue** holds work when all slots are busy.\n\n```ts\nconst runtime = pool.get(modelId);\nawait runtime.run({ sessionId, messages });\n```\n\nThroughput is shared between active sessions. You can adjust capacity in **Compute**.";
const artifactSource = {
  version: 1,
  type: "html-css",
  title: "Fixture report",
  html: '<main><h1>Formatted report</h1><p id="report">Static content</p><script>window.injected=true</script><img src="http://127.0.0.1:1/forbidden"><a href="https://example.invalid">Inert link</a></main>',
  css: 'main { color: rgb(10, 20, 30); padding: 20px; } @import "https://example.invalid";',
};
const artifactAnswer =
  answer +
  "\n\n```relay-artifact\n" +
  JSON.stringify(artifactSource) +
  "\n```\n";
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  active++;
  peak = Math.max(peak, active);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: artifactAnswer.slice(0, 85) } }] })}\n\n`,
  );
  const finish = () => {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: artifactAnswer.slice(85) } }], usage: { prompt_tokens: 132, completion_tokens: 112 } })}\n\n`,
    );
    active--;
    res.end("data: [DONE]\n\n");
  };
  if (release) setTimeout(finish, 80);
  else waiting.push(finish);
});
const wait = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("UI test condition timed out");
};
const launch = async () => {
  desktop = await electron.launch({
    ...(process.env.RELAY_TEST_EXECUTABLE
      ? { executablePath: process.env.RELAY_TEST_EXECUTABLE }
      : {}),
    args: process.env.RELAY_TEST_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      RELAY_DATA_DIR: directory,
      RELAY_LOCALAI_ROOT: "",
      RELAY_FIXTURE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`,
    },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  await page.waitForSelector(".workspace-heading");
  return page;
};
const api = (page, name, input = {}) =>
  page.evaluate(({ name, input }) => window.relay.call(name, input), {
    name,
    input,
  });
const errors = [];
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new Store(directory);
  store.data.models = [
    {
      id: "test:shared",
      name: "Shared model · test endpoint",
      kind: "local",
      model: "fixture",
      engine: "Test endpoint",
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      parallel: 2,
      context: 32768,
      slotGiB: 0.25,
    },
  ];
  store.data.settings.reserveGiB = 2;
  store.save();
  let page = await launch();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.screenshot({ path: join(artifacts, "welcome.png") });
  const create = async (prompt) => {
    await page.locator(".new-session").click();
    await page
      .getByRole("button", { name: "Create session", exact: true })
      .click();
    await page
      .locator(".session-header h2")
      .filter({ hasText: /^New session$/ })
      .waitFor();
    await page
      .getByRole("textbox", { name: "Message your agent" })
      .fill(prompt);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  };
  await create("ALPHA: review shared-model session scheduling");
  await wait(() => requests.length === 1);
  await create("BETA: build a separate conversation");
  await wait(() => requests.length === 2);
  await create("GAMMA: wait for a shared inference slot");
  await wait(async () =>
    (await api(page, "snapshot")).sessions.some((s) => s.status === "queued"),
  );
  assert.equal(peak, 2);
  assert.equal(requests.length, 2);
  assert.ok(!JSON.stringify(requests[0]).includes("BETA"));
  assert.ok(!JSON.stringify(requests[1]).includes("ALPHA"));
  await page.getByRole("button", { name: "Compute", exact: true }).click();
  await page.getByText("One model. More momentum.").waitFor();
  await wait(
    async () =>
      (await page
        .locator(".stat-card")
        .nth(2)
        .locator("strong")
        .textContent()) === "1",
  );
  await page.screenshot({ path: join(artifacts, "compute.png") });
  release = true;
  waiting.splice(0).forEach((f) => f());
  await wait(async () =>
    (await api(page, "snapshot")).sessions.every((s) => s.status === "idle"),
  );
  assert.equal(requests.length, 3);
  assert.ok(peak <= 2);
  const initial = await api(page, "snapshot");
  const alpha = initial.sessions.find((s) => s.title.startsWith("ALPHA"));
  await page.locator(".session-row").filter({ hasText: "ALPHA" }).click();
  await page.locator(".message.assistant .markdown h2").waitFor();
  await page.screenshot({ path: join(artifacts, "session.png") });
  // Formatted output is sanitized, isolated, and backed by immutable source revisions.
  await page
    .getByRole("button", { name: "Open preview", exact: true })
    .first()
    .click();
  const preview = page.frameLocator(".artifact-viewport iframe");
  await preview.getByRole("heading", { name: "Formatted report" }).waitFor();
  assert.equal(
    await preview
      .locator("#report")
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(10, 20, 30)",
  );
  assert.equal(await preview.locator("script, img, iframe, form").count(), 0);
  assert.equal(await preview.locator("a").getAttribute("href"), null);
  const frame = await page.locator(".artifact-viewport iframe").elementHandle();
  const frameContext = await frame.contentFrame();
  assert.deepEqual(
    await frameContext.evaluate(() => ({
      bridge: typeof window.relay,
      require: typeof window.require,
      injected: !!window.injected,
      parentBlocked: (() => {
        try {
          return !parent.document;
        } catch {
          return true;
        }
      })(),
    })),
    {
      bridge: "undefined",
      require: "undefined",
      injected: false,
      parentBlocked: true,
    },
  );
  assert.equal(
    await page.locator(".artifact-viewport iframe").getAttribute("sandbox"),
    "",
  );
  await page.getByRole("tab", { name: "HTML", exact: true }).click();
  assert.match(
    await page.locator(".artifact-content pre").textContent(),
    /window.injected/,
  );
  await page.screenshot({ path: join(artifacts, "formatted-output.png") });
  await page
    .getByRole("button", { name: "Toggle session details", exact: true })
    .click();
  // Toggle standing instructions off and verify both context restoration and next-turn behavior.
  await page.locator(".hook-selector").click();
  await page
    .locator(".hooks-popover button")
    .filter({ hasText: "Careful engineer" })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message your agent" })
    .fill("Continue ALPHA");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await wait(() => requests.length === 4);
  await wait(async () =>
    (await api(page, "snapshot")).sessions.every((s) => s.status === "idle"),
  );
  assert.equal(requests[3].messages.length, 3);
  assert.ok(requests[3].messages[0].content.includes("ALPHA"));
  assert.match(requests[3].messages.at(-1).content, /No extra instructions/);
  assert.ok(!JSON.stringify(requests[3]).includes("BETA"));
  await page
    .getByRole("button", { name: "Fork conversation", exact: true })
    .click();
  await wait(async () => (await api(page, "snapshot")).sessions.length === 4);
  await page
    .getByRole("button", { name: "Instructions & skills", exact: true })
    .click();
  await page
    .getByRole("button", { name: "New instruction", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Instruction name", exact: true })
    .fill("UI test instruction");
  await page
    .getByRole("textbox", { name: "Instruction content", exact: true })
    .fill("Keep responses specific to this conversation.");
  await page
    .getByRole("button", { name: "Save instruction", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("UI test instruction", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByText("A well-connected workspace.").waitFor();
  await page.screenshot({ path: join(artifacts, "connections.png") });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await wait(() =>
    page.evaluate(() => document.documentElement.dataset.theme === "light"),
  );
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  // Native UI at minimum supported width must not create a horizontal document scrollbar.
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1040, 760),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await desktop.close();
  desktop = null;
  page = await launch();
  const restored = await api(page, "snapshot");
  assert.equal(restored.sessions.length, 4);
  assert.equal(
    restored.sessions.find((s) => s.id === alpha.id).messages.length,
    4,
  );
  assert.ok(restored.hooks.some((h) => h.name === "UI test instruction"));
  page.on("pageerror", (error) => errors.push(error.message));
  assert.ok(
    restored.sessions
      .find((s) => s.id === alpha.id)
      .messages.some((m) => m.artifacts?.length),
  );
  await page
    .locator(".session-row")
    .filter({ hasText: "ALPHA" })
    .filter({ hasNotText: "fork" })
    .click();
  await page
    .getByRole("button", { name: "Open agents panel", exact: true })
    .click();
  await page.locator(".delegate-form summary").click();
  await page
    .getByRole("textbox", { name: "Child task objective", exact: true })
    .fill("Inspect fixture documentation");
  await page
    .getByRole("textbox", { name: "Child task context", exact: true })
    .fill("The fixture has no file access. Return a summary.");
  await page
    .getByRole("button", { name: "Start read-only child", exact: true })
    .click();
  await wait(async () =>
    (await api(page, "snapshot")).tasks.some(
      (t) => t.parentSessionId === alpha.id && t.status === "complete",
    ),
  );
  await page
    .locator(".task-card")
    .getByText("Inspect fixture documentation", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Add results to draft", exact: true })
    .click();
  await wait(async () =>
    (
      await page
        .getByRole("textbox", { name: "Message your agent" })
        .inputValue()
    ).includes("delegated results"),
  );
  await page.screenshot({ path: join(artifacts, "delegation.png") });
  await page
    .getByRole("button", { name: "Toggle session details", exact: true })
    .click();
  await page.locator(".hook-selector").click();
  await page
    .getByRole("combobox", { name: "Instruction scope" })
    .selectOption("turn");
  await page
    .locator(".skill-choices button")
    .filter({ hasText: "Code review" })
    .click();
  await wait(async () =>
    (await api(page, "effectiveSkills", { sid: alpha.id })).skills.some(
      (s) => s.id === "review",
    ),
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message your agent" })
    .fill("Verify one-turn skill");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await wait(async () => {
    const session = (await api(page, "snapshot")).sessions.find(
      (s) => s.id === alpha.id,
    );
    return (
      session.status === "idle" &&
      session.messages.at(-2)?.content === "Verify one-turn skill"
    );
  });
  const afterTurn = (await api(page, "snapshot")).sessions.find(
    (s) => s.id === alpha.id,
  );
  assert.deepEqual(afterTurn.nextTurnHookIds, []);
  assert.ok(
    afterTurn.messages.at(-2).hookSnapshot.some((h) => h.id === "review"),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Electron UI passed: shared queue, isolated context, skill scopes/snapshots, sanitized artifact sandbox/source/recovery, guided delegation and result collection, navigation, responsive layout, and persistence.",
  );
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  if (desktop) {
    const page = await desktop.firstWindow();
    await page.screenshot({ path: join(artifacts, "failure.png") });
    console.error("UI state at failure:", await api(page, "snapshot"));
  }
  throw error;
} finally {
  release = true;
  waiting.splice(0).forEach((f) => f());
  await desktop?.close();
  server.closeAllConnections();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
