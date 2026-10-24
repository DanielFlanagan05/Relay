// Per-turn usage/rate accounting: measured values only from provider-reported
// numbers, cumulative turn totals, cache fields only where a harness reports
// them, honest estimates otherwise, and no fabricated rate for tool-only turns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeUsage,
  addUsage,
  finalizeRate,
  estimateOutputTokens,
} from "../electron/usage.mjs";
import { normalize } from "../electron/protocol.mjs";
import { runDirect } from "../electron/adapters.mjs";
import { AgentService } from "../electron/service.mjs";
import { bundledSkills } from "../electron/skills.mjs";

const until = async (fn) => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out");
};

test("normalizeUsage keeps only real numbers and known cache fields", () => {
  assert.deepEqual(normalizeUsage({ input: 10, output: "7" }), {
    input: 10,
  });
  assert.deepEqual(
    normalizeUsage({ input: 10, output: 5, cacheRead: 4, cacheWrite: "x" }),
    { input: 10, output: 5, cacheRead: 4 },
  );
  assert.deepEqual(normalizeUsage({ input: -2, output: 5 }), {
    output: 5,
  });
  assert.equal(normalizeUsage(undefined), null);
  assert.equal(normalizeUsage({ cacheRead: 9 }), null);
});

test("turn totals accumulate across provider requests without losing cache", () => {
  let total = addUsage(null, { input: 100, output: 5, cacheRead: 40 });
  total = addUsage(total, { input: 140, output: 8 });
  total = addUsage(total, { input: "bad" }); // ignored entirely
  assert.deepEqual(total, { input: 240, output: 13, cacheRead: 40 });
});

test("final rate prefers measured tokens, labels estimates, none for tool-only", () => {
  assert.deepEqual(
    finalizeRate({ turnOutput: 90, generatedText: "hi", elapsedMs: 900 }),
    {
      rate: 100,
      estimated: false,
    },
  );
  const est = finalizeRate({
    turnOutput: undefined,
    generatedText: "x".repeat(400),
    elapsedMs: 1000,
  });
  assert.equal(est.estimated, true);
  assert.equal(est.rate, estimateOutputTokens("x".repeat(400)));
  // No text and no measured output: no rate, never a fake 0 tok/s display.
  assert.deepEqual(
    finalizeRate({ turnOutput: undefined, generatedText: "", elapsedMs: 5000 }),
    {},
  );
  assert.deepEqual(
    finalizeRate({ turnOutput: 50, generatedText: "x", elapsedMs: 100 }),
    {},
  );
});

test("harness usage normalization keeps cache/reasoning only when reported", () => {
  const pi = normalize("pi", {
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input: 900, output: 20, cacheRead: 700, cacheWrite: 120 },
    },
  })[0];
  assert.deepEqual(pi.value, {
    input: 1720,
    contextInput: 1720,
    scope: "request",
    reasoning: undefined,
    output: 20,
    cacheRead: 700,
    cacheWrite: 120,
  });
  const codex = normalize("codex", {
    type: "turn.completed",
    usage: {
      input_tokens: 50,
      output_tokens: 6,
      cached_input_tokens: 32,
      reasoning_output_tokens: 2,
    },
  })[0].value;
  assert.deepEqual(codex, {
    input: 50,
    scope: "turn",
    output: 6,
    cacheRead: 32,
    reasoning: 2,
  });
  const claude = normalize("claude", {
    type: "result",
    usage: {
      input_tokens: 70,
      output_tokens: 9,
      cache_read_input_tokens: 55,
      cache_creation_input_tokens: 10,
    },
  }).find((e) => e.type === "usage").value;
  assert.deepEqual(claude, {
    input: 135,
    scope: "turn",
    output: 9,
    cacheRead: 55,
    cacheWrite: 10,
  });
  const opencode = normalize("opencode", {
    type: "step_finish",
    part: { tokens: { input: 12, output: 3, cache: { read: 8, write: 1 } } },
  })[0].value;
  assert.deepEqual(opencode, {
    input: 12,
    output: 3,
    cacheRead: 8,
    cacheWrite: 1,
  });
  // Absent telemetry must stay absent through to the service, not become zero.
  const bare = normalize("opencode", {
    type: "step_finish",
    part: { tokens: { input: 4, output: 1 } },
  })[0].value;
  assert.equal(bare.cacheRead, undefined);
  assert.deepEqual(normalizeUsage(bare), { input: 4, output: 1 });
  assert.equal(
    normalizeUsage({ input: 4, output: 1, cacheRead: undefined }).cacheRead,
    undefined,
  );
  assert.equal(
    normalize("codex", { type: "turn.completed", usage: {} })[0].value.input,
    undefined,
  );
  assert.equal(
    normalizeUsage(
      normalize("codex", { type: "turn.completed", usage: {} })[0].value,
    ),
    null,
  );
});

test("direct SSE reports cached and reasoning tokens only when the endpoint sends them", async (t) => {
  const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      sse({
        choices: [{ delta: { content: "answer" } }],
        usage: { prompt_tokens: 120, completion_tokens: 2 },
      }),
    );
    res.write(
      sse({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 96 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const events = [];
  await runDirect({
    session: { messages: [] },
    model: {
      context: 4096,
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    },
    prompt: "hi",
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  });
  assert.equal(events.filter((e) => e.type === "usage").length, 1);
  const usage = events.find((e) => e.type === "usage");
  assert.deepEqual(usage.value, {
    input: 120,
    contextInput: 120,
    scope: "request",
    output: 7,
    cacheRead: 96,
    reasoning: 3,
  });
});

const model = {
  id: "fixture",
  name: "Fixture",
  kind: "local",
  model: "fake",
  endpoint: "http://127.0.0.1:1/v1",
  parallel: 1,
  slotGiB: 0.25,
  context: 32768,
};

function serviceFixture(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  const service = new AgentService(dir, {
    runner,
    memorySource: () => ({ availableGiB: 100, totalGiB: 128 }),
    runtimeSource: () => null,
  });
  service.store.data.models = [structuredClone(model)];
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}

test("a turn sums usage across requests; context stays last-request; rate measured", async (t) => {
  const service = serviceFixture(t, async ({ emit }) => {
    emit({
      type: "usage",
      value: {
        input: 1000,
        output: 6,
        cacheRead: 800,
        scope: "request",
        contextInput: 1000,
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    emit({ type: "delta", value: "done now" });
    emit({
      type: "usage",
      value: { input: 1100, output: 4, scope: "request", contextInput: 1100 },
    });
    return { text: "done now" };
  });
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  service.send(sid, "go");
  await until(() => service.store.session(sid).status === "idle");
  const answer = service.store.session(sid).messages.at(-1);
  // Last request = context occupancy, with no stale cache key carried over.
  assert.deepEqual(answer.usage, {
    input: 1100,
    output: 4,
    scope: "request",
    contextInput: 1100,
  });
  // Turn totals are cumulative across both provider requests.
  assert.deepEqual(answer.turnUsage, {
    input: 2100,
    output: 10,
    cacheRead: 800,
  });
  assert.equal(answer.requests, 2);
  assert.equal(answer.estimatedRate, false);
  assert.ok(answer.tokensPerSecond > 0);
  // Rate was computed from measured turn output over active time.
  assert.ok(
    Math.abs(
      answer.tokensPerSecond -
        answer.turnUsage.output / (answer.elapsedMs / 1000),
    ) < 0.5,
    "final rate must equal measured output over active seconds",
  );
});

test("no provider usage keeps the rate explicitly estimated", async (t) => {
  const service = serviceFixture(t, async ({ emit }) => {
    emit({ type: "delta", value: "x".repeat(400) });
    await new Promise((r) => setTimeout(r, 300));
    return { text: "x".repeat(400) };
  });
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  service.send(sid, "go");
  await until(() => service.store.session(sid).status === "idle");
  const answer = service.store.session(sid).messages.at(-1);
  assert.equal(answer.usage, undefined);
  assert.equal(answer.estimatedRate, true);
  assert.ok(answer.tokensPerSecond > 0);
});

test("tool-only turns without usage never report a text rate", async (t) => {
  const service = serviceFixture(t, async ({ emit }) => {
    emit({ type: "tool", value: { name: "search", output: "ok" } });
    await new Promise((r) => setTimeout(r, 300));
    return { text: "" };
  });
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  service.send(sid, "go");
  await until(() => service.store.session(sid).status === "idle");
  const answer = service.store.session(sid).messages.at(-1);
  assert.equal(
    answer.tokensPerSecond,
    0,
    "no fabricated rate for tool-only turns",
  );
  assert.equal(answer.usage, undefined);
  assert.ok(answer.elapsedMs >= 300, "active duration is still reported");
});

test("bundled concise/review/subagents carry the evidence-based wording", () => {
  const content = Object.fromEntries(
    bundledSkills().map((s) => [s.id, s.content]),
  );
  assert.match(
    content.concise,
    /never omit necessary information just to be brief/,
  );
  assert.match(content.concise, /unnecessary headings/);
  assert.match(content.review, /If no actionable findings remain/);
  assert.match(content.review, /material validation gaps/);
  assert.match(content.subagents, /avoid overlapping edits/);
  assert.match(content.subagents, /Cancel unnecessary children/);
  assert.match(content.subagents, /Do not claim a child ran/);
  // Capability gating is unchanged: subagents still requires delegation.
  const entry = bundledSkills().find((s) => s.id === "subagents");
  assert.deepEqual(entry.requires, ["delegation"]);
});

test("live reasoning-only work reports cumulative throughput before visible text", async (t) => {
  let resume;
  const service = serviceFixture(t, async ({ emit }) => {
    await new Promise((r) => setTimeout(r, 280));
    emit({ type: "thinking", value: "reasoning".repeat(20) });
    emit({ type: "usage", value: { output: 10, scope: "request" } });
    emit({ type: "usage", value: { output: 20, scope: "request" } });
    await new Promise((r) => {
      resume = r;
    });
    return { text: "" };
  });
  const sid = service.create({ modelId: "fixture", harness: "direct" });
  service.send(sid, "inspect");
  await until(() => resume);
  const a = service.store.session(sid).messages.at(-1);
  assert.equal(a.turnUsage.output, 30);
  assert.ok(a.tokensPerSecond > 0);
  assert.equal(a.rateKind, "turn-throughput");
  assert.ok(Math.abs(a.tokensPerSecond - 30 / (a.activeMs / 1000)) < 0.01);
  resume();
  await until(() => service.store.session(sid).status === "idle");
});

test("reported zero output stays measured and partial usage stays partial", () => {
  assert.deepEqual(normalizeUsage({ output: 0 }), { output: 0 });
  assert.deepEqual(
    finalizeRate({
      turnOutput: 0,
      generatedText: "large text",
      elapsedMs: 1000,
    }),
    { rate: 0, estimated: false },
  );
  assert.deepEqual(addUsage(null, { output: 12 }), { output: 12 });
});
